import { describe, expect, test } from "vitest";
import {
  TranscriptEventCodecError,
  decodeTranscriptEvents,
  encodeTranscriptEvents,
  legacyTranscriptEventFormat,
  transcriptEventCodecVersion,
  type TranscriptEventCodecErrorCode,
  type TranscriptEventIdentity
} from "../../packages/application/src/core/transcript-event-codec.js";
import type { AgentTranscriptEvent } from "../../packages/application/src/ports/agent-adapter.js";

const identity: TranscriptEventIdentity = {
  projectId: "proj_1",
  sessionId: "sess_1",
  externalSessionId: "01a0ffff-0000-7000-8000-000000000001",
  parserVersion: "codex-jsonl.v5",
  stream: "desktop-sync"
};

const events: AgentTranscriptEvent[] = [
  { ordinal: 1, timestamp: "2026-09-20T00:00:01.000Z", kind: "message", role: "user", text: "hello" },
  { ordinal: 2, kind: "tool_call", name: "shell", callId: "call_a", text: '{"command":"ls"}' },
  { ordinal: 3, kind: "tool_result", callId: "call_a", text: "ok", isError: false },
  { ordinal: 4, kind: "summary", text: "condensed" },
  { ordinal: 5, kind: "tool_result", callId: "call_b", text: "failed", isError: true },
  { ordinal: 6, kind: "tool_result", callId: "call_c", text: "unknown outcome" }
];

/** Exactly the shape Task 6 wrote: identity lines, then event objects without ordinals. */
const legacyContent = [
  "stream:desktop-sync",
  "project:proj_1",
  "session:sess_1",
  "external:01a0ffff-0000-7000-8000-000000000001",
  "parser:codex-jsonl.v5",
  JSON.stringify({ timestamp: "2026-09-20T00:00:01.000Z", kind: "message", role: "user", name: null, callId: null, truncated: false, text: "hello" }),
  JSON.stringify({ timestamp: null, kind: "tool_call", role: null, name: "shell", callId: "call_a", truncated: false, text: '{"command":"ls"}' }),
  JSON.stringify({ timestamp: null, kind: "tool_result", role: null, name: null, callId: "call_a", truncated: false, text: "ok" })
].join("\n");

function expectCodecError(work: () => unknown, code: TranscriptEventCodecErrorCode): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(TranscriptEventCodecError);
    expect((error as TranscriptEventCodecError).code).toBe(code);
    return;
  }
  throw new Error(`Expected a TranscriptEventCodecError with code ${code}`);
}

/** A well-formed versioned header, terminated by the blank line that separates events. */
function headerWith(count: number): string {
  return [
    transcriptEventCodecVersion,
    "project:proj_1",
    "session:sess_1",
    "external:",
    "parser:",
    "stream:desktop-sync",
    `events:${count}`,
    ""
  ].join("\n");
}

describe("versioned transcript event codec", () => {
  test("round-trips events and identity through the versioned format", () => {
    const encoded = encodeTranscriptEvents(events, identity);

    expect(encoded.split("\n")[0]).toBe(transcriptEventCodecVersion);

    const decoded = decodeTranscriptEvents(encoded);
    expect(decoded.codecVersion).toBe(transcriptEventCodecVersion);
    expect(decoded.legacy).toBe(false);
    expect(decoded.identity).toEqual(identity);
    expect(decoded.events).toEqual(events);
  });

  test("keeps the outcome three-state through the codec", () => {
    const decoded = decodeTranscriptEvents(encodeTranscriptEvents(events, identity));

    expect(decoded.events.find((event) => event.ordinal === 3)!.isError).toBe(false);
    expect(decoded.events.find((event) => event.ordinal === 5)!.isError).toBe(true);
    // No signal must stay absent, not become `false`.
    expect(decoded.events.find((event) => event.ordinal === 6)).not.toHaveProperty("isError");
  });

  test("normalises empty identity fields to null and tolerates CRLF and trailing newlines", () => {
    const encoded = encodeTranscriptEvents(events, { ...identity, externalSessionId: null, parserVersion: null });

    const decoded = decodeTranscriptEvents(`${encoded.replaceAll("\n", "\r\n")}\r\n\r\n`);
    expect(decoded.identity.externalSessionId).toBeNull();
    expect(decoded.identity.parserVersion).toBeNull();
    expect(decoded.events).toEqual(events);
  });

  test("reads the unversioned format Task 6 wrote, reconstructing ordinals", () => {
    const decoded = decodeTranscriptEvents(legacyContent);

    expect(decoded.legacy).toBe(true);
    expect(decoded.codecVersion).toBe(legacyTranscriptEventFormat);
    expect(decoded.identity).toEqual(identity);
    expect(decoded.events).toEqual([
      { ordinal: 0, timestamp: "2026-09-20T00:00:01.000Z", kind: "message", role: "user", text: "hello", truncated: false },
      { ordinal: 1, kind: "tool_call", name: "shell", callId: "call_a", text: '{"command":"ls"}', truncated: false },
      { ordinal: 2, kind: "tool_result", callId: "call_a", text: "ok", truncated: false }
    ]);
    // Legacy blobs carry no outcome signal, so compaction must treat them as unknown.
    expect(decoded.events[2]).not.toHaveProperty("isError");
  });

  test("validates the identity when an expectation is supplied", () => {
    const encoded = encodeTranscriptEvents(events, identity);

    expect(decodeTranscriptEvents(encoded, { sessionId: "sess_1" }).identity.sessionId).toBe("sess_1");
    expectCodecError(() => decodeTranscriptEvents(encoded, { sessionId: "sess_other" }), "TRANSCRIPT_CODEC_IDENTITY_MISMATCH");
    expectCodecError(() => decodeTranscriptEvents(encoded, { externalSessionId: "01a0other" }), "TRANSCRIPT_CODEC_IDENTITY_MISMATCH");
    expectCodecError(() => decodeTranscriptEvents(encoded, { parserVersion: "codex-jsonl.v4" }), "TRANSCRIPT_CODEC_IDENTITY_MISMATCH");
    expectCodecError(() => decodeTranscriptEvents(legacyContent, { parserVersion: "codex-jsonl.v4" }), "TRANSCRIPT_CODEC_IDENTITY_MISMATCH");
  });

  test("fails clearly on a malformed or unknown header", () => {
    expectCodecError(() => decodeTranscriptEvents(""), "TRANSCRIPT_CODEC_EMPTY");
    expectCodecError(() => decodeTranscriptEvents("   \n\n"), "TRANSCRIPT_CODEC_INVALID_HEADER");
    expectCodecError(() => decodeTranscriptEvents("not a transcript at all"), "TRANSCRIPT_CODEC_INVALID_HEADER");
    expectCodecError(
      () => decodeTranscriptEvents(encodeTranscriptEvents(events, identity).replace(transcriptEventCodecVersion, "contextos-transcript-events:v9")),
      "TRANSCRIPT_CODEC_UNSUPPORTED_VERSION"
    );
    expectCodecError(
      () => decodeTranscriptEvents(`${transcriptEventCodecVersion}\nproject:proj_1\nsession:sess_1\nstream:desktop-sync\n{"ordinal":1,"kind":"message","text":"hi"}`),
      "TRANSCRIPT_CODEC_INVALID_HEADER"
    );
    expectCodecError(
      () => decodeTranscriptEvents(`${transcriptEventCodecVersion}\nproject:proj_1\nsession:sess_1\nexternal:\nparser:\nstream:desktop-sync\nevents:1\nunknown:value\n{"ordinal":1,"kind":"message","text":"hi"}`),
      "TRANSCRIPT_CODEC_INVALID_HEADER"
    );
  });

  test("fails clearly on an invalid event line", () => {
    const header = headerWith(1);

    expectCodecError(() => decodeTranscriptEvents(`${header}\n{not json}`), "TRANSCRIPT_CODEC_INVALID_EVENT");
    expectCodecError(() => decodeTranscriptEvents(`${header}\n"a string"`), "TRANSCRIPT_CODEC_INVALID_EVENT");
    expectCodecError(() => decodeTranscriptEvents(`${header}\n["an array"]`), "TRANSCRIPT_CODEC_INVALID_EVENT");
    expectCodecError(() => decodeTranscriptEvents(`${header}\n{"kind":"message","text":"hi"}`), "TRANSCRIPT_CODEC_INVALID_EVENT");
    expectCodecError(() => decodeTranscriptEvents(`${header}\n{"ordinal":"1","kind":"message","text":"hi"}`), "TRANSCRIPT_CODEC_INVALID_EVENT");
  });

  test("fails clearly on duplicate and non-ascending ordinals", () => {
    const header = headerWith(2);

    expectCodecError(
      () => decodeTranscriptEvents(`${header}\n{"ordinal":1,"kind":"message","text":"a"}\n{"ordinal":1,"kind":"message","text":"b"}`),
      "TRANSCRIPT_CODEC_DUPLICATE_ORDINAL"
    );
    expectCodecError(
      () => decodeTranscriptEvents(`${header}\n{"ordinal":5,"kind":"message","text":"a"}\n{"ordinal":2,"kind":"message","text":"b"}`),
      "TRANSCRIPT_CODEC_NON_INCREASING_ORDINAL"
    );
  });

  test("fails clearly when the declared event count disagrees", () => {
    expectCodecError(
      () => decodeTranscriptEvents(`${headerWith(3)}\n{"ordinal":1,"kind":"message","text":"a"}`),
      "TRANSCRIPT_CODEC_EVENT_COUNT_MISMATCH"
    );
  });

  test("refuses to encode an identity value that would break the header", () => {
    expectCodecError(
      () => encodeTranscriptEvents(events, { ...identity, sessionId: "sess\ninjected:1" }),
      "TRANSCRIPT_CODEC_INVALID_HEADER"
    );
  });

  test("refuses to encode ordinals that would not decode", () => {
    expectCodecError(
      () => encodeTranscriptEvents([{ ordinal: 2, kind: "message", text: "a" }, { ordinal: 1, kind: "message", text: "b" }], identity),
      "TRANSCRIPT_CODEC_NON_INCREASING_ORDINAL"
    );
    expectCodecError(
      () => encodeTranscriptEvents([{ ordinal: 1, kind: "message", text: "a" }, { ordinal: 1, kind: "message", text: "b" }], identity),
      "TRANSCRIPT_CODEC_DUPLICATE_ORDINAL"
    );
  });

  test("does not modify the stored content it reads", () => {
    const contentText = encodeTranscriptEvents(events, identity);
    const before = contentText;

    const first = decodeTranscriptEvents(contentText);
    const second = decodeTranscriptEvents(contentText);

    expect(contentText).toBe(before);
    expect(second).toEqual(first);
  });
});
