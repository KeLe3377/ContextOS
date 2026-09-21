import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CompactionArtifactDto, CompactionEvent } from "../../packages/contracts/src/compaction.js";
import {
  reviewSourceTypeExtractionCandidate,
  reviewTriggerAutomationSuggestion
} from "../../packages/contracts/src/review-items.js";
import {
  computeExtractionFingerprint,
  toContextItemCandidate,
  toResumeCapsuleCandidate
} from "../../packages/application/src/core/extraction-candidate-mapping.js";
import {
  ExtractionService,
  acceptanceDeferralReason,
  decideDisposition
} from "../../packages/application/src/core/extraction-service.js";
import { ExtractionError, type ContextExtractor, type ExtractionCandidate, type ExtractionInput, type ExtractionResult } from "../../packages/application/src/ports/context-extractor.js";
import { AutomationJobRouter } from "../../packages/application/src/core/automation-job-router.js";
import { AutomationScheduler } from "../../packages/application/src/core/automation-scheduler.js";
import { EvidenceSnapshotService } from "../../packages/application/src/core/context-services.js";
import { SqliteAutomationRepository } from "../../packages/infrastructure/src/sqlite/automation-repository.js";
import { SqliteClient } from "../../packages/infrastructure/src/sqlite/client.js";
import { SqliteCompactionArtifactRepository } from "../../packages/infrastructure/src/sqlite/compaction-artifact-repository.js";
import { SqliteContextItemRepository, SqliteEvidenceSnapshotRepository } from "../../packages/infrastructure/src/sqlite/context-repositories.js";
import { SqliteReviewItemRepository, SqliteSessionRepository } from "../../packages/infrastructure/src/sqlite/core-repositories.js";
import { runMigrations } from "../../packages/infrastructure/src/sqlite/migrations.js";
import { CandidateApplicationService } from "../../packages/application/src/core/candidate-application-service.js";
import { ContextItemService } from "../../packages/application/src/core/context-services.js";
import { SessionService } from "../../packages/application/src/core/core-services.js";
import { ContinueSessionService } from "../../packages/application/src/core/runtime-services.js";
import { ProcessSupervisor } from "../../packages/infrastructure/src/process-supervisor.js";
import { AgentAdapterRegistry } from "../../packages/infrastructure/src/adapters/registry.js";
import { SqliteRuntimeRepository } from "../../packages/infrastructure/src/sqlite/runtime-repository.js";
import { SqliteProjectRepository } from "../../packages/infrastructure/src/sqlite/project-repository.js";

const now = 1_770_000_000_000;
const sourceEvidenceId = "ev_source";
const artifactId = "cmp_1";

let tempDir: string;
let client: SqliteClient;
let automation: SqliteAutomationRepository;
let artifacts: SqliteCompactionArtifactRepository;
let reviewItems: SqliteReviewItemRepository;
let sessions: SqliteSessionRepository;
let evidence: EvidenceSnapshotService;
let projectId: string;
let otherProjectId: string;
let sessionId: string;

class FakeExtractor implements ContextExtractor {
  readonly id = "fake-extractor";
  readonly version = "fake.v1";
  readonly inputs: ExtractionInput[] = [];
  result: ExtractionResult | null = null;
  error: Error | null = null;

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    this.inputs.push(input);
    if (this.error) throw this.error;
    if (!this.result) throw new Error("Fake extractor has no result configured");
    return this.result;
  }
}

let extractor: FakeExtractor;
let application: CandidateApplicationService;

function artifact(events: CompactionEvent[], overrides: Partial<CompactionArtifactDto> = {}): CompactionArtifactDto {
  return artifacts.findOrCreate(
    {
      projectId,
      sessionId,
      sourceEvidenceId,
      sourceContentHash: "sha256:source",
      providerId: "deterministic",
      providerVersion: "contextos-deterministic-compaction.v1",
      sanitizerVersion: "contextos-transcript-sanitizer.v1",
      optionsHash: "sha256:options",
      status: "SUCCEEDED",
      events,
      decisions: [],
      stats: {
        messagesBefore: events.length,
        messagesAfter: events.length,
        charsBefore: 0,
        charsAfter: 0,
        pairedCalls: 0,
        truncatedResults: 0,
        pinnedMessages: 0
      },
      failureCode: null,
      ...overrides
    },
    now
  ).artifact;
}

const events: CompactionEvent[] = [
  { ordinal: 1, kind: "message", role: "user", text: "wire the extractor" },
  { ordinal: 2, kind: "message", role: "assistant", text: "done" }
];

function extractionResult(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    extractorId: extractor.id,
    extractorVersion: extractor.version,
    resumeCapsule: { summary: "Wired the extractor.", nextAction: "Persist candidates." },
    candidates: [
      {
        itemType: "SUMMARY" as const,
        title: "Daemon owns polling",
        summary: "The daemon polls transcripts instead of the browser.",
        body: "Polling lives entirely in the daemon.",
        confidence: 0.8,
        evidenceIds: [sourceEvidenceId],
        explanation: "Stated in the transcript."
      }
    ].map((item) => ({ ...item, fingerprint: "sha256:model-lies" })),
    stats: { inputItems: 2, inputChars: 20, candidateCount: 1, durationMs: 5 },
    ...overrides
  };
}

function service(options: { reviewItems?: SqliteReviewItemRepository; automation?: SqliteAutomationRepository } = {}): ExtractionService {
  return new ExtractionService({
    automation: options.automation ?? automation,
    artifacts,
    evidence,
    sessions,
    reviewItems: options.reviewItems ?? reviewItems,
    extractor,
    application,
    clock: () => now
  });
}

function candidates() {
  return automation.listCandidates({ projectId, limit: 100 });
}

function openReviews() {
  return reviewItems
    .list({ projectId, limit: 100 })
    .filter(
      (item) =>
        item.sourceType === reviewSourceTypeExtractionCandidate &&
        (item.status === "OPEN" || item.status === "IN_PROGRESS")
    );
}

function setMode(mode: "OFF" | "SUGGEST_ONLY" | "AUTO_ACCEPT_HIGH_CONFIDENCE", autoAcceptThreshold = 0.9): void {
  const current = automation.getSettings(projectId, now);
  automation.patchSettings(projectId, { mode, autoAcceptThreshold, expectedRevision: current.revision }, now);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-extraction-"));
  client = SqliteClient.open({ databaseFile: join(tempDir, "contextos.sqlite") });
  runMigrations(client);
  automation = new SqliteAutomationRepository(client.db);
  artifacts = new SqliteCompactionArtifactRepository(client.db);
  reviewItems = new SqliteReviewItemRepository(client.db);
  sessions = new SqliteSessionRepository(client.db);
  // Only `get` is used here, so no Evidence Store is needed.
  evidence = new EvidenceSnapshotService(new SqliteEvidenceSnapshotRepository(client.db));

  const projects = new SqliteProjectRepository(client.db);
  projectId = projects.create({ name: "Extraction", rootPath: tempDir, defaultRuleIds: [], agentAdapterIds: ["codex"] }, now).id;
  otherProjectId = projects.create({ name: "Other", rootPath: join(tempDir, "other"), defaultRuleIds: [], agentAdapterIds: ["codex"] }, now).id;
  sessionId = sessions.create({ projectId, agentAdapterId: "codex", title: "Session", intent: "wire the extractor" }, now).id;

  client.db.prepare(
    "INSERT INTO evidence_snapshots (id, project_id, evidence_type, title, content_text, content_hash, metadata_json, captured_at, created_at) VALUES (?, ?, 'AGENT_OUTPUT', 'Batch', 'body', 'sha256:source', '{}', ?, ?)"
  ).run(sourceEvidenceId, projectId, now, now);

  application = new CandidateApplicationService({
    automation,
    sessions: new SessionService(
      sessions,
      new ContinueSessionService(new SqliteRuntimeRepository(client.db), new AgentAdapterRegistry([]), new ProcessSupervisor())
    ),
    contextItems: new ContextItemService(new SqliteContextItemRepository(client.db)),
    reviewItems,
    clock: () => now
  });
  extractor = new FakeExtractor();
});

afterEach(async () => {
  client.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("extraction persistence", () => {
  test("persists a capsule and a context item with a review item in one run", async () => {
    extractor.result = extractionResult();
    const artifactRow = artifact(events);

    const summary = await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    expect(summary).toMatchObject({
      artifactId: artifactRow.id,
      sourceEvidenceId,
      mode: "SUGGEST_ONLY",
      skipped: false,
      candidatesCreated: 2,
      autoAccepted: 0,
      reviewItemsCreated: 2
    });

    const stored = candidates();
    expect(stored).toHaveLength(2);
    expect(stored.map((candidate) => candidate.kind).sort()).toEqual(["CONTEXT_ITEM", "RESUME_CAPSULE"]);
    expect(stored.every((candidate) => candidate.status === "PENDING")).toBe(true);
    expect(stored.every((candidate) => candidate.evidenceIds.includes(sourceEvidenceId))).toBe(true);
    expect(stored.every((candidate) => candidate.provenance.sourceArtifactId === artifactRow.id)).toBe(true);
    expect(stored.every((candidate) => candidate.provenance.extractionInputHash?.startsWith("sha256:") ?? false)).toBe(true);

    const reviews = openReviews();
    expect(reviews).toHaveLength(2);
    expect(reviews.every((item) => item.triggerType === reviewTriggerAutomationSuggestion)).toBe(true);
    expect(reviews.some((item) => item.summary.includes("resume capsule"))).toBe(true);
    expect(reviews.some((item) => item.summary.includes("Daemon owns polling"))).toBe(true);
  });

  test("maps the resume capsule explicitly", async () => {
    extractor.result = extractionResult();
    const artifactRow = artifact(events);

    await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    const capsule = candidates().find((candidate) => candidate.kind === "RESUME_CAPSULE")!;
    expect(capsule.payload).toEqual({
      kind: "RESUME_CAPSULE",
      summary: "Wired the extractor.",
      nextAction: "Persist candidates."
    });
  });

  test("maps the context item explicitly, including the confidence band", async () => {
    extractor.result = extractionResult();
    const artifactRow = artifact(events);

    await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    const item = candidates().find((candidate) => candidate.kind === "CONTEXT_ITEM")!;
    expect(item.confidence).toBe(0.8);
    expect(item.payload).toEqual({
      kind: "CONTEXT_ITEM",
      itemType: "SUMMARY" as const,
      title: "Daemon owns polling",
      summary: "The daemon polls transcripts instead of the browser.",
      body: "Polling lives entirely in the daemon.",
      confidence: "HIGH"
    });
  });

  test("never produces a decision, work item or rule candidate", async () => {
    extractor.result = extractionResult({
      candidates: [
        { itemType: "FACT" as const, title: "f", summary: "s", body: "b", confidence: 0.9, evidenceIds: [sourceEvidenceId], explanation: "e" },
        { itemType: "RISK" as const, title: "r", summary: "s", body: "b", confidence: 0.4, evidenceIds: [sourceEvidenceId], explanation: "e" }
      ].map((entry) => ({ ...entry, fingerprint: "sha256:x" }))
    });
    const artifactRow = artifact(events);

    await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    const kinds = candidates().map((candidate) => candidate.kind);
    expect(kinds).not.toContain("DECISION");
    expect(kinds).not.toContain("WORK_ITEM");
    expect(kinds).not.toContain("RULE");
    expect(kinds.sort()).toEqual(["CONTEXT_ITEM", "CONTEXT_ITEM", "RESUME_CAPSULE"]);
  });

  test("computes the fingerprint locally and ignores the model's value", async () => {
    extractor.result = extractionResult();
    const artifactRow = artifact(events);

    await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    const item = candidates().find((candidate) => candidate.kind === "CONTEXT_ITEM")!;
    expect(item.fingerprint).not.toBe("sha256:model-lies");
    expect(item.fingerprint).toBe(
      computeExtractionFingerprint({
        projectId,
        kind: "CONTEXT_ITEM",
        material: "SUMMARY Daemon owns polling The daemon polls transcripts instead of the browser. Polling lives entirely in the daemon.",
        evidenceIds: [sourceEvidenceId]
      })
    );
  });

  test("is idempotent across repeated runs of the same job", async () => {
    extractor.result = extractionResult();
    const artifactRow = artifact(events);

    await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });
    const second = await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    expect(second).toMatchObject({ candidatesCreated: 0, candidatesReused: 2, reviewItemsCreated: 0 });
    expect(candidates()).toHaveLength(2);
    expect(openReviews()).toHaveLength(2);
  });

  test("repairs a missing evidence link on a later run", async () => {
    extractor.result = extractionResult();
    const artifactRow = artifact(events);
    await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    const candidate = candidates()[0]!;
    client.db.prepare("DELETE FROM extraction_candidate_evidence WHERE candidate_id = ?").run(candidate.id);
    expect(automation.getCandidate(candidate.id)!.evidenceIds).toEqual([]);

    await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    expect(automation.getCandidate(candidate.id)!.evidenceIds).toEqual([sourceEvidenceId]);
  });

  test("recreates a missing review item for a pending candidate", async () => {
    extractor.result = extractionResult();
    const artifactRow = artifact(events);
    await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    for (const item of openReviews()) {
      client.db.prepare("UPDATE review_items SET status = 'RESOLVED' WHERE id = ?").run(item.id);
    }
    expect(openReviews()).toHaveLength(0);

    const rerun = await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    expect(rerun.reviewItemsCreated).toBe(2);
    expect(candidates()).toHaveLength(2);
    expect(openReviews()).toHaveLength(2);
  });

  test("writes nothing when the extractor fails", async () => {
    extractor.error = new ExtractionError("EXTRACTOR_TIMEOUT", "run took too long");
    const artifactRow = artifact(events);

    await expect(service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId }))
      .rejects.toMatchObject({ code: "EXTRACTOR_TIMEOUT" });

    expect(candidates()).toHaveLength(0);
    expect(openReviews()).toHaveLength(0);
    expect(client.db.prepare("SELECT COUNT(*) AS count FROM extraction_candidate_evidence").get()).toEqual({ count: 0 });
  });

  test("rolls the whole unit back when a review item cannot be created", async () => {
    extractor.result = extractionResult();
    const artifactRow = artifact(events);

    let calls = 0;
    const failing = Object.create(reviewItems) as SqliteReviewItemRepository;
    failing.findOrCreateOpen = () => {
      calls += 1;
      if (calls === 2) throw new Error("review item write failed");
      return reviewItems.findOrCreateOpen.call(reviewItems, {
        projectId,
        sourceType: reviewSourceTypeExtractionCandidate,
        sourceId: "rev_probe",
        triggerType: reviewTriggerAutomationSuggestion,
        priority: "MEDIUM",
        summary: "probe"
      }, now);
    };

    await expect(service({ reviewItems: failing }).extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId }))
      .rejects.toThrow(/review item write failed/);

    // The first candidate was written inside the same transaction, so it is gone too.
    expect(calls).toBe(2);
    expect(candidates()).toHaveLength(0);
    expect(client.db.prepare("SELECT COUNT(*) AS count FROM extraction_candidate_evidence").get()).toEqual({ count: 0 });
    expect(reviewItems.list({ projectId, limit: 100 })).toHaveLength(0);
  });

  test("rolls back when a candidate insert fails midway", async () => {
    extractor.result = extractionResult();
    const artifactRow = artifact(events);

    // Break the evidence link write, which happens right after the candidate insert.
    client.db.prepare("DROP TABLE extraction_candidate_evidence").run();

    await expect(service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId })).rejects.toThrow();

    client.db.prepare(
      "CREATE TABLE extraction_candidate_evidence (candidate_id TEXT NOT NULL, evidence_id TEXT NOT NULL, link_reason TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (candidate_id, evidence_id))"
    ).run();
    expect(candidates()).toHaveLength(0);
    expect(reviewItems.list({ projectId, limit: 100 })).toHaveLength(0);
  });
});

describe("extraction identity and scope", () => {
  test("rejects an artifact that does not exist", async () => {
    extractor.result = extractionResult();

    await expect(service().extractArtifact({ projectId, artifactId: "cmp_missing", sourceEvidenceId }))
      .rejects.toMatchObject({ code: "COMPACTION_ARTIFACT_NOT_FOUND" });
    expect(extractor.inputs).toHaveLength(0);
    expect(candidates()).toHaveLength(0);
  });

  test("rejects an artifact that belongs to another project", async () => {
    extractor.result = extractionResult();
    const artifactRow = artifact(events, { projectId: otherProjectId, sessionId: null, optionsHash: "sha256:other" });

    await expect(service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId }))
      .rejects.toMatchObject({ code: "EXTRACTION_SOURCE_MISMATCH" });
    expect(extractor.inputs).toHaveLength(0);
    expect(candidates()).toHaveLength(0);
  });

  test("rejects an artifact whose source evidence does not match", async () => {
    extractor.result = extractionResult();
    const artifactRow = artifact(events);

    await expect(service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId: "ev_other" }))
      .rejects.toMatchObject({ code: "EXTRACTION_SOURCE_MISMATCH" });
    expect(candidates()).toHaveLength(0);
  });

  test("rejects a candidate that cites evidence outside the run", async () => {
    extractor.result = extractionResult({
      candidates: [
        { itemType: "FACT" as const, title: "f", summary: "s", body: "b", confidence: 0.9, evidenceIds: ["ev_outside"], explanation: "e" }
      ].map((entry) => ({ ...entry, fingerprint: "sha256:x" }))
    });
    const artifactRow = artifact(events);

    await expect(service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId }))
      .rejects.toMatchObject({ code: "EXTRACTION_EVIDENCE_OUT_OF_SCOPE" });
    expect(candidates()).toHaveLength(0);
    expect(openReviews()).toHaveLength(0);
  });

  test("rejects a job payload without an artifact reference", async () => {
    const job = automation.enqueue(
      { kind: "EXTRACT_EVIDENCE_CONTEXT", projectId, sessionId, resourceType: "COMPACTION_ARTIFACT", resourceId: "cmp_1", idempotencyKey: "k" },
      now
    ).job;

    await expect(service().handleExtractionJob(job)).rejects.toMatchObject({ code: "EXTRACTION_SOURCE_MISMATCH" });
  });

  test("passes the session intent and existing fingerprints into the bounded input", async () => {
    extractor.result = extractionResult();
    const artifactRow = artifact(events);
    await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    const second = extractor.inputs[0]!;
    expect(second.sessionIntent).toBe("wire the extractor");
    expect(second.projectIntent).toBeNull();
    expect(second.knownCandidateFingerprints).toEqual([]);

    const fingerprints = candidates().map((candidate) => candidate.fingerprint);
    await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });
    expect(extractor.inputs[1]!.knownCandidateFingerprints.sort()).toEqual([...fingerprints].sort());
  });
});

describe("automation policy", () => {
  test("writes nothing and succeeds when the project is OFF", async () => {
    setMode("OFF");
    extractor.result = extractionResult();
    const artifactRow = artifact(events);

    const summary = await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    expect(summary).toMatchObject({ mode: "OFF", skipped: true, candidatesCreated: 0, reviewItemsCreated: 0 });
    expect(extractor.inputs).toHaveLength(0);
    expect(candidates()).toHaveLength(0);
    expect(reviewItems.list({ projectId, limit: 100 })).toHaveLength(0);
  });

  test("never marks a candidate accepted without a target resource", async () => {
    setMode("AUTO_ACCEPT_HIGH_CONFIDENCE", 0.9);
    extractor.result = extractionResult();
    const artifactRow = artifact(events);

    await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    const stored = candidates();
    // Every acceptance carries the object it produced; anything unapplied stays PENDING and empty.
    for (const candidate of stored) {
      if (candidate.status === "ACCEPTED") {
        expect(candidate.targetResourceType).toBeTruthy();
        expect(candidate.targetResourceId).toBeTruthy();
      } else {
        expect(candidate.targetResourceType).toBeNull();
        expect(candidate.targetResourceId).toBeNull();
      }
    }
    // The applied capsule points at the Session; this context item sits below the threshold.
    expect(stored.find((candidate) => candidate.kind === "RESUME_CAPSULE"))
      .toMatchObject({ status: "ACCEPTED", targetResourceType: "SESSION", targetResourceId: sessionId });
    expect(stored.find((candidate) => candidate.kind === "CONTEXT_ITEM"))
      .toMatchObject({ status: "PENDING", targetResourceType: null, targetResourceId: null });

    const reviews = openReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.triggerType).toBe(reviewTriggerAutomationSuggestion);
  });

  test("does not duplicate a capsule or its review when an eligible run is retried", async () => {
    setMode("AUTO_ACCEPT_HIGH_CONFIDENCE", 0.9);
    extractor.result = extractionResult();
    const artifactRow = artifact(events);

    await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });
    const retry = await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    // The capsule was applied on the first pass, so the retry reuses it and creates nothing new.
    expect(retry).toMatchObject({ autoAcceptEligible: 1, autoAccepted: 0, candidatesCreated: 0, candidatesReused: 2, reviewItemsCreated: 0 });
    expect(candidates()).toHaveLength(2);
    expect(candidates().find((candidate) => candidate.kind === "RESUME_CAPSULE"))
      .toMatchObject({ status: "ACCEPTED", targetResourceType: "SESSION", targetResourceId: sessionId });
    // One review item is open: the context item the policy could not apply.
    expect(openReviews()).toHaveLength(1);
  });

  test("keeps non-whitelisted types in review however confident they are", async () => {
    setMode("AUTO_ACCEPT_HIGH_CONFIDENCE", 0.1);
    extractor.result = extractionResult({
      candidates: [
        { itemType: "CONSTRAINT" as const, title: "c", summary: "s", body: "b", confidence: 1, evidenceIds: [sourceEvidenceId], explanation: "e" }
      ].map((entry) => ({ ...entry, fingerprint: "sha256:x" }))
    });
    const artifactRow = artifact(events);

    const summary = await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    // Only the capsule is eligible and applied; the constraint goes to review at any confidence.
    expect(summary).toMatchObject({ autoAcceptEligible: 1, autoAccepted: 1, reviewItemsCreated: 1 });
    expect(candidates().find((candidate) => candidate.kind === "CONTEXT_ITEM")!.status).toBe("PENDING");
    expect(openReviews()).toHaveLength(1);
  });

  test("the pure policy function still grants eligibility independently of persistence", () => {
    const capsule = toResumeCapsuleCandidate({ summary: "s", nextAction: "n" });
    const handoff = toContextItemCandidate({
      itemType: "HANDOFF" as const, title: "t", summary: "s", body: "b", confidence: 0.99, evidenceIds: [sourceEvidenceId], explanation: "e"
    });
    const risk = toContextItemCandidate({
      itemType: "RISK" as const, title: "t", summary: "s", body: "b", confidence: 0.99, evidenceIds: [sourceEvidenceId], explanation: "e"
    });

    expect(decideDisposition({ mode: "AUTO_ACCEPT_HIGH_CONFIDENCE", draft: capsule, threshold: 0.9 }))
      .toEqual({ disposition: "AUTO_ACCEPT", reason: "WHITELISTED" });
    expect(decideDisposition({ mode: "AUTO_ACCEPT_HIGH_CONFIDENCE", draft: handoff, threshold: 0.9 }))
      .toEqual({ disposition: "AUTO_ACCEPT", reason: "WHITELISTED" });
    expect(decideDisposition({ mode: "AUTO_ACCEPT_HIGH_CONFIDENCE", draft: risk, threshold: 0.9 }))
      .toEqual({ disposition: "REVIEW", reason: "NOT_WHITELISTED" });
    // A capsule carries no model confidence (the mapping treats it as certain), so the threshold
    // gate is exercised through a whitelisted context item instead.
    const lukewarm = toContextItemCandidate({
      itemType: "HANDOFF" as const, title: "t", summary: "s", body: "b", confidence: 0.5, evidenceIds: [sourceEvidenceId], explanation: "e"
    });
    expect(decideDisposition({ mode: "AUTO_ACCEPT_HIGH_CONFIDENCE", draft: lukewarm, threshold: 0.9 }))
      .toEqual({ disposition: "REVIEW", reason: "BELOW_THRESHOLD" });
    expect(decideDisposition({ mode: "SUGGEST_ONLY", draft: capsule, threshold: 0.9 }))
      .toEqual({ disposition: "REVIEW", reason: "SUGGEST_ONLY" });
    expect(acceptanceDeferralReason).toBe("APPLICATION_PENDING");
  });

  test("keeps a whitelisted context item below the threshold in review", async () => {
    setMode("AUTO_ACCEPT_HIGH_CONFIDENCE", 0.95);
    extractor.result = extractionResult({
      candidates: [
        { itemType: "SUMMARY" as const, title: "s", summary: "s", body: "b", confidence: 0.5, evidenceIds: [sourceEvidenceId], explanation: "e" }
      ].map((entry) => ({ ...entry, fingerprint: "sha256:x" }))
    });
    const artifactRow = artifact(events);

    const summary = await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    // Below the threshold the whitelisted item is not eligible; only the capsule is applied.
    expect(summary).toMatchObject({ autoAcceptEligible: 1, autoAccepted: 1, reviewItemsCreated: 1 });
    expect(candidates().find((candidate) => candidate.kind === "CONTEXT_ITEM")!.status).toBe("PENDING");
    expect(openReviews()).toHaveLength(1);
  });
});

describe("scheduler integration", () => {
  async function runSchedulerOnce() {
    const scheduler = new AutomationScheduler({
      repository: automation,
      dispatcher: new AutomationJobRouter().register("EXTRACT_EVIDENCE_CONTEXT", (job) => service().handleExtractionJob(job)),
      clock: () => now,
      setTimer: () => () => {}
    });
    scheduler.start();
    await scheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
    await scheduler.stop();
  }

  test("claims the job, persists, and marks it SUCCEEDED only afterwards", async () => {
    extractor.result = extractionResult();
    const artifactRow = artifact(events);
    const job = automation.enqueue(
      {
        kind: "EXTRACT_EVIDENCE_CONTEXT",
        projectId,
        sessionId,
        resourceType: "COMPACTION_ARTIFACT",
        resourceId: artifactRow.id,
        payload: { artifactId: artifactRow.id, sourceEvidenceId },
        idempotencyKey: "extract:1"
      },
      now
    ).job;

    await runSchedulerOnce();

    expect(automation.getJob(job.id)).toMatchObject({ status: "SUCCEEDED", attempts: 1 });
    expect(candidates()).toHaveLength(2);
    expect(openReviews()).toHaveLength(2);
  });

  test("does not mark the job successful when the handler fails", async () => {
    extractor.error = new ExtractionError("EXTRACTOR_TIMEOUT", "run took too long");
    const artifactRow = artifact(events);
    const job = automation.enqueue(
      {
        kind: "EXTRACT_EVIDENCE_CONTEXT",
        projectId,
        sessionId,
        resourceType: "COMPACTION_ARTIFACT",
        resourceId: artifactRow.id,
        payload: { artifactId: artifactRow.id, sourceEvidenceId },
        idempotencyKey: "extract:2"
      },
      now
    ).job;

    await runSchedulerOnce();

    const after = automation.getJob(job.id)!;
    expect(after.status).not.toBe("SUCCEEDED");
    expect(after.failureCode).toBe("EXTRACTOR_TIMEOUT");
    expect(candidates()).toHaveLength(0);
    expect(openReviews()).toHaveLength(0);
  });

  test("converges after a restart without duplicating candidates or review items", async () => {
    extractor.result = extractionResult();
    const artifactRow = artifact(events);

    await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });
    // A restart rebuilds every service over the same database.
    await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });
    await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    expect(candidates()).toHaveLength(2);
    expect(openReviews()).toHaveLength(2);
    expect(client.db.prepare("SELECT COUNT(*) AS count FROM extraction_candidate_evidence").get()).toEqual({ count: 2 });
  });

  test("recovers when the activity update fails after the transaction committed", async () => {
    extractor.result = extractionResult();
    const artifactRow = artifact(events);

    // Activity is recorded after the business transaction, so a failure there leaves the
    // candidates committed and the job retryable.
    let activityCalls = 0;
    const flaky = Object.create(automation) as SqliteAutomationRepository;
    flaky.markProjectActivity = () => {
      activityCalls += 1;
      if (activityCalls === 1) throw new Error("activity write failed");
    };

    await expect(service({ automation: flaky }).extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId }))
      .rejects.toThrow(/activity write failed/);

    expect(activityCalls).toBe(1);
    expect(candidates()).toHaveLength(2);
    expect(openReviews()).toHaveLength(2);
    expect(client.db.prepare("SELECT COUNT(*) AS count FROM extraction_candidate_evidence").get()).toEqual({ count: 2 });

    // The retry converges on the committed state instead of duplicating it.
    const retry = await service({ automation: flaky }).extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    expect(retry).toMatchObject({ candidatesCreated: 0, candidatesReused: 2, reviewItemsCreated: 0 });
    expect(activityCalls).toBe(2);
    expect(candidates()).toHaveLength(2);
    expect(openReviews()).toHaveLength(2);
    expect(client.db.prepare("SELECT COUNT(*) AS count FROM extraction_candidate_evidence").get()).toEqual({ count: 2 });
  });

  test("auto applies an eligible resume capsule through the application service", async () => {
    setMode("AUTO_ACCEPT_HIGH_CONFIDENCE", 0.9);
    extractor.result = extractionResult();
    const artifactRow = artifact(events);

    const summary = await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    expect(summary).toMatchObject({ autoAcceptEligible: 1, autoAccepted: 1, reviewItemsCreated: 1 });

    const stored = candidates();
    expect(stored.find((candidate) => candidate.kind === "RESUME_CAPSULE")).toMatchObject({
      status: "ACCEPTED",
      targetResourceType: "SESSION",
      targetResourceId: sessionId
    });
    // The SUMMARY item scores below the threshold, so it stays in review.
    expect(stored.find((candidate) => candidate.kind === "CONTEXT_ITEM")).toMatchObject({ status: "PENDING", targetResourceId: null });
    expect(openReviews()).toHaveLength(1);
  });

  function resultWith(itemType: ExtractionCandidate["itemType"], confidence: number): ExtractionResult {
    const candidate: ExtractionCandidate = {
      itemType,
      title: `Candidate ${itemType}`,
      summary: "A summary of the conclusion.",
      body: "The body of the conclusion.",
      confidence,
      evidenceIds: [sourceEvidenceId],
      explanation: "Stated in the transcript.",
      fingerprint: "sha256:model-lies"
    };
    return extractionResult({ candidates: [candidate] });
  }

  test("auto accepts a high confidence SUMMARY context item", async () => {
    setMode("AUTO_ACCEPT_HIGH_CONFIDENCE", 0.9);
    extractor.result = resultWith("SUMMARY", 0.95);
    const artifactRow = artifact(events);

    const summary = await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    expect(summary).toMatchObject({ autoAcceptEligible: 2, autoAccepted: 2 });
    const item = candidates().find((candidate) => candidate.kind === "CONTEXT_ITEM")!;
    expect(item).toMatchObject({ status: "ACCEPTED", targetResourceType: "CONTEXT_ITEM" });
    expect(item.targetResourceId).toBeTruthy();
    expect(openReviews()).toHaveLength(0);
  });

  test("auto accepts a high confidence HANDOFF context item", async () => {
    setMode("AUTO_ACCEPT_HIGH_CONFIDENCE", 0.9);
    extractor.result = resultWith("HANDOFF", 0.99);
    const artifactRow = artifact(events);

    await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

    expect(candidates().find((candidate) => candidate.kind === "CONTEXT_ITEM"))
      .toMatchObject({ status: "ACCEPTED", targetResourceType: "CONTEXT_ITEM" });
    expect(openReviews()).toHaveLength(0);
  });

  test("keeps every non-whitelisted type in review however confident it is", async () => {
    setMode("AUTO_ACCEPT_HIGH_CONFIDENCE", 0.1);
    for (const itemType of ["FACT", "RISK", "CONSTRAINT", "OPEN_QUESTION"] as const) {
      extractor.result = resultWith(itemType, 1);
      const artifactRow = artifact(events, { optionsHash: `sha256:options-${itemType}` });

      await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

      const item = candidates().find(
        (candidate) => candidate.kind === "CONTEXT_ITEM" && candidate.payload.kind === "CONTEXT_ITEM" && candidate.payload.itemType === itemType
      )!;
      expect(item.status).toBe("PENDING");
      expect(item.targetResourceId).toBeNull();
      expect(openReviews().some((review) => review.sourceId === item.id)).toBe(true);
    }
  });

  test("keeps a whitelisted item below the threshold in review", async () => {
    setMode("AUTO_ACCEPT_HIGH_CONFIDENCE", 0.95);
    for (const itemType of ["SUMMARY", "HANDOFF"] as const) {
      extractor.result = resultWith(itemType, 0.5);
      const artifactRow = artifact(events, { optionsHash: `sha256:below-${itemType}` });

      await service().extractArtifact({ projectId, artifactId: artifactRow.id, sourceEvidenceId });

      const item = candidates().find(
        (candidate) => candidate.kind === "CONTEXT_ITEM" && candidate.payload.kind === "CONTEXT_ITEM" && candidate.payload.itemType === itemType
      )!;
      expect(item.status).toBe("PENDING");
      expect(item.targetResourceId).toBeNull();
    }
  });
});
