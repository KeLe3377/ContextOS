import type { Database } from "better-sqlite3";
import type { SessionSyncStatus } from "../../../contracts/src/sessions.js";

export type SessionSyncStateRow = {
  session_id: string;
  adapter_id: string;
  external_session_id: string | null;
  transcript_path: string;
  byte_offset: number;
  events_ingested: number;
  last_event_at: string | null;
  last_synced_at: string | null;
  status: SessionSyncStatus;
  last_error: string | null;
  updated_at: string;
};

export type SessionSyncStateUpsert = {
  sessionId: string;
  adapterId: string;
  externalSessionId: string | null;
  transcriptPath: string;
  byteOffset: number;
  eventsIngested: number;
  lastEventAt: string | null;
  lastSyncedAt: string | null;
  status: SessionSyncStatus;
  lastError: string | null;
  updatedAt: string;
};

export class SqliteSessionSyncRepository {
  constructor(private readonly db: Database) {}

  get(sessionId: string): SessionSyncStateRow | null {
    return (this.db.prepare("SELECT * FROM session_sync_state WHERE session_id = ?").get(sessionId) as SessionSyncStateRow | undefined) ?? null;
  }

  list(): SessionSyncStateRow[] {
    return this.db.prepare("SELECT * FROM session_sync_state ORDER BY updated_at DESC").all() as SessionSyncStateRow[];
  }

  upsert(state: SessionSyncStateUpsert): SessionSyncStateRow {
    this.db.prepare(
      `INSERT INTO session_sync_state
        (session_id, adapter_id, external_session_id, transcript_path, byte_offset, events_ingested, last_event_at, last_synced_at, status, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
        adapter_id = excluded.adapter_id,
        external_session_id = excluded.external_session_id,
        transcript_path = excluded.transcript_path,
        byte_offset = excluded.byte_offset,
        events_ingested = excluded.events_ingested,
        last_event_at = excluded.last_event_at,
        last_synced_at = excluded.last_synced_at,
        status = excluded.status,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at`
    ).run(
      state.sessionId,
      state.adapterId,
      state.externalSessionId,
      state.transcriptPath,
      state.byteOffset,
      state.eventsIngested,
      state.lastEventAt,
      state.lastSyncedAt,
      state.status,
      state.lastError,
      state.updatedAt
    );
    return this.get(state.sessionId)!;
  }

  remove(sessionId: string): void {
    this.db.prepare("DELETE FROM session_sync_state WHERE session_id = ?").run(sessionId);
  }
}
