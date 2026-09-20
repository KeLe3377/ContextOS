import {
  findDanglingToolResults,
  type CompactionDecision,
  type CompactionDecisionReason,
  type CompactionInput,
  type CompactionMessage,
  type CompactionOptions,
  type CompactionOutput,
  type CompactionStats,
  type CompactionToolResult,
  type TranscriptCompactionProvider
} from "../../../application/src/ports/transcript-compaction.js";
import { ContextOsError } from "../../../shared/src/errors.js";

/**
 * The conservative, fully local compaction provider.
 *
 * Phase C1 deliberately implements the narrowest possible policy: it never removes a tool call,
 * never removes a message and never writes a summary. The only thing it may do is truncate the
 * text of a tool result that is paired, outside the pinned window, longer than the threshold and
 * not an error — and even then the notice it leaves behind says exactly how much was removed and
 * that the tool can be re-run.
 *
 * It reads no environment variable, no database and no file system, and it is a pure function of
 * its input: the same messages and options always produce a deeply equal result.
 *
 * Design: docs/2026-09-20-contextos-jev-compaction-integration-design.md §8.2, Phase C1
 */

export const deterministicCompactionProviderId = "deterministic";
export const deterministicCompactionProviderVersion = "contextos-deterministic-compaction.v1";

/** Fixed marker placed in every truncated result, so a reader can always tell what happened. */
export const compactionTruncationMarker = "[contextos-compaction]";

export const defaultCompactionOptions: CompactionOptions = {
  preserveRecentMessages: 6,
  maxToolResultChars: 4_000,
  truncateHeadChars: 300
};

export class DeterministicCompactionProvider implements TranscriptCompactionProvider {
  readonly id = deterministicCompactionProviderId;
  readonly version = deterministicCompactionProviderVersion;

  constructor(private readonly defaults: Partial<CompactionOptions> = {}) {}

  async compact(input: CompactionInput): Promise<CompactionOutput> {
    const options: CompactionOptions = { ...defaultCompactionOptions, ...this.defaults, ...input.options };
    const messages = input.messages;
    const pinned = pinnedOrdinals(messages, options.preserveRecentMessages);
    const pairing = pairToolCalls(messages);

    const decisions: CompactionDecision[] = [];
    const output: CompactionMessage[] = [];
    let truncatedResults = 0;

    for (const message of messages) {
      const use = message.toolUses[0];
      const result = message.toolResults[0];
      const ordinal = message.origin.ordinal;

      if (use) {
        // C1 never removes a call, so the decision records why it was left alone.
        decisions.push({
          callId: use.callId,
          ordinal,
          action: "KEEP",
          reason: unpairedReason(use.callId, pairing),
          charsBefore: 0,
          charsAfter: 0
        });
      }

      if (!result) {
        output.push(message);
        continue;
      }

      const outcome = decideResult(result, ordinal, pairing, pinned, options);
      decisions.push(outcome.decision);

      if (outcome.decision.action === "TRUNCATE_RESULT") {
        truncatedResults += 1;
        output.push({ ...message, toolResults: [{ ...result, text: outcome.text }] });
        continue;
      }
      output.push(message);
    }

    const dangling = findDanglingToolResults(messages, output);
    if (dangling.length > 0) {
      throw new ContextOsError("INTERNAL", "Compaction produced a tool result without its call", { callIds: dangling });
    }

    const stats: CompactionStats = {
      messagesBefore: messages.length,
      messagesAfter: output.length,
      charsBefore: messages.reduce((sum, message) => sum + messageChars(message), 0),
      charsAfter: output.reduce((sum, message) => sum + messageChars(message), 0),
      pairedCalls: pairing.paired.size,
      truncatedResults,
      pinnedMessages: pinned.size
    };

    return {
      providerId: this.id,
      providerVersion: this.version,
      messages: output,
      decisions,
      stats
    };
  }
}

type CallPairing = {
  /** callIds with exactly one call and exactly one result. */
  paired: Set<string>;
  /** callIds that appear more than once on either side, so their pairing is ambiguous. */
  duplicated: Set<string>;
};

function pairToolCalls(messages: readonly CompactionMessage[]): CallPairing {
  const callCounts = new Map<string, number>();
  const resultCounts = new Map<string, number>();

  for (const message of messages) {
    for (const use of message.toolUses) {
      if (use.callId === null) continue;
      callCounts.set(use.callId, (callCounts.get(use.callId) ?? 0) + 1);
    }
    for (const result of message.toolResults) {
      if (result.callId === null) continue;
      resultCounts.set(result.callId, (resultCounts.get(result.callId) ?? 0) + 1);
    }
  }

  const paired = new Set<string>();
  const duplicated = new Set<string>();
  for (const [callId, callCount] of callCounts) {
    const resultCount = resultCounts.get(callId) ?? 0;
    if (callCount > 1 || resultCount > 1) duplicated.add(callId);
    else if (resultCount === 1) paired.add(callId);
  }
  for (const [callId, resultCount] of resultCounts) {
    if (resultCount > 1) duplicated.add(callId);
  }

  return { paired, duplicated };
}

function unpairedReason(callId: string | null, pairing: CallPairing): CompactionDecisionReason {
  if (callId === null) return "MISSING_CALL_ID";
  if (pairing.duplicated.has(callId)) return "DUPLICATE_CALL_ID";
  return pairing.paired.has(callId) ? "BELOW_THRESHOLD" : "UNPAIRED";
}

function decideResult(
  result: CompactionToolResult,
  ordinal: number,
  pairing: CallPairing,
  pinned: ReadonlySet<number>,
  options: CompactionOptions
): { decision: CompactionDecision; text: string } {
  const charsBefore = result.text.length;
  const keep = (reason: CompactionDecisionReason): { decision: CompactionDecision; text: string } => ({
    decision: { callId: result.callId, ordinal, action: "KEEP", reason, charsBefore, charsAfter: charsBefore },
    text: result.text
  });

  if (result.callId === null) return keep("MISSING_CALL_ID");
  if (pairing.duplicated.has(result.callId)) return keep("DUPLICATE_CALL_ID");
  if (!pairing.paired.has(result.callId)) return keep("UNPAIRED");
  if (pinned.has(ordinal)) return keep("PINNED");
  // Outcome is three-state. Only a confirmed success may be shortened: a confirmed failure is
  // exactly the evidence a later step needs, and an unknown outcome means the transcript carried
  // no signal, so the conservative choice is to keep the text whole.
  if (result.isError !== false) return keep(result.isError === true ? "ERROR_RESULT" : "UNKNOWN_OUTCOME");
  if (charsBefore <= options.maxToolResultChars) return keep("BELOW_THRESHOLD");

  const headChars = Math.min(Math.max(0, options.truncateHeadChars), charsBefore);
  if (headChars >= charsBefore) return keep("BELOW_THRESHOLD");

  const text = truncateResultText(result.text, headChars);
  return {
    decision: {
      callId: result.callId,
      ordinal,
      action: "TRUNCATE_RESULT",
      reason: "TRUNCATED",
      charsBefore,
      charsAfter: text.length
    },
    text
  };
}

function truncateResultText(text: string, headChars: number): string {
  const head = text.slice(0, headChars);
  return `${head}\n${truncationNotice(text.length, text.length - head.length)}`;
}

/**
 * The notice left in place of removed text. It always states how much was removed, how long the
 * original was, and that the tool can be re-run to get it back.
 */
export function truncationNotice(originalChars: number, removedChars: number): string {
  return `${compactionTruncationMarker} truncated ${removedChars} of ${originalChars} chars of this tool result; re-run the tool to get the full output again`;
}

function pinnedOrdinals(messages: readonly CompactionMessage[], preserveRecentMessages: number): Set<number> {
  const real = messages
    .filter((message) => message.origin.kind === "message" && message.text.trim().length > 0)
    .map((message) => message.origin.ordinal);

  const pinned = new Set<number>();
  if (real.length === 0) return pinned;

  // The first real turn is the session's premise and is always kept.
  pinned.add(real[0]!);

  const recent = real.slice(-Math.max(0, Math.floor(preserveRecentMessages)));
  for (const ordinal of recent) pinned.add(ordinal);

  // Tool work that happened after the newest pinned turn is still in flight, so it is pinned too.
  const anchor = recent.at(-1);
  if (anchor !== undefined) {
    for (const message of messages) {
      if (message.origin.kind === "message") continue;
      if (message.origin.ordinal > anchor) pinned.add(message.origin.ordinal);
    }
  }

  return pinned;
}

function messageChars(message: CompactionMessage): number {
  let total = message.text.length;
  for (const use of message.toolUses) total += (use.sourceText ?? JSON.stringify(use.input)).length;
  for (const result of message.toolResults) total += result.text.length;
  return total;
}
