import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { ProjectDto, ProjectInput, ProjectStatus } from "../../../contracts/src/projects.js";
import { ContextOsError } from "../../../shared/src/errors.js";
import { newId } from "../../../shared/src/id.js";

export type ProjectListOptions = {
  status?: string;
  q?: string;
  limit: number;
};

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  root_path: string;
  status: ProjectStatus;
  default_rule_ids: string;
  agent_adapter_ids: string;
  created_at: number;
  updated_at: number;
  revision: number;
  archived_at: number | null;
};

export class SqliteProjectRepository {
  constructor(private readonly db: Database) {}

  create(input: ProjectInput, now: number): ProjectDto {
    const id = newId("proj");
    const rootPathHash = createHash("sha256").update(input.rootPath).digest("hex");

    this.db
      .prepare(
        "INSERT INTO projects (id, name, description, root_path, root_path_hash, status, default_rule_ids, agent_adapter_ids, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, 1)"
      )
      .run(
        id,
        input.name,
        input.description ?? null,
        input.rootPath,
        rootPathHash,
        JSON.stringify(input.defaultRuleIds),
        JSON.stringify(input.agentAdapterIds),
        now,
        now
      );

    return this.getByIdOrThrow(id);
  }

  list(options: ProjectListOptions): ProjectDto[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (options.status) {
      where.push("status = ?");
      params.push(options.status);
    }

    if (options.q) {
      where.push("name LIKE ?");
      params.push(`%${options.q}%`);
    }

    params.push(options.limit);
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM projects ${whereSql} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params) as ProjectRow[];

    return rows.map(mapProject);
  }

  getById(id: string): ProjectDto | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row ? mapProject(row) : null;
  }

  getByIdOrThrow(id: string): ProjectDto {
    const project = this.getById(id);
    if (!project) {
      throw new ContextOsError("NOT_FOUND", "Project not found", { id });
    }
    return project;
  }

  updateStatus(
    id: string,
    status: ProjectStatus,
    expectedRevision: number,
    now: number,
    archivedAt: number | null
  ): ProjectDto {
    const result = this.db
      .prepare(
        "UPDATE projects SET status = ?, updated_at = ?, archived_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?"
      )
      .run(status, now, archivedAt, id, expectedRevision);

    if (result.changes === 0) {
      const current = this.getById(id);
      if (!current) {
        throw new ContextOsError("NOT_FOUND", "Project not found", { id });
      }
      throw new ContextOsError("CONFLICT", "Project revision conflict", {
        id,
        expectedRevision,
        currentRevision: current.revision
      });
    }

    return this.getByIdOrThrow(id);
  }
}

function mapProject(row: ProjectRow): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rootPath: row.root_path,
    status: row.status,
    defaultRuleIds: JSON.parse(row.default_rule_ids) as string[],
    agentAdapterIds: JSON.parse(row.agent_adapter_ids) as string[],
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    revision: row.revision,
    archivedAt: row.archived_at === null ? null : new Date(row.archived_at).toISOString()
  };
}

