-- Audit and replay provenance for automatically extracted candidates.
--
-- Deliberately a generic JSON column rather than a single-purpose `source_artifact_id` foreign
-- key: a candidate may be derived from a compaction artifact today and from something else
-- later, and provenance must never become able to replace the original Evidence as the
-- candidate's source of truth. `source_evidence_id` stays the authoritative link.
ALTER TABLE extraction_candidates ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}';
