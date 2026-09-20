import { describe, expect, test } from "vitest";
import type { CompactionArtifactDto, CompactionEvent } from "../../packages/contracts/src/compaction.js";
import {
  buildExtractionInput,
  defaultExtractionLimits,
  extractionTruncationMarker
} from "../../packages/application/src/core/extraction-input.js";

const sourceEvidenceId = "ev_source";

function artifact(events: CompactionEvent[], overrides: Partial<CompactionArtifactDto> = {}): CompactionArtifactDto {
  return {
    id: "cmp_1",
    projectId: "proj_1",
    sessionId: "sess_1",
    sourceEvidenceId,
    sourceContentHash: "sha256:source",
    providerId: "deterministic",
    providerVersion: "contextos-deterministic-compaction.v1",
    sanitizerVersion: "contextos-transcript-sanitizer.v1",
    optionsHash: "sha256:options",
    status: "SUCCEEDED",
    events,
    decisions: [],
    stats: {
      messagesBefore: events.length,
      messagesAfter: events.length,
      charsBefore: 0,
      charsAfter: 0,
      pairedCalls: 0,
      truncatedResults: 0,
      pinnedMessages: 0
    },
    failureCode: null,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    revision: 1,
    ...overrides
  };
}

const transcript: CompactionEvent[] = [
  { ordinal: 1, kind: "message", role: "user", text: "first question" },
  { ordinal: 2, kind: "tool_call", name: "shell", callId: "call_a", text: '{"command":"ls"}' },
  { ordinal: 3, kind: "tool_result", callId: "call_a", text: "tool output" },
  { ordinal: 4, kind: "summary", text: "condensed earlier work" },
  { ordinal: 5, kind: "message", role: "assistant", text: "final answer" }
];

describe("extraction input", () => {
  test("carries the artifact identity and the intents", () => {
    const input = buildExtractionInput({
      artifact: artifact(transcript),
      projectIntent: "ship the automation pipeline",
      sessionIntent: "wire the extractor",
      knownCandidateFingerprints: ["sha256:known"]
    });

    expect(input.identity).toEqual({
      projectId: "proj_1",
      sessionId: "sess_1",
      artifactId: "cmp_1",
      sourceEvidenceId,
      sourceContentHash: "sha256:source",
      compactionProviderId: "deterministic",
      compactionProviderVersion: "contextos-deterministic-compaction.v1",
      sanitizerVersion: "contextos-transcript-sanitizer.v1"
    });
    expect(input.projectIntent).toBe("ship the automation pipeline");
    expect(input.sessionIntent).toBe("wire the extractor");
    expect(input.knownCandidateFingerprints).toEqual(["sha256:known"]);
    expect(input.limits).toEqual(defaultExtractionLimits);
  });

  test("presents the transcript chronologically and keeps item text verbatim", () => {
    const input = buildExtractionInput({ artifact: artifact(transcript) });

    expect(input.transcript.map((item) => item.ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(input.transcript.map((item) => item.kind)).toEqual(["message", "tool", "tool", "summary", "message"]);
    expect(input.transcript[0]).toMatchObject({ role: "user", text: "first question", truncated: false });
    expect(input.transcript[1]).toMatchObject({ kind: "tool", name: "shell", text: '{"command":"ls"}' });
    expect(input.transcript[4]).toMatchObject({ role: "assistant", text: "final answer" });
  });

  test("is deterministic for identical input", () => {
    const first = buildExtractionInput({ artifact: artifact(transcript), limits: { maxChars: 40 } });
    const second = buildExtractionInput({ artifact: artifact(transcript), limits: { maxChars: 40 } });

    expect(second).toStrictEqual(first);
  });

  test("never exceeds the character budget and drops the oldest tool content first", () => {
    const input = buildExtractionInput({
      artifact: artifact(transcript),
      limits: { maxChars: 40, maxItems: 100, maxItemChars: 40 }
    });

    const total = input.transcript.reduce((sum, item) => sum + item.text.length, 0);
    expect(total).toBeLessThanOrEqual(40);
    // Messages are the priority, so the tool traffic is what went.
    expect(input.transcript.some((item) => item.kind === "message")).toBe(true);
    expect(input.transcript.some((item) => item.kind === "tool")).toBe(false);
  });

  test("keeps the newest tool items and drops the oldest ones", () => {
    const events: CompactionEvent[] = [
      { ordinal: 1, kind: "tool_result", callId: "call_old", text: "old output" },
      { ordinal: 2, kind: "tool_result", callId: "call_new", text: "new output" }
    ];
    const input = buildExtractionInput({
      artifact: artifact(events),
      limits: { maxChars: 12, maxItems: 100, maxItemChars: 12 }
    });

    expect(input.transcript.map((item) => item.ordinal)).toEqual([2]);
    expect(input.transcript[0]!.text).toBe("new output");
  });

  test("caps a single oversized item with an explicit notice", () => {
    const long = "x".repeat(500);
    const input = buildExtractionInput({
      artifact: artifact([{ ordinal: 1, kind: "message", role: "user", text: long }]),
      limits: { maxChars: 10_000, maxItems: 10, maxItemChars: 100 }
    });

    const item = input.transcript[0]!;
    expect(item.truncated).toBe(true);
    expect(item.text.startsWith("x".repeat(100))).toBe(true);
    expect(item.text).toContain(extractionTruncationMarker);
    expect(item.text).toContain("truncated 400 of 500 chars");
    expect(item.text.length).toBeLessThan(long.length);
  });

  test("limits the number of items", () => {
    const events: CompactionEvent[] = Array.from({ length: 20 }, (_, index) => ({
      ordinal: index + 1,
      kind: "message" as const,
      role: "user" as const,
      text: `message ${index + 1}`
    }));

    const input = buildExtractionInput({ artifact: artifact(events), limits: { maxChars: 10_000, maxItems: 3, maxItemChars: 100 } });

    expect(input.transcript).toHaveLength(3);
    expect(input.transcript.map((item) => item.ordinal)).toEqual([1, 2, 3]);
  });

  test("produces an empty transcript for an artifact with no events", () => {
    const input = buildExtractionInput({ artifact: artifact([]) });
    expect(input.transcript).toEqual([]);
  });

  test("does not expose any storage path or blob reference", () => {
    const input = buildExtractionInput({ artifact: artifact(transcript) });
    const serialized = JSON.stringify(input);

    expect(serialized).not.toContain("storageRef");
    expect(serialized).not.toContain("evidence/");
    expect(serialized).not.toContain("contentText");
  });
});
