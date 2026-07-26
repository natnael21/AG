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

CREATE TABLE IF NOT EXISTS leads_inbox (
  id SERIAL PRIMARY KEY,
  workspace_id VARCHAR(64) REFERENCES workspaces(id) ON DELETE SET NULL,
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_phone TEXT,
  shop_type TEXT,
  annual_revenue TEXT,
  technicians TEXT,
  employees TEXT,
  has_advisor TEXT,
  pain_point TEXT,
  source TEXT,
  tools TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_ws_created ON customers(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vehicles_ws_created ON vehicles(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repair_orders_ws_created ON repair_orders(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repair_orders_ws_status ON repair_orders(workspace_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_repair_orders_ws_ro_number ON repair_orders(workspace_id, ro_number);
CREATE INDEX IF NOT EXISTS idx_leads_inbox_created ON leads_inbox(created_at DESC);
