import type { Database } from "better-sqlite3";
import type {
  RuleDto,
  RuleEnforcementMode,
  RuleInput,
  RulePatch,
  RuleStatus,
  RuleValidationState,
  RuleVersionDto,
  RuleVersionInput
} from "../../../contracts/src/rules.js";
import { ContextOsError } from "../../../shared/src/errors.js";
import { newId } from "../../../shared/src/id.js";

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function parseObject(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

function parseArray(value: string): unknown[] {
  return JSON.parse(value) as unknown[];
}

function ensureChanged(changes: number, exists: unknown, type: string, id: string, expectedRevision: number): void {
  if (changes > 0) return;
  if (!exists) throw new ContextOsError("NOT_FOUND", `${type} not found`, { id });
  throw new ContextOsError("CONFLICT", `${type} revision conflict`, { id, expectedRevision });
}

function contentHash(input: {
  scope: Record<string, unknown>;
  conditions: unknown[];
  effect: Record<string, unknown>;
  enforcementMode: RuleEnforcementMode;
  precedence: number;
  exceptions: unknown[];
}): string {
  return JSON.stringify(input);
}

type RuleRow = {
  id: string;
  project_id: string;
  current_version_id: string | null;
  title: string;
  description: string | null;
  status: RuleStatus;
  created_at: number;
  updated_at: number;
  revision: number;
  archived_at: number | null;
};

type RuleVersionRow = {
  id: string;
  rule_id: string;
  version_number: number;
  scope_json: string;
  conditions_json: string;
  effect_json: string;
  enforcement_mode: RuleEnforcementMode;
  precedence: number;
  exceptions_json: string;
  validation_state: RuleValidationState;
  validation_errors_json: string;
  content_hash: string;
  created_by_type: string;
  created_by_id: string | null;
  created_at: number;
  activated_at: number | null;
};

export class SqliteRuleRepository {
  constructor(private readonly db: Database) {}

  create(input: RuleInput, now: number): RuleDto {
    const id = newId("rule");
    const versionId = newId("rulev");
    const hash = contentHash(input);
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO rules (id, project_id, current_version_id, title, description, status, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, 1)")
        .run(id, input.projectId, versionId, input.title, input.description ?? null, now, now);
      this.db.prepare("INSERT INTO rule_versions (id, rule_id, version_number, scope_json, conditions_json, effect_json, enforcement_mode, precedence, exceptions_json, validation_state, validation_errors_json, content_hash, created_by_type, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'UNKNOWN', '[]', ?, 'USER', ?)")
        .run(versionId, id, JSON.stringify(input.scope), JSON.stringify(input.conditions), JSON.stringify(input.effect), input.enforcementMode, input.precedence, JSON.stringify(input.exceptions), hash, now);
    })();
    return this.getByIdOrThrow(id);
  }

  list(options: { projectId?: string; status?: string; q?: string; limit: number }): RuleDto[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.projectId) { where.push("project_id = ?"); params.push(options.projectId); }
    if (options.status) { where.push("status = ?"); params.push(options.status); }
    if (options.q) { where.push("(title LIKE ? OR COALESCE(description, '') LIKE ?)"); params.push(`%${options.q}%`, `%${options.q}%`); }
    params.push(options.limit);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM rules ${whereSql} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...params) as RuleRow[]).map(mapRule);
  }

  getById(id: string): RuleDto | null {
    const row = this.db.prepare("SELECT * FROM rules WHERE id = ?").get(id) as RuleRow | undefined;
    return row ? mapRule(row) : null;
  }

  getByIdOrThrow(id: string): RuleDto {
    const item = this.getById(id);
    if (!item) throw new ContextOsError("NOT_FOUND", "Rule not found", { id });
    return item;
  }

  patch(id: string, input: RulePatch, now: number): RuleDto {
    const result = this.db.prepare("UPDATE rules SET title = COALESCE(?, title), description = COALESCE(?, description), updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
      .run(input.title ?? null, input.description ?? null, now, id, input.expectedRevision);
    ensureChanged(result.changes, this.getById(id), "Rule", id, input.expectedRevision);
    return this.getByIdOrThrow(id);
  }

  updateStatus(id: string, status: RuleStatus, expectedRevision: number, now: number): RuleDto {
    const rule = this.getByIdOrThrow(id);
    if (status === "ACTIVE") {
      const version = rule.currentVersionId ? this.getVersionById(rule.currentVersionId) : null;
      if (!version || version.validationState !== "VALID") {
        throw new ContextOsError("INVALID_ARGUMENT", "Rule must validate before activation", { id });
      }
    }
    const archivedAt = status === "ARCHIVED" ? now : null;
    this.db.transaction(() => {
      const result = this.db.prepare("UPDATE rules SET status = ?, archived_at = COALESCE(?, archived_at), updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
        .run(status, archivedAt, now, id, expectedRevision);
      ensureChanged(result.changes, rule, "Rule", id, expectedRevision);
      if (status === "ACTIVE" && rule.currentVersionId) {
        this.db.prepare("UPDATE rule_versions SET activated_at = COALESCE(activated_at, ?) WHERE id = ?").run(now, rule.currentVersionId);
      }
    })();
    return this.getByIdOrThrow(id);
  }

  createVersion(ruleId: string, input: RuleVersionInput, now: number): RuleVersionDto {
    const rule = this.getByIdOrThrow(ruleId);
    const nextVersion = this.latestVersionNumber(ruleId) + 1;
    const versionId = newId("rulev");
    const hash = contentHash(input);
    this.db.transaction(() => {
      const result = this.db.prepare("UPDATE rules SET current_version_id = ?, status = 'DRAFT', updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
        .run(versionId, now, ruleId, input.expectedRevision);
      ensureChanged(result.changes, rule, "Rule", ruleId, input.expectedRevision);
      this.db.prepare("INSERT INTO rule_versions (id, rule_id, version_number, scope_json, conditions_json, effect_json, enforcement_mode, precedence, exceptions_json, validation_state, validation_errors_json, content_hash, created_by_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNKNOWN', '[]', ?, 'USER', ?)")
        .run(versionId, ruleId, nextVersion, JSON.stringify(input.scope), JSON.stringify(input.conditions), JSON.stringify(input.effect), input.enforcementMode, input.precedence, JSON.stringify(input.exceptions), hash, now);
    })();
    return this.getVersionByIdOrThrow(versionId);
  }

  validateCurrent(id: string, now: number): { rule: RuleDto; version: RuleVersionDto; valid: boolean; errors: string[] } {
    const rule = this.getByIdOrThrow(id);
    if (!rule.currentVersionId) throw new ContextOsError("INVALID_ARGUMENT", "Rule has no current version", { id });
    const version = this.getVersionByIdOrThrow(rule.currentVersionId);
    const errors = validateVersion(version);
    const state: RuleValidationState = errors.length ? "INVALID" : "VALID";
    this.db.prepare("UPDATE rule_versions SET validation_state = ?, validation_errors_json = ? WHERE id = ?")
      .run(state, JSON.stringify(errors), version.id);
    this.db.prepare("UPDATE rules SET updated_at = ? WHERE id = ?").run(now, id);
    const updatedRule = this.getByIdOrThrow(id);
    const updatedVersion = this.getVersionByIdOrThrow(version.id);
    return { rule: updatedRule, version: updatedVersion, valid: errors.length === 0, errors };
  }

  listVersions(ruleId: string): RuleVersionDto[] {
    this.getByIdOrThrow(ruleId);
    return (this.db.prepare("SELECT * FROM rule_versions WHERE rule_id = ? ORDER BY version_number DESC").all(ruleId) as RuleVersionRow[]).map(mapRuleVersion);
  }

  getVersionById(id: string): RuleVersionDto | null {
    const row = this.db.prepare("SELECT * FROM rule_versions WHERE id = ?").get(id) as RuleVersionRow | undefined;
    return row ? mapRuleVersion(row) : null;
  }

  getVersionByIdOrThrow(id: string): RuleVersionDto {
    const item = this.getVersionById(id);
    if (!item) throw new ContextOsError("NOT_FOUND", "Rule Version not found", { id });
    return item;
  }

  private latestVersionNumber(ruleId: string): number {
    const row = this.db.prepare("SELECT MAX(version_number) AS version FROM rule_versions WHERE rule_id = ?").get(ruleId) as { version: number | null };
    return row.version ?? 0;
  }
}

function validateVersion(version: RuleVersionDto): string[] {
  const errors: string[] = [];
  if (Object.keys(version.effect).length === 0) errors.push("effect is required");
  if (!Array.isArray(version.conditions)) errors.push("conditions must be an array");
  if (version.precedence < 0) errors.push("precedence must be non-negative");
  return errors;
}

function mapRule(row: RuleRow): RuleDto {
  return {
    id: row.id,
    projectId: row.project_id,
    currentVersionId: row.current_version_id,
    title: row.title,
    description: row.description,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    revision: row.revision,
    archivedAt: iso(row.archived_at)
  };
}

function mapRuleVersion(row: RuleVersionRow): RuleVersionDto {
  return {
    id: row.id,
    ruleId: row.rule_id,
    versionNumber: row.version_number,
    scope: parseObject(row.scope_json),
    conditions: parseArray(row.conditions_json),
    effect: parseObject(row.effect_json),
    enforcementMode: row.enforcement_mode,
    precedence: row.precedence,
    exceptions: parseArray(row.exceptions_json),
    validationState: row.validation_state,
    validationErrors: parseArray(row.validation_errors_json) as string[],
    contentHash: row.content_hash,
    createdByType: row.created_by_type,
    createdById: row.created_by_id,
    createdAt: new Date(row.created_at).toISOString(),
    activatedAt: iso(row.activated_at)
  };
}

