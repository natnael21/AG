require("dotenv").config();
const express    = require('express');
const cors       = require('cors');
const { Pool }   = require('pg');
const createHealthRoute = require('./src/routes/health');

function parseCorsOrigins() {
  const raw = process.env.CORS_ORIGINS;
  if (raw && String(raw).trim()) {
    return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [
    'https://agshopro.com',
    'https://www.agshopro.com',
    'https://preprod.agshopro.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ];
}

const app = express();

/* ── Middleware ── */
app.use(cors({ origin: parseCorsOrigins(), credentials: true }));
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
app.get('/api/health', createHealthRoute(pool));

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

app.post('/api/signup', async (req, res) => {
  const {
    first,
    last,
    email,
    phone,
    shop,
    type,
    revenue,
    techs,
    employees,
    advisor,
    pain,
    source,
    tools,
  } = req.body || {};

  if (!first || !email || !shop) {
    return res.status(400).json({ error: 'Missing required signup fields.' });
  }

  try {
    const bcrypt = require('bcrypt');
    const crypto = require('crypto');
    const password = `Temp-${crypto.randomBytes(5).toString('hex')}!`;
    const hash = await bcrypt.hash(password, 12);

    await pool.query('BEGIN');
    const wsResult = await pool.query(
      `INSERT INTO workspaces (name, type, plan, active)
       VALUES ($1,$2,$3,true)
       RETURNING id, name`,
      [shop, type || 'mechanic', 'starter']
    );
    const workspaceId = wsResult.rows[0].id;
    const fullName = [first, last].filter(Boolean).join(' ').trim();

    const userResult = await pool.query(
      `INSERT INTO users (name, email, phone, password_hash, role, workspace_ids, active)
       VALUES ($1,$2,$3,$4,'super_admin',$5,true)
       RETURNING id, name, email, role, workspace_ids`,
      [fullName || first, email.toLowerCase(), phone || null, hash, [workspaceId]]
    );

    await pool.query(
      `INSERT INTO leads_inbox
       (workspace_id, contact_name, contact_email, contact_phone, shop_type, annual_revenue, technicians, employees, has_advisor, pain_point, source, tools, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'new')`,
      [
        workspaceId,
        fullName || first,
        email.toLowerCase(),
        phone || null,
        type || null,
        revenue || null,
        techs || null,
        employees || null,
        advisor || null,
        pain || null,
        source || null,
        tools || null,
      ]
    );

    await pool.query('COMMIT');
    res.status(201).json({
      ok: true,
      workspace: wsResult.rows[0],
      user: userResult.rows[0],
      tempPassword: password,
    });
  } catch (e) {
    await pool.query('ROLLBACK').catch(() => {});
    if (String(e.message).toLowerCase().includes('duplicate key')) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    return res.status(500).json({ error: e.message });
  }
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

function resolveWorkspaceId(req, res) {
  const raw = req.query.workspaceId || req.body.workspaceId || req.session.workspace_ids?.[0];
  const workspaceId = Number(raw);
  if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
    res.status(400).json({ error: 'workspaceId is required.' });
    return null;
  }

  if (req.session.role !== 'super_admin') {
    const allowed = new Set((req.session.workspace_ids || []).map((x) => Number(x)));
    if (!allowed.has(workspaceId)) {
      res.status(403).json({ error: 'Workspace access denied.' });
      return null;
    }
  }

  return workspaceId;
}

/* ── Core customers routes ── */
app.get('/api/customers', requireAuth(), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const { rows } = await pool.query(
      `SELECT id, workspace_id, full_name, email, phone, created_at, updated_at
       FROM customers
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [workspaceId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/customers', requireAuth(['super_admin', 'manager', 'service_advisor']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  const { fullName, email, phone } = req.body || {};
  if (!fullName) return res.status(400).json({ error: 'fullName is required.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO customers (workspace_id, full_name, email, phone)
       VALUES ($1,$2,$3,$4)
       RETURNING id, workspace_id, full_name, email, phone, created_at, updated_at`,
      [workspaceId, fullName, email || null, phone || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Core vehicles routes ── */
app.get('/api/vehicles', requireAuth(), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  const customerId = req.query.customerId ? Number(req.query.customerId) : null;
  try {
    const params = [workspaceId];
    let sql = `SELECT id, workspace_id, customer_id, vin, year, make, model, plate, mileage, created_at, updated_at
               FROM vehicles
               WHERE workspace_id = $1`;
    if (customerId) {
      params.push(customerId);
      sql += ` AND customer_id = $2`;
    }
    sql += ` ORDER BY created_at DESC`;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/vehicles', requireAuth(['super_admin', 'manager', 'service_advisor']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  const { customerId, vin, year, make, model, plate, mileage } = req.body || {};
  if (!customerId) return res.status(400).json({ error: 'customerId is required.' });
  if (!vin || !make || !model) return res.status(400).json({ error: 'vin, make and model are required.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO vehicles
       (workspace_id, customer_id, vin, year, make, model, plate, mileage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, workspace_id, customer_id, vin, year, make, model, plate, mileage, created_at, updated_at`,
      [workspaceId, customerId, vin, year || null, make, model, plate || null, mileage || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Core repair order routes ── */
app.get('/api/repair-orders', requireAuth(), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const { rows } = await pool.query(
      `SELECT id, workspace_id, ro_number, customer_id, vehicle_id, status, concern, total_estimate, total_final, created_at, updated_at
       FROM repair_orders
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [workspaceId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/repair-orders', requireAuth(['super_admin', 'manager', 'service_advisor']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  const { customerId, vehicleId, concern, totalEstimate } = req.body || {};
  if (!customerId || !vehicleId || !concern) {
    return res.status(400).json({ error: 'customerId, vehicleId and concern are required.' });
  }
  try {
    const roNumber = `RO-${Date.now()}`;
    const { rows } = await pool.query(
      `INSERT INTO repair_orders
       (workspace_id, ro_number, customer_id, vehicle_id, status, concern, total_estimate, total_final)
       VALUES ($1,$2,$3,$4,'open',$5,$6,0)
       RETURNING id, workspace_id, ro_number, customer_id, vehicle_id, status, concern, total_estimate, total_final, created_at, updated_at`,
      [workspaceId, roNumber, customerId, vehicleId, concern, totalEstimate || 0]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/repair-orders/:id/status', requireAuth(['super_admin', 'manager', 'service_advisor', 'technician']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  const roId = Number(req.params.id);
  const { status } = req.body || {};
  if (!roId || !status) return res.status(400).json({ error: 'id and status are required.' });
  const allowed = new Set(['open', 'in_progress', 'awaiting_parts', 'ready', 'completed', 'cancelled']);
  if (!allowed.has(status)) return res.status(400).json({ error: 'Invalid status value.' });
  try {
    const { rows } = await pool.query(
      `UPDATE repair_orders
       SET status = $1, updated_at = NOW()
       WHERE id = $2 AND workspace_id = $3
       RETURNING id, workspace_id, ro_number, status, updated_at`,
      [status, roId, workspaceId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Repair order not found.' });
    res.json(rows[0]);
  } catch (e) {
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
    const userId = rows[0].id;
    await pool.query(
      `UPDATE users SET password_hash = $1, reset_token = NULL, reset_expiry = NULL WHERE id = $2`,
      [hash, userId]
    );

    const crypto = require('crypto');
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)`,
      [sessionToken, userId, expiry]
    );

    const { rows: urows } = await pool.query(
      `SELECT id, name, email, role, workspace_ids FROM users WHERE id = $1`,
      [userId]
    );
    const u = urows[0];
    res.json({
      ok: true,
      token: sessionToken,
      user: {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        workspaceIds: u.workspace_ids,
      },
    });
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
    console.log('[ETL] Mitchell 1 module loaded');
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
