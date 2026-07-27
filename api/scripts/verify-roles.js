#!/usr/bin/env node
/**
 * Log in as every seeded demo account against a running environment and assert
 * each one sees exactly what its role should see -- and is refused what it
 * should not.
 *
 *   node scripts/verify-roles.js --base-url https://preprod.agshopro.com --creds ~/agshop-preprod.bw.json
 *   node scripts/verify-roles.js --base-url http://127.0.0.1:3000 --creds ./demo.json
 *
 * This exercises the deployed stack over HTTP rather than the database, so it
 * catches the class of problem the integration suite cannot: a scoping regression
 * that only appears once nginx, sessions and the real RBAC middleware are in the
 * path. It reads the credential artifact seed-demo.js produced, so it never needs
 * a password of its own.
 *
 * Exits non-zero if any expectation fails, which makes it usable as a
 * post-deploy gate.
 */
const fs = require('fs');

const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const BASE = (arg('--base-url', '') || '').replace(/\/$/, '');
const CREDS = arg('--creds', '');

if (!BASE || !CREDS) {
  console.error('Usage: verify-roles.js --base-url <url> --creds <bitwarden-json from seed-demo.js>');
  process.exit(64);
}

/* Which endpoints each role may reach. Mirrors the requireAuth() lists in
   server.js; if those change, this must change with them, deliberately -- an
   RBAC change should be a visible edit here rather than a silent drift. */
const MATRIX = {
  super_admin:     { allow: ['customers', 'repairOrders', 'parts', 'users', 'reports', 'invoices', 'receivables'], deny: [] },
  manager:         { allow: ['customers', 'repairOrders', 'parts', 'users', 'reports', 'invoices', 'receivables'], deny: [] },
  service_advisor: { allow: ['customers', 'repairOrders', 'parts', 'invoices', 'receivables'], deny: ['users', 'reports'] },
  technician:      { allow: ['customers', 'repairOrders', 'parts'], deny: ['users', 'reports', 'invoices', 'receivables'] },
};

const ENDPOINTS = {
  customers:    (ws) => `/api/customers?workspaceId=${ws}`,
  repairOrders: (ws) => `/api/repair-orders?workspaceId=${ws}`,
  parts:        (ws) => `/api/parts?workspaceId=${ws}`,
  users:        (ws) => `/api/users?workspaceId=${ws}`,
  reports:      (ws) => `/api/reports/financial-summary?workspaceId=${ws}`,
  invoices:     (ws) => `/api/invoices?workspaceId=${ws}`,
  receivables:  (ws) => `/api/invoices/receivables?workspaceId=${ws}`,
};

let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const pass = (msg) => console.log(`  ok    ${msg}`);

async function req(path, token) {
  const res = await fetch(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  return { status: res.status, body };
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: username, password }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, token: body.token, user: body.user };
}

function parseCredentials(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (raw.items || []).map((item) => {
    const notes = item.notes || '';
    const pick = (label) => (notes.match(new RegExp(`^${label}: (.*)$`, 'm')) || [])[1] || '';
    return {
      name: item.name,
      username: item.login.username,
      password: item.login.password,
      role: pick('Role'),
      userId: pick('User id'),
      workspaceIds: pick('Workspace ids').split(',').map((s) => s.trim()).filter(Boolean),
    };
  });
}

async function main() {
  const creds = parseCredentials(CREDS);
  const staff = creds.filter((c) => MATRIX[c.role]);
  const portal = creds.filter((c) => c.role === 'customer');

  console.log(`[verify] ${BASE}`);
  console.log(`[verify] ${staff.length} staff account(s), ${portal.length} portal account(s)\n`);

  const sessions = [];

  for (const c of staff) {
    console.log(`${c.role} — ${c.username}`);

    const auth = await login(c.username, c.password);
    if (auth.status !== 200 || !auth.token) {
      fail(`login returned ${auth.status}`);
      continue;
    }
    pass('login');

    if (auth.user && auth.user.id !== c.userId) {
      fail(`session user id ${auth.user.id} does not match seeded ${c.userId}`);
    } else if (auth.user && !/^usr-/.test(auth.user.id)) {
      fail(`user id ${auth.user.id} is not a string id`);
    } else {
      pass(`string user id ${c.userId}`);
    }

    const ws = c.workspaceIds[0];
    if (!ws) { fail('no workspace id in credential notes'); continue; }

    for (const key of MATRIX[c.role].allow) {
      const res = await req(ENDPOINTS[key](ws), auth.token);
      if (res.status === 200) pass(`${key} allowed (200)`);
      else fail(`${key} should be allowed but returned ${res.status}`);
    }
    for (const key of MATRIX[c.role].deny) {
      const res = await req(ENDPOINTS[key](ws), auth.token);
      if (res.status === 403) pass(`${key} denied (403)`);
      else fail(`${key} should be denied for ${c.role} but returned ${res.status}`);
    }

    sessions.push({ ...c, token: auth.token, ws });
    console.log('');
  }

  /* Cross-tenant isolation: every account tries every OTHER workspace it is not
     a member of. A super_admin legitimately spans workspaces, so it is exempt. */
  console.log('cross-tenant isolation');
  const allWorkspaces = [...new Set(sessions.flatMap((s) => s.workspaceIds))];
  for (const s of sessions) {
    if (s.role === 'super_admin') continue;
    for (const foreign of allWorkspaces.filter((w) => !s.workspaceIds.includes(w))) {
      const res = await req(ENDPOINTS.customers(foreign), s.token);
      if (res.status === 403 || res.status === 404) {
        pass(`${s.role} ${s.username} refused ${foreign} (${res.status})`);
      } else if (res.status === 200 && Array.isArray(res.body) && res.body.length === 0) {
        fail(`${s.role} reached ${foreign} with 200 and an empty list — scoping should refuse, not filter`);
      } else {
        fail(`${s.role} ${s.username} reached foreign workspace ${foreign} (${res.status})`);
      }
    }
  }
  console.log('');

  /* Unauthenticated access must be refused everywhere. */
  console.log('unauthenticated');
  for (const [key, build] of Object.entries(ENDPOINTS)) {
    const res = await req(build(allWorkspaces[0] || 'ws-none'), null);
    if (res.status === 401) pass(`${key} requires auth (401)`);
    else fail(`${key} returned ${res.status} without a token`);
  }
  console.log('');

  /* Customer portal accounts authenticate on their own endpoint, and must supply
     the workspace they belong to -- customers are scoped to one shop, so the same
     email at two shops is two distinct portal identities. */
  if (portal.length) {
    console.log('customer portal');
    for (const p of portal) {
      const workspaceId = p.workspaceIds[0];
      if (!workspaceId) { fail(`no workspace id for portal account ${p.username}`); continue; }

      const res = await fetch(`${BASE}/api/customer/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: p.username, password: p.password, workspaceId }),
      });
      const body = await res.json().catch(() => ({}));
      /* customerLogin returns `sessionToken`, not `token` -- customers are a
         separate identity system from staff, with their own customer_sessions
         table and their own requireCustomerAuth middleware. */
      const sessionToken = body.sessionToken;
      if (res.status !== 200 || !sessionToken) {
        fail(`portal login ${p.username} returned ${res.status}${sessionToken ? '' : ' with no sessionToken'}`);
        continue;
      }
      pass(`portal login ${p.username}`);

      /* The token must work on the portal's own endpoints... */
      const history = await req('/api/customer/service-history', sessionToken);
      if (history.status === 200) pass('portal token works on service-history');
      else fail(`portal token rejected by service-history (${history.status})`);

      /* ...and must NOT be interchangeable with a staff session. */
      const leak = await req(ENDPOINTS.customers(workspaceId), sessionToken);
      if (leak.status === 200) fail(`portal token reached the staff customers endpoint (${leak.status})`);
      else pass(`portal token refused on staff endpoint (${leak.status})`);
    }
    console.log('');
  }

  if (failures) {
    console.log(`[verify] ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('[verify] all checks passed');
}

main().catch((err) => {
  console.error('[verify]', err.message);
  process.exit(1);
});
