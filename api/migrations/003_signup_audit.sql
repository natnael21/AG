-- Add rejection tracking and audit trail for signups

ALTER TABLE shop_signups
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS rejection_comment TEXT,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by VARCHAR(64) REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reinstated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reinstated_by VARCHAR(64) REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS status_history JSONB DEFAULT '[]'::jsonb;

-- Create audit log table for signup actions
CREATE TABLE IF NOT EXISTS signup_audit_log (
  id SERIAL PRIMARY KEY,
  signup_id INTEGER NOT NULL REFERENCES shop_signups(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  performed_by VARCHAR(64) REFERENCES users(id),
  reason TEXT,
  comment TEXT,
  old_status TEXT,
  new_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signup_audit_log_signup_id ON signup_audit_log(signup_id);
CREATE INDEX IF NOT EXISTS idx_signup_audit_log_created ON signup_audit_log(created_at DESC);
