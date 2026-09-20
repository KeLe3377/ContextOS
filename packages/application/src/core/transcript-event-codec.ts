import type { AgentTranscriptEvent } from "../ports/agent-adapter.js";

/**
 * The canonical, versioned on-disk representation of a transcript event batch.
 *
 * It exists so that nobody has to split or parse transcript text inside a business service:
 * `encode` is the only writer and `decode` the only reader, which is what makes the stored
 * Evidence blob a stable, self-describing artefact instead of an incidental string format.
 *
 * The format is:
 *
 * ```text
 * contextos-transcript-events.v2
 * project:<projectId>
 * session:<sessionId>
 * external:<externalSessionId or empty>
 * parser:<parserVersion or empty>
 * stream:<stream>
 * events:<count>
 *
 * {"ordinal":1,"kind":"message","role":"user","text":"..."}
 * ```
 *
 * The blank line is the unambiguous boundary between the identity header and the event lines,
 * so an event line never has to be recognised by its own shape.
 *
 * `decode` also reads the unversioned format Task 6 wrote (identity header lines followed by
 * event objects without ordinals). That legacy form carried no ordinals, so decoding it
 * reconstructs them sequentially and reports `legacy: true`; nothing rewrites the original
 * Evidence blob, and the new format is the only one ever written from here on.
 */

export const transcriptEventCodecVersion = "contextos-transcript-events.v2";

/** Version marker of the unversioned format Task 6 wrote, decoded for compatibility only. */
export const legacyTranscriptEventFormat = "legacy-unversioned";

export type TranscriptEventIdentity = {
  projectId: string;
  sessionId: string;
  externalSessionId: string | null;
  parserVersion: string | null;
  stream: string;
};

export type DecodedTranscriptEvents = {
  events: AgentTranscriptEvent[];
  identity: TranscriptEventIdentity;
  codecVersion: string;
  /** True when the blob predates the versioned format, so its ordinals were reconstructed. */
  legacy: boolean;
};

export type TranscriptEventCodecErrorCode =
  | "TRANSCRIPT_CODEC_EMPTY"
  | "TRANSCRIPT_CODEC_INVALID_HEADER"
  | "TRANSCRIPT_CODEC_UNSUPPORTED_VERSION"
  | "TRANSCRIPT_CODEC_INVALID_EVENT"
  | "TRANSCRIPT_CODEC_DUPLICATE_ORDINAL"
  | "TRANSCRIPT_CODEC_NON_INCREASING_ORDINAL"
  | "TRANSCRIPT_CODEC_EVENT_COUNT_MISMATCH"
  | "TRANSCRIPT_CODEC_IDENTITY_MISMATCH";

/** Raised for every way a stored blob can fail to decode. The code says exactly which one. */
export class TranscriptEventCodecError extends Error {
  readonly code: TranscriptEventCodecErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: TranscriptEventCodecErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "TranscriptEventCodecError";
    this.code = code;
    this.details = details;
  }
}

const headerKeys = ["project", "session", "external", "parser", "stream", "events"] as const;
const legacyKeys = ["stream", "project", "session", "external", "parser"] as const;
const versionPrefix = "contextos-transcript-events";
const versionedHeaderSeparator = "";

export function encodeTranscriptEvents(
  events: readonly AgentTranscriptEvent[],
  identity: TranscriptEventIdentity
): string {
  assertHeaderValue("project", identity.projectId);
  assertHeaderValue("session", identity.sessionId);
  assertHeaderValue("external", identity.externalSessionId ?? "");
  assertHeaderValue("parser", identity.parserVersion ?? "");
  assertHeaderValue("stream", identity.stream);
  assertAscendingOrdinals(events);

  const lines = [
    transcriptEventCodecVersion,
    `project:${identity.projectId}`,
    `session:${identity.sessionId}`,
    `external:${identity.externalSessionId ?? ""}`,
    `parser:${identity.parserVersion ?? ""}`,
    `stream:${identity.stream}`,
    `events:${events.length}`,
    versionedHeaderSeparator
  ];
  for (const event of events) lines.push(JSON.stringify(encodeEvent(event)));
  return lines.join("\n");
}

/**
 * Reads a stored blob back into events.
 *
 * When `expected` is given, the identity recorded in the blob must agree with it — session,
 * external session and parser version included — so a blob can never be attributed to the
 * wrong session or be silently read with the wrong parser generation.
 */
export function decodeTranscriptEvents(
  contentText: string,
  expected?: Partial<TranscriptEventIdentity>
): DecodedTranscriptEvents {
  const lines = contentText.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) {
    throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_EMPTY", "Transcript content is empty");
  }

  const first = lines[0]!;
  if (first.startsWith(versionPrefix)) {
    if (first !== transcriptEventCodecVersion) {
      throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_UNSUPPORTED_VERSION", "Unsupported transcript event codec version", {
        found: first,
        supported: transcriptEventCodecVersion
      });
    }
    return decodeVersioned(lines, expected);
  }

  if (legacyKeys.some((key) => first.startsWith(`${key}:`))) return decodeLegacy(lines, expected);

  throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_INVALID_HEADER", "Transcript content does not start with a known header", {
    firstLine: first.slice(0, 80)
  });
}

function decodeVersioned(lines: readonly string[], expected?: Partial<TranscriptEventIdentity>): DecodedTranscriptEvents {
  const header = new Map<string, string>();
  let index = 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === versionedHeaderSeparator) break;

    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_INVALID_HEADER", "Malformed identity header line", { line: line.slice(0, 80) });
    }
    const key = line.slice(0, separator);
    if (!(headerKeys as readonly string[]).includes(key)) {
      throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_INVALID_HEADER", "Unknown identity header key", { key });
    }
    header.set(key, line.slice(separator + 1));
  }

  // The blank separator is mandatory: without it there is no way to tell a header line from an
  // event line that happens not to be a JSON object.
  if (index >= lines.length) {
    throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_INVALID_HEADER", "Identity header is not terminated by a blank line");
  }
  for (const key of headerKeys) {
    if (!header.has(key)) {
      throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_INVALID_HEADER", "Identity header is missing a key", { key });
    }
  }

  const identity: TranscriptEventIdentity = {
    projectId: header.get("project")!,
    sessionId: header.get("session")!,
    externalSessionId: emptyToNull(header.get("external")!),
    parserVersion: emptyToNull(header.get("parser")!),
    stream: header.get("stream")!
  };
  assertIdentity(identity, expected);

  const events = parseEventLines(lines.slice(index + 1));
  const declared = Number(header.get("events"));
  if (!Number.isInteger(declared) || declared !== events.length) {
    throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_EVENT_COUNT_MISMATCH", "Declared event count does not match the number of event lines", {
      declared: header.get("events"),
      actual: events.length
    });
  }

  return { events, identity, codecVersion: transcriptEventCodecVersion, legacy: false };
}

function decodeLegacy(lines: readonly string[], expected?: Partial<TranscriptEventIdentity>): DecodedTranscriptEvents {
  const header = new Map<string, string>();
  let index = 0;
  // The legacy header is exactly the known identity keys; event lines never match this pattern.
  while (index < lines.length) {
    const line = lines[index]!;
    const key = legacyKeys.find((candidate) => line.startsWith(`${candidate}:`));
    if (!key) break;
    header.set(key, line.slice(key.length + 1));
    index += 1;
  }
  for (const key of ["project", "session", "stream"] as const) {
    if (!header.has(key)) {
      throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_INVALID_HEADER", "Legacy identity header is missing a key", { key });
    }
  }

  const identity: TranscriptEventIdentity = {
    projectId: header.get("project")!,
    sessionId: header.get("session")!,
    externalSessionId: emptyToNull(header.get("external") ?? ""),
    parserVersion: emptyToNull(header.get("parser") ?? ""),
    stream: header.get("stream")!
  };
  assertIdentity(identity, expected);

  // The legacy format stored no ordinals, so they are reconstructed sequentially. Callers can
  // tell by `legacy: true` that these positions are synthetic.
  const parsed = parseEventLines(lines.slice(index), { ordinalBase: 0 });
  return { events: parsed, identity, codecVersion: legacyTranscriptEventFormat, legacy: true };
}

function parseEventLines(lines: readonly string[], options: { ordinalBase?: number } = {}): AgentTranscriptEvent[] {
  const events: AgentTranscriptEvent[] = [];
  let previousOrdinal: number | null = null;

  for (const line of lines) {
    if (line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_INVALID_EVENT", "Event line is not valid JSON", {
        line: line.slice(0, 80),
        reason: error instanceof Error ? error.message : "invalid JSON"
      });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_INVALID_EVENT", "Event line is not a JSON object", { line: line.slice(0, 80) });
    }

    const record = parsed as Record<string, unknown>;
    const ordinal = options.ordinalBase === undefined
      ? record.ordinal
      : options.ordinalBase + events.length;
    if (typeof ordinal !== "number" || !Number.isInteger(ordinal)) {
      throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_INVALID_EVENT", "Event is missing an integer ordinal", { ordinal: record.ordinal });
    }
    if (previousOrdinal !== null) {
      if (ordinal === previousOrdinal) {
        throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_DUPLICATE_ORDINAL", "Two events share the same ordinal", { ordinal });
      }
      if (ordinal < previousOrdinal) {
        throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_NON_INCREASING_ORDINAL", "Event ordinals are not ascending", {
          previousOrdinal,
          ordinal
        });
      }
    }
    if (typeof record.kind !== "string") {
      throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_INVALID_EVENT", "Event is missing a kind", { ordinal });
    }

    previousOrdinal = ordinal;
    events.push(toEvent(record, ordinal));
  }

  return events;
}

function toEvent(record: Record<string, unknown>, ordinal: number): AgentTranscriptEvent {
  const event: AgentTranscriptEvent = {
    ordinal,
    kind: record.kind as AgentTranscriptEvent["kind"]
  };
  if (typeof record.timestamp === "string") event.timestamp = record.timestamp;
  if (typeof record.role === "string") event.role = record.role as AgentTranscriptEvent["role"];
  if (typeof record.text === "string") event.text = record.text;
  if (typeof record.name === "string") event.name = record.name;
  if (typeof record.callId === "string") event.callId = record.callId;
  if (typeof record.truncated === "boolean") event.truncated = record.truncated;
  // Outcome stays three-state: absent means unknown, never "succeeded".
  if (typeof record.isError === "boolean") event.isError = record.isError;
  return event;
}

function encodeEvent(event: AgentTranscriptEvent): Record<string, unknown> {
  return omitUndefined({
    ordinal: event.ordinal,
    timestamp: event.timestamp,
    kind: event.kind,
    role: event.role,
    name: event.name,
    callId: event.callId,
    truncated: event.truncated,
    isError: event.isError,
    text: event.text
  });
}

function assertHeaderValue(key: string, value: string): void {
  if (value.includes("\n") || value.includes("\r")) {
    throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_INVALID_HEADER", "Identity value must not contain a line break", { key });
  }
}

function assertAscendingOrdinals(events: readonly AgentTranscriptEvent[]): void {
  let previous: number | null = null;
  for (const event of events) {
    if (!Number.isInteger(event.ordinal)) {
      throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_INVALID_EVENT", "Event ordinal must be an integer", { ordinal: event.ordinal });
    }
    if (previous !== null) {
      if (event.ordinal === previous) {
        throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_DUPLICATE_ORDINAL", "Two events share the same ordinal", { ordinal: event.ordinal });
      }
      if (event.ordinal < previous) {
        throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_NON_INCREASING_ORDINAL", "Event ordinals are not ascending", {
          previousOrdinal: previous,
          ordinal: event.ordinal
        });
      }
    }
    previous = event.ordinal;
  }
}

function assertIdentity(identity: TranscriptEventIdentity, expected?: Partial<TranscriptEventIdentity>): void {
  if (!expected) return;
  for (const key of ["projectId", "sessionId", "externalSessionId", "parserVersion", "stream"] as const) {
    const wanted = expected[key];
    if (wanted === undefined) continue;
    if (identity[key] !== wanted) {
      throw new TranscriptEventCodecError("TRANSCRIPT_CODEC_IDENTITY_MISMATCH", "Stored transcript identity does not match the expected identity", {
        field: key,
        expected: wanted,
        actual: identity[key]
      });
    }
  }
}

function emptyToNull(value: string): string | null {
  return value === "" ? null : value;
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
