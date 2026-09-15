CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NULL,
  root_path TEXT NOT NULL,
  root_path_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),
  default_rule_ids TEXT NOT NULL DEFAULT '[]',
  agent_adapter_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  archived_at INTEGER NULL
);

CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_root_path_hash ON projects(root_path_hash);
CREATE INDEX idx_projects_updated_at ON projects(updated_at);

CREATE TABLE settings (
  id TEXT PRIMARY KEY CHECK (id = 'singleton'),
  launch_at_startup INTEGER NOT NULL DEFAULT 0 CHECK (launch_at_startup IN (0, 1)),
  start_minimized INTEGER NOT NULL DEFAULT 0 CHECK (start_minimized IN (0, 1)),
  confirm_destructive_actions INTEGER NOT NULL DEFAULT 1 CHECK (confirm_destructive_actions IN (0, 1)),
  local_endpoint TEXT NOT NULL DEFAULT '127.0.0.1:4721',
  default_adapter_id TEXT NULL,
  context_config_json TEXT NOT NULL DEFAULT '{}',
  privacy_config_json TEXT NOT NULL DEFAULT '{}',
  data_directory TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE agent_adapters (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  implementation TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  last_checked_at INTEGER NULL,
  last_error_code TEXT NULL,
  last_error_message TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
