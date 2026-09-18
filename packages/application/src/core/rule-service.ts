import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RuleDto, RuleEvaluationDto, RuleEvaluationInput, RuleInput, RuleInstructionRenderDto, RuleInstructionRenderInput, RulePatch, RuleStatus, RuleValidationResult, RuleVersionDto, RuleVersionInput } from "../../../contracts/src/rules.js";
import type { SessionDto } from "../../../contracts/src/sessions.js";
import type { SqliteReviewItemRepository } from "../../../infrastructure/src/sqlite/core-repositories.js";
import type { SqliteProjectRepository } from "../../../infrastructure/src/sqlite/project-repository.js";
import type { SqliteRuleRepository } from "../../../infrastructure/src/sqlite/rule-repository.js";
import { nowMs } from "../../../shared/src/clock.js";
import { ContextOsError } from "../../../shared/src/errors.js";

const evaluatorVersion = "contextos.rules.v1";

export class RuleService {
  constructor(
    private readonly rules: SqliteRuleRepository,
    private readonly reviewItems?: SqliteReviewItemRepository,
    private readonly projects?: SqliteProjectRepository
  ) {}

  create(input: RuleInput): RuleDto {
    return this.rules.create(input, nowMs());
  }

  list(input: { projectId?: string; status?: string; q?: string; limit: number }): RuleDto[] {
    return this.rules.list(input);
  }

  get(id: string): RuleDto {
    return this.rules.getByIdOrThrow(id);
  }

  patch(id: string, input: RulePatch): RuleDto {
    return this.rules.patch(id, input, nowMs());
  }

  validate(id: string): RuleValidationResult {
    return this.rules.validateCurrent(id, nowMs());
  }

  transition(id: string, action: "activate" | "disable" | "archive" | "restore", expectedRevision: number): RuleDto {
    const statusByAction: Record<typeof action, RuleStatus> = {
      activate: "ACTIVE",
      disable: "DISABLED",
      archive: "ARCHIVED",
      restore: "DRAFT"
    };
    return this.rules.updateStatus(id, statusByAction[action], expectedRevision, nowMs());
  }

  createVersion(id: string, input: RuleVersionInput): RuleVersionDto {
    return this.rules.createVersion(id, input, nowMs());
  }

  listVersions(id: string): RuleVersionDto[] {
    return this.rules.listVersions(id);
  }

  test(id: string, input: RuleEvaluationInput): RuleEvaluationDto {
    const rule = this.rules.getByIdOrThrow(id);
    const version = this.rules.getCurrentVersion(id);
    return this.evaluateAndRecord(rule, version, input);
  }

  listEvaluations(id: string): RuleEvaluationDto[] {
    return this.rules.listEvaluations(id);
  }

  getUsage(id: string): { evaluationCount: number; matchedCount: number; lastEvaluatedAt: string | null } {
    return this.rules.getUsage(id);
  }

  renderInstructions(input: RuleInstructionRenderInput): RuleInstructionRenderDto {
    if (!this.projects) throw new Error("Project repository is not configured");
    const project = this.projects.getByIdOrThrow(input.projectId);
    const activeRules = this.rules.listActiveWithVersions(project.id);
    const path = instructionTargetPath(input.target, project.rootPath);
    const existingContent = readTextIfExists(path);
    const content = renderInstructionBlock(project.name, activeRules);
    const nextContent = mergeManagedBlock(existingContent ?? "", content);
    if (input.apply) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, nextContent, "utf8");
    }
    return { projectId: project.id, target: input.target, path, content, existingContent, nextContent, activeRuleCount: activeRules.length, applied: input.apply };
  }

  evaluateSessionContinue(session: SessionDto): void {
    const sample: RuleEvaluationInput = {
      eventType: "session.continue",
      resourceType: "session",
      resourceId: session.id,
      data: {
        projectId: session.projectId,
        status: session.status,
        adapterId: session.agentAdapterId,
        title: session.title,
        intent: session.intent
      }
    };
    for (const { rule, version } of this.rules.listActiveWithVersions(session.projectId)) {
      const evaluation = this.evaluateAndRecord(rule, version, sample);
      if (evaluation.result !== "MATCHED") continue;
      if (version.enforcementMode === "REQUIRE_REVIEW") {
        this.reviewItems?.create({
          projectId: session.projectId,
          sourceType: "RULE",
          sourceId: rule.id,
          triggerType: "SESSION_CONTINUE",
          priority: "HIGH",
          summary: stringValue(version.effect.reason) ?? `Rule requires review: ${rule.title}`,
          proposedResolution: stringValue(version.effect.action)
        }, nowMs());
      }
      if (version.enforcementMode === "BLOCK") {
        throw new ContextOsError("CONFLICT", stringValue(version.effect.reason) ?? `Blocked by rule: ${rule.title}`, {
          ruleId: rule.id,
          evaluationId: evaluation.id
        });
      }
    }
  }

  private evaluateAndRecord(rule: RuleDto, version: RuleVersionDto, sample: RuleEvaluationInput): RuleEvaluationDto {
    const outcome = evaluateRule(version, sample);
    return this.rules.recordEvaluation({
      rule,
      version,
      sample,
      inputHash: createHash("sha256").update(stableJson(sample)).digest("hex"),
      result: outcome.matched ? "MATCHED" : "NOT_MATCHED",
      explanation: outcome.explanation,
      evaluatorVersion
    }, nowMs());
  }
}

const managedStart = "<!-- CONTEXTOS_RULES_START -->";
const managedEnd = "<!-- CONTEXTOS_RULES_END -->";

function instructionTargetPath(target: string, projectRoot: string): string {
  switch (target) {
    case "PROJECT_AGENTS": return join(projectRoot, "AGENTS.md");
    case "PROJECT_CLAUDE": return join(projectRoot, "CLAUDE.md");
    case "GLOBAL_AGENTS": return join(homedir(), ".codex", "AGENTS.md");
    case "GLOBAL_CLAUDE": return join(homedir(), ".claude", "CLAUDE.md");
    default: throw new ContextOsError("INVALID_ARGUMENT", "Unknown instruction target", { target });
  }
}

function readTextIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function mergeManagedBlock(existingContent: string, content: string): string {
  const block = `${managedStart}\n${content.trim()}\n${managedEnd}`;
  const pattern = new RegExp(`${escapeRegExp(managedStart)}[\\s\\S]*?${escapeRegExp(managedEnd)}`);
  if (pattern.test(existingContent)) return existingContent.replace(pattern, block);
  const trimmed = existingContent.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

function renderInstructionBlock(projectName: string, items: Array<{ rule: RuleDto; version: RuleVersionDto }>): string {
  const lines = [
    "## ContextOS Rules",
    "",
    `Project: ${projectName}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "These instructions are generated from ACTIVE ContextOS rules. Edit rules in ContextOS, then re-apply this block.",
    ""
  ];
  if (!items.length) {
    lines.push("- No active ContextOS rules.");
    return lines.join("\n");
  }
  for (const { rule, version } of items) {
    lines.push(`- [${version.enforcementMode}] ${rule.title}`);
    if (rule.description) lines.push(`  - Description: ${rule.description}`);
    lines.push(`  - Precedence: ${version.precedence}`);
    const reason = stringValue(version.effect.reason);
    const action = stringValue(version.effect.action);
    if (reason) lines.push(`  - Reason: ${reason}`);
    if (action) lines.push(`  - Required action: ${action}`);
    lines.push(`  - Scope: \`${stableJson(version.scope)}\``);
    if (version.conditions.length) lines.push(`  - Conditions: \`${stableJson(version.conditions)}\``);
    if (version.exceptions.length) lines.push(`  - Exceptions: \`${stableJson(version.exceptions)}\``);
  }
  return lines.join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function evaluateRule(version: RuleVersionDto, sample: RuleEvaluationInput): { matched: boolean; explanation: string } {
  const resourceTypes = arrayOfStrings(version.scope.resourceTypes);
  if (resourceTypes.length && !resourceTypes.includes(sample.resourceType)) {
    return { matched: false, explanation: `Resource type ${sample.resourceType} is outside rule scope.` };
  }
  const eventTypes = arrayOfStrings(version.scope.eventTypes);
  if (eventTypes.length && !eventTypes.includes(sample.eventType)) {
    return { matched: false, explanation: `Event type ${sample.eventType} is outside rule scope.` };
  }
  for (const condition of version.conditions) {
    if (!matchesCondition(condition, sample)) return { matched: false, explanation: "A rule condition did not match." };
  }
  for (const exception of version.exceptions) {
    if (matchesCondition(exception, sample)) return { matched: false, explanation: "A rule exception matched." };
  }
  return { matched: true, explanation: "Scope and all conditions matched." };
}

function matchesCondition(value: unknown, sample: RuleEvaluationInput): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const condition = value as Record<string, unknown>;
  if (typeof condition.field !== "string" || typeof condition.operator !== "string") return false;
  const actual = resolveField(sample, condition.field);
  switch (condition.operator) {
    case "exists": return actual !== undefined && actual !== null;
    case "equals": return Object.is(actual, condition.value);
    case "not_equals": return !Object.is(actual, condition.value);
    case "in": return Array.isArray(condition.value) && condition.value.some((item) => Object.is(item, actual));
    case "contains": return Array.isArray(actual) ? actual.some((item) => Object.is(item, condition.value)) : typeof actual === "string" && typeof condition.value === "string" && actual.includes(condition.value);
    default: return false;
  }
}

function resolveField(sample: RuleEvaluationInput, field: string): unknown {
  const root = field in sample ? sample as unknown as Record<string, unknown> : sample.data;
  return field.split(".").reduce<unknown>((current, part) => current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined, root);
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
