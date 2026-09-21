import type { AgentTranscriptEvent } from "../ports/agent-adapter.js";

/**
 * Stable version of the sanitizer rules, recorded on derived artifacts.
 *
 * Kept here (not in the deferred `transcript-compaction` port) because the sanitizer is
 * part of the active session-continuity path and must survive the compaction pipeline removal.
 */
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

/**
 * Removes the known pseudo-user injections the agent runtime prepends to a session.
 *
 * Only these exact prefixes are matched — never `includes`, and never a general XML, Markdown
 * or length rule — so a genuine message that merely discusses `AGENTS.md` or quotes an
 * `<environment_context>` snippet is left alone. The result is a derived input for compaction;
 * the source Evidence is untouched.
 */
const injectionPrefixes = ["# AGENTS.md instructions", "<environment_context>"] as const;

export class PrefixTranscriptSanitizer implements TranscriptSanitizer {
  readonly version = transcriptSanitizerVersion;

  sanitize(events: readonly AgentTranscriptEvent[]): SanitizedTranscript {
    const kept: AgentTranscriptEvent[] = [];
    const removedOrdinals: number[] = [];

    for (const event of events) {
      if (isKnownInjection(event)) {
        removedOrdinals.push(event.ordinal);
        continue;
      }
      kept.push(event);
    }

    removedOrdinals.sort((left, right) => left - right);
    return { events: kept, removedOrdinals, sanitizerVersion: this.version };
  }
}

/**
 * An injection is a context message the runtime synthesised. Only `user` and `system` roles are
 * considered, because those are the roles a runtime uses for injected context.
 */
function isKnownInjection(event: AgentTranscriptEvent): boolean {
  if (event.kind !== "message") return false;
  if (event.role !== "user" && event.role !== "system") return false;
  const text = stripLeadingDecoration(event.text ?? "");
  return injectionPrefixes.some((prefix) => text.startsWith(prefix));
}

/** Allows a leading byte order mark and whitespace before the marker. */
function stripLeadingDecoration(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/^\s+/, "");
}
