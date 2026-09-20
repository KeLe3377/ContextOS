import { describe, expect, test } from "vitest";
import { PrefixTranscriptSanitizer } from "../../packages/application/src/core/transcript-sanitizer.js";
import { transcriptSanitizerVersion } from "../../packages/application/src/ports/transcript-compaction.js";
import type { AgentTranscriptEvent } from "../../packages/application/src/ports/agent-adapter.js";

const agentsInjection = "# AGENTS.md instructions for D:\\project\\ContextOS\n\n<INSTRUCTIONS>\nUse tabs.\n</INSTRUCTIONS>";
const environmentInjection = "<environment_context>\n  <cwd>D:\\project\\ContextOS</cwd>\n</environment_context>";

function userMessage(ordinal: number, text: string): AgentTranscriptEvent {
  return { ordinal, kind: "message", role: "user", text, timestamp: `2026-09-20T00:00:0${ordinal}.000Z` };
}

function sanitizer() {
  return new PrefixTranscriptSanitizer();
}

describe("transcript sanitizer", () => {
  test("removes both known injection prefixes and reports their ordinals", () => {
    const events = [
      userMessage(1, agentsInjection),
      userMessage(2, "real question"),
      userMessage(3, environmentInjection),
      { ordinal: 4, kind: "message", role: "assistant", text: "real answer" } as AgentTranscriptEvent
    ];

    const result = sanitizer().sanitize(events);

    expect(result.removedOrdinals).toEqual([1, 3]);
    expect(result.events.map((event) => event.ordinal)).toEqual([2, 4]);
    expect(result.sanitizerVersion).toBe(transcriptSanitizerVersion);
    expect(sanitizer().version).toBe(transcriptSanitizerVersion);
  });

  test("allows a leading byte order mark and whitespace before the marker", () => {
    const events = [
      userMessage(1, `\uFEFF${agentsInjection}`),
      userMessage(2, `\n\t  ${environmentInjection}`),
      userMessage(3, `\uFEFF \n ${agentsInjection}`)
    ];

    expect(sanitizer().sanitize(events).removedOrdinals).toEqual([1, 2, 3]);
  });

  test("keeps messages that merely mention the markers instead of starting with them", () => {
    const events = [
      userMessage(1, "Please update the AGENTS.md instructions section of the README"),
      userMessage(2, "Why does my transcript contain <environment_context> at the top?"),
      userMessage(3, "See the block below:\n<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>"),
      userMessage(4, "The runtime injects # AGENTS.md instructions and <environment_context> at the top"),
      userMessage(5, "# AGENTS.md instructions"),
      userMessage(6, "How do I trim leading whitespace?")
    ];

    const result = sanitizer().sanitize(events);

    // Only a message that *starts* with the exact marker is removed. Ordinal 4 talks about both
    // markers without starting with either, so it survives.
    expect(result.removedOrdinals).toEqual([5]);
    expect(result.events.map((event) => event.ordinal)).toEqual([1, 2, 3, 4, 6]);
  });

  test("does not remove non-user roles or non-message events carrying the marker", () => {
    const events: AgentTranscriptEvent[] = [
      { ordinal: 1, kind: "message", role: "assistant", text: agentsInjection },
      { ordinal: 2, kind: "summary", text: agentsInjection },
      { ordinal: 3, kind: "tool_result", callId: "call_1", text: agentsInjection },
      { ordinal: 4, kind: "tool_call", name: "shell", callId: "call_2", text: agentsInjection },
      { ordinal: 5, kind: "message", role: "system", text: environmentInjection }
    ];

    const result = sanitizer().sanitize(events);

    // A system-role context message is still runtime-injected context.
    expect(result.removedOrdinals).toEqual([5]);
    expect(result.events.map((event) => event.ordinal)).toEqual([1, 2, 3, 4]);
  });

  test("sorts removed ordinals ascending regardless of input order", () => {
    const events = [
      userMessage(9, environmentInjection),
      userMessage(2, "kept"),
      userMessage(5, agentsInjection),
      userMessage(1, environmentInjection)
    ];

    const result = sanitizer().sanitize(events);

    expect(result.removedOrdinals).toEqual([1, 5, 9]);
    expect(result.events.map((event) => event.ordinal)).toEqual([2]);
  });

  test("does not modify the input array or the event objects", () => {
    const events = [userMessage(1, agentsInjection), userMessage(2, "kept")];
    const snapshot = structuredClone(events);
    const firstReference = events[0];

    const result = sanitizer().sanitize(events);

    expect(events).toEqual(snapshot);
    expect(events).toHaveLength(2);
    expect(events[0]).toBe(firstReference);
    // Kept events are passed through by reference, and the result array is a new one.
    expect(result.events).not.toBe(events);
    expect(result.events[0]).toBe(events[1]);
  });

  test("returns an empty removal list when there is nothing to sanitize", () => {
    const result = sanitizer().sanitize([userMessage(1, "hello")]);
    expect(result.removedOrdinals).toEqual([]);
    expect(result.events).toHaveLength(1);
  });
});
