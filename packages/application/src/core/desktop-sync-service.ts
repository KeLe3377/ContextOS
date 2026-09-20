import { statSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentAdapter, AgentTranscriptEvent, ExternalSessionCandidate } from "../ports/agent-adapter.js";
import type { DesktopSyncCandidate, SessionSyncBindInput, SessionSyncResultDto, SessionSyncStateDto } from "../../../contracts/src/sessions.js";
import type { AgentAdapterRegistry } from "../../../infrastructure/src/adapters/registry.js";
import type { CodexTranscriptTailer } from "../../../infrastructure/src/adapters/codex-transcript-tailer.js";
import type { SqliteSessionRepository } from "../../../infrastructure/src/sqlite/core-repositories.js";
import type { SessionSyncStateRow, SessionSyncStateUpsert, SqliteSessionSyncRepository } from "../../../infrastructure/src/sqlite/session-sync-repository.js";
import { nowMs } from "../../../shared/src/clock.js";
import { ContextOsError } from "../../../shared/src/errors.js";

export type DesktopSyncServiceOptions = {
  sessions: SqliteSessionRepository;
  sync: SqliteSessionSyncRepository;
  adapters: AgentAdapterRegistry;
  tailer: CodexTranscriptTailer;
  /**
   * Writes the external id back onto the Session row. Desktop sync alone only
   * tracks it in session_sync_state — but `continue` decides between
   * `launch` and `resume` by reading `sessions.external_session_id`, so a
   * bind that never lands on the Session row would keep starting a brand new
   * agent thread instead of resuming the same UUID.
   */
  bindExternalSession?: (input: { sessionId: string; externalSessionId: string }) => void;
  /**
   * Used to scope thread discovery to the Session's Project. Without it the
   * candidate list falls back to an unscoped (still read-only) listing.
   */
  resolveProjectRoot?: (projectId: string) => string | null;
};

/**
 * Persistence input for one ingested transcript batch. It carries the exact ordinal and byte
 * range covered by `events`, so the caller can store the batch as immutable Evidence with a
 * reproducible provenance record — without re-reading or re-parsing the rollout.
 */
export type DesktopSyncBatch = {
  sessionId: string;
  adapterId: string;
  externalSessionId: string | null;
  transcriptPath: string;
  parserVersion: string | null;
  startOrdinal: number;
  endOrdinal: number;
  startByteOffset: number;
  endByteOffset: number;
  partialLine: boolean;
  resetReason: "offset_beyond_eof" | null;
  events: AgentTranscriptEvent[];
};

/**
 * Result of reading a transcript without committing anything. The caller persists `nextState`
 * as part of whatever wider unit of work it owns.
 */
export type DesktopSyncRead = {
  state: SessionSyncStateRow;
  events: AgentTranscriptEvent[];
  /** Set when the transcript could not be read; `nextState` then carries the ERROR row. */
  readError: string | null;
  nextState: SessionSyncStateUpsert;
  partialLine: boolean;
  resetReason: "offset_beyond_eof" | null;
  /** Non-null only when the read produced events worth capturing as Evidence. */
  batch: DesktopSyncBatch | null;
};

/**
 * Thread discovery is scoped to the Project root first. Codex threads are
 * usually recorded against a parent directory (a Desktop thread opened for
 * ContextOS reports `D:\project`, not `D:\project\ContextOS`), so the parent
 * is queried too and the two result sets are merged.
 */
function candidateRoots(explicitCwd: string | undefined, projectRoot: string | null): (string | null)[] {
  if (explicitCwd) return [explicitCwd];
  if (!projectRoot) return [null];
  const parent = dirname(projectRoot);
  return parent && parent !== projectRoot ? [projectRoot, parent] : [projectRoot];
}

function isoNow(): string {
  return new Date(nowMs()).toISOString();
}

/**
 * Level A: Desktop -> ContextOS read-only sync.
 *
 * This is deliberately one-way. ContextOS only reads the agent's own rollout
 * file and records how far it has read; it never writes to the transcript.
 */
export class DesktopSyncService {
  constructor(private readonly options: DesktopSyncServiceOptions) {}

  status(sessionId: string): SessionSyncStateDto {
    const session = this.options.sessions.getByIdOrThrow(sessionId);
    const state = this.options.sync.get(sessionId);
    const adapter = this.options.adapters.get(session.agentAdapterId);

    if (!state) {
      return {
        sessionId,
        adapterId: session.agentAdapterId,
        externalSessionId: session.externalSessionId,
        transcriptPath: null,
        byteOffset: 0,
        fileSize: null,
        eventsIngested: 0,
        lastEventAt: null,
        lastSyncedAt: null,
        lagMs: null,
        status: "UNBOUND",
        lastError: null,
        capabilities: capabilitiesFor(adapter, session.externalSessionId),
        updatedAt: null
      };
    }

    const fileSize = safeFileSize(state.transcript_path);
    const lastEventMs = state.last_event_at ? Date.parse(state.last_event_at) : null;
    return {
      sessionId,
      adapterId: state.adapter_id,
      externalSessionId: state.external_session_id,
      transcriptPath: state.transcript_path,
      byteOffset: state.byte_offset,
      fileSize,
      eventsIngested: state.events_ingested,
      lastEventAt: state.last_event_at,
      lastSyncedAt: state.last_synced_at,
      lagMs: lastEventMs && Number.isFinite(lastEventMs) ? Math.max(0, nowMs() - lastEventMs) : null,
      status: state.status,
      lastError: state.last_error,
      capabilities: capabilitiesFor(adapter, state.external_session_id),
      updatedAt: state.updated_at
    };
  }

  bind(sessionId: string, input: SessionSyncBindInput = {}): SessionSyncStateDto {
    const session = this.options.sessions.getByIdOrThrow(sessionId);
    const adapter = this.options.adapters.getOrThrow(session.agentAdapterId);
    const externalSessionId = input.externalSessionId ?? session.externalSessionId;
    if (!externalSessionId) {
      throw new ContextOsError("INVALID_ARGUMENT", "Bind an external session id before enabling desktop sync", { sessionId });
    }
    if (session.externalSessionId && session.externalSessionId !== externalSessionId) {
      throw new ContextOsError("CONFLICT", "Session is already bound to a different external agent session", {
        sessionId,
        boundExternalSessionId: session.externalSessionId,
        externalSessionId
      });
    }
    if (!adapter.resolveTranscriptPath) {
      throw new ContextOsError("INVALID_ARGUMENT", "Agent adapter cannot resolve a transcript path", { adapterId: adapter.id });
    }

    const transcriptPath = input.transcriptPath ?? adapter.resolveTranscriptPath({ externalSessionId });
    if (!transcriptPath) {
      throw new ContextOsError("NOT_FOUND", "Transcript was not found for this external session", { externalSessionId });
    }

    const existing = this.options.sync.get(sessionId);
    const keepOffset = existing && existing.transcript_path === transcriptPath && input.fromBeginning !== true;
    const fileSize = safeFileSize(transcriptPath) ?? 0;
    const byteOffset = keepOffset ? existing!.byte_offset : input.fromBeginning === true ? 0 : fileSize;

    this.options.sync.upsert({
      sessionId,
      adapterId: adapter.id,
      externalSessionId,
      transcriptPath,
      byteOffset,
      eventsIngested: keepOffset ? existing!.events_ingested : 0,
      lastEventAt: keepOffset ? existing!.last_event_at : null,
      lastSyncedAt: isoNow(),
      status: "WATCHING",
      lastError: null,
      updatedAt: isoNow()
    });
    // Only fill the Session row once; it is what makes `continue` resume this
    // UUID instead of launching a fresh agent thread.
    if (!session.externalSessionId && this.options.bindExternalSession) {
      this.options.bindExternalSession({ sessionId, externalSessionId });
    }
    return this.status(sessionId);
  }

  sync(sessionId: string): SessionSyncResultDto {
    const read = this.read(sessionId);
    this.options.sync.upsert(read.nextState);
    return this.toSyncResult(sessionId, read);
  }

  /**
   * Reads and parses new transcript rows without writing anything.
   *
   * The caller owns the commit. Automatic ingestion has to persist the Evidence Snapshot, the
   * advanced offset and the derived job as one unit, so advancing the offset here would be
   * lossy — a crash in between would leave the reader past events that were never captured.
   * `nextState` is exactly what has to be persisted once the batch is durably captured.
   */
  read(sessionId: string): DesktopSyncRead {
    const state = this.options.sync.get(sessionId);
    if (!state) {
      throw new ContextOsError("NOT_FOUND", "Session is not bound to a transcript", { sessionId });
    }
    const adapter = this.options.adapters.get(state.adapter_id);
    if (!adapter?.parseTranscriptRows) {
      throw new ContextOsError("INVALID_ARGUMENT", "Agent adapter cannot parse transcript rows", { adapterId: state.adapter_id });
    }

    let tailed;
    try {
      tailed = this.options.tailer.read({ path: state.transcript_path, offset: state.byte_offset });
    } catch (error) {
      // A temporarily unreadable rollout keeps the last successful offset, so the next poll
      // retries from the same place instead of dropping or replaying events.
      const message = error instanceof Error ? error.message : "Failed to read transcript";
      return {
        state,
        events: [],
        readError: message,
        nextState: { ...rowToUpsert(state), status: "ERROR", lastError: message, updatedAt: isoNow() },
        partialLine: false,
        resetReason: null,
        batch: null
      };
    }

    // An `offset_beyond_eof` reset rewinds the reader to the start of the file, so the ordinal
    // space restarts with it. Keeping the old counter would attribute the re-read rows to
    // positions that no longer correspond to the content being read.
    const ordinalBase = tailed.resetReason ? 0 : state.events_ingested;
    const events = adapter.parseTranscriptRows({ rows: tailed.rows.map((row) => row.line), startOrdinal: ordinalBase });
    const firstRow = tailed.rows[0];
    const nextState: SessionSyncStateUpsert = {
      ...rowToUpsert(state),
      byteOffset: tailed.nextOffset,
      eventsIngested: ordinalBase + events.length,
      lastEventAt: events.filter((event) => Boolean(event.timestamp)).at(-1)?.timestamp ?? state.last_event_at,
      lastSyncedAt: isoNow(),
      status: "WATCHING",
      lastError: tailed.resetReason ? `Transcript offset reset: ${tailed.resetReason}` : null,
      updatedAt: isoNow()
    };

    return {
      state,
      events,
      readError: null,
      nextState,
      partialLine: tailed.partialLine,
      resetReason: tailed.resetReason,
      batch: events.length > 0 && firstRow
        ? {
            sessionId,
            adapterId: state.adapter_id,
            externalSessionId: state.external_session_id,
            transcriptPath: state.transcript_path,
            parserVersion: adapter.transcriptParserVersion ?? null,
            startOrdinal: ordinalBase,
            endOrdinal: ordinalBase + events.length,
            startByteOffset: firstRow.byteStart,
            endByteOffset: tailed.nextOffset,
            partialLine: tailed.partialLine,
            resetReason: tailed.resetReason,
            events
          }
        : null
    };
  }

  /** Builds the public sync result for a read whose `nextState` has already been persisted. */
  private toSyncResult(sessionId: string, read: DesktopSyncRead): SessionSyncResultDto {
    return {
      ...this.status(sessionId),
      newEvents: read.events.length,
      newEventTimestamps: read.events.filter((event) => Boolean(event.timestamp)).length,
      partialLine: read.partialLine,
      resetReason: read.resetReason,
      events: read.events.map((event) => ({
        ordinal: event.ordinal,
        timestamp: event.timestamp,
        kind: event.kind,
        role: event.role,
        text: event.text,
        name: event.name,
        callId: event.callId,
        truncated: event.truncated
      }))
    };
  }

  unbind(sessionId: string): void {
    this.options.sync.remove(sessionId);
  }

  /**
   * Level A discovery: external agent threads the user could bind to.
   *
   * Read-only, never opens or resumes a thread, so it is safe to call while
   * Codex Desktop is running. Returns an empty list when the adapter has no
   * discovery support or the agent's app-server is unavailable; the UI then
   * keeps its manual id entry path.
   */
  async listCandidates(sessionId: string, input: { cwd?: string; limit?: number } = {}): Promise<DesktopSyncCandidate[]> {
    const session = this.options.sessions.getByIdOrThrow(sessionId);
    const adapter = this.options.adapters.getOrThrow(session.agentAdapterId);
    if (!adapter.listExternalSessions) return [];

    const projectRoot = this.options.resolveProjectRoot?.(session.projectId) ?? null;
    const merged = new Map<string, ExternalSessionCandidate>();
    for (const root of candidateRoots(input.cwd, projectRoot)) {
      const found = await adapter.listExternalSessions({ cwd: root ?? undefined, limit: input.limit ?? 50 });
      for (const item of found) {
        if (!merged.has(item.externalSessionId)) merged.set(item.externalSessionId, item);
      }
    }

    const boundElsewhere = new Set(
      this.options.sync
        .list()
        .filter((row) => row.session_id !== sessionId && row.external_session_id)
        .map((row) => row.external_session_id as string)
    );

    return [...merged.values()].map((item) => ({
      ...item,
      alreadyBound: boundElsewhere.has(item.externalSessionId)
    }));
  }
}

function capabilitiesFor(adapter: AgentAdapter | null, externalSessionId: string | null) {
  return {
    // Reading the agent's own rollout file incrementally is supported.
    desktopReadSync: Boolean(adapter?.resolveTranscriptPath && adapter?.parseTranscriptRows),
    // Listing discoverable external threads (read-only app-server) is supported.
    desktopThreadDiscovery: Boolean(adapter?.listExternalSessions),
    // Starting a managed CLI turn against the same UUID is supported.
    managedCliResume: Boolean(adapter && externalSessionId),
    // Driving the open Codex Desktop task is still under investigation.
    desktopUiControl: false
  };
}

function rowToUpsert(state: SessionSyncStateRow) {
  return {
    sessionId: state.session_id,
    adapterId: state.adapter_id,
    externalSessionId: state.external_session_id,
    transcriptPath: state.transcript_path,
    byteOffset: state.byte_offset,
    eventsIngested: state.events_ingested,
    lastEventAt: state.last_event_at,
    lastSyncedAt: state.last_synced_at
  };
}

function safeFileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}
