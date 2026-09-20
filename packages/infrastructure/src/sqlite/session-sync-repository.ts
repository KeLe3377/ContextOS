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

  /**
   * The commit boundary for automatic transcript ingestion.
   *
   * The Evidence Snapshot row, the reader offset and the derived follow-up job must become
   * visible together. Advancing the offset on its own would be lossy: a crash right after would
   * leave the reader past events that were never captured as Evidence, and nothing could ever
   * recover them because the transcript is only read forward from the stored offset.
   *
   * Nested repository calls join this transaction, so the whole unit either commits or rolls
   * back as one.
   */
  runIngestionTransaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  get(sessionId: string): SessionSyncStateRow | null {
    return (this.db.prepare("SELECT * FROM session_sync_state WHERE session_id = ?").get(sessionId) as SessionSyncStateRow | undefined) ?? null;
  }

  list(): SessionSyncStateRow[] {
    return this.db.prepare("SELECT * FROM session_sync_state ORDER BY updated_at DESC").all() as SessionSyncStateRow[];
  }

  /**
   * WATCHING sessions whose last successful sync is older than their Project's poll interval.
   *
   * The cadence comes from `project_automation_settings`, never from browser state, and OFF
   * Projects are excluded so switching automation off also stops background polling.
   */
  listDueForSync(input: { now: number; defaultPollIntervalMs: number; limit?: number }): SessionSyncStateRow[] {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    return this.db.prepare(
      `SELECT state.*
         FROM session_sync_state state
         JOIN sessions ON sessions.id = state.session_id
         LEFT JOIN project_automation_settings settings ON settings.project_id = sessions.project_id
        WHERE state.status = 'WATCHING'
          AND COALESCE(settings.mode, 'SUGGEST_ONLY') <> 'OFF'
          AND (
            state.last_synced_at IS NULL
            OR CAST(strftime('%s', state.last_synced_at) AS INTEGER) * 1000
               <= ? - COALESCE(settings.poll_interval_ms, ?)
          )
        ORDER BY (state.last_synced_at IS NULL) DESC, state.last_synced_at ASC, state.session_id ASC
        LIMIT ?`
    ).all(input.now, input.defaultPollIntervalMs, limit) as SessionSyncStateRow[];
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
