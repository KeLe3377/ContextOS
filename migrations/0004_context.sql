CREATE TABLE context_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL CHECK (source_type IN ('FILE', 'DIRECTORY', 'URL', 'AGENT_OUTPUT', 'USER_NOTE')),
  name TEXT NOT NULL,
  locator TEXT NOT NULL,
  description TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  last_snapshot_id TEXT NULL,
  last_checked_at INTEGER NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  archived_at INTEGER NULL
);

CREATE INDEX idx_context_sources_project_status ON context_sources(project_id, status);
CREATE INDEX idx_context_sources_locator ON context_sources(locator);

CREATE TABLE evidence_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_id TEXT NULL REFERENCES context_sources(id) ON DELETE SET NULL,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('TEXT', 'FILE', 'DIRECTORY_LISTING', 'URL', 'COMMAND_OUTPUT', 'AGENT_OUTPUT')),
  title TEXT NOT NULL,
  uri TEXT NULL,
  content_text TEXT NULL,
  content_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  captured_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_evidence_snapshots_project_created ON evidence_snapshots(project_id, created_at);
CREATE INDEX idx_evidence_snapshots_source_created ON evidence_snapshots(source_id, created_at);
CREATE UNIQUE INDEX idx_evidence_snapshots_project_hash ON evidence_snapshots(project_id, content_hash);

CREATE TABLE context_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_snapshot_id TEXT NULL REFERENCES evidence_snapshots(id) ON DELETE SET NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('FACT', 'SUMMARY', 'CONSTRAINT', 'OPEN_QUESTION', 'RISK', 'HANDOFF')),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'STALE', 'ARCHIVED')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('LOW', 'MEDIUM', 'HIGH')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  archived_at INTEGER NULL
);

CREATE INDEX idx_context_items_project_status ON context_items(project_id, status);
CREATE INDEX idx_context_items_snapshot ON context_items(source_snapshot_id);

CREATE TABLE context_item_versions (
  id TEXT PRIMARY KEY,
  context_item_id TEXT NOT NULL REFERENCES context_items(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NULL,
  confidence TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by_type TEXT NOT NULL,
  created_by_id TEXT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (context_item_id, version_number)
);

CREATE TABLE context_packages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  context_item_ids_json TEXT NOT NULL DEFAULT '[]',
  evidence_snapshot_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_context_packages_project_updated ON context_packages(project_id, updated_at);
