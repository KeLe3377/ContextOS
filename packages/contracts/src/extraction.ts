import { z } from "zod";
import { contextItemTypeSchema } from "./context.js";

/**
 * The strict contract a Context Extractor must answer with.
 *
 * Everything here is deliberately bounded and closed: the model never returns a fingerprint, a
 * rule, a decision or a work item, and any extra field is rejected outright. ContextOS derives
 * the fingerprint itself from `fingerprintMaterial`, so a model can never decide a candidate's
 * identity.
 *
 * Design: docs/2026-09-20-contextos-jev-compaction-integration-design.md §12
 */

export const extractionResumeCapsuleSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  nextAction: z.string().trim().min(1).max(500)
}).strict();

export const extractionContextItemSchema = z.object({
  /** Reuses the Context Item vocabulary, which has no RULE member. */
  itemType: contextItemTypeSchema,
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(1_000),
  body: z.string().trim().min(1).max(8_000),
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(z.string().min(1)).min(1).max(20),
  /** Normalised locally into the candidate fingerprint; the model never sees the result. */
  fingerprintMaterial: z.string().trim().min(1).max(2_000),
  explanation: z.string().trim().min(1).max(1_000)
}).strict();

export const extractionOutputSchema = z.object({
  resumeCapsule: extractionResumeCapsuleSchema,
  contextItems: z.array(extractionContextItemSchema).max(10)
}).strict();

export type ExtractionResumeCapsule = z.infer<typeof extractionResumeCapsuleSchema>;
export type ExtractionContextItem = z.infer<typeof extractionContextItemSchema>;
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;
