import type { CompactionProviderMeta } from "../../../../contracts/src/semantic-compaction.js";
import type {
  CompactionOptions,
  CompactionResult,
  CompactionToolPair,
  DeterministicCompactionProvider,
  PairDecision
} from "../../ports/semantic-compaction.js";
import { buildProviderMeta } from "./meta.js";

/**
 * Rule-based compaction used when Jev is unavailable.
 *
 * It is deliberately conservative: it never DROPs, because losing a pair the user still needs is
 * worse than carrying some noise. It only truncates long *successful* results, and it always
 * keeps failures, unknown outcomes, pinned pairs and short results in full.
 */
export class DeterministicCompactionProviderImpl implements DeterministicCompactionProvider {
  readonly id = "deterministic" as const;

  constructor(private readonly clock: () => number) {}

  async compact(
    input: { pairs: readonly CompactionToolPair[]; options: CompactionOptions }
  ): Promise<CompactionResult> {
    const { options } = input;
    const decisions: PairDecision[] = [];
    const pairs: (CompactionToolPair & { action: "KEEP_FULL" | "KEEP_CALL_ONLY" | "DROP" })[] = [];
    let charsBefore = 0;
    let charsAfter = 0;

    for (const pair of input.pairs) {
      const long = pair.resultText.length > options.truncateHeadChars;
      let action: "KEEP_FULL" | "KEEP_CALL_ONLY";
      let reason: PairDecision["reason"];
      if (pair.pinned) {
        action = "KEEP_FULL";
        reason = "pinned";
      } else if (pair.isError) {
        action = "KEEP_FULL";
        reason = "protected_failure";
      } else if (long) {
        action = "KEEP_CALL_ONLY";
        reason = "result_dropped";
      } else {
        action = "KEEP_FULL";
        reason = "kept";
      }
      decisions.push({ callId: pair.callId, action, reason, keepCall: null, keepResult: null });
      pairs.push({ ...pair, action });
      charsBefore += pair.resultText.length;
      charsAfter += action === "KEEP_CALL_ONLY" ? Math.min(pair.resultText.length, options.truncateHeadChars) : pair.resultText.length;
    }

    const meta: CompactionProviderMeta = buildProviderMeta({ provider: this.id, now: this.clock() });
    return {
      decisions,
      pairs,
      stats: {
        pairs: input.pairs.length,
        keepFull: decisions.filter((d) => d.action === "KEEP_FULL").length,
        keepCallOnly: decisions.filter((d) => d.action === "KEEP_CALL_ONLY").length,
        drop: 0,
        charsBefore,
        charsAfter
      },
      meta
    };
  }
}
