import { createHash } from "node:crypto";
import type { ExtractionContextItem, ExtractionOutput, ExtractionResumeCapsule } from "../../../contracts/src/extraction.js";

/**
 * The port a structured context extractor implements.
 *
 * Extraction runs against a Compaction Artifact — never against raw Evidence and never against
 * `metadata.events` — and it only ever produces candidates. Persisting them, and turning them
 * into review items, is a later stage's job.
 *
 * Design: docs/2026-09-20-contextos-jev-compaction-integration-design.md §12
 */

/** Where a run's input came from, so a candidate can always be traced back. */
export type ExtractionIdentity = {
  projectId: string;
  sessionId: string | null;
  artifactId: string;
  sourceEvidenceId: string;
  sourceContentHash: string;
  compactionProviderId: string;
  compactionProviderVersion: string;
  sanitizerVersion: string;
};

export type ExtractionTranscriptItem = {
  ordinal: number;
  kind: "message" | "summary" | "tool";
  role: "user" | "assistant" | null;
  /** Tool name for tool items, so the extractor can tell a command from a file read. */
  name: string | null;
  text: string;
  /** True when the text was shortened to fit the input budget. */
  truncated: boolean;
};

/** Hard bounds on what may be handed to an extractor. */
export type ExtractionInputLimits = {
  maxChars: number;
  maxItems: number;
  maxItemChars: number;
};

export type ExtractionInput = {
  identity: ExtractionIdentity;
  projectIntent: string | null;
  sessionIntent: string | null;
  /** Selected, bounded and chronologically ordered transcript items. */
  transcript: ExtractionTranscriptItem[];
  /** Fingerprints already known for this Project, so the model can avoid repeating itself. */
  knownCandidateFingerprints: string[];
  limits: ExtractionInputLimits;
};

export type ExtractionCandidate = Omit<ExtractionContextItem, "fingerprintMaterial"> & {
  /**
   * Derived by ContextOS from the normalised `fingerprintMaterial`. A model never supplies it,
   * so a candidate's identity can never be decided by the model.
   */
  fingerprint: string;
};

export type ExtractionResult = {
  extractorId: string;
  extractorVersion: string;
  resumeCapsule: ExtractionResumeCapsule;
  candidates: ExtractionCandidate[];
  stats: {
    inputItems: number;
    inputChars: number;
    candidateCount: number;
    durationMs: number;
  };
};

export interface ContextExtractor {
  readonly id: string;
  readonly version: string;
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

/** Stable failure codes an extractor raises; the scheduler records them on the job. */
export type ExtractionFailureCode =
  | "EXTRACTOR_UNAVAILABLE"
  | "EXTRACTOR_TIMEOUT"
  | "EXTRACTOR_EXIT_NONZERO"
  | "EXTRACTOR_STDOUT_LIMIT"
  | "EXTRACTOR_OUTPUT_NOT_JSON"
  | "EXTRACTOR_OUTPUT_SCHEMA_INVALID"
  | "EXTRACTOR_EVIDENCE_IDS_INVALID"
  | "EXTRACTOR_RUN_FAILED";

/**
 * Carries only a stable code and a short, content-free message: the raw model output, the prompt
 * and the transcript must never travel through an error into a log.
 */
export class ExtractionError extends Error {
  readonly code: ExtractionFailureCode;

  constructor(code: ExtractionFailureCode, message: string) {
    super(message);
    this.name = "ExtractionError";
    this.code = code;
  }
}

/** Normalised, deterministic candidate identity. Whitespace-only differences do not fork it. */
export function computeCandidateFingerprint(fingerprintMaterial: string): string {
  const normalized = fingerprintMaterial.replace(/\s+/g, " ").trim();
  return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

/** Re-exported so implementations can talk about the contract without a second import. */
export type { ExtractionOutput };
