#!/usr/bin/env node
/**
 * Repeatable demo dataset for a whole environment: two shops, users covering
 * every role, and a worked example of every feature the schema supports.
 *
 *   node scripts/seed-demo.js --env preprod --out ~/agshop-preprod.bw.json
 *   node scripts/seed-demo.js --env prod --confirm-prod --out ~/agshop-prod.bw.json
 *   node scripts/seed-demo.js --env preprod --cleanup
 *   node scripts/seed-demo.js --env preprod --dry-run
 *
 * SAFETY
 *
 * Everything this script creates is namespaced by environment:
 *
 *   workspaces  ws-demo-<env>-<slug>
 *   users       usr-demo-<env>-<role><n>      email <role><n>@<env>.demo.agshopro.test
 *
 * Cleanup deletes only rows reachable from those ids, so real accounts -- the
 * owner created by seed-owner.js, for instance -- are never touched. Because the
 * ids are deterministic rather than random, re-running is a clean replace instead
 * of an accumulating pile of duplicates.
 *
 * The whole run (cleanup + insert) is ONE transaction. A failure anywhere leaves
 * the database exactly as it was; there is no half-seeded state to unpick.
 * --dry-run performs the entire seed and then rolls back, which is also the
 * cheapest way to check the dataset still matches the schema after a migration.
 *
 * Email addresses use the reserved .test TLD, which cannot resolve, so no demo
 * row can ever cause mail to reach a real person.
 *
 * Passwords are generated per run and never stored in this file or in Git. They
 * are printed once and, with --out, written to a Bitwarden/Vaultwarden import
 * file at mode 0600. Losing them costs a re-run; there is no recovery path.
 *
 * Money and totals are computed the way the application computes them --
 * line_total from quantity x price, repair order totals via the
 * recalculate_ro_totals() function from migration 006, invoice subtotals from the
 * order's labour and parts lines as services/invoicing.js does -- so the seeded
 * rows are indistinguishable from rows the product itself would have written.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Client } = require('pg');

/* ── CLI ── */

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const ENV = arg('--env', '');
const CLEANUP_ONLY = has('--cleanup');
const DRY_RUN = has('--dry-run');
const OUT = arg('--out', '');

if (!['preprod', 'prod'].includes(ENV)) {
  console.error('Usage: seed-demo.js --env <preprod|prod> [--cleanup] [--dry-run] [--out file]');
  process.exit(64);
}
/* Production needs the extra keystroke. Everything here is fictional, but
   "seeding the demo set" and "writing to production" should never be one flag
   apart. */
if (ENV === 'prod' && !has('--confirm-prod') && !DRY_RUN) {
  console.error('[seed-demo] Refusing to write to production without --confirm-prod.');
  console.error('[seed-demo] Re-run with --dry-run first to see exactly what it would do.');
  process.exit(65);
}

const WS = (slug) => `ws-demo-${ENV}-${slug}`;
const USR = (key) => `usr-demo-${ENV}-${key}`;
const MAIL = (key) => `${key}@${ENV}.demo.agshopro.test`;

/* shop_signups is the one table whose rows are not reachable from a demo
   workspace or user: a *pending* request has no reviewer, no workspace and no
   provisioned account yet, so cleanup had nothing to match on and pending rows
   accumulated on every run. `source` carries the marker instead. */
const SIGNUP_SOURCE = `demo-${ENV}`;

/* ── Fictional data ── */

const SHOPS = [
  { slug: 'ridgeline', name: 'Ridgeline Auto Care', type: 'mechanic', plan: 'pro',
    address: '1420 Ridgeline Blvd, Asheville, NC 28801' },
  { slug: 'bayview', name: 'Bayview Collision', type: 'auto body', plan: 'starter',
    address: '88 Harbor Way, Bayview, CA 94066' },
];

/* Every role the application recognises (services/user-management.js VALID_ROLES).
   The super_admin is a platform account and belongs to both shops; the rest are
   scoped to one, which is what makes the isolation checks meaningful. */
const STAFF = [
  { key: 'admin',     role: 'super_admin',     name: 'Dana Whitfield',  shops: ['ridgeline', 'bayview'] },
  { key: 'manager1',  role: 'manager',         name: 'Marcus Ellery',   shops: ['ridgeline'] },
  { key: 'advisor1',  role: 'service_advisor', name: 'Priya Raman',     shops: ['ridgeline'] },
  { key: 'tech1',     role: 'technician',      name: 'Luis Ferreira',   shops: ['ridgeline'] },
  { key: 'tech2',     role: 'technician',      name: 'Grace Okonkwo',   shops: ['ridgeline'] },
  { key: 'manager2',  role: 'manager',         name: 'Helen Vasquez',   shops: ['bayview'] },
  { key: 'advisor2',  role: 'service_advisor', name: 'Tom Bridger',     shops: ['bayview'] },
  { key: 'tech3',     role: 'technician',      name: 'Sam Adeyemi',     shops: ['bayview'] },
];

const CUSTOMERS = {
  ridgeline: [
    { name: 'Ada Lindqvist',  email: 'ada.lindqvist@example.test',  phone: '828-555-0142', city: 'Asheville', state: 'NC', zip: '28801', address: '17 Chestnut St' },
    { name: 'Ravi Chandran',  email: 'ravi.chandran@example.test',  phone: '828-555-0198', city: 'Asheville', state: 'NC', zip: '28804', address: '2210 Merrimon Ave' },
    { name: 'Nora Bellweather', email: 'nora.b@example.test',       phone: '828-555-0233', city: 'Weaverville', state: 'NC', zip: '28787', address: '5 Pine Ridge Rd' },
    { name: 'Desmond Iheme',  email: 'd.iheme@example.test',        phone: '828-555-0271', city: 'Asheville', state: 'NC', zip: '28803', address: '904 Sweeten Creek' },
    { name: 'Marta Kowalczyk', email: 'marta.k@example.test',       phone: '828-555-0310', city: 'Black Mountain', state: 'NC', zip: '28711', address: '61 Cherry St' },
  ],
  bayview: [
    { name: 'Elena Moretti',   email: 'elena.moretti@example.test', phone: '650-555-0104', city: 'Bayview', state: 'CA', zip: '94066', address: '340 Marina Dr' },
    { name: 'Curtis Nakamura', email: 'c.nakamura@example.test',     phone: '650-555-0166', city: 'San Bruno', state: 'CA', zip: '94066', address: '12 Crestview Ln' },
    { name: 'Yusuf Demir',     email: 'yusuf.demir@example.test',    phone: '650-555-0221', city: 'Millbrae', state: 'CA', zip: '94030', address: '778 El Camino' },
    { name: 'Bridget Halloran', email: 'b.halloran@example.test',    phone: '650-555-0289', city: 'Bayview', state: 'CA', zip: '94066', address: '55 Seawall Ct' },
  ],
};

/* VINs are 17 chars and exclude I, O and Q, like the real standard, so the
   uniqueness index and any future validation both behave realistically. */
const VEHICLES = {
  ridgeline: [
    { c: 0, vin: '1HGCM82633A004352', year: 2019, make: 'Honda',    model: 'Accord',   plate: 'NC-8842A', mileage: 78421 },
    { c: 0, vin: '5FNYF6H91KB012774', year: 2021, make: 'Honda',    model: 'Pilot',    plate: 'NC-1190B', mileage: 41008 },
    { c: 1, vin: 'JTDKARFU7J3061882', year: 2018, make: 'Toyota',   model: 'Prius',    plate: 'NC-5521C', mileage: 112390 },
    { c: 2, vin: '1FTEW1EP7MFA33125', year: 2021, make: 'Ford',     model: 'F-150',    plate: 'NC-7734D', mileage: 58210 },
    { c: 3, vin: 'WBA8E9G59HNU21345', year: 2017, make: 'BMW',      model: '330i',     plate: 'NC-3308E', mileage: 96574 },
    { c: 4, vin: '3VW2K7AJ9FM214477', year: 2015, make: 'Volkswagen', model: 'Jetta',  plate: 'NC-6612F', mileage: 141002 },
  ],
  bayview: [
    { c: 0, vin: '2C3CDXBG5FH512088', year: 2015, make: 'Dodge',    model: 'Charger',  plate: 'CA-4KLM22', mileage: 132880 },
    { c: 1, vin: '5YJ3E1EA7KF317442', year: 2019, make: 'Tesla',    model: 'Model 3',  plate: 'CA-8XRT41', mileage: 46220 },
    { c: 2, vin: 'KM8J3CA46JU623119', year: 2018, make: 'Hyundai',  model: 'Tucson',   plate: 'CA-2BND77', mileage: 88450 },
    { c: 3, vin: '1N4BL4BV5KC188023', year: 2019, make: 'Nissan',   model: 'Altima',   plate: 'CA-9QWE03', mileage: 61377 },
  ],
};

/* One part in each shop sits below minimum_stock so the low-stock report has
   something to show. */
const PARTS = {
  ridgeline: [
    { pn: 'BRK-PAD-2019H', name: 'Ceramic brake pad set', cat: 'Brakes', mfr: 'Akebono', cost: 42.5, retail: 96.0, qty: 14, min: 4, loc: 'A1-03' },
    { pn: 'BRK-ROT-2019H', name: 'Front brake rotor', cat: 'Brakes', mfr: 'Brembo', cost: 61.0, retail: 138.0, qty: 6, min: 2, loc: 'A1-04' },
    { pn: 'OIL-5W30-SYN', name: 'Full synthetic 5W-30 (qt)', cat: 'Fluids', mfr: 'Mobil', cost: 6.25, retail: 12.99, qty: 96, min: 24, loc: 'B2-01' },
    { pn: 'FLT-OIL-H1', name: 'Oil filter', cat: 'Filters', mfr: 'Honda OEM', cost: 7.1, retail: 17.5, qty: 31, min: 10, loc: 'B2-06' },
    { pn: 'FLT-AIR-H1', name: 'Engine air filter', cat: 'Filters', mfr: 'Fram', cost: 11.4, retail: 26.0, qty: 18, min: 6, loc: 'B2-07' },
    { pn: 'BAT-H6-AGM', name: 'AGM battery H6', cat: 'Electrical', mfr: 'Interstate', cost: 128.0, retail: 249.0, qty: 3, min: 2, loc: 'C1-01' },
    { pn: 'SPK-IRID-4PK', name: 'Iridium spark plugs (4pk)', cat: 'Ignition', mfr: 'NGK', cost: 33.0, retail: 74.0, qty: 2, min: 6, loc: 'C2-04' },
    { pn: 'CAB-SERP-BLT', name: 'Serpentine belt', cat: 'Engine', mfr: 'Gates', cost: 24.75, retail: 58.0, qty: 9, min: 3, loc: 'C2-09' },
  ],
  bayview: [
    { pn: 'PNL-DR-FL-CHG', name: 'Front left door panel', cat: 'Body', mfr: 'Aftermarket', cost: 310.0, retail: 640.0, qty: 2, min: 1, loc: 'BAY-1' },
    { pn: 'PNT-BC-SILVER', name: 'Basecoat, silver metallic (qt)', cat: 'Paint', mfr: 'PPG', cost: 88.0, retail: 165.0, qty: 7, min: 3, loc: 'PNT-2' },
    { pn: 'PNT-CLR-2K', name: '2K clearcoat (qt)', cat: 'Paint', mfr: 'PPG', cost: 64.0, retail: 128.0, qty: 1, min: 4, loc: 'PNT-3' },
    { pn: 'BMP-CVR-ALT', name: 'Rear bumper cover', cat: 'Body', mfr: 'Aftermarket', cost: 245.0, retail: 495.0, qty: 3, min: 1, loc: 'BAY-2' },
    { pn: 'GLS-WS-TSL3', name: 'Windshield, Model 3', cat: 'Glass', mfr: 'Pilkington', cost: 420.0, retail: 810.0, qty: 2, min: 1, loc: 'GLS-1' },
  ],
};

function generatePassword(prefix = 'Ag') {
  return `${prefix}-${crypto.randomBytes(12).toString('base64url')}!`;
}

/* ── Cleanup ──
   Ordered children-first. 007 made repair_orders -> customers/vehicles ON DELETE
   RESTRICT and 009 did the same for invoices, so deleting a workspace and
   letting the cascades sort it out is not reliable; each level goes explicitly.
   time_entries has no workspace_id at all, so it is reached through its order or
   its technician. */
async function cleanup(client) {
  const wsIds = SHOPS.map((s) => WS(s.slug));
  const usrPrefix = `usr-demo-${ENV}-%`;
  const counts = {};
  const del = async (label, sql, params) => {
    const res = await client.query(sql, params);
    if (res.rowCount) counts[label] = res.rowCount;
  };

  await del('payments', 'DELETE FROM payments WHERE workspace_id = ANY($1)', [wsIds]);
  await del('invoices', 'DELETE FROM invoices WHERE workspace_id = ANY($1)', [wsIds]);
  await del('feedback', 'DELETE FROM feedback WHERE workspace_id = ANY($1)', [wsIds]);
  await del('appointments', 'DELETE FROM appointments WHERE workspace_id = ANY($1)', [wsIds]);
  await del('time_entries',
    `DELETE FROM time_entries
      WHERE technician_id LIKE $1
         OR repair_order_id IN (SELECT id FROM repair_orders WHERE workspace_id = ANY($2))`,
    [usrPrefix, wsIds]);
  await del('ro_parts_lines', 'DELETE FROM ro_parts_lines WHERE workspace_id = ANY($1)', [wsIds]);
  await del('ro_labor_lines', 'DELETE FROM ro_labor_lines WHERE workspace_id = ANY($1)', [wsIds]);
  await del('repair_orders', 'DELETE FROM repair_orders WHERE workspace_id = ANY($1)', [wsIds]);
  await del('parts', 'DELETE FROM parts WHERE workspace_id = ANY($1)', [wsIds]);
  await del('vehicles', 'DELETE FROM vehicles WHERE workspace_id = ANY($1)', [wsIds]);
  /* customer_sessions cascade from customers. */
  await del('customers', 'DELETE FROM customers WHERE workspace_id = ANY($1)', [wsIds]);
  await del('leads_inbox', 'DELETE FROM leads_inbox WHERE workspace_id = ANY($1)', [wsIds]);
  /* signup_audit_log cascades from shop_signups, but shop_signups.reviewed_by
     references users with no cascade, so signups must go before users. */
  await del('shop_signups',
    `DELETE FROM shop_signups
      WHERE source = $3 OR workspace_id = ANY($1) OR reviewed_by LIKE $2 OR user_id LIKE $2`,
    [wsIds, usrPrefix, SIGNUP_SOURCE]);
  /* sessions cascade from users. */
  await del('users', 'DELETE FROM users WHERE id LIKE $1', [usrPrefix]);
  await del('workspaces', 'DELETE FROM workspaces WHERE id = ANY($1)', [wsIds]);

  return counts;
}

/* ── Seed ── */

async function seed(client) {
  const created = { credentials: [], summary: {} };
  const now = Date.now();
  const day = 86400000;
  const at = (daysAgo, hour = 9) =>
    new Date(now - daysAgo * day).toISOString().slice(0, 10) + ` ${String(hour).padStart(2, '0')}:00:00+00`;
  const dateOnly = (daysFromNow) => new Date(now + daysFromNow * day).toISOString().slice(0, 10);

  /* Workspaces */
  for (const shop of SHOPS) {
    await client.query(
      `INSERT INTO workspaces (id, name, address, type, plan, active) VALUES ($1,$2,$3,$4,$5,true)`,
      [WS(shop.slug), shop.name, shop.address, shop.type, shop.plan]
    );
  }
  created.summary.workspaces = SHOPS.length;

  /* Staff, one password each, generated now and never persisted anywhere but the
     credential artifact. */
  const staffById = {};
  for (const person of STAFF) {
    const id = USR(person.key);
    const email = MAIL(person.key);
    const password = generatePassword();
    const hash = await bcrypt.hash(password, 12);
    const workspaceIds = person.shops.map((s) => WS(s));

    await client.query(
      `INSERT INTO users (id, name, email, phone, password_hash, role, workspace_ids, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)`,
      [id, person.name, email, null, hash, person.role, workspaceIds]
    );

    staffById[person.key] = { id, email, password, role: person.role, name: person.name, workspaceIds };
    created.credentials.push({
      kind: 'staff', env: ENV, role: person.role, name: person.name,
      username: email, password, userId: id, workspaceIds,
    });
  }
  created.summary.users = STAFF.length;

  const totals = { customers: 0, vehicles: 0, parts: 0, repair_orders: 0, labor_lines: 0,
    parts_lines: 0, time_entries: 0, appointments: 0, feedback: 0, invoices: 0,
    payments: 0, leads: 0, signups: 0, portal_customers: 0 };

  for (const shop of SHOPS) {
    const wsId = WS(shop.slug);
    const techs = STAFF.filter((s) => s.role === 'technician' && s.shops.includes(shop.slug))
      .map((s) => staffById[s.key]);
    const advisor = STAFF.filter((s) => s.role === 'service_advisor' && s.shops.includes(shop.slug))
      .map((s) => staffById[s.key])[0];
    const manager = STAFF.filter((s) => s.role === 'manager' && s.shops.includes(shop.slug))
      .map((s) => staffById[s.key])[0];

    /* Customers. Two per shop get portal access, with their own generated
       password -- customers authenticate separately from staff. */
    const customerIds = [];
    for (const [i, c] of CUSTOMERS[shop.slug].entries()) {
      const portal = i < 2;
      const portalPassword = portal ? generatePassword('Portal') : null;
      const { rows } = await client.query(
        `INSERT INTO customers (workspace_id, full_name, email, phone, address, city, state, zip_code,
                                portal_enabled, portal_password_hash, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [wsId, c.name, c.email.toLowerCase(), c.phone, c.address, c.city, c.state, c.zip,
          portal, portal ? await bcrypt.hash(portalPassword, 12) : null, at(120 - i * 10)]
      );
      customerIds.push(rows[0].id);
      totals.customers++;
      if (portal) {
        totals.portal_customers++;
        created.credentials.push({
          kind: 'customer-portal', env: ENV, role: 'customer', name: c.name,
          username: c.email.toLowerCase(), password: portalPassword,
          shop: shop.name, workspaceIds: [wsId],
        });
      }
    }

    /* Vehicles */
    const vehicleIds = [];
    for (const v of VEHICLES[shop.slug]) {
      const { rows } = await client.query(
        `INSERT INTO vehicles (workspace_id, customer_id, vin, year, make, model, plate, mileage, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [wsId, customerIds[v.c], v.vin, v.year, v.make, v.model, v.plate, v.mileage, at(110)]
      );
      vehicleIds.push({ id: rows[0].id, customerId: customerIds[v.c] });
      totals.vehicles++;
    }

    /* Parts catalogue */
    const partIds = [];
    for (const p of PARTS[shop.slug]) {
      const { rows } = await client.query(
        `INSERT INTO parts (workspace_id, part_number, name, category, manufacturer,
                            cost_price, retail_price, quantity_on_hand, minimum_stock, location, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true) RETURNING id`,
        [wsId, p.pn, p.name, p.cat, p.mfr, p.cost, p.retail, p.qty, p.min, p.loc]
      );
      partIds.push({ id: rows[0].id, ...p });
      totals.parts++;
    }

    /* Repair orders across the whole status domain (007's CHECK constraint) and
       every priority, so board views, filters and reports all have data. */
    const RO_PLAN = [
      { status: 'completed',      priority: 'normal', daysAgo: 45, concern: 'Grinding noise when braking', notes: 'Pads worn to backing plate; rotors scored past spec.', labor: [{ t: 0, d: 'Replace front pads and rotors', h: 2.5, r: 105 }], parts: [{ p: 0, q: 1 }, { p: 1, q: 2 }], invoice: 'paid' },
      { status: 'completed',      priority: 'low',    daysAgo: 30, concern: 'Routine oil and filter service', notes: 'Customer requested synthetic. Next service due at 84k.', labor: [{ t: 1, d: 'Full synthetic oil service', h: 0.7, r: 105 }], parts: [{ p: 2, q: 5 }, { p: 3, q: 1 }], invoice: 'partially_paid' },
      { status: 'ready',          priority: 'high',   daysAgo: 6,  concern: 'Battery dies overnight', notes: 'Parasitic draw traced to aftermarket dashcam wiring.', labor: [{ t: 0, d: 'Diagnose parasitic draw', h: 1.8, r: 115 }], parts: [{ p: 5, q: 1 }], invoice: 'issued' },
      { status: 'in_progress',    priority: 'urgent', daysAgo: 2,  concern: 'Overheating on the highway', notes: 'Waiting on coolant pressure test results.', labor: [{ t: 1, d: 'Cooling system pressure test', h: 1.2, r: 115 }], parts: [], invoice: null },
      { status: 'awaiting_parts', priority: 'normal', daysAgo: 4,  concern: 'Misfire under load', notes: 'Iridium plugs backordered; ETA Thursday.', labor: [], parts: [{ p: 6, q: 1 }], invoice: 'draft' },
      { status: 'open',           priority: 'normal', daysAgo: 1,  concern: 'Squeal from belt area on cold start', notes: null, labor: [], parts: [], invoice: null },
      { status: 'draft',          priority: 'low',    daysAgo: 0,  concern: 'Customer requested pre-trip inspection', notes: 'Quote only at this stage.', labor: [], parts: [], invoice: null },
      { status: 'cancelled',      priority: 'low',    daysAgo: 20, concern: 'Alignment check', notes: 'Customer took the vehicle elsewhere.', labor: [], parts: [], invoice: null },
    ];

    const roRecords = [];
    for (const [i, plan] of RO_PLAN.entries()) {
      const vehicle = vehicleIds[i % vehicleIds.length];
      const roNumber = `RO-${1001 + i}`;
      const { rows } = await client.query(
        `INSERT INTO repair_orders (workspace_id, ro_number, customer_id, vehicle_id, status, priority,
                                    concern, notes, created_at, updated_at,
                                    actual_completion, customer_approval_required, customer_approved_at, customer_approved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13) RETURNING id`,
        [wsId, roNumber, vehicle.customerId, vehicle.id, plan.status, plan.priority,
          plan.concern, plan.notes, at(plan.daysAgo),
          plan.status === 'completed' ? at(Math.max(plan.daysAgo - 1, 0), 16) : null,
          plan.priority === 'urgent',
          plan.priority === 'urgent' ? at(plan.daysAgo, 11) : null,
          plan.priority === 'urgent' ? (advisor ? advisor.id : null) : null]
      );
      const roId = rows[0].id;
      totals.repair_orders++;

      for (const l of plan.labor) {
        const tech = techs[l.t % techs.length];
        const lineTotal = Number((l.h * l.r).toFixed(2));
        await client.query(
          `INSERT INTO ro_labor_lines (workspace_id, repair_order_id, technician_id, technician_name,
                                       description, hours, hourly_rate, line_total, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
          [wsId, roId, tech.id, tech.name, l.d, l.h, l.r, lineTotal, at(plan.daysAgo, 10)]
        );
        totals.labor_lines++;
      }

      for (const pl of plan.parts) {
        const part = partIds[pl.p % partIds.length];
        const lineTotal = Number((part.retail * pl.q).toFixed(2));
        await client.query(
          `INSERT INTO ro_parts_lines (workspace_id, repair_order_id, part_id, part_number, part_name,
                                       quantity, unit_cost, unit_price, line_total, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
          [wsId, roId, part.id, part.pn, part.name, pl.q, part.cost, part.retail, lineTotal, at(plan.daysAgo, 11)]
        );
        totals.parts_lines++;
      }

      /* Let the database compute the order totals, exactly as the application
         does after every line change (migration 006). */
      await client.query('SELECT recalculate_ro_totals($1)', [roId]);

      roRecords.push({ id: roId, ...plan, customerId: vehicle.customerId, roNumber });
    }

    /* Time entries. The unique index from 007 allows a technician at most one
       open entry, so only the first tech is left clocked in. */
    for (const [i, ro] of roRecords.filter((r) => r.labor.length).entries()) {
      const tech = techs[i % techs.length];
      const minutes = 90 + i * 25;
      await client.query(
        `INSERT INTO time_entries (repair_order_id, technician_id, start_time, end_time, duration_minutes, description)
         VALUES ($1,$2,$3::timestamptz, $3::timestamptz + make_interval(mins => $4), $4, $5)`,
        [ro.id, tech.id, at(ro.daysAgo, 9), minutes, ro.labor[0].d]
      );
      totals.time_entries++;
    }
    const openRO = roRecords.find((r) => r.status === 'in_progress');
    if (openRO && techs.length) {
      await client.query(
        `INSERT INTO time_entries (repair_order_id, technician_id, start_time, description)
         VALUES ($1,$2,NOW() - make_interval(mins => 42),$3)`,
        [openRO.id, techs[0].id, 'Cooling system diagnosis (in progress)']
      );
      totals.time_entries++;
    }

    /* Appointments across the status domain from 005. */
    const APPTS = [
      { v: 0, days: 3,  time: '09:30', status: 'confirmed', method: 'email', concern: '60k mile service', notes: 'Customer will wait on site.' },
      { v: 1, days: 5,  time: '13:00', status: 'pending',   method: 'phone', concern: 'Check engine light came on', notes: null },
      { v: 2, days: -8, time: '08:00', status: 'completed', method: 'text',  concern: 'Tyre rotation and balance', notes: 'Completed same day.' },
      { v: 3, days: 9,  time: '15:15', status: 'pending',   method: 'email', concern: 'Brake inspection before road trip', notes: null },
      { v: 0, days: -2, time: '11:00', status: 'cancelled', method: 'phone', concern: 'Wiper replacement', notes: 'Customer rescheduled.' },
    ];
    for (const a of APPTS) {
      const vehicle = vehicleIds[a.v % vehicleIds.length];
      await client.query(
        `INSERT INTO appointments (workspace_id, customer_id, vehicle_id, preferred_date, preferred_time,
                                   concern, contact_method, notes, status, confirmed_date, confirmed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [wsId, vehicle.customerId, vehicle.id, dateOnly(a.days), a.time, a.concern, a.method, a.notes,
          a.status, a.status === 'confirmed' || a.status === 'completed' ? at(1, 12) : null,
          a.status === 'confirmed' || a.status === 'completed' ? (advisor ? advisor.id : null) : null]
      );
      totals.appointments++;
    }

    /* Feedback on completed work. The unique index is (repair_order_id,
       customer_id), so one entry per order per customer. */
    const FEEDBACK = [
      { rating: 5, comments: 'Clear explanation of what was wrong and why. Car stops properly again.' },
      { rating: 4, comments: 'Quick turnaround. Slightly pricier than I expected but the work is solid.' },
    ];
    for (const [i, ro] of roRecords.filter((r) => r.status === 'completed').entries()) {
      const f = FEEDBACK[i % FEEDBACK.length];
      await client.query(
        `INSERT INTO feedback (workspace_id, repair_order_id, customer_id, rating, comments, feedback_type, created_at)
         VALUES ($1,$2,$3,$4,$5,'repair_order',$6)`,
        [wsId, ro.id, ro.customerId, f.rating, f.comments, at(Math.max(ro.daysAgo - 2, 0), 18)]
      );
      totals.feedback++;
    }

    /* Invoices and payments, covering the whole lifecycle from migration 009.
       Subtotals are read back from the order's lines the way
       services/invoicing.js does, rather than recomputed here. */
    let invSeq = 1000;
    for (const ro of roRecords.filter((r) => r.invoice)) {
      const { rows: sums } = await client.query(
        `SELECT COALESCE((SELECT SUM(line_total) FROM ro_labor_lines WHERE repair_order_id = $1 AND workspace_id = $2),0)
              + COALESCE((SELECT SUM(line_total) FROM ro_parts_lines WHERE repair_order_id = $1 AND workspace_id = $2),0) AS subtotal`,
        [ro.id, wsId]
      );
      const subtotal = Number(Number(sums[0].subtotal).toFixed(2));
      const taxRate = shop.slug === 'ridgeline' ? 0.0475 : 0.0875;
      const taxAmount = Number((subtotal * taxRate).toFixed(2));
      const total = Number((subtotal + taxAmount).toFixed(2));

      const state = ro.invoice;
      const issued = state !== 'draft';
      const amountPaid = state === 'paid' ? total : state === 'partially_paid' ? Number((total / 2).toFixed(2)) : 0;

      const { rows: invRows } = await client.query(
        `INSERT INTO invoices (workspace_id, repair_order_id, customer_id, invoice_number, status,
                               subtotal, tax_rate, tax_amount, total, amount_paid,
                               issued_at, due_date, paid_at, notes, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING id`,
        [wsId, ro.id, ro.customerId, `INV-${new Date().getUTCFullYear()}-${++invSeq}`, state,
          subtotal, taxRate, taxAmount, total, amountPaid,
          issued ? at(Math.max(ro.daysAgo - 1, 0), 17) : null,
          issued ? dateOnly(30 - ro.daysAgo) : null,
          state === 'paid' ? at(Math.max(ro.daysAgo - 3, 0), 12) : null,
          `Billed against ${ro.roNumber}.`,
          advisor ? advisor.id : null, at(Math.max(ro.daysAgo - 1, 0), 17)]
      );
      const invoiceId = invRows[0].id;
      totals.invoices++;

      if (state === 'paid') {
        await client.query(
          `INSERT INTO payments (workspace_id, invoice_id, amount, method, reference, received_at, recorded_by, notes)
           VALUES ($1,$2,$3,'card',$4,$5,$6,'Paid in full at collection.')`,
          [wsId, invoiceId, total, `AUTH-${shop.slug.toUpperCase()}-${invoiceId}`,
            at(Math.max(ro.daysAgo - 3, 0), 12), manager ? manager.id : null]
        );
        totals.payments++;
      } else if (state === 'partially_paid') {
        await client.query(
          `INSERT INTO payments (workspace_id, invoice_id, amount, method, reference, received_at, recorded_by, notes)
           VALUES ($1,$2,$3,'cash',NULL,$4,$5,'Deposit taken at drop-off.')`,
          [wsId, invoiceId, amountPaid, at(Math.max(ro.daysAgo - 2, 0), 9), advisor ? advisor.id : null]
        );
        totals.payments++;
      }
    }

    /* Inbound marketing leads. */
    const LEADS = [
      { name: 'Priscilla Vance', email: 'p.vance@example.test', phone: '828-555-0401', shopType: 'mechanic', revenue: '$500k-$1m', techs: '4', employees: '7', advisor: 'yes', pain: 'Scheduling chaos across two bays', source: 'referral', tools: 'Paper + spreadsheets', status: 'new' },
      { name: 'Owen Blackwood', email: 'owen.b@example.test', phone: '650-555-0512', shopType: 'auto body', revenue: '$1m-$2m', techs: '9', employees: '14', advisor: 'yes', pain: 'Parts ordering has no audit trail', source: 'search', tools: 'Mitchell 1', status: 'contacted' },
      { name: 'Hana Sato', email: 'hana.sato@example.test', phone: '415-555-0733', shopType: 'mechanic', revenue: '<$500k', techs: '2', employees: '3', advisor: 'no', pain: 'Cannot tell which jobs are profitable', source: 'trade show', tools: 'QuickBooks only', status: 'new' },
    ];
    if (shop.slug === 'ridgeline') {
      for (const l of LEADS) {
        await client.query(
          `INSERT INTO leads_inbox (workspace_id, contact_name, contact_email, contact_phone, shop_type,
                                    annual_revenue, technicians, employees, has_advisor, pain_point, source, tools, status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [wsId, l.name, l.email, l.phone, l.shopType, l.revenue, l.techs, l.employees,
            l.advisor, l.pain, l.source, l.tools, l.status, at(15)]
        );
        totals.leads++;
      }
    }
  }

  /* Signup requests in each state, reviewed by the platform admin, with the
     audit rows migration 003 expects. */
  const admin = staffById.admin;
  const SIGNUPS = [
    { name: 'Gareth Pollard', email: 'gareth@pollardauto.test', shop: 'Pollard Automotive', status: 'pending' },
    { name: 'Ines Duarte', email: 'ines@duartemotors.test', shop: 'Duarte Motors', status: 'approved' },
    { name: 'Kyle Brennan', email: 'kyle@brennantune.test', shop: 'Brennan Tuning', status: 'rejected',
      rejectionReason: 'outside_service_area', rejectionComment: 'No coverage in that region yet; revisit next quarter.' },
  ];
  for (const s of SIGNUPS) {
    const approved = s.status === 'approved';
    const rejected = s.status === 'rejected';
    const { rows } = await client.query(
      `INSERT INTO shop_signups (contact_name, contact_email, shop_name, shop_type, annual_revenue,
                                  technicians, employees, has_advisor, pain_point, source, tools, status,
                                  reviewed_by, reviewed_at, workspace_id, user_id,
                                  rejection_reason, rejection_comment, rejected_at, rejected_by, created_at)
       VALUES ($1,$2,$3,'mechanic','$500k-$1m','5','8','yes','Manual repair orders',$14,'Paper',$4,
               $5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [s.name, s.email.toLowerCase(), s.shop, s.status,
        approved || rejected ? admin.id : null,
        approved || rejected ? at(10, 14) : null,
        approved ? WS('bayview') : null,
        approved ? staffById.manager2.id : null,
        s.rejectionReason || null, s.rejectionComment || null,
        rejected ? at(9, 15) : null, rejected ? admin.id : null,
        at(12), SIGNUP_SOURCE]
    );
    totals.signups++;

    if (approved || rejected) {
      await client.query(
        `INSERT INTO signup_audit_log (signup_id, action, performed_by, reason, comment, old_status, new_status, created_at)
         VALUES ($1,$2,$3,$4,$5,'pending',$6,$7)`,
        [rows[0].id, approved ? 'approve' : 'reject', admin.id,
          s.rejectionReason || null, s.rejectionComment || null, s.status, at(10, 14)]
      );
    }
  }

  created.summary = { ...created.summary, ...totals };
  return created;
}

/* ── Credential artifact ──
   Bitwarden's JSON import format, which Vaultwarden accepts unchanged. Written
   0600 and never committed: scripts/ is source, this file is a secret. */
function writeCredentialFile(outPath, credentials) {
  const folderId = crypto.randomUUID();
  const folderName = `AG Shop Pro / ${ENV} demo`;
  const uri = ENV === 'prod' ? 'https://agshopro.com' : 'https://preprod.agshopro.com';

  const payload = {
    encrypted: false,
    folders: [{ id: folderId, name: folderName }],
    items: credentials.map((c) => ({
      id: crypto.randomUUID(),
      organizationId: null,
      folderId,
      type: 1,
      reprompt: 0,
      name: `AG ${ENV} — ${c.role} — ${c.name}`,
      notes: [
        `Environment: ${ENV}`,
        `Role: ${c.role}`,
        c.userId ? `User id: ${c.userId}` : null,
        c.shop ? `Shop: ${c.shop}` : null,
        c.workspaceIds ? `Workspace ids: ${c.workspaceIds.join(', ')}` : null,
        '',
        'Generated by api/scripts/seed-demo.js. Demo account, fictional data.',
        'Re-running the seeder replaces this account and issues a new password.',
      ].filter((line) => line !== null).join('\n'),
      login: { username: c.username, password: c.password, totp: null, uris: [{ match: null, uri }] },
      favorite: false,
      collectionIds: null,
    })),
  };

  const resolved = path.resolve(outPath);
  fs.writeFileSync(resolved, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.chmodSync(resolved, 0o600);
  return resolved;
}

/* ── Main ── */

async function main() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    ssl: process.env.DB_SSL === '0' ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  console.log(`[seed-demo] env=${ENV} db=${process.env.DB_NAME}@${process.env.DB_HOST}` +
    `${CLEANUP_ONLY ? ' mode=cleanup' : ''}${DRY_RUN ? ' mode=dry-run' : ''}`);

  try {
    await client.query('BEGIN');

    const removed = await cleanup(client);
    const removedTotal = Object.values(removed).reduce((a, b) => a + b, 0);
    if (removedTotal) {
      console.log('[seed-demo] removed existing demo rows:',
        Object.entries(removed).map(([k, v]) => `${k}=${v}`).join(' '));
    } else {
      console.log('[seed-demo] no existing demo rows to remove');
    }

    if (CLEANUP_ONLY) {
      if (DRY_RUN) {
        await client.query('ROLLBACK');
        console.log('[seed-demo] dry run: rolled back, nothing was deleted');
      } else {
        await client.query('COMMIT');
        console.log('[seed-demo] cleanup committed');
      }
      return;
    }

    const created = await seed(client);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('[seed-demo] dry run: rolled back, database unchanged');
    } else {
      await client.query('COMMIT');
      console.log('[seed-demo] committed');
    }

    console.log('[seed-demo] seeded:',
      Object.entries(created.summary).map(([k, v]) => `${k}=${v}`).join(' '));

    if (OUT && !DRY_RUN) {
      const written = writeCredentialFile(OUT, created.credentials);
      console.log(`[seed-demo] ${created.credentials.length} credentials written to ${written} (mode 0600)`);
      console.log('[seed-demo] Import into Vaultwarden: Tools -> Import data -> Bitwarden (json)');
      console.log('[seed-demo] Delete the file once imported; it is plaintext.');
    } else if (!DRY_RUN) {
      console.log('');
      console.log('  No --out given, so credentials are printed once and not saved:');
      console.log('');
      for (const c of created.credentials) {
        console.log(`  ${c.role.padEnd(16)} ${c.username.padEnd(44)} ${c.password}`);
      }
      console.log('');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[seed-demo]', err.message);
  process.exit(1);
});
