import type { AgentTranscriptEvent } from "./agent-adapter.js";

/**
 * Ports for the optional fidelity-preserving compaction layer that sits between immutable
 * Evidence and semantic extraction.
 *
 * Design: docs/2026-09-20-contextos-jev-compaction-integration-design.md (Phase C1)
 *
 * Compaction only deletes or truncates; it never rewrites, summarises or invents content.
 * Extraction is the layer that produces meaning, and the two must not be merged.
 *
 * This module is deliberately free of any dependency on a provider library: the ContextOS
 * adapter converts to and from the neutral shapes below, and a provider that bridges to a
 * third-party library performs that mapping inside its own adapter.
 */

/** Stable version of the sanitizer rules, recorded on derived artifacts. */
export const transcriptSanitizerVersion = "contextos-transcript-sanitizer.v1";

export type SanitizedTranscript = {
  events: AgentTranscriptEvent[];
  /** Ordinals dropped as known system injections, ascending. */
  removedOrdinals: number[];
  sanitizerVersion: string;
};

export interface TranscriptSanitizer {
  readonly version: string;
  sanitize(events: readonly AgentTranscriptEvent[]): SanitizedTranscript;
}

export type CompactionRole = "user" | "assistant";

export type CompactionToolUse = {
  /** Null when the transcript did not identify the invocation; never eligible for compaction. */
  callId: string | null;
  name: string;
  /** Parsed tool input, or `{ raw }` when the transcript only carried text. */
  input: Record<string, unknown>;
  /**
   * The exact input text the transcript carried. Kept so a round trip through compaction
   * reproduces the original bytes instead of a re-serialisation.
   */
  sourceText?: string;
};

export type CompactionToolResult = {
  callId: string | null;
  text: string;
  /**
   * Three-state outcome of the invocation:
   * - `true`: confirmed failure — keep verbatim.
   * - `false`: confirmed success — may be compacted.
   * - `undefined`: unknown, because the transcript carries no signal — keep verbatim.
   * Compaction may only shorten a result whose outcome is confirmed successful.
   */
  isError?: boolean;
};

/**
 * Everything needed to rebuild the source event, so `toEvents` is lossless.
 * Only the content fields live outside the origin: those are what compaction may change.
 */
export type CompactionMessageOrigin = {
  ordinal: number;
  timestamp?: string;
  kind: AgentTranscriptEvent["kind"];
  role?: AgentTranscriptEvent["role"];
  name?: string;
  callId?: string;
  truncated?: boolean;
};

export type CompactionMessage = {
  role: CompactionRole;
  text: string;
  toolUses: CompactionToolUse[];
  toolResults: CompactionToolResult[];
  origin: CompactionMessageOrigin;
};

export type CompactionOptions = {
  /** Newest real messages never touched; the first real message is always pinned. */
  preserveRecentMessages: number;
  /** A paired, non-pinned tool result longer than this may be truncated. */
  maxToolResultChars: number;
  /** Characters of the original result text kept in front of the truncation notice. */
  truncateHeadChars: number;
};

export type CompactionAction = "KEEP" | "TRUNCATE_RESULT";

export type CompactionDecisionReason =
  | "PINNED"
  | "BELOW_THRESHOLD"
  | "ERROR_RESULT"
  | "UNKNOWN_OUTCOME"
  | "UNPAIRED"
  | "DUPLICATE_CALL_ID"
  | "MISSING_CALL_ID"
  | "TRUNCATED";

export type CompactionDecision = {
  callId: string | null;
  ordinal: number | null;
  action: CompactionAction;
  reason: CompactionDecisionReason;
  charsBefore: number;
  charsAfter: number;
};

export type CompactionStats = {
  messagesBefore: number;
  messagesAfter: number;
  charsBefore: number;
  charsAfter: number;
  /** Calls with a unique id present on both a call and a result. */
  pairedCalls: number;
  truncatedResults: number;
  pinnedMessages: number;
};

export type CompactionOutput = {
  providerId: string;
  providerVersion: string;
  messages: CompactionMessage[];
  decisions: CompactionDecision[];
  stats: CompactionStats;
};

export type CompactionInput = {
  messages: readonly CompactionMessage[];
  options?: CompactionOptions;
};

export interface TranscriptCompactionProvider {
  readonly id: string;
  readonly version: string;
  compact(input: CompactionInput): Promise<CompactionOutput>;
}

/**
 * Contract invariant for a compaction result: a tool result may only disappear together with
 * the call it belongs to. Results whose call was never present in the input are pass-through
 * data — the transcript already had them unpaired — and are not reported.
 *
 * Lives here rather than in an implementation so every provider can assert the same invariant.
 */
export function findDanglingToolResults(
  input: readonly CompactionMessage[],
  output: readonly CompactionMessage[]
): string[] {
  const inputCallIds = collectCallIds(input);
  const outputCallIds = collectCallIds(output);
  const dangling = new Set<string>();

  for (const message of output) {
    for (const result of message.toolResults) {
      if (result.callId === null) continue;
      if (inputCallIds.has(result.callId) && !outputCallIds.has(result.callId)) dangling.add(result.callId);
    }
  }

  return [...dangling].sort();
}

function collectCallIds(messages: readonly CompactionMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const use of message.toolUses) if (use.callId !== null) ids.add(use.callId);
  }
  return ids;
}
