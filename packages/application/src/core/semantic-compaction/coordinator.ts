import type { CompactionDegradationReason } from "../../../../contracts/src/semantic-compaction.js";
import type { AgentTranscriptEvent } from "../../ports/agent-adapter.js";
import type {
  CapsuleEvidence,
  CapsuleResult,
  CompactionOptions,
  CompactionResult
} from "../../ports/semantic-compaction.js";
import { decodeTranscriptEvents } from "../transcript-event-codec.js";
import { PrefixTranscriptSanitizer } from "../transcript-sanitizer.js";
import { DeterministicCapsuleGeneratorImpl } from "./deterministic-capsule-generator.js";
import { DeterministicCompactionProviderImpl } from "./deterministic-compaction-provider.js";
import { CompactionApiError } from "./errors.js";
import { JevCompactionProviderImpl, type JsonPost } from "./jev-compaction-provider.js";
import { LlmResumeCapsuleGeneratorImpl } from "./llm-resume-capsule-generator.js";
import { applyDecisions, buildToolPairs, renderTranscript, type TaggedEvent } from "./transcript-pairs.js";

/**
 * Chooses between the API path and the deterministic fallback, and never lets an API failure
 * block Continue.
 *
 * Order: Jev (per-pair KEEP_FULL / KEEP_CALL_ONLY / DROP) -> reconstructed transcript ->
 * LLM structured Chinese capsule. If the API path is off, unconfigured, or fails at any step,
 * the deterministic capsule is produced instead and the reason is recorded on the result.
 */

export type CompactionRuntimeConfig = {
  apiCompactionEnabled: boolean;
  deterministicFallbackEnabled: boolean;
  jev: { enabled: boolean; endpoint: string; model: string; timeoutMs: number; apiKey: string | null };
  llm: { enabled: boolean; endpoint: string; model: string; reasoning: string; timeoutMs: number; apiKey: string | null };
  options: CompactionOptions;
};

export type CompactionRuntime = {
  capsule: CapsuleResult;
  compaction: CompactionResult | null;
};

export class ApiCompactionCoordinator {
  constructor(
    private readonly clock: () => number,
    private readonly post?: JsonPost
  ) {}

  async build(
    input: { sessionId: string; goal: string | null; evidence: readonly CapsuleEvidence[]; config: CompactionRuntimeConfig },
    signal?: AbortSignal
  ): Promise<CompactionRuntime> {
    const deterministic = new DeterministicCapsuleGeneratorImpl(this.clock);
    const fallback = async (reason: CompactionDegradationReason): Promise<CompactionRuntime> => {
      const capsule = await deterministic.generate({ ...this.capsuleInput(input), compaction: null });
      return { capsule: { ...capsule, degradationReason: reason }, compaction: null };
    };

    const skipReason = this.skipReason(input.config);
    if (skipReason) return fallback(skipReason);

    const { jev, llm, options } = input.config;
    try {
      const tagged = this.tag(input.evidence);
      const pairs = buildToolPairs(tagged, options.preserveRecentMessages);

      const compaction = await new JevCompactionProviderImpl(
        { endpoint: jev.endpoint, model: jev.model, apiKey: jev.apiKey!, timeoutMs: jev.timeoutMs },
        this.clock,
        this.post
      ).compact({ pairs, options }, signal);

      const decisionByCallId = new Map(compaction.decisions.map((decision) => [decision.callId, decision.action]));
      const transcript = renderTranscript(applyDecisions(tagged, decisionByCallId, options.truncateHeadChars));

      const capsule = await new LlmResumeCapsuleGeneratorImpl(
        { endpoint: llm.endpoint, model: llm.model, apiKey: llm.apiKey!, timeoutMs: llm.timeoutMs, reasoning: llm.reasoning },
        this.clock,
        this.post
      ).generate({ ...this.capsuleInput(input), compaction, transcript }, signal);

      return { capsule, compaction };
    } catch (error) {
      const reason: CompactionDegradationReason = error instanceof CompactionApiError ? error.reason : "PROVIDER_ERROR";
      return fallback(reason);
    }
  }

  /** Returns a degradation reason when the API path cannot even start, else null. */
  private skipReason(config: CompactionRuntimeConfig): CompactionDegradationReason | null {
    if (!config.apiCompactionEnabled) return "DISABLED";
    if (!config.jev.enabled || !config.llm.enabled) return "DISABLED";
    if (!config.jev.apiKey || !config.llm.apiKey) return "NO_API_KEY";
    if (!config.jev.endpoint || !config.llm.endpoint || !config.llm.model) return "NOT_CONFIGURED";
    return null;
  }

  private capsuleInput(input: { sessionId: string; goal: string | null; evidence: readonly CapsuleEvidence[]; config: CompactionRuntimeConfig }) {
    return {
      sessionId: input.sessionId,
      goal: input.goal,
      evidence: input.evidence,
      compaction: null,
      transcript: "",
      options: input.config.options
    };
  }

  /** Decodes each Evidence snapshot and tags every event with the snapshot it came from. */
  private tag(evidence: readonly CapsuleEvidence[]): TaggedEvent[] {
    const sanitizer = new PrefixTranscriptSanitizer();
    const tagged: TaggedEvent[] = [];
    for (const snapshot of evidence) {
      const decoded = decodeTranscriptEvents(snapshot.canonicalText);
      for (const event of sanitizer.sanitize(decoded.events).events) {
        tagged.push({ event: event as AgentTranscriptEvent, evidenceId: snapshot.id });
      }
    }
    return tagged;
  }
}
