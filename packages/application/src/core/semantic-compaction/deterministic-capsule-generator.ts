import { buildSessionContinuity } from "../session-continuity.js";
import type { CapsuleInput, CapsuleResult, DeterministicCapsuleGenerator } from "../../ports/semantic-compaction.js";
import { buildProviderMeta } from "./meta.js";

/**
 * The deterministic capsule, wrapped as a replaceable generator.
 *
 * It is a thin wrapper over the existing `buildSessionContinuity`, so the fallback is
 * byte-for-byte the same capsule the product produced before API compaction existed. It never
 * fails: no network, no key, no clock-dependent branching.
 */
export class DeterministicCapsuleGeneratorImpl implements DeterministicCapsuleGenerator {
  readonly id = "deterministic" as const;

  constructor(private readonly clock: () => number) {}

  async generate(input: CapsuleInput): Promise<CapsuleResult> {
    const continuity = buildSessionContinuity({
      evidence: input.evidence.map((snapshot) => ({ id: snapshot.id, canonicalText: snapshot.canonicalText }))
    });
    return {
      source: "deterministic",
      structured: null,
      summary: continuity.summary,
      nextAction: continuity.nextAction,
      contextText: continuity.contextText,
      evidenceSnapshotIds: continuity.evidenceSnapshotIds,
      meta: buildProviderMeta({ provider: this.id, now: this.clock() }),
      degradationReason: null
    };
  }
}
