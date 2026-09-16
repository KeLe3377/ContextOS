CREATE TABLE rule_evaluations (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE RESTRICT,
  rule_version_id TEXT NOT NULL REFERENCES rule_versions(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NULL,
  input_hash TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('MATCHED', 'NOT_MATCHED')),
  explanation TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_rule_evaluations_rule_created ON rule_evaluations(rule_id, created_at DESC);
CREATE INDEX idx_rule_evaluations_resource ON rule_evaluations(resource_type, resource_id, created_at DESC);
