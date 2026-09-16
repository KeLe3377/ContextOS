import { z } from "zod";
import { expectedRevisionSchema, resourceMetaSchema } from "./common.js";

export const contextSourceTypeSchema = z.enum(["FILE", "DIRECTORY", "URL", "AGENT_OUTPUT", "USER_NOTE"]);
export const contextSourceStatusSchema = z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]);

export const contextSourceInputSchema = z.object({
  projectId: z.string().min(1),
  sourceType: contextSourceTypeSchema,
  name: z.string().trim().min(1),
  locator: z.string().trim().min(1),
  description: z.string().trim().optional(),
  metadata: z.record(z.unknown()).default({})
});

export const contextSourcePatchSchema = expectedRevisionSchema.extend({
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().optional(),
  metadata: z.record(z.unknown()).optional()
});

export const contextSourceDtoSchema = resourceMetaSchema.extend({
  projectId: z.string(),
  sourceType: contextSourceTypeSchema,
  name: z.string(),
  locator: z.string(),
  description: z.string().nullable(),
  status: contextSourceStatusSchema,
  metadata: z.record(z.unknown()),
  lastSnapshotId: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  archivedAt: z.string().nullable()
});

export const evidenceTypeSchema = z.enum(["TEXT", "FILE", "DIRECTORY_LISTING", "URL", "COMMAND_OUTPUT", "AGENT_OUTPUT"]);

export const evidenceSnapshotInputSchema = z.object({
  projectId: z.string().min(1),
  sourceId: z.string().min(1).optional(),
  evidenceType: evidenceTypeSchema,
  title: z.string().trim().min(1),
  uri: z.string().trim().optional(),
  contentText: z.string().optional(),
  contentHash: z.string().trim().min(1).optional(),
  metadata: z.record(z.unknown()).default({})
});

export const evidenceSnapshotDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  sourceId: z.string().nullable(),
  evidenceType: evidenceTypeSchema,
  title: z.string(),
  uri: z.string().nullable(),
  contentText: z.string().nullable(),
  contentHash: z.string(),
  storageRef: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  metadata: z.record(z.unknown()),
  capturedAt: z.string(),
  createdAt: z.string()
});

export const contextItemTypeSchema = z.enum(["FACT", "SUMMARY", "CONSTRAINT", "OPEN_QUESTION", "RISK", "HANDOFF"]);
export const contextItemStatusSchema = z.enum(["DRAFT", "ACTIVE", "STALE", "ARCHIVED"]);
export const contextConfidenceSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);

export const contextItemInputSchema = z.object({
  projectId: z.string().min(1),
  sourceSnapshotId: z.string().min(1).optional(),
  itemType: contextItemTypeSchema,
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  body: z.string().optional(),
  confidence: contextConfidenceSchema.default("MEDIUM"),
  metadata: z.record(z.unknown()).default({})
});

export const contextItemPatchSchema = expectedRevisionSchema.extend({
  title: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1).optional(),
  body: z.string().optional(),
  confidence: contextConfidenceSchema.optional(),
  metadata: z.record(z.unknown()).optional()
});

export const contextItemDtoSchema = resourceMetaSchema.extend({
  projectId: z.string(),
  sourceSnapshotId: z.string().nullable(),
  itemType: contextItemTypeSchema,
  status: contextItemStatusSchema,
  title: z.string(),
  summary: z.string(),
  body: z.string().nullable(),
  confidence: contextConfidenceSchema,
  metadata: z.record(z.unknown()),
  archivedAt: z.string().nullable()
});

export type ContextSourceType = z.infer<typeof contextSourceTypeSchema>;
export type ContextSourceStatus = z.infer<typeof contextSourceStatusSchema>;
export type ContextSourceInput = z.infer<typeof contextSourceInputSchema>;
export type ContextSourcePatch = z.infer<typeof contextSourcePatchSchema>;
export type ContextSourceDto = z.infer<typeof contextSourceDtoSchema>;

export type EvidenceType = z.infer<typeof evidenceTypeSchema>;
export type EvidenceSnapshotInput = z.infer<typeof evidenceSnapshotInputSchema>;
export type EvidenceSnapshotDto = z.infer<typeof evidenceSnapshotDtoSchema>;

export type ContextItemType = z.infer<typeof contextItemTypeSchema>;
export type ContextItemStatus = z.infer<typeof contextItemStatusSchema>;
export type ContextConfidence = z.infer<typeof contextConfidenceSchema>;
export type ContextItemInput = z.infer<typeof contextItemInputSchema>;
export type ContextItemPatch = z.infer<typeof contextItemPatchSchema>;
export const contextPackageEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  contentHash: z.string().nullable(),
  revision: z.number().int().nullable(),
  selectionReason: z.string()
});

export const contextPackageDtoSchema = resourceMetaSchema.extend({
  projectId: z.string(),
  sessionId: z.string(),
  name: z.string(),
  purpose: z.string(),
  contextItems: z.array(contextPackageEntrySchema),
  evidenceSnapshots: z.array(contextPackageEntrySchema),
  manifest: z.record(z.unknown())
});

export type ContextItemDto = z.infer<typeof contextItemDtoSchema>;
export type ContextPackageEntryDto = z.infer<typeof contextPackageEntrySchema>;
export type ContextPackageDto = z.infer<typeof contextPackageDtoSchema>;



