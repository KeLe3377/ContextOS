import { z } from "zod";
import { contextPackageDtoSchema } from "./context.js";
import { projectDtoSchema } from "./projects.js";

const overviewRefSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  subtitle: z.string().nullable(),
  updatedAt: z.string().nullable()
});

export const workspaceOverviewDtoSchema = z.object({
  project: projectDtoSchema.nullable(),
  kpis: z.object({
    sessions: z.number().int().nonnegative(),
    pendingReviews: z.number().int().nonnegative(),
    readyWorkItems: z.number().int().nonnegative(),
    activeContextItems: z.number().int().nonnegative(),
    activeRules: z.number().int().nonnegative()
  }),
  lastSession: overviewRefSchema.nullable(),
  nextWorkItems: z.array(overviewRefSchema),
  pendingReviews: z.array(overviewRefSchema),
  contextHealth: z.object({
    activeSources: z.number().int().nonnegative(),
    pausedSources: z.number().int().nonnegative(),
    evidenceSnapshots: z.number().int().nonnegative(),
    activeContextItems: z.number().int().nonnegative(),
    staleContextItems: z.number().int().nonnegative()
  }),
  latestContextPackage: contextPackageDtoSchema.nullable()
});

export type WorkspaceOverviewDto = z.infer<typeof workspaceOverviewDtoSchema>;
