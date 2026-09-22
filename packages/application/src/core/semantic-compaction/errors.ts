import type { CompactionDegradationReason } from "../../../../contracts/src/semantic-compaction.js";

/** A classified API failure. The reason drives the deterministic fallback and the UI status. */
export class CompactionApiError extends Error {
  constructor(readonly reason: CompactionDegradationReason, message: string) {
    super(message);
    this.name = "CompactionApiError";
  }
}
