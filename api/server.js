const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const { Pool, types } = require('pg');

/* A DATE column is a calendar date, not an instant. node-postgres parses it
   into a JS Date at local midnight, which JSON then serialises through UTC —
   so appointments.preferred_date arrived at the browser as e.g.
   "2026-07-20T04:00:00.000Z" and rendered a day early for any client west of
   the server. Hand DATE through as the plain "YYYY-MM-DD" string it already
   is; the frontend formatters treat that as a calendar date. (1082 = DATE.) */
types.setTypeParser(1082, (value) => value);
const createHealthRoute = require('./src/routes/health');
const { provisionSignup, rejectSignup, reinstateSignup } = require('./services/signup');
const { sendRejectionEmail, sendApprovalEmail, sendReinstateEmail, verifyTransporter } = require('./services/email');
const { route, sendError, parseId, ValidationError, NotFoundError } = require('./services/errors');

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

/* Security headers. The pages are hand-written HTML with inline <script> and
   onclick handlers and pull fonts/Chart.js from CDNs, so the CSP has to allow
   those; it is set explicitly rather than left at helmet's default, which
   would break every page. */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      /* The pages wire buttons with onclick="" attributes. helmet's default
         script-src-attr of 'none' blocks inline event handlers outright, which
         would silently disable every button in the app. */
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  /* Loading Chart.js and Google Fonts cross-origin is incompatible with COEP. */
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({ origin: parseCorsOrigins(), credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/* Rate limits. Credential endpoints are the ones worth protecting: without
   this, a password can be brute-forced at network speed. Keyed by IP.
   `trust proxy` is set below so the real client IP is used behind nginx. */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait and try again.' },
});

/* Behind nginx/ELB the client IP arrives in X-Forwarded-For. Trust exactly one
   proxy hop rather than `true`, which would let a client spoof the header and
   defeat the rate limiter. */
app.set('trust proxy', 1);

/* ── Static frontend ──
   public/ is served by nginx in the deployed environments; serving it here
   too means `npm run dev` gives a working app on one port with no extra
   setup, and keeps the frontend same-origin with the API. */
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

/* ── DB pool ── */
const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
  /* RDS requires TLS; a local/CI postgres generally has none. */
  ssl:      process.env.DB_SSL === '0' ? false : { rejectUnauthorized: false },
  max:      10,
});

pool.on('error', (err) => {
  console.error('[DB] Idle client error:', err.message);
});

pool.connect((err, client, release) => {
  if (err) { console.error('[DB] Connection failed:', err.message); return; }
  release();
  console.log('[DB] Connected to PostgreSQL');
});

/* ── Services ──
   Instantiated once against the shared pool. Routes stay thin and delegate
   all business logic and workspace scoping here. */
const RepairOrderService    = require('./services/repair-order');
const PartsService          = require('./services/parts');
const UserManagementService = require('./services/user-management');
const ReportingService      = require('./services/reporting');
const CustomerPortalService = require('./services/customer-portal');

const repairOrderService    = new RepairOrderService(pool);
const partsService          = new PartsService(pool);
const userManagementService = new UserManagementService(pool);
const reportingService      = new ReportingService(pool);
const customerPortalService = new CustomerPortalService(pool);

/* ── Health check ── */
app.get('/api/health', createHealthRoute({ pool, verifySmtp: verifyTransporter }));

/* ── Auth routes ── */
app.post('/api/auth/login', authLimiter, async (req, res) => {
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
    sendError(res, e, 'login');
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const token = req.headers.authorization?.slice(7);
  if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  res.json({ ok: true });
});

app.post('/api/signup', writeLimiter, async (req, res) => {
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
    if (e.code === '23505') {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    return sendError(res, e, 'signup');
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
    sendError(res, e, 'workspaces');
  }
});

/* ── User routes ── */
app.get('/api/users', requireAuth(['super_admin', 'manager']), async (req, res) => {
  try {
    /* A manager may only see members of the workspaces they belong to;
       only a super_admin sees the whole directory. */
    const isAdmin = req.session.role === 'super_admin';
    const { rows } = isAdmin
      ? await pool.query(
          `SELECT id, name, email, phone, role, workspace_ids, active, last_login, created_at
             FROM users ORDER BY name`
        )
      : await pool.query(
          `SELECT id, name, email, phone, role, workspace_ids, active, last_login, created_at
             FROM users
            WHERE workspace_ids && $1::int[]
            ORDER BY name`,
          [(req.session.workspace_ids || []).map(Number)]
        );
    res.json(rows);
  } catch(e) {
    sendError(res, e, 'users');
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
    sendError(res, e, 'admin/signups');
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
    sendError(res, e, 'admin/signups/reject');
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
    sendError(res, e, 'admin/signups/approve');
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
    sendError(res, e, 'admin/signups/reinstate');
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
    sendError(res, e, 'admin/signups/:id');
  }
});

function resolveWorkspaceId(req, res) {
  /* express.json() only populates req.body for requests that carry one, and
     Express 5 leaves it undefined otherwise — so this must be optional. */
  const raw = req.query.workspaceId || req.body?.workspaceId || req.session.workspace_ids?.[0];
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
    sendError(res, e, 'test-email');
  }
});

/* ── Core customers routes ── */
const CustomerService = require('./services/customer');
const customerService = new CustomerService(pool);

app.get('/api/customers', requireAuth(), route('customers', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  const { search, limit, offset } = req.query;
  res.json(await customerService.listCustomers(workspaceId, { search, limit, offset }));
}));

app.post('/api/customers', requireAuth(['super_admin', 'manager', 'service_advisor']), route('customers:create', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  res.status(201).json(await customerService.createCustomer(req.body || {}, workspaceId));
}));

app.get('/api/customers/:id', requireAuth(), route('customers:get', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  const customer = await customerService.getCustomer(parseId(req.params.id, 'id'), workspaceId);
  if (!customer) throw new NotFoundError('Customer not found.');
  res.json(customer);
}));

/* ── Core vehicles routes ── */
const VehicleService = require('./services/vehicle');
const vehicleService = new VehicleService(pool);

app.get('/api/vehicles', requireAuth(), route('vehicles', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  const { customerId, search, limit, offset } = req.query;
  res.json(await vehicleService.listVehicles(workspaceId, {
    customerId: customerId ? parseId(customerId, 'customerId') : undefined,
    search,
    limit,
    offset,
  }));
}));

app.post('/api/vehicles', requireAuth(['super_admin', 'manager', 'service_advisor']), route('vehicles:create', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  res.status(201).json(await vehicleService.createVehicle(req.body || {}, workspaceId));
}));

app.patch('/api/vehicles/:id', requireAuth(['super_admin', 'manager', 'service_advisor']), route('vehicles:update', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  res.json(await vehicleService.updateVehicle(parseId(req.params.id, 'id'), req.body || {}, workspaceId));
}));

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
      sendError(res, e, 'import/customers');
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
      sendError(res, e, 'import/vehicles');
    }
  }
);

/* ── Core repair order routes ──
   Handlers stay thin: validation, workspace scoping, status-transition rules
   and totals all live in RepairOrderService (declared below, hoisted here by
   const-in-module order — see the service block further down). */
app.get('/api/repair-orders', requireAuth(), route('repair-orders', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  const { status, customerId, limit, offset } = req.query;
  res.json(await repairOrderService.listRepairOrders(workspaceId, {
    status,
    customerId: customerId ? parseId(customerId, 'customerId') : undefined,
    limit,
    offset,
  }));
}));

app.post('/api/repair-orders', requireAuth(['super_admin', 'manager', 'service_advisor']), route('repair-orders:create', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  const ro = await repairOrderService.createRepairOrder(workspaceId, req.body || {}, req.session.user_id);
  res.status(201).json(ro);
}));

app.patch('/api/repair-orders/:id/status', requireAuth(['super_admin', 'manager', 'service_advisor', 'technician']), route('repair-orders:status', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  const { status } = req.body || {};
  if (!status) throw new ValidationError('status is required.');
  const updated = await repairOrderService.updateRepairOrderStatus(
    parseId(req.params.id, 'id'), status, workspaceId, req.session.user_id
  );
  res.json(updated);
}));

/* ── ETL status route ── */
app.get('/api/integrations/mitchell/status', requireAuth(), route('integrations:mitchell', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  const [integration, syncLog, counts] = await Promise.all([
    pool.query(
      `SELECT active, connected_at, last_sync_at, total_synced FROM workspace_integrations
       WHERE workspace_id = $1 AND integration = 'mitchell1'`, [workspaceId]
    ),
    pool.query(
      `SELECT * FROM etl_sync_log WHERE workspace_id = $1 AND integration = 'mitchell1'
       ORDER BY last_sync_at DESC LIMIT 1`, [workspaceId]
    ),
    pool.query(
      `SELECT
         (SELECT COUNT(*) FROM customers      WHERE workspace_id = $1) AS customers,
         (SELECT COUNT(*) FROM vehicles       WHERE workspace_id = $1) AS vehicles,
         (SELECT COUNT(*) FROM repair_orders  WHERE workspace_id = $1) AS repair_orders,
         (SELECT COUNT(*) FROM ro_labor_lines WHERE workspace_id = $1) AS labor_lines,
         (SELECT COUNT(*) FROM ro_parts_lines WHERE workspace_id = $1) AS parts_lines`, [workspaceId]
    ),
  ]);

  res.json({
    connected:   integration.rows[0]?.active || false,
    connectedAt: integration.rows[0]?.connected_at || null,
    lastSync:    syncLog.rows[0] || null,
    counts:      counts.rows[0],
  });
}));

/* ── Customer history route ──
   Backed by CustomerService. This previously called a Mitchell ETL
   placeholder that always returned null, so the endpoint always 404'd. */
app.get('/api/customers/:id/history', requireAuth(), route('customers:history', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  const history = await customerService.getCustomerHistory(workspaceId, parseId(req.params.id, 'id'));
  if (!history) throw new NotFoundError('Customer not found.');
  res.json(history);
}));

/* ── Burn rate route ──
   Derived from completed repair orders by services/analytics.js. It previously
   used services/square-categories.js, which returned an all-zero dashboard. */
app.get('/api/analytics/burn-rate', requireAuth(['super_admin', 'manager']), route('analytics:burn-rate', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  const { burnRateHandler } = require('./services/analytics');
  await burnRateHandler(req, res, pool, workspaceId);
}));

/* ── Repair Order Management Routes ── */

app.get('/api/repair-orders/:id', requireAuth(), route('repair-orders:get', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  const repairOrder = await repairOrderService.getRepairOrder(parseId(req.params.id, 'id'), workspaceId);
  if (!repairOrder) throw new NotFoundError('Repair order not found.');
  res.json(repairOrder);
}));

app.post('/api/repair-orders/:id/parts', requireAuth(['super_admin', 'manager', 'service_advisor', 'technician']), route('repair-orders:parts', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  const result = await repairOrderService.addPartToRepairOrder(
    parseId(req.params.id, 'id'), req.body || {}, workspaceId, req.session.user_id
  );
  res.status(201).json(result);
}));

app.post('/api/repair-orders/:id/labor', requireAuth(['super_admin', 'manager', 'service_advisor', 'technician']), route('repair-orders:labor', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  const result = await repairOrderService.addLaborToRepairOrder(
    parseId(req.params.id, 'id'), req.body || {}, workspaceId, req.session.user_id
  );
  res.status(201).json(result);
}));

app.post('/api/repair-orders/:id/time/clock-in', requireAuth(['super_admin', 'manager', 'service_advisor', 'technician']), route('repair-orders:clock-in', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  const result = await repairOrderService.clockIn(
    parseId(req.params.id, 'id'), req.session.user_id, workspaceId, req.body?.description
  );
  res.status(201).json(result);
}));

app.post('/api/repair-orders/:id/time/clock-out', requireAuth(['super_admin', 'manager', 'service_advisor', 'technician']), route('repair-orders:clock-out', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  const result = await repairOrderService.clockOut(parseId(req.params.id, 'id'), req.session.user_id, workspaceId);
  res.json(result);
}));

/* The technician's currently open time entry, so the tech page can restore
   its clock state after a reload. */
app.get('/api/time/open', requireAuth(), route('time:open', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  res.json(await repairOrderService.getOpenTimeEntry(req.session.user_id, workspaceId));
}));

app.patch('/api/repair-orders/:id', requireAuth(['super_admin', 'manager', 'service_advisor']), route('repair-orders:update', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  const result = await repairOrderService.updateRepairOrder(
    parseId(req.params.id, 'id'), req.body || {}, workspaceId, req.session.user_id
  );
  res.json(result);
}));

/* ── Parts Management Routes ── */

app.get('/api/parts', requireAuth(), route('parts', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  const { search, category, lowStock } = req.query;
  let parts;

  if (search) {
    parts = await partsService.searchParts(search, workspaceId, { category });
  } else if (lowStock === 'true') {
    parts = await partsService.getLowStockParts(workspaceId);
  } else {
    parts = await partsService.getAllParts(workspaceId, category);
  }

  res.json(parts);
}));

app.post('/api/parts', requireAuth(['super_admin', 'manager']), route('parts:create', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  res.status(201).json(await partsService.createPart(req.body || {}, workspaceId, req.session.user_id));
}));

app.patch('/api/parts/:id', requireAuth(['super_admin', 'manager']), route('parts:update', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  res.json(await partsService.updatePart(parseId(req.params.id, 'id'), req.body || {}, workspaceId, req.session.user_id));
}));

app.post('/api/parts/:id/adjust-inventory', requireAuth(['super_admin', 'manager']), route('parts:adjust', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  const { adjustment, reason } = req.body || {};
  res.json(await partsService.adjustInventory(
    parseId(req.params.id, 'id'), adjustment, reason, workspaceId, req.session.user_id
  ));
}));

/* ── User Management Routes ──
   The service receives req.session (not just the actor's id) so it can apply
   the authority rules: only a super_admin may grant super_admin, and a
   manager may only act on non-super_admin members of their own workspace. */

/* Declared before /api/users/:id/* so the literal path wins over the
   parameterised ones. */
app.get('/api/users/workspace', requireAuth(), route('users:workspace', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  res.json(await userManagementService.getWorkspaceUsers(workspaceId));
}));

app.patch('/api/users/profile', requireAuth(), route('users:profile', async (req, res) => {
  res.json(await userManagementService.updateUserProfile(req.session.user_id, req.body || {}));
}));

app.post('/api/users/invite', requireAuth(['super_admin', 'manager']), route('users:invite', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  res.status(201).json(await userManagementService.inviteUser(workspaceId, req.body || {}, req.session));
}));

app.patch('/api/users/:id/role', requireAuth(['super_admin', 'manager']), route('users:role', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  const { role } = req.body || {};
  res.json(await userManagementService.updateUserRole(parseId(req.params.id, 'id'), workspaceId, role, req.session));
}));

app.delete('/api/users/:id/workspace', requireAuth(['super_admin', 'manager']), route('users:remove', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  res.json(await userManagementService.removeUserFromWorkspace(parseId(req.params.id, 'id'), workspaceId, req.session));
}));

app.post('/api/users/:id/deactivate', requireAuth(['super_admin']), route('users:deactivate', async (req, res) => {
  res.json(await userManagementService.deactivateUser(parseId(req.params.id, 'id'), req.session));
}));

app.post('/api/users/:id/reactivate', requireAuth(['super_admin']), route('users:reactivate', async (req, res) => {
  res.json(await userManagementService.reactivateUser(parseId(req.params.id, 'id'), req.session));
}));

app.post('/api/users/:id/reset-password', requireAuth(['super_admin', 'manager']), route('users:reset-password', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  res.json(await userManagementService.resetUserPassword(parseId(req.params.id, 'id'), workspaceId, req.session));
}));

/* ── Reporting & Analytics Routes ── */

/** Pull an optional {startDate, endDate} window off the query string. */
function dateRangeFrom(req) {
  const { startDate, endDate } = req.query;
  return startDate && endDate ? { startDate, endDate } : {};
}

app.get('/api/reports/financial-summary', requireAuth(['super_admin', 'manager']), route('reports:financial', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  res.json(await reportingService.getFinancialSummary(workspaceId, dateRangeFrom(req)));
}));

app.get('/api/reports/technician-performance', requireAuth(['super_admin', 'manager']), route('reports:tech', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  res.json(await reportingService.getTechnicianPerformance(workspaceId, dateRangeFrom(req)));
}));

app.get('/api/reports/customer-analytics', requireAuth(['super_admin', 'manager']), route('reports:customers', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  res.json(await reportingService.getCustomerAnalytics(workspaceId, dateRangeFrom(req)));
}));

app.get('/api/reports/parts-analytics', requireAuth(['super_admin', 'manager']), route('reports:parts', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  res.json(await reportingService.getPartsAnalytics(workspaceId, dateRangeFrom(req)));
}));

app.get('/api/reports/revenue-trends', requireAuth(['super_admin', 'manager']), route('reports:revenue', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  res.json(await reportingService.getRevenueTrends(workspaceId, Number(req.query.months) || 12));
}));

app.get('/api/reports/shop-kpis', requireAuth(['super_admin', 'manager']), route('reports:kpis', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;
  res.json(await reportingService.getShopKPIs(workspaceId, dateRangeFrom(req)));
}));

app.get('/api/reports/export', requireAuth(['super_admin', 'manager']), route('reports:export', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  const { format = 'json' } = req.query;
  const data = await reportingService.exportRepairOrderData(workspaceId, format, dateRangeFrom(req));

  /* exportRepairOrderData already renders CSV; send it as a file rather than
     wrapping the string in JSON. */
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="repair-orders.csv"');
    return res.send(data);
  }
  res.json(data);
}));

/* ── Staff-side appointments ──
   The portal lets customers request appointments; the shop needs to see and
   act on them. Scoped by workspace_id (added in migration 007). */
app.get('/api/appointments', requireAuth(), route('appointments', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  const params = [workspaceId];
  let sql = 'SELECT * FROM appointment_summary WHERE workspace_id = $1';
  if (req.query.status) {
    params.push(req.query.status);
    sql += ` AND status = $${params.length}`;
  }
  sql += ' ORDER BY preferred_date ASC, preferred_time ASC NULLS LAST LIMIT 200';

  const { rows } = await pool.query(sql, params);
  res.json(rows);
}));

app.patch('/api/appointments/:id', requireAuth(['super_admin', 'manager', 'service_advisor']), route('appointments:update', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  const { status } = req.body || {};
  const allowed = ['pending', 'confirmed', 'in_progress', 'completed', 'cancelled'];
  if (!allowed.includes(status)) {
    throw new ValidationError(`status must be one of: ${allowed.join(', ')}.`);
  }

  /* $1 is cast explicitly: it is both assigned to status and compared inside
     the CASE, which otherwise leaves its type ambiguous. */
  const { rows } = await pool.query(
    `UPDATE appointments
        SET status = $1::text,
            confirmed_by = CASE WHEN $1::text = 'confirmed' THEN $2::int ELSE confirmed_by END,
            confirmed_date = CASE WHEN $1::text = 'confirmed' THEN NOW() ELSE confirmed_date END
      WHERE id = $3 AND workspace_id = $4
      RETURNING *`,
    [status, req.session.user_id, parseId(req.params.id, 'id'), workspaceId]
  );
  if (!rows.length) throw new NotFoundError('Appointment not found.');
  res.json(rows[0]);
}));

/* ── Customer Portal Routes ── */

/* Public: the portal login page needs to offer a shop to sign in to. Only
   id and name are exposed. */
app.get('/api/customer/workspaces', route('customer:workspaces', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name FROM workspaces WHERE active = true ORDER BY name'
  );
  res.json(rows);
}));

// Customer authentication
app.post('/api/customer/login', authLimiter, route('customer:login', async (req, res) => {
  const { email, password, workspaceId } = req.body || {};

  if (!email || !password || !workspaceId) {
    throw new ValidationError('Email, password, and workspaceId are required.');
  }

  const result = await customerPortalService.customerLogin(email, password, parseId(workspaceId, 'workspaceId'));
  res.json(result);
}));

app.post('/api/customer/logout', route('customer:logout', async (req, res) => {
  const sessionToken = req.headers.authorization?.slice(7);
  if (!sessionToken) throw new ValidationError('Session token required.');

  await customerPortalService.logout(sessionToken);
  res.json({ success: true });
}));

// Customer portal middleware
function requireCustomerAuth() {
  return async (req, res, next) => {
    const sessionToken = req.headers.authorization?.slice(7);

    if (!sessionToken) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    try {
      const customer = await customerPortalService.validateSession(sessionToken);
      if (!customer) {
        return res.status(401).json({ error: 'Invalid or expired session.' });
      }

      req.customer = customer;
      next();
    } catch (e) {
      sendError(res, e, 'customer:auth');
    }
  };
}

// Customer service history
app.get('/api/customer/service-history', requireCustomerAuth(), route('customer:history', async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  res.json(await customerPortalService.getServiceHistory(req.customer.id, limit, offset));
}));

// Customer vehicles
app.get('/api/customer/vehicles', requireCustomerAuth(), route('customer:vehicles', async (req, res) => {
  res.json(await customerPortalService.getCustomerVehicles(req.customer.id));
}));

// Customer appointments
app.post('/api/customer/appointments', requireCustomerAuth(), route('customer:appointments:create', async (req, res) => {
  res.status(201).json(await customerPortalService.scheduleAppointment(req.customer.id, req.body || {}));
}));

app.get('/api/customer/appointments', requireCustomerAuth(), route('customer:appointments', async (req, res) => {
  res.json(await customerPortalService.getCustomerAppointments(req.customer.id, req.query.status));
}));

app.patch('/api/customer/appointments/:id', requireCustomerAuth(), route('customer:appointments:update', async (req, res) => {
  res.json(await customerPortalService.updateAppointment(
    parseId(req.params.id, 'id'), req.customer.id, req.body || {}
  ));
}));

app.delete('/api/customer/appointments/:id', requireCustomerAuth(), route('customer:appointments:cancel', async (req, res) => {
  res.json(await customerPortalService.cancelAppointment(parseId(req.params.id, 'id'), req.customer.id));
}));

// Customer feedback
app.post('/api/customer/feedback', requireCustomerAuth(), route('customer:feedback', async (req, res) => {
  const { repairOrderId, rating, comments, feedbackType } = req.body || {};
  res.status(201).json(await customerPortalService.submitFeedback(
    req.customer.id, parseId(repairOrderId, 'repairOrderId'), { rating, comments, feedbackType }
  ));
}));

// Customer profile management
app.get('/api/customer/profile', requireCustomerAuth(), route('customer:profile', async (req, res) => {
  res.json(await customerPortalService.getCustomerProfile(req.customer.id));
}));

app.patch('/api/customer/profile', requireCustomerAuth(), route('customer:profile:update', async (req, res) => {
  res.json(await customerPortalService.updateCustomerProfile(req.customer.id, req.body || {}));
}));

app.patch('/api/customer/change-password', requireCustomerAuth(), route('customer:password', async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  res.json(await customerPortalService.updatePortalPassword(req.customer.id, currentPassword, newPassword));
}));

/* Admin endpoints for customer portal management.
   These take the workspace from the session and scope the update to it, so a
   manager cannot enable portal access for, or reset the password of, a
   customer belonging to another shop. */
app.post('/api/admin/customers/:id/enable-portal', requireAuth(['super_admin', 'manager']), route('admin:enable-portal', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  const tempPassword = customerPortalService.generateTempPassword();
  res.json(await customerPortalService.enablePortalAccess(parseId(req.params.id, 'id'), tempPassword, workspaceId));
}));

app.post('/api/admin/customers/:id/reset-portal-password', requireAuth(['super_admin', 'manager']), route('admin:reset-portal', async (req, res) => {
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) return;

  res.json(await customerPortalService.resetPortalPassword(parseId(req.params.id, 'id'), workspaceId));
}));

/* ── Forgot password ── */
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
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
app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
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
    sendError(res, e, 'reset-password');
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

/* ── Root ──
   public/ has no index.html, so the bare domain would 404. Send people to the
   staff sign-in, which redirects on to their portal once authenticated. */
app.get('/', (req, res) => res.redirect('/login.html'));

/* ── Fallbacks ──
   An unmatched /api/* path fell through to Express's default handler, which
   returns an HTML error page — every other API response is JSON, and a client
   parsing this would fail on the markup rather than read the status. */
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found.' });
});

/* Last-resort error handler. Anything that reaches here is a fault we did not
   anticipate: log it in full, tell the client nothing about it. Express needs
   all four parameters to recognise this as an error handler. */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  sendError(res, err, `${req.method} ${req.path}`);
});

/* ── Start server ──
   Only when run directly (`node server.js`). Importing this module — as the
   tests do — gives you the app and pool without binding a port. */
const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[AG Shop Pro API] Running on port ${PORT}`);
    console.log(`[AG Shop Pro API] Health: http://localhost:${PORT}/api/health`);
  });
}

module.exports = app;
module.exports.app = app;
module.exports.pool = pool;
