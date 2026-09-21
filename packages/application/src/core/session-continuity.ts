import type { AgentTranscriptEvent } from "../ports/agent-adapter.js";
import { decodeTranscriptEvents } from "./transcript-event-codec.js";
import { PrefixTranscriptSanitizer } from "./transcript-sanitizer.js";

/**
 * The bounded "session continuity" excerpt that replaces the deferred
 * Evidence -> Compaction Artifact -> Extractor -> Candidate -> Review pipeline as the thing a
 * Continue has to carry back into the same Codex session.
 *
 * It is deliberately not semantic long-term memory: it is a deterministic, character-bounded
 * transcript excerpt rebuilt from canonical Evidence every time a sync batch is captured. It
 * reads events through the existing codec and sanitizer, never calls a model, and never touches
 * the filesystem or a clock — identical input always produces an identical excerpt.
 */

/** Hard character budget for the excerpt. */
export const sessionContinuityMaxChars = 12_000;

/** Character budget for the capsule `nextAction`. */
export const sessionContinuityNextActionMaxChars = 500;

const summaryMaxChars = 500;

/** Shown when a Session has captured no transcript yet, so the capsule is never blank. */
const emptyContinuitySummary = "No captured session continuity yet.";

const truncationMarker = "...[truncated]";

export type SessionContinuityEvidence = {
  id: string;
  /** Canonical, integrity-verified transcript blob, exactly as the codec wrote it. */
  canonicalText: string;
};

export type SessionContinuityInput = {
  /** Ordered oldest batch first; the order is what makes source ids and excerpt order stable. */
  evidence: readonly SessionContinuityEvidence[];
  maxChars?: number;
};

export type SessionContinuity = {
  summary: string;
  nextAction: string | null;
  contextText: string;
  evidenceSnapshotIds: string[];
};

/**
 * The narrow port AutomationService uses to persist an excerpt.
 *
 * It is a writer and nothing else: the service must not reach for the runtime repository, and
 * the implementation is expected to run inside the caller's transaction so continuity, Evidence
 * and the reader offset either all land or all roll back.
 */
export type SessionContinuityWriter = {
  write(input: { sessionId: string } & SessionContinuity): void;
};

type ContinuityEntry = {
  /** Chronological position across every batch; the excerpt is re-emitted in this order. */
  order: number;
  line: string;
  /** Successful tool output and tool calls are the first thing dropped when space runs out. */
  droppable: boolean;
};

export function buildSessionContinuity(input: SessionContinuityInput): SessionContinuity {
  const maxChars = Math.max(0, input.maxChars ?? sessionContinuityMaxChars);
  const sanitizer = new PrefixTranscriptSanitizer();
  const entries: ContinuityEntry[] = [];
  const evidenceSnapshotIds: string[] = [];
  const events: AgentTranscriptEvent[] = [];
  let order = 0;

  for (const snapshot of input.evidence) {
    if (!evidenceSnapshotIds.includes(snapshot.id)) evidenceSnapshotIds.push(snapshot.id);
    const decoded = decodeTranscriptEvents(snapshot.canonicalText);
    for (const event of sanitizer.sanitize(decoded.events).events) {
      events.push(event);
      const line = renderLine(event);
      if (!line) continue;
      entries.push({ order, line, droppable: isDroppable(event) });
      order += 1;
    }
  }

  return {
    summary: buildSummary(events),
    nextAction: buildNextAction(events),
    contextText: selectExcerpt(entries, maxChars),
    evidenceSnapshotIds
  };
}

/**
 * Selects what fits, newest first, then restores chronological order.
 *
 * Two passes with different rules: a protected entry (conversation, summary, failed or unknown
 * tool result) may be truncated to whatever is left, because losing it entirely would lose the
 * thread; a droppable entry (tool call, successful tool output) is only taken when it fits
 * whole, and selection stops at the first one that does not — exactly the
 * "fill until it no longer fits" rule the rest of the codebase uses.
 */
function selectExcerpt(entries: readonly ContinuityEntry[], maxChars: number): string {
  const chosen: ContinuityEntry[] = [];
  let used = 0;

  const take = (entry: ContinuityEntry, truncate: boolean): boolean => {
    const cost = entry.line.length + 1;
    if (cost <= maxChars - used) {
      chosen.push(entry);
      used += cost;
      return true;
    }
    if (!truncate) return false;
    const remaining = maxChars - used;
    if (remaining <= 0) return false;
    const line = fitLine(entry.line, remaining);
    chosen.push({ ...entry, line });
    used += line.length + 1;
    return false;
  };

  const byNewest = [...entries].reverse();
  for (const entry of byNewest) {
    if (entry.droppable) continue;
    if (!take(entry, true)) break;
  }
  for (const entry of byNewest) {
    if (!entry.droppable) continue;
    if (!take(entry, false)) break;
  }

  return chosen
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.line)
    .join("\n");
}

function fitLine(line: string, remaining: number): string {
  if (line.length <= remaining) return line;
  if (remaining <= truncationMarker.length) return line.slice(0, remaining);
  return `${line.slice(0, remaining - truncationMarker.length)}${truncationMarker}`;
}

/**
 * A tool result is protected unless the transcript positively reported success. Absent outcome
 * means unknown, and an unknown or failed result is exactly what a resume must not drop.
 */
function isDroppable(event: AgentTranscriptEvent): boolean {
  if (event.kind === "tool_call") return true;
  if (event.kind !== "tool_result") return false;
  return event.isError === false;
}

function renderLine(event: AgentTranscriptEvent): string | null {
  const text = (event.text ?? "").trim();
  if (!text) return null;
  return `${labelFor(event)}: ${text}`;
}

function labelFor(event: AgentTranscriptEvent): string {
  if (event.kind === "message") return event.role ?? "message";
  if (event.kind === "summary") return "summary";
  const name = event.name ?? event.callId ?? "unknown";
  if (event.kind === "tool_call") return `tool-call ${name}`;
  return event.isError === true ? `tool-error ${name}` : `tool-result ${name}`;
}

/** Last assistant word wins; a summary event or the last question is used only as a fallback. */
function buildSummary(events: readonly AgentTranscriptEvent[]): string {
  const assistant = lastText(events.filter((event) => event.kind === "message" && event.role === "assistant"));
  if (assistant) return bound(assistant, summaryMaxChars);
  const summary = lastText(events.filter((event) => event.kind === "summary"));
  if (summary) return bound(summary, summaryMaxChars);
  const user = lastText(events.filter((event) => event.kind === "message" && event.role === "user"));
  if (user) return bound(user, summaryMaxChars);
  return emptyContinuitySummary;
}

function buildNextAction(events: readonly AgentTranscriptEvent[]): string | null {
  const user = lastText(events.filter((event) => event.kind === "message" && event.role === "user"));
  return user ? bound(user, sessionContinuityNextActionMaxChars) : null;
}

function lastText(events: readonly AgentTranscriptEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const text = (events[index]!.text ?? "").trim();
    if (text) return text;
  }
  return null;
}

function bound(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
