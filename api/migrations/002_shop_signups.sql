CREATE TABLE IF NOT EXISTS shop_signups (
  id SERIAL PRIMARY KEY,
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_phone TEXT,
  shop_name TEXT NOT NULL,
  shop_type TEXT,
  annual_revenue TEXT,
  technicians TEXT,
  employees TEXT,
  has_advisor TEXT,
  pain_point TEXT,
  source TEXT,
  tools TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  workspace_id TEXT,
  user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shop_signups_status_created
  ON shop_signups(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shop_signups_email_lower
  ON shop_signups(lower(contact_email));
