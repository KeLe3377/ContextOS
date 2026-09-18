import { z } from "zod";
import { resourceMetaSchema } from "./common.js";
import type { SessionDto } from "./sessions.js";

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
  parentId: z.string().min(1).nullable().optional(),
  dependencyIds: z.array(z.string().min(1)).optional(),
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  acceptance: z.array(z.string()).optional(),
  executionContract: z.string().nullable().optional(),
  expectedRevision: z.number().int().positive()
});

export const workItemStartSessionSchema = z.object({
  agentAdapterId: z.string().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  intent: z.string().trim().min(1).optional(),
  expectedRevision: z.number().int().positive()
});

export const workItemDependencyDtoSchema = z.object({
  workItemId: z.string(),
  dependsOnId: z.string(),
  dependencyType: z.string(),
  status: workItemStatusSchema
});

export const workItemReadinessDtoSchema = z.object({
  ready: z.boolean(),
  blockers: z.array(workItemDependencyDtoSchema)
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
export type WorkItemStartSessionInput = z.infer<typeof workItemStartSessionSchema>;
export type WorkItemDto = z.infer<typeof workItemDtoSchema>;
export type WorkItemDependencyDto = z.infer<typeof workItemDependencyDtoSchema>;
export type WorkItemReadinessDto = z.infer<typeof workItemReadinessDtoSchema>;

export type WorkItemAttemptDto = {
  id: string;
  workItemId: string;
  sessionId: string | null;
  status: "STARTED" | "SUCCEEDED" | "FAILED" | "CANCELED";
  summary: string | null;
  resultRef: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  session: SessionDto | null;
};

export type WorkItemStartSessionResult = {
  workItem: WorkItemDto;
  attempt: WorkItemAttemptDto;
  session: SessionDto;
};
