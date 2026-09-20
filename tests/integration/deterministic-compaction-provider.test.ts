import { describe, expect, test } from "vitest";
import { ContextOsCompactionAdapter } from "../../packages/application/src/core/compaction-adapter.js";
import {
  findDanglingToolResults,
  type CompactionMessage,
  type CompactionOptions,
  type CompactionOutput
} from "../../packages/application/src/ports/transcript-compaction.js";
import type { AgentTranscriptEvent } from "../../packages/application/src/ports/agent-adapter.js";
import {
  DeterministicCompactionProvider,
  compactionTruncationMarker,
  deterministicCompactionProviderId,
  deterministicCompactionProviderVersion,
  truncationNotice
} from "../../packages/infrastructure/src/compaction/deterministic-compaction-provider.js";

const longText = "x".repeat(6_000);
const adapter = new ContextOsCompactionAdapter();
const provider = new DeterministicCompactionProvider();

/**
 * A transcript whose oversized tool result sits well before the newest turns:
 * real messages are 1, 4-9, so the newest six are 4-9 and the tail anchor is 9.
 */
function buildTranscript(overrides: { resultIsError?: boolean; tailToolCall?: boolean } = {}): AgentTranscriptEvent[] {
  const events: AgentTranscriptEvent[] = [
    { ordinal: 1, kind: "message", role: "user", text: "first turn" },
    { ordinal: 2, kind: "tool_call", name: "shell", callId: "call_1", text: '{"command":"cat big.txt"}' },
    { ordinal: 3, kind: "tool_result", callId: "call_1", text: longText, isError: overrides.resultIsError === true ? true : undefined },
    { ordinal: 4, kind: "message", role: "assistant", text: "reading" },
    { ordinal: 5, kind: "message", role: "user", text: "continue" },
    { ordinal: 6, kind: "message", role: "assistant", text: "working" },
    { ordinal: 7, kind: "message", role: "user", text: "and now" },
    { ordinal: 8, kind: "message", role: "assistant", text: "almost" },
    { ordinal: 9, kind: "message", role: "user", text: "finish" }
  ];
  if (overrides.tailToolCall) {
    events.push(
      { ordinal: 10, kind: "tool_call", name: "shell", callId: "call_tail", text: '{"command":"tail -n 5"}' },
      { ordinal: 11, kind: "tool_result", callId: "call_tail", text: longText }
    );
  }
  return events;
}

async function compact(
  events: readonly AgentTranscriptEvent[],
  options?: CompactionOptions
): Promise<{ messages: CompactionMessage[]; output: CompactionOutput }> {
  const messages = adapter.toMessages(events);
  const output = await provider.compact({ messages, options });
  return { messages, output };
}

function resultTextOf(output: CompactionOutput, ordinal: number): string {
  const message = output.messages.find((entry) => entry.origin.ordinal === ordinal);
  if (!message) throw new Error(`No output message at ordinal ${ordinal}`);
  return message.toolResults[0]?.text ?? "";
}

function decisionAt(output: CompactionOutput, ordinal: number) {
  const decision = output.decisions.find((entry) => entry.ordinal === ordinal);
  if (!decision) throw new Error(`No decision at ordinal ${ordinal}`);
  return decision;
}

describe("deterministic compaction policy", () => {
  test("truncates a paired, non-pinned, oversized tool result with an auditable notice", async () => {
    const { output } = await compact(buildTranscript());

    const text = resultTextOf(output, 3);
    expect(text.startsWith("x".repeat(300))).toBe(true);
    expect(text).toContain(compactionTruncationMarker);
    expect(text).toContain("truncated 5700 of 6000 chars of this tool result");
    expect(text).toContain("re-run the tool");
    expect(text.endsWith(truncationNotice(6_000, 5_700))).toBe(true);

    expect(decisionAt(output, 3)).toMatchObject({
      callId: "call_1",
      ordinal: 3,
      action: "TRUNCATE_RESULT",
      reason: "TRUNCATED",
      charsBefore: 6_000
    });
    expect(decisionAt(output, 3).charsAfter).toBe(text.length);
    expect(output.stats).toMatchObject({ truncatedResults: 1, pairedCalls: 1 });
  });

  test("never truncates an error result", async () => {
    const { output } = await compact(buildTranscript({ resultIsError: true }));

    expect(resultTextOf(output, 3)).toBe(longText);
    expect(decisionAt(output, 3)).toMatchObject({ action: "KEEP", reason: "ERROR_RESULT", charsBefore: 6_000, charsAfter: 6_000 });
    expect(output.stats.truncatedResults).toBe(0);
  });

  test("pins tool work that happened after the newest pinned turn", async () => {
    const { output } = await compact(buildTranscript({ tailToolCall: true }));

    // Ordinals 10 and 11 come after the anchor (9), so they are pinned even though the result
    // is oversized and paired.
    expect(resultTextOf(output, 11)).toBe(longText);
    expect(decisionAt(output, 11)).toMatchObject({ action: "KEEP", reason: "PINNED" });
    // The older result outside the window is still truncated.
    expect(decisionAt(output, 3).action).toBe("TRUNCATE_RESULT");
    expect(output.stats.pinnedMessages).toBe(9);
  });

  test("honours a smaller preserveRecentMessages window", async () => {
    const { output } = await compact(buildTranscript(), {
      preserveRecentMessages: 1,
      maxToolResultChars: 4_000,
      truncateHeadChars: 300
    });

    // Only the first turn and the newest turn are pinned.
    expect(output.stats.pinnedMessages).toBe(2);
    expect(decisionAt(output, 3).action).toBe("TRUNCATE_RESULT");
  });

  test("keeps the result when it is exactly at the threshold and truncates one character over", async () => {
    const atThreshold: AgentTranscriptEvent[] = [
      { ordinal: 1, kind: "message", role: "user", text: "first" },
      { ordinal: 2, kind: "tool_call", name: "shell", callId: "call_1", text: "{}" },
      { ordinal: 3, kind: "tool_result", callId: "call_1", text: "y".repeat(100) },
      { ordinal: 4, kind: "message", role: "assistant", text: "recent" }
    ];
    const options: CompactionOptions = { preserveRecentMessages: 1, maxToolResultChars: 100, truncateHeadChars: 50 };

    const kept = await compact(atThreshold, options);
    expect(kept.output.stats.truncatedResults).toBe(0);
    expect(decisionAt(kept.output, 3)).toMatchObject({ action: "KEEP", reason: "BELOW_THRESHOLD" });

    const overThreshold = await compact(
      atThreshold.map((event) => (event.ordinal === 3 ? { ...event, text: "y".repeat(101) } : event)),
      options
    );
    expect(overThreshold.output.stats.truncatedResults).toBe(1);
    expect(resultTextOf(overThreshold.output, 3)).toBe(`y`.repeat(50) + `\n${truncationNotice(101, 51)}`);
  });

  test("never truncates a result whose pairing is missing or ambiguous", async () => {
    const events: AgentTranscriptEvent[] = [
      { ordinal: 1, kind: "message", role: "user", text: "first" },
      { ordinal: 2, kind: "tool_result", callId: "call_orphan", text: longText },
      { ordinal: 3, kind: "tool_result", text: longText },
      { ordinal: 4, kind: "tool_call", name: "shell", callId: "call_dup", text: "{}" },
      { ordinal: 5, kind: "tool_call", name: "shell", callId: "call_dup", text: "{}" },
      { ordinal: 6, kind: "tool_result", callId: "call_dup", text: longText },
      { ordinal: 7, kind: "tool_result", callId: "call_dup", text: longText },
      { ordinal: 8, kind: "message", role: "assistant", text: "recent" }
    ];

    const { output } = await compact(events);

    expect(output.stats.truncatedResults).toBe(0);
    expect(resultTextOf(output, 2)).toBe(longText);
    expect(resultTextOf(output, 3)).toBe(longText);
    expect(resultTextOf(output, 6)).toBe(longText);
    expect(resultTextOf(output, 7)).toBe(longText);
    expect(decisionAt(output, 2).reason).toBe("UNPAIRED");
    expect(decisionAt(output, 3).reason).toBe("MISSING_CALL_ID");
    expect(decisionAt(output, 6).reason).toBe("DUPLICATE_CALL_ID");
    expect(decisionAt(output, 7).reason).toBe("DUPLICATE_CALL_ID");
    expect(output.stats.pairedCalls).toBe(0);
  });

  test("removes nothing and never rewrites text", async () => {
    const events = buildTranscript({ tailToolCall: true });
    const { messages, output } = await compact(events);

    expect(output.stats.messagesAfter).toBe(output.stats.messagesBefore);
    expect(output.messages).toHaveLength(messages.length);
    expect(output.messages.map((message) => message.origin.ordinal)).toEqual(messages.map((message) => message.origin.ordinal));

    // Every real message survives byte for byte; only the one result text changed.
    for (const original of messages) {
      const kept = output.messages.find((message) => message.origin.ordinal === original.origin.ordinal)!;
      if (original.origin.kind === "tool_result" && original.origin.ordinal === 3) continue;
      expect(kept).toEqual(original);
    }

    // Rebuilding events yields the same calls and results, only one text shortened.
    const rebuilt = adapter.toEvents(output.messages);
    expect(rebuilt).toHaveLength(events.length);
    expect(rebuilt.filter((event) => event.kind === "tool_call")).toHaveLength(2);
    expect(rebuilt.filter((event) => event.kind === "tool_result")).toHaveLength(2);
  });

  test("is deterministic across runs", async () => {
    const events = buildTranscript({ tailToolCall: true });

    const first = await compact(events);
    const second = await compact(events);

    expect(second.output).toStrictEqual(first.output);
  });

  test("reports the provider identity, decisions and stats", async () => {
    const { output } = await compact(buildTranscript());

    expect(output.providerId).toBe(deterministicCompactionProviderId);
    expect(output.providerVersion).toBe(deterministicCompactionProviderVersion);
    expect(output.decisions).toHaveLength(2);
    expect(output.stats).toMatchObject({
      messagesBefore: 9,
      messagesAfter: 9,
      pairedCalls: 1,
      truncatedResults: 1,
      pinnedMessages: 7
    });
    expect(output.stats.charsBefore).toBeGreaterThan(output.stats.charsAfter);
  });

  test("produces no dangling tool result", async () => {
    const { messages, output } = await compact(buildTranscript({ tailToolCall: true }));
    expect(findDanglingToolResults(messages, output.messages)).toEqual([]);
  });

  test("does not modify the input messages", async () => {
    const events = buildTranscript();
    const messages = adapter.toMessages(events);
    const snapshot = structuredClone(messages);

    await provider.compact({ messages });

    expect(messages).toEqual(snapshot);
    expect(messages.find((message) => message.origin.ordinal === 3)!.toolResults[0]!.text).toBe(longText);
  });

  test("applies constructor defaults without reading any environment", async () => {
    const stricter = new DeterministicCompactionProvider({ maxToolResultChars: 1_000, truncateHeadChars: 100 });
    const messages = adapter.toMessages(buildTranscript());

    const output = await stricter.compact({ messages });

    expect(output.stats.truncatedResults).toBe(1);
    expect(resultTextOf(output, 3)).toBe("x".repeat(100) + `\n${truncationNotice(6_000, 5_900)}`);
  });
});
