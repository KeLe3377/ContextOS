CREATE TABLE review_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED')),
  priority TEXT NOT NULL CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
  summary TEXT NOT NULL,
  evidence_delta_ref TEXT NULL,
  proposed_resolution TEXT NULL,
  reviewer_id TEXT NULL,
  resolution_type TEXT NULL,
  resolution_reason TEXT NULL,
  due_at INTEGER NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_review_items_project_status_priority ON review_items(project_id, status, priority);
CREATE INDEX idx_review_items_source ON review_items(source_type, source_id);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  current_version_id TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PROPOSED', 'ACCEPTED', 'SUPERSEDED', 'REVERSED', 'ARCHIVED')),
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  archived_at INTEGER NULL
);

CREATE TABLE decision_versions (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('DRAFT', 'PROPOSED', 'ACCEPTED', 'SUPERSEDED', 'REVERSED')),
  statement TEXT NOT NULL,
  problem_context TEXT NULL,
  rationale TEXT NOT NULL,
  alternatives_json TEXT NOT NULL DEFAULT '[]',
  consequences TEXT NULL,
  references_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  created_by_type TEXT NOT NULL,
  created_by_id TEXT NULL,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER NULL,
  supersedes_version_id TEXT NULL REFERENCES decision_versions(id),
  reverses_version_id TEXT NULL REFERENCES decision_versions(id),
  UNIQUE (decision_id, version_number)
);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  parent_id TEXT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('BACKLOG', 'READY', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'DONE', 'CANCELED')),
  assignee_type TEXT NULL,
  assignee_id TEXT NULL,
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  execution_contract TEXT NULL,
  readiness_state TEXT NOT NULL DEFAULT '{}',
  scheduled_at INTEGER NULL,
  completed_at INTEGER NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  CHECK (parent_id IS NULL OR parent_id != id)
);

CREATE INDEX idx_work_items_project_status ON work_items(project_id, status);

CREATE TABLE work_item_dependencies (
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  depends_on_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  dependency_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (work_item_id, depends_on_id),
  CHECK (work_item_id != depends_on_id)
);

CREATE TABLE work_item_attempts (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  session_id TEXT NULL REFERENCES sessions(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('STARTED', 'SUCCEEDED', 'FAILED', 'CANCELED')),
  summary TEXT NULL,
  result_ref TEXT NULL,
  started_at INTEGER NULL,
  ended_at INTEGER NULL,
  created_at INTEGER NOT NULL
);
