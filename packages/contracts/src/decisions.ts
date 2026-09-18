import { z } from "zod";
import { resourceMetaSchema } from "./common.js";

export const decisionStatusSchema = z.enum(["DRAFT", "PROPOSED", "ACCEPTED", "SUPERSEDED", "REVERSED", "ARCHIVED"]);

export const decisionInputSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  statement: z.string().min(1),
  rationale: z.string().min(1),
  problemContext: z.string().optional(),
  alternatives: z.array(z.string()).default([]),
  consequences: z.string().optional(),
  references: z.array(z.string()).default([])
});

export const decisionPatchSchema = z.object({
  title: z.string().min(1).optional(),
  statement: z.string().min(1).optional(),
  rationale: z.string().min(1).optional(),
  problemContext: z.string().optional(),
  alternatives: z.array(z.string()).optional(),
  consequences: z.string().optional(),
  references: z.array(z.string()).optional(),
  expectedRevision: z.number().int().positive()
});

export const decisionDtoSchema = resourceMetaSchema.extend({
  projectId: z.string(),
  status: decisionStatusSchema,
  title: z.string(),
  currentVersionId: z.string().nullable(),
  archivedAt: z.string().nullable()
});

export const decisionVersionDtoSchema = z.object({
  id: z.string(),
  decisionId: z.string(),
  versionNumber: z.number().int().positive(),
  state: z.enum(["DRAFT", "PROPOSED", "ACCEPTED", "SUPERSEDED", "REVERSED"]),
  statement: z.string(),
  problemContext: z.string().nullable(),
  rationale: z.string(),
  alternatives: z.array(z.string()),
  consequences: z.string().nullable(),
  references: z.array(z.string()),
  contentHash: z.string(),
  createdByType: z.string(),
  createdById: z.string().nullable(),
  createdAt: z.string(),
  acceptedAt: z.string().nullable(),
  supersedesVersionId: z.string().nullable(),
  reversesVersionId: z.string().nullable()
});

export type DecisionStatus = z.infer<typeof decisionStatusSchema>;
export type DecisionInput = z.infer<typeof decisionInputSchema>;
export type DecisionPatch = z.infer<typeof decisionPatchSchema>;
export type DecisionDto = z.infer<typeof decisionDtoSchema>;
export type DecisionVersionDto = z.infer<typeof decisionVersionDtoSchema>;
