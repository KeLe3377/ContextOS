import { z } from "zod";
import { resourceMetaSchema } from "./common.js";

export const reviewItemStatusSchema = z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "DISMISSED"]);
export const reviewItemPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);

export const reviewItemInputSchema = z.object({
  projectId: z.string().min(1),
  sourceType: z.string().min(1),
  sourceId: z.string().min(1),
  triggerType: z.string().min(1),
  priority: reviewItemPrioritySchema.default("MEDIUM"),
  summary: z.string().min(1),
  proposedResolution: z.string().optional()
});

export const reviewResolveSchema = z.object({
  resolutionType: z.string().min(1),
  resolutionReason: z.string().min(1),
  expectedRevision: z.number().int().positive()
});

export const reviewDismissSchema = z.object({
  resolutionReason: z.string().min(1),
  expectedRevision: z.number().int().positive()
});

export const reviewAssignSchema = z.object({
  reviewerId: z.string().min(1),
  expectedRevision: z.number().int().positive()
});

export const reviewItemDtoSchema = resourceMetaSchema.extend({
  projectId: z.string(),
  sourceType: z.string(),
  sourceId: z.string(),
  triggerType: z.string(),
  status: reviewItemStatusSchema,
  priority: reviewItemPrioritySchema,
  summary: z.string(),
  proposedResolution: z.string().nullable(),
  reviewerId: z.string().nullable(),
  resolutionType: z.string().nullable(),
  resolutionReason: z.string().nullable(),
  resolvedAt: z.string().nullable()
});

export type ReviewItemStatus = z.infer<typeof reviewItemStatusSchema>;
export type ReviewItemPriority = z.infer<typeof reviewItemPrioritySchema>;
export type ReviewItemInput = z.infer<typeof reviewItemInputSchema>;
export type ReviewItemDto = z.infer<typeof reviewItemDtoSchema>;
