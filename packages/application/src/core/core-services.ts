import type { ContextPackageDto, EvidenceSnapshotDto } from "../../../contracts/src/context.js";
import type { DecisionDto, DecisionInput, DecisionPatch, DecisionStatus, DecisionVersionDto } from "../../../contracts/src/decisions.js";
import type { ReviewItemDto, ReviewItemInput } from "../../../contracts/src/review-items.js";
import type { SessionContinueRuntime, ContinueSessionService } from "./runtime-services.js";
import type { ResourceActivityEventDto, SessionInterruptRuntimeDto, SessionRuntimeStatusDto } from "../../../contracts/src/runtime.js";
import type { AdapterTranscriptImportInput, AdapterTranscriptImportResult, ResumeCapsuleDto, ResumeCapsulePatch, SessionDto, SessionInput, SessionPatch, SessionStatus, SessionTranscriptEventsDto, TranscriptImportInput, TranscriptImportResult } from "../../../contracts/src/sessions.js";
import type { WorkItemAttemptDto, WorkItemBlockInput, WorkItemDependencyDto, WorkItemDto, WorkItemInput, WorkItemPatch, WorkItemReadinessDto, WorkItemResolveBlockerInput, WorkItemStartSessionInput, WorkItemStartSessionResult, WorkItemStatus } from "../../../contracts/src/work-items.js";
import type {
  SqliteDecisionRepository,
  SqliteReviewItemRepository,
  SqliteSessionRepository,
  SqliteWorkItemRepository
} from "../../../infrastructure/src/sqlite/core-repositories.js";
import type { SqliteProjectRepository } from "../../../infrastructure/src/sqlite/project-repository.js";
import type { RuleService } from "./rule-service.js";
import { nowMs } from "../../../shared/src/clock.js";
import { ContextOsError } from "../../../shared/src/errors.js";

export type SessionContinueResult = SessionDto & Partial<SessionContinueRuntime>;
export type SessionInterruptResult = SessionDto & SessionInterruptRuntimeDto;

export class SessionService {
  constructor(
    private readonly sessions: SqliteSessionRepository,
    private readonly continueSession?: ContinueSessionService,
    private readonly projects?: SqliteProjectRepository,
    private readonly rules?: RuleService
  ) {}

  create(input: SessionInput): SessionDto {
    this.assertProjectAcceptsSessions(input.projectId);
    return this.sessions.create(input, nowMs());
  }

  list(input: { projectId?: string; status?: string; q?: string; limit: number }): SessionDto[] {
    return this.sessions.list(input);
  }

  get(id: string): SessionDto {
    return this.sessions.getByIdOrThrow(id);
  }

  patch(id: string, input: SessionPatch): SessionDto {
    return this.sessions.patch(id, input, nowMs());
  }

  getContextPackage(id: string): ContextPackageDto {
    if (!this.continueSession) throw new Error("Continue session runtime is not configured");
    this.sessions.getByIdOrThrow(id);
    return this.continueSession.getContextPackage(id);
  }

  listEvidence(id: string): EvidenceSnapshotDto[] {
    if (!this.continueSession) throw new Error("Continue session runtime is not configured");
    this.sessions.getByIdOrThrow(id);
    return this.continueSession.listEvidence(id);
  }

  transcriptEvents(id: string): SessionTranscriptEventsDto {
    if (!this.continueSession) throw new Error("Continue session runtime is not configured");
    this.sessions.getByIdOrThrow(id);
    return this.continueSession.getTranscriptEvents(id);
  }

  getResumeCapsule(id: string): ResumeCapsuleDto {
    if (!this.continueSession) throw new Error("Continue session runtime is not configured");
    this.sessions.getByIdOrThrow(id);
    return this.continueSession.getResumeCapsule(id);
  }

  patchResumeCapsule(id: string, input: ResumeCapsulePatch): ResumeCapsuleDto {
    if (!this.continueSession) throw new Error("Continue session runtime is not configured");
    this.sessions.getByIdOrThrow(id);
    return this.continueSession.patchResumeCapsule(id, input);
  }

  importTranscript(id: string, input: TranscriptImportInput): TranscriptImportResult {
    if (!this.continueSession) throw new Error("Continue session runtime is not configured");
    return this.continueSession.importTranscript(this.sessions.getByIdOrThrow(id), input);
  }

  importAdapterTranscript(id: string, input: AdapterTranscriptImportInput): AdapterTranscriptImportResult {
    if (!this.continueSession) throw new Error("Continue session runtime is not configured");
    return this.continueSession.importAdapterTranscript(this.sessions.getByIdOrThrow(id), input);
  }

  runtimeStatus(id: string): SessionRuntimeStatusDto {
    if (!this.continueSession) throw new Error("Continue session runtime is not configured");
    return this.continueSession.inspectStatus(this.sessions.getByIdOrThrow(id));
  }

  activity(id: string): ResourceActivityEventDto[] {
    if (!this.continueSession) throw new Error("Continue session runtime is not configured");
    this.sessions.getByIdOrThrow(id);
    return this.continueSession.listActivity(id);
  }

  interrupt(id: string, expectedRevision: number): SessionInterruptResult {
    if (!this.continueSession) throw new Error("Continue session runtime is not configured");
    const current = this.sessions.getByIdOrThrow(id);
    if (current.revision !== expectedRevision) {
      throw new ContextOsError("CONFLICT", "Session revision conflict", { id, expectedRevision, currentRevision: current.revision });
    }
    assertTransition("Session", current.status, "interrupt", ["RUNNING"]);
    const runtime = this.continueSession.interrupt(current, expectedRevision);
    return { ...this.sessions.getByIdOrThrow(id), ...runtime };
  }

  transition(id: string, action: "continue" | "review" | "archive", expectedRevision: number): SessionContinueResult {
    const current = this.sessions.getByIdOrThrow(id);
    if (current.revision !== expectedRevision) {
      throw new ContextOsError("CONFLICT", "Session revision conflict", { id, expectedRevision, currentRevision: current.revision });
    }
    const allowed: Record<typeof action, SessionStatus[]> = {
      continue: ["CREATED", "PAUSED", "FAILED", "COMPLETED"],
      review: ["RUNNING"],
      archive: ["CREATED", "PAUSED", "FAILED", "COMPLETED"]
    };
    assertTransition("Session", current.status, action, allowed[action]);
    if (action === "continue") {
      this.assertProjectAcceptsSessions(current.projectId);
      this.rules?.evaluateSessionContinue(current);
    }
    const status: SessionStatus = action === "continue" ? "RUNNING" : action === "review" ? "PAUSED" : "ARCHIVED";
    const session = this.sessions.updateStatus(id, status, expectedRevision, nowMs());
    if (action !== "continue" || !this.continueSession) return session;
    const runtime = this.continueSession.continue(session);
    return { ...this.sessions.getByIdOrThrow(id), ...runtime };
  }

  private assertProjectAcceptsSessions(projectId: string): void {
    if (!this.projects) return;
    const project = this.projects.getByIdOrThrow(projectId);
    if (project.status === "ARCHIVED") {
      throw new ContextOsError("CONFLICT", "Archived project cannot create or continue sessions", { projectId });
    }
  }
}

export class DecisionService {
  constructor(private readonly decisions: SqliteDecisionRepository) {}

  create(input: DecisionInput): DecisionDto {
    return this.decisions.create(input, nowMs());
  }

  list(input: { projectId?: string; status?: string; q?: string; limit: number }): DecisionDto[] {
    return this.decisions.list(input);
  }

  get(id: string): DecisionDto {
    return this.decisions.getByIdOrThrow(id);
  }

  versions(id: string): DecisionVersionDto[] {
    this.decisions.getByIdOrThrow(id);
    return this.decisions.listVersions(id);
  }

  patch(id: string, input: DecisionPatch): DecisionDto {
    const current = this.decisions.getByIdOrThrow(id);
    if (["ACCEPTED", "SUPERSEDED", "REVERSED", "ARCHIVED"].includes(current.status)) {
      throw new ContextOsError("CONFLICT", "Accepted or closed decisions cannot be patched; supersede or reverse them", { id, status: current.status });
    }
    return this.decisions.patch(id, input, nowMs());
  }

  transition(id: string, action: "propose" | "accept" | "supersede" | "reverse" | "archive" | "review", expectedRevision: number): DecisionDto {
    const current = this.decisions.getByIdOrThrow(id);
    const allowed: Record<typeof action, DecisionStatus[]> = {
      propose: ["DRAFT"],
      accept: ["DRAFT", "PROPOSED"],
      supersede: ["ACCEPTED"],
      reverse: ["ACCEPTED"],
      archive: ["DRAFT", "PROPOSED", "SUPERSEDED", "REVERSED"],
      review: ["DRAFT", "PROPOSED"]
    };
    assertTransition("Decision", current.status, action, allowed[action]);
    const statusByAction: Record<typeof action, DecisionStatus> = {
      propose: "PROPOSED",
      accept: "ACCEPTED",
      supersede: "SUPERSEDED",
      reverse: "REVERSED",
      archive: "ARCHIVED",
      review: "PROPOSED"
    };
    return this.decisions.updateStatus(id, statusByAction[action], expectedRevision, nowMs());
  }
}

export class WorkItemService {
  constructor(
    private readonly workItems: SqliteWorkItemRepository,
    private readonly sessions?: SqliteSessionRepository,
    private readonly projects?: SqliteProjectRepository
  ) {}

  create(input: WorkItemInput): WorkItemDto {
    if (input.parentId) this.workItems.assertParentInProject(input.parentId, input.projectId);
    return this.workItems.create(input, nowMs());
  }

  list(input: { projectId?: string; status?: string; q?: string; limit: number }): WorkItemDto[] {
    return this.workItems.list(input);
  }

  get(id: string): WorkItemDto {
    return this.workItems.getByIdOrThrow(id);
  }

  patch(id: string, input: WorkItemPatch): WorkItemDto {
    const current = this.workItems.getByIdOrThrow(id);
    if (["DONE", "CANCELED"].includes(current.status)) {
      throw new ContextOsError("CONFLICT", "Completed or canceled work items cannot be patched", { id, status: current.status });
    }
    if (input.parentId !== undefined) this.workItems.assertValidParent(id, input.parentId);
    if (input.dependencyIds !== undefined) this.workItems.assertValidDependencies(id, input.dependencyIds);
    return this.workItems.patch(id, input, nowMs());
  }

  readiness(id: string): WorkItemReadinessDto {
    const item = this.workItems.getByIdOrThrow(id);
    const blockers = this.workItems.listDependencies(id).filter((dependency) => dependency.status !== "DONE");
    const blockerReason = item.status === "BLOCKED" && typeof item.readinessState.blocker === "object" && item.readinessState.blocker !== null
      ? String((item.readinessState.blocker as Record<string, unknown>).reason || "Blocked")
      : null;
    return { ready: blockers.length === 0 && blockerReason === null, blockerReason, blockers };
  }

  dependencies(id: string): WorkItemDependencyDto[] {
    this.workItems.getByIdOrThrow(id);
    return this.workItems.listDependencies(id);
  }

  children(id: string): WorkItemDto[] {
    this.workItems.getByIdOrThrow(id);
    return this.workItems.listChildren(id);
  }

  activity(id: string): ResourceActivityEventDto[] {
    this.workItems.getByIdOrThrow(id);
    return this.workItems.listActivity(id);
  }

  attempts(id: string): WorkItemAttemptDto[] {
    this.workItems.getByIdOrThrow(id);
    return this.workItems.listAttempts(id);
  }

  startSession(id: string, input: WorkItemStartSessionInput): WorkItemStartSessionResult {
    if (!this.sessions || !this.projects) throw new Error("Work Item session runtime is not configured");
    const current = this.workItems.getByIdOrThrow(id);
    if (!["READY", "IN_PROGRESS"].includes(current.status)) {
      throw new ContextOsError("CONFLICT", "Work Item must be ready before starting an agent session", { id, status: current.status });
    }
    if (current.revision !== input.expectedRevision) {
      throw new ContextOsError("CONFLICT", "Work Item revision conflict", { id, expectedRevision: input.expectedRevision, actualRevision: current.revision });
    }
    const readiness = this.readiness(id);
    if (!readiness.ready) {
      throw new ContextOsError("CONFLICT", "Work Item has incomplete dependencies", { id });
    }
    const project = this.projects.getByIdOrThrow(current.projectId);
    const agentAdapterId = input.agentAdapterId ?? project.agentAdapterIds[0] ?? "codex";
    const session = this.sessions.create({
      projectId: current.projectId,
      agentAdapterId,
      title: input.title ?? `Work: ${current.title}`,
      intent: input.intent ?? formatWorkItemIntent(current)
    }, nowMs());
    const attempt = this.workItems.recordSessionAttempt({
      workItemId: id,
      expectedRevision: input.expectedRevision,
      sessionId: session.id,
      summary: `Started agent session for Work Item: ${current.title}`
    }, nowMs());
    return { workItem: this.workItems.getByIdOrThrow(id), attempt, session };
  }

  block(id: string, input: WorkItemBlockInput): WorkItemDto {
    const current = this.workItems.getByIdOrThrow(id);
    assertTransition("Work Item", current.status, "block", ["IN_PROGRESS"]);
    return this.workItems.updateBlockState(id, "BLOCKED", input.expectedRevision, { reason: input.reason }, nowMs());
  }

  resolveBlocker(id: string, input: WorkItemResolveBlockerInput): WorkItemDto {
    const current = this.workItems.getByIdOrThrow(id);
    assertTransition("Work Item", current.status, "resolve-blocker", ["BLOCKED"]);
    return this.workItems.updateBlockState(id, "IN_PROGRESS", input.expectedRevision, { resolution: input.resolution }, nowMs());
  }

  transition(id: string, action: "mark-ready" | "start" | "send-to-review" | "complete" | "reopen" | "cancel", expectedRevision: number): WorkItemDto {
    const current = this.workItems.getByIdOrThrow(id);
    const allowed: Record<typeof action, WorkItemStatus[]> = {
      "mark-ready": ["BACKLOG"],
      start: ["READY"],
      "send-to-review": ["IN_PROGRESS"],
      complete: ["IN_PROGRESS", "IN_REVIEW"],
      reopen: ["DONE", "CANCELED"],
      cancel: ["BACKLOG", "READY", "IN_PROGRESS", "BLOCKED", "IN_REVIEW"]
    };
    assertTransition("Work Item", current.status, action, allowed[action]);
    if ((action === "mark-ready" || action === "start") && !this.readiness(id).ready) {
      throw new ContextOsError("CONFLICT", "Work Item has incomplete dependencies", { id });
    }
    const statusByAction: Record<typeof action, WorkItemStatus> = {
      "mark-ready": "READY",
      start: "IN_PROGRESS",
      "send-to-review": "IN_REVIEW",
      complete: "DONE",
      reopen: "BACKLOG",
      cancel: "CANCELED"
    };
    return this.workItems.updateStatus(id, statusByAction[action], expectedRevision, nowMs());
  }
}

function formatWorkItemIntent(item: WorkItemDto): string {
  const acceptance = item.acceptance.length ? item.acceptance.map((value) => `- ${value}`).join("\n") : "- No acceptance criteria recorded.";
  return [
    `Execute Work Item: ${item.title}`,
    "",
    item.description ? `Description:\n${item.description}` : "Description: not recorded.",
    "",
    "Acceptance Criteria:",
    acceptance,
    "",
    item.executionContract ? `Execution Contract:\n${item.executionContract}` : "Execution Contract: use repository validation and report evidence."
  ].join("\n");
}

export class ReviewItemService {
  constructor(private readonly reviewItems: SqliteReviewItemRepository) {}

  create(input: ReviewItemInput): ReviewItemDto {
    return this.reviewItems.create(input, nowMs());
  }

  list(input: { projectId?: string; status?: string; q?: string; limit: number }): ReviewItemDto[] {
    return this.reviewItems.list(input);
  }

  get(id: string): ReviewItemDto {
    return this.reviewItems.getByIdOrThrow(id);
  }

  assign(id: string, reviewerId: string, expectedRevision: number): ReviewItemDto {
    const current = this.reviewItems.getByIdOrThrow(id);
    assertTransition("Review Item", current.status, "assign", ["OPEN", "IN_PROGRESS"]);
    return this.reviewItems.assign(id, reviewerId, expectedRevision, nowMs());
  }

  start(id: string, expectedRevision: number): ReviewItemDto {
    const current = this.reviewItems.getByIdOrThrow(id);
    assertTransition("Review Item", current.status, "start", ["OPEN"]);
    return this.reviewItems.updateStatus(id, "IN_PROGRESS", expectedRevision, nowMs());
  }

  resolve(id: string, input: { resolutionType: string; resolutionReason: string; expectedRevision: number }): ReviewItemDto {
    const current = this.reviewItems.getByIdOrThrow(id);
    assertTransition("Review Item", current.status, "resolve", ["OPEN", "IN_PROGRESS"]);
    return this.reviewItems.updateStatus(id, "RESOLVED", input.expectedRevision, nowMs(), {
      type: input.resolutionType,
      reason: input.resolutionReason
    });
  }

  dismiss(id: string, input: { resolutionReason: string; expectedRevision: number }): ReviewItemDto {
    const current = this.reviewItems.getByIdOrThrow(id);
    assertTransition("Review Item", current.status, "dismiss", ["OPEN", "IN_PROGRESS"]);
    return this.reviewItems.updateStatus(id, "DISMISSED", input.expectedRevision, nowMs(), {
      type: "DISMISSED",
      reason: input.resolutionReason
    });
  }

  actionLog(id: string): Array<Record<string, unknown>> {
    this.reviewItems.getByIdOrThrow(id);
    return this.reviewItems.listActionLog(id);
  }
}

function assertTransition(type: string, status: string, action: string, allowed: string[]): void {
  if (allowed.includes(status)) return;
  throw new ContextOsError("CONFLICT", `${type} cannot ${action} from ${status}`, { status, action });
}
