import { createHash } from "node:crypto";
import type { RuleDto, RuleEvaluationDto, RuleEvaluationInput, RuleInput, RulePatch, RuleStatus, RuleValidationResult, RuleVersionDto, RuleVersionInput } from "../../../contracts/src/rules.js";
import type { SessionDto } from "../../../contracts/src/sessions.js";
import type { SqliteReviewItemRepository } from "../../../infrastructure/src/sqlite/core-repositories.js";
import type { SqliteRuleRepository } from "../../../infrastructure/src/sqlite/rule-repository.js";
import { nowMs } from "../../../shared/src/clock.js";
import { ContextOsError } from "../../../shared/src/errors.js";

const evaluatorVersion = "contextos.rules.v1";

export class RuleService {
  constructor(
    private readonly rules: SqliteRuleRepository,
    private readonly reviewItems?: SqliteReviewItemRepository
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
