import { z } from "zod";
import { resourceMetaSchema } from "./common.js";

export const projectStatusSchema = z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]);

export const projectInputSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().optional(),
  rootPath: z.string().trim().min(1),
  defaultRuleIds: z.array(z.string()).default([]),
  agentAdapterIds: z.array(z.string()).default([])
});

export const projectDtoSchema = resourceMetaSchema.extend({
  name: z.string(),
  description: z.string().nullable(),
  rootPath: z.string(),
  status: projectStatusSchema,
  defaultRuleIds: z.array(z.string()),
  agentAdapterIds: z.array(z.string()),
  archivedAt: z.string().nullable()
});

export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type ProjectInput = z.infer<typeof projectInputSchema>;
export type ProjectDto = z.infer<typeof projectDtoSchema>;

