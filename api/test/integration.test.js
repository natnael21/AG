/**
 * End-to-end API tests against a real PostgreSQL database.
 *
 * Two workspaces are seeded throughout so that every read path can be checked
 * for tenant leakage, not just the happy path.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resetDatabase,
  startServer,
  makeClient,
  seedWorkspace,
  seedUser,
  seedCustomer,
  seedVehicle,
  enablePortal,
} = require('./helpers');

let ctx;      // { baseUrl, pool, close }
let api;      // http client
let shopA, shopB;
let adminA, managerA, advisorA, techA, managerB;

test.before(async () => {
  await resetDatabase();
  ctx = await startServer();
  api = makeClient(ctx.baseUrl);

  shopA = await seedWorkspace(ctx.pool, 'Shop A');
  shopB = await seedWorkspace(ctx.pool, 'Shop B');

  adminA   = await seedUser(ctx.pool, api, { email: 'admin@a.test',   role: 'super_admin',     workspaceIds: [shopA.id, shopB.id] });
  managerA = await seedUser(ctx.pool, api, { email: 'manager@a.test', role: 'manager',         workspaceIds: [shopA.id] });
  advisorA = await seedUser(ctx.pool, api, { email: 'advisor@a.test', role: 'service_advisor', workspaceIds: [shopA.id] });
  techA    = await seedUser(ctx.pool, api, { email: 'tech@a.test',    role: 'technician',      workspaceIds: [shopA.id], name: 'Tech A' });
  managerB = await seedUser(ctx.pool, api, { email: 'manager@b.test', role: 'manager',         workspaceIds: [shopB.id] });
});

test.after(async () => {
  if (ctx) await ctx.close();
});

/* ── Authentication ── */

test('health check reports database connectivity', async () => {
  const res = await api.get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.checks.database.status, 'ok');
});

test('login rejects a wrong password without revealing the account exists', async () => {
  const res = await api.post('/api/auth/login', { email: 'manager@a.test', password: 'wrong' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Incorrect email or password.');
});

test('login rejects an unknown email with the same message', async () => {
  const res = await api.post('/api/auth/login', { email: 'nobody@a.test', password: 'Password123!' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Incorrect email or password.');
});

test('protected routes reject a missing or invalid token', async () => {
  assert.equal((await api.get('/api/customers')).status, 401);
  assert.equal((await api.get('/api/customers', { token: 'not-a-real-token' })).status, 401);
});

test('logout invalidates the session token', async () => {
  const tmp = await seedUser(ctx.pool, api, { email: 'logout@a.test', role: 'manager', workspaceIds: [shopA.id] });
  assert.equal((await api.get('/api/customers', { token: tmp.token })).status, 200);

  await api.post('/api/auth/logout', {}, { token: tmp.token });
  assert.equal((await api.get('/api/customers', { token: tmp.token })).status, 401);
});

/* ── Password reset ── */

test('forgot-password gives the same generic answer whether or not the email exists', async () => {
  const known = await api.post('/api/auth/forgot-password', { email: 'manager@a.test' });
  assert.equal(known.status, 200);
  assert.equal(known.body.ok, true);

  const unknown = await api.post('/api/auth/forgot-password', { email: 'ghost@nowhere.test' });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, known.body, 'the response must not reveal whether an account exists');
});

test('a reset token lets a user set a new password, ends old sessions, and is single-use', async () => {
  const user = await seedUser(ctx.pool, api, { email: 'resetme@a.test', role: 'technician', workspaceIds: [shopA.id] });
  assert.equal((await api.get('/api/customers', { token: user.token })).status, 200);

  /* Stand in for what forgot-password stores; the email carries this token. */
  const token = `reset-token-${user.user.id}`;
  await ctx.pool.query(
    `UPDATE users SET reset_token = $1, reset_expiry = NOW() + INTERVAL '1 hour' WHERE id = $2`,
    [token, user.user.id]
  );

  const res = await api.post('/api/auth/reset-password', { token, password: 'FreshPass123!' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.token, 'a successful reset should return a new session token');

  assert.equal((await api.get('/api/customers', { token: user.token })).status, 401,
    'resetting the password must invalidate existing sessions');

  const relogin = await api.post('/api/auth/login', { email: 'resetme@a.test', password: 'FreshPass123!' });
  assert.equal(relogin.status, 200);

  const reuse = await api.post('/api/auth/reset-password', { token, password: 'AnotherPass123!' });
  assert.equal(reuse.status, 410, 'a consumed reset token must not work a second time');
});

test('reset-password refuses an expired token', async () => {
  const user = await seedUser(ctx.pool, api, { email: 'expired@a.test', role: 'technician', workspaceIds: [shopA.id] });
  await ctx.pool.query(
    `UPDATE users SET reset_token = 'expired-tok', reset_expiry = NOW() - INTERVAL '1 minute' WHERE id = $1`,
    [user.user.id]
  );
  const res = await api.post('/api/auth/reset-password', { token: 'expired-tok', password: 'FreshPass123!' });
  assert.equal(res.status, 410);
});

/* ── Authorization ── */

test('a technician cannot create a customer', async () => {
  const res = await api.post('/api/customers', { fullName: 'Nope' }, { token: techA.token });
  assert.equal(res.status, 403);
});

test('a service advisor cannot reach manager-only reports', async () => {
  const res = await api.get('/api/reports/financial-summary', { token: advisorA.token });
  assert.equal(res.status, 403);
});

/* ── Workspace isolation ── */

test('a manager cannot read another workspace by passing its workspaceId', async () => {
  const res = await api.get(`/api/customers?workspaceId=${shopB.id}`, { token: managerA.token });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Workspace access denied.');
});

test('customers are scoped to the active workspace', async () => {
  await seedCustomer(ctx.pool, shopA.id, { fullName: 'Belongs to A' });
  await seedCustomer(ctx.pool, shopB.id, { fullName: 'Belongs to B' });

  const res = await api.get('/api/customers', { token: managerA.token });
  assert.equal(res.status, 200);
  const names = res.body.map((c) => c.full_name);
  assert.ok(names.includes('Belongs to A'));
  assert.ok(!names.includes('Belongs to B'), 'Shop B customer leaked into Shop A');
});

test("a customer from another workspace is not readable by id", async () => {
  const foreign = await seedCustomer(ctx.pool, shopB.id, { fullName: 'Foreign' });
  const res = await api.get(`/api/customers/${foreign.id}`, { token: managerA.token });
  assert.equal(res.status, 404);
});

test('a super_admin may act in any workspace they belong to', async () => {
  const res = await api.get(`/api/customers?workspaceId=${shopB.id}`, { token: adminA.token });
  assert.equal(res.status, 200);
});

test('a manager only sees users from their own workspaces', async () => {
  const res = await api.get('/api/users', { token: managerA.token });
  assert.equal(res.status, 200);
  const emails = res.body.map((u) => u.email);
  assert.ok(emails.includes('manager@a.test'));
  assert.ok(!emails.includes('manager@b.test'), 'Shop B user leaked to a Shop A manager');
});

/* ── Signup provisioning authority ── */

test('an approved shop owner is a manager of their own shop, not a platform admin', async () => {
  const signup = await api.post('/api/signup', {
    first: 'New', last: 'Owner', email: 'newowner@shop.test', shop: 'Newly Signed Up Shop',
  });
  assert.equal(signup.status, 201);

  const approved = await api.post(`/api/admin/signups/${signup.body.signup.id}/approve`, {}, { token: adminA.token });
  assert.equal(approved.status, 200, `approve failed: ${JSON.stringify(approved.body)}`);

  /* Provisioning used to assign 'super_admin', for which resolveWorkspaceId
     skips the workspace allowlist — so every shop that signed up could read
     every other shop's data. */
  assert.equal(approved.body.user.role, 'manager',
    'a shop owner must not be provisioned as a platform super_admin');

  const owner = await api.post('/api/auth/login',
    { email: 'newowner@shop.test', password: approved.body.tempPassword });
  assert.equal(owner.status, 200);
  const token = owner.body.token;

  /* Their own shop works. */
  const own = await api.get('/api/customers', { token });
  assert.equal(own.status, 200);

  /* Another shop does not. */
  const foreign = await api.get(`/api/customers?workspaceId=${shopA.id}`, { token });
  assert.equal(foreign.status, 403, "a new shop owner must not read another shop's customers");

  const foreignROs = await api.get(`/api/repair-orders?workspaceId=${shopA.id}`, { token });
  assert.equal(foreignROs.status, 403);

  /* And they cannot review other shops' signup requests. */
  const signups = await api.get('/api/admin/signups', { token });
  assert.equal(signups.status, 403, 'a shop owner must not see the platform signup queue');

  /* /api/workspaces must only list their own shop. */
  const workspaces = await api.get('/api/workspaces', { token });
  assert.equal(workspaces.status, 200);
  assert.equal(workspaces.body.length, 1);
  assert.equal(workspaces.body[0].name, 'Newly Signed Up Shop');
});

/* ── Customer creation ── */

test('creating a customer requires a name', async () => {
  const res = await api.post('/api/customers', { email: 'x@x.test' }, { token: advisorA.token });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /fullName/);
});

test('a customer can be created and read back', async () => {
  const res = await api.post('/api/customers',
    { fullName: 'Ada Lovelace', email: 'ada@a.test', phone: '5551234' },
    { token: advisorA.token });

  assert.equal(res.status, 201);
  assert.equal(res.body.full_name, 'Ada Lovelace');
  assert.equal(res.body.workspace_id, shopA.id);

  const read = await api.get(`/api/customers/${res.body.id}`, { token: advisorA.token });
  assert.equal(read.status, 200);
  assert.equal(read.body.email, 'ada@a.test');
  assert.deepEqual(read.body.vehicles, []);
});

test('duplicate customer email in the same workspace is rejected', async () => {
  await api.post('/api/customers', { fullName: 'Dup One', email: 'dup@a.test' }, { token: advisorA.token });
  const res = await api.post('/api/customers', { fullName: 'Dup Two', email: 'dup@a.test' }, { token: advisorA.token });
  assert.equal(res.status, 409);
});

/* ── Vehicle creation ── */

test('a vehicle cannot be attached to a customer in another workspace', async () => {
  const foreign = await seedCustomer(ctx.pool, shopB.id, { fullName: 'B Customer' });
  const res = await api.post('/api/vehicles',
    { customerId: foreign.id, vin: 'FOREIGNVIN123', make: 'Ford', model: 'F150' },
    { token: advisorA.token });

  assert.equal(res.status, 404, 'must not attach a vehicle to another tenant\'s customer');
});

test('a vehicle is created and filtered by customer', async () => {
  const customer = await seedCustomer(ctx.pool, shopA.id, { fullName: 'Vehicle Owner' });
  const res = await api.post('/api/vehicles',
    { customerId: customer.id, vin: 'jh4ka7561pc008269', year: 2021, make: 'Toyota', model: 'Corolla', plate: 'XYZ789' },
    { token: advisorA.token });

  assert.equal(res.status, 201);
  assert.equal(res.body.vin, 'JH4KA7561PC008269', 'VIN should be normalised to upper case');

  const list = await api.get(`/api/vehicles?customerId=${customer.id}`, { token: advisorA.token });
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].customer_name, 'Vehicle Owner');
});

test('a duplicate VIN in the same workspace is rejected', async () => {
  const customer = await seedCustomer(ctx.pool, shopA.id);
  const body = { customerId: customer.id, vin: 'DUPVIN0001', make: 'Kia', model: 'Rio' };
  assert.equal((await api.post('/api/vehicles', body, { token: advisorA.token })).status, 201);
  assert.equal((await api.post('/api/vehicles', body, { token: advisorA.token })).status, 409);
});

test('an invalid vehicle year is rejected', async () => {
  const customer = await seedCustomer(ctx.pool, shopA.id);
  const res = await api.post('/api/vehicles',
    { customerId: customer.id, vin: 'BADYEAR001', make: 'Kia', model: 'Rio', year: 1799 },
    { token: advisorA.token });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /year/);
});

/* ── Repair orders ── */

async function makeRO(token = advisorA.token) {
  const customer = await seedCustomer(ctx.pool, shopA.id, { fullName: 'RO Customer' });
  const vehicle = await seedVehicle(ctx.pool, shopA.id, customer.id);
  const res = await api.post('/api/repair-orders',
    { customerId: customer.id, vehicleId: vehicle.id, concern: 'Brakes squealing' },
    { token });
  assert.equal(res.status, 201, `RO create failed: ${JSON.stringify(res.body)}`);
  return { customer, vehicle, ro: res.body };
}

test('a repair order is created with an open status and a workspace-unique number', async () => {
  const { ro } = await makeRO();
  assert.equal(ro.status, 'open');
  assert.equal(ro.workspace_id, shopA.id);
  assert.match(ro.ro_number, /^RO-\d+$/);
});

test('repair order numbers do not collide when created in the same millisecond', async () => {
  const customer = await seedCustomer(ctx.pool, shopA.id);
  const vehicle = await seedVehicle(ctx.pool, shopA.id, customer.id);

  const results = await Promise.all(Array.from({ length: 5 }, () =>
    api.post('/api/repair-orders',
      { customerId: customer.id, vehicleId: vehicle.id, concern: 'Concurrent' },
      { token: advisorA.token })
  ));

  const created = results.filter((r) => r.status === 201);
  assert.equal(created.length, 5, `expected 5 creates, got statuses ${results.map((r) => r.status)}`);
  const numbers = new Set(created.map((r) => r.body.ro_number));
  assert.equal(numbers.size, 5, 'RO numbers collided');
});

test('a repair order rejects a vehicle that belongs to a different customer', async () => {
  const c1 = await seedCustomer(ctx.pool, shopA.id, { fullName: 'Owner One' });
  const c2 = await seedCustomer(ctx.pool, shopA.id, { fullName: 'Owner Two' });
  const v2 = await seedVehicle(ctx.pool, shopA.id, c2.id);

  const res = await api.post('/api/repair-orders',
    { customerId: c1.id, vehicleId: v2.id, concern: 'Mismatched' },
    { token: advisorA.token });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /does not belong/);
});

test('a repair order rejects a customer from another workspace', async () => {
  const foreign = await seedCustomer(ctx.pool, shopB.id);
  const foreignVehicle = await seedVehicle(ctx.pool, shopB.id, foreign.id);

  const res = await api.post('/api/repair-orders',
    { customerId: foreign.id, vehicleId: foreignVehicle.id, concern: 'Cross tenant' },
    { token: advisorA.token });

  assert.equal(res.status, 404);
});

test('a repair order requires a concern', async () => {
  const customer = await seedCustomer(ctx.pool, shopA.id);
  const vehicle = await seedVehicle(ctx.pool, shopA.id, customer.id);
  const res = await api.post('/api/repair-orders',
    { customerId: customer.id, vehicleId: vehicle.id },
    { token: advisorA.token });
  assert.equal(res.status, 400);
});

test('repair order details include customer, vehicle and empty line collections', async () => {
  const { ro, customer } = await makeRO();
  const res = await api.get(`/api/repair-orders/${ro.id}`, { token: advisorA.token });

  assert.equal(res.status, 200);
  assert.equal(res.body.customer_name, customer.full_name);
  assert.equal(res.body.make, 'Honda');
  assert.deepEqual(res.body.parts, []);
  assert.deepEqual(res.body.labor, []);
  assert.deepEqual(res.body.timeEntries, []);
});

test('a repair order from another workspace is not readable', async () => {
  const { ro } = await makeRO();
  const res = await api.get(`/api/repair-orders/${ro.id}`, { token: managerB.token });
  assert.equal(res.status, 404, 'RO leaked across workspaces');
});

test('repair order fields can be updated, and unknown fields are ignored', async () => {
  const { ro } = await makeRO();
  const res = await api.patch(`/api/repair-orders/${ro.id}`,
    { concern: 'Updated concern', priority: 'high', bogusField: 'ignored' },
    { token: advisorA.token });

  assert.equal(res.status, 200);
  assert.equal(res.body.concern, 'Updated concern');
  assert.equal(res.body.priority, 'high');
});

test('an invalid priority is rejected', async () => {
  const { ro } = await makeRO();
  const res = await api.patch(`/api/repair-orders/${ro.id}`, { priority: 'catastrophic' }, { token: advisorA.token });
  assert.equal(res.status, 400);
});

test('a repair order in another workspace cannot be updated', async () => {
  const { ro } = await makeRO();
  const res = await api.patch(`/api/repair-orders/${ro.id}`, { concern: 'hijack' }, { token: managerB.token });
  assert.equal(res.status, 404);
});

/* ── Status transitions ── */

test('a valid status transition is applied', async () => {
  const { ro } = await makeRO();
  const res = await api.patch(`/api/repair-orders/${ro.id}/status`, { status: 'in_progress' }, { token: techA.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'in_progress');
});

test('an invalid status transition is refused', async () => {
  const { ro } = await makeRO();
  // open -> completed skips the workflow.
  const res = await api.patch(`/api/repair-orders/${ro.id}/status`, { status: 'completed' }, { token: advisorA.token });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Cannot change status from open to completed/);
});

test('an unknown status value is rejected', async () => {
  const { ro } = await makeRO();
  const res = await api.patch(`/api/repair-orders/${ro.id}/status`, { status: 'teleported' }, { token: advisorA.token });
  assert.equal(res.status, 400);
});

test('completing a repair order stamps actual_completion and is terminal', async () => {
  const { ro } = await makeRO();
  await api.patch(`/api/repair-orders/${ro.id}/status`, { status: 'in_progress' }, { token: advisorA.token });
  const done = await api.patch(`/api/repair-orders/${ro.id}/status`, { status: 'completed' }, { token: advisorA.token });

  assert.equal(done.status, 200);
  assert.ok(done.body.actual_completion, 'actual_completion should be set on completion');

  const reopen = await api.patch(`/api/repair-orders/${ro.id}/status`, { status: 'open' }, { token: advisorA.token });
  assert.equal(reopen.status, 409, 'completed must be terminal');
});

/* ── Parts, labor and totals ── */

test('an ad-hoc part line is added and totals recalculate', async () => {
  const { ro } = await makeRO();
  const res = await api.post(`/api/repair-orders/${ro.id}/parts`,
    { partNumber: 'BP-100', partName: 'Brake pads', quantity: 2, unitPrice: 49.5, unitCost: 20 },
    { token: advisorA.token });

  assert.equal(res.status, 201);
  assert.equal(Number(res.body.line_total), 99);
  assert.equal(Number(res.body.totals.parts_total), 99);
  assert.equal(Number(res.body.totals.total_final), 99);
});

test('a catalog part draws down stock and inherits its price', async () => {
  const { ro } = await makeRO();
  const part = await api.post('/api/parts',
    { partNumber: 'OIL-5W30', name: 'Oil 5W30', retailPrice: 12.25, costPrice: 6, quantityOnHand: 10 },
    { token: managerA.token });
  assert.equal(part.status, 201);

  const res = await api.post(`/api/repair-orders/${ro.id}/parts`,
    { partId: part.body.id, quantity: 4 },
    { token: techA.token });

  assert.equal(res.status, 201);
  assert.equal(Number(res.body.unit_price), 12.25, 'price should come from the catalog');
  assert.equal(Number(res.body.line_total), 49);
  assert.equal(res.body.part_quantity_on_hand, 6, 'stock should be drawn down');
});

test('a part from another workspace cannot be added to a repair order', async () => {
  const { ro } = await makeRO();
  const foreignPart = await api.post('/api/parts',
    { partNumber: 'B-ONLY', name: 'Shop B part', retailPrice: 5 },
    { token: managerB.token });
  assert.equal(foreignPart.status, 201);

  const res = await api.post(`/api/repair-orders/${ro.id}/parts`,
    { partId: foreignPart.body.id, quantity: 1 },
    { token: advisorA.token });

  assert.equal(res.status, 404, 'cross-workspace part leaked into a repair order');
});

test('a labor line is added and totals combine parts and labor', async () => {
  const { ro } = await makeRO();
  await api.post(`/api/repair-orders/${ro.id}/parts`,
    { partNumber: 'P-1', partName: 'Part', quantity: 1, unitPrice: 100 },
    { token: advisorA.token });

  const res = await api.post(`/api/repair-orders/${ro.id}/labor`,
    { technicianId: techA.user.id, description: 'Replace pads', hours: 2, hourlyRate: 75 },
    { token: advisorA.token });

  assert.equal(res.status, 201);
  assert.equal(Number(res.body.line_total), 150);
  assert.equal(res.body.technician_name, 'Tech A');
  assert.equal(Number(res.body.totals.labor_total), 150);
  assert.equal(Number(res.body.totals.total_final), 250, 'total should be parts + labor');
});

test('labor requires description, hours and rate', async () => {
  const { ro } = await makeRO();
  assert.equal((await api.post(`/api/repair-orders/${ro.id}/labor`, { hours: 1, hourlyRate: 10 }, { token: advisorA.token })).status, 400);
  assert.equal((await api.post(`/api/repair-orders/${ro.id}/labor`, { description: 'x', hourlyRate: 10 }, { token: advisorA.token })).status, 400);
});

test('labor rejects a non-numeric or negative value', async () => {
  const { ro } = await makeRO();
  const res = await api.post(`/api/repair-orders/${ro.id}/labor`,
    { description: 'Bad', hours: 'two', hourlyRate: 75 }, { token: advisorA.token });
  assert.equal(res.status, 400);

  const neg = await api.post(`/api/repair-orders/${ro.id}/labor`,
    { description: 'Bad', hours: -3, hourlyRate: 75 }, { token: advisorA.token });
  assert.equal(neg.status, 400);
});

test('labor rejects a technician from another workspace', async () => {
  const { ro } = await makeRO();
  const res = await api.post(`/api/repair-orders/${ro.id}/labor`,
    { technicianId: managerB.user.id, description: 'Foreign tech', hours: 1, hourlyRate: 50 },
    { token: advisorA.token });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /not a member/);
});

test('a part cannot be added to a repair order in another workspace', async () => {
  const { ro } = await makeRO();
  const res = await api.post(`/api/repair-orders/${ro.id}/parts`,
    { partNumber: 'X', partName: 'X', quantity: 1, unitPrice: 1 },
    { token: managerB.token });
  assert.equal(res.status, 404);
});

/* ── Time tracking ── */

test('a technician clocks in and out, and duration is recorded', async () => {
  const { ro } = await makeRO();

  const inRes = await api.post(`/api/repair-orders/${ro.id}/time/clock-in`, {}, { token: techA.token });
  assert.equal(inRes.status, 201);
  assert.ok(inRes.body.start_time);
  assert.equal(inRes.body.end_time, null);

  const open = await api.get('/api/time/open', { token: techA.token });
  assert.equal(open.status, 200);
  assert.equal(open.body.ro_number, ro.ro_number);

  const outRes = await api.post(`/api/repair-orders/${ro.id}/time/clock-out`, {}, { token: techA.token });
  assert.equal(outRes.status, 200);
  assert.ok(outRes.body.end_time);
  assert.ok(Number(outRes.body.duration_minutes) >= 0);

  const afterOpen = await api.get('/api/time/open', { token: techA.token });
  assert.equal(afterOpen.body, null, 'no open entry should remain after clocking out');
});

test('a technician cannot clock in twice', async () => {
  const { ro } = await makeRO();
  assert.equal((await api.post(`/api/repair-orders/${ro.id}/time/clock-in`, {}, { token: techA.token })).status, 201);

  const second = await api.post(`/api/repair-orders/${ro.id}/time/clock-in`, {}, { token: techA.token });
  assert.equal(second.status, 409);

  await api.post(`/api/repair-orders/${ro.id}/time/clock-out`, {}, { token: techA.token });
});

test('clocking out without clocking in is refused', async () => {
  const { ro } = await makeRO();
  const res = await api.post(`/api/repair-orders/${ro.id}/time/clock-out`, {}, { token: techA.token });
  assert.equal(res.status, 409);
});

test('clock-in is refused for a repair order in another workspace', async () => {
  const { ro } = await makeRO();
  const res = await api.post(`/api/repair-orders/${ro.id}/time/clock-in`, {}, { token: managerB.token });
  assert.equal(res.status, 404);
});

/* ── Parts catalog ── */

test('parts are listed and searched within a workspace only', async () => {
  await api.post('/api/parts', { partNumber: 'FLT-9', name: 'Air filter', retailPrice: 20 }, { token: managerA.token });
  await api.post('/api/parts', { partNumber: 'ZZZ-9', name: 'Shop B only widget', retailPrice: 20 }, { token: managerB.token });

  const all = await api.get('/api/parts', { token: managerA.token });
  assert.equal(all.status, 200);
  assert.ok(all.body.some((p) => p.part_number === 'FLT-9'));
  assert.ok(!all.body.some((p) => p.part_number === 'ZZZ-9'), 'Shop B part leaked');

  const search = await api.get('/api/parts?search=filter', { token: managerA.token });
  assert.equal(search.status, 200);
  assert.ok(search.body.some((p) => p.part_number === 'FLT-9'));
});

test('a duplicate part number in the same workspace is rejected', async () => {
  const body = { partNumber: 'DUP-1', name: 'Dup part', retailPrice: 1 };
  assert.equal((await api.post('/api/parts', body, { token: managerA.token })).status, 201);
  assert.equal((await api.post('/api/parts', body, { token: managerA.token })).status, 409);
});

test('the same part number is allowed in a different workspace', async () => {
  const body = { partNumber: 'SHARED-1', name: 'Shared', retailPrice: 1 };
  assert.equal((await api.post('/api/parts', body, { token: managerA.token })).status, 201);
  assert.equal((await api.post('/api/parts', body, { token: managerB.token })).status, 201);
});

test('inventory adjustment cannot drive stock below zero', async () => {
  const part = await api.post('/api/parts',
    { partNumber: 'ADJ-1', name: 'Adjustable', retailPrice: 1, quantityOnHand: 3 },
    { token: managerA.token });

  const ok = await api.post(`/api/parts/${part.body.id}/adjust-inventory`,
    { adjustment: 5, reason: 'restock' }, { token: managerA.token });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.quantity_on_hand, 8);

  const bad = await api.post(`/api/parts/${part.body.id}/adjust-inventory`,
    { adjustment: -100, reason: 'oops' }, { token: managerA.token });
  assert.equal(bad.status, 400);
});

test('a part update ignores unknown keys rather than injecting them into SQL', async () => {
  const part = await api.post('/api/parts',
    { partNumber: 'INJ-1', name: 'Injection target', retailPrice: 5 },
    { token: managerA.token });

  const res = await api.patch(`/api/parts/${part.body.id}`,
    { name: 'Renamed', 'quantity_on_hand = 999, name': 'pwned' },
    { token: managerA.token });

  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Renamed');
  assert.equal(res.body.quantity_on_hand, 0, 'injected assignment must not take effect');
});

/* ── User management authority ── */

test('a manager cannot promote a user to super_admin', async () => {
  const victim = await seedUser(ctx.pool, api, { email: 'victim@a.test', role: 'technician', workspaceIds: [shopA.id] });
  const res = await api.patch(`/api/users/${victim.user.id}/role`, { role: 'super_admin' }, { token: managerA.token });

  assert.equal(res.status, 403);
  assert.match(res.body.error, /super admin/i);
});

test('a manager cannot change a role in another workspace', async () => {
  const res = await api.patch(`/api/users/${managerB.user.id}/role`, { role: 'technician' }, { token: managerA.token });
  assert.ok([403, 404].includes(res.status), `expected 403/404, got ${res.status}`);
});

test('a user cannot change their own role', async () => {
  const res = await api.patch(`/api/users/${managerA.user.id}/role`, { role: 'technician' }, { token: managerA.token });
  assert.equal(res.status, 403);
});

test('a manager cannot reset a super_admin password', async () => {
  const res = await api.post(`/api/users/${adminA.user.id}/reset-password`, {}, { token: managerA.token });
  assert.equal(res.status, 403);
});

test('a manager can change a role within their workspace, ending that session', async () => {
  const target = await seedUser(ctx.pool, api, { email: 'promote@a.test', role: 'technician', workspaceIds: [shopA.id] });
  assert.equal((await api.get('/api/customers', { token: target.token })).status, 200);

  const res = await api.patch(`/api/users/${target.user.id}/role`, { role: 'service_advisor' }, { token: managerA.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.role, 'service_advisor');

  assert.equal((await api.get('/api/customers', { token: target.token })).status, 401,
    'a role change should invalidate the existing session');
});

test('inviting a user creates them with a temporary password', async () => {
  const res = await api.post('/api/users/invite',
    { email: 'invited@a.test', name: 'Invited User', role: 'technician' },
    { token: managerA.token });

  assert.equal(res.status, 201);
  assert.equal(res.body.isNew, true);
  assert.ok(res.body.tempPassword);
  assert.deepEqual(res.body.user.workspace_ids, [shopA.id]);
});

test('a manager cannot invite a super_admin', async () => {
  const res = await api.post('/api/users/invite',
    { email: 'sneaky@a.test', name: 'Sneaky', role: 'super_admin' },
    { token: managerA.token });
  assert.equal(res.status, 403);
});

test('inviting an existing workspace member is a conflict', async () => {
  const res = await api.post('/api/users/invite',
    { email: 'tech@a.test', name: 'Tech A', role: 'technician' },
    { token: managerA.token });
  assert.equal(res.status, 409);
});

/* ── Customer portal ── */

async function portalCustomer({ email, password = 'PortalPass1!', workspace = shopA }) {
  const customer = await seedCustomer(ctx.pool, workspace.id, { fullName: 'Portal User', email });
  await enablePortal(ctx.pool, customer.id, password);
  const login = await api.post('/api/customer/login', { email, password, workspaceId: workspace.id });
  assert.equal(login.status, 200, `portal login failed: ${JSON.stringify(login.body)}`);
  return { customer, token: login.body.sessionToken };
}

test('portal login succeeds and issues a session', async () => {
  const { token } = await portalCustomer({ email: 'portal1@a.test' });
  assert.ok(token);
});

test('portal login fails for a customer without portal access enabled', async () => {
  const customer = await seedCustomer(ctx.pool, shopA.id, { fullName: 'No Portal', email: 'noportal@a.test' });
  assert.ok(customer.id);

  const res = await api.post('/api/customer/login',
    { email: 'noportal@a.test', password: 'anything', workspaceId: shopA.id });

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Invalid email or password.',
    'must not reveal that the account exists but has no portal access');
});

test('portal login is scoped to the workspace', async () => {
  await portalCustomer({ email: 'scoped@a.test' });
  const res = await api.post('/api/customer/login',
    { email: 'scoped@a.test', password: 'PortalPass1!', workspaceId: shopB.id });
  assert.equal(res.status, 401);
});

test('portal routes reject a missing or invalid session', async () => {
  assert.equal((await api.get('/api/customer/profile')).status, 401);
  assert.equal((await api.get('/api/customer/profile', { token: 'bogus' })).status, 401);
});

test('a staff token is not valid for the portal', async () => {
  const res = await api.get('/api/customer/profile', { token: managerA.token });
  assert.equal(res.status, 401, 'staff session must not authenticate the customer portal');
});

test('portal profile returns only the signed-in customer and their roll-ups', async () => {
  const { customer, token } = await portalCustomer({ email: 'profile@a.test' });
  const res = await api.get('/api/customer/profile', { token });

  assert.equal(res.status, 200);
  assert.equal(res.body.id, customer.id);
  assert.equal(res.body.workspace_name, 'Shop A');
  assert.equal(res.body.portal_password_hash, undefined, 'password hash must never be returned');
});

test('portal profile can be updated', async () => {
  const { token } = await portalCustomer({ email: 'profileedit@a.test' });
  const res = await api.patch('/api/customer/profile',
    { full_name: 'Edited Name', city: 'Bethesda', zip_code: '20814' },
    { token });

  assert.equal(res.status, 200);
  assert.equal(res.body.full_name, 'Edited Name');
  assert.equal(res.body.city, 'Bethesda');
});

test('portal vehicles and history only show the signed-in customer records', async () => {
  const { customer, token } = await portalCustomer({ email: 'iso@a.test' });
  const mine = await seedVehicle(ctx.pool, shopA.id, customer.id, { make: 'Mazda', model: 'CX5' });

  const other = await seedCustomer(ctx.pool, shopA.id, { fullName: 'Someone Else' });
  await seedVehicle(ctx.pool, shopA.id, other.id, { make: 'Secret', model: 'Car' });

  const vehicles = await api.get('/api/customer/vehicles', { token });
  assert.equal(vehicles.status, 200);
  assert.equal(vehicles.body.length, 1);
  assert.equal(vehicles.body[0].id, mine.id);
  assert.ok(!vehicles.body.some((v) => v.make === 'Secret'), "another customer's vehicle leaked");

  const history = await api.get('/api/customer/service-history', { token });
  assert.equal(history.status, 200);
  assert.deepEqual(history.body, []);
});

test('service history returns the customer repair orders with lines', async () => {
  const { customer, token } = await portalCustomer({ email: 'history@a.test' });
  const vehicle = await seedVehicle(ctx.pool, shopA.id, customer.id);

  const ro = await api.post('/api/repair-orders',
    { customerId: customer.id, vehicleId: vehicle.id, concern: 'Oil change' },
    { token: advisorA.token });
  assert.equal(ro.status, 201);

  await api.post(`/api/repair-orders/${ro.body.id}/labor`,
    { technicianId: techA.user.id, description: 'Drain and fill', hours: 1, hourlyRate: 90 },
    { token: advisorA.token });

  const res = await api.get('/api/customer/service-history', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].ro_number, ro.body.ro_number);
  assert.equal(res.body[0].labor_lines.length, 1);
  assert.equal(Number(res.body[0].total_final), 90);
});

/* ── Appointments ── */

function futureDate(days = 7) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

test('an appointment is scheduled against the customer own vehicle', async () => {
  const { customer, token } = await portalCustomer({ email: 'appt@a.test' });
  const vehicle = await seedVehicle(ctx.pool, shopA.id, customer.id);

  const res = await api.post('/api/customer/appointments',
    { vehicleId: vehicle.id, preferredDate: futureDate(), preferredTime: '09:30', concern: 'Noise when braking' },
    { token });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.workspace_id, shopA.id, 'appointment must carry the tenant id');
});

test('a DATE column is returned as a plain calendar date, not a UTC instant', async () => {
  const { customer, token } = await portalCustomer({ email: 'apptdate@a.test' });
  const vehicle = await seedVehicle(ctx.pool, shopA.id, customer.id);
  const date = futureDate(9);

  const created = await api.post('/api/customer/appointments',
    { vehicleId: vehicle.id, preferredDate: date, preferredTime: '08:15', concern: 'Date fidelity' },
    { token });

  assert.equal(created.status, 201);
  /* Serialised through a JS Date this comes back as "...T04:00:00.000Z" and
     renders a day early for any client west of the server. */
  assert.equal(created.body.preferred_date, date,
    'preferred_date must round-trip as YYYY-MM-DD');

  const list = await api.get('/api/customer/appointments', { token });
  assert.equal(list.body[0].preferred_date, date);

  const staff = await api.get('/api/appointments', { token: advisorA.token });
  const row = staff.body.find((a) => a.id === created.body.id);
  assert.equal(row.preferred_date, date, 'staff view must agree on the calendar date');
});

test('an appointment cannot be booked against another customer vehicle', async () => {
  const { token } = await portalCustomer({ email: 'appt2@a.test' });
  const other = await seedCustomer(ctx.pool, shopA.id);
  const otherVehicle = await seedVehicle(ctx.pool, shopA.id, other.id);

  const res = await api.post('/api/customer/appointments',
    { vehicleId: otherVehicle.id, preferredDate: futureDate(), concern: 'Not mine' },
    { token });

  assert.equal(res.status, 404);
});

test('an appointment in the past is rejected', async () => {
  const { customer, token } = await portalCustomer({ email: 'appt3@a.test' });
  const vehicle = await seedVehicle(ctx.pool, shopA.id, customer.id);

  const res = await api.post('/api/customer/appointments',
    { vehicleId: vehicle.id, preferredDate: '2020-01-01', concern: 'Time travel' },
    { token });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /past/);
});

test('a malformed appointment date is rejected', async () => {
  const { customer, token } = await portalCustomer({ email: 'appt4@a.test' });
  const vehicle = await seedVehicle(ctx.pool, shopA.id, customer.id);

  const res = await api.post('/api/customer/appointments',
    { vehicleId: vehicle.id, preferredDate: 'next tuesday', concern: 'Vague' },
    { token });
  assert.equal(res.status, 400);
});

test('a repeated identical booking does not create a duplicate', async () => {
  const { customer, token } = await portalCustomer({ email: 'appt5@a.test' });
  const vehicle = await seedVehicle(ctx.pool, shopA.id, customer.id);
  const body = { vehicleId: vehicle.id, preferredDate: futureDate(3), concern: 'Same request' };

  const first = await api.post('/api/customer/appointments', body, { token });
  const second = await api.post('/api/customer/appointments', body, { token });

  assert.equal(first.status, 201);
  assert.equal(second.body.id, first.body.id, 'a double submit should not create a second appointment');

  const list = await api.get('/api/customer/appointments', { token });
  assert.equal(list.body.length, 1);
});

test('an appointment can be cancelled by its owner and not by anyone else', async () => {
  const { customer, token } = await portalCustomer({ email: 'appt6@a.test' });
  const vehicle = await seedVehicle(ctx.pool, shopA.id, customer.id);

  const appt = await api.post('/api/customer/appointments',
    { vehicleId: vehicle.id, preferredDate: futureDate(), concern: 'To cancel' }, { token });

  const stranger = await portalCustomer({ email: 'appt7@a.test' });
  const theirs = await api.del(`/api/customer/appointments/${appt.body.id}`, { token: stranger.token });
  assert.equal(theirs.status, 404, "another customer must not cancel someone else's appointment");

  const res = await api.del(`/api/customer/appointments/${appt.body.id}`, { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'cancelled');
});

test('staff see workspace appointments and can confirm them', async () => {
  const { customer, token } = await portalCustomer({ email: 'appt8@a.test' });
  const vehicle = await seedVehicle(ctx.pool, shopA.id, customer.id);
  const appt = await api.post('/api/customer/appointments',
    { vehicleId: vehicle.id, preferredDate: futureDate(5), concern: 'Staff view' }, { token });

  const list = await api.get('/api/appointments', { token: advisorA.token });
  assert.equal(list.status, 200);
  assert.ok(list.body.some((a) => a.id === appt.body.id));

  const leak = await api.get('/api/appointments', { token: managerB.token });
  assert.ok(!leak.body.some((a) => a.id === appt.body.id), 'appointment leaked to another workspace');

  const confirm = await api.patch(`/api/appointments/${appt.body.id}`, { status: 'confirmed' }, { token: advisorA.token });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.status, 'confirmed');
  assert.ok(confirm.body.confirmed_date);
});

/* ── Feedback ── */

test('feedback is only accepted on a completed repair order, once', async () => {
  const { customer, token } = await portalCustomer({ email: 'feedback@a.test' });
  const vehicle = await seedVehicle(ctx.pool, shopA.id, customer.id);

  const ro = await api.post('/api/repair-orders',
    { customerId: customer.id, vehicleId: vehicle.id, concern: 'Feedback flow' },
    { token: advisorA.token });

  const tooEarly = await api.post('/api/customer/feedback',
    { repairOrderId: ro.body.id, rating: 5, comments: 'Great' }, { token });
  assert.equal(tooEarly.status, 409);

  await api.patch(`/api/repair-orders/${ro.body.id}/status`, { status: 'in_progress' }, { token: advisorA.token });
  await api.patch(`/api/repair-orders/${ro.body.id}/status`, { status: 'completed' }, { token: advisorA.token });

  const ok = await api.post('/api/customer/feedback',
    { repairOrderId: ro.body.id, rating: 5, comments: 'Great work' }, { token });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.rating, 5);
  assert.equal(ok.body.workspace_id, shopA.id);

  const again = await api.post('/api/customer/feedback',
    { repairOrderId: ro.body.id, rating: 1 }, { token });
  assert.equal(again.status, 409, 'duplicate feedback should be rejected');
});

test('staff see the feedback a customer left on the repair order', async () => {
  const { customer, token } = await portalCustomer({ email: 'feedbackstaff@a.test' });
  const vehicle = await seedVehicle(ctx.pool, shopA.id, customer.id);

  const ro = await api.post('/api/repair-orders',
    { customerId: customer.id, vehicleId: vehicle.id, concern: 'Staff sees rating' },
    { token: advisorA.token });
  await api.patch(`/api/repair-orders/${ro.body.id}/status`, { status: 'in_progress' }, { token: advisorA.token });
  await api.patch(`/api/repair-orders/${ro.body.id}/status`, { status: 'completed' }, { token: advisorA.token });

  await api.post('/api/customer/feedback',
    { repairOrderId: ro.body.id, rating: 4, comments: 'Prompt and tidy' }, { token });

  /* The RO detail used to read repair_order_feedback, which nothing writes,
     so a rating left in the portal was invisible to the shop. */
  const detail = await api.get(`/api/repair-orders/${ro.body.id}`, { token: advisorA.token });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.feedback.length, 1);
  assert.equal(detail.body.feedback[0].rating, 4);
  assert.equal(detail.body.feedback[0].comments, 'Prompt and tidy');
});

test('feedback rejects an out-of-range rating', async () => {
  const { token } = await portalCustomer({ email: 'feedback2@a.test' });
  const res = await api.post('/api/customer/feedback', { repairOrderId: 1, rating: 9 }, { token });
  assert.equal(res.status, 400);
});

test("feedback cannot be left on another customer's repair order", async () => {
  const { token } = await portalCustomer({ email: 'feedback3@a.test' });
  const { ro } = await makeRO();
  const res = await api.post('/api/customer/feedback', { repairOrderId: ro.id, rating: 5 }, { token });
  assert.equal(res.status, 404);
});

/* ── Portal password management ── */

test('a customer can change their password, which ends existing sessions', async () => {
  const { token } = await portalCustomer({ email: 'pw@a.test' });

  const res = await api.patch('/api/customer/change-password',
    { currentPassword: 'PortalPass1!', newPassword: 'BrandNewPass9!' }, { token });
  assert.equal(res.status, 200);

  assert.equal((await api.get('/api/customer/profile', { token })).status, 401,
    'changing the password should invalidate old sessions');

  const relogin = await api.post('/api/customer/login',
    { email: 'pw@a.test', password: 'BrandNewPass9!', workspaceId: shopA.id });
  assert.equal(relogin.status, 200);
});

test('changing a password requires the correct current one and a strong new one', async () => {
  const { token } = await portalCustomer({ email: 'pw2@a.test' });

  const wrong = await api.patch('/api/customer/change-password',
    { currentPassword: 'nope', newPassword: 'BrandNewPass9!' }, { token });
  assert.equal(wrong.status, 400);

  const weak = await api.patch('/api/customer/change-password',
    { currentPassword: 'PortalPass1!', newPassword: 'short' }, { token });
  assert.equal(weak.status, 400);
});

test('a manager cannot enable portal access for another workspace customer', async () => {
  const foreign = await seedCustomer(ctx.pool, shopB.id, { fullName: 'B Portal', email: 'bportal@b.test' });
  const res = await api.post(`/api/admin/customers/${foreign.id}/enable-portal`, {}, { token: managerA.token });
  assert.equal(res.status, 404, 'cross-tenant portal provisioning must be refused');
});

test('a manager can enable portal access in their own workspace', async () => {
  const customer = await seedCustomer(ctx.pool, shopA.id, { fullName: 'Enable Me', email: 'enable@a.test' });
  const res = await api.post(`/api/admin/customers/${customer.id}/enable-portal`, {}, { token: managerA.token });

  assert.equal(res.status, 200);
  assert.ok(res.body.tempPassword);
  assert.equal(res.body.customer.portal_enabled, true);

  const login = await api.post('/api/customer/login',
    { email: 'enable@a.test', password: res.body.tempPassword, workspaceId: shopA.id });
  assert.equal(login.status, 200, 'the issued temporary password should work');
});

/* ── Customer history (staff) ── */

test('customer history returns the customer, vehicles, repair orders and summary', async () => {
  const customer = await seedCustomer(ctx.pool, shopA.id, { fullName: 'History Customer' });
  const vehicle = await seedVehicle(ctx.pool, shopA.id, customer.id);

  const ro = await api.post('/api/repair-orders',
    { customerId: customer.id, vehicleId: vehicle.id, concern: 'History check' },
    { token: advisorA.token });
  await api.post(`/api/repair-orders/${ro.body.id}/parts`,
    { partNumber: 'H-1', partName: 'Hose', quantity: 1, unitPrice: 30 },
    { token: advisorA.token });

  const res = await api.get(`/api/customers/${customer.id}/history`, { token: advisorA.token });

  assert.equal(res.status, 200);
  assert.equal(res.body.customer.full_name, 'History Customer');
  assert.equal(res.body.vehicles.length, 1);
  assert.equal(res.body.repairOrders.length, 1);
  assert.equal(res.body.repairOrders[0].parts.length, 1);
  assert.equal(Number(res.body.summary.total_spent), 30);
});

test('customer history is refused across workspaces', async () => {
  const foreign = await seedCustomer(ctx.pool, shopB.id);
  const res = await api.get(`/api/customers/${foreign.id}/history`, { token: managerA.token });
  assert.equal(res.status, 404);
});

/* ── Reporting ── */

test('financial summary does not multiply revenue when an RO has many lines', async () => {
  const ws = await seedWorkspace(ctx.pool, 'Reporting Shop');
  const mgr = await seedUser(ctx.pool, api, { email: 'rep@r.test', role: 'manager', workspaceIds: [ws.id] });
  const customer = await seedCustomer(ctx.pool, ws.id, { fullName: 'Report Customer' });
  const vehicle = await seedVehicle(ctx.pool, ws.id, customer.id);

  const ro = await api.post('/api/repair-orders',
    { customerId: customer.id, vehicleId: vehicle.id, concern: 'Multi line' },
    { token: mgr.token });

  // 2 parts lines and 2 labor lines: a naive join would report 4x the revenue.
  await api.post(`/api/repair-orders/${ro.body.id}/parts`, { partNumber: 'A', partName: 'A', quantity: 1, unitPrice: 100 }, { token: mgr.token });
  await api.post(`/api/repair-orders/${ro.body.id}/parts`, { partNumber: 'B', partName: 'B', quantity: 1, unitPrice: 50 }, { token: mgr.token });
  await api.post(`/api/repair-orders/${ro.body.id}/labor`, { description: 'L1', hours: 1, hourlyRate: 100 }, { token: mgr.token });
  await api.post(`/api/repair-orders/${ro.body.id}/labor`, { description: 'L2', hours: 1, hourlyRate: 100 }, { token: mgr.token });

  const res = await api.get('/api/reports/financial-summary', { token: mgr.token });
  assert.equal(res.status, 200);
  assert.equal(Number(res.body.total_repair_orders), 1);
  assert.equal(Number(res.body.parts_revenue), 150);
  assert.equal(Number(res.body.labor_revenue), 200);
  assert.equal(Number(res.body.total_revenue), 350, 'total_revenue must not be multiplied by the line count');
});

test('customer analytics does not multiply spend by vehicle count', async () => {
  const ws = await seedWorkspace(ctx.pool, 'Analytics Shop');
  const mgr = await seedUser(ctx.pool, api, { email: 'an@r.test', role: 'manager', workspaceIds: [ws.id] });
  const customer = await seedCustomer(ctx.pool, ws.id, { fullName: 'Multi Vehicle' });

  const v1 = await seedVehicle(ctx.pool, ws.id, customer.id, { vin: 'MV0000000000001' });
  await seedVehicle(ctx.pool, ws.id, customer.id, { vin: 'MV0000000000002' });
  await seedVehicle(ctx.pool, ws.id, customer.id, { vin: 'MV0000000000003' });

  const ro = await api.post('/api/repair-orders',
    { customerId: customer.id, vehicleId: v1.id, concern: 'One RO' }, { token: mgr.token });
  await api.post(`/api/repair-orders/${ro.body.id}/parts`,
    { partNumber: 'S', partName: 'S', quantity: 1, unitPrice: 200 }, { token: mgr.token });

  const res = await api.get('/api/reports/customer-analytics', { token: mgr.token });
  assert.equal(res.status, 200);

  const row = res.body.find((r) => r.full_name === 'Multi Vehicle');
  assert.equal(Number(row.vehicles_owned), 3);
  assert.equal(Number(row.total_repair_orders), 1);
  assert.equal(Number(row.total_spent), 200, 'total_spent must not be multiplied by vehicles_owned');
});

test('technician performance does not multiply hours or revenue across an RO with several lines', async () => {
  const ws = await seedWorkspace(ctx.pool, 'Tech Perf Shop');
  const mgr = await seedUser(ctx.pool, api, { email: 'tp-mgr@r.test', role: 'manager', workspaceIds: [ws.id] });
  const tech = await seedUser(ctx.pool, api, { email: 'tp-tech@r.test', role: 'technician', workspaceIds: [ws.id], name: 'Perf Tech' });
  const customer = await seedCustomer(ctx.pool, ws.id, { fullName: 'Perf Customer' });
  const vehicle = await seedVehicle(ctx.pool, ws.id, customer.id);

  const ro = await api.post('/api/repair-orders',
    { customerId: customer.id, vehicleId: vehicle.id, concern: 'Perf' }, { token: mgr.token });

  // Two labor lines by the same tech on one RO: 6 hours, $600 total.
  await api.post(`/api/repair-orders/${ro.body.id}/labor`,
    { technicianId: tech.user.id, description: 'L1', hours: 3, hourlyRate: 100 }, { token: mgr.token });
  await api.post(`/api/repair-orders/${ro.body.id}/labor`,
    { technicianId: tech.user.id, description: 'L2', hours: 3, hourlyRate: 100 }, { token: mgr.token });

  // Two time entries on the same RO. A direct join of both line tables would
  // multiply the two labor lines by the two time entries (4x), doubling hours
  // and revenue and doubling tracked minutes.
  await ctx.pool.query(
    `INSERT INTO time_entries (repair_order_id, technician_id, start_time, end_time, duration_minutes)
     SELECT $1, $2, NOW(), NOW(), 60 FROM generate_series(1,2)`,
    [ro.body.id, tech.user.id]
  );

  await api.patch(`/api/repair-orders/${ro.body.id}/status`, { status: 'in_progress' }, { token: mgr.token });
  await api.patch(`/api/repair-orders/${ro.body.id}/status`, { status: 'completed' }, { token: mgr.token });

  const res = await api.get('/api/reports/technician-performance', { token: mgr.token });
  assert.equal(res.status, 200);
  const row = res.body.find((r) => r.name === 'Perf Tech');
  assert.ok(row, 'the technician should appear in the report');
  assert.equal(Number(row.repair_orders_completed), 1);
  assert.equal(Number(row.total_hours), 6, 'hours must not be multiplied by the time-entry count');
  assert.equal(Number(row.labor_revenue), 600, 'labor revenue must not be multiplied by the time-entry count');
  assert.equal(Number(row.total_tracked_minutes), 120, 'tracked minutes must not be multiplied by the labor-line count');
});

test('shop KPIs and revenue trends respond for a manager', async () => {
  const kpis = await api.get('/api/reports/shop-kpis', { token: managerA.token });
  assert.equal(kpis.status, 200);
  assert.ok('total_repair_orders' in kpis.body);

  const trends = await api.get('/api/reports/revenue-trends?months=6', { token: managerA.token });
  assert.equal(trends.status, 200);
  assert.ok(Array.isArray(trends.body));
});

test('reports are scoped to the requested workspace', async () => {
  const res = await api.get(`/api/reports/shop-kpis?workspaceId=${shopB.id}`, { token: managerA.token });
  assert.equal(res.status, 403);
});

/* ── CSV import ── */

async function importCsv(kind, csvText, token, workspaceId) {
  const form = new FormData();
  form.append('file', new Blob([csvText], { type: 'text/csv' }), `${kind}.csv`);
  const res = await fetch(`${ctx.baseUrl}/api/import/${kind}?workspaceId=${workspaceId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

test('CSV customer import stores email canonically and does not create duplicates', async () => {
  const ws = await seedWorkspace(ctx.pool, 'Import Shop');
  const mgr = await seedUser(ctx.pool, api, { email: 'imp-mgr@r.test', role: 'manager', workspaceIds: [ws.id] });

  const first = await importCsv('customers', 'full_name,email\nAda Byron,Ada@Import.Test\n', mgr.token, ws.id);
  assert.equal(first.status, 200);
  assert.equal(first.body.success, 1);

  /* A hand entry of the same address in different case is caught as a duplicate. */
  const dup = await api.post('/api/customers', { fullName: 'Ada Again', email: 'ADA@import.test' }, { token: mgr.token });
  assert.equal(dup.status, 409);

  /* Re-importing the same address in yet another case is skipped, not doubled. */
  const second = await importCsv('customers', 'full_name,email\nAda Byron,ada@import.test\n', mgr.token, ws.id);
  assert.equal(second.body.duplicates, 1);
  assert.equal(second.body.success, 0);

  const { rows } = await ctx.pool.query('SELECT email FROM customers WHERE workspace_id = $1', [ws.id]);
  assert.equal(rows.length, 1, 'only one customer row should exist');
  assert.equal(rows[0].email, 'ada@import.test', 'email should be stored lower-cased');
});

test('CSV vehicle import upper-cases the VIN and links the customer by email', async () => {
  const ws = await seedWorkspace(ctx.pool, 'Import Vehicle Shop');
  const mgr = await seedUser(ctx.pool, api, { email: 'impv-mgr@r.test', role: 'manager', workspaceIds: [ws.id] });
  const customer = await seedCustomer(ctx.pool, ws.id, { fullName: 'Owner', email: 'owner@iv.test' });

  const imp = await importCsv('vehicles',
    'vin,make,model,customer_email\nabc123xyz789,Ford,Focus,Owner@IV.test\n', mgr.token, ws.id);
  assert.equal(imp.status, 200);
  assert.equal(imp.body.success, 1);

  const list = await api.get(`/api/vehicles?customerId=${customer.id}`, { token: mgr.token });
  assert.equal(list.body.length, 1, 'vehicle should link to the customer despite email casing');
  assert.equal(list.body[0].vin, 'ABC123XYZ789', 'VIN should be stored upper-cased');

  /* A hand entry of the same VIN in any case is now a duplicate. */
  const dup = await api.post('/api/vehicles',
    { customerId: customer.id, vin: 'abc123xyz789', make: 'Ford', model: 'Focus' }, { token: mgr.token });
  assert.equal(dup.status, 409);
});

/* ── Error handling ── */

test('internal errors do not leak driver or SQL detail', async () => {
  const res = await api.get('/api/customers/not-a-number', { token: managerA.token });
  assert.equal(res.status, 400);
  assert.ok(!/syntax|invalid input|pg|postgres/i.test(JSON.stringify(res.body)),
    `error body leaked internals: ${JSON.stringify(res.body)}`);
});

test('a missing repair order returns 404 rather than 500', async () => {
  const res = await api.get('/api/repair-orders/99999999', { token: managerA.token });
  assert.equal(res.status, 404);
});

test('an unknown /api path returns JSON, not an HTML error page', async () => {
  const res = await api.get('/api/does-not-exist', { token: managerA.token });
  assert.equal(res.status, 404);
  /* Express's default handler renders HTML; a client parsing every other
     response as JSON would choke on it. */
  assert.deepEqual(res.body, { error: 'Endpoint not found.' });
});

test('the root path sends visitors to sign in', async () => {
  const res = await fetch(`${ctx.baseUrl}/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login.html');
});

test('security headers are set on responses', async () => {
  const res = await fetch(`${ctx.baseUrl}/login.html`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('content-security-policy'), 'CSP header should be present');
  /* The pages wire buttons with onclick=""; a script-src-attr of 'none' would
     silently disable every one of them. */
  assert.ok(
    !/script-src-attr 'none'/.test(res.headers.get('content-security-policy')),
    'CSP must not block the inline event handlers the pages rely on'
  );
});
