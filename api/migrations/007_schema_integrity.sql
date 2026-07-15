-- Closes schema gaps that make several shipped endpoints fail at runtime, and
-- adds the tenant columns / constraints the application logic already assumes.
--
-- Verified against a fresh DB built from 001..006 before writing this file:
--   * users.updated_at              MISSING -> every UserManagementService write
--                                   ("SET ... updated_at = NOW()") raised
--                                   "column updated_at of relation users does not exist".
--   * customers.address/city/state/zip_code
--                                   MISSING -> CustomerPortalService.getCustomerProfile
--                                   and updateCustomerProfile selected them and failed.
--   * appointments.workspace_id     MISSING -> appointments could not be tenant-scoped;
--                                   staff-side queries had to join customers to filter.
--   * feedback.workspace_id         MISSING -> same, for customer feedback.
--
-- Earlier migrations are left untouched: 005 has already been applied to
-- preprod/production, so corrections belong in a new file (the convention
-- 006 established).

/* ── users: updated_at ─────────────────────────────────────────────── */
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

/* ── customers: postal address used by the portal profile ──────────── */
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS address  TEXT,
  ADD COLUMN IF NOT EXISTS city     TEXT,
  ADD COLUMN IF NOT EXISTS state    TEXT,
  ADD COLUMN IF NOT EXISTS zip_code TEXT;

/* ── appointments: tenant scoping ──────────────────────────────────── */
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE;

-- Backfill from the owning customer, then enforce NOT NULL.
UPDATE appointments a
   SET workspace_id = c.workspace_id
  FROM customers c
 WHERE a.customer_id = c.id
   AND a.workspace_id IS NULL;

DELETE FROM appointments WHERE workspace_id IS NULL;

ALTER TABLE appointments
  ALTER COLUMN workspace_id SET NOT NULL;

/* ── feedback: tenant scoping ──────────────────────────────────────── */
ALTER TABLE feedback
  ADD COLUMN IF NOT EXISTS workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE;

UPDATE feedback f
   SET workspace_id = c.workspace_id
  FROM customers c
 WHERE f.customer_id = c.id
   AND f.workspace_id IS NULL;

DELETE FROM feedback WHERE workspace_id IS NULL;

ALTER TABLE feedback
  ALTER COLUMN workspace_id SET NOT NULL;

-- One feedback entry per customer per repair order.
CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_ro_customer
  ON feedback(repair_order_id, customer_id);

-- Note: repair_order_feedback (004/006) is superseded by feedback (005), which
-- is what the customer portal writes and the reports read. Nothing in the
-- application has ever written to repair_order_feedback. It is left in place
-- rather than dropped, in case an environment holds rows this repo cannot see;
-- it should be dropped once that is confirmed. Do not add new readers.
COMMENT ON TABLE repair_order_feedback IS
  'Superseded by feedback (migration 005). No writers; do not use.';

/* ── Referential integrity the app relies on ───────────────────────── */

-- A repair order without a customer or vehicle cannot be rendered: every
-- detail query INNER JOINs both. 002 declared them ON DELETE SET NULL, which
-- silently produces such rows. Restrict deletion instead.
ALTER TABLE repair_orders
  DROP CONSTRAINT IF EXISTS repair_orders_customer_id_fkey,
  DROP CONSTRAINT IF EXISTS repair_orders_vehicle_id_fkey;

ALTER TABLE repair_orders
  ADD CONSTRAINT repair_orders_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT,
  ADD CONSTRAINT repair_orders_vehicle_id_fkey
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE RESTRICT;

/* ── Uniqueness ────────────────────────────────────────────────────── */

-- PartsService.createPart already rejects duplicates with a SELECT-then-INSERT,
-- which races under concurrency; back it with a real constraint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_parts_ws_part_number
  ON parts(workspace_id, part_number);

-- ImportService.importVehicles dedupes on (workspace_id, vin) the same way.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicles_ws_vin
  ON vehicles(workspace_id, vin)
  WHERE vin IS NOT NULL;

-- A technician can hold at most one open time entry at a time. The service
-- checks this before inserting; the index makes the rule hold under
-- concurrent clock-ins.
DELETE FROM time_entries te
 WHERE te.end_time IS NULL
   AND te.id <> (
     SELECT max(id) FROM time_entries x
      WHERE x.technician_id = te.technician_id AND x.end_time IS NULL
   );

CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entries_open_per_tech
  ON time_entries(technician_id)
  WHERE end_time IS NULL;

/* ── Status domains ────────────────────────────────────────────────── */

-- repair_orders.status was free text; RepairOrderService.isValidStatusTransition
-- and the API both work from this exact set.
ALTER TABLE repair_orders
  DROP CONSTRAINT IF EXISTS repair_orders_status_check;

ALTER TABLE repair_orders
  ADD CONSTRAINT repair_orders_status_check
    CHECK (status IN ('draft','open','in_progress','awaiting_parts','ready','completed','cancelled'));

/* ── Indexes for the access paths the pages actually use ───────────── */
CREATE INDEX IF NOT EXISTS idx_appointments_ws_date
  ON appointments(workspace_id, preferred_date DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_ws
  ON feedback(workspace_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_customer
  ON vehicles(customer_id);
CREATE INDEX IF NOT EXISTS idx_repair_orders_customer
  ON repair_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_repair_orders_vehicle
  ON repair_orders(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_customers_ws_email_lower
  ON customers(workspace_id, lower(email))
  WHERE email IS NOT NULL;

/* ── Views refreshed for the new columns ───────────────────────────── */

-- appointment_summary gains workspace_id so staff queries can filter without
-- joining customers.
DROP VIEW IF EXISTS appointment_summary;
CREATE VIEW appointment_summary AS
SELECT
  a.*,
  c.full_name AS customer_name,
  c.email     AS customer_email,
  c.phone     AS customer_phone,
  v.year, v.make, v.model, v.plate,
  u.name      AS confirmed_by_name
FROM appointments a
JOIN customers c ON a.customer_id = c.id
JOIN vehicles  v ON a.vehicle_id  = v.id
LEFT JOIN users u ON a.confirmed_by = u.id;
