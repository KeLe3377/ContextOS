import type { CompactionArtifactDto, CompactionEvent } from "../../../contracts/src/compaction.js";
import type {
  ExtractionIdentity,
  ExtractionInput,
  ExtractionInputLimits,
  ExtractionTranscriptItem
} from "../ports/context-extractor.js";

/**
 * Turns a Compaction Artifact into the bounded input an extractor may see.
 *
 * The artifact is the only source: raw Evidence, `metadata.events`, project directories, API keys
 * and settings are all out of reach here, and no absolute storage path ever reaches the input.
 *
 * Selection is deterministic and priority ordered — user/assistant messages first, then summaries,
 * then tool traffic — and when the budget runs out it is the *oldest* tool content that goes
 * first, so the newest work survives. Selection order and presentation order are separate: the
 * result is handed over chronologically.
 */

export const defaultExtractionLimits: ExtractionInputLimits = {
  maxChars: 60_000,
  maxItems: 400,
  maxItemChars: 4_000
};

/** Fixed marker appended when an item had to be shortened to fit the budget. */
export const extractionTruncationMarker = "[contextos-extraction]";

export function buildExtractionInput(input: {
  artifact: CompactionArtifactDto;
  projectIntent?: string | null;
  sessionIntent?: string | null;
  knownCandidateFingerprints?: readonly string[];
  limits?: Partial<ExtractionInputLimits>;
}): ExtractionInput {
  const limits: ExtractionInputLimits = { ...defaultExtractionLimits, ...input.limits };
  const perItemCap = Math.max(1, Math.min(limits.maxItemChars, limits.maxChars));

  const selected: ExtractionTranscriptItem[] = [];
  let usedChars = 0;

  for (const item of selectionOrder(input.artifact.events)) {
    if (selected.length >= limits.maxItems) break;

    const capped = capItem(item, perItemCap);
    // Priority order is honoured strictly: once an item no longer fits, nothing of lower
    // priority is considered either. A single item can always fit, because it is capped to the
    // smaller of `maxItemChars` and the whole budget before this check.
    if (usedChars + capped.text.length > limits.maxChars) break;
    usedChars += capped.text.length;
    selected.push(capped);
  }

  return {
    identity: identityOf(input.artifact),
    projectIntent: input.projectIntent ?? null,
    sessionIntent: input.sessionIntent ?? null,
    transcript: selected.sort((left, right) => left.ordinal - right.ordinal),
    knownCandidateFingerprints: [...(input.knownCandidateFingerprints ?? [])],
    limits
  };
}

/**
 * Priority order used to decide what survives the budget.
 *
 * Within tool traffic the order is reversed: the newest tool items are considered first, so an
 * overflow drops the oldest tool content rather than the work in flight.
 */
function selectionOrder(events: readonly CompactionEvent[]): ExtractionTranscriptItem[] {
  const messages: ExtractionTranscriptItem[] = [];
  const summaries: ExtractionTranscriptItem[] = [];
  const tools: ExtractionTranscriptItem[] = [];

  for (const event of events) {
    if (event.kind === "message") messages.push(toItem(event));
    else if (event.kind === "summary") summaries.push(toItem(event));
    else tools.push(toItem(event));
  }

  messages.sort(byOrdinal);
  summaries.sort(byOrdinal);
  tools.sort((left, right) => right.ordinal - left.ordinal);
  return [...messages, ...summaries, ...tools];
}

function toItem(event: CompactionEvent): ExtractionTranscriptItem {
  return {
    ordinal: event.ordinal,
    kind: event.kind === "message" || event.kind === "summary" ? event.kind : "tool",
    role: event.kind === "message" ? (event.role === "assistant" ? "assistant" : "user") : null,
    name: event.name ?? null,
    // Kept verbatim: an item is only ever shortened, never reworded.
    text: event.text ?? "",
    truncated: false
  };
}

function byOrdinal(left: ExtractionTranscriptItem, right: ExtractionTranscriptItem): number {
  return left.ordinal - right.ordinal;
}

function capItem(item: ExtractionTranscriptItem, maxItemChars: number): ExtractionTranscriptItem {
  if (item.text.length <= maxItemChars) return item;
  const head = item.text.slice(0, maxItemChars);
  return {
    ...item,
    text: `${head}\n${truncationNotice(item.text.length, item.text.length - head.length)}`,
    truncated: true
  };
}

/**
 * The notice left in place of removed text: how much went, how long the original was, and that
 * the tool can be re-run to see it again.
 */
export function truncationNotice(originalChars: number, removedChars: number): string {
  return `${extractionTruncationMarker} truncated ${removedChars} of ${originalChars} chars; re-run the tool to see the full output`;
}

function identityOf(artifact: CompactionArtifactDto): ExtractionIdentity {
  return {
    projectId: artifact.projectId,
    sessionId: artifact.sessionId,
    artifactId: artifact.id,
    sourceEvidenceId: artifact.sourceEvidenceId,
    sourceContentHash: artifact.sourceContentHash,
    compactionProviderId: artifact.providerId,
    compactionProviderVersion: artifact.providerVersion,
    sanitizerVersion: artifact.sanitizerVersion
  };
}
