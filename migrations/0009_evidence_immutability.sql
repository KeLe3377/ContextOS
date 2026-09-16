CREATE TRIGGER evidence_snapshots_prevent_update
BEFORE UPDATE ON evidence_snapshots
BEGIN
  SELECT RAISE(ABORT, 'Evidence Snapshots are immutable');
END;

CREATE TRIGGER evidence_snapshots_prevent_delete
BEFORE DELETE ON evidence_snapshots
BEGIN
  SELECT RAISE(ABORT, 'Evidence Snapshots are immutable');
END;
