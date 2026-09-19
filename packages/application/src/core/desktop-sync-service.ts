import { statSync } from "node:fs";
import type { AgentAdapter } from "../ports/agent-adapter.js";
import type { SessionSyncBindInput, SessionSyncResultDto, SessionSyncStateDto } from "../../../contracts/src/sessions.js";
import type { AgentAdapterRegistry } from "../../../infrastructure/src/adapters/registry.js";
import type { CodexTranscriptTailer } from "../../../infrastructure/src/adapters/codex-transcript-tailer.js";
import type { SqliteSessionRepository } from "../../../infrastructure/src/sqlite/core-repositories.js";
import type { SessionSyncStateRow, SqliteSessionSyncRepository } from "../../../infrastructure/src/sqlite/session-sync-repository.js";
import { nowMs } from "../../../shared/src/clock.js";
import { ContextOsError } from "../../../shared/src/errors.js";

export type DesktopSyncServiceOptions = {
  sessions: SqliteSessionRepository;
  sync: SqliteSessionSyncRepository;
  adapters: AgentAdapterRegistry;
  tailer: CodexTranscriptTailer;
};

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
    return this.status(sessionId);
  }

  sync(sessionId: string): SessionSyncResultDto {
    const state = this.options.sync.get(sessionId);
    if (!state) {
      throw new ContextOsError("NOT_FOUND", "Session is not bound to a transcript", { sessionId });
    }
    const adapter = this.options.adapters.get(state.adapter_id);
    if (!adapter?.parseTranscriptRows) {
      throw new ContextOsError("INVALID_ARGUMENT", "Agent adapter cannot parse transcript rows", { adapterId: state.adapter_id });
    }

    let result;
    try {
      result = this.options.tailer.read({ path: state.transcript_path, offset: state.byte_offset });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to read transcript";
      this.options.sync.upsert({ ...rowToUpsert(state), status: "ERROR", lastError: message, updatedAt: isoNow() });
      return { ...this.status(sessionId), newEvents: 0, newEventTimestamps: 0, partialLine: false, resetReason: null, events: [] };
    }

    const lines = result.rows.map((row) => row.line);
    const events = adapter.parseTranscriptRows({ rows: lines, startOrdinal: state.events_ingested });
    const timestamped = events.filter((event) => Boolean(event.timestamp));
    const lastEventAt = timestamped.at(-1)?.timestamp ?? state.last_event_at;

    this.options.sync.upsert({
      ...rowToUpsert(state),
      byteOffset: result.nextOffset,
      eventsIngested: state.events_ingested + events.length,
      lastEventAt,
      lastSyncedAt: isoNow(),
      status: "WATCHING",
      lastError: result.resetReason ? `Transcript offset reset: ${result.resetReason}` : null,
      updatedAt: isoNow()
    });

    return {
      ...this.status(sessionId),
      newEvents: events.length,
      newEventTimestamps: timestamped.length,
      partialLine: result.partialLine,
      resetReason: result.resetReason,
      events: events.map((event) => ({
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
}

function capabilitiesFor(adapter: AgentAdapter | null, externalSessionId: string | null) {
  return {
    // Reading the agent's own rollout file incrementally is supported.
    desktopReadSync: Boolean(adapter?.resolveTranscriptPath && adapter?.parseTranscriptRows),
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
