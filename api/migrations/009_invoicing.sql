-- Invoicing and payment records.
--
-- The product had no billing schema. Production carried `invoices`, `payments`
-- and `refunds` tables, but those belonged to the pre-git Square/Mitchell build
-- and were dropped when production was rebuilt from these migrations; nothing in
-- this codebase ever read them. `services/analytics.js` still reports
-- `paymentsIntegration: 'not_connected'` and `refunds: null` for that reason.
--
-- MODEL
--
-- One invoice per repair order. A repair order is the unit of work a shop bills
-- for, so a unique index on (workspace_id, repair_order_id) enforces 1:1 rather
-- than modelling invoices that span several orders.
--
-- `subtotal` is a SNAPSHOT of the order's labour + parts total taken when the
-- invoice is issued. It is deliberately not a view over ro_*_lines: editing a
-- line on an already-issued invoice must not silently restate what the customer
-- was billed. Corrections happen by voiding and re-issuing.
--
-- `tax_rate` is per-invoice and supplied by the caller. There is no tax
-- jurisdiction engine -- rates vary by state and that is a product decision, not
-- something to infer from customers.state.
--
-- `amount_paid` is maintained transactionally by the service as payments are
-- recorded, rather than being a generated column, so the running balance can be
-- read without aggregating payments on every query. The CHECK keeps it from
-- drifting past the invoice total (overpayment is rejected at the service).
--
-- Refunds and credit notes are out of scope; `payments.amount` is constrained
-- positive so a negative "refund" row cannot be smuggled in to fake one.

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- RESTRICT, not CASCADE: an issued invoice is a financial record and must not
  -- disappear because someone deleted the order or customer behind it. This
  -- matches the constraint 007 put on repair_orders -> customers/vehicles.
  repair_order_id INTEGER NOT NULL REFERENCES repair_orders(id) ON DELETE RESTRICT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,

  invoice_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',

  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(6,4) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,

  issued_at TIMESTAMPTZ,
  due_date DATE,
  paid_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  notes TEXT,

  created_by VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT invoices_status_check
    CHECK (status IN ('draft', 'issued', 'partially_paid', 'paid', 'void')),
  CONSTRAINT invoices_amounts_nonneg
    CHECK (subtotal >= 0 AND tax_amount >= 0 AND total >= 0 AND amount_paid >= 0),
  CONSTRAINT invoices_not_overpaid
    CHECK (amount_paid <= total)
);

-- One invoice per order, per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_ws_repair_order
  ON invoices(workspace_id, repair_order_id);

-- Numbers are generated per workspace (INV-<year>-<seq>), the same way
-- repair-order.js derives ro_number under the transaction's lock.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_ws_number
  ON invoices(workspace_id, invoice_number);

CREATE INDEX IF NOT EXISTS idx_invoices_ws_status
  ON invoices(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_ws_created
  ON invoices(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_customer
  ON invoices(customer_id);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- CASCADE here is safe and intended: payments have no meaning without their
  -- invoice, and an invoice can only be deleted by deleting its workspace.
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,

  amount NUMERIC(12,2) NOT NULL,
  method TEXT NOT NULL,
  reference TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT,

  recorded_by VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT payments_amount_positive CHECK (amount > 0),
  CONSTRAINT payments_method_check
    CHECK (method IN ('cash', 'check', 'card', 'ach', 'other'))
);

CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_ws_received ON payments(workspace_id, received_at DESC);

-- A card/ACH reference is the processor's transaction id; two payments claiming
-- the same one are a double-post, not two payments.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_ws_reference
  ON payments(workspace_id, reference)
  WHERE reference IS NOT NULL;
