/**
 * Integration test harness.
 *
 * Builds a real PostgreSQL database from the migrations in api/migrations,
 * boots the real Express app against it, and drives it over real HTTP. No
 * mocks: workspace isolation and the SQL that enforces it are exactly what is
 * under test, and a stubbed pool would prove nothing about either.
 *
 * Requires a reachable PostgreSQL. Configure with TEST_DB_* or DB_* env vars;
 * see api/test/README.md.
 */

const { Client } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const ADMIN_DB = process.env.TEST_DB_ADMIN || 'postgres';
const TEST_DB = process.env.TEST_DB_NAME || 'agshop_test';

function baseConfig() {
  return {
    host: process.env.TEST_DB_HOST || process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.TEST_DB_PORT || process.env.DB_PORT, 10) || 5432,
    user: process.env.TEST_DB_USER || process.env.DB_USER || 'postgres',
    password: process.env.TEST_DB_PASS || process.env.DB_PASS || '',
    ssl: (process.env.TEST_DB_SSL || process.env.DB_SSL) === '0' ? false : undefined,
  };
}

/** Drop and recreate the test database, then apply every migration in order. */
async function resetDatabase() {
  const admin = new Client({ ...baseConfig(), database: ADMIN_DB });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const db = new Client({ ...baseConfig(), database: TEST_DB });
  await db.connect();

  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    try {
      await db.query(sql);
    } catch (e) {
      throw new Error(`Migration ${file} failed: ${e.message}`);
    }
  }
  await db.end();
  return files;
}

/**
 * Point the app at the test database and boot it on an ephemeral port.
 * Must be called before requiring server.js, which reads env at import time.
 */
async function startServer() {
  const cfg = baseConfig();
  process.env.DB_HOST = String(cfg.host);
  process.env.DB_PORT = String(cfg.port);
  process.env.DB_NAME = TEST_DB;
  process.env.DB_USER = String(cfg.user);
  process.env.DB_PASS = String(cfg.password);
  process.env.DB_SSL = '0';
  process.env.HEALTH_SKIP_SMTP = '1';
  process.env.NODE_ENV = 'test';

  const mod = require('../server');
  const app = mod.app || mod;
  const pool = mod.pool;

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    server,
    pool,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    },
  };
}

/** Minimal JSON HTTP client that returns { status, body }. */
function makeClient(baseUrl) {
  async function request(method, path, { token, body, raw } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    if (raw) return { status: res.status, body: text };

    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed };
  }

  return {
    get:   (p, o) => request('GET', p, o),
    post:  (p, body, o) => request('POST', p, { ...o, body }),
    patch: (p, body, o) => request('PATCH', p, { ...o, body }),
    del:   (p, o) => request('DELETE', p, o),
  };
}

/* ── Seeding ── */

async function seedWorkspace(pool, name) {
  // workspaces.id is VARCHAR(64) with no default, matching production; the app
  // generates "ws-<uuid>" ids (see services/signup.js), so seeds must too.
  const id = `ws-${crypto.randomUUID()}`;
  const { rows } = await pool.query(
    `INSERT INTO workspaces (id, name, type, plan, active) VALUES ($1,$2,'mechanic','pro',true) RETURNING *`,
    [id, name]
  );
  return rows[0];
}

/**
 * Create an active user and sign them in. Returns { user, token }.
 */
async function seedUser(pool, client, { email, role, workspaceIds, password = 'Password123!', name }) {
  const hash = await bcrypt.hash(password, 4); // low cost: these are throwaway
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, workspace_ids, active)
     VALUES ($1,$2,$3,$4,$5,true)
     RETURNING id, name, email, role, workspace_ids`,
    [name || email, email.toLowerCase(), hash, role, workspaceIds]
  );

  const res = await client.post('/api/auth/login', { email, password });
  if (res.status !== 200) {
    throw new Error(`seedUser login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { user: rows[0], token: res.body.token, password };
}

async function seedCustomer(pool, workspaceId, { fullName = 'Test Customer', email = null, phone = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO customers (workspace_id, full_name, email, phone) VALUES ($1,$2,$3,$4) RETURNING *`,
    [workspaceId, fullName, email, phone]
  );
  return rows[0];
}

async function seedVehicle(pool, workspaceId, customerId, overrides = {}) {
  const v = { vin: `VIN${Math.random().toString(36).slice(2, 12).toUpperCase()}`, year: 2020, make: 'Honda', model: 'Civic', plate: 'ABC123', mileage: 40000, ...overrides };
  const { rows } = await pool.query(
    `INSERT INTO vehicles (workspace_id, customer_id, vin, year, make, model, plate, mileage)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [workspaceId, customerId, v.vin, v.year, v.make, v.model, v.plate, v.mileage]
  );
  return rows[0];
}

async function enablePortal(pool, customerId, password) {
  const hash = await bcrypt.hash(password, 4);
  await pool.query(
    'UPDATE customers SET portal_password_hash = $1, portal_enabled = true WHERE id = $2',
    [hash, customerId]
  );
}

module.exports = {
  TEST_DB,
  resetDatabase,
  startServer,
  makeClient,
  seedWorkspace,
  seedUser,
  seedCustomer,
  seedVehicle,
  enablePortal,
};
