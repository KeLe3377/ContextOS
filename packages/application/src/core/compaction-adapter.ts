import type { AgentTranscriptEvent } from "../ports/agent-adapter.js";
import type {
  CompactionMessage,
  CompactionMessageOrigin,
  CompactionToolUse
} from "../ports/transcript-compaction.js";

/**
 * Converts the flat ContextOS event stream to the neutral conversation shape compaction works
 * on, and back again.
 *
 * One event becomes exactly one message. That keeps the round trip lossless — ordinal,
 * timestamp, kind, role, name, callId, error and truncation flags all survive — and it means
 * this module carries no policy: it never drops, merges, reorders or truncates anything.
 *
 * Design: docs/2026-09-20-contextos-jev-compaction-integration-design.md §7.1, §7.2, §8.3
 */
export class ContextOsCompactionAdapter {
  toMessages(events: readonly AgentTranscriptEvent[]): CompactionMessage[] {
    return events.map(toMessage);
  }

  /** Rebuilds events ordered by their original ordinal, whatever order the provider returned. */
  toEvents(messages: readonly CompactionMessage[]): AgentTranscriptEvent[] {
    return messages.map(toEvent).sort((left, right) => left.ordinal - right.ordinal);
  }
}

function toMessage(event: AgentTranscriptEvent): CompactionMessage {
  const origin: CompactionMessageOrigin = {
    ordinal: event.ordinal,
    timestamp: event.timestamp,
    kind: event.kind,
    role: event.role,
    name: event.name,
    callId: event.callId,
    truncated: event.truncated
  };

  if (event.kind === "tool_call") {
    return {
      role: "assistant",
      text: "",
      toolUses: [
        {
          callId: event.callId ?? null,
          name: event.name ?? "tool",
          input: parseToolInput(event.text),
          // Always a string, so a round trip reproduces the bytes the transcript carried
          // instead of a re-serialisation. An absent text normalises to an empty string.
          sourceText: event.text ?? ""
        }
      ],
      toolResults: [],
      origin
    };
  }

  if (event.kind === "tool_result") {
    return {
      role: "user",
      text: "",
      toolUses: [],
      toolResults: [{ callId: event.callId ?? null, text: event.text ?? "", isError: event.isError === true }],
      origin
    };
  }

  // `message` and `summary` both carry plain text. A summary is assistant-side by definition and
  // keeps its source kind in the origin, so the round trip can restore both.
  return {
    role: event.kind === "summary" || event.role === "assistant" ? "assistant" : "user",
    text: event.text ?? "",
    toolUses: [],
    toolResults: [],
    origin
  };
}

function toEvent(message: CompactionMessage): AgentTranscriptEvent {
  const { origin } = message;

  if (origin.kind === "tool_call") {
    const use = message.toolUses[0];
    return omitUndefined({
      ordinal: origin.ordinal,
      timestamp: origin.timestamp,
      kind: origin.kind,
      name: use?.name ?? origin.name,
      callId: use?.callId ?? origin.callId,
      text: use ? toolInputText(use) : ""
    });
  }

  if (origin.kind === "tool_result") {
    const result = message.toolResults[0];
    return omitUndefined({
      ordinal: origin.ordinal,
      timestamp: origin.timestamp,
      kind: origin.kind,
      callId: result?.callId ?? origin.callId,
      text: result?.text ?? "",
      isError: result?.isError === true ? true : undefined
    });
  }

  return omitUndefined({
    ordinal: origin.ordinal,
    timestamp: origin.timestamp,
    kind: origin.kind,
    role: origin.role,
    name: origin.name,
    callId: origin.callId,
    text: message.text,
    truncated: origin.truncated
  });
}

/**
 * Parses a serialised tool input.
 *
 * Only a JSON object counts as structured input. Arrays, primitives, `null`, malformed JSON and
 * empty text are all wrapped as `{ raw }` around the original text, so nothing is lost and the
 * provider still sees exactly one shape.
 */
export function parseToolInput(text: string | undefined): Record<string, unknown> {
  const original = text ?? "";
  const trimmed = original.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Falls through to the raw wrapper below.
    }
  }
  return { raw: original };
}

function toolInputText(use: CompactionToolUse): string {
  return use.sourceText ?? JSON.stringify(use.input);
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
