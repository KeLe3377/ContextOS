import { createHash } from "node:crypto";
import type { CompactionArtifactDto } from "../../../contracts/src/compaction.js";
import type {
  AutomationMode,
  ExtractionCandidateProvenance
} from "../../../contracts/src/automation.js";
import type { EvidenceSnapshotDto } from "../../../contracts/src/context.js";
import {
  reviewSourceTypeExtractionCandidate,
  reviewTriggerAutomationSuggestion
} from "../../../contracts/src/review-items.js";
import type { AutomationJobRecord, SqliteAutomationRepository } from "../../../infrastructure/src/sqlite/automation-repository.js";
import type { SqliteCompactionArtifactRepository } from "../../../infrastructure/src/sqlite/compaction-artifact-repository.js";
import type { SqliteReviewItemRepository, SqliteSessionRepository } from "../../../infrastructure/src/sqlite/core-repositories.js";
import { ContextOsError } from "../../../shared/src/errors.js";
import { nowMs } from "../../../shared/src/clock.js";
import { buildExtractionInput } from "./extraction-input.js";
import {
  computeExtractionFingerprint,
  toContextItemCandidate,
  toResumeCapsuleCandidate,
  type CandidateDraft
} from "./extraction-candidate-mapping.js";
import type { ContextExtractor, ExtractionInput, ExtractionResult } from "../ports/context-extractor.js";
import { CandidateApplicationError, type CandidateApplicationService } from "./candidate-application-service.js";
import type { EvidenceSnapshotService } from "./context-services.js";

/**
 * Turns one compaction artifact into persisted candidates and the Review Items that surface them.
 *
 * The order below is the whole point of this service:
 * 1. load and validate the artifact, using the repository's strict mapper;
 * 2. build the bounded input;
 * 3. run the extractor — a subprocess, always *outside* any database transaction;
 * 4. validate the output and compute every fingerprint locally;
 * 5. open one transaction and persist candidates, Evidence links and Review Items together;
 * 6. only then return, so the scheduler can mark the job SUCCEEDED.
 *
 * Automatic acceptance is handed to CandidateApplicationService inside the same transaction, so a
 * candidate only leaves this service ACCEPTED once the governed object exists and the target
 * reference is recorded. Anything that cannot be applied automatically stays PENDING with a Review
 * Item rather than failing the extraction.
 *
 * A failure anywhere in step 5 rolls the whole unit back and leaves the job to retry. Nothing is
 * written when the project is OFF, and nothing is written when the extractor fails.
 *
 * Review Items follow the automation design: `sourceType` is `EXTRACTION_CANDIDATE` and
 * `sourceId` is the candidate id, which is what keeps retries from piling up duplicates.
 */

export type ExtractionPipelineFailureCode =
  | "COMPACTION_ARTIFACT_NOT_FOUND"
  | "COMPACTION_ARTIFACT_INVALID"
  | "EXTRACTION_SOURCE_MISMATCH"
  | "EXTRACTION_OUTPUT_INVALID"
  | "EXTRACTION_EVIDENCE_OUT_OF_SCOPE"
  | "EXTRACTION_PERSISTENCE_FAILED";

/** Stable, retryable failure. Only ids, hashes, counts and codes travel with it. */
export class ExtractionPipelineError extends Error {
  readonly code: ExtractionPipelineFailureCode;

  constructor(code: ExtractionPipelineFailureCode, message: string) {
    super(message);
    this.name = "ExtractionPipelineError";
    this.code = code;
  }
}

export type ExtractionServiceOptions = {
  automation: SqliteAutomationRepository;
  artifacts: SqliteCompactionArtifactRepository;
  /** Read through the application service so Evidence always comes from verified storage. */
  evidence: EvidenceSnapshotService;
  sessions: SqliteSessionRepository;
  reviewItems: SqliteReviewItemRepository;
  extractor: ContextExtractor;
  /**
   * Used to materialise candidates the policy marked eligible. Without it — or when an
   * application cannot be performed — the candidate falls back to PENDING plus a Review Item,
   * which keeps a missing application step from failing the whole extraction.
   */
  application?: CandidateApplicationService;
  clock?: () => number;
};

export type ExtractionRunSummary = {
  artifactId: string;
  sourceEvidenceId: string;
  mode: AutomationMode;
  /** True when the project switched to OFF and the run deliberately wrote nothing. */
  skipped: boolean;
  candidatesCreated: number;
  candidatesReused: number;
  /** Candidates the policy marked eligible for automatic acceptance. */
  autoAcceptEligible: number;
  /** Candidates actually materialised and marked ACCEPTED in this run. */
  autoAccepted: number;
  reviewItemsCreated: number;
  inputItems: number;
  inputChars: number;
  extractionInputHash: string;
};

/** One mapped candidate plus the Evidence it is allowed to cite. */
type DraftWithEvidence = CandidateDraft & { evidenceIds: string[] };

export class ExtractionService {
  constructor(private readonly options: ExtractionServiceOptions) {}

  /** Dispatcher entry point for EXTRACT_EVIDENCE_CONTEXT jobs. */
  async handleExtractionJob(job: AutomationJobRecord): Promise<void> {
    const payload = job.payload as { artifactId?: unknown; sourceEvidenceId?: unknown };
    if (typeof payload.artifactId !== "string" || typeof payload.sourceEvidenceId !== "string" || job.projectId === null) {
      throw new ExtractionPipelineError("EXTRACTION_SOURCE_MISMATCH", "Extraction job is missing its artifact reference");
    }

    await this.extractArtifact({
      projectId: job.projectId,
      artifactId: payload.artifactId,
      sourceEvidenceId: payload.sourceEvidenceId
    });
  }

  async extractArtifact(input: {
    projectId: string;
    artifactId: string;
    sourceEvidenceId: string;
  }): Promise<ExtractionRunSummary> {
    const now = this.now();
    const settings = this.options.automation.getSettings(input.projectId, now);

    // OFF means no automatic output. The run succeeds so the job does not retry forever.
    if (settings.mode === "OFF") {
      return {
        artifactId: input.artifactId,
        sourceEvidenceId: input.sourceEvidenceId,
        mode: settings.mode,
        skipped: true,
        candidatesCreated: 0,
        candidatesReused: 0,
        autoAcceptEligible: 0,
        autoAccepted: 0,
        reviewItemsCreated: 0,
        inputItems: 0,
        inputChars: 0,
        extractionInputHash: ""
      };
    }

    const artifact = this.loadVerifiedArtifact(input);
    const extractionInput = buildExtractionInput({
      artifact,
      projectIntent: null,
      sessionIntent: artifact.sessionId ? this.options.sessions.getById(artifact.sessionId)?.intent ?? null : null,
      knownCandidateFingerprints: this.knownFingerprints(input.projectId)
    });

    // Subprocess call: strictly before any database transaction.
    const result = await this.options.extractor.extract(extractionInput);
    const drafts = this.toDrafts(result, input.sourceEvidenceId);
    const provenance: ExtractionCandidateProvenance = {
      sourceArtifactId: artifact.id,
      sourceEvidenceId: input.sourceEvidenceId,
      extractorId: result.extractorId,
      extractorVersion: result.extractorVersion,
      extractionInputHash: hashExtractionInput(extractionInput)
    };

    const persisted = this.options.automation.runExtractionTransaction(() => this.persist({
      projectId: input.projectId,
      sessionId: artifact.sessionId,
      mode: settings.mode,
      autoAcceptThreshold: settings.autoAcceptThreshold,
      sourceEvidenceId: input.sourceEvidenceId,
      drafts,
      provenance,
      now
    }));

    this.options.automation.markProjectActivity(input.projectId, "EXTRACTION", now);

    return {
      artifactId: artifact.id,
      sourceEvidenceId: input.sourceEvidenceId,
      mode: settings.mode,
      skipped: false,
      candidatesCreated: persisted.candidatesCreated,
      candidatesReused: persisted.candidatesReused,
      autoAcceptEligible: persisted.autoAcceptEligible,
      autoAccepted: persisted.autoAccepted,
      reviewItemsCreated: persisted.reviewItemsCreated,
      inputItems: extractionInput.transcript.length,
      inputChars: extractionInput.transcript.reduce((total, item) => total + item.text.length, 0),
      extractionInputHash: provenance.extractionInputHash ?? ""
    };
  }

  /**
   * Loads the artifact and proves it belongs to the expected project and Evidence. The repository's
   * strict mapper has already validated the stored JSON and the source content hash against the
   * Evidence row, so anything reaching this point is structurally sound.
   */
  private loadVerifiedArtifact(input: {
    projectId: string;
    artifactId: string;
    sourceEvidenceId: string;
  }): CompactionArtifactDto {
    let artifact: CompactionArtifactDto;
    try {
      artifact = this.options.artifacts.getByIdOrThrow(input.artifactId);
    } catch (error) {
      if (error instanceof ContextOsError && error.code === "NOT_FOUND") {
        throw new ExtractionPipelineError("COMPACTION_ARTIFACT_NOT_FOUND", "Compaction artifact not found");
      }
      throw error;
    }

    if (artifact.projectId !== input.projectId || artifact.sourceEvidenceId !== input.sourceEvidenceId) {
      throw new ExtractionPipelineError("EXTRACTION_SOURCE_MISMATCH", "Artifact does not belong to the expected project and Evidence");
    }

    let evidence: EvidenceSnapshotDto;
    try {
      evidence = this.options.evidence.get(input.sourceEvidenceId);
    } catch (error) {
      if (error instanceof ContextOsError && error.code === "NOT_FOUND") {
        throw new ExtractionPipelineError("EXTRACTION_SOURCE_MISMATCH", "Source Evidence not found");
      }
      throw error;
    }

    if (evidence.projectId !== input.projectId) {
      throw new ExtractionPipelineError("EXTRACTION_SOURCE_MISMATCH", "Source Evidence belongs to another project");
    }

    return artifact;
  }

  /** Existing candidate fingerprints, so the extractor can avoid repeating itself. */
  private knownFingerprints(projectId: string): string[] {
    return this.options.automation
      .listCandidates({ projectId, limit: 200 })
      .filter((candidate) => candidate.status === "PENDING" || candidate.status === "ACCEPTED")
      .map((candidate) => candidate.fingerprint);
  }

  /** Maps the extractor's output and re-checks that every citation stays inside this run. */
  private toDrafts(result: ExtractionResult, sourceEvidenceId: string): DraftWithEvidence[] {
    const drafts: DraftWithEvidence[] = [
      { ...toResumeCapsuleCandidate(result.resumeCapsule), evidenceIds: [sourceEvidenceId] }
    ];

    for (const candidate of result.candidates) {
      if (!candidate.evidenceIds.includes(sourceEvidenceId)) {
        throw new ExtractionPipelineError("EXTRACTION_EVIDENCE_OUT_OF_SCOPE", "A candidate did not cite the source Evidence");
      }
      for (const evidenceId of candidate.evidenceIds) {
        if (evidenceId !== sourceEvidenceId) {
          throw new ExtractionPipelineError("EXTRACTION_EVIDENCE_OUT_OF_SCOPE", "A candidate cited Evidence outside this run");
        }
      }
      drafts.push({ ...toContextItemCandidate(candidate), evidenceIds: [sourceEvidenceId] });
    }

    return drafts;
  }

  private persist(input: {
    projectId: string;
    sessionId: string | null;
    mode: AutomationMode;
    autoAcceptThreshold: number;
    sourceEvidenceId: string;
    drafts: DraftWithEvidence[];
    provenance: ExtractionCandidateProvenance;
    now: number;
  }): { candidatesCreated: number; candidatesReused: number; autoAcceptEligible: number; autoAccepted: number; reviewItemsCreated: number } {
    let candidatesCreated = 0;
    let candidatesReused = 0;
    let autoAcceptEligible = 0;
    let autoAccepted = 0;
    let reviewItemsCreated = 0;

    for (const draft of input.drafts) {
      // The model's fingerprint is never trusted: identity is recomputed from the draft itself.
      const fingerprint = computeExtractionFingerprint({
        projectId: input.projectId,
        kind: draft.kind,
        material: draft.fingerprintMaterial,
        evidenceIds: draft.evidenceIds
      });

      const { candidate, created } = this.options.automation.upsertCandidate(
        {
          projectId: input.projectId,
          sessionId: input.sessionId,
          sourceEvidenceId: input.sourceEvidenceId,
          evidenceIds: draft.evidenceIds,
          kind: draft.kind,
          fingerprint,
          payload: draft.payload,
          confidence: draft.confidence,
          extractorId: input.provenance.extractorId ?? "",
          extractorVersion: input.provenance.extractorVersion ?? "",
          provenance: input.provenance
        },
        input.now
      );
      if (created) candidatesCreated += 1;
      else candidatesReused += 1;

      const disposition = decideDisposition({
        mode: input.mode,
        draft,
        threshold: input.autoAcceptThreshold
      });
      if (disposition.disposition === "AUTO_ACCEPT") {
        autoAcceptEligible += 1;
        if (this.tryApply(input, candidate)) {
          autoAccepted += 1;
          continue;
        }
      }

      // Not applied automatically: it stays PENDING and gets a Review Item. An ACCEPTED candidate
      // never leaves this loop, because it already carries its target.
      if (candidate.status === "ACCEPTED") continue;

      const existing = this.openReviewItemCount(input.projectId, candidate.id);
      this.options.reviewItems.findOrCreateOpen(
        {
          projectId: input.projectId,
          sourceType: reviewSourceTypeExtractionCandidate,
          sourceId: candidate.id,
          triggerType: reviewTriggerAutomationSuggestion,
          priority: "MEDIUM",
          summary: reviewSummaryFor(draft)
        },
        input.now
      );
      if (existing === 0) reviewItemsCreated += 1;
    }

    return { candidatesCreated, candidatesReused, autoAcceptEligible, autoAccepted, reviewItemsCreated };
  }

  /**
   * Materialises an eligible candidate inside the surrounding transaction.
   *
   * Returns false when the application cannot be performed for a deterministic reason, so the
   * caller can fall back to review instead of failing the whole extraction and retrying forever.
   */
  private tryApply(input: { projectId: string; drafts: DraftWithEvidence[]; now: number }, candidate: ReturnType<SqliteAutomationRepository["getCandidateOrThrow"]>): boolean {
    if (!this.options.application) return false;
    try {
      // Only a first application counts; an already applied candidate is simply reused, so a
      // retry reports zero new acceptances instead of re-counting the same one.
      return this.options.application.apply({ candidateId: candidate.id, expectedRevision: candidate.revision, actorType: "SYSTEM" }).outcome === "APPLIED";
    } catch (error) {
      if (error instanceof CandidateApplicationError && deferrableApplicationCodes.has(error.code)) return false;
      throw error;
    }
  }

  private openReviewItemCount(projectId: string, candidateId: string): number {
    return this.options.reviewItems.list({ projectId, limit: 200 }).filter((item) =>
      item.sourceType === reviewSourceTypeExtractionCandidate &&
      item.sourceId === candidateId &&
      (item.status === "OPEN" || item.status === "IN_PROGRESS")
    ).length;
  }

  private now(): number {
    return this.options.clock?.() ?? nowMs();
  }
}

/**
 * Why a candidate can be left to a human even when the policy granted eligibility. The policy
 * decision and the application are two separate stages, and only the second one may move a
 * candidate to ACCEPTED.
 */
export const acceptanceDeferralReason = "APPLICATION_PENDING";

/** Application failures that mean "leave it to a human", not "retry the extraction". */
const deferrableApplicationCodes = new Set([
  "CANDIDATE_TARGET_SESSION_MISSING",
  "CANDIDATE_KIND_NOT_APPLICABLE",
  "CANDIDATE_NOT_APPLICABLE"
]);

export type CandidateDisposition = "REVIEW" | "AUTO_ACCEPT";

export type DispositionReason =
  | "SUGGEST_ONLY"
  | "NOT_WHITELISTED"
  | "BELOW_THRESHOLD"
  | "WHITELISTED";

/**
 * Automation policy, taken from the zero-input automation design rather than invented here:
 * `AUTO_ACCEPT_HIGH_CONFIDENCE` may only accept low-risk types above the project threshold, and
 * the first-stage whitelist is Resume Capsule plus SUMMARY/HANDOFF context items. Decisions, work
 * items, rules, constraints and risks always go to review however confident they are.
 *
 * This function answers exactly one question — *is this candidate eligible for automatic
 * acceptance?* — and nothing else. Applying an acceptance is a separate stage, performed by
 * CandidateApplicationService inside `persist`: the automation design requires the domain service
 * to materialise the governed object, and the candidate status update has to share a transaction
 * with that application. An `AUTO_ACCEPT` verdict here therefore means "may be applied", not
 * "has been accepted".
 */
export function decideDisposition(input: {
  mode: AutomationMode;
  draft: CandidateDraft;
  threshold: number;
}): { disposition: CandidateDisposition; reason: DispositionReason } {
  if (input.mode !== "AUTO_ACCEPT_HIGH_CONFIDENCE") {
    return { disposition: "REVIEW", reason: "SUGGEST_ONLY" };
  }

  const whitelisted =
    input.draft.kind === "RESUME_CAPSULE" ||
    (input.draft.payload.kind === "CONTEXT_ITEM" &&
      (input.draft.payload.itemType === "SUMMARY" || input.draft.payload.itemType === "HANDOFF"));

  if (!whitelisted) return { disposition: "REVIEW", reason: "NOT_WHITELISTED" };
  if (input.draft.confidence < input.threshold) return { disposition: "REVIEW", reason: "BELOW_THRESHOLD" };

  return { disposition: "AUTO_ACCEPT", reason: "WHITELISTED" };
}

function reviewSummaryFor(draft: CandidateDraft): string {
  if (draft.payload.kind === "RESUME_CAPSULE") return "Extracted resume capsule candidate";
  if (draft.payload.kind === "CONTEXT_ITEM") {
    return `Extracted ${draft.payload.itemType} context item candidate: ${draft.payload.title}`;
  }
  return "Extracted candidate";
}

/** Hash of the run's input facts, for audit and replay only. */
function hashExtractionInput(input: ExtractionInput): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex")}`;
}
