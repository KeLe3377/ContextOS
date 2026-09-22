import { z } from "zod";
import {
  DEFAULT_JEV_ENDPOINT,
  DEFAULT_JEV_MODEL,
  DEFAULT_LLM_ENDPOINT,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_REASONING,
  compactionConfigVersion,
  type CompactionApiConfigDto
} from "../../../../contracts/src/semantic-compaction.js";
import type { CompactionOptions } from "../../ports/semantic-compaction.js";
import type { CompactionRuntimeConfig } from "./coordinator.js";

/**
 * The non-secret configuration that lives in the settings row.
 *
 * Keys are never here. `*KeyHint` is the last four characters of a key saved through the UI, kept
 * only so the settings screen can show `••••abcd`; `*ApiKeyEnvRef` names an environment variable
 * the key may also be read from (headless installs).
 */
export const compactionStoredConfigSchema = z.object({
  apiCompactionEnabled: z.boolean().default(false),
  deterministicFallbackEnabled: z.boolean().default(true),
  jevEnabled: z.boolean().default(true),
  jevEndpoint: z.string().default(DEFAULT_JEV_ENDPOINT),
  jevModel: z.string().default(DEFAULT_JEV_MODEL),
  jevTimeoutMs: z.number().int().positive().default(15_000),
  jevApiKeyEnvRef: z.string().default("TYPESAFE_API_KEY"),
  jevKeyHint: z.string().nullable().default(null),
  llmEnabled: z.boolean().default(true),
  llmEndpoint: z.string().default(DEFAULT_LLM_ENDPOINT),
  llmModel: z.string().default(DEFAULT_LLM_MODEL),
  llmReasoning: z.string().default(DEFAULT_LLM_REASONING),
  llmTimeoutMs: z.number().int().positive().default(30_000),
  llmApiKeyEnvRef: z.string().default("TEXT_MODEL_API_KEY"),
  llmKeyHint: z.string().nullable().default(null),
  inputTokenBudget: z.number().int().positive().default(24_000),
  outputTokenBudget: z.number().int().positive().default(4_000),
  preserveRecentMessages: z.number().int().nonnegative().default(6),
  keepThreshold: z.number().min(0).max(1).default(0.5),
  truncateHeadChars: z.number().int().nonnegative().default(300)
});

export type CompactionStoredConfig = z.infer<typeof compactionStoredConfigSchema>;

export type CompactionSecretsLike = { jevApiKey?: string; llmApiKey?: string };

/** Parses the stored JSON defensively; a partial or corrupt row falls back to defaults. */
export function parseStoredConfig(json: unknown): CompactionStoredConfig {
  const parsed = compactionStoredConfigSchema.safeParse(json ?? {});
  return parsed.success ? parsed.data : compactionStoredConfigSchema.parse({});
}

/** Resolves the real keys: the local secret file wins, then the named environment variable. */
export function resolveApiKeys(
  stored: CompactionStoredConfig,
  secrets: CompactionSecretsLike,
  env: Record<string, string | undefined>
): { jevApiKey: string | null; llmApiKey: string | null } {
  const jevApiKey = secrets.jevApiKey ?? (stored.jevApiKeyEnvRef ? env[stored.jevApiKeyEnvRef] : undefined) ?? null;
  const llmApiKey = secrets.llmApiKey ?? (stored.llmApiKeyEnvRef ? env[stored.llmApiKeyEnvRef] : undefined) ?? null;
  return { jevApiKey: emptyToNull(jevApiKey), llmApiKey: emptyToNull(llmApiKey) };
}

/** The client-facing view: never a key, only whether one is configured and its masked hint. */
export function toConfigDto(
  stored: CompactionStoredConfig,
  keys: { jevApiKey: string | null; llmApiKey: string | null }
): CompactionApiConfigDto {
  return {
    apiCompactionEnabled: stored.apiCompactionEnabled,
    deterministicFallbackEnabled: stored.deterministicFallbackEnabled,
    jev: {
      enabled: stored.jevEnabled,
      endpoint: stored.jevEndpoint,
      model: stored.jevModel,
      timeoutMs: stored.jevTimeoutMs,
      keyConfigured: keys.jevApiKey !== null,
      keyHint: stored.jevKeyHint
    },
    llm: {
      enabled: stored.llmEnabled,
      endpoint: stored.llmEndpoint,
      model: stored.llmModel,
      reasoning: stored.llmReasoning,
      timeoutMs: stored.llmTimeoutMs,
      keyConfigured: keys.llmApiKey !== null,
      keyHint: stored.llmKeyHint
    },
    inputTokenBudget: stored.inputTokenBudget,
    outputTokenBudget: stored.outputTokenBudget,
    preserveRecentMessages: stored.preserveRecentMessages,
    keepThreshold: stored.keepThreshold,
    truncateHeadChars: stored.truncateHeadChars,
    configVersion: compactionConfigVersion
  };
}

/** The runtime view the coordinator consumes. */
export function toRuntimeConfig(
  stored: CompactionStoredConfig,
  keys: { jevApiKey: string | null; llmApiKey: string | null }
): CompactionRuntimeConfig {
  const options: CompactionOptions = {
    keepThreshold: stored.keepThreshold,
    preserveRecentMessages: stored.preserveRecentMessages,
    truncateHeadChars: stored.truncateHeadChars,
    inputTokenBudget: stored.inputTokenBudget,
    outputTokenBudget: stored.outputTokenBudget
  };
  return {
    apiCompactionEnabled: stored.apiCompactionEnabled,
    deterministicFallbackEnabled: stored.deterministicFallbackEnabled,
    jev: {
      enabled: stored.jevEnabled,
      endpoint: stored.jevEndpoint,
      model: stored.jevModel,
      timeoutMs: stored.jevTimeoutMs,
      apiKey: keys.jevApiKey
    },
    llm: {
      enabled: stored.llmEnabled,
      endpoint: stored.llmEndpoint,
      model: stored.llmModel,
      reasoning: stored.llmReasoning,
      timeoutMs: stored.llmTimeoutMs,
      apiKey: keys.llmApiKey
    },
    options
  };
}

function emptyToNull(value: string | undefined | null): string | null {
  return value && value.length > 0 ? value : null;
}
