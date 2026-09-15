import { z } from "zod";
import { resourceMetaSchema } from "./common.js";

export const sessionStatusSchema = z.enum(["CREATED", "RUNNING", "PAUSED", "COMPLETED", "FAILED", "ARCHIVED"]);

export const sessionInputSchema = z.object({
  projectId: z.string().min(1),
  agentAdapterId: z.string().min(1),
  title: z.string().optional(),
  intent: z.string().optional()
});

export const sessionPatchSchema = z.object({
  title: z.string().optional(),
  intent: z.string().optional(),
  expectedRevision: z.number().int().positive()
});

export const sessionDtoSchema = resourceMetaSchema.extend({
  projectId: z.string(),
  agentAdapterId: z.string(),
  externalSessionId: z.string().nullable(),
  title: z.string().nullable(),
  intent: z.string().nullable(),
  status: sessionStatusSchema,
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  archivedAt: z.string().nullable()
});

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SessionInput = z.infer<typeof sessionInputSchema>;
export type SessionPatch = z.infer<typeof sessionPatchSchema>;
export type SessionDto = z.infer<typeof sessionDtoSchema>;
