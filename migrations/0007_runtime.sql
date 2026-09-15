CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CREATED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED')),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  available_at INTEGER NOT NULL,
  started_at INTEGER NULL,
  ended_at INTEGER NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  failure_code TEXT NULL,
  failure_message TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_jobs_status_available ON jobs(status, available_at);
CREATE INDEX idx_jobs_resource ON jobs(resource_type, resource_id);

CREATE TABLE job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('STARTED', 'SUCCEEDED', 'FAILED', 'CANCELED')),
  worker_id TEXT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NULL,
  failure_code TEXT NULL,
  failure_message TEXT NULL
);

CREATE TABLE activity_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NULL REFERENCES projects(id) ON DELETE SET NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_activity_events_resource ON activity_events(resource_type, resource_id, created_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NULL REFERENCES projects(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT NULL,
  after_json TEXT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_audit_events_resource ON audit_events(resource_type, resource_id, created_at);

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'DISPATCHED', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_outbox_events_status_next ON outbox_events(status, next_attempt_at);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_idempotency_keys_expires ON idempotency_keys(expires_at);

INSERT OR IGNORE INTO settings (id, data_directory, created_at, updated_at)
VALUES ('singleton', '.contextos', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);
