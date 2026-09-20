import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  SqliteAutomationRepository,
  automationJobMaxAttempts,
  type AutomationJobFailure
} from "../../packages/infrastructure/src/sqlite/automation-repository.js";
import { SqliteClient } from "../../packages/infrastructure/src/sqlite/client.js";
import { runMigrations } from "../../packages/infrastructure/src/sqlite/migrations.js";
import { SqliteProjectRepository } from "../../packages/infrastructure/src/sqlite/project-repository.js";
import { newId } from "../../packages/shared/src/id.js";

const now = 1_760_000_000_000;

let tempDir: string;
let client: SqliteClient;
let repository: SqliteAutomationRepository;
let projectId: string;
let evidenceId: string;
let evidenceSequence = 0;

function insertEvidence(hash?: string): string {
  const id = newId("ev");
  evidenceSequence += 1;
  client.db.prepare(
    "INSERT INTO evidence_snapshots (id, project_id, evidence_type, title, content_hash, metadata_json, captured_at, created_at) VALUES (?, ?, 'AGENT_OUTPUT', ?, ?, '{}', ?, ?)"
  ).run(id, projectId, `Evidence ${evidenceSequence}`, hash ?? `sha256:evidence-${evidenceSequence}`, now, now);
  return id;
}

function enqueueSyncJob(overrides: { idempotencyKey?: string; availableAt?: number; maxAttempts?: number } = {}) {
  return repository.enqueue(
    {
      kind: "SYNC_SESSION_TRANSCRIPT",
      projectId,
      resourceType: "SESSION",
      resourceId: "sess_1",
      idempotencyKey: overrides.idempotencyKey ?? "SYNC_SESSION_TRANSCRIPT:sess_1:1",
      payload: { transcriptPath: "rollout.jsonl" },
      availableAt: overrides.availableAt,
      maxAttempts: overrides.maxAttempts
    },
    now
  );
}

const failure: AutomationJobFailure = { code: "TRANSCRIPT_UNREADABLE", message: "Rollout file is temporarily unreadable" };

function contextItemPayload(summary: string) {
  return { kind: "CONTEXT_ITEM" as const, itemType: "SUMMARY" as const, title: "Automation pipeline", summary, confidence: "HIGH" as const };
}

function upsertCandidate(overrides: { fingerprint?: string; confidence?: number; evidenceId?: string; kind?: "CONTEXT_ITEM" | "RESUME_CAPSULE" } = {}) {
  const source = overrides.evidenceId ?? evidenceId;
  return repository.upsertCandidate(
    {
      projectId,
      sessionId: null,
      sourceEvidenceId: source,
      evidenceIds: [source],
      kind: overrides.kind ?? "CONTEXT_ITEM",
      fingerprint: overrides.fingerprint ?? "sha256:fp-1",
      payload: overrides.kind === "RESUME_CAPSULE"
        ? { kind: "RESUME_CAPSULE", summary: "Where we are", nextAction: null }
        : contextItemPayload("Daemon owns transcript polling"),
      confidence: overrides.confidence ?? 0.7,
      extractorId: "codex-cli",
      extractorVersion: "1.0.0"
    },
    now
  );
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-automation-"));
  client = SqliteClient.open({ databaseFile: join(tempDir, "contextos.sqlite") });
  runMigrations(client);
  repository = new SqliteAutomationRepository(client.db);
  const projects = new SqliteProjectRepository(client.db);
  projectId = projects.create({ name: "Automation project", rootPath: tempDir, defaultRuleIds: [], agentAdapterIds: ["codex"] }, now).id;
  evidenceId = insertEvidence();
});

afterEach(async () => {
  client.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("automation settings storage", () => {
  test("defaults a project to SUGGEST_ONLY", () => {
    const settings = repository.getSettings(projectId, now);
    expect(settings).toMatchObject({
      projectId,
      mode: "SUGGEST_ONLY",
      pollIntervalMs: 30_000,
      maxConcurrentJobs: 1,
      sourceMaxBytes: 262_144,
      autoAcceptThreshold: 0.9,
      revision: 1
    });
  });

  test("patches settings under expectedRevision control", () => {
    const patched = repository.patchSettings(projectId, { mode: "OFF", pollIntervalMs: 5_000, expectedRevision: 1 }, now);
    expect(patched).toMatchObject({ mode: "OFF", pollIntervalMs: 5_000, maxConcurrentJobs: 1, revision: 2 });

    expect(() => repository.patchSettings(projectId, { mode: "SUGGEST_ONLY", expectedRevision: 1 }, now))
      .toThrowError(/revision conflict/i);
    expect(repository.getSettings(projectId, now).mode).toBe("OFF");
  });

  test("rejects settings lookups for unknown projects", () => {
    expect(() => repository.getSettings("proj_missing", now)).toThrowError(/Project not found/i);
  });

  test("records discovery, sync and extraction timestamps", () => {
    repository.markProjectActivity(projectId, "DISCOVERY", now);
    repository.markProjectActivity(projectId, "SYNC", now + 1_000);
    repository.markProjectActivity(projectId, "EXTRACTION", now + 2_000);
    const [status] = repository.listProjectStatuses();
    expect(status).toMatchObject({
      projectId,
      mode: "SUGGEST_ONLY",
      lastDiscoveryAt: new Date(now).toISOString(),
      lastSyncAt: new Date(now + 1_000).toISOString(),
      lastExtractionAt: new Date(now + 2_000).toISOString(),
      pendingCandidates: 0
    });
  });
});

describe("automation job storage", () => {
  test("enqueueing the same active idempotency key twice returns one job", () => {
    const first = enqueueSyncJob();
    expect(first.created).toBe(true);

    const second = enqueueSyncJob();
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(repository.countActiveJobs()).toBe(1);
  });

  test("frees the idempotency key once the job reaches a terminal state", () => {
    const first = enqueueSyncJob();
    repository.claimNext(now);
    repository.markSucceeded(first.job.id, now);

    const second = enqueueSyncJob();
    expect(second.created).toBe(true);
    expect(second.job.id).not.toBe(first.job.id);
  });

  test("only claims a due QUEUED job", () => {
    enqueueSyncJob({ idempotencyKey: "future", availableAt: now + 60_000 });
    expect(repository.claimNext(now)).toBeNull();
    expect(repository.countJobsByStatus().QUEUED).toBe(1);

    const claimed = repository.claimNext(now + 60_000);
    expect(claimed).toMatchObject({ status: "RUNNING", attempts: 1, maxAttempts: automationJobMaxAttempts });
    // A RUNNING job is not claimable again.
    expect(repository.claimNext(now + 120_000)).toBeNull();
  });

  test("claims due jobs oldest first and records an attempt row", () => {
    const later = enqueueSyncJob({ idempotencyKey: "later", availableAt: now + 10 });
    const earlier = enqueueSyncJob({ idempotencyKey: "earlier", availableAt: now + 5 });

    expect(repository.claimNext(now + 10)?.id).toBe(earlier.job.id);
    expect(repository.claimNext(now + 10)?.id).toBe(later.job.id);

    const attemptRows = client.db.prepare("SELECT job_id, attempt_number, status FROM automation_job_attempts").all() as Array<{ job_id: string; attempt_number: number; status: string }>;
    expect(attemptRows).toHaveLength(2);
    const attemptsByJob = Object.fromEntries(attemptRows.map((row) => [row.job_id, { attempt_number: row.attempt_number, status: row.status }]));
    expect(attemptsByJob[earlier.job.id]).toEqual({ attempt_number: 1, status: "STARTED" });
    expect(attemptsByJob[later.job.id]).toEqual({ attempt_number: 1, status: "STARTED" });
  });

  test("claims only the job kinds the caller can run", () => {
    const sync = enqueueSyncJob({ idempotencyKey: "sync" });
    repository.enqueue(
      { kind: "DISCOVER_CODEX_THREADS", projectId, resourceType: "PROJECT", resourceId: "all", idempotencyKey: "discover", availableAt: now },
      now
    );

    expect(repository.claimNext(now, ["DISCOVER_CODEX_THREADS"])?.kind).toBe("DISCOVER_CODEX_THREADS");
    expect(repository.claimNext(now, [])).toBeNull();
    expect(repository.claimNext(now, ["SYNC_SESSION_TRANSCRIPT"])?.id).toBe(sync.job.id);
  });

  test("a RUNNING job can succeed", () => {
    const { job } = enqueueSyncJob();
    repository.claimNext(now);
    const succeeded = repository.markSucceeded(job.id, now + 500);
    expect(succeeded).toMatchObject({ status: "SUCCEEDED", failureCode: null, endedAt: new Date(now + 500).toISOString() });
    expect(openAttemptStatus(job.id)).toBe("SUCCEEDED");
  });

  test("a RUNNING job can go back to a retryable QUEUED state", () => {
    const { job } = enqueueSyncJob();
    repository.claimNext(now);
    const retried = repository.markRetryable(job.id, failure, now + 5_000, now + 100);
    expect(retried).toMatchObject({
      status: "QUEUED",
      availableAt: new Date(now + 5_000).toISOString(),
      failureCode: failure.code,
      attempts: 1
    });
    expect(openAttemptStatus(job.id)).toBe("FAILED");
    // The retry only becomes claimable once the backoff elapses.
    expect(repository.claimNext(now + 4_999)).toBeNull();
    expect(repository.claimNext(now + 5_000)).toMatchObject({ id: job.id, attempts: 2 });
  });

  test("a RUNNING job can fail permanently", () => {
    const { job } = enqueueSyncJob();
    repository.claimNext(now);
    expect(repository.markFailed(job.id, failure, now)).toMatchObject({ status: "FAILED", failureCode: failure.code });
    expect(openAttemptStatus(job.id)).toBe("FAILED");
  });

  test("rejects illegal job transitions", () => {
    const { job } = enqueueSyncJob();
    expect(() => repository.markSucceeded(job.id, now)).toThrowError(/expected state/i);
    expect(() => repository.markFailed("ajob_missing", failure, now)).toThrowError(/not found/i);
  });

  test("recovers RUNNING jobs after a daemon restart", () => {
    const retryable = enqueueSyncJob({ idempotencyKey: "retryable" });
    const exhausted = enqueueSyncJob({ idempotencyKey: "exhausted", maxAttempts: 1 });
    repository.claimNext(now);
    repository.claimNext(now);

    expect(repository.recoverRunning(now + 1_000)).toBe(2);

    expect(repository.getJob(retryable.job.id)).toMatchObject({
      status: "QUEUED",
      failureCode: "DAEMON_RESTARTED",
      availableAt: new Date(now + 1_000).toISOString()
    });
    expect(repository.getJob(exhausted.job.id)).toMatchObject({ status: "FAILED", failureCode: "DAEMON_RESTARTED" });
    expect(repository.recoverRunning(now + 2_000)).toBe(0);
  });

  test("cancels a queued or running job", () => {
    const { job } = enqueueSyncJob();
    expect(repository.markCanceled(job.id, { code: "USER_CANCELED", message: "Canceled by user" }, now))
      .toMatchObject({ status: "CANCELED" });
    expect(() => repository.markCanceled(job.id, { code: "USER_CANCELED", message: "again" }, now))
      .toThrowError(/expected state/i);
  });

  test("enforces one non-terminal job per idempotency key at the database level", () => {
    enqueueSyncJob();
    expect(() =>
      client.db.prepare(
        `INSERT INTO automation_jobs (id, kind, project_id, session_id, resource_type, resource_id, payload_json, idempotency_key, status, available_at, created_at, updated_at, revision)
         VALUES ('ajob_dup', 'SYNC_SESSION_TRANSCRIPT', ?, NULL, 'SESSION', 'sess_1', '{}', 'SYNC_SESSION_TRANSCRIPT:sess_1:1', 'QUEUED', ?, ?, ?, 1)`
      ).run(projectId, now, now, now)
    ).toThrow();
  });

  test("summarises job counts and failures for the status endpoint", () => {
    const first = enqueueSyncJob({ idempotencyKey: "one" });
    enqueueSyncJob({ idempotencyKey: "two", availableAt: now + 60_000 });
    repository.claimNext(now);
    repository.markFailed(first.job.id, failure, now);

    expect(repository.countJobsByStatus()).toEqual({ QUEUED: 1, RUNNING: 0, SUCCEEDED: 0, FAILED: 1, CANCELED: 0 });
    expect(repository.countJobsByKind()).toMatchObject({ SYNC_SESSION_TRANSCRIPT: 2, EXTRACT_EVIDENCE_CONTEXT: 0 });
    expect(repository.countActiveJobs()).toBe(1);
    expect(repository.listLatestFailures()).toEqual([
      expect.objectContaining({ id: first.job.id, kind: "SYNC_SESSION_TRANSCRIPT", failureCode: failure.code })
    ]);
    // Job DTOs must never leak the stored payload.
    expect(repository.listLatestFailures()[0]).not.toHaveProperty("payload");
  });
});

describe("extraction candidate storage", () => {
  test("creates a PENDING candidate and links its evidence", () => {
    const { candidate, created } = upsertCandidate();
    expect(created).toBe(true);
    expect(candidate).toMatchObject({
      projectId,
      kind: "CONTEXT_ITEM",
      fingerprint: "sha256:fp-1",
      status: "PENDING",
      confidence: 0.7,
      extractorId: "codex-cli",
      extractorVersion: "1.0.0",
      targetResourceType: null,
      targetResourceId: null,
      reviewedAt: null,
      revision: 1
    });
    expect(candidate.evidenceIds).toEqual([evidenceId]);
    expect(repository.countPendingCandidates(projectId)).toBe(1);
  });

  test("keeps one active candidate per project, kind and fingerprint", () => {
    const first = upsertCandidate({ confidence: 0.6 });
    const second = upsertCandidate({ confidence: 0.8 });

    expect(second.created).toBe(false);
    expect(second.candidate.id).toBe(first.candidate.id);
    expect(second.candidate.confidence).toBe(0.8);
    expect(second.candidate.evidenceIds).toEqual([evidenceId]);
    expect(repository.listCandidates({ projectId })).toHaveLength(1);
  });

  test("folds additional evidence into the existing candidate instead of duplicating it", () => {
    const first = upsertCandidate();
    const extra = insertEvidence();
    const second = upsertCandidate({ evidenceId: extra });

    expect(second.candidate.id).toBe(first.candidate.id);
    expect(second.candidate.evidenceIds).toEqual([first.candidate.evidenceIds[0], extra]);
    expect(second.candidate.sourceEvidenceId).toBe(evidenceId);
  });

  test("scopes the fingerprint to a project and a kind", () => {
    upsertCandidate();
    expect(upsertCandidate({ kind: "RESUME_CAPSULE" }).created).toBe(true);
    expect(repository.listCandidates({ projectId })).toHaveLength(2);

    const otherProject = new SqliteProjectRepository(client.db)
      .create({ name: "Other", rootPath: `${tempDir}/other`, defaultRuleIds: [], agentAdapterIds: ["codex"] }, now).id;
    const other = repository.upsertCandidate(
      {
        projectId: otherProject,
        kind: "CONTEXT_ITEM",
        fingerprint: "sha256:fp-1",
        payload: contextItemPayload("Same fingerprint, different project"),
        confidence: 0.5,
        extractorId: "codex-cli",
        extractorVersion: "1.0.0"
      },
      now
    );
    expect(other.created).toBe(true);
  });

  test("lets a rejected fingerprint come back as a fresh candidate", () => {
    const first = upsertCandidate();
    repository.transitionCandidate({ id: first.candidate.id, status: "REJECTED", expectedRevision: 1 }, now);

    const second = upsertCandidate();
    expect(second.created).toBe(true);
    expect(second.candidate.id).not.toBe(first.candidate.id);
    expect(repository.listCandidates({ projectId, status: "REJECTED" })).toHaveLength(1);
  });

  test("accepting a candidate records the applied resource under expectedRevision", () => {
    const { candidate } = upsertCandidate();
    const accepted = repository.transitionCandidate(
      { id: candidate.id, status: "ACCEPTED", expectedRevision: 1, target: { resourceType: "CONTEXT_ITEM", resourceId: "ci_1" } },
      now + 100
    );
    expect(accepted).toMatchObject({
      status: "ACCEPTED",
      targetResourceType: "CONTEXT_ITEM",
      targetResourceId: "ci_1",
      reviewedAt: new Date(now + 100).toISOString(),
      revision: 2
    });

    expect(() =>
      repository.transitionCandidate({ id: candidate.id, status: "ACCEPTED", expectedRevision: 1 }, now + 200)
    ).toThrowError(/revision conflict/i);
    expect(() => repository.transitionCandidate({ id: "cand_missing", status: "REJECTED", expectedRevision: 1 }, now))
      .toThrowError(/not found/i);
  });

  test("never rewrites accepted candidate history when the same evidence reappears", () => {
    const first = upsertCandidate({ confidence: 0.6 });
    repository.transitionCandidate(
      { id: first.candidate.id, status: "ACCEPTED", expectedRevision: 1, target: { resourceType: "CONTEXT_ITEM", resourceId: "ci_1" } },
      now
    );

    const replay = upsertCandidate({ confidence: 0.95 });
    expect(replay.created).toBe(false);
    expect(replay.candidate).toMatchObject({ status: "ACCEPTED", confidence: 0.6, revision: 2, targetResourceId: "ci_1" });
  });

  test("rejects evidence that does not exist", () => {
    expect(() => upsertCandidate({ evidenceId: "ev_missing" })).toThrow();
  });

  test("enforces one active candidate per fingerprint at the database level", () => {
    upsertCandidate();
    expect(() =>
      client.db.prepare(
        `INSERT INTO extraction_candidates (id, project_id, session_id, source_evidence_id, kind, fingerprint, payload_json, confidence, status, extractor_id, extractor_version, created_at, updated_at, revision)
         VALUES ('cand_dup', ?, NULL, ?, 'CONTEXT_ITEM', 'sha256:fp-1', '{}', 0.5, 'PENDING', 'codex-cli', '1.0.0', ?, ?, 1)`
      ).run(projectId, evidenceId, now, now)
    ).toThrow();
  });

  test("filters and orders candidate listings", () => {
    const older = upsertCandidate();
    const newer = upsertCandidate({ fingerprint: "sha256:fp-2" });
    repository.transitionCandidate({ id: newer.candidate.id, status: "REJECTED", expectedRevision: 1 }, now + 500);

    const pending = repository.listCandidates({ projectId, status: "PENDING" });
    expect(pending.map((candidate) => candidate.id)).toEqual([older.candidate.id]);
    expect(repository.listCandidates({ projectId, kind: "CONTEXT_ITEM" })).toHaveLength(2);
    expect(repository.listCandidates({ projectId, sessionId: "sess_missing" })).toEqual([]);
    expect(repository.listCandidates({ limit: 1 })).toHaveLength(1);
  });
});

function openAttemptStatus(jobId: string): string | undefined {
  const row = client.db.prepare("SELECT status FROM automation_job_attempts WHERE job_id = ? ORDER BY started_at DESC, id DESC LIMIT 1")
    .get(jobId) as { status: string } | undefined;
  return row?.status;
}
