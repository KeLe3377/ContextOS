import { z } from "zod";
import { resourceMetaSchema } from "./common.js";

export const workItemStatusSchema = z.enum(["BACKLOG", "READY", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE", "CANCELED"]);

export const workItemInputSchema = z.object({
  projectId: z.string().min(1),
  parentId: z.string().nullable().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  acceptance: z.array(z.string()).default([]),
  executionContract: z.string().optional()
});

export const workItemPatchSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  expectedRevision: z.number().int().positive()
});

export const workItemDtoSchema = resourceMetaSchema.extend({
  projectId: z.string(),
  parentId: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  status: workItemStatusSchema,
  acceptance: z.array(z.string()),
  executionContract: z.string().nullable(),
  readinessState: z.record(z.unknown()),
  completedAt: z.string().nullable()
});

export type WorkItemStatus = z.infer<typeof workItemStatusSchema>;
export type WorkItemInput = z.infer<typeof workItemInputSchema>;
export type WorkItemPatch = z.infer<typeof workItemPatchSchema>;
export type WorkItemDto = z.infer<typeof workItemDtoSchema>;
