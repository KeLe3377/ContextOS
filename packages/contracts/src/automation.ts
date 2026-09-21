import { z } from "zod";
import { expectedRevisionSchema, resourceMetaSchema } from "./common.js";
import { contextConfidenceSchema, contextItemTypeSchema } from "./context.js";

/**
 * Automation contracts for the daemon-owned zero-input pipeline.
 *
 * Invariants encoded here (see docs/superpowers/specs/2026-09-20-contextos-zero-input-automation-design.md):
 * - The scheduler only owns job lifecycle; domain semantics live in application services.
 * - Extractors may only ever produce candidates, never governed domain objects.
 * - Rule is deliberately absent from the candidate surface: rules are governance-bearing
 *   and must stay user-authored in this phase.
 * - Public job DTOs never expose the stored payload, because payloads can embed transcript
 *   fragments, file paths and other content that must not leak into status responses or logs.
 */

export const automationModeSchema = z.enum(["OFF", "SUGGEST_ONLY", "AUTO_ACCEPT_HIGH_CONFIDENCE"]);

export const automationJobKindSchema = z.enum([
  "DISCOVER_CODEX_THREADS",
  "SYNC_SESSION_TRANSCRIPT",
  "DISCOVER_PROJECT_SOURCES",
  "SYNC_CONTEXT_SOURCE",
  "COMPACT_EVIDENCE",
  "EXTRACT_EVIDENCE_CONTEXT",
  "RECONCILE_EXTRACTION_CANDIDATES"
]);

/** Job lifecycle states. Terminal states are SUCCEEDED, FAILED and CANCELED. */
export const automationJobStatusSchema = z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"]);

export const automationTerminalJobStatuses = ["SUCCEEDED", "FAILED", "CANCELED"] as const;

export const candidateKindSchema = z.enum(["RESUME_CAPSULE", "CONTEXT_ITEM", "DECISION", "WORK_ITEM"]);

export const candidateStatusSchema = z.enum(["PENDING", "ACCEPTED", "REJECTED", "SUPERSEDED"]);

/** Candidate statuses that still participate in deduplication and review. */
export const candidateActiveStatuses = ["PENDING", "ACCEPTED"] as const;

export const automationSettingsPatchSchema = z
  .object({
    mode: automationModeSchema.optional(),
    pollIntervalMs: z.number().int().min(5_000).max(300_000).optional(),
    maxConcurrentJobs: z.number().int().min(1).max(4).optional(),
    sourceMaxBytes: z.number().int().min(1_024).max(1_000_000).optional(),
    autoAcceptThreshold: z.number().min(0).max(1).optional(),
    expectedRevision: z.number().int().positive()
  })
  .strict();

export const automationSettingsDtoSchema = resourceMetaSchema.extend({
  projectId: z.string(),
  mode: automationModeSchema,
  pollIntervalMs: z.number().int().min(5_000).max(300_000),
  maxConcurrentJobs: z.number().int().min(1).max(4),
  sourceMaxBytes: z.number().int().min(1_024).max(1_000_000),
  autoAcceptThreshold: z.number().min(0).max(1)
});

export const automationSettingsDefaults = {
  mode: "SUGGEST_ONLY",
  pollIntervalMs: 30_000,
  maxConcurrentJobs: 1,
  sourceMaxBytes: 262_144,
  autoAcceptThreshold: 0.9
} as const satisfies Omit<z.infer<typeof automationSettingsDtoSchema>, "id" | "projectId" | "createdAt" | "updatedAt" | "revision">;

export const resumeCapsuleCandidatePayloadSchema = z.object({
  kind: z.literal("RESUME_CAPSULE"),
  summary: z.string().trim().min(1),
  nextAction: z.string().trim().min(1).nullable().default(null)
});

export const contextItemCandidatePayloadSchema = z.object({
  kind: z.literal("CONTEXT_ITEM"),
  itemType: contextItemTypeSchema,
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  body: z.string().optional(),
  confidence: contextConfidenceSchema.default("MEDIUM")
});

export const decisionCandidatePayloadSchema = z.object({
  kind: z.literal("DECISION"),
  title: z.string().trim().min(1),
  statement: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  alternatives: z.array(z.string()).default([]),
  consequences: z.string().optional()
});

export const workItemCandidatePayloadSchema = z.object({
  kind: z.literal("WORK_ITEM"),
  title: z.string().trim().min(1),
  description: z.string().optional(),
  acceptance: z.array(z.string()).default([])
});

/**
 * Strict discriminated union over candidate payloads.
 * Rule payloads are intentionally unrepresentable, so an extractor cannot smuggle one in.
 */
export const extractionCandidatePayloadSchema = z.discriminatedUnion("kind", [
  resumeCapsuleCandidatePayloadSchema,
  contextItemCandidatePayloadSchema,
  decisionCandidatePayloadSchema,
  workItemCandidatePayloadSchema
]);

/**
 * Audit-only provenance for a candidate. It exists for replay and diagnosis, never as the
 * candidate's source of truth — that stays the linked Evidence rows.
 */
export const extractionCandidateProvenanceSchema = z.object({
  sourceArtifactId: z.string().min(1).optional(),
  sourceEvidenceId: z.string().min(1).optional(),
  extractorId: z.string().min(1).optional(),
  extractorVersion: z.string().min(1).optional(),
  extractionInputHash: z.string().min(1).optional()
}).strict();

export const extractionCandidateSchema = resourceMetaSchema
  .extend({
    projectId: z.string(),
    sessionId: z.string().nullable(),
    sourceEvidenceId: z.string().nullable(),
    /** Every Evidence row that supports this candidate, including the direct source. */
    evidenceIds: z.array(z.string()),
    kind: candidateKindSchema,
    fingerprint: z.string().min(1),
    payload: extractionCandidatePayloadSchema,
    confidence: z.number().min(0).max(1),
    status: candidateStatusSchema,
    extractorId: z.string().min(1),
    extractorVersion: z.string().min(1),
    targetResourceType: z.string().nullable(),
    targetResourceId: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    supersededById: z.string().nullable(),
    provenance: extractionCandidateProvenanceSchema
  })
  .refine((candidate) => candidate.payload.kind === candidate.kind, {
    message: "payload.kind must match candidate.kind",
    path: ["payload", "kind"]
  });

export const extractionCandidateListQuerySchema = z.object({
  projectId: z.string().optional(),
  sessionId: z.string().optional(),
  kind: candidateKindSchema.optional(),
  status: candidateStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

export const extractionCandidateAcceptSchema = expectedRevisionSchema.extend({
  /** Optional reviewer edit applied instead of the extracted payload. */
  payload: extractionCandidatePayloadSchema.optional(),
  note: z.string().trim().min(1).max(2_000).optional()
});

export const extractionCandidateRejectSchema = expectedRevisionSchema.extend({
  reason: z.string().trim().min(1).max(2_000).optional()
});

export const extractionCandidateRetrySchema = expectedRevisionSchema;

/**
 * Public job projection. `payload` is deliberately omitted: job payloads may carry
 * transcript-derived content and must not surface in status APIs.
 */
export const automationJobSchema = resourceMetaSchema.extend({
  kind: automationJobKindSchema,
  projectId: z.string().nullable(),
  sessionId: z.string().nullable(),
  resourceType: z.string(),
  resourceId: z.string(),
  idempotencyKey: z.string().min(1),
  status: automationJobStatusSchema,
  availableAt: z.string(),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable()
});

export const automationJobFailureSchema = automationJobSchema.pick({
  id: true,
  kind: true,
  projectId: true,
  failureCode: true,
  failureMessage: true,
  attempts: true,
  endedAt: true
});

export const automationSchedulerStatusSchema = z.object({
  running: z.boolean(),
  startedAt: z.string().nullable(),
  lastTickAt: z.string().nullable(),
  activeJobs: z.number().int().nonnegative()
});

export const automationProjectStatusSchema = z.object({
  projectId: z.string(),
  mode: automationModeSchema,
  lastDiscoveryAt: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  lastExtractionAt: z.string().nullable(),
  pendingCandidates: z.number().int().nonnegative()
});

export const automationStatusSchema = z.object({
  generatedAt: z.string(),
  scheduler: automationSchedulerStatusSchema,
  jobs: z.object({
    total: z.number().int().nonnegative(),
    byStatus: z.record(automationJobStatusSchema, z.number().int().nonnegative()),
    byKind: z.record(automationJobKindSchema, z.number().int().nonnegative()),
    latestFailures: z.array(automationJobFailureSchema)
  }),
  projects: z.array(automationProjectStatusSchema),
  extractor: z.object({
    id: z.string(),
    version: z.string(),
    available: z.boolean()
  }),
  candidates: z.object({
    pending: z.number().int().nonnegative()
  })
});

export const automationRunDiscoveryInputSchema = z
  .object({
    projectId: z.string().min(1).optional()
  })
  .strict();

export const automationRunDiscoveryResultSchema = z.object({
  enqueued: z.number().int().nonnegative(),
  jobs: z.array(automationJobSchema)
});

export const extractionCandidateTransitionResultSchema = z.object({
  candidate: extractionCandidateSchema,
  appliedResourceType: z.string().nullable(),
  appliedResourceId: z.string().nullable()
});

export type AutomationMode = z.infer<typeof automationModeSchema>;
export type AutomationJobKind = z.infer<typeof automationJobKindSchema>;
export type AutomationJobStatus = z.infer<typeof automationJobStatusSchema>;
export type AutomationSettingsPatch = z.infer<typeof automationSettingsPatchSchema>;
export type AutomationSettingsDto = z.infer<typeof automationSettingsDtoSchema>;
export type CandidateKind = z.infer<typeof candidateKindSchema>;
export type CandidateStatus = z.infer<typeof candidateStatusSchema>;
export type ExtractionCandidateProvenance = z.infer<typeof extractionCandidateProvenanceSchema>;
export type ExtractionCandidatePayload = z.infer<typeof extractionCandidatePayloadSchema>;
export type ResumeCapsuleCandidatePayload = z.infer<typeof resumeCapsuleCandidatePayloadSchema>;
export type ContextItemCandidatePayload = z.infer<typeof contextItemCandidatePayloadSchema>;
export type DecisionCandidatePayload = z.infer<typeof decisionCandidatePayloadSchema>;
export type WorkItemCandidatePayload = z.infer<typeof workItemCandidatePayloadSchema>;
export type ExtractionCandidateDto = z.infer<typeof extractionCandidateSchema>;
export type ExtractionCandidateListQuery = z.infer<typeof extractionCandidateListQuerySchema>;
export type ExtractionCandidateAcceptInput = z.infer<typeof extractionCandidateAcceptSchema>;
export type ExtractionCandidateRejectInput = z.infer<typeof extractionCandidateRejectSchema>;
export type AutomationJobDto = z.infer<typeof automationJobSchema>;
export type AutomationJobFailureDto = z.infer<typeof automationJobFailureSchema>;
export type AutomationSchedulerStatus = z.infer<typeof automationSchedulerStatusSchema>;
export type AutomationProjectStatus = z.infer<typeof automationProjectStatusSchema>;
export type AutomationStatusDto = z.infer<typeof automationStatusSchema>;
export type AutomationRunDiscoveryInput = z.infer<typeof automationRunDiscoveryInputSchema>;
export type AutomationRunDiscoveryResult = z.infer<typeof automationRunDiscoveryResultSchema>;
export type ExtractionCandidateTransitionResult = z.infer<typeof extractionCandidateTransitionResultSchema>;
