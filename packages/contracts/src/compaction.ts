import { z } from "zod";
import { resourceMetaSchema } from "./common.js";

/**
 * A Compaction Artifact is a versioned derived product: it records what a compaction provider
 * made of one immutable Evidence Snapshot, without ever changing that Evidence.
 *
 * Identity is `sourceContentHash + providerId + providerVersion + sanitizerVersion + optionsHash`,
 * so the same input under the same configuration is computed once and reused, while a provider or
 * configuration change produces a new artifact instead of overwriting history.
 */

export const compactionArtifactStatusSchema = z.enum(["SUCCEEDED", "FALLBACK"]);

/**
 * Mirrors the transcript event shape. Declared here rather than imported so the contract stays
 * self-contained and validates what it stores.
 *
 * Strict on purpose: an event may not smuggle an extra identity or content field past the row
 * level checks.
 */
export const compactionEventSchema = z.object({
  ordinal: z.number().int(),
  timestamp: z.string().optional(),
  kind: z.enum(["message", "tool_call", "tool_result", "summary"]),
  role: z.enum(["user", "assistant", "system"]).optional(),
  text: z.string().optional(),
  name: z.string().optional(),
  callId: z.string().optional(),
  truncated: z.boolean().optional(),
  /** Absent means the transcript carried no outcome signal; it never means "succeeded". */
  isError: z.boolean().optional()
}).strict();

export const compactionEventsSchema = z.array(compactionEventSchema);

export const compactionDecisionSchema = z.object({
  callId: z.string().nullable(),
  ordinal: z.number().int().nullable(),
  action: z.enum(["KEEP", "TRUNCATE_RESULT"]),
  reason: z.string().min(1).max(64),
  charsBefore: z.number().int().nonnegative(),
  charsAfter: z.number().int().nonnegative()
}).strict();

export const compactionDecisionsSchema = z.array(compactionDecisionSchema);

export const compactionStatsSchema = z.object({
  messagesBefore: z.number().int().nonnegative(),
  messagesAfter: z.number().int().nonnegative(),
  charsBefore: z.number().int().nonnegative(),
  charsAfter: z.number().int().nonnegative(),
  pairedCalls: z.number().int().nonnegative(),
  truncatedResults: z.number().int().nonnegative(),
  pinnedMessages: z.number().int().nonnegative()
}).strict();

export const compactionArtifactIdentitySchema = z.object({
  sourceContentHash: z.string().min(1),
  providerId: z.string().min(1),
  providerVersion: z.string().min(1),
  sanitizerVersion: z.string().min(1),
  optionsHash: z.string().min(1)
});

export const compactionArtifactDtoSchema = resourceMetaSchema.extend({
  projectId: z.string(),
  sessionId: z.string().nullable(),
  sourceEvidenceId: z.string(),
  sourceContentHash: z.string(),
  providerId: z.string(),
  providerVersion: z.string(),
  sanitizerVersion: z.string(),
  optionsHash: z.string(),
  status: compactionArtifactStatusSchema,
  events: compactionEventsSchema,
  decisions: compactionDecisionsSchema,
  stats: compactionStatsSchema,
  /** Populated only for FALLBACK artifacts; never contains transcript content. */
  failureCode: z.string().nullable()
});

export type CompactionArtifactStatus = z.infer<typeof compactionArtifactStatusSchema>;
export type CompactionEvent = z.infer<typeof compactionEventSchema>;
export type CompactionDecision = z.infer<typeof compactionDecisionSchema>;
export type CompactionArtifactStats = z.infer<typeof compactionStatsSchema>;
export type CompactionArtifactIdentity = z.infer<typeof compactionArtifactIdentitySchema>;
export type CompactionArtifactDto = z.infer<typeof compactionArtifactDtoSchema>;
