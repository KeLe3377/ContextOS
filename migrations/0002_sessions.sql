CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  agent_adapter_id TEXT NOT NULL,
  external_session_id TEXT NULL,
  title TEXT NULL,
  intent TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('CREATED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'ARCHIVED')),
  runtime_state TEXT NOT NULL DEFAULT '{}',
  context_package_id TEXT NULL,
  resume_capsule_id TEXT NULL,
  started_at INTEGER NULL,
  completed_at INTEGER NULL,
  last_activity_at INTEGER NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  archived_at INTEGER NULL
);

CREATE UNIQUE INDEX idx_sessions_adapter_external ON sessions(agent_adapter_id, external_session_id) WHERE external_session_id IS NOT NULL;
CREATE INDEX idx_sessions_project_updated ON sessions(project_id, updated_at);
CREATE INDEX idx_sessions_project_status ON sessions(project_id, status);

CREATE TABLE session_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  job_id TEXT NULL,
  external_run_id TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('CREATED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED')),
  pid INTEGER NULL,
  started_at INTEGER NULL,
  ended_at INTEGER NULL,
  exit_code INTEGER NULL,
  failure_code TEXT NULL,
  failure_message TEXT NULL,
  adapter_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_session_runs_session_created ON session_runs(session_id, created_at);
CREATE INDEX idx_session_runs_status ON session_runs(status);
