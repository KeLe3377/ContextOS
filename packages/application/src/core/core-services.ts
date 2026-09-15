import type { DecisionDto, DecisionInput, DecisionPatch, DecisionStatus } from "../../../contracts/src/decisions.js";
import type { ReviewItemDto, ReviewItemInput } from "../../../contracts/src/review-items.js";
import type { SessionContinueRuntime, ContinueSessionService } from "./runtime-services.js";
import type { SessionDto, SessionInput, SessionPatch, SessionStatus } from "../../../contracts/src/sessions.js";
import type { WorkItemDto, WorkItemInput, WorkItemPatch, WorkItemStatus } from "../../../contracts/src/work-items.js";
import type {
  SqliteDecisionRepository,
  SqliteReviewItemRepository,
  SqliteSessionRepository,
  SqliteWorkItemRepository
} from "../../../infrastructure/src/sqlite/core-repositories.js";
import { nowMs } from "../../../shared/src/clock.js";

export type SessionContinueResult = SessionDto & Partial<SessionContinueRuntime>;

export class SessionService {
  constructor(
    private readonly sessions: SqliteSessionRepository,
    private readonly continueSession?: ContinueSessionService
  ) {}

  create(input: SessionInput): SessionDto {
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

  transition(id: string, action: "continue" | "review" | "archive", expectedRevision: number): SessionContinueResult {
    const status: SessionStatus = action === "continue" ? "RUNNING" : action === "review" ? "PAUSED" : "ARCHIVED";
    const session = this.sessions.updateStatus(id, status, expectedRevision, nowMs());
    if (action !== "continue" || !this.continueSession) return session;
    return { ...session, ...this.continueSession.continue(session) };
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

  patch(id: string, input: DecisionPatch): DecisionDto {
    return this.decisions.patch(id, input, nowMs());
  }

  transition(id: string, action: "propose" | "accept" | "supersede" | "reverse" | "archive" | "review", expectedRevision: number): DecisionDto {
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
  constructor(private readonly workItems: SqliteWorkItemRepository) {}

  create(input: WorkItemInput): WorkItemDto {
    return this.workItems.create(input, nowMs());
  }

  list(input: { projectId?: string; status?: string; q?: string; limit: number }): WorkItemDto[] {
    return this.workItems.list(input);
  }

  get(id: string): WorkItemDto {
    return this.workItems.getByIdOrThrow(id);
  }

  patch(id: string, input: WorkItemPatch): WorkItemDto {
    return this.workItems.patch(id, input, nowMs());
  }

  transition(id: string, action: "mark-ready" | "start" | "block" | "resolve-blocker" | "send-to-review" | "complete" | "reopen" | "cancel", expectedRevision: number): WorkItemDto {
    const statusByAction: Record<typeof action, WorkItemStatus> = {
      "mark-ready": "READY",
      start: "IN_PROGRESS",
      block: "BLOCKED",
      "resolve-blocker": "IN_PROGRESS",
      "send-to-review": "IN_REVIEW",
      complete: "DONE",
      reopen: "BACKLOG",
      cancel: "CANCELED"
    };
    return this.workItems.updateStatus(id, statusByAction[action], expectedRevision, nowMs());
  }
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
    return this.reviewItems.assign(id, reviewerId, expectedRevision, nowMs());
  }

  start(id: string, expectedRevision: number): ReviewItemDto {
    return this.reviewItems.updateStatus(id, "IN_PROGRESS", expectedRevision, nowMs());
  }

  resolve(id: string, input: { resolutionType: string; resolutionReason: string; expectedRevision: number }): ReviewItemDto {
    return this.reviewItems.updateStatus(id, "RESOLVED", input.expectedRevision, nowMs(), {
      type: input.resolutionType,
      reason: input.resolutionReason
    });
  }

  dismiss(id: string, expectedRevision: number): ReviewItemDto {
    return this.reviewItems.updateStatus(id, "DISMISSED", expectedRevision, nowMs());
  }
}


