-- Compaction stage of the zero-input pipeline:
--   * widens the automation job kinds with COMPACT_EVIDENCE
--   * adds compaction_artifacts, the versioned derived products of immutable Evidence
--
-- 0012 itself is left untouched: SQLite cannot alter a CHECK constraint in place, so the job
-- table is rebuilt below following the prescribed order, with its child table carried across so
-- no attempt row is lost to the implicit DELETE that a parent DROP performs.

-- 1. Stash the attempt rows and drop the child first, so nothing references the parent.
CREATE TABLE automation_job_attempts_stash (
  id TEXT,
  job_id TEXT,
  attempt_number INTEGER,
  status TEXT,
  failure_code TEXT,
  failure_message TEXT,
  started_at INTEGER,
  ended_at INTEGER
);

INSERT INTO automation_job_attempts_stash
  SELECT id, job_id, attempt_number, status, failure_code, failure_message, started_at, ended_at
  FROM automation_job_attempts;

DROP TABLE automation_job_attempts;

-- 2. Rebuild the job table with the widened kind list, preserving every column and row.
CREATE TABLE automation_jobs_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'DISCOVER_CODEX_THREADS',
    'SYNC_SESSION_TRANSCRIPT',
    'DISCOVER_PROJECT_SOURCES',
    'SYNC_CONTEXT_SOURCE',
    'COMPACT_EVIDENCE',
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

INSERT INTO automation_jobs_new
  SELECT id, kind, project_id, session_id, resource_type, resource_id, payload_json, idempotency_key,
         status, available_at, started_at, ended_at, attempts, max_attempts, failure_code,
         failure_message, created_at, updated_at, revision
  FROM automation_jobs;

DROP TABLE automation_jobs;

ALTER TABLE automation_jobs_new RENAME TO automation_jobs;

CREATE INDEX idx_automation_jobs_due ON automation_jobs(status, available_at);
CREATE INDEX idx_automation_jobs_project ON automation_jobs(project_id, kind, created_at);
CREATE INDEX idx_automation_jobs_session ON automation_jobs(session_id, kind);
-- Still one non-terminal job per idempotency key.
CREATE UNIQUE INDEX idx_automation_jobs_active_key
  ON automation_jobs(idempotency_key)
  WHERE status IN ('QUEUED', 'RUNNING');

-- 3. Restore the child table against the rebuilt parent.
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

INSERT INTO automation_job_attempts
  SELECT id, job_id, attempt_number, status, failure_code, failure_message, started_at, ended_at
  FROM automation_job_attempts_stash;

DROP TABLE automation_job_attempts_stash;

CREATE INDEX idx_automation_job_attempts_job ON automation_job_attempts(job_id, attempt_number);

-- Compaction artifacts: versioned derived products of immutable Evidence Snapshots.
--
-- Kept in their own table on purpose. A compaction result must never be written back into the
-- source Evidence metadata: Evidence is the original fact, while an artifact is a rebuildable
-- interpretation of it.
CREATE TABLE compaction_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_evidence_id TEXT NOT NULL REFERENCES evidence_snapshots(id) ON DELETE RESTRICT,
  source_content_hash TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_version TEXT NOT NULL,
  sanitizer_version TEXT NOT NULL,
  options_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SUCCEEDED', 'FALLBACK')),
  events_json TEXT NOT NULL,
  decisions_json TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  failure_code TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

-- The same input under the same configuration is computed once and reused.
CREATE UNIQUE INDEX idx_compaction_artifacts_identity
  ON compaction_artifacts(source_content_hash, provider_id, provider_version, sanitizer_version, options_hash);

CREATE INDEX idx_compaction_artifacts_evidence ON compaction_artifacts(source_evidence_id, created_at);
CREATE INDEX idx_compaction_artifacts_project ON compaction_artifacts(project_id, created_at);
