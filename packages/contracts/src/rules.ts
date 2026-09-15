import { z } from "zod";
import { expectedRevisionSchema, resourceMetaSchema } from "./common.js";

export const ruleStatusSchema = z.enum(["DRAFT", "ACTIVE", "DISABLED", "ARCHIVED"]);
export const ruleEnforcementModeSchema = z.enum(["ADVISORY", "WARNING", "REQUIRE_REVIEW", "BLOCK"]);
export const ruleValidationStateSchema = z.enum(["UNKNOWN", "VALID", "INVALID"]);

const jsonObjectSchema = z.record(z.unknown());
const jsonArraySchema = z.array(z.unknown());

export const ruleInputSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().optional(),
  scope: jsonObjectSchema.default({}),
  conditions: jsonArraySchema.default([]),
  effect: jsonObjectSchema.default({}),
  enforcementMode: ruleEnforcementModeSchema.default("REQUIRE_REVIEW"),
  precedence: z.number().int().min(0).max(10000).default(100),
  exceptions: jsonArraySchema.default([])
});

export const rulePatchSchema = expectedRevisionSchema.extend({
  title: z.string().trim().min(1).optional(),
  description: z.string().trim().optional()
});

export const ruleVersionInputSchema = expectedRevisionSchema.extend({
  scope: jsonObjectSchema.default({}),
  conditions: jsonArraySchema.default([]),
  effect: jsonObjectSchema.default({}),
  enforcementMode: ruleEnforcementModeSchema.default("REQUIRE_REVIEW"),
  precedence: z.number().int().min(0).max(10000).default(100),
  exceptions: jsonArraySchema.default([])
});

export const ruleDtoSchema = resourceMetaSchema.extend({
  projectId: z.string(),
  currentVersionId: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  status: ruleStatusSchema,
  archivedAt: z.string().nullable()
});

export const ruleVersionDtoSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  versionNumber: z.number().int().positive(),
  scope: jsonObjectSchema,
  conditions: jsonArraySchema,
  effect: jsonObjectSchema,
  enforcementMode: ruleEnforcementModeSchema,
  precedence: z.number().int(),
  exceptions: jsonArraySchema,
  validationState: ruleValidationStateSchema,
  validationErrors: z.array(z.string()),
  contentHash: z.string(),
  createdByType: z.string(),
  createdById: z.string().nullable(),
  createdAt: z.string(),
  activatedAt: z.string().nullable()
});

export const ruleValidationResultSchema = z.object({
  rule: ruleDtoSchema,
  version: ruleVersionDtoSchema,
  valid: z.boolean(),
  errors: z.array(z.string())
});

export type RuleStatus = z.infer<typeof ruleStatusSchema>;
export type RuleEnforcementMode = z.infer<typeof ruleEnforcementModeSchema>;
export type RuleValidationState = z.infer<typeof ruleValidationStateSchema>;
export type RuleInput = z.infer<typeof ruleInputSchema>;
export type RulePatch = z.infer<typeof rulePatchSchema>;
export type RuleVersionInput = z.infer<typeof ruleVersionInputSchema>;
export type RuleDto = z.infer<typeof ruleDtoSchema>;
export type RuleVersionDto = z.infer<typeof ruleVersionDtoSchema>;
export type RuleValidationResult = z.infer<typeof ruleValidationResultSchema>;
