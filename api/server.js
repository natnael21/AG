require("dotenv").config();
const express    = require('express');
const cors       = require('cors');
const { Pool }   = require('pg');
const path       = require('path');
const healthRoute = require('./src/routes/health');

const app = express();

/* ── Middleware ── */
app.use(cors({ origin: ['https://agshopro.com', 'http://localhost:3000'], credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/* ── DB pool ── */
const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
  ssl:      { rejectUnauthorized: false },
  max:      10,
});

pool.connect((err, client, release) => {
  if (err) { console.error('[DB] Connection failed:', err.message); return; }
  release();
  console.log('[DB] Connected to RDS PostgreSQL');
});

/* ── Health check ── */
app.get('/api/health', healthRoute);

/* ── Auth routes ── */
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing email or password.' });

  try {
    const bcrypt = require('bcrypt');
    const crypto = require('crypto');

    const { rows } = await pool.query(
      `SELECT * FROM users WHERE lower(email) = lower($1) AND active = true`,
      [email]
    );
    if (!rows.length) return res.status(401).json({ error: 'Incorrect email or password.' });

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect email or password.' });

    /* Create session */
    const token   = crypto.randomBytes(32).toString('hex');
    const expiry  = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)`,
      [token, user.id, expiry]
    );

    await pool.query(`UPDATE users SET last_login = NOW() WHERE id = $1`, [user.id]);

    res.json({
      ok: true,
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, workspaceIds: user.workspace_ids }
    });
  } catch(e) {
    console.error('[login]', e.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const token = req.headers.authorization?.slice(7);
  if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  res.json({ ok: true });
});

/* ── Workspace routes ── */
app.get('/api/workspaces', requireAuth(), async (req, res) => {
  try {
    const isAdmin = req.session.role === 'super_admin';
    const query   = isAdmin
      ? `SELECT * FROM workspaces WHERE active = true ORDER BY name`
      : `SELECT * FROM workspaces WHERE id = ANY($1) AND active = true ORDER BY name`;
    const params  = isAdmin ? [] : [req.session.workspace_ids || []];
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── User routes ── */
app.get('/api/users', requireAuth(['super_admin', 'manager']), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, phone, role, workspace_ids, active, last_login, created_at
       FROM users ORDER BY name`
    );
    res.json(rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── ETL status route ── */
app.get('/api/integrations/mitchell/status', requireAuth(), async (req, res) => {
  const wsId = req.query.workspaceId || req.session.workspace_ids?.[0];
  try {
    const [integration, syncLog, counts] = await Promise.all([
      pool.query(
        `SELECT active, connected_at, last_sync_at, total_synced FROM workspace_integrations
         WHERE workspace_id = $1 AND integration = 'mitchell1'`, [wsId]
      ),
      pool.query(
        `SELECT * FROM etl_sync_log WHERE workspace_id = $1 AND integration = 'mitchell1'
         ORDER BY last_sync_at DESC LIMIT 1`, [wsId]
      ),
      pool.query(
        `SELECT
           (SELECT COUNT(*) FROM customers      WHERE workspace_id = $1) AS customers,
           (SELECT COUNT(*) FROM vehicles       WHERE workspace_id = $1) AS vehicles,
           (SELECT COUNT(*) FROM repair_orders  WHERE workspace_id = $1) AS repair_orders,
           (SELECT COUNT(*) FROM ro_labor_lines WHERE workspace_id = $1) AS labor_lines,
           (SELECT COUNT(*) FROM ro_parts_lines WHERE workspace_id = $1) AS parts_lines`, [wsId]
      ),
    ]);
    res.json({
      connected:  integration.rows[0]?.active || false,
      connectedAt: integration.rows[0]?.connected_at,
      lastSync:   syncLog.rows[0] || null,
      counts:     counts.rows[0],
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Customer history route ── */
app.get('/api/customers/:id/history', requireAuth(), async (req, res) => {
  const wsId = req.query.workspaceId || req.session.workspace_ids?.[0];
  try {
    const { getCustomerHistory } = require('./services/mitchell-etl');
    const history = await getCustomerHistory(wsId, req.params.id);
    if (!history) return res.status(404).json({ error: 'Customer not found.' });
    res.json(history);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Burn rate route ── */
app.get('/api/analytics/burn-rate', requireAuth(), async (req, res) => {
  try {
    const { burnRateHandler } = require('./services/square-categories');
    await burnRateHandler(req, res, pool);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Forgot password ── */
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  /* Always return ok — never reveal if email exists */
  res.json({ ok: true, message: 'If that email is registered, a reset link has been sent.' });

  try {
    const crypto   = require('crypto');
    const { rows } = await pool.query(
      `SELECT * FROM users WHERE lower(email) = lower($1) AND active = true`, [email]
    );
    if (!rows.length) return;

    const token  = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 60 * 60 * 1000);
    await pool.query(
      `UPDATE users SET reset_token = $1, reset_expiry = $2 WHERE id = $3`,
      [token, expiry, rows[0].id]
    );

    const resetBaseUrl = process.env.RESET_BASE_URL || 'http://localhost:3000';
    const resetURL = `${resetBaseUrl.replace(/\/$/, '')}/reset.html?token=${token}`;
    console.log(`[forgot-password] Reset link for ${email}: ${resetURL}`);
    /* TODO: wire AWS SES to send real email */
  } catch(e) {
    console.error('[forgot-password]', e.message);
  }
});

/* ── Reset password ── */
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Missing fields.' });
  if (password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  try {
    const bcrypt = require('bcrypt');
    const { rows } = await pool.query(
      `SELECT * FROM users WHERE reset_token = $1 AND reset_expiry > NOW()`, [token]
    );
    if (!rows.length) return res.status(410).json({ error: 'Link expired or already used.' });

    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      `UPDATE users SET password_hash = $1, reset_token = NULL, reset_expiry = NULL WHERE id = $2`,
      [hash, rows[0].id]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Auth middleware ── */
function requireAuth(roles) {
  return async (req, res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized.' });
    const token = header.slice(7);
    try {
      const { rows } = await pool.query(
        `SELECT s.*, u.role, u.name, u.email, u.workspace_ids
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = $1 AND s.expires_at > NOW()`,
        [token]
      );
      if (!rows.length) return res.status(401).json({ error: 'Session expired.' });
      if (roles && !roles.includes(rows[0].role)) return res.status(403).json({ error: 'Insufficient permissions.' });
      req.session = rows[0];
      next();
    } catch(e) {
      res.status(401).json({ error: 'Invalid token.' });
    }
  };
}

/* ── Start Mitchell ETL cron (only in production) ── */
if (process.env.NODE_ENV === 'production') {
  try {
    require('./services/mitchell-etl');
    console.log('[ETL] Mitchell 1 cron scheduler started');
  } catch(e) {
    console.warn('[ETL] Mitchell ETL not loaded:', e.message);
  }
}

/* ── Start server ── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[AG Shop Pro API] Running on port ${PORT}`);
  console.log(`[AG Shop Pro API] Health: http://localhost:${PORT}/api/health`);
});

module.exports = app;
