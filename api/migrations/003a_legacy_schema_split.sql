-- Displace production's pre-existing business tables so this application can
-- own `public`.
--
-- WHY THIS EXISTS
--
-- The production database predates this repository. It was created by an
-- earlier Square/Mitchell-integrated build of AG Shop Pro and carries tables
-- this codebase has never referenced (invoices, payments, refunds,
-- square_catalog, etl_jobs, oauth_states, ro_comments, vehicle_mileage_log)
-- alongside its own customers / vehicles / repair_orders / ro_*_lines.
--
-- Those five collide with ours, and the shapes are incompatible:
--
--     column                      legacy prod        this repo
--     customers.id                varchar(128)       SERIAL
--     vehicles.id                 varchar(128)       SERIAL
--     repair_orders.id            varchar(128)       SERIAL
--     ro_*_lines.id               varchar(128)       SERIAL
--     ro_*_lines -> order FK      ro_id              repair_order_id
--
-- 001_initial.sql never noticed, because CREATE TABLE IF NOT EXISTS silently
-- no-op'd against the tables that were already there, and 002_core_entities'
-- ADD COLUMN IF NOT EXISTS did the same for every FK column -- which is why 002
-- recorded as "applied" on production without creating a single one of its
-- foreign keys. The mismatch only surfaced at 004, whose new tables really do
-- have to declare `INTEGER REFERENCES repair_orders(id)` against a varchar PK.
--
-- WHAT THIS DOES
--
-- Moves those five tables into a `legacy` schema and rebuilds them in `public`
-- with the shape 001 + 002 intended. Nothing is dropped: the legacy rows, their
-- indexes and their constraints all survive under `legacy`, and the untouched
-- public tables that reference them (invoices, payments, ro_comments,
-- vehicle_mileage_log) keep working -- a foreign key follows its target across
-- a schema move. Reverse any single table with:
--
--     ALTER TABLE public.customers  SET SCHEMA legacy_rejected;  -- park ours
--     ALTER TABLE legacy.customers  SET SCHEMA public;           -- restore theirs
--
-- On a fresh database (CI, preprod-from-scratch, local test runs) this file is
-- a no-op: nothing is legacy-shaped, so nothing moves, and every rebuild
-- statement below is guarded by IF NOT EXISTS.
--
-- Ordered 003a so it lands after 003_signup_audit.sql and before
-- 004_enhanced_repair_orders.sql, which is the first migration that would fail.

/* ── 1. Move the colliding legacy tables aside ─────────────────────── */

DO $$
DECLARE
  t     text;
  moved int := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers', 'vehicles', 'repair_orders',
                           'ro_labor_lines', 'ro_parts_lines']
  LOOP
    /* A varchar `id` is the discriminator: this repo has only ever declared
       these as SERIAL, so a string PK can only have come from the legacy
       build. */
    IF EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = t
         AND column_name  = 'id'
         AND data_type    = 'character varying'
    ) THEN
      IF moved = 0 THEN
        EXECUTE 'CREATE SCHEMA IF NOT EXISTS legacy';
      END IF;
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA legacy', t);
      moved := moved + 1;
      RAISE NOTICE '[003a] displaced public.% -> legacy.%', t, t;
    END IF;
  END LOOP;

  IF moved = 0 THEN
    RAISE NOTICE '[003a] no legacy-shaped tables present; nothing to displace';
  ELSE
    EXECUTE $c$COMMENT ON SCHEMA legacy IS
      'Pre-existing Square/Mitchell tables displaced by migration 003a so this application could own public. No application code reads them. Restore one with: ALTER TABLE legacy.<table> SET SCHEMA public.'$c$;
  END IF;
END $$;

/* ── 2. Rebuild them in `public` with the shape 001 + 002 intended ──── */

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS vehicles (
  id SERIAL PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS repair_orders (
  id SERIAL PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ro_labor_lines (
  id SERIAL PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ro_parts_lines (
  id SERIAL PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
);

/* The columns 002_core_entities.sql adds. On production these ALTERs are what
   002 was supposed to do and silently didn't; on a fresh database they are
   already present and no-op. */

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS full_name TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vin TEXT,
  ADD COLUMN IF NOT EXISTS year INTEGER,
  ADD COLUMN IF NOT EXISTS make TEXT,
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS plate TEXT,
  ADD COLUMN IF NOT EXISTS mileage INTEGER,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE repair_orders
  ADD COLUMN IF NOT EXISTS ro_number TEXT,
  ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS concern TEXT,
  ADD COLUMN IF NOT EXISTS total_estimate NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_final NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_customers_ws_created ON customers(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vehicles_ws_created ON vehicles(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repair_orders_ws_created ON repair_orders(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repair_orders_ws_status ON repair_orders(workspace_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_repair_orders_ws_ro_number ON repair_orders(workspace_id, ro_number);
