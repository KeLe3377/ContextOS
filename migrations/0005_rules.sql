CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  current_version_id TEXT NULL,
  title TEXT NOT NULL,
  description TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'DISABLED', 'ARCHIVED')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  archived_at INTEGER NULL
);

CREATE INDEX idx_rules_project_status ON rules(project_id, status);
CREATE INDEX idx_rules_updated ON rules(updated_at);

CREATE TABLE rule_versions (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}',
  conditions_json TEXT NOT NULL DEFAULT '[]',
  effect_json TEXT NOT NULL DEFAULT '{}',
  enforcement_mode TEXT NOT NULL CHECK (enforcement_mode IN ('ADVISORY', 'WARNING', 'REQUIRE_REVIEW', 'BLOCK')),
  precedence INTEGER NOT NULL DEFAULT 100,
  exceptions_json TEXT NOT NULL DEFAULT '[]',
  validation_state TEXT NOT NULL CHECK (validation_state IN ('UNKNOWN', 'VALID', 'INVALID')),
  validation_errors_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  created_by_type TEXT NOT NULL,
  created_by_id TEXT NULL,
  created_at INTEGER NOT NULL,
  activated_at INTEGER NULL,
  UNIQUE (rule_id, version_number)
);

CREATE INDEX idx_rule_versions_rule_number ON rule_versions(rule_id, version_number);
CREATE INDEX idx_rule_versions_validation ON rule_versions(validation_state);
