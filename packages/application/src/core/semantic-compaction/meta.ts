import { compactionConfigVersion, compactionPromptSchemaVersion, type CompactionProviderMeta } from "../../../../contracts/src/semantic-compaction.js";

/** Builds the derived-product metadata recorded alongside every capsule. Never the body. */
export function buildProviderMeta(input: {
  provider: string;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
  now: number;
}): CompactionProviderMeta {
  return {
    provider: input.provider,
    model: input.model ?? null,
    configVersion: compactionConfigVersion,
    promptSchemaVersion: compactionPromptSchemaVersion,
    createdAt: new Date(input.now).toISOString(),
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    latencyMs: input.latencyMs ?? null
  };
}
