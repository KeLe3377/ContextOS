import type { AgentTranscriptEvent } from "../../ports/agent-adapter.js";
import type { CompactionAction, CompactionToolPair } from "../../ports/semantic-compaction.js";

/**
 * Pairing and reconstruction helpers shared by every compaction provider.
 *
 * A `tool_call` and its `tool_result` are paired by `callId`. The reconstructed transcript is a
 * derived product: it is rebuilt from the events on demand and never written back to Evidence.
 */

export type TaggedEvent = {
  event: AgentTranscriptEvent;
  /** Evidence snapshot that carries this event, used to cite facts later. */
  evidenceId: string;
};

/** Pairs tool calls with their results by `callId`, in stream order. */
export function buildToolPairs(events: readonly TaggedEvent[], preserveRecentMessages: number): CompactionToolPair[] {
  const resultByCallId = new Map<string, { index: number; event: AgentTranscriptEvent; evidenceId: string }>();
  events.forEach((tagged, index) => {
    const { event } = tagged;
    if (event.kind === "tool_result" && event.callId && !resultByCallId.has(event.callId)) {
      resultByCallId.set(event.callId, { index, event, evidenceId: tagged.evidenceId });
    }
  });

  const pinnedFrom = events.length - Math.max(0, preserveRecentMessages);
  const pairs: CompactionToolPair[] = [];
  events.forEach((tagged, index) => {
    const { event } = tagged;
    if (event.kind !== "tool_call" || !event.callId) return;
    const result = resultByCallId.get(event.callId);
    pairs.push({
      callId: event.callId,
      tool: event.name ?? "unknown",
      inputSummary: (event.text ?? "").slice(0, 500),
      resultText: result?.event.text ?? "",
      // A missing result is "unknown", not "succeeded": the caller must keep it.
      isError: result?.event.isError === true || event.isError === true || !result,
      pinned: index >= pinnedFrom,
      callOrdinal: event.ordinal,
      resultOrdinal: result?.event.ordinal ?? event.ordinal,
      evidenceId: tagged.evidenceId
    });
  });
  return pairs;
}

/** Truncates a result to its head, keeping a marker so the reader knows it was cut. */
export function truncateResult(text: string, headChars: number): string {
  if (text.length <= headChars) return text;
  return `${text.slice(0, headChars)}...[truncated]`;
}

/**
 * Rebuilds the transcript from the decisions.
 *
 * Invariants: a `DROP` removes the call and its result together (never leaving an orphan), and a
 * `KEEP_CALL_ONLY` keeps the call with a truncated result. Evidence is untouched.
 */
export function applyDecisions(
  events: readonly TaggedEvent[],
  decisionByCallId: ReadonlyMap<string, CompactionAction>,
  truncateHeadChars: number
): TaggedEvent[] {
  const out: TaggedEvent[] = [];
  for (const tagged of events) {
    const { event } = tagged;
    const callId = event.callId;
    if (callId && (event.kind === "tool_call" || event.kind === "tool_result")) {
      const action = decisionByCallId.get(callId) ?? "KEEP_FULL";
      if (action === "DROP") continue;
      if (action === "KEEP_CALL_ONLY" && event.kind === "tool_result") {
        out.push({ ...tagged, event: { ...event, text: truncateResult(event.text ?? "", truncateHeadChars), truncated: true } });
        continue;
      }
      out.push(tagged);
      continue;
    }
    out.push(tagged);
  }
  return out;
}

/** Renders events as plain lines for the LLM prompt. Deterministic, no model, no clock. */
export function renderTranscript(events: readonly TaggedEvent[]): string {
  const lines: string[] = [];
  for (const { event, evidenceId } of events) {
    const text = (event.text ?? "").trim();
    if (!text) continue;
    lines.push(`[${evidenceId}] ${labelFor(event)}: ${text}`);
  }
  return lines.join("\n");
}

function labelFor(event: AgentTranscriptEvent): string {
  if (event.kind === "message") return event.role ?? "message";
  if (event.kind === "summary") return "summary";
  const name = event.name ?? event.callId ?? "unknown";
  if (event.kind === "tool_call") return `tool-call ${name}`;
  return event.isError === true ? `tool-error ${name}` : `tool-result ${name}`;
}
