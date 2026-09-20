import { describe, expect, test } from "vitest";
import {
  automationJobKindSchema,
  automationJobSchema,
  automationJobStatusSchema,
  automationModeSchema,
  automationRunDiscoveryInputSchema,
  automationSettingsDtoSchema,
  automationSettingsPatchSchema,
  automationStatusSchema,
  automationTerminalJobStatuses,
  candidateActiveStatuses,
  candidateKindSchema,
  candidateStatusSchema,
  contextItemCandidatePayloadSchema,
  decisionCandidatePayloadSchema,
  extractionCandidateAcceptSchema,
  extractionCandidateListQuerySchema,
  extractionCandidatePayloadSchema,
  extractionCandidateSchema,
  resumeCapsuleCandidatePayloadSchema,
  workItemCandidatePayloadSchema
} from "../../packages/contracts/src/automation.js";

const validCandidate = {
  id: "cand_1",
  projectId: "proj_1",
  sessionId: "sess_1",
  sourceEvidenceId: "ev_1",
  evidenceIds: ["ev_1"],
  kind: "CONTEXT_ITEM",
  fingerprint: "sha256:abc",
  payload: {
    kind: "CONTEXT_ITEM",
    itemType: "SUMMARY",
    title: "Sync pipeline",
    summary: "Daemon owns transcript polling",
    confidence: "HIGH"
  },
  confidence: 0.82,
  status: "PENDING",
  extractorId: "codex-cli",
  extractorVersion: "1.0.0",
  targetResourceType: null,
  targetResourceId: null,
  reviewedAt: null,
  supersededById: null,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  revision: 1
} as const;

describe("automation mode contract", () => {
  test("accepts the three documented modes", () => {
    expect(automationModeSchema.parse("SUGGEST_ONLY")).toBe("SUGGEST_ONLY");
    expect(automationModeSchema.parse("OFF")).toBe("OFF");
    expect(automationModeSchema.parse("AUTO_ACCEPT_HIGH_CONFIDENCE")).toBe("AUTO_ACCEPT_HIGH_CONFIDENCE");
  });

  test("rejects unknown modes", () => {
    expect(() => automationModeSchema.parse("AUTO")).toThrow();
    expect(() => automationModeSchema.parse("suggest_only")).toThrow();
  });
});

describe("automation settings contract", () => {
  test("rejects an out-of-range poll interval", () => {
    expect(() => automationSettingsPatchSchema.parse({ pollIntervalMs: 999 })).toThrow();
    expect(() => automationSettingsPatchSchema.parse({ pollIntervalMs: 999, expectedRevision: 1 })).toThrow();
    expect(() => automationSettingsPatchSchema.parse({ pollIntervalMs: 300_001, expectedRevision: 1 })).toThrow();
  });

  test("enforces the documented numeric bounds", () => {
    expect(() => automationSettingsPatchSchema.parse({ maxConcurrentJobs: 0, expectedRevision: 1 })).toThrow();
    expect(() => automationSettingsPatchSchema.parse({ maxConcurrentJobs: 5, expectedRevision: 1 })).toThrow();
    expect(() => automationSettingsPatchSchema.parse({ sourceMaxBytes: 1_023, expectedRevision: 1 })).toThrow();
    expect(() => automationSettingsPatchSchema.parse({ sourceMaxBytes: 1_000_001, expectedRevision: 1 })).toThrow();
    expect(() => automationSettingsPatchSchema.parse({ autoAcceptThreshold: 1.01, expectedRevision: 1 })).toThrow();
  });

  test("accepts a valid patch and requires expectedRevision", () => {
    const parsed = automationSettingsPatchSchema.parse({
      mode: "SUGGEST_ONLY",
      pollIntervalMs: 5_000,
      maxConcurrentJobs: 4,
      sourceMaxBytes: 1_024,
      autoAcceptThreshold: 0.95,
      expectedRevision: 3
    });
    expect(parsed).toMatchObject({ pollIntervalMs: 5_000, maxConcurrentJobs: 4, sourceMaxBytes: 1_024 });
    expect(() => automationSettingsPatchSchema.parse({ mode: "OFF" })).toThrow();
  });

  test("strips nothing: unknown keys are rejected", () => {
    expect(() => automationSettingsPatchSchema.parse({ apiKey: "secret", expectedRevision: 1 })).toThrow();
  });

  test("validates a settings DTO", () => {
    const parsed = automationSettingsDtoSchema.parse({
      id: "aset_proj_1",
      projectId: "proj_1",
      mode: "SUGGEST_ONLY",
      pollIntervalMs: 30_000,
      maxConcurrentJobs: 1,
      sourceMaxBytes: 262_144,
      autoAcceptThreshold: 0.9,
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
      revision: 1
    });
    expect(parsed.mode).toBe("SUGGEST_ONLY");
  });
});

describe("automation job contract", () => {
  test("exposes exactly the seven planned job kinds", () => {
    expect([...automationJobKindSchema.options].sort()).toEqual([
      "COMPACT_EVIDENCE",
      "DISCOVER_CODEX_THREADS",
      "DISCOVER_PROJECT_SOURCES",
      "EXTRACT_EVIDENCE_CONTEXT",
      "RECONCILE_EXTRACTION_CANDIDATES",
      "SYNC_CONTEXT_SOURCE",
      "SYNC_SESSION_TRANSCRIPT"
    ]);
  });

  test("distinguishes the documented lifecycle states", () => {
    expect([...automationJobStatusSchema.options]).toEqual(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"]);
    expect([...automationTerminalJobStatuses]).toEqual(["SUCCEEDED", "FAILED", "CANCELED"]);
  });

  test("never projects the stored payload onto a job DTO", () => {
    const parsed = automationJobSchema.parse({
      id: "job_1",
      kind: "SYNC_SESSION_TRANSCRIPT",
      projectId: "proj_1",
      sessionId: "sess_1",
      resourceType: "SESSION",
      resourceId: "sess_1",
      idempotencyKey: "SYNC_SESSION_TRANSCRIPT:sess_1:1",
      status: "QUEUED",
      availableAt: "2026-09-20T00:00:00.000Z",
      attempts: 0,
      maxAttempts: 4,
      failureCode: null,
      failureMessage: null,
      startedAt: null,
      endedAt: null,
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
      revision: 1,
      payload: { transcriptExcerpt: "must not surface" }
    });
    expect(parsed).not.toHaveProperty("payload");
  });
});

describe("extraction candidate contract", () => {
  test("distinguishes candidate kinds and statuses", () => {
    expect([...candidateKindSchema.options]).toEqual(["RESUME_CAPSULE", "CONTEXT_ITEM", "DECISION", "WORK_ITEM"]);
    expect([...candidateStatusSchema.options]).toEqual(["PENDING", "ACCEPTED", "REJECTED", "SUPERSEDED"]);
    expect([...candidateActiveStatuses]).toEqual(["PENDING", "ACCEPTED"]);
  });

  test("parses a valid candidate as PENDING", () => {
    expect(extractionCandidateSchema.parse(validCandidate).status).toBe("PENDING");
  });

  test("rejects a RULE candidate payload", () => {
    expect(() => extractionCandidatePayloadSchema.parse({ kind: "RULE" })).toThrow();
    expect(() => extractionCandidatePayloadSchema.parse({ kind: "RULE", title: "No rules yet" })).toThrow();
  });

  test("rejects a payload whose kind disagrees with the candidate kind", () => {
    expect(() =>
      extractionCandidateSchema.parse({
        ...validCandidate,
        kind: "DECISION",
        payload: { kind: "CONTEXT_ITEM", itemType: "FACT", title: "t", summary: "s" }
      })
    ).toThrow();
  });

  test("bounds confidence to 0..1", () => {
    expect(() => extractionCandidateSchema.parse({ ...validCandidate, confidence: 1.5 })).toThrow();
    expect(() => extractionCandidateSchema.parse({ ...validCandidate, confidence: -0.01 })).toThrow();
  });

  test("keeps provenance fields required", () => {
    expect(() => extractionCandidateSchema.parse({ ...validCandidate, fingerprint: "" })).toThrow();
    expect(() => extractionCandidateSchema.parse({ ...validCandidate, extractorVersion: "" })).toThrow();
    const { evidenceIds: _omitted, ...withoutEvidence } = validCandidate;
    expect(() => extractionCandidateSchema.parse(withoutEvidence)).toThrow();
  });

  test("resume capsule payload defaults nextAction to null", () => {
    const parsed = resumeCapsuleCandidatePayloadSchema.parse({ kind: "RESUME_CAPSULE", summary: "Where we are" });
    expect(parsed.nextAction).toBeNull();
  });

  test("context item payload only allows the six context item types", () => {
    expect(contextItemCandidatePayloadSchema.parse({ kind: "CONTEXT_ITEM", itemType: "RISK", title: "t", summary: "s" }).confidence).toBe("MEDIUM");
    expect(() => contextItemCandidatePayloadSchema.parse({ kind: "CONTEXT_ITEM", itemType: "RULE", title: "t", summary: "s" })).toThrow();
  });

  test("reserves decision and work item payloads without enabling rule generation", () => {
    expect(decisionCandidatePayloadSchema.parse({ kind: "DECISION", title: "t", statement: "s", rationale: "r" }).alternatives).toEqual([]);
    expect(workItemCandidatePayloadSchema.parse({ kind: "WORK_ITEM", title: "t" }).acceptance).toEqual([]);
    // A payload cannot smuggle a rule reference through an unexpected key either.
    expect(workItemCandidatePayloadSchema.parse({ kind: "WORK_ITEM", title: "t", ruleId: "r_1" })).not.toHaveProperty("ruleId");
  });

  test("candidate list query bounds the page size", () => {
    expect(extractionCandidateListQuerySchema.parse({}).limit).toBe(50);
    expect(() => extractionCandidateListQuerySchema.parse({ limit: 0 })).toThrow();
    expect(() => extractionCandidateListQuerySchema.parse({ limit: 201 })).toThrow();
    expect(extractionCandidateListQuerySchema.parse({ status: "PENDING" }).status).toBe("PENDING");
  });

  test("accept requires an expected revision and validates reviewer overrides", () => {
    expect(extractionCandidateAcceptSchema.parse({ expectedRevision: 2 }).expectedRevision).toBe(2);
    expect(() => extractionCandidateAcceptSchema.parse({})).toThrow();
    expect(() =>
      extractionCandidateAcceptSchema.parse({
        expectedRevision: 2,
        payload: { kind: "RESUME_CAPSULE", summary: "edited" }
      })
    ).not.toThrow();
  });
});

describe("automation status contract", () => {
  test("parses a status snapshot and keeps failures payload-free", () => {
    const parsed = automationStatusSchema.parse({
      generatedAt: "2026-09-20T00:00:00.000Z",
      scheduler: { running: true, startedAt: "2026-09-20T00:00:00.000Z", lastTickAt: "2026-09-20T00:00:05.000Z", activeJobs: 1 },
      jobs: {
        total: 3,
        byStatus: { QUEUED: 1, RUNNING: 1, SUCCEEDED: 1, FAILED: 0, CANCELED: 0 },
        byKind: { SYNC_SESSION_TRANSCRIPT: 2, EXTRACT_EVIDENCE_CONTEXT: 1 },
        latestFailures: [
          {
            id: "job_2",
            kind: "EXTRACT_EVIDENCE_CONTEXT",
            projectId: "proj_1",
            failureCode: "EXTRACTOR_TIMEOUT",
            failureMessage: "Codex CLI timed out",
            attempts: 2,
            endedAt: "2026-09-20T00:01:00.000Z"
          }
        ]
      },
      projects: [
        {
          projectId: "proj_1",
          mode: "SUGGEST_ONLY",
          lastDiscoveryAt: null,
          lastSyncAt: "2026-09-20T00:00:05.000Z",
          lastExtractionAt: null,
          pendingCandidates: 2
        }
      ],
      extractor: { id: "codex-cli", version: "1.0.0", available: true },
      candidates: { pending: 2 }
    });

    expect(parsed.jobs.latestFailures[0]).not.toHaveProperty("payload");
    expect(parsed.scheduler.activeJobs).toBe(1);
  });

  test("run-discovery accepts an optional project scope only", () => {
    expect(automationRunDiscoveryInputSchema.parse({})).toEqual({});
    expect(automationRunDiscoveryInputSchema.parse({ projectId: "proj_1" })).toEqual({ projectId: "proj_1" });
    expect(() => automationRunDiscoveryInputSchema.parse({ force: true })).toThrow();
  });
});
