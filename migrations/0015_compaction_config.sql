-- API-version semantic compaction configuration.
--
-- Non-secret configuration only. The API keys themselves never live in the database:
-- this column stores endpoints, models, budgets, thresholds and switches plus a
-- `keyConfigured` flag and a masked `keyHint` (last 4 characters). Real keys are kept in a
-- local-only, gitignored secret file under the data directory (see CompactionSecretStore).
ALTER TABLE settings ADD COLUMN compaction_config_json TEXT NOT NULL DEFAULT '{}';
