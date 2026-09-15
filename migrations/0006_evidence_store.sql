ALTER TABLE evidence_snapshots ADD COLUMN storage_ref TEXT NULL;
ALTER TABLE evidence_snapshots ADD COLUMN size_bytes INTEGER NULL;

CREATE UNIQUE INDEX idx_evidence_snapshots_storage_ref ON evidence_snapshots(storage_ref) WHERE storage_ref IS NOT NULL;
