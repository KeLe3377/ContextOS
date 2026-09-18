import type { Database } from "better-sqlite3";
import type { SessionDto, SessionInput, SessionPatch, SessionStatus } from "../../../contracts/src/sessions.js";
import type { DecisionDto, DecisionInput, DecisionPatch, DecisionStatus, DecisionVersionDto } from "../../../contracts/src/decisions.js";
import type { WorkItemAttemptDto, WorkItemDependencyDto, WorkItemDto, WorkItemInput, WorkItemPatch, WorkItemStatus } from "../../../contracts/src/work-items.js";
import type { ReviewItemDto, ReviewItemInput, ReviewItemPriority, ReviewItemStatus } from "../../../contracts/src/review-items.js";
import type { ResourceActivityEventDto } from "../../../contracts/src/runtime.js";
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
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO sessions (id, project_id, agent_adapter_id, title, intent, status, runtime_state, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, 'CREATED', '{}', ?, ?, 1)")
        .run(id, input.projectId, input.agentAdapterId, input.title ?? null, input.intent ?? null, now, now);
      this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'SESSION', ?, 'SESSION_CREATED', 'Session created', ?, ?)")
        .run(newId("act"), input.projectId, id, JSON.stringify({ title: input.title ?? null, adapterId: input.agentAdapterId }), now);
      this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, after_json, created_at) VALUES (?, ?, 'USER', 'SESSION', ?, 'CREATE', ?, ?)")
        .run(newId("audit"), input.projectId, id, JSON.stringify({ id, title: input.title ?? null, adapterId: input.agentAdapterId }), now);
    })();
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
    const before = this.getById(id);
    let changes = 0;
    this.db.transaction(() => {
      const result = this.db.prepare("UPDATE sessions SET status = ?, started_at = COALESCE(started_at, ?), completed_at = CASE WHEN ? IS NOT NULL THEN ? WHEN ? = 'RUNNING' THEN NULL ELSE completed_at END, last_activity_at = ?, archived_at = COALESCE(?, archived_at), updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
        .run(status, startedAt, completedAt, completedAt, status, now, archivedAt, now, id, expectedRevision);
      changes = result.changes;
      if (result.changes > 0 && before) {
        const after = this.getByIdOrThrow(id);
        this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'SESSION', ?, ?, ?, ?, ?)")
          .run(newId("act"), after.projectId, id, `SESSION_${status}`, `Session ${status.toLowerCase()}`, JSON.stringify({ beforeStatus: before.status, afterStatus: status }), now);
        this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, before_json, after_json, created_at) VALUES (?, ?, 'USER', 'SESSION', ?, ?, ?, ?, ?)")
          .run(newId("audit"), after.projectId, id, `STATUS_${status}`, JSON.stringify(before), JSON.stringify(after), now);
      }
    })();
    ensureChanged(changes, before ?? this.getById(id), "Session", id, expectedRevision);
    return this.getByIdOrThrow(id);
  }
}

function mapSession(row: SessionRow): SessionDto {
  return { id: row.id, projectId: row.project_id, agentAdapterId: row.agent_adapter_id, externalSessionId: row.external_session_id, title: row.title, intent: row.intent, status: row.status, startedAt: iso(row.started_at), completedAt: iso(row.completed_at), lastActivityAt: iso(row.last_activity_at), createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), revision: row.revision, archivedAt: iso(row.archived_at) };
}

type DecisionRow = { id: string; project_id: string; current_version_id: string | null; status: DecisionStatus; title: string; created_at: number; updated_at: number; revision: number; archived_at: number | null };
type DecisionVersionRow = {
  id: string; decision_id: string; version_number: number; state: Exclude<DecisionStatus, "ARCHIVED">; statement: string; problem_context: string | null; rationale: string;
  alternatives_json: string; consequences: string | null; references_json: string; content_hash: string; created_by_type: string; created_by_id: string | null;
  created_at: number; accepted_at: number | null; supersedes_version_id: string | null; reverses_version_id: string | null;
};

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

  listVersions(id: string): DecisionVersionDto[] {
    return (this.db.prepare("SELECT * FROM decision_versions WHERE decision_id = ? ORDER BY version_number DESC").all(id) as DecisionVersionRow[]).map(mapDecisionVersion);
  }

  patch(id: string, input: DecisionPatch, now: number): DecisionDto {
    const before = this.getById(id);
    const currentVersion = this.db.prepare("SELECT * FROM decision_versions WHERE decision_id = ? ORDER BY version_number DESC LIMIT 1").get(id) as DecisionVersionRow | undefined;
    const changesVersion = input.statement !== undefined || input.rationale !== undefined || input.problemContext !== undefined || input.alternatives !== undefined || input.consequences !== undefined || input.references !== undefined;
    this.db.transaction(() => {
      let nextVersionId = before?.currentVersionId ?? null;
      if (changesVersion && currentVersion) {
        nextVersionId = newId("decv");
        const statement = input.statement ?? currentVersion.statement;
        const rationale = input.rationale ?? currentVersion.rationale;
        const problemContext = input.problemContext ?? currentVersion.problem_context;
        const alternatives = input.alternatives ?? JSON.parse(currentVersion.alternatives_json);
        const consequences = input.consequences ?? currentVersion.consequences;
        const references = input.references ?? JSON.parse(currentVersion.references_json);
        const contentHash = `${statement}\n${rationale}`;
        this.db.prepare("INSERT INTO decision_versions (id, decision_id, version_number, state, statement, problem_context, rationale, alternatives_json, consequences, references_json, content_hash, created_by_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USER', ?)")
          .run(nextVersionId, id, currentVersion.version_number + 1, before?.status === "PROPOSED" ? "PROPOSED" : "DRAFT", statement, problemContext || null, rationale, JSON.stringify(alternatives), consequences || null, JSON.stringify(references), contentHash, now);
      }
      const result = this.db.prepare("UPDATE decisions SET title = COALESCE(?, title), current_version_id = COALESCE(?, current_version_id), updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
        .run(input.title ?? null, nextVersionId, now, id, input.expectedRevision);
      ensureChanged(result.changes, before, "Decision", id, input.expectedRevision);
    })();
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

function mapDecisionVersion(row: DecisionVersionRow): DecisionVersionDto {
  return {
    id: row.id,
    decisionId: row.decision_id,
    versionNumber: row.version_number,
    state: row.state,
    statement: row.statement,
    problemContext: row.problem_context,
    rationale: row.rationale,
    alternatives: JSON.parse(row.alternatives_json),
    consequences: row.consequences,
    references: JSON.parse(row.references_json),
    contentHash: row.content_hash,
    createdByType: row.created_by_type,
    createdById: row.created_by_id,
    createdAt: new Date(row.created_at).toISOString(),
    acceptedAt: iso(row.accepted_at),
    supersedesVersionId: row.supersedes_version_id,
    reversesVersionId: row.reverses_version_id
  };
}

type WorkItemRow = { id: string; project_id: string; parent_id: string | null; title: string; description: string | null; status: WorkItemStatus; acceptance_json: string; execution_contract: string | null; readiness_state: string; completed_at: number | null; created_at: number; updated_at: number; revision: number };
type WorkItemAttemptRow = {
  id: string; work_item_id: string; session_id: string | null; status: WorkItemAttemptDto["status"]; summary: string | null; result_ref: string | null;
  started_at: number | null; ended_at: number | null; created_at: number;
  failure_code: string | null; failure_message: string | null;
  session_id_join: string | null; project_id: string | null; agent_adapter_id: string | null; external_session_id: string | null; title: string | null; intent: string | null;
  session_status: SessionStatus | null; session_started_at: number | null; completed_at: number | null; last_activity_at: number | null; session_created_at: number | null;
  session_updated_at: number | null; session_revision: number | null; archived_at: number | null;
};

export class SqliteWorkItemRepository {
  constructor(private readonly db: Database) {}

  create(input: WorkItemInput, now: number): WorkItemDto {
    const id = newId("work");
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO work_items (id, project_id, parent_id, title, description, status, acceptance_json, execution_contract, readiness_state, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, 'BACKLOG', ?, ?, '{}', ?, ?, 1)")
        .run(id, input.projectId, input.parentId ?? null, input.title, input.description ?? null, JSON.stringify(input.acceptance), input.executionContract ?? null, now, now);
      const created = this.getByIdOrThrow(id);
      this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'WORK_ITEM', ?, 'WORK_ITEM_CREATED', ?, ?, ?)")
        .run(newId("act"), input.projectId, id, `Created Work Item: ${input.title}`, JSON.stringify({ status: "BACKLOG", parentId: input.parentId ?? null }), now);
      this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, after_json, created_at) VALUES (?, ?, 'USER', 'WORK_ITEM', ?, 'CREATE', ?, ?)")
        .run(newId("audit"), input.projectId, id, JSON.stringify(created), now);
    })();
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
    const setParent = input.parentId !== undefined ? 1 : 0;
    const before = this.getById(id);
    this.db.transaction(() => {
      const result = this.db.prepare("UPDATE work_items SET parent_id = CASE WHEN ? = 1 THEN ? ELSE parent_id END, title = COALESCE(?, title), description = COALESCE(?, description), acceptance_json = COALESCE(?, acceptance_json), execution_contract = COALESCE(?, execution_contract), updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
        .run(setParent, input.parentId ?? null, input.title ?? null, input.description ?? null, input.acceptance ? JSON.stringify(input.acceptance) : null, input.executionContract ?? null, now, id, input.expectedRevision);
      ensureChanged(result.changes, before, "Work Item", id, input.expectedRevision);
      if (input.dependencyIds !== undefined) {
        this.db.prepare("DELETE FROM work_item_dependencies WHERE work_item_id = ?").run(id);
        const insert = this.db.prepare("INSERT INTO work_item_dependencies (work_item_id, depends_on_id, dependency_type, created_at) VALUES (?, ?, 'BLOCKING', ?)");
        for (const dependencyId of input.dependencyIds) insert.run(id, dependencyId, now);
      }
      const after = this.getByIdOrThrow(id);
      this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'WORK_ITEM', ?, 'WORK_ITEM_UPDATED', 'Updated Work Item definition', ?, ?)")
        .run(newId("act"), after.projectId, id, JSON.stringify({ dependencyIds: input.dependencyIds ?? null }), now);
      this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, before_json, after_json, created_at) VALUES (?, ?, 'USER', 'WORK_ITEM', ?, 'UPDATE', ?, ?, ?)")
        .run(newId("audit"), after.projectId, id, JSON.stringify(before), JSON.stringify(after), now);
    })();
    return this.getByIdOrThrow(id);
  }

  assertParentInProject(parentId: string, projectId: string): void {
    const parent = this.getByIdOrThrow(parentId);
    if (parent.projectId !== projectId) {
      throw new ContextOsError("INVALID_ARGUMENT", "Work Item parent must belong to the same project", { parentId, projectId });
    }
  }

  assertValidParent(id: string, parentId: string | null): void {
    if (parentId === null) return;
    if (id === parentId) throw new ContextOsError("INVALID_ARGUMENT", "Work Item cannot be its own parent", { id });
    const item = this.getByIdOrThrow(id);
    const parent = this.getByIdOrThrow(parentId);
    if (item.projectId !== parent.projectId) {
      throw new ContextOsError("INVALID_ARGUMENT", "Work Item parent must belong to the same project", { id, parentId });
    }
    const createsCycle = this.db.prepare(`
      WITH RECURSIVE ancestors(id, parent_id) AS (
        SELECT id, parent_id FROM work_items WHERE id = ?
        UNION ALL
        SELECT work_items.id, work_items.parent_id
        FROM work_items JOIN ancestors ON work_items.id = ancestors.parent_id
      )
      SELECT 1 FROM ancestors WHERE id = ? LIMIT 1
    `).get(parentId, id);
    if (createsCycle) throw new ContextOsError("INVALID_ARGUMENT", "Work Item parent would create a cycle", { id, parentId });
  }

  assertValidDependencies(id: string, dependencyIds: string[]): void {
    const item = this.getByIdOrThrow(id);
    if (new Set(dependencyIds).size !== dependencyIds.length) {
      throw new ContextOsError("INVALID_ARGUMENT", "Work Item dependencies must be unique", { id });
    }
    for (const dependencyId of dependencyIds) {
      if (dependencyId === id) throw new ContextOsError("INVALID_ARGUMENT", "Work Item cannot depend on itself", { id });
      const dependency = this.getByIdOrThrow(dependencyId);
      if (dependency.projectId !== item.projectId) {
        throw new ContextOsError("INVALID_ARGUMENT", "Work Item dependencies must belong to the same project", { id, dependencyId });
      }
      const createsCycle = this.db.prepare(`
        WITH RECURSIVE reachable(id) AS (
          SELECT depends_on_id FROM work_item_dependencies WHERE work_item_id = ?
          UNION
          SELECT d.depends_on_id FROM work_item_dependencies d JOIN reachable r ON d.work_item_id = r.id
        )
        SELECT 1 FROM reachable WHERE id = ? LIMIT 1
      `).get(dependencyId, id);
      if (createsCycle) throw new ContextOsError("INVALID_ARGUMENT", "Work Item dependency would create a cycle", { id, dependencyId });
    }
  }

  listDependencies(id: string): WorkItemDependencyDto[] {
    return this.db.prepare(`
      SELECT d.work_item_id AS workItemId, d.depends_on_id AS dependsOnId,
             d.dependency_type AS dependencyType, w.status AS status
      FROM work_item_dependencies d
      JOIN work_items w ON w.id = d.depends_on_id
      WHERE d.work_item_id = ?
      ORDER BY d.created_at, d.depends_on_id
    `).all(id) as WorkItemDependencyDto[];
  }

  listChildren(id: string): WorkItemDto[] {
    return (this.db.prepare("SELECT * FROM work_items WHERE parent_id = ? ORDER BY updated_at DESC, id DESC").all(id) as WorkItemRow[]).map(mapWorkItem);
  }

  listActivity(id: string, limit = 50): ResourceActivityEventDto[] {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const activities = this.db.prepare("SELECT id, project_id AS projectId, resource_type AS resourceType, resource_id AS resourceId, event_type AS eventType, summary, metadata_json AS metadataJson, created_at AS createdAt FROM activity_events WHERE resource_type = 'WORK_ITEM' AND resource_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(id, safeLimit) as Array<{ id: string; projectId: string | null; resourceType: string; resourceId: string; eventType: string; summary: string; metadataJson: string; createdAt: number }>;
    const audits = this.db.prepare("SELECT id, project_id AS projectId, resource_type AS resourceType, resource_id AS resourceId, action AS eventType, actor_type AS actorType, after_json AS metadataJson, created_at AS createdAt FROM audit_events WHERE resource_type = 'WORK_ITEM' AND resource_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(id, safeLimit) as Array<{ id: string; projectId: string | null; resourceType: string; resourceId: string; eventType: string; actorType: string; metadataJson: string | null; createdAt: number }>;
    return [
      ...activities.map((row) => ({ id: row.id, kind: "ACTIVITY" as const, projectId: row.projectId, resourceType: row.resourceType, resourceId: row.resourceId, eventType: row.eventType, summary: row.summary, actorType: null, metadata: JSON.parse(row.metadataJson), createdAt: new Date(row.createdAt).toISOString() })),
      ...audits.map((row) => ({ id: row.id, kind: "AUDIT" as const, projectId: row.projectId, resourceType: row.resourceType, resourceId: row.resourceId, eventType: row.eventType, summary: row.eventType, actorType: row.actorType, metadata: row.metadataJson ? JSON.parse(row.metadataJson) : {}, createdAt: new Date(row.createdAt).toISOString() }))
    ].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)).slice(0, safeLimit);
  }

  listAttempts(id: string): WorkItemAttemptDto[] {
    return (this.db.prepare(`
      SELECT attempts.*,
             runs.failure_code,
             runs.failure_message,
             sessions.id AS session_id_join,
             sessions.project_id,
             sessions.agent_adapter_id,
             sessions.external_session_id,
             sessions.title,
             sessions.intent,
             sessions.status AS session_status,
             sessions.started_at AS session_started_at,
             sessions.completed_at,
             sessions.last_activity_at,
             sessions.created_at AS session_created_at,
             sessions.updated_at AS session_updated_at,
             sessions.revision AS session_revision,
             sessions.archived_at
      FROM work_item_attempts attempts
      LEFT JOIN sessions ON sessions.id = attempts.session_id
      LEFT JOIN session_runs runs ON runs.id = attempts.result_ref
      WHERE attempts.work_item_id = ?
      ORDER BY attempts.created_at DESC, attempts.id DESC
    `).all(id) as WorkItemAttemptRow[]).map(mapWorkItemAttempt);
  }

  recordSessionAttempt(input: { workItemId: string; expectedRevision: number; sessionId: string; summary: string }, now: number): WorkItemAttemptDto {
    const before = this.getById(input.workItemId);
    if (!before) throw new ContextOsError("NOT_FOUND", "Work Item not found", { id: input.workItemId });
    if (!["READY", "IN_PROGRESS"].includes(before.status)) {
      throw new ContextOsError("CONFLICT", "Work Item must be ready before starting an agent session", { id: input.workItemId, status: before.status });
    }
    const attemptId = newId("wattempt");
    this.db.transaction(() => {
      const result = before.status === "READY"
        ? this.db.prepare("UPDATE work_items SET status = 'IN_PROGRESS', updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
          .run(now, input.workItemId, input.expectedRevision)
        : this.db.prepare("UPDATE work_items SET updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
          .run(now, input.workItemId, input.expectedRevision);
      ensureChanged(result.changes, before, "Work Item", input.workItemId, input.expectedRevision);
      this.db.prepare("INSERT INTO work_item_attempts (id, work_item_id, session_id, status, summary, started_at, created_at) VALUES (?, ?, ?, 'STARTED', ?, ?, ?)")
        .run(attemptId, input.workItemId, input.sessionId, input.summary, now, now);
      this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'WORK_ITEM', ?, 'WORK_ITEM_SESSION_STARTED', ?, ?, ?)")
        .run(newId("act"), before.projectId, input.workItemId, input.summary, JSON.stringify({ attemptId, sessionId: input.sessionId, beforeStatus: before.status, afterStatus: "IN_PROGRESS" }), now);
      this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, before_json, after_json, created_at) VALUES (?, ?, 'USER', 'WORK_ITEM', ?, 'START_SESSION', ?, ?, ?)")
        .run(newId("audit"), before.projectId, input.workItemId, JSON.stringify(before), JSON.stringify({ attemptId, sessionId: input.sessionId, status: "IN_PROGRESS" }), now);
    })();
    return this.listAttempts(input.workItemId).find((attempt) => attempt.id === attemptId)!;
  }

  updateStatus(id: string, status: WorkItemStatus, expectedRevision: number, now: number): WorkItemDto {
    const before = this.getById(id);
    const completedAt = status === "DONE" ? now : null;
    this.db.transaction(() => {
      const result = this.db.prepare("UPDATE work_items SET status = ?, completed_at = CASE WHEN ? IS NOT NULL THEN ? WHEN ? IN ('BACKLOG', 'CANCELED') THEN NULL ELSE completed_at END, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
        .run(status, completedAt, completedAt, status, now, id, expectedRevision);
      ensureChanged(result.changes, before, "Work Item", id, expectedRevision);
      const after = this.getByIdOrThrow(id);
      const eventType = `WORK_ITEM_${status}`;
      this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'WORK_ITEM', ?, ?, ?, ?, ?)")
        .run(newId("act"), after.projectId, id, eventType, `Work Item moved to ${status}`, JSON.stringify({ beforeStatus: before?.status, afterStatus: status }), now);
      this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, before_json, after_json, created_at) VALUES (?, ?, 'USER', 'WORK_ITEM', ?, ?, ?, ?, ?)")
        .run(newId("audit"), after.projectId, id, eventType, JSON.stringify(before), JSON.stringify(after), now);
    })();
    return this.getByIdOrThrow(id);
  }

  updateBlockState(id: string, status: "BLOCKED" | "IN_PROGRESS", expectedRevision: number, input: { reason?: string; resolution?: string }, now: number): WorkItemDto {
    const before = this.getById(id);
    if (!before) throw new ContextOsError("NOT_FOUND", "Work Item not found", { id });
    const currentBlocker = typeof before.readinessState.blocker === "object" && before.readinessState.blocker !== null
      ? before.readinessState.blocker as Record<string, unknown>
      : {};
    const blocker = status === "BLOCKED"
      ? { reason: input.reason, blockedAt: new Date(now).toISOString(), resolution: null, resolvedAt: null }
      : { ...currentBlocker, resolution: input.resolution, resolvedAt: new Date(now).toISOString() };
    const readinessState = { ...before.readinessState, blocker };
    const eventType = status === "BLOCKED" ? "WORK_ITEM_BLOCKED" : "WORK_ITEM_BLOCKER_RESOLVED";
    const summary = status === "BLOCKED" ? input.reason! : input.resolution!;
    this.db.transaction(() => {
      const result = this.db.prepare("UPDATE work_items SET status = ?, readiness_state = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
        .run(status, JSON.stringify(readinessState), now, id, expectedRevision);
      ensureChanged(result.changes, before, "Work Item", id, expectedRevision);
      const metadata = JSON.stringify({ beforeStatus: before.status, afterStatus: status, blocker });
      this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'WORK_ITEM', ?, ?, ?, ?, ?)")
        .run(newId("act"), before.projectId, id, eventType, summary, metadata, now);
      this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, before_json, after_json, created_at) VALUES (?, ?, 'USER', 'WORK_ITEM', ?, ?, ?, ?, ?)")
        .run(newId("audit"), before.projectId, id, eventType, JSON.stringify(before), JSON.stringify({ status, readinessState }), now);
    })();
    return this.getByIdOrThrow(id);
  }
}

function mapWorkItem(row: WorkItemRow): WorkItemDto {
  return { id: row.id, projectId: row.project_id, parentId: row.parent_id, title: row.title, description: row.description, status: row.status, acceptance: JSON.parse(row.acceptance_json) as string[], executionContract: row.execution_contract, readinessState: JSON.parse(row.readiness_state) as Record<string, unknown>, completedAt: iso(row.completed_at), createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), revision: row.revision };
}

function mapWorkItemAttempt(row: WorkItemAttemptRow): WorkItemAttemptDto {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    sessionId: row.session_id,
    status: row.status,
    summary: row.summary,
    resultRef: row.result_ref,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    createdAt: new Date(row.created_at).toISOString(),
    session: row.session_id_join !== null && row.project_id !== null && row.agent_adapter_id !== null && row.session_status !== null && row.session_created_at !== null && row.session_updated_at !== null && row.session_revision !== null
      ? mapSession({
          id: row.session_id_join,
          project_id: row.project_id,
          agent_adapter_id: row.agent_adapter_id,
          external_session_id: row.external_session_id,
          title: row.title,
          intent: row.intent,
          status: row.session_status,
          started_at: row.session_started_at,
          completed_at: row.completed_at,
          last_activity_at: row.last_activity_at,
          created_at: row.session_created_at,
          updated_at: row.session_updated_at,
          revision: row.session_revision,
          archived_at: row.archived_at
        })
      : null
  };
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

  findOrCreateOpenEvidenceIssue(input: ReviewItemInput, now: number): ReviewItemDto {
    return this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT * FROM review_items
        WHERE source_type = ? AND source_id = ? AND trigger_type = ?
          AND status IN ('OPEN', 'IN_PROGRESS')
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `).get(input.sourceType, input.sourceId, input.triggerType) as ReviewItemRow | undefined;
      if (existing) return mapReviewItem(existing);

      const id = newId("rev");
      this.db.prepare("INSERT INTO review_items (id, project_id, source_type, source_id, trigger_type, status, priority, summary, proposed_resolution, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, 1)")
        .run(id, input.projectId, input.sourceType, input.sourceId, input.triggerType, input.priority, input.summary, input.proposedResolution ?? null, now, now);
      const created = this.getByIdOrThrow(id);
      this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'EVIDENCE_SNAPSHOT', ?, ?, ?, ?, ?)")
        .run(newId("act"), input.projectId, input.sourceId, input.triggerType, input.summary, JSON.stringify({ reviewItemId: id }), now);
      this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, after_json, created_at) VALUES (?, ?, 'SYSTEM', 'REVIEW_ITEM', ?, 'CREATE', ?, ?)")
        .run(newId("audit"), input.projectId, id, JSON.stringify(created), now);
      return created;
    })();
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
    const before = this.getById(id);
    this.db.transaction(() => {
      const result = this.db.prepare("UPDATE review_items SET reviewer_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
        .run(reviewerId, now, id, expectedRevision);
      ensureChanged(result.changes, before, "Review Item", id, expectedRevision);
      if (before) {
        const after = this.getByIdOrThrow(id);
        this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, before_json, after_json, created_at) VALUES (?, ?, 'USER', 'REVIEW_ITEM', ?, 'ASSIGN', ?, ?, ?)")
          .run(newId("audit"), after.projectId, id, JSON.stringify(before), JSON.stringify(after), now);
      }
    })();
    return this.getByIdOrThrow(id);
  }

  updateStatus(id: string, status: ReviewItemStatus, expectedRevision: number, now: number, resolution?: { type: string; reason: string }): ReviewItemDto {
    const resolvedAt = status === "RESOLVED" || status === "DISMISSED" ? now : null;
    const before = this.getById(id);
    this.db.transaction(() => {
      const result = this.db.prepare("UPDATE review_items SET status = ?, resolution_type = COALESCE(?, resolution_type), resolution_reason = COALESCE(?, resolution_reason), resolved_at = COALESCE(?, resolved_at), updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
        .run(status, resolution?.type ?? null, resolution?.reason ?? null, resolvedAt, now, id, expectedRevision);
      ensureChanged(result.changes, before, "Review Item", id, expectedRevision);
      if (before) {
        const after = this.getByIdOrThrow(id);
        const action = status === "IN_PROGRESS" ? "START" : status === "RESOLVED" ? "RESOLVE" : status === "DISMISSED" ? "DISMISS" : status;
        this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, before_json, after_json, created_at) VALUES (?, ?, 'USER', 'REVIEW_ITEM', ?, ?, ?, ?, ?)")
          .run(newId("audit"), after.projectId, id, action, JSON.stringify(before), JSON.stringify(after), now);
      }
    })();
    return this.getByIdOrThrow(id);
  }

  listActionLog(id: string): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT id, action, before_json AS beforeJson, after_json AS afterJson, created_at AS createdAt
      FROM audit_events
      WHERE resource_type = 'REVIEW_ITEM' AND resource_id = ?
      ORDER BY created_at, id
    `).all(id).map((row) => {
      const value = row as { id: string; action: string; beforeJson: string | null; afterJson: string | null; createdAt: number };
      return {
        id: value.id,
        action: value.action,
        before: value.beforeJson ? JSON.parse(value.beforeJson) : null,
        after: value.afterJson ? JSON.parse(value.afterJson) : null,
        createdAt: new Date(value.createdAt).toISOString()
      };
    });
  }
}

function mapReviewItem(row: ReviewItemRow): ReviewItemDto {
  return { id: row.id, projectId: row.project_id, sourceType: row.source_type, sourceId: row.source_id, triggerType: row.trigger_type, status: row.status, priority: row.priority, summary: row.summary, proposedResolution: row.proposed_resolution, reviewerId: row.reviewer_id, resolutionType: row.resolution_type, resolutionReason: row.resolution_reason, resolvedAt: iso(row.resolved_at), createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), revision: row.revision };
}
