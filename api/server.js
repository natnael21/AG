const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express    = require('express');
const cors       = require('cors');
const { Pool }   = require('pg');
const createHealthRoute = require('./src/routes/health');
const { provisionSignup, rejectSignup, reinstateSignup } = require('./services/signup');
const { sendRejectionEmail, sendApprovalEmail, sendReinstateEmail, verifyTransporter } = require('./services/email');

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
app.get('/api/health', createHealthRoute({ pool, verifySmtp: verifyTransporter }));

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
    const fullName = [first, last].filter(Boolean).join(' ').trim();
    const { rows: dup } = await pool.query(
      `SELECT id FROM shop_signups WHERE lower(contact_email) = lower($1) AND status IN ('pending','approved') LIMIT 1`,
      [email]
    );
    if (dup.length) return res.status(409).json({ error: 'A signup request for this email already exists.' });

    const { rows } = await pool.query(
      `INSERT INTO shop_signups
       (contact_name, contact_email, contact_phone, shop_name, shop_type, annual_revenue, technicians, employees, has_advisor, pain_point, source, tools, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')
       RETURNING id, status, created_at`,
      [
        fullName || first,
        email.toLowerCase(),
        phone || null,
        shop,
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
    res.status(201).json({ ok: true, signup: rows[0] });
  } catch (e) {
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

app.get('/api/admin/signups', requireAuth(['super_admin']), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, contact_name, contact_email, contact_phone, shop_name, shop_type, annual_revenue,
              technicians, employees, has_advisor, pain_point, source, tools, status, reviewed_by,
              reviewed_at, rejection_comment, rejected_at, rejected_by, reinstated_at, reinstated_by,
              workspace_id, user_id, created_at
       FROM shop_signups
       ORDER BY created_at DESC
       LIMIT 200`
    );
    res.json(rows);
  } catch (e) {
    console.error('[admin/signups]', e.message);
    res.status(500).json({ error: 'Failed to fetch signups: ' + e.message });
  }
});

app.post('/api/admin/signups/:id/reject', requireAuth(['super_admin']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid signup id.' });
    
    const { comment } = req.body || {};
    
    // Get signup details before rejecting
    const { rows: signupRows } = await pool.query(
      `SELECT * FROM shop_signups WHERE id = $1`,
      [id]
    );
    
    if (!signupRows.length) {
      return res.status(404).json({ error: 'Signup not found.' });
    }
    
    const signup = signupRows[0];
    
    // Reject the signup
    const result = await rejectSignup(pool, id, req.session.user_id, comment || null);
    
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    
    // Send rejection email
    const emailResult = await sendRejectionEmail(signup, comment || null);
    if (!emailResult.success) {
      console.warn('[admin/signups/reject] Email send failed:', emailResult.error);
    }
    
    res.json({ ok: true, signup: result.signup, emailSent: emailResult.success });
  } catch (e) {
    console.error('[admin/signups/reject]', e.message);
    res.status(500).json({ error: 'Failed to reject signup: ' + e.message });
  }
});

app.post('/api/admin/signups/:id/approve', requireAuth(['super_admin']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid signup id.' });
    
    const result = await provisionSignup(pool, id, req.session.user_id);
    
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    
    // Send approval email with credentials
    const emailResult = await sendApprovalEmail(result.user, result.workspace, result.tempPassword);
    if (!emailResult.success) {
      console.warn('[admin/signups/approve] Email send failed:', emailResult.error);
    }
    
    res.json({ 
      ok: true, 
      signup: result.signup, 
      workspace: result.workspace,
      user: result.user,
      tempPassword: result.tempPassword,
      emailSent: emailResult.success
    });
  } catch (e) {
    console.error('[admin/signups/approve]', e.message);
    res.status(500).json({ error: 'Failed to approve signup: ' + e.message });
  }
});

app.post('/api/admin/signups/:id/reinstate', requireAuth(['super_admin']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid signup id.' });
    
    // Get signup details before reinstating
    const { rows: signupRows } = await pool.query(
      `SELECT * FROM shop_signups WHERE id = $1`,
      [id]
    );
    
    if (!signupRows.length) {
      return res.status(404).json({ error: 'Signup not found.' });
    }
    
    const signup = signupRows[0];
    
    // Reinstate the signup
    const result = await reinstateSignup(pool, id, req.session.user_id);
    
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    
    // Send reinstate notification email
    const emailResult = await sendReinstateEmail(signup);
    if (!emailResult.success) {
      console.warn('[admin/signups/reinstate] Email send failed:', emailResult.error);
    }
    
    res.json({ ok: true, signup: result.signup, emailSent: emailResult.success });
  } catch (e) {
    console.error('[admin/signups/reinstate]', e.message);
    res.status(500).json({ error: 'Failed to reinstate signup: ' + e.message });
  }
});

app.get('/api/admin/signups/:id', requireAuth(['super_admin']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid signup id.' });
    
    const { rows: signupRows } = await pool.query(
      `SELECT id, contact_name, contact_email, contact_phone, shop_name, shop_type, annual_revenue,
              technicians, employees, has_advisor, pain_point, source, tools, status, 
              reviewed_by, reviewed_at, rejection_comment, rejected_at, rejected_by,
              reinstated_at, reinstated_by, workspace_id, user_id, created_at
       FROM shop_signups
       WHERE id = $1`,
      [id]
    );
    
    if (!signupRows.length) {
      return res.status(404).json({ error: 'Signup not found.' });
    }
    
    // Get audit history
    const { rows: auditRows } = await pool.query(
      `SELECT id, action, performed_by, reason, comment, old_status, new_status, created_at
       FROM signup_audit_log
       WHERE signup_id = $1
       ORDER BY created_at DESC`,
      [id]
    );
    
    res.json({ signup: signupRows[0], auditHistory: auditRows });
  } catch (e) {
    console.error('[admin/signups/:id]', e.message);
    res.status(500).json({ error: 'Failed to fetch signup: ' + e.message });
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

/* ── Email test endpoint (admin only) ── */
app.post('/api/admin/test-email', requireAuth(['super_admin']), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required.' });

    console.log('[test-email] Attempting to send test email to:', email);
    console.log('[test-email] SMTP Config:', {
      SMTP_HOST: process.env.SMTP_HOST,
      SMTP_PORT: process.env.SMTP_PORT,
      SMTP_SECURE: process.env.SMTP_SECURE,
      SMTP_USER: process.env.SMTP_USER ? '***set***' : '***not set***',
      SMTP_PASS: process.env.SMTP_PASS ? '***set***' : '***not set***',
      FROM_EMAIL: process.env.FROM_EMAIL,
    });

    const testEmail = require('./services/email');
    const result = await testEmail.sendApprovalEmail(
      { name: 'Test User', email },
      { name: 'Test Workspace', id: 0 },
      'TestPassword123!'
    );

    res.json({
      ok: result.success,
      message: result.success ? 'Test email sent successfully' : 'Test email failed',
      error: result.error || null,
    });
  } catch (e) {
    console.error('[test-email]', e.message);
    res.status(500).json({ error: 'Test email error: ' + e.message });
  }
});

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

/* ── CSV bulk import routes ── */
const multer = require('multer');
const ImportService = require('./services/import');
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const importService = new ImportService(pool);

app.post('/api/import/customers',
  requireAuth(['super_admin', 'manager']),
  csvUpload.single('file'),
  async (req, res) => {
    const workspaceId = resolveWorkspaceId(req, res);
    if (!workspaceId) return;
    if (!req.file) return res.status(400).json({ error: 'CSV file required (field name: file).' });
    try {
      const result = await importService.importCustomers(workspaceId, req.file.buffer);
      res.json(result);
    } catch (e) {
      console.error('[import/customers]', e.message);
      res.status(500).json({ error: e.message });
    }
  }
);

app.post('/api/import/vehicles',
  requireAuth(['super_admin', 'manager']),
  csvUpload.single('file'),
  async (req, res) => {
    const workspaceId = resolveWorkspaceId(req, res);
    if (!workspaceId) return;
    if (!req.file) return res.status(400).json({ error: 'CSV file required (field name: file).' });
    try {
      const result = await importService.importVehicles(workspaceId, req.file.buffer);
      res.json(result);
    } catch (e) {
      console.error('[import/vehicles]', e.message);
      res.status(500).json({ error: e.message });
    }
  }
);

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

/* ── Repair Order Management Routes ── */
const RepairOrderService = require('./services/repair-order');
const repairOrderService = new RepairOrderService(pool);

app.get('/api/repair-orders/:id', requireAuth(), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const roId = Number(req.params.id);
    const repairOrder = await repairOrderService.getRepairOrder(roId, workspaceId);
    if (!repairOrder) {
      return res.status(404).json({ error: 'Repair order not found' });
    }
    res.json(repairOrder);
  } catch (e) {
    console.error('[repair-orders/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/repair-orders/:id/parts', requireAuth(['super_admin', 'manager', 'service_advisor', 'technician']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const roId = Number(req.params.id);
    const partData = req.body;
    const result = await repairOrderService.addPartToRepairOrder(roId, partData, workspaceId, req.session.user_id);
    res.json(result);
  } catch (e) {
    console.error('[repair-orders/:id/parts]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/repair-orders/:id/labor', requireAuth(['super_admin', 'manager', 'service_advisor', 'technician']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const roId = Number(req.params.id);
    const laborData = req.body;
    const result = await repairOrderService.addLaborToRepairOrder(roId, laborData, workspaceId, req.session.user_id);
    res.json(result);
  } catch (e) {
    console.error('[repair-orders/:id/labor]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/repair-orders/:id/time/clock-in', requireAuth(['super_admin', 'manager', 'service_advisor', 'technician']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const roId = Number(req.params.id);
    const result = await repairOrderService.clockIn(roId, req.session.user_id, workspaceId);
    res.json(result);
  } catch (e) {
    console.error('[repair-orders/:id/clock-in]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/repair-orders/:id/time/clock-out', requireAuth(['super_admin', 'manager', 'service_advisor', 'technician']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const roId = Number(req.params.id);
    const result = await repairOrderService.clockOut(roId, req.session.user_id, workspaceId);
    res.json(result);
  } catch (e) {
    console.error('[repair-orders/:id/clock-out]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/repair-orders/:id', requireAuth(['super_admin', 'manager', 'service_advisor']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const roId = Number(req.params.id);
    const updates = req.body;
    const result = await repairOrderService.updateRepairOrder(roId, updates, workspaceId, req.session.user_id);
    res.json(result);
  } catch (e) {
    console.error('[repair-orders/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── Parts Management Routes ── */
const PartsService = require('./services/parts');
const partsService = new PartsService(pool);

app.get('/api/parts', requireAuth(), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const { search, category, lowStock } = req.query;
    let parts;

    if (search) {
      parts = await partsService.searchParts(search, workspaceId);
    } else if (lowStock === 'true') {
      parts = await partsService.getLowStockParts(workspaceId);
    } else {
      parts = await partsService.getAllParts(workspaceId, category);
    }

    res.json(parts);
  } catch (e) {
    console.error('[parts]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/parts', requireAuth(['super_admin', 'manager']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const partData = req.body;
    const result = await partsService.createPart(partData, workspaceId, req.session.user_id);
    res.status(201).json(result);
  } catch (e) {
    console.error('[parts]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/parts/:id', requireAuth(['super_admin', 'manager']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const partId = Number(req.params.id);
    const updates = req.body;
    const result = await partsService.updatePart(partId, updates, workspaceId, req.session.user_id);
    res.json(result);
  } catch (e) {
    console.error('[parts/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/parts/:id/adjust-inventory', requireAuth(['super_admin', 'manager']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const partId = Number(req.params.id);
    const { adjustment, reason } = req.body;
    const result = await partsService.adjustInventory(partId, adjustment, reason, workspaceId, req.session.user_id);
    res.json(result);
  } catch (e) {
    console.error('[parts/:id/adjust-inventory]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── User Management Routes ── */
const UserManagementService = require('./services/user-management');
const userManagementService = new UserManagementService(pool);

app.post('/api/users/invite', requireAuth(['super_admin', 'manager']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const inviteData = req.body;
    const result = await userManagementService.inviteUser(workspaceId, inviteData, req.session.user_id);
    res.status(201).json(result);
  } catch (e) {
    console.error('[users/invite]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/users/:id/role', requireAuth(['super_admin', 'manager']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const userId = Number(req.params.id);
    const { role } = req.body;
    const result = await userManagementService.updateUserRole(userId, workspaceId, role, req.session.user_id);
    res.json(result);
  } catch (e) {
    console.error('[users/:id/role]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/users/:id/workspace', requireAuth(['super_admin', 'manager']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const userId = Number(req.params.id);
    const result = await userManagementService.removeUserFromWorkspace(userId, workspaceId, req.session.user_id);
    res.json(result);
  } catch (e) {
    console.error('[users/:id/workspace]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/users/:id/deactivate', requireAuth(['super_admin']), async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const result = await userManagementService.deactivateUser(userId, req.session.user_id);
    res.json(result);
  } catch (e) {
    console.error('[users/:id/deactivate]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/users/:id/reactivate', requireAuth(['super_admin']), async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const result = await userManagementService.reactivateUser(userId, req.session.user_id);
    res.json(result);
  } catch (e) {
    console.error('[users/:id/reactivate]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/users/profile', requireAuth(), async (req, res) => {
  try {
    const profileData = req.body;
    const result = await userManagementService.updateUserProfile(req.session.user_id, profileData);
    res.json(result);
  } catch (e) {
    console.error('[users/profile]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/users/:id/reset-password', requireAuth(['super_admin', 'manager']), async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const result = await userManagementService.resetUserPassword(userId, req.session.user_id);
    res.json(result);
  } catch (e) {
    console.error('[users/:id/reset-password]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/users/workspace', requireAuth(), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const users = await userManagementService.getWorkspaceUsers(workspaceId);
    res.json(users);
  } catch (e) {
    console.error('[users/workspace]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── Reporting & Analytics Routes ── */
const ReportingService = require('./services/reporting');
const reportingService = new ReportingService(pool);

app.get('/api/reports/financial-summary', requireAuth(['super_admin', 'manager']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const { startDate, endDate } = req.query;
    const dateRange = startDate && endDate ? { startDate, endDate } : {};
    const summary = await reportingService.getFinancialSummary(workspaceId, dateRange);
    res.json(summary);
  } catch (e) {
    console.error('[reports/financial-summary]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/reports/technician-performance', requireAuth(['super_admin', 'manager']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const { startDate, endDate } = req.query;
    const dateRange = startDate && endDate ? { startDate, endDate } : {};
    const performance = await reportingService.getTechnicianPerformance(workspaceId, dateRange);
    res.json(performance);
  } catch (e) {
    console.error('[reports/technician-performance]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/reports/customer-analytics', requireAuth(['super_admin', 'manager']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const { startDate, endDate } = req.query;
    const dateRange = startDate && endDate ? { startDate, endDate } : {};
    const analytics = await reportingService.getCustomerAnalytics(workspaceId, dateRange);
    res.json(analytics);
  } catch (e) {
    console.error('[reports/customer-analytics]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/reports/parts-analytics', requireAuth(['super_admin', 'manager']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const { startDate, endDate } = req.query;
    const dateRange = startDate && endDate ? { startDate, endDate } : {};
    const analytics = await reportingService.getPartsAnalytics(workspaceId, dateRange);
    res.json(analytics);
  } catch (e) {
    console.error('[reports/parts-analytics]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/reports/revenue-trends', requireAuth(['super_admin', 'manager']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const months = Number(req.query.months) || 12;
    const trends = await reportingService.getRevenueTrends(workspaceId, months);
    res.json(trends);
  } catch (e) {
    console.error('[reports/revenue-trends]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/reports/shop-kpis', requireAuth(['super_admin', 'manager']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const { startDate, endDate } = req.query;
    const dateRange = startDate && endDate ? { startDate, endDate } : {};
    const kpis = await reportingService.getShopKPIs(workspaceId, dateRange);
    res.json(kpis);
  } catch (e) {
    console.error('[reports/shop-kpis]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/reports/export', requireAuth(['super_admin', 'manager']), async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  try {
    const { format = 'json', startDate, endDate } = req.query;
    const dateRange = startDate && endDate ? { startDate, endDate } : {};
    const data = await reportingService.exportRepairOrderData(workspaceId, format, dateRange);
    res.json(data);
  } catch (e) {
    console.error('[reports/export]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── Customer Portal Routes ── */
const CustomerPortalService = require('./services/customer-portal');
const customerPortalService = new CustomerPortalService(pool);

// Customer authentication
app.post('/api/customer/login', async (req, res) => {
  const { email, password, workspaceId } = req.body;

  if (!email || !password || !workspaceId) {
    return res.status(400).json({ error: 'Email, password, and workspaceId are required' });
  }

  try {
    const result = await customerPortalService.customerLogin(email, password, workspaceId);
    res.json(result);
  } catch (e) {
    console.error('[customer/login]', e.message);
    res.status(401).json({ error: e.message });
  }
});

app.post('/api/customer/logout', async (req, res) => {
  const sessionToken = req.headers.authorization?.slice(7);

  if (!sessionToken) {
    return res.status(400).json({ error: 'Session token required' });
  }

  try {
    await customerPortalService.logout(sessionToken);
    res.json({ success: true });
  } catch (e) {
    console.error('[customer/logout]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Customer portal middleware
function requireCustomerAuth() {
  return async (req, res, next) => {
    const sessionToken = req.headers.authorization?.slice(7);

    if (!sessionToken) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      const customer = await customerPortalService.validateSession(sessionToken);
      if (!customer) {
        return res.status(401).json({ error: 'Invalid or expired session' });
      }

      req.customer = customer;
      next();
    } catch (e) {
      console.error('[customer auth]', e.message);
      res.status(500).json({ error: 'Authentication error' });
    }
  };
}

// Customer service history
app.get('/api/customer/service-history', requireCustomerAuth(), async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const history = await customerPortalService.getServiceHistory(req.customer.id, limit, offset);
    res.json(history);
  } catch (e) {
    console.error('[customer/service-history]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Customer vehicles
app.get('/api/customer/vehicles', requireCustomerAuth(), async (req, res) => {
  try {
    const vehicles = await customerPortalService.getCustomerVehicles(req.customer.id);
    res.json(vehicles);
  } catch (e) {
    console.error('[customer/vehicles]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Customer appointments
app.post('/api/customer/appointments', requireCustomerAuth(), async (req, res) => {
  try {
    const appointmentData = req.body;
    const result = await customerPortalService.scheduleAppointment(req.customer.id, appointmentData);
    res.status(201).json(result);
  } catch (e) {
    console.error('[customer/appointments]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/customer/appointments', requireCustomerAuth(), async (req, res) => {
  try {
    const { status } = req.query;
    const appointments = await customerPortalService.getCustomerAppointments(req.customer.id, status);
    res.json(appointments);
  } catch (e) {
    console.error('[customer/appointments]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/customer/appointments/:id', requireCustomerAuth(), async (req, res) => {
  try {
    const appointmentId = Number(req.params.id);
    const updateData = req.body;
    const result = await customerPortalService.updateAppointment(appointmentId, req.customer.id, updateData);
    res.json(result);
  } catch (e) {
    console.error('[customer/appointments/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/customer/appointments/:id', requireCustomerAuth(), async (req, res) => {
  try {
    const appointmentId = Number(req.params.id);
    const result = await customerPortalService.cancelAppointment(appointmentId, req.customer.id);
    res.json(result);
  } catch (e) {
    console.error('[customer/appointments/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Customer profile management
app.get('/api/customer/profile', requireCustomerAuth(), async (req, res) => {
  try {
    const profile = await customerPortalService.getCustomerProfile(req.customer.id);
    res.json(profile);
  } catch (e) {
    console.error('[customer/profile]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/customer/profile', requireCustomerAuth(), async (req, res) => {
  try {
    const profileData = req.body;
    const result = await customerPortalService.updateCustomerProfile(req.customer.id, profileData);
    res.json(result);
  } catch (e) {
    console.error('[customer/profile]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/customer/change-password', requireCustomerAuth(), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const result = await customerPortalService.updatePortalPassword(req.customer.id, currentPassword, newPassword);
    res.json(result);
  } catch (e) {
    console.error('[customer/change-password]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Admin endpoints for customer portal management
app.post('/api/admin/customers/:id/enable-portal', requireAuth(['super_admin', 'manager']), async (req, res) => {
  try {
    const customerId = Number(req.params.id);
    const tempPassword = customerPortalService.generateTempPassword();
    const result = await customerPortalService.enablePortalAccess(customerId, tempPassword);
    res.json(result);
  } catch (e) {
    console.error('[admin/customers/:id/enable-portal]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/customers/:id/reset-portal-password', requireAuth(['super_admin', 'manager']), async (req, res) => {
  try {
    const customerId = Number(req.params.id);
    const result = await customerPortalService.resetPortalPassword(customerId);
    res.json(result);
  } catch (e) {
    console.error('[admin/customers/:id/reset-portal-password]', e.message);
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
