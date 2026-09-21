import type { ContextItemDto, ContextItemInput } from "../../../contracts/src/context.js";
import type { ExtractionCandidateDto } from "../../../contracts/src/automation.js";
import type { ReviewItemDto } from "../../../contracts/src/review-items.js";
import { ContextOsError } from "../../../shared/src/errors.js";
import { nowMs } from "../../../shared/src/clock.js";
import type { SqliteAutomationRepository } from "../../../infrastructure/src/sqlite/automation-repository.js";
import type { SqliteReviewItemRepository } from "../../../infrastructure/src/sqlite/core-repositories.js";
import {
  reviewSourceTypeExtractionCandidate
} from "../../../contracts/src/review-items.js";
import type { ContextItemService } from "./context-services.js";
import type { SessionService } from "./core-services.js";

/**
 * Applies accepted candidates by writing the governed object they describe.
 *
 * The rule this service exists to enforce: a candidate may only become `ACCEPTED` in the same
 * transaction that creates or updates the domain object it points at, and it must record the
 * target resource. That is why every path below writes the object first and only then transitions
 * the candidate, and why an `ACCEPTED` candidate without a target is not a state this service can
 * produce.
 *
 * Target resources, as agreed for this stage:
 * - Resume Capsule → `targetResourceType = SESSION`, `targetResourceId = <session id>`
 * - Context Item  → `targetResourceType = CONTEXT_ITEM`, `targetResourceId = <context item id>`
 *
 * A Resume Capsule candidate with no Session stays PENDING and raises a stable failure code. The
 * target Session is never guessed.
 *
 * Design: docs/2026-09-20-contextos-jev-compaction-integration-design.md §12,
 * docs/superpowers/specs/2026-09-20-contextos-zero-input-automation-design.md §7.8
 */

export type CandidateApplicationFailureCode =
  | "CANDIDATE_NOT_FOUND"
  | "CANDIDATE_NOT_APPLICABLE"
  | "CANDIDATE_KIND_NOT_APPLICABLE"
  | "CANDIDATE_TARGET_SESSION_MISSING"
  | "CANDIDATE_REVISION_CONFLICT"
  | "CANDIDATE_APPLICATION_FAILED";

/** Stable, retryable failure. Only ids and codes travel with it. */
export class CandidateApplicationError extends Error {
  readonly code: CandidateApplicationFailureCode;

  constructor(code: CandidateApplicationFailureCode, message: string) {
    super(message);
    this.name = "CandidateApplicationError";
    this.code = code;
  }
}

export type CandidateApplicationOutcome = "APPLIED" | "ALREADY_APPLIED" | "REJECTED" | "ALREADY_REJECTED";

export type CandidateApplicationResult = {
  outcome: CandidateApplicationOutcome;
  candidate: ExtractionCandidateDto;
  target: { resourceType: string; resourceId: string } | null;
};

export type CandidateApplicationServiceOptions = {
  automation: SqliteAutomationRepository;
  /** Used for the Resume Capsule path: the existing session capsule patch route. */
  sessions: SessionService;
  contextItems: ContextItemService;
  reviewItems: SqliteReviewItemRepository;
  clock?: () => number;
};

export class CandidateApplicationService {
  constructor(private readonly options: CandidateApplicationServiceOptions) {}

  /**
   * Materialises the candidate's content and marks it ACCEPTED, atomically.
   *
   * Idempotent: applying an already accepted candidate returns its recorded target instead of
   * writing a second governed object.
   */
  apply(input: { candidateId: string; expectedRevision: number; actorType?: "USER" | "SYSTEM" }): CandidateApplicationResult {
    const now = this.now();
    const before = this.requireCandidate(input.candidateId);

    if (before.status === "ACCEPTED") {
      return {
        outcome: "ALREADY_APPLIED",
        candidate: before,
        target: before.targetResourceId ? { resourceType: before.targetResourceType ?? "", resourceId: before.targetResourceId } : null
      };
    }

    if (before.status === "REJECTED" || before.status === "SUPERSEDED") {
      throw new CandidateApplicationError("CANDIDATE_NOT_APPLICABLE", "Candidate is no longer open");
    }

    return this.options.automation.runApplicationTransaction(() => {
      const target = this.materialise(before);

      let candidate: ExtractionCandidateDto;
      try {
        candidate = this.options.automation.transitionCandidate(
          { id: before.id, status: "ACCEPTED", expectedRevision: input.expectedRevision, target },
          now
        );
      } catch (error) {
        if (error instanceof ContextOsError && error.code === "CONFLICT") {
          // A concurrent review changed the candidate first; it stays PENDING for the next attempt.
          throw new CandidateApplicationError("CANDIDATE_REVISION_CONFLICT", "Candidate revision conflict");
        }
        throw error;
      }

      this.options.automation.recordCandidateAudit({
        projectId: candidate.projectId,
        candidateId: candidate.id,
        action: "APPLY",
        eventType: "CANDIDATE_APPLIED",
        summary: `Applied ${candidate.kind} candidate to ${target.resourceType}`,
        before,
        after: candidate,
        actorType: input.actorType ?? "USER",
        now
      });

      return {
        outcome: "APPLIED" as CandidateApplicationOutcome,
        candidate,
        target
      };
    });
  }

  /** Marks a candidate REJECTED. Idempotent: a rejected candidate is returned unchanged. */
  reject(input: { candidateId: string; expectedRevision: number; actorType?: "USER" | "SYSTEM"; reason?: string }): CandidateApplicationResult {
    const now = this.now();
    const before = this.requireCandidate(input.candidateId);

    if (before.status === "REJECTED") {
      return { outcome: "ALREADY_REJECTED", candidate: before, target: null };
    }
    if (before.status === "ACCEPTED") {
      throw new CandidateApplicationError("CANDIDATE_NOT_APPLICABLE", "Candidate was already applied");
    }

    return this.options.automation.runApplicationTransaction(() => {
      let candidate: ExtractionCandidateDto;
      try {
        candidate = this.options.automation.transitionCandidate(
          {
            id: before.id,
            status: "REJECTED",
            expectedRevision: input.expectedRevision,
            target: null,
            supersededById: null
          },
          now
        );
      } catch (error) {
        if (error instanceof ContextOsError && error.code === "CONFLICT") {
          throw new CandidateApplicationError("CANDIDATE_REVISION_CONFLICT", "Candidate revision conflict");
        }
        throw error;
      }

      this.options.automation.recordCandidateAudit({
        projectId: candidate.projectId,
        candidateId: candidate.id,
        action: "REJECT",
        eventType: "CANDIDATE_REJECTED",
        summary: input.reason ? `Rejected ${candidate.kind} candidate` : `Rejected ${candidate.kind} candidate`,
        before,
        after: candidate,
        actorType: input.actorType ?? "USER",
        now
      });

      return { outcome: "REJECTED" as CandidateApplicationOutcome, candidate, target: null };
    });
  }

  /**
   * Links a Review Item decision to the candidate it was raised for.
   *
   * The candidate is applied or rejected first, and only then is the Review Item closed, so a
   * failed application leaves the item open for another attempt instead of silently dropping the
   * suggestion.
   */
  resolveReviewItem(input: {
    reviewItemId: string;
    expectedRevision: number;
    resolutionType: string;
    resolutionReason: string;
    actorType?: "USER" | "SYSTEM";
  }): { reviewItem: ReviewItemDto; application: CandidateApplicationResult } {
    const item = this.options.reviewItems.getById(input.reviewItemId);
    if (!item) throw new CandidateApplicationError("CANDIDATE_NOT_FOUND", "Review item not found");
    if (item.sourceType !== reviewSourceTypeExtractionCandidate) {
      throw new CandidateApplicationError("CANDIDATE_NOT_APPLICABLE", "Review item is not a candidate suggestion");
    }

    // One transaction spans the candidate decision, the governed object, the candidate status
    // and the Review Item. Nesting `apply`/`reject` inside it is safe because better-sqlite3
    // uses savepoints, so a Review Item conflict rolls everything back and cannot leave an
    // accepted candidate behind an open review.
    const result = this.options.automation.runApplicationTransaction(() => {
      const candidate = this.requireCandidate(item.sourceId);
      const approved = input.resolutionType === "APPROVED" || input.resolutionType === "ACCEPT";

      const application = approved
        ? this.apply({ candidateId: candidate.id, expectedRevision: candidate.revision, actorType: input.actorType })
        : this.reject({ candidateId: candidate.id, expectedRevision: candidate.revision, actorType: input.actorType, reason: input.resolutionReason });

      const reviewItem = this.options.reviewItems.updateStatus(
        input.reviewItemId,
        approved ? "RESOLVED" : "DISMISSED",
        input.expectedRevision,
        this.now(),
        { type: input.resolutionType, reason: input.resolutionReason }
      );

      return { reviewItem, application };
    });

    return result;
  }

  private requireCandidate(candidateId: string): ExtractionCandidateDto {
    const candidate = this.options.automation.getCandidate(candidateId);
    if (!candidate) throw new CandidateApplicationError("CANDIDATE_NOT_FOUND", "Extraction candidate not found");
    return candidate;
  }

  /** Writes the governed object and returns the target reference for the candidate row. */
  private materialise(candidate: ExtractionCandidateDto): { resourceType: string; resourceId: string } {
    if (candidate.kind === "RESUME_CAPSULE" && candidate.payload.kind === "RESUME_CAPSULE") {
      // The target Session must come from the candidate; guessing one would attach the capsule to
      // the wrong session.
      if (!candidate.sessionId) {
        throw new CandidateApplicationError("CANDIDATE_TARGET_SESSION_MISSING", "Resume capsule candidate has no Session");
      }
      // The capsule patch route is guarded by the Session's optimistic revision.
      const session = this.options.sessions.get(candidate.sessionId);
      this.options.sessions.patchResumeCapsule(candidate.sessionId, {
        summary: candidate.payload.summary,
        nextAction: candidate.payload.nextAction,
        expectedRevision: session.revision
      });
      return { resourceType: "SESSION", resourceId: candidate.sessionId };
    }

    if (candidate.kind === "CONTEXT_ITEM" && candidate.payload.kind === "CONTEXT_ITEM") {
      const created = this.options.contextItems.create(contextItemInputFor(candidate));
      const active = this.activate(created);
      return { resourceType: "CONTEXT_ITEM", resourceId: active.id };
    }

    throw new CandidateApplicationError("CANDIDATE_KIND_NOT_APPLICABLE", "Candidate kind cannot be applied at this stage");
  }

  /** Activates only when the project is allowed to hold the item active automatically. */
  private activate(item: ContextItemDto): ContextItemDto {
    return this.options.contextItems.transition(item.id, "activate", item.revision);
  }

  private now(): number {
    return this.options.clock?.() ?? nowMs();
  }
}

function contextItemInputFor(candidate: ExtractionCandidateDto): ContextItemInput {
  if (candidate.payload.kind !== "CONTEXT_ITEM") {
    throw new CandidateApplicationError("CANDIDATE_KIND_NOT_APPLICABLE", "Candidate is not a context item");
  }
  return {
    projectId: candidate.projectId,
    ...(candidate.sourceEvidenceId ? { sourceSnapshotId: candidate.sourceEvidenceId } : {}),
    itemType: candidate.payload.itemType,
    title: candidate.payload.title,
    summary: candidate.payload.summary,
    ...(candidate.payload.body === undefined ? {} : { body: candidate.payload.body }),
    confidence: candidate.payload.confidence,
    metadata: { candidateId: candidate.id, extractorId: candidate.extractorId }
  };
}
