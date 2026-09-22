import { z } from "zod";

/**
 * API-version semantic compaction: configuration + derived-product contracts.
 *
 * Two stages, each with an API implementation and a deterministic fallback:
 *   Evidence (immutable) -> Jev KEEP_FULL / KEEP_CALL_ONLY / DROP -> reconstructed transcript
 *   -> LLM structured Chinese Resume Capsule -> Continue.
 *
 * Nothing here carries a secret. Keys are referenced by name only; the value lives in a
 * local-only, gitignored secret file (or the environment) and is never returned to a client.
 */

export const DEFAULT_JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_LLM_ENDPOINT = "https://ai-gateway.vercel.sh/v1";
export const DEFAULT_LLM_MODEL = "google/gemini-3.8-live";
export const DEFAULT_LLM_REASONING = "none";

/** Bumped whenever the meaning of the stored config changes. */
export const compactionConfigVersion = "contextos-compaction-config.v1";
/** Bumped whenever the Jev question set or the LLM capsule prompt/schema changes. */
export const compactionPromptSchemaVersion = "contextos-compaction-prompt.v1";

export const compactionConfigDefaults = {
  apiCompactionEnabled: false,
  deterministicFallbackEnabled: true,
  jevEnabled: true,
  jevEndpoint: DEFAULT_JEV_ENDPOINT,
  jevModel: DEFAULT_JEV_MODEL,
  jevTimeoutMs: 15_000,
  jevApiKeyEnvRef: "TYPESAFE_API_KEY",
  llmEnabled: true,
  llmEndpoint: DEFAULT_LLM_ENDPOINT,
  llmModel: DEFAULT_LLM_MODEL,
  llmReasoning: DEFAULT_LLM_REASONING,
  llmTimeoutMs: 30_000,
  llmApiKeyEnvRef: "TEXT_MODEL_API_KEY",
  inputTokenBudget: 24_000,
  outputTokenBudget: 4_000,
  preserveRecentMessages: 6,
  keepThreshold: 0.5,
  truncateHeadChars: 300
} as const;

/** Why an API attempt fell back to the deterministic capsule. Never blocks Continue. */
export const compactionDegradationReasonSchema = z.enum([
  "NO_API_KEY",
  "DISABLED",
  "NOT_CONFIGURED",
  "TIMEOUT",
  "RATE_LIMITED",
  "HTTP_ERROR",
  "INVALID_JSON",
  "SCHEMA_INVALID",
  "EVIDENCE_REF_MISSING",
  "TOKEN_BUDGET_EXCEEDED",
  "PROVIDER_ERROR"
]);

/** Which implementation produced the capsule currently on a Session. */
export const capsuleSourceSchema = z.enum(["api", "deterministic"]);

/** One fact, always traceable to the Evidence it came from. */
export const semanticCapsuleFactSchema = z
  .object({
    text: z.string().trim().min(1),
    evidenceIds: z.array(z.string().min(1)).min(1)
  })
  .strict();

/** The structured Chinese Resume Capsule the LLM must return. */
export const structuredResumeCapsuleSchema = z
  .object({
    objective: z.string().trim().min(1),
    currentState: z.string().trim().min(1),
    completed: z.array(semanticCapsuleFactSchema),
    decisions: z.array(semanticCapsuleFactSchema),
    constraints: z.array(semanticCapsuleFactSchema),
    failures: z.array(semanticCapsuleFactSchema),
    unresolved: z.array(semanticCapsuleFactSchema),
    nextActions: z.array(z.string().trim().min(1)),
    recentFiles: z.array(z.string().trim().min(1)),
    evidenceRange: z
      .object({
        from: z.string().min(1),
        to: z.string().min(1),
        count: z.number().int().nonnegative(),
        ids: z.array(z.string().min(1))
      })
      .strict()
  })
  .strict();

/** Derived-product metadata: recorded, never the transcript body. */
export const compactionProviderMetaSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().nullable(),
    configVersion: z.string().min(1),
    promptSchemaVersion: z.string().min(1),
    createdAt: z.string().min(1),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    latencyMs: z.number().int().nonnegative().nullable()
  })
  .strict();

const keyStateShape = {
  /** Whether a key is resolvable right now (secret file or environment). */
  keyConfigured: z.boolean(),
  /** Last 4 characters of the configured key, for a masked display. Never the full key. */
  keyHint: z.string().nullable()
};

export const compactionJevConfigDtoSchema = z
  .object({
    enabled: z.boolean(),
    endpoint: z.string(),
    model: z.string(),
    timeoutMs: z.number().int().positive(),
    ...keyStateShape
  })
  .strict();

export const compactionLlmConfigDtoSchema = z
  .object({
    enabled: z.boolean(),
    endpoint: z.string(),
    model: z.string(),
    reasoning: z.string(),
    timeoutMs: z.number().int().positive(),
    ...keyStateShape
  })
  .strict();

/** `GET /api/settings` view: never contains a key. */
export const compactionApiConfigDtoSchema = z
  .object({
    apiCompactionEnabled: z.boolean(),
    deterministicFallbackEnabled: z.boolean(),
    jev: compactionJevConfigDtoSchema,
    llm: compactionLlmConfigDtoSchema,
    inputTokenBudget: z.number().int().positive(),
    outputTokenBudget: z.number().int().positive(),
    preserveRecentMessages: z.number().int().nonnegative(),
    keepThreshold: z.number().min(0).max(1),
    truncateHeadChars: z.number().int().nonnegative(),
    configVersion: z.string()
  })
  .strict();

const keyPatchShape = {
  /** A real key, accepted once on submit; `null` clears it; `undefined` leaves it untouched. */
  apiKey: z.string().min(1).nullable().optional()
};

export const compactionJevConfigPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    endpoint: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    ...keyPatchShape
  })
  .strict();

export const compactionLlmConfigPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    endpoint: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    reasoning: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    ...keyPatchShape
  })
  .strict();

/** `PATCH /api/settings` view: the only place a key may be sent, exactly once. */
export const compactionApiConfigPatchSchema = z
  .object({
    apiCompactionEnabled: z.boolean().optional(),
    deterministicFallbackEnabled: z.boolean().optional(),
    jev: compactionJevConfigPatchSchema.optional(),
    llm: compactionLlmConfigPatchSchema.optional(),
    inputTokenBudget: z.number().int().positive().optional(),
    outputTokenBudget: z.number().int().positive().optional(),
    preserveRecentMessages: z.number().int().nonnegative().optional(),
    keepThreshold: z.number().min(0).max(1).optional(),
    truncateHeadChars: z.number().int().nonnegative().optional()
  })
  .strict();

export type CompactionDegradationReason = z.infer<typeof compactionDegradationReasonSchema>;
export type CapsuleSource = z.infer<typeof capsuleSourceSchema>;
export type SemanticCapsuleFact = z.infer<typeof semanticCapsuleFactSchema>;
export type StructuredResumeCapsule = z.infer<typeof structuredResumeCapsuleSchema>;
export type CompactionProviderMeta = z.infer<typeof compactionProviderMetaSchema>;
export type CompactionApiConfigDto = z.infer<typeof compactionApiConfigDtoSchema>;
export type CompactionApiConfigPatch = z.infer<typeof compactionApiConfigPatchSchema>;
export type CompactionJevConfigPatch = z.infer<typeof compactionJevConfigPatchSchema>;
export type CompactionLlmConfigPatch = z.infer<typeof compactionLlmConfigPatchSchema>;
