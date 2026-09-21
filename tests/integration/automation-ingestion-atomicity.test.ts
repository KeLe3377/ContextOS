import { appendFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AutomationJobRouter } from "../../packages/application/src/core/automation-job-router.js";
import { AutomationScheduler } from "../../packages/application/src/core/automation-scheduler.js";
import { AutomationService } from "../../packages/application/src/core/automation-service.js";
import { EvidenceSnapshotService } from "../../packages/application/src/core/context-services.js";
import { DesktopSyncService } from "../../packages/application/src/core/desktop-sync-service.js";
import type { AgentAdapter, AgentTranscriptEvent } from "../../packages/application/src/ports/agent-adapter.js";
import { AgentAdapterRegistry } from "../../packages/infrastructure/src/adapters/registry.js";
import { CodexTranscriptTailer } from "../../packages/infrastructure/src/adapters/codex-transcript-tailer.js";
import { FileEvidenceStore } from "../../packages/infrastructure/src/evidence/evidence-store.js";
import { SqliteAutomationRepository } from "../../packages/infrastructure/src/sqlite/automation-repository.js";
import { SqliteClient } from "../../packages/infrastructure/src/sqlite/client.js";
import { SqliteEvidenceSnapshotRepository } from "../../packages/infrastructure/src/sqlite/context-repositories.js";
import { SqliteReviewItemRepository, SqliteSessionRepository } from "../../packages/infrastructure/src/sqlite/core-repositories.js";
import { runMigrations } from "../../packages/infrastructure/src/sqlite/migrations.js";
import { SqliteProjectRepository } from "../../packages/infrastructure/src/sqlite/project-repository.js";
import { SqliteRuntimeRepository } from "../../packages/infrastructure/src/sqlite/runtime-repository.js";
import { SqliteSessionSyncRepository } from "../../packages/infrastructure/src/sqlite/session-sync-repository.js";
import type { SessionContinuityWriter } from "../../packages/application/src/core/session-continuity.js";

const externalSessionId = "01a0eeee-0000-7000-8000-000000000001";
const pollIntervalMs = 30_000;

let tempDir: string;
let rolloutPath: string;
let client: SqliteClient;
let projects: SqliteProjectRepository;
let sessions: SqliteSessionRepository;
let sync: SqliteSessionSyncRepository;
let automation: SqliteAutomationRepository;
let evidenceService: EvidenceSnapshotService;
let service: AutomationService;
let projectId: string;
let sessionId: string;
let clockNow: number;
let parserVersion: string;
let runtime: SqliteRuntimeRepository;
let failContinuityWrite: boolean;

function messageRow(text: string, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] }
  });
}

function createTranscriptAdapter(): AgentAdapter {
  return {
    id: "codex",
    displayName: "Codex",
    get transcriptParserVersion() {
      return parserVersion;
    },
    resolveTranscriptPath: () => rolloutPath,
    parseTranscriptRows: ({ rows, startOrdinal }: { rows: string[]; startOrdinal: number }): AgentTranscriptEvent[] => {
      const events: AgentTranscriptEvent[] = [];
      let ordinal = startOrdinal;
      for (const row of rows) {
        let parsed: { timestamp?: string; type?: string; payload?: { type?: string; role?: "user"; content?: Array<{ text?: string }> } };
        try {
          parsed = JSON.parse(row) as typeof parsed;
        } catch {
          continue;
        }
        if (parsed.type !== "response_item" || parsed.payload?.type !== "message") continue;
        ordinal += 1;
        events.push({ ordinal, timestamp: parsed.timestamp, kind: "message", role: parsed.payload.role, text: parsed.payload.content?.[0]?.text });
      }
      return events;
    }
  } as unknown as AgentAdapter;
}

function syncState() {
  return client.db.prepare("SELECT byte_offset, events_ingested, status FROM session_sync_state WHERE session_id = ?")
    .get(sessionId) as { byte_offset: number; events_ingested: number; status: string } | undefined;
}

function evidenceRows() {
  return client.db.prepare("SELECT id, content_hash, metadata_json FROM evidence_snapshots ORDER BY created_at, id").all() as Array<{
    id: string;
    content_hash: string;
    metadata_json: string;
  }>;
}

function jobsOf(kind: string) {
  return client.db.prepare("SELECT id, status, attempts FROM automation_jobs WHERE kind = ? ORDER BY created_at, id").all(kind) as Array<{
    id: string;
    status: string;
    attempts: number;
  }>;
}

/** Files actually present under the Evidence root, used to prove no blob is orphaned. */
async function evidenceFileCount(): Promise<number> {
  try {
    const entries = await readdir(join(tempDir, "evidence"), { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).length;
  } catch {
    return 0;
  }
}

async function bindAtEnd(): Promise<void> {
  await writeFile(rolloutPath, "", "utf8");
  await service.syncSessionTranscript({ sessionId });
}

async function appendMessage(text: string): Promise<void> {
  await appendFile(rolloutPath, `${messageRow(text, new Date(clockNow).toISOString())}\n`, "utf8");
}

async function syncOnce() {
  clockNow += pollIntervalMs;
  return service.syncSessionTranscript({ sessionId });
}

const resumeCapsuleWriter: SessionContinuityWriter = {
  write: (input) => {
    if (failContinuityWrite) throw new Error("resume capsule write failed");
    runtime.writeSessionContinuity(input, clockNow);
  }
};

function capsule() {
  return runtime.getResumeCapsule(sessionId);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-atomic-"));
  rolloutPath = join(tempDir, "rollout.jsonl");
  clockNow = Math.floor(Date.now() / 1000) * 1000;
  parserVersion = "codex-jsonl.test.v1";
  failContinuityWrite = false;

  client = SqliteClient.open({ databaseFile: join(tempDir, "contextos.sqlite") });
  runMigrations(client);
  projects = new SqliteProjectRepository(client.db);
  sessions = new SqliteSessionRepository(client.db);
  sync = new SqliteSessionSyncRepository(client.db);
  automation = new SqliteAutomationRepository(client.db);
  const reviewItems = new SqliteReviewItemRepository(client.db);
  runtime = new SqliteRuntimeRepository(client.db);
  evidenceService = new EvidenceSnapshotService(new SqliteEvidenceSnapshotRepository(client.db), new FileEvidenceStore(tempDir), reviewItems);

  const adapters = new AgentAdapterRegistry([createTranscriptAdapter()]);
  const desktopSync = new DesktopSyncService({
    sessions,
    sync,
    adapters,
    tailer: new CodexTranscriptTailer(),
    bindExternalSession: ({ sessionId: id, externalSessionId: external }) => {
      client.db.prepare("UPDATE sessions SET external_session_id = ?, revision = revision + 1 WHERE id = ?").run(external, id);
    }
  });
  service = new AutomationService({
    projects,
    sessions,
    sync,
    reviewItems,
    automation,
    evidence: evidenceService,
    adapters,
    desktopSync,
    // The real repository, so the capsule genuinely shares the ingestion transaction.
    resumeCapsuleWriter,
    clock: () => clockNow
  });

  const project = projects.create({ name: "Atomic ingestion", rootPath: tempDir, defaultRuleIds: [], agentAdapterIds: ["codex"] }, clockNow);
  projectId = project.id;
  automation.patchSettings(projectId, { pollIntervalMs, expectedRevision: 1 }, clockNow);
  sessionId = sessions.createDiscovered({ projectId, agentAdapterId: "codex", externalSessionId, title: "Rollout" }, clockNow).session.id;
});

afterEach(async () => {
  client.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("transcript ingestion commit boundary", () => {
  test("commits Evidence, the reader offset and the session continuity together", async () => {
    await bindAtEnd();
    await appendMessage("first message");
    const summary = await syncOnce();

    const state = syncState()!;
    expect(state).toMatchObject({ events_ingested: 1, status: "WATCHING" });
    expect(state.byte_offset).toBe(summary.endByteOffset);
    expect(evidenceRows()).toHaveLength(1);
    // The deferred compaction/extraction pipeline is no longer part of this unit of work.
    expect(jobsOf("COMPACT_EVIDENCE")).toHaveLength(0);
    await expect(evidenceFileCount()).resolves.toBe(1);

    // The capsule names the Evidence it was derived from and carries the captured text.
    expect(capsule()).toMatchObject({
      evidenceSnapshotIds: [summary.evidenceId],
      nextAction: "first message"
    });
    expect(capsule().contextText).toContain("first message");
  });

  test("rolls the whole ingestion back when the continuity write fails, then re-reads the same batch", async () => {
    await bindAtEnd();
    await appendMessage("must not be lost");
    const offsetBefore = syncState()!.byte_offset;

    failContinuityWrite = true;
    await expect(syncOnce()).rejects.toThrow("resume capsule write failed");
    failContinuityWrite = false;

    // Nothing may survive a failed unit: no offset advance, no Snapshot row, no blob, no capsule.
    expect(syncState()).toMatchObject({ byte_offset: offsetBefore, events_ingested: 0 });
    expect(evidenceRows()).toHaveLength(0);
    await expect(evidenceFileCount()).resolves.toBe(0);
    expect(capsule().contextText).toBeNull();
    expect(capsule().evidenceSnapshotIds).toEqual([]);

    // The reader is still behind the batch, so the next attempt ingests it exactly once.
    const retried = await syncOnce();
    expect(retried).toMatchObject({ newEvents: 1, evidenceReused: false });
    expect(evidenceRows()).toHaveLength(1);
    await expect(evidenceFileCount()).resolves.toBe(1);
    expect(capsule().contextText).toContain("must not be lost");
  });

  test("keeps the reader behind the batch when the offset write itself fails", async () => {
    await bindAtEnd();
    await appendMessage("offset write fails");
    const offsetBefore = syncState()!.byte_offset;

    const originalUpsert = sync.upsert.bind(sync);
    (sync as unknown as { upsert: typeof sync.upsert }).upsert = (state) => {
      throw new Error("sync state write failed");
    };

    await expect(syncOnce()).rejects.toThrow("sync state write failed");
    (sync as unknown as { upsert: typeof sync.upsert }).upsert = originalUpsert;

    expect(syncState()).toMatchObject({ byte_offset: offsetBefore, events_ingested: 0 });
    expect(evidenceRows()).toHaveLength(0);
    await expect(evidenceFileCount()).resolves.toBe(0);
  });
});

describe("agent output evidence identity", () => {
  const contentText = "line one\nline two";

  test("deduplicates by project, session, stream and content hash", () => {
    const otherProjectId = projects.create({ name: "Other", rootPath: join(tempDir, "other"), defaultRuleIds: [], agentAdapterIds: ["codex"] }, clockNow).id;
    const probe = (overrides: { projectId?: string; sessionId?: string; stream?: string } = {}) => evidenceService.prepareAgentOutput({
      projectId: overrides.projectId ?? projectId,
      sessionId: overrides.sessionId ?? "sess_1",
      stream: overrides.stream ?? "desktop-sync",
      title: "Batch",
      contentText,
      metadata: {}
    });

    // Nothing is stored yet, so even an identical probe has nothing to reuse.
    const first = probe();
    expect(first.existing).toBeNull();
    const committed = evidenceService.commitPreparedAgentOutput(first);

    const found = probe();
    expect(found.existing?.id).toBe(committed.id);
    // A reused capture writes no second blob.
    expect(found.stored).toBeNull();

    // A different Session, stream or Project must not fold into the same snapshot.
    expect(probe({ sessionId: "sess_2" }).existing).toBeNull();
    expect(probe({ stream: "other-stream" }).existing).toBeNull();
    expect(probe({ projectId: otherProjectId }).existing).toBeNull();
  });

  test("treats a parser upgrade as a new capture of the same rows", async () => {
    await bindAtEnd();
    await appendMessage("parser upgrade");
    const first = await syncOnce();
    expect(first).toMatchObject({ newEvents: 1, evidenceReused: false });

    // Rewind the reader and re-read identical rows with a different parser version.
    client.db.prepare("UPDATE session_sync_state SET byte_offset = 0, events_ingested = 0 WHERE session_id = ?").run(sessionId);
    parserVersion = "codex-jsonl.test.v2";
    const second = await syncOnce();

    expect(second).toMatchObject({ newEvents: 1, evidenceReused: false });
    expect(second.evidenceId).not.toBe(first.evidenceId);
    expect(evidenceRows()).toHaveLength(2);
    // Continuity is rebuilt from every batch of the stream, oldest first.
    expect(capsule().evidenceSnapshotIds).toEqual([first.evidenceId, second.evidenceId]);
  });

  test("reuses the capture when nothing that defines identity changed", async () => {
    await bindAtEnd();
    await appendMessage("stable identity");
    const first = await syncOnce();

    client.db.prepare("UPDATE session_sync_state SET byte_offset = 0, events_ingested = 0 WHERE session_id = ?").run(sessionId);
    const second = await syncOnce();

    expect(second).toMatchObject({ newEvents: 1, evidenceReused: true, evidenceId: first.evidenceId });
    expect(evidenceRows()).toHaveLength(1);
    // A reused capture changes nothing, so the excerpt is not rewritten either.
    expect(capsule().evidenceSnapshotIds).toEqual([first.evidenceId]);
  });
});

describe("scheduler claim filtering", () => {
  test("leaves jobs of unregistered kinds QUEUED instead of burning their retries", async () => {
    automation.enqueue(
      {
        kind: "EXTRACT_EVIDENCE_CONTEXT",
        projectId,
        sessionId,
        resourceType: "EVIDENCE_SNAPSHOT",
        resourceId: "ev_1",
        idempotencyKey: "EXTRACT_EVIDENCE_CONTEXT:ev_1:test.v1",
        availableAt: 0
      },
      clockNow
    );

    // No handler registered yet: the job must keep its retry budget.
    const idle = new AutomationScheduler({
      repository: automation,
      dispatcher: new AutomationJobRouter(),
      clock: () => clockNow,
      setTimer: () => () => {}
    });
    idle.start();
    await idle.tick();
    await new Promise((resolve) => setImmediate(resolve));
    await idle.stop();

    expect(jobsOf("EXTRACT_EVIDENCE_CONTEXT")).toEqual([expect.objectContaining({ status: "QUEUED", attempts: 0 })]);

    // Registering the handler makes the very same job claimable.
    const active = new AutomationScheduler({
      repository: automation,
      dispatcher: new AutomationJobRouter().register("EXTRACT_EVIDENCE_CONTEXT", async () => {}),
      clock: () => clockNow,
      setTimer: () => () => {}
    });
    active.start();
    await active.tick();
    await new Promise((resolve) => setImmediate(resolve));
    await active.stop();

    expect(jobsOf("EXTRACT_EVIDENCE_CONTEXT")).toEqual([expect.objectContaining({ status: "SUCCEEDED", attempts: 1 })]);
  });
});
