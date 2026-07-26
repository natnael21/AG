-- AG Shop Pro — baseline schema (auth, workspaces, integration counters, RO-related tables)

CREATE TABLE IF NOT EXISTS workspaces (
  -- Matches production: workspace ids are app-generated strings ("ws-<uuid>"),
  -- not autoincrement integers. Changing this file is safe for already-migrated
  -- environments because migrate.js skips filenames already in schema_migrations.
  id VARCHAR(64) PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  type TEXT,
  plan TEXT DEFAULT 'starter',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  workspace_ids VARCHAR(64)[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT true,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reset_token TEXT,
  reset_expiry TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));
CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users (reset_token) WHERE reset_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS workspace_integrations (
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  connected_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  total_synced INTEGER DEFAULT 0,
  PRIMARY KEY (workspace_id, integration)
);

CREATE TABLE IF NOT EXISTS etl_sync_log (
  id SERIAL PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration TEXT NOT NULL,
  last_sync_at TIMESTAMPTZ,
  status TEXT,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_etl_sync_log_ws ON etl_sync_log(workspace_id, integration);

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
