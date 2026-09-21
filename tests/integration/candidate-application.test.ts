import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CandidateApplicationService } from "../../packages/application/src/core/candidate-application-service.js";
import { ContextItemService } from "../../packages/application/src/core/context-services.js";
import { SessionService } from "../../packages/application/src/core/core-services.js";
import { ContinueSessionService } from "../../packages/application/src/core/runtime-services.js";
import { ProcessSupervisor } from "../../packages/infrastructure/src/process-supervisor.js";
import { AgentAdapterRegistry } from "../../packages/infrastructure/src/adapters/registry.js";
import { SqliteAutomationRepository } from "../../packages/infrastructure/src/sqlite/automation-repository.js";
import { SqliteClient } from "../../packages/infrastructure/src/sqlite/client.js";
import { SqliteReviewItemRepository, SqliteSessionRepository } from "../../packages/infrastructure/src/sqlite/core-repositories.js";
import { SqliteContextItemRepository } from "../../packages/infrastructure/src/sqlite/context-repositories.js";
import { runMigrations } from "../../packages/infrastructure/src/sqlite/migrations.js";
import { SqliteProjectRepository } from "../../packages/infrastructure/src/sqlite/project-repository.js";
import { SqliteRuntimeRepository } from "../../packages/infrastructure/src/sqlite/runtime-repository.js";
import { reviewSourceTypeExtractionCandidate, reviewTriggerAutomationSuggestion } from "../../packages/contracts/src/review-items.js";

const now = 1_770_000_000_000;
const sourceEvidenceId = "ev_source";

let tempDir: string;
let client: SqliteClient;
let automation: SqliteAutomationRepository;
let reviewItems: SqliteReviewItemRepository;
let sessions: SessionService;
let contextItems: ContextItemService;
let application: CandidateApplicationService;
let seedCounter = 0;
let projectId: string;
let sessionId: string;
let runtime: SqliteRuntimeRepository;

function seedCandidate(kind: "RESUME_CAPSULE" | "CONTEXT_ITEM", options: { sessionId?: string | null } = {}) {
  const payload = kind === "RESUME_CAPSULE"
    ? { kind: "RESUME_CAPSULE" as const, summary: "Wired the extractor.", nextAction: "Persist candidates." }
    : {
        kind: "CONTEXT_ITEM" as const,
        itemType: "SUMMARY" as const,
        title: "Daemon owns polling",
        summary: "The daemon polls transcripts.",
        body: "Polling lives in the daemon.",
        confidence: "HIGH" as const
      };

  seedCounter += 1;
  return automation.upsertCandidate(
    {
      projectId,
      sessionId: options.sessionId === undefined ? sessionId : options.sessionId,
      sourceEvidenceId,
      evidenceIds: [sourceEvidenceId],
      kind,
      fingerprint: `sha256:${kind}-${seedCounter}`,
      payload,
      confidence: 0.9,
      extractorId: "fake-extractor",
      extractorVersion: "fake.v1",
      provenance: { sourceArtifactId: "cmp_1", sourceEvidenceId, extractorId: "fake-extractor" }
    },
    now
  ).candidate;
}

function openReviewFor(candidateId: string) {
  return reviewItems.findOrCreateOpen(
    {
      projectId,
      sourceType: reviewSourceTypeExtractionCandidate,
      sourceId: candidateId,
      triggerType: reviewTriggerAutomationSuggestion,
      priority: "MEDIUM",
      summary: "Extracted candidate"
    },
    now
  );
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-apply-"));
  client = SqliteClient.open({ databaseFile: join(tempDir, "contextos.sqlite") });
  runMigrations(client);
  automation = new SqliteAutomationRepository(client.db);
  reviewItems = new SqliteReviewItemRepository(client.db);
  contextItems = new ContextItemService(new SqliteContextItemRepository(client.db));
  runtime = new SqliteRuntimeRepository(client.db);
  const continueSession = new ContinueSessionService(runtime, new AgentAdapterRegistry([]), new ProcessSupervisor());
  sessions = new SessionService(new SqliteSessionRepository(client.db), continueSession);

  projectId = new SqliteProjectRepository(client.db)
    .create({ name: "Apply", rootPath: tempDir, defaultRuleIds: [], agentAdapterIds: ["codex"] }, now).id;
  sessionId = new SqliteSessionRepository(client.db)
    .create({ projectId, agentAdapterId: "codex", title: "Session", intent: "wire it" }, now).id;
  client.db.prepare(
    "INSERT INTO evidence_snapshots (id, project_id, evidence_type, title, content_text, content_hash, metadata_json, captured_at, created_at) VALUES (?, ?, 'AGENT_OUTPUT', 'Batch', 'body', 'sha256:source', '{}', ?, ?)"
  ).run(sourceEvidenceId, projectId, now, now);

  application = new CandidateApplicationService({
    automation,
    sessions,
    contextItems,
    reviewItems,
    clock: () => now
  });
});

afterEach(async () => {
  client.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("candidate application", () => {
  test("applies a resume capsule through the session capsule patch path", () => {
    const candidate = seedCandidate("RESUME_CAPSULE");

    const result = application.apply({ candidateId: candidate.id, expectedRevision: candidate.revision });

    expect(result.outcome).toBe("APPLIED");
    expect(result.target).toEqual({ resourceType: "SESSION", resourceId: sessionId });
    expect(result.candidate).toMatchObject({ status: "ACCEPTED", targetResourceType: "SESSION", targetResourceId: sessionId });
    expect(sessions.getResumeCapsule(sessionId)).toMatchObject({
      summary: "Wired the extractor.",
      nextAction: "Persist candidates."
    });
  });

  test("creates and activates a context item for a context item candidate", () => {
    const candidate = seedCandidate("CONTEXT_ITEM");

    const result = application.apply({ candidateId: candidate.id, expectedRevision: candidate.revision });

    expect(result.outcome).toBe("APPLIED");
    expect(result.target!.resourceType).toBe("CONTEXT_ITEM");
    expect(result.candidate).toMatchObject({
      status: "ACCEPTED",
      targetResourceType: "CONTEXT_ITEM",
      targetResourceId: result.target!.resourceId
    });

    const item = contextItems.get(result.target!.resourceId);
    expect(item).toMatchObject({
      projectId,
      itemType: "SUMMARY",
      title: "Daemon owns polling",
      confidence: "HIGH",
      status: "ACTIVE",
      sourceSnapshotId: sourceEvidenceId
    });
    expect(item.metadata).toMatchObject({ candidateId: candidate.id });
  });

  test("keeps a sessionless resume capsule PENDING with a stable failure code", () => {
    const candidate = seedCandidate("RESUME_CAPSULE", { sessionId: null });

    expect(() => application.apply({ candidateId: candidate.id, expectedRevision: candidate.revision }))
      .toThrowError(expect.objectContaining({ code: "CANDIDATE_TARGET_SESSION_MISSING" }));

    // The target session is never guessed, so nothing was written.
    expect(automation.getCandidate(candidate.id)).toMatchObject({ status: "PENDING", targetResourceId: null });
    expect(sessions.getResumeCapsule(sessionId).summary).not.toBe("Wired the extractor.");
  });

  test("leaves the candidate PENDING on a revision conflict", () => {
    const candidate = seedCandidate("CONTEXT_ITEM");
    // Bump the revision behind the caller's back, as a concurrent review would.
    automation.upsertCandidate(
      {
        projectId,
        sessionId,
        sourceEvidenceId,
        evidenceIds: [sourceEvidenceId],
        kind: "CONTEXT_ITEM",
        fingerprint: candidate.fingerprint,
        payload: candidate.payload,
        confidence: 0.95,
        extractorId: "fake-extractor",
        extractorVersion: "fake.v1"
      },
      now
    );

    expect(() => application.apply({ candidateId: candidate.id, expectedRevision: candidate.revision }))
      .toThrowError(expect.objectContaining({ code: "CANDIDATE_REVISION_CONFLICT" }));

    expect(automation.getCandidate(candidate.id)).toMatchObject({ status: "PENDING" });
    expect(contextItems.list({ projectId, limit: 50 })).toHaveLength(0);
  });

  test("does not materialise a second object when applied twice", () => {
    const candidate = seedCandidate("CONTEXT_ITEM");

    const first = application.apply({ candidateId: candidate.id, expectedRevision: candidate.revision });
    const second = application.apply({ candidateId: candidate.id, expectedRevision: first.candidate.revision });

    expect(second).toMatchObject({ outcome: "ALREADY_APPLIED" });
    expect(second.target).toEqual(first.target);
    expect(contextItems.list({ projectId, limit: 50 })).toHaveLength(1);
    expect(automation.getCandidate(candidate.id)).toMatchObject({ status: "ACCEPTED" });
  });

  test("rejects a candidate and stays idempotent", () => {
    const candidate = seedCandidate("CONTEXT_ITEM");

    const rejected = application.reject({ candidateId: candidate.id, expectedRevision: candidate.revision });
    expect(rejected).toMatchObject({ outcome: "REJECTED" });
    expect(rejected.candidate.status).toBe("REJECTED");

    const again = application.reject({ candidateId: candidate.id, expectedRevision: rejected.candidate.revision });
    expect(again).toMatchObject({ outcome: "ALREADY_REJECTED" });
    expect(contextItems.list({ projectId, limit: 50 })).toHaveLength(0);
  });

  test("refuses to apply a rejected candidate", () => {
    const candidate = seedCandidate("CONTEXT_ITEM");
    const rejected = application.reject({ candidateId: candidate.id, expectedRevision: candidate.revision });

    expect(() => application.apply({ candidateId: candidate.id, expectedRevision: rejected.candidate.revision }))
      .toThrowError(expect.objectContaining({ code: "CANDIDATE_NOT_APPLICABLE" }));
  });

  test("writes activity and audit for the candidate life cycle", () => {
    const candidate = seedCandidate("CONTEXT_ITEM");
    application.apply({ candidateId: candidate.id, expectedRevision: candidate.revision });

    const audit = client.db.prepare(
      "SELECT action, resource_type, resource_id FROM audit_events WHERE resource_type = 'EXTRACTION_CANDIDATE'"
    ).all() as Array<{ action: string; resource_type: string; resource_id: string }>;
    expect(audit).toEqual([{ action: "APPLY", resource_type: "EXTRACTION_CANDIDATE", resource_id: candidate.id }]);

    const activity = client.db.prepare(
      "SELECT event_type FROM activity_events WHERE resource_type = 'EXTRACTION_CANDIDATE'"
    ).all() as Array<{ event_type: string }>;
    expect(activity).toEqual([{ event_type: "CANDIDATE_APPLIED" }]);
  });
});

describe("review item linkage", () => {
  test("approving a review item applies the candidate and closes the item", () => {
    const candidate = seedCandidate("CONTEXT_ITEM");
    const review = openReviewFor(candidate.id);

    const result = application.resolveReviewItem({
      reviewItemId: review.id,
      expectedRevision: review.revision,
      resolutionType: "APPROVED",
      resolutionReason: "looks right"
    });

    expect(result.application.outcome).toBe("APPLIED");
    expect(result.reviewItem).toMatchObject({ status: "RESOLVED", resolutionType: "APPROVED" });
    expect(automation.getCandidate(candidate.id)).toMatchObject({ status: "ACCEPTED" });
  });

  test("dismissing a review item rejects the candidate", () => {
    const candidate = seedCandidate("CONTEXT_ITEM");
    const review = openReviewFor(candidate.id);

    const result = application.resolveReviewItem({
      reviewItemId: review.id,
      expectedRevision: review.revision,
      resolutionType: "DISMISSED",
      resolutionReason: "not useful"
    });

    expect(result.application.outcome).toBe("REJECTED");
    expect(result.reviewItem).toMatchObject({ status: "DISMISSED" });
    expect(automation.getCandidate(candidate.id)).toMatchObject({ status: "REJECTED" });
    expect(contextItems.list({ projectId, limit: 50 })).toHaveLength(0);
  });

  test("leaves the review item open when the application fails", () => {
    const candidate = seedCandidate("RESUME_CAPSULE", { sessionId: null });
    const review = openReviewFor(candidate.id);

    expect(() => application.resolveReviewItem({
      reviewItemId: review.id,
      expectedRevision: review.revision,
      resolutionType: "APPROVED",
      resolutionReason: "try it"
    })).toThrowError(expect.objectContaining({ code: "CANDIDATE_TARGET_SESSION_MISSING" }));

    expect(reviewItems.getById(review.id)).toMatchObject({ status: "OPEN" });
    expect(automation.getCandidate(candidate.id)).toMatchObject({ status: "PENDING" });
  });


});
describe("candidates reaching agent context", () => {
  function packageFor() {
    return runtime.createContextPackageForSession({ projectId, sessionId, intent: "wire it" }, now);
  }

  test("an accepted context item enters a package built afterwards, and not one built before", () => {
    const candidate = seedCandidate("CONTEXT_ITEM");
    const before = packageFor();
    expect(before.contextItems).toHaveLength(0);

    const result = application.apply({ candidateId: candidate.id, expectedRevision: candidate.revision });
    const itemId = result.target!.resourceId;

    const created = contextItems.get(itemId);
    expect(created).toMatchObject({ status: "ACTIVE", sourceSnapshotId: sourceEvidenceId });

    // Packages are immutable snapshots, so the earlier one is untouched.
    const stillBefore = runtime.getContextPackageForSession(sessionId);
    expect(stillBefore.id).toBe(before.id);
    expect(stillBefore.contextItems).toHaveLength(0);

    const after = packageFor();
    expect(after.contextItems.map((entry) => entry.id)).toEqual([itemId]);
  });

  test("pending and rejected candidates never enter a package", () => {
    const pending = seedCandidate("CONTEXT_ITEM");
    const rejected = seedCandidate("CONTEXT_ITEM");
    application.reject({ candidateId: rejected.id, expectedRevision: rejected.revision });

    const accepted = seedCandidate("CONTEXT_ITEM");
    const applied = application.apply({ candidateId: accepted.id, expectedRevision: accepted.revision });

    const built = packageFor();
    const ids = built.contextItems.map((entry) => entry.id);
    expect(ids).toEqual([applied.target!.resourceId]);
    expect(ids).not.toContain(pending.id);
    expect(automation.getCandidate(pending.id)).toMatchObject({ status: "PENDING" });
    expect(automation.getCandidate(rejected.id)).toMatchObject({ status: "REJECTED" });
  });

  test("a resume capsule applied to a session is visible when the session is read", () => {
    const candidate = seedCandidate("RESUME_CAPSULE");
    expect(sessions.getResumeCapsule(sessionId).summary).not.toBe("Wired the extractor.");

    application.apply({ candidateId: candidate.id, expectedRevision: candidate.revision });

    expect(sessions.getResumeCapsule(sessionId)).toMatchObject({
      summary: "Wired the extractor.",
      nextAction: "Persist candidates."
    });
  });

  test("rolls back the whole decision when the Review Item update fails", () => {
    const candidate = seedCandidate("CONTEXT_ITEM");
    const review = openReviewFor(candidate.id);

    // The governed object and the candidate status both succeed, then the Review Item write fails.
    const flaky = Object.create(reviewItems) as SqliteReviewItemRepository;
    flaky.updateStatus = () => {
      throw new Error("review update failed");
    };
    const failing = new CandidateApplicationService({
      automation,
      sessions,
      contextItems,
      reviewItems: flaky,
      clock: () => now
    });

    // The fixture's own review item creation already wrote one activity row; the point is that
    // the failed decision adds none.
    const auditBefore = client.db.prepare("SELECT id FROM audit_events WHERE resource_type = 'EXTRACTION_CANDIDATE'").all();
    const activityBefore = client.db.prepare("SELECT id FROM activity_events WHERE resource_type = 'EXTRACTION_CANDIDATE'").all();

    expect(() => failing.resolveReviewItem({
      reviewItemId: review.id,
      expectedRevision: review.revision,
      resolutionType: "APPROVED",
      resolutionReason: "try it"
    })).toThrow(/review update failed/);

    // Nothing survived: no accepted candidate, no governed object, no audit residue.
    expect(automation.getCandidate(candidate.id)).toMatchObject({ status: "PENDING", targetResourceId: null });
    expect(contextItems.list({ projectId, limit: 50 })).toHaveLength(0);
    expect(reviewItems.getById(review.id)).toMatchObject({ status: "OPEN" });

    const audit = client.db.prepare("SELECT id FROM audit_events WHERE resource_type = 'EXTRACTION_CANDIDATE'").all();
    expect(audit).toHaveLength(auditBefore.length);
    const activity = client.db.prepare("SELECT id FROM activity_events WHERE resource_type = 'EXTRACTION_CANDIDATE'").all();
    expect(activity).toHaveLength(activityBefore.length);
  });
});
