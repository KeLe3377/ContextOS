import { createHash } from "node:crypto";
import type { EvidenceSnapshotDto } from "../../../contracts/src/context.js";
import type { AutomationJobRecord, SqliteAutomationRepository } from "../../../infrastructure/src/sqlite/automation-repository.js";
import type { SqliteCompactionArtifactRepository } from "../../../infrastructure/src/sqlite/compaction-artifact-repository.js";
import { nowMs } from "../../../shared/src/clock.js";
import type { ContextOsCompactionAdapter } from "./compaction-adapter.js";
import type { EvidenceSnapshotService } from "./context-services.js";
import { describeAutomationFailure } from "./automation-scheduler.js";
import {
  decodeTranscriptEvents,
  type TranscriptEventIdentity
} from "./transcript-event-codec.js";
import {
  compactionMessageChars,
  type CompactionMessage,
  type CompactionOptions,
  type TranscriptCompactionProvider,
  type TranscriptSanitizer
} from "../ports/transcript-compaction.js";

/**
 * Turns a committed Evidence Snapshot into a versioned Compaction Artifact and only then queues
 * extraction.
 *
 * Invariants this service exists to hold:
 * - the source Evidence is read, never written;
 * - a blob that cannot be decoded fails the job instead of producing a forged artifact;
 * - a provider failure still yields a valid FALLBACK artifact built from the sanitized events,
 *   so a compaction problem never blocks extraction;
 * - the artifact is created before extraction is queued, and the queue key derives from the
 *   artifact id, so a retry cannot double-enqueue;
 * - compaction and extraction stay separate responsibilities.
 *
 * Design: docs/2026-09-20-contextos-jev-compaction-integration-design.md §10, Phase C2
 */

export type AutomationExtractorIdentity = { id: string; version: string };

export const defaultAutomationExtractor: AutomationExtractorIdentity = { id: "codex-cli", version: "codex-cli.v1" };

export type CompactionServiceOptions = {
  /**
   * Reads Evidence through the application service, never the repository, so the payload always
   * comes from the integrity-verified Evidence Store instead of an unverified database copy.
   */
  evidence: EvidenceSnapshotService;
  artifacts: SqliteCompactionArtifactRepository;
  automation: SqliteAutomationRepository;
  sanitizer: TranscriptSanitizer;
  adapter: ContextOsCompactionAdapter;
  provider: TranscriptCompactionProvider;
  options: CompactionOptions;
  extractor?: AutomationExtractorIdentity;
  clock?: () => number;
};

export type CompactionRunSummary = {
  artifactId: string;
  status: "SUCCEEDED" | "FALLBACK";
  reused: boolean;
  eventCount: number;
  truncatedResults: number;
  extractionJobEnqueued: boolean;
};

export class CompactionService {
  constructor(private readonly options: CompactionServiceOptions) {}

  /** Dispatcher entry point for COMPACT_EVIDENCE jobs. */
  async handleCompactionJob(job: AutomationJobRecord): Promise<void> {
    await this.compactEvidence({ evidenceId: job.resourceId });
  }

  async compactEvidence(input: { evidenceId: string }): Promise<CompactionRunSummary> {
    const now = this.now();
    // The full payload comes from verified storage: a tampered or missing blob must fail the job
    // rather than let compaction run on an unverified or empty copy of the transcript.
    const { snapshot: evidence, contentText } = this.options.evidence.readFullText(input.evidenceId);

    // An undecodable blob is a hard failure: the job retries rather than inventing an artifact.
    const decoded = decodeTranscriptEvents(contentText, expectedIdentity(evidence));
    const sanitized = this.options.sanitizer.sanitize(decoded.events);
    const messages = this.options.adapter.toMessages(sanitized.events);

    let status: "SUCCEEDED" | "FALLBACK" = "SUCCEEDED";
    let failureCode: string | null = null;
    let events = sanitized.events;
    let decisions: Array<Record<string, unknown>> = [];
    let stats: Record<string, unknown> = fallbackStats(messages);

    try {
      const output = await this.options.provider.compact({ messages, options: this.options.options });
      events = this.options.adapter.toEvents(output.messages);
      decisions = output.decisions.map((decision) => ({ ...decision }));
      stats = { ...output.stats };
    } catch (error) {
      // The provider failed, not the batch: keep the sanitized events verbatim and record why.
      status = "FALLBACK";
      failureCode = describeAutomationFailure(error).code;
    }

    const { artifact, created } = this.options.artifacts.findOrCreate(
      {
        projectId: evidence.projectId,
        sessionId: typeof evidence.metadata.sessionId === "string" ? evidence.metadata.sessionId : null,
        sourceEvidenceId: evidence.id,
        sourceContentHash: evidence.contentHash,
        providerId: this.options.provider.id,
        providerVersion: this.options.provider.version,
        sanitizerVersion: this.options.sanitizer.version,
        optionsHash: hashCompactionOptions(this.options.options),
        status,
        events,
        decisions,
        stats,
        failureCode
      },
      now
    );

    const extractor = this.options.extractor ?? defaultAutomationExtractor;
    const job = this.options.automation.enqueue(
      {
        kind: "EXTRACT_EVIDENCE_CONTEXT",
        projectId: evidence.projectId,
        sessionId: artifact.sessionId,
        resourceType: "COMPACTION_ARTIFACT",
        resourceId: artifact.id,
        payload: { artifactId: artifact.id, sourceEvidenceId: evidence.id, extractorId: extractor.id },
        idempotencyKey: `EXTRACT_EVIDENCE_CONTEXT:${artifact.id}:${extractor.version}`
      },
      now
    );

    return {
      artifactId: artifact.id,
      status: artifact.status,
      reused: !created,
      eventCount: artifact.events.length,
      truncatedResults: typeof stats.truncatedResults === "number" ? stats.truncatedResults : 0,
      extractionJobEnqueued: job.created
    };
  }

  private now(): number {
    return this.options.clock?.() ?? nowMs();
  }
}

/**
 * Options participate in the artifact identity, so changing any of them produces a new artifact
 * instead of silently reusing one built under different rules.
 */
export function hashCompactionOptions(options: CompactionOptions): string {
  const canonical = JSON.stringify({
    preserveRecentMessages: options.preserveRecentMessages,
    maxToolResultChars: options.maxToolResultChars,
    truncateHeadChars: options.truncateHeadChars
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/**
 * Identity facts the Evidence itself records. Only what is actually present is asserted, so a
 * blob is never rejected for a field its producer never wrote.
 */
function expectedIdentity(evidence: EvidenceSnapshotDto): Partial<TranscriptEventIdentity> {
  const metadata = evidence.metadata;
  const expected: Partial<TranscriptEventIdentity> = { projectId: evidence.projectId };

  if (typeof metadata.sessionId === "string") expected.sessionId = metadata.sessionId;
  if (typeof metadata.stream === "string") expected.stream = metadata.stream;
  if (typeof metadata.externalSessionId === "string" || metadata.externalSessionId === null) {
    expected.externalSessionId = metadata.externalSessionId;
  }
  if (typeof metadata.parserVersion === "string" || metadata.parserVersion === null) {
    expected.parserVersion = metadata.parserVersion;
  }
  return expected;
}

function fallbackStats(messages: readonly CompactionMessage[]): Record<string, unknown> {
  const chars = messages.reduce((sum, message) => sum + compactionMessageChars(message), 0);
  return {
    messagesBefore: messages.length,
    messagesAfter: messages.length,
    charsBefore: chars,
    charsAfter: chars,
    pairedCalls: 0,
    truncatedResults: 0,
    pinnedMessages: 0
  };
}
