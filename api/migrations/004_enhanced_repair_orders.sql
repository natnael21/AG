-- Enhanced repair order management
-- ro_parts_lines and ro_labor_lines were created as stub tables in
-- 001_initial.sql (id + workspace_id only), so this migration uses
-- ALTER TABLE ADD COLUMN IF NOT EXISTS instead of CREATE TABLE to be
-- idempotent on any DB state. All other tables are new and safe to CREATE.

-- Parts catalog (new table)
CREATE TABLE IF NOT EXISTS parts (
  id SERIAL PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  part_number TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  manufacturer TEXT,
  cost_price DECIMAL(10,2),
  retail_price DECIMAL(10,2),
  quantity_on_hand INTEGER NOT NULL DEFAULT 0,
  minimum_stock INTEGER DEFAULT 0,
  location TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Complete ro_parts_lines schema (stub from 001 had only id + workspace_id).
-- Columns are nullable so ALTER succeeds even when rows already exist.
ALTER TABLE ro_parts_lines
  ADD COLUMN IF NOT EXISTS repair_order_id INTEGER REFERENCES repair_orders(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS part_id INTEGER REFERENCES parts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS part_number TEXT,
  ADD COLUMN IF NOT EXISTS part_name TEXT,
  ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS unit_cost DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS unit_price DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS line_total DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Complete ro_labor_lines schema (stub from 001 had only id + workspace_id).
ALTER TABLE ro_labor_lines
  ADD COLUMN IF NOT EXISTS repair_order_id INTEGER REFERENCES repair_orders(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS technician_id VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS technician_name TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS hours DECIMAL(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hourly_rate DECIMAL(8,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS line_total DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Time tracking for technicians (new table)
CREATE TABLE IF NOT EXISTS time_entries (
  id SERIAL PRIMARY KEY,
  repair_order_id INTEGER REFERENCES repair_orders(id) ON DELETE CASCADE,
  technician_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  duration_minutes INTEGER,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Customer feedback (new table)
CREATE TABLE IF NOT EXISTS repair_order_feedback (
  id SERIAL PRIMARY KEY,
  repair_order_id INTEGER NOT NULL REFERENCES repair_orders(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  comments TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_parts_workspace ON parts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_parts_part_number ON parts(part_number);
CREATE INDEX IF NOT EXISTS idx_ro_parts_lines_ro ON ro_parts_lines(repair_order_id);
CREATE INDEX IF NOT EXISTS idx_ro_labor_lines_ro ON ro_labor_lines(repair_order_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_ro ON time_entries(repair_order_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_technician ON time_entries(technician_id);
CREATE INDEX IF NOT EXISTS idx_feedback_ro ON repair_order_feedback(repair_order_id);

-- Additional repair_orders fields
ALTER TABLE repair_orders
  ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  ADD COLUMN IF NOT EXISTS estimated_completion TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS actual_completion TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS customer_approval_required BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS customer_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_approved_by VARCHAR(64) REFERENCES users(id);

-- Recalculate totals helper function
CREATE OR REPLACE FUNCTION recalculate_ro_totals(ro_id INTEGER)
RETURNS VOID AS $$
DECLARE
  parts_total DECIMAL(12,2) := 0;
  labor_total DECIMAL(12,2) := 0;
  total DECIMAL(12,2);
BEGIN
  SELECT COALESCE(SUM(line_total), 0) INTO parts_total
  FROM ro_parts_lines WHERE repair_order_id = ro_id;

  SELECT COALESCE(SUM(line_total), 0) INTO labor_total
  FROM ro_labor_lines WHERE repair_order_id = ro_id;

  total := parts_total + labor_total;
  UPDATE repair_orders
  SET total_estimate = total, total_final = total, updated_at = NOW()
  WHERE id = ro_id;
END;
$$ LANGUAGE plpgsql;
