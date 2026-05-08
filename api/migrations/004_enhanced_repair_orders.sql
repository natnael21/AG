-- Enhanced repair order management
-- Adds parts, labor, and proper workflow

-- Parts catalog
CREATE TABLE IF NOT EXISTS parts (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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

-- Repair order parts lines (many-to-many with quantities)
CREATE TABLE IF NOT EXISTS ro_parts_lines (
  id SERIAL PRIMARY KEY,
  repair_order_id INTEGER NOT NULL REFERENCES repair_orders(id) ON DELETE CASCADE,
  part_id INTEGER REFERENCES parts(id) ON DELETE SET NULL,
  part_number TEXT NOT NULL, -- Store here in case part is deleted
  part_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_cost DECIMAL(10,2),
  unit_price DECIMAL(10,2),
  line_total DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Repair order labor lines
CREATE TABLE IF NOT EXISTS ro_labor_lines (
  id SERIAL PRIMARY KEY,
  repair_order_id INTEGER NOT NULL REFERENCES repair_orders(id) ON DELETE CASCADE,
  technician_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  technician_name TEXT, -- Store here in case user is deleted
  description TEXT NOT NULL,
  hours DECIMAL(6,2) NOT NULL DEFAULT 0,
  hourly_rate DECIMAL(8,2) NOT NULL DEFAULT 0,
  line_total DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Time tracking for technicians
CREATE TABLE IF NOT EXISTS time_entries (
  id SERIAL PRIMARY KEY,
  repair_order_id INTEGER REFERENCES repair_orders(id) ON DELETE CASCADE,
  technician_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  duration_minutes INTEGER,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Customer feedback/satisfaction
CREATE TABLE IF NOT EXISTS repair_order_feedback (
  id SERIAL PRIMARY KEY,
  repair_order_id INTEGER NOT NULL REFERENCES repair_orders(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  comments TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_parts_workspace ON parts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_parts_part_number ON parts(part_number);
CREATE INDEX IF NOT EXISTS idx_ro_parts_lines_ro ON ro_parts_lines(repair_order_id);
CREATE INDEX IF NOT EXISTS idx_ro_labor_lines_ro ON ro_labor_lines(repair_order_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_ro ON time_entries(repair_order_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_technician ON time_entries(technician_id);
CREATE INDEX IF NOT EXISTS idx_feedback_ro ON repair_order_feedback(repair_order_id);

-- Update repair_orders table with additional fields
ALTER TABLE repair_orders
  ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  ADD COLUMN IF NOT EXISTS estimated_completion TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS actual_completion TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS customer_approval_required BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS customer_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_approved_by INTEGER REFERENCES users(id);

-- Recalculate totals function
CREATE OR REPLACE FUNCTION recalculate_ro_totals(ro_id INTEGER)
RETURNS VOID AS $$
DECLARE
  parts_total DECIMAL(12,2) := 0;
  labor_total DECIMAL(12,2) := 0;
  total DECIMAL(12,2);
BEGIN
  -- Sum parts
  SELECT COALESCE(SUM(line_total), 0) INTO parts_total
  FROM ro_parts_lines WHERE repair_order_id = ro_id;

  -- Sum labor
  SELECT COALESCE(SUM(line_total), 0) INTO labor_total
  FROM ro_labor_lines WHERE repair_order_id = ro_id;

  -- Update totals
  total := parts_total + labor_total;
  UPDATE repair_orders
  SET total_estimate = total, total_final = total, updated_at = NOW()
  WHERE id = ro_id;
END;
$$ LANGUAGE plpgsql;