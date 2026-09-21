import { createHash } from "node:crypto";
import type {
  CandidateKind,
  ContextItemCandidatePayload,
  ExtractionCandidatePayload,
  ResumeCapsuleCandidatePayload
} from "../../../contracts/src/automation.js";
import type { ContextConfidence } from "../../../contracts/src/context.js";
import type { ExtractionContextItem, ExtractionResumeCapsule } from "../../../contracts/src/extraction.js";

/**
 * Explicit mapping from extractor output to candidate payloads.
 *
 * Every candidate is built by one of the two functions below rather than by spreading the model's
 * object: the payload is a strict discriminated union, so a stray field cannot be smuggled in and
 * a future extractor output change fails here instead of at persistence time.
 *
 * Only RESUME_CAPSULE and CONTEXT_ITEM are representable. Decision and Work Item payloads exist in
 * the union but no mapping produces them, which is what keeps Task 8 from generating governed
 * domain objects.
 */

/** Version prefix for candidate fingerprints, so an algorithm change cannot collide silently. */
export const candidateFingerprintVersion = "contextos-candidate-fingerprint.v1";

export type CandidateDraft = {
  kind: CandidateKind;
  payload: ExtractionCandidatePayload;
  confidence: number;
  /** Normalised, stable text the fingerprint is computed from. */
  fingerprintMaterial: string;
};

export function toResumeCapsuleCandidate(capsule: ExtractionResumeCapsule): CandidateDraft {
  const payload: ResumeCapsuleCandidatePayload = {
    kind: "RESUME_CAPSULE",
    summary: capsule.summary,
    nextAction: capsule.nextAction
  };

  return {
    kind: "RESUME_CAPSULE",
    payload,
    confidence: 1,
    fingerprintMaterial: normalizeMaterial([capsule.summary, capsule.nextAction])
  };
}

/**
 * Accepts the extractor's candidate shape. `fingerprintMaterial` is deliberately absent: the
 * extractor already used it to derive the fingerprint, and the material is recomputed here from
 * the same stable fields so a downstream stage never has to trust the model's value.
 */
export function toContextItemCandidate(item: Omit<ExtractionContextItem, "fingerprintMaterial">): CandidateDraft {
  const payload: ContextItemCandidatePayload = {
    kind: "CONTEXT_ITEM",
    itemType: item.itemType,
    title: item.title,
    summary: item.summary,
    body: item.body,
    confidence: toContextConfidence(item.confidence)
  };

  return {
    kind: "CONTEXT_ITEM",
    payload,
    confidence: item.confidence,
    fingerprintMaterial: normalizeMaterial([item.itemType, item.title, item.summary, item.body])
  };
}

/**
 * The candidate's stable identity.
 *
 * Only facts about the conclusion itself participate: the project boundary, the candidate type,
 * the normalised body and the Evidence it cites. Timestamps, job ids, artifact ids and other
 * run-state never enter, so a retry reproduces the same fingerprint instead of forking the
 * candidate. The version prefix keeps a future algorithm change from colliding with history.
 */
export function computeExtractionFingerprint(input: {
  projectId: string;
  kind: CandidateKind;
  material: string;
  evidenceIds: readonly string[];
}): string {
  const evidence = [...new Set(input.evidenceIds)].sort();
  const canonical = [
    candidateFingerprintVersion,
    input.projectId,
    input.kind,
    normalizeMaterial([input.material]),
    evidence.join("\n")
  ].join("\n");
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/**
 * Mechanical number-to-enum conversion required by the payload schema. The extractor reports a
 * continuous score; a Context Item stores a discrete band. The bands are fixed and deterministic,
 * and are not an automation policy.
 */
export function toContextConfidence(confidence: number): ContextConfidence {
  if (confidence >= 0.75) return "HIGH";
  if (confidence >= 0.4) return "MEDIUM";
  return "LOW";
}

function normalizeMaterial(parts: readonly (string | null | undefined)[]): string {
  return parts
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}
