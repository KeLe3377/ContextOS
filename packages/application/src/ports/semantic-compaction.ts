import type {
  CapsuleSource,
  CompactionDegradationReason,
  CompactionProviderMeta,
  StructuredResumeCapsule
} from "../../../contracts/src/semantic-compaction.js";

/**
 * The four replaceable interfaces behind API-version semantic compaction.
 *
 * Stage 1 turns immutable Evidence into a set of per-pair decisions
 * (KEEP_FULL / KEEP_CALL_ONLY / DROP). Stage 2 turns the reconstructed transcript into a
 * structured Chinese Resume Capsule. Each stage has an API implementation and a deterministic
 * one; the coordinator picks and degrades between them.
 */

export type CompactionAction = "KEEP_FULL" | "KEEP_CALL_ONLY" | "DROP";

export type CompactionReason =
  | "pinned"
  | "protected_failure"
  | "kept"
  | "result_dropped"
  | "call_dropped";

/** One tool call paired with its result by `callId`. */
export type CompactionToolPair = {
  callId: string;
  tool: string;
  inputSummary: string;
  resultText: string;
  isError: boolean;
  /** In the first or the newest preserved messages: never a candidate for DROP. */
  pinned: boolean;
  callOrdinal: number;
  resultOrdinal: number;
  /** Evidence snapshot that carries this pair; used to cite facts later. */
  evidenceId: string;
};

export type CompactionOptions = {
  /** Minimum probability for a call/result to stay. */
  keepThreshold: number;
  /** Newest messages never touched. */
  preserveRecentMessages: number;
  /** Characters of a truncated result to retain. */
  truncateHeadChars: number;
  /** Input token ceiling for one API request. */
  inputTokenBudget: number;
  /** Output token ceiling for the generated capsule. */
  outputTokenBudget: number;
};

export type PairDecision = {
  callId: string;
  action: CompactionAction;
  reason: CompactionReason;
  keepCall: number | null;
  keepResult: number | null;
};

export type CompactionStats = {
  pairs: number;
  keepFull: number;
  keepCallOnly: number;
  drop: number;
  charsBefore: number;
  charsAfter: number;
};

export type CompactionResult = {
  decisions: PairDecision[];
  /** Pairs in original order, with the applied action. Evidence is never modified. */
  pairs: (CompactionToolPair & { action: CompactionAction })[];
  stats: CompactionStats;
  meta: CompactionProviderMeta;
};

export interface CompactionProvider {
  readonly id: string;
  compact(
    input: { pairs: readonly CompactionToolPair[]; options: CompactionOptions },
    signal?: AbortSignal
  ): Promise<CompactionResult>;
}

/** Jev-backed provider: asks the live model per pair. */
export interface JevCompactionProvider extends CompactionProvider {
  readonly id: "jev";
}

/** Rule-based provider: protects, truncates and drops without a network call. */
export interface DeterministicCompactionProvider extends CompactionProvider {
  readonly id: "deterministic";
}

export type CapsuleEvidence = {
  id: string;
  /** Canonical, integrity-verified transcript blob, exactly as the codec wrote it. */
  canonicalText: string;
};

export type CapsuleInput = {
  sessionId: string;
  goal: string | null;
  evidence: readonly CapsuleEvidence[];
  /** Stage 1 output; null when compaction was skipped (the deterministic path reads Evidence). */
  compaction: CompactionResult | null;
  /**
   * Reconstructed transcript after applying the stage-1 decisions, each line tagged with its
   * Evidence id. The LLM generator reads this; the deterministic generator ignores it and reads
   * Evidence directly, so the fallback stays identical to the pre-API capsule.
   */
  transcript: string;
  options: CompactionOptions;
};

export type CapsuleResult = {
  source: CapsuleSource;
  /** Present only for `source === "api"`. */
  structured: StructuredResumeCapsule | null;
  summary: string;
  nextAction: string | null;
  /** The text Continue carries back; always populated, whichever source produced it. */
  contextText: string;
  evidenceSnapshotIds: string[];
  meta: CompactionProviderMeta;
  degradationReason: CompactionDegradationReason | null;
};

export interface CapsuleGenerator {
  readonly id: string;
  generate(input: CapsuleInput, signal?: AbortSignal): Promise<CapsuleResult>;
}

/** LLM-backed generator: produces the structured Chinese capsule. */
export interface ResumeCapsuleGenerator extends CapsuleGenerator {
  readonly id: "llm";
}

/** Deterministic generator: wraps `buildSessionContinuity`; always succeeds. */
export interface DeterministicCapsuleGenerator extends CapsuleGenerator {
  readonly id: "deterministic";
}
