import { z } from "zod";
import type { EvidenceSnapshotDto } from "./context.js";
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

export const resumeCapsuleDtoSchema = z.object({
  sessionId: z.string(),
  status: sessionStatusSchema,
  intent: z.string().nullable(),
  summary: z.string(),
  nextAction: z.string().nullable(),
  lastRunId: z.string().nullable(),
  evidenceSnapshotIds: z.array(z.string()),
  updatedAt: z.string()
});

export const transcriptImportInputSchema = z.object({
  contentText: z.string().max(1_000_000).refine((value) => value.trim().length > 0, "Transcript text is required"),
  summary: z.string().refine((value) => value.trim().length > 0, "Summary must not be blank").optional(),
  title: z.string().refine((value) => value.trim().length > 0, "Title must not be blank").optional()
});

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SessionInput = z.infer<typeof sessionInputSchema>;
export type SessionPatch = z.infer<typeof sessionPatchSchema>;
export type SessionDto = z.infer<typeof sessionDtoSchema>;
export type ResumeCapsuleDto = z.infer<typeof resumeCapsuleDtoSchema>;
export type TranscriptImportInput = z.infer<typeof transcriptImportInputSchema>;
export type TranscriptImportResult = {
  evidence: EvidenceSnapshotDto;
  resumeCapsule: ResumeCapsuleDto;
};

