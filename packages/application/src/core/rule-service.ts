import type { RuleDto, RuleInput, RulePatch, RuleStatus, RuleValidationResult, RuleVersionDto, RuleVersionInput } from "../../../contracts/src/rules.js";
import type { SqliteRuleRepository } from "../../../infrastructure/src/sqlite/rule-repository.js";
import { nowMs } from "../../../shared/src/clock.js";

export class RuleService {
  constructor(private readonly rules: SqliteRuleRepository) {}

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
}
