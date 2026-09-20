import { describe, expect, test } from "vitest";
import { ContextOsCompactionAdapter, parseToolInput } from "../../packages/application/src/core/compaction-adapter.js";
import { findDanglingToolResults } from "../../packages/application/src/ports/transcript-compaction.js";
import type { AgentTranscriptEvent } from "../../packages/application/src/ports/agent-adapter.js";

function adapter() {
  return new ContextOsCompactionAdapter();
}

/** A realistic slice of a Codex transcript, including every shape the adapter must preserve. */
const transcript: AgentTranscriptEvent[] = [
  { ordinal: 1, timestamp: "2026-09-20T00:00:01.000Z", kind: "message", role: "user", text: "Please fix the parser" },
  { ordinal: 2, timestamp: "2026-09-20T00:00:02.000Z", kind: "summary", text: "Earlier turns summarised" },
  { ordinal: 3, timestamp: "2026-09-20T00:00:03.000Z", kind: "tool_call", name: "shell", callId: "call_a", text: '{"command":"ls -la","cwd":"D:\\\\project"}' },
  { ordinal: 4, timestamp: "2026-09-20T00:00:04.000Z", kind: "tool_result", callId: "call_a", text: "total 12\ndrwxr-xr-x" },
  { ordinal: 5, kind: "tool_call", name: "read_file", callId: "call_b", text: '["a.ts","b.ts"]' },
  { ordinal: 6, kind: "tool_result", callId: "call_b", text: "cannot read array input" },
  { ordinal: 7, kind: "tool_call", name: "grep", callId: "call_c", text: "not json at all" },
  { ordinal: 8, kind: "tool_result", callId: "call_c", text: "no matches", isError: true },
  { ordinal: 9, kind: "tool_call", name: "shell", text: '{"command":"pwd"}' },
  { ordinal: 10, kind: "tool_result", text: "orphan output" },
  { ordinal: 11, kind: "tool_call", name: "shell", callId: "call_dup", text: '{"command":"a"}' },
  { ordinal: 12, kind: "tool_call", name: "shell", callId: "call_dup", text: '{"command":"b"}' },
  { ordinal: 13, kind: "tool_result", callId: "call_dup", text: "first output" },
  { ordinal: 14, kind: "tool_result", callId: "call_dup", text: "second output" },
  { ordinal: 15, kind: "message", role: "assistant", text: "Done.", truncated: true },
  { ordinal: 16, timestamp: "2026-09-20T00:00:16.000Z", kind: "tool_call", name: "shell", callId: "call_e", text: '{"command":"tail"}' }
];

describe("compaction adapter round trip", () => {
  test("preserves every event field through both directions", () => {
    const result = adapter().toEvents(adapter().toMessages(transcript));
    expect(result).toEqual(transcript);
  });

  test("keeps ordinal, timestamp, name, callId, role and the truncation flag", () => {
    const messages = adapter().toMessages(transcript);

    const summary = messages.find((message) => message.origin.ordinal === 2)!;
    expect(summary.origin).toMatchObject({ kind: "summary" });
    expect(summary.role).toBe("assistant");
    expect(summary.text).toBe("Earlier turns summarised");

    const call = messages.find((message) => message.origin.ordinal === 3)!;
    expect(call.role).toBe("assistant");
    expect(call.toolUses[0]).toMatchObject({ callId: "call_a", name: "shell", input: { command: "ls -la", cwd: "D:\\project" } });

    const result = messages.find((message) => message.origin.ordinal === 4)!;
    expect(result.toolResults[0]).toMatchObject({ callId: "call_a", text: "total 12\ndrwxr-xr-x", isError: false });

    const errorResult = messages.find((message) => message.origin.ordinal === 8)!;
    expect(errorResult.toolResults[0]!.isError).toBe(true);

    const truncated = messages.find((message) => message.origin.ordinal === 15)!;
    expect(truncated.origin).toMatchObject({ kind: "message", role: "assistant", truncated: true });
    expect(truncated.origin.timestamp).toBeUndefined();
  });

  test("keeps the exact tool input text so a round trip is byte-exact", () => {
    const prettyPrinted = '{\n  "command": "ls",\n  "cwd": "D:\\\\project"\n}';
    const events: AgentTranscriptEvent[] = [
      { ordinal: 1, kind: "tool_call", name: "shell", callId: "call_a", text: prettyPrinted }
    ];

    const messages = adapter().toMessages(events);
    expect(messages[0]!.toolUses[0]!.input).toEqual({ command: "ls", cwd: "D:\\project" });
    expect(adapter().toEvents(messages)).toEqual(events);
  });

  test("orders output by the original ordinal whatever order the provider returned", () => {
    const messages = adapter().toMessages(transcript);
    const shuffled = [...messages].reverse();

    const events = adapter().toEvents(shuffled);

    expect(events.map((event) => event.ordinal)).toEqual([...transcript.map((event) => event.ordinal)]);
  });

  test("normalises absent text to an empty string rather than dropping the field", () => {
    const events: AgentTranscriptEvent[] = [
      { ordinal: 1, kind: "tool_call", name: "shell", callId: "call_a" },
      { ordinal: 2, kind: "tool_result", callId: "call_a" }
    ];

    const messages = adapter().toMessages(events);
    // The structured input still exists, wrapped as raw around the empty text.
    expect(messages[0]!.toolUses[0]!.input).toEqual({ raw: "" });

    const roundTripped = adapter().toEvents(messages);
    expect(roundTripped).toEqual([
      { ordinal: 1, kind: "tool_call", name: "shell", callId: "call_a", text: "" },
      { ordinal: 2, kind: "tool_result", callId: "call_a", text: "" }
    ]);
  });
});

describe("tool input parsing", () => {
  test("parses a JSON object as structured input", () => {
    expect(parseToolInput('{"command":"ls","nested":{"a":1}}')).toEqual({ command: "ls", nested: { a: 1 } });
  });

  test("wraps non-object JSON and non-JSON text as raw", () => {
    expect(parseToolInput('["a","b"]')).toEqual({ raw: '["a","b"]' });
    expect(parseToolInput("42")).toEqual({ raw: "42" });
    expect(parseToolInput('"a string"')).toEqual({ raw: '"a string"' });
    expect(parseToolInput("null")).toEqual({ raw: "null" });
    expect(parseToolInput("not json at all")).toEqual({ raw: "not json at all" });
    expect(parseToolInput("")).toEqual({ raw: "" });
    expect(parseToolInput(undefined)).toEqual({ raw: "" });
  });

  test("wraps malformed JSON without losing the original text", () => {
    expect(parseToolInput('{"command": ')).toEqual({ raw: '{"command": ' });
  });
});

describe("passthrough of unpaired and ambiguous tool events", () => {
  test("keeps a call without a callId as an unpaired entry", () => {
    const messages = adapter().toMessages(transcript);
    const call = messages.find((message) => message.origin.ordinal === 9)!;
    expect(call.toolUses[0]!.callId).toBeNull();
    expect(call.toolUses[0]!.input).toEqual({ command: "pwd" });

    const result = messages.find((message) => message.origin.ordinal === 10)!;
    expect(result.toolResults[0]!.callId).toBeNull();
  });

  test("keeps duplicated callIds on both sides", () => {
    const messages = adapter().toMessages(transcript);
    const duplicates = messages.filter((message) => message.toolUses[0]?.callId === "call_dup" || message.toolResults[0]?.callId === "call_dup");

    expect(duplicates).toHaveLength(4);
    expect(adapter().toEvents(messages)).toEqual(transcript);
  });

  test("reports a result whose call was removed, and ignores one that was never paired", () => {
    const messages = adapter().toMessages(transcript);

    // Remove the call for call_a but keep its result: that is a dangling result.
    const withoutCallA = messages.filter((message) => !(message.origin.kind === "tool_call" && message.toolUses[0]?.callId === "call_a"));
    expect(findDanglingToolResults(messages, withoutCallA)).toEqual(["call_a"]);

    // Removing both sides is fine, and the never-paired result is not reported.
    const withoutCallAAndResult = withoutCallA.filter((message) => !(message.origin.kind === "tool_result" && message.toolResults[0]?.callId === "call_a"));
    expect(findDanglingToolResults(messages, withoutCallAAndResult)).toEqual([]);
    expect(findDanglingToolResults(messages, messages)).toEqual([]);
  });

  test("does not modify the input events", () => {
    const events = structuredClone(transcript);
    const snapshot = structuredClone(events);

    adapter().toEvents(adapter().toMessages(events));

    expect(events).toEqual(snapshot);
  });
});
