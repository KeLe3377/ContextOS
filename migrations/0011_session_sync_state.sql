CREATE TABLE IF NOT EXISTS session_sync_state (
  session_id TEXT PRIMARY KEY,
  adapter_id TEXT NOT NULL,
  external_session_id TEXT,
  transcript_path TEXT NOT NULL,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  events_ingested INTEGER NOT NULL DEFAULT 0,
  last_event_at TEXT,
  last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'IDLE',
  last_error TEXT,
  updated_at TEXT NOT NULL
);
