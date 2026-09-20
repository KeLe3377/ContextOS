-- Zero-input automation storage: project settings, persistent jobs, attempts,
-- extraction candidates and candidate/evidence provenance links.
--
-- Design: docs/superpowers/specs/2026-09-20-contextos-zero-input-automation-design.md
-- These tables are deliberately separate from the existing `jobs` / `job_attempts`
-- pair, which keeps carrying Agent Continue runs and must not change its public shape.

CREATE TABLE project_automation_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'SUGGEST_ONLY'
    CHECK (mode IN ('OFF', 'SUGGEST_ONLY', 'AUTO_ACCEPT_HIGH_CONFIDENCE')),
  poll_interval_ms INTEGER NOT NULL DEFAULT 30000
    CHECK (poll_interval_ms BETWEEN 5000 AND 300000),
  max_concurrent_jobs INTEGER NOT NULL DEFAULT 1
    CHECK (max_concurrent_jobs BETWEEN 1 AND 4),
  source_max_bytes INTEGER NOT NULL DEFAULT 262144
    CHECK (source_max_bytes BETWEEN 1024 AND 1000000),
  auto_accept_threshold REAL NOT NULL DEFAULT 0.9
    CHECK (auto_accept_threshold BETWEEN 0 AND 1),
  last_discovery_at INTEGER NULL,
  last_sync_at INTEGER NULL,
  last_extraction_at INTEGER NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

-- Existing Projects start in SUGGEST_ONLY, matching automationSettingsDefaults.
INSERT OR IGNORE INTO project_automation_settings (project_id, created_at, updated_at)
SELECT id, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM projects;

CREATE TABLE automation_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'DISCOVER_CODEX_THREADS',
    'SYNC_SESSION_TRANSCRIPT',
    'DISCOVER_PROJECT_SOURCES',
    'SYNC_CONTEXT_SOURCE',
    'EXTRACT_EVIDENCE_CONTEXT',
    'RECONCILE_EXTRACTION_CANDIDATES'
  )),
  project_id TEXT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED')),
  available_at INTEGER NOT NULL,
  started_at INTEGER NULL,
  ended_at INTEGER NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 4,
  failure_code TEXT NULL,
  failure_message TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_automation_jobs_due ON automation_jobs(status, available_at);
CREATE INDEX idx_automation_jobs_project ON automation_jobs(project_id, kind, created_at);
CREATE INDEX idx_automation_jobs_session ON automation_jobs(session_id, kind);

-- A given idempotency key may only have one non-terminal job. Once the job reaches
-- SUCCEEDED/FAILED/CANCELED the key is free again, which is what lets a time-bucketed
-- recurring key be re-enqueued for the next cycle.
CREATE UNIQUE INDEX idx_automation_jobs_active_key
  ON automation_jobs(idempotency_key)
  WHERE status IN ('QUEUED', 'RUNNING');

CREATE TABLE automation_job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('STARTED', 'SUCCEEDED', 'FAILED', 'CANCELED')),
  failure_code TEXT NULL,
  failure_message TEXT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NULL
);

CREATE INDEX idx_automation_job_attempts_job ON automation_job_attempts(job_id, attempt_number);

CREATE TABLE extraction_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_evidence_id TEXT NULL REFERENCES evidence_snapshots(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('RESUME_CAPSULE', 'CONTEXT_ITEM', 'DECISION', 'WORK_ITEM')),
  fingerprint TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'SUPERSEDED')),
  extractor_id TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  target_resource_type TEXT NULL,
  target_resource_id TEXT NULL,
  reviewed_at INTEGER NULL,
  superseded_by_id TEXT NULL REFERENCES extraction_candidates(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_extraction_candidates_review ON extraction_candidates(project_id, status, updated_at);
CREATE INDEX idx_extraction_candidates_session ON extraction_candidates(session_id, kind, updated_at);

-- One active candidate per (project, kind, fingerprint): repeated evidence for the same
-- conclusion appends provenance instead of creating a duplicate row. REJECTED and
-- SUPERSEDED rows stay behind as history and do not block a fresh candidate.
CREATE UNIQUE INDEX idx_extraction_candidates_active_fingerprint
  ON extraction_candidates(project_id, kind, fingerprint)
  WHERE status IN ('PENDING', 'ACCEPTED');

CREATE TABLE extraction_candidate_evidence (
  candidate_id TEXT NOT NULL REFERENCES extraction_candidates(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence_snapshots(id) ON DELETE RESTRICT,
  link_reason TEXT NOT NULL DEFAULT 'SOURCE',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (candidate_id, evidence_id)
);

CREATE INDEX idx_extraction_candidate_evidence_evidence ON extraction_candidate_evidence(evidence_id);
