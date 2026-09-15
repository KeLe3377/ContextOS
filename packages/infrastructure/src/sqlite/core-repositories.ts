import type { Database } from "better-sqlite3";
import type { SessionDto, SessionInput, SessionPatch, SessionStatus } from "../../../contracts/src/sessions.js";
import type { DecisionDto, DecisionInput, DecisionPatch, DecisionStatus } from "../../../contracts/src/decisions.js";
import type { WorkItemDto, WorkItemInput, WorkItemPatch, WorkItemStatus } from "../../../contracts/src/work-items.js";
import type { ReviewItemDto, ReviewItemInput, ReviewItemPriority, ReviewItemStatus } from "../../../contracts/src/review-items.js";
import { ContextOsError } from "../../../shared/src/errors.js";
import { newId } from "../../../shared/src/id.js";

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function ensureChanged(changes: number, exists: unknown, type: string, id: string, expectedRevision: number): void {
  if (changes > 0) return;
  if (!exists) throw new ContextOsError("NOT_FOUND", `${type} not found`, { id });
  throw new ContextOsError("CONFLICT", `${type} revision conflict`, { id, expectedRevision });
}

type SessionRow = {
  id: string; project_id: string; agent_adapter_id: string; external_session_id: string | null; title: string | null; intent: string | null;
  status: SessionStatus; started_at: number | null; completed_at: number | null; last_activity_at: number | null; created_at: number; updated_at: number; revision: number; archived_at: number | null;
};

export class SqliteSessionRepository {
  constructor(private readonly db: Database) {}

  create(input: SessionInput, now: number): SessionDto {
    const id = newId("sess");
    this.db.prepare("INSERT INTO sessions (id, project_id, agent_adapter_id, title, intent, status, runtime_state, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, 'CREATED', '{}', ?, ?, 1)")
      .run(id, input.projectId, input.agentAdapterId, input.title ?? null, input.intent ?? null, now, now);
    return this.getByIdOrThrow(id);
  }

  list(options: { projectId?: string; status?: string; q?: string; limit: number }): SessionDto[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.projectId) { where.push("project_id = ?"); params.push(options.projectId); }
    if (options.status) { where.push("status = ?"); params.push(options.status); }
    if (options.q) { where.push("COALESCE(title, intent, id) LIKE ?"); params.push(`%${options.q}%`); }
    params.push(options.limit);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM sessions ${whereSql} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...params) as SessionRow[]).map(mapSession);
  }

  getById(id: string): SessionDto | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  getByIdOrThrow(id: string): SessionDto {
    const item = this.getById(id);
    if (!item) throw new ContextOsError("NOT_FOUND", "Session not found", { id });
    return item;
  }

  patch(id: string, input: SessionPatch, now: number): SessionDto {
    const result = this.db.prepare("UPDATE sessions SET title = COALESCE(?, title), intent = COALESCE(?, intent), updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
      .run(input.title ?? null, input.intent ?? null, now, id, input.expectedRevision);
    ensureChanged(result.changes, this.getById(id), "Session", id, input.expectedRevision);
    return this.getByIdOrThrow(id);
  }

  updateStatus(id: string, status: SessionStatus, expectedRevision: number, now: number): SessionDto {
    const startedAt = status === "RUNNING" ? now : null;
    const completedAt = status === "COMPLETED" || status === "FAILED" ? now : null;
    const archivedAt = status === "ARCHIVED" ? now : null;
    const result = this.db.prepare("UPDATE sessions SET status = ?, started_at = COALESCE(started_at, ?), completed_at = COALESCE(?, completed_at), last_activity_at = ?, archived_at = COALESCE(?, archived_at), updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
      .run(status, startedAt, completedAt, now, archivedAt, now, id, expectedRevision);
    ensureChanged(result.changes, this.getById(id), "Session", id, expectedRevision);
    return this.getByIdOrThrow(id);
  }
}

function mapSession(row: SessionRow): SessionDto {
  return { id: row.id, projectId: row.project_id, agentAdapterId: row.agent_adapter_id, externalSessionId: row.external_session_id, title: row.title, intent: row.intent, status: row.status, startedAt: iso(row.started_at), completedAt: iso(row.completed_at), lastActivityAt: iso(row.last_activity_at), createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), revision: row.revision, archivedAt: iso(row.archived_at) };
}

type DecisionRow = { id: string; project_id: string; current_version_id: string | null; status: DecisionStatus; title: string; created_at: number; updated_at: number; revision: number; archived_at: number | null };

export class SqliteDecisionRepository {
  constructor(private readonly db: Database) {}

  create(input: DecisionInput, now: number): DecisionDto {
    const id = newId("dec");
    const versionId = newId("decv");
    const body = `${input.statement}\n${input.rationale}`;
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO decisions (id, project_id, current_version_id, status, title, created_at, updated_at, revision) VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, 1)")
        .run(id, input.projectId, versionId, input.title, now, now);
      this.db.prepare("INSERT INTO decision_versions (id, decision_id, version_number, state, statement, problem_context, rationale, alternatives_json, consequences, references_json, content_hash, created_by_type, created_at) VALUES (?, ?, 1, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, 'USER', ?)")
        .run(versionId, id, input.statement, input.problemContext ?? null, input.rationale, JSON.stringify(input.alternatives), input.consequences ?? null, JSON.stringify(input.references), body, now);
    })();
    return this.getByIdOrThrow(id);
  }

  list(options: { projectId?: string; status?: string; q?: string; limit: number }): DecisionDto[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.projectId) { where.push("project_id = ?"); params.push(options.projectId); }
    if (options.status) { where.push("status = ?"); params.push(options.status); }
    if (options.q) { where.push("title LIKE ?"); params.push(`%${options.q}%`); }
    params.push(options.limit);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM decisions ${whereSql} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...params) as DecisionRow[]).map(mapDecision);
  }

  getById(id: string): DecisionDto | null {
    const row = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as DecisionRow | undefined;
    return row ? mapDecision(row) : null;
  }

  getByIdOrThrow(id: string): DecisionDto {
    const item = this.getById(id);
    if (!item) throw new ContextOsError("NOT_FOUND", "Decision not found", { id });
    return item;
  }

  patch(id: string, input: DecisionPatch, now: number): DecisionDto {
    const result = this.db.prepare("UPDATE decisions SET title = COALESCE(?, title), updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
      .run(input.title ?? null, now, id, input.expectedRevision);
    ensureChanged(result.changes, this.getById(id), "Decision", id, input.expectedRevision);
    return this.getByIdOrThrow(id);
  }

  updateStatus(id: string, status: DecisionStatus, expectedRevision: number, now: number): DecisionDto {
    const archivedAt = status === "ARCHIVED" ? now : null;
    const result = this.db.prepare("UPDATE decisions SET status = ?, updated_at = ?, archived_at = COALESCE(?, archived_at), revision = revision + 1 WHERE id = ? AND revision = ?")
      .run(status, now, archivedAt, id, expectedRevision);
    ensureChanged(result.changes, this.getById(id), "Decision", id, expectedRevision);
    return this.getByIdOrThrow(id);
  }
}

function mapDecision(row: DecisionRow): DecisionDto {
  return { id: row.id, projectId: row.project_id, status: row.status, title: row.title, currentVersionId: row.current_version_id, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), revision: row.revision, archivedAt: iso(row.archived_at) };
}

type WorkItemRow = { id: string; project_id: string; parent_id: string | null; title: string; description: string | null; status: WorkItemStatus; acceptance_json: string; execution_contract: string | null; readiness_state: string; completed_at: number | null; created_at: number; updated_at: number; revision: number };

export class SqliteWorkItemRepository {
  constructor(private readonly db: Database) {}

  create(input: WorkItemInput, now: number): WorkItemDto {
    const id = newId("work");
    this.db.prepare("INSERT INTO work_items (id, project_id, parent_id, title, description, status, acceptance_json, execution_contract, readiness_state, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, 'BACKLOG', ?, ?, '{}', ?, ?, 1)")
      .run(id, input.projectId, input.parentId ?? null, input.title, input.description ?? null, JSON.stringify(input.acceptance), input.executionContract ?? null, now, now);
    return this.getByIdOrThrow(id);
  }

  list(options: { projectId?: string; status?: string; q?: string; limit: number }): WorkItemDto[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.projectId) { where.push("project_id = ?"); params.push(options.projectId); }
    if (options.status) { where.push("status = ?"); params.push(options.status); }
    if (options.q) { where.push("title LIKE ?"); params.push(`%${options.q}%`); }
    params.push(options.limit);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM work_items ${whereSql} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...params) as WorkItemRow[]).map(mapWorkItem);
  }

  getById(id: string): WorkItemDto | null {
    const row = this.db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as WorkItemRow | undefined;
    return row ? mapWorkItem(row) : null;
  }

  getByIdOrThrow(id: string): WorkItemDto {
    const item = this.getById(id);
    if (!item) throw new ContextOsError("NOT_FOUND", "Work Item not found", { id });
    return item;
  }

  patch(id: string, input: WorkItemPatch, now: number): WorkItemDto {
    const result = this.db.prepare("UPDATE work_items SET title = COALESCE(?, title), description = COALESCE(?, description), updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
      .run(input.title ?? null, input.description ?? null, now, id, input.expectedRevision);
    ensureChanged(result.changes, this.getById(id), "Work Item", id, input.expectedRevision);
    return this.getByIdOrThrow(id);
  }

  updateStatus(id: string, status: WorkItemStatus, expectedRevision: number, now: number): WorkItemDto {
    const completedAt = status === "DONE" ? now : null;
    const result = this.db.prepare("UPDATE work_items SET status = ?, completed_at = COALESCE(?, completed_at), updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
      .run(status, completedAt, now, id, expectedRevision);
    ensureChanged(result.changes, this.getById(id), "Work Item", id, expectedRevision);
    return this.getByIdOrThrow(id);
  }
}

function mapWorkItem(row: WorkItemRow): WorkItemDto {
  return { id: row.id, projectId: row.project_id, parentId: row.parent_id, title: row.title, description: row.description, status: row.status, acceptance: JSON.parse(row.acceptance_json) as string[], executionContract: row.execution_contract, readinessState: JSON.parse(row.readiness_state) as Record<string, unknown>, completedAt: iso(row.completed_at), createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), revision: row.revision };
}

type ReviewItemRow = { id: string; project_id: string; source_type: string; source_id: string; trigger_type: string; status: ReviewItemStatus; priority: ReviewItemPriority; summary: string; proposed_resolution: string | null; reviewer_id: string | null; resolution_type: string | null; resolution_reason: string | null; resolved_at: number | null; created_at: number; updated_at: number; revision: number };

export class SqliteReviewItemRepository {
  constructor(private readonly db: Database) {}

  create(input: ReviewItemInput, now: number): ReviewItemDto {
    const id = newId("rev");
    this.db.prepare("INSERT INTO review_items (id, project_id, source_type, source_id, trigger_type, status, priority, summary, proposed_resolution, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, 1)")
      .run(id, input.projectId, input.sourceType, input.sourceId, input.triggerType, input.priority, input.summary, input.proposedResolution ?? null, now, now);
    return this.getByIdOrThrow(id);
  }

  list(options: { projectId?: string; status?: string; q?: string; limit: number }): ReviewItemDto[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.projectId) { where.push("project_id = ?"); params.push(options.projectId); }
    if (options.status) { where.push("status = ?"); params.push(options.status); }
    if (options.q) { where.push("summary LIKE ?"); params.push(`%${options.q}%`); }
    params.push(options.limit);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM review_items ${whereSql} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...params) as ReviewItemRow[]).map(mapReviewItem);
  }

  getById(id: string): ReviewItemDto | null {
    const row = this.db.prepare("SELECT * FROM review_items WHERE id = ?").get(id) as ReviewItemRow | undefined;
    return row ? mapReviewItem(row) : null;
  }

  getByIdOrThrow(id: string): ReviewItemDto {
    const item = this.getById(id);
    if (!item) throw new ContextOsError("NOT_FOUND", "Review Item not found", { id });
    return item;
  }

  assign(id: string, reviewerId: string, expectedRevision: number, now: number): ReviewItemDto {
    const result = this.db.prepare("UPDATE review_items SET reviewer_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
      .run(reviewerId, now, id, expectedRevision);
    ensureChanged(result.changes, this.getById(id), "Review Item", id, expectedRevision);
    return this.getByIdOrThrow(id);
  }

  updateStatus(id: string, status: ReviewItemStatus, expectedRevision: number, now: number, resolution?: { type: string; reason: string }): ReviewItemDto {
    const resolvedAt = status === "RESOLVED" || status === "DISMISSED" ? now : null;
    const result = this.db.prepare("UPDATE review_items SET status = ?, resolution_type = COALESCE(?, resolution_type), resolution_reason = COALESCE(?, resolution_reason), resolved_at = COALESCE(?, resolved_at), updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
      .run(status, resolution?.type ?? null, resolution?.reason ?? null, resolvedAt, now, id, expectedRevision);
    ensureChanged(result.changes, this.getById(id), "Review Item", id, expectedRevision);
    return this.getByIdOrThrow(id);
  }
}

function mapReviewItem(row: ReviewItemRow): ReviewItemDto {
  return { id: row.id, projectId: row.project_id, sourceType: row.source_type, sourceId: row.source_id, triggerType: row.trigger_type, status: row.status, priority: row.priority, summary: row.summary, proposedResolution: row.proposed_resolution, reviewerId: row.reviewer_id, resolutionType: row.resolution_type, resolutionReason: row.resolution_reason, resolvedAt: iso(row.resolved_at), createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), revision: row.revision };
}
