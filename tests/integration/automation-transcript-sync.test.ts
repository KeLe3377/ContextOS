import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
import { SqliteSessionSyncRepository } from "../../packages/infrastructure/src/sqlite/session-sync-repository.js";

const externalSessionId = "01a0cccc-0000-7000-8000-000000000001";
const pollIntervalMs = 30_000;

let tempDir: string;
let rolloutPath: string;
let client: SqliteClient;
let projects: SqliteProjectRepository;
let sessions: SqliteSessionRepository;
let sync: SqliteSessionSyncRepository;
let automation: SqliteAutomationRepository;
let service: AutomationService;
let projectId: string;
let sessionId: string;
let clockNow: number;

function messageRow(role: "user" | "assistant", text: string, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] }
  });
}

function createTranscriptAdapter(): AgentAdapter {
  return {
    id: "codex",
    displayName: "Codex",
    transcriptParserVersion: "codex-jsonl.test.v1",
    resolveTranscriptPath: () => rolloutPath,
    parseTranscriptRows: ({ rows, startOrdinal }: { rows: string[]; startOrdinal: number }): AgentTranscriptEvent[] => {
      const events: AgentTranscriptEvent[] = [];
      let ordinal = startOrdinal;
      for (const row of rows) {
        let parsed: { timestamp?: string; type?: string; payload?: { type?: string; role?: "user" | "assistant"; content?: Array<{ text?: string }> } };
        try {
          parsed = JSON.parse(row) as typeof parsed;
        } catch {
          continue;
        }
        if (parsed.type !== "response_item" || parsed.payload?.type !== "message") continue;
        ordinal += 1;
        events.push({
          ordinal,
          timestamp: parsed.timestamp,
          kind: "message",
          role: parsed.payload.role,
          text: parsed.payload.content?.[0]?.text
        });
      }
      return events;
    }
  } as unknown as AgentAdapter;
}

function syncStateRow() {
  return client.db.prepare("SELECT * FROM session_sync_state WHERE session_id = ?").get(sessionId) as {
    byte_offset: number;
    events_ingested: number;
    last_synced_at: string | null;
    status: string;
    last_error: string | null;
  };
}

function syncJobs() {
  return client.db.prepare(
    "SELECT id, status, available_at, idempotency_key FROM automation_jobs WHERE kind = 'SYNC_SESSION_TRANSCRIPT' ORDER BY created_at, id"
  ).all() as Array<{ id: string; status: string; available_at: number; idempotency_key: string }>;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-bgsync-"));
  rolloutPath = join(tempDir, "rollout.jsonl");
  // Whole-second base keeps the second-precision `last_synced_at` comparison deterministic.
  clockNow = Math.floor(Date.now() / 1000) * 1000;

  client = SqliteClient.open({ databaseFile: join(tempDir, "contextos.sqlite") });
  runMigrations(client);
  projects = new SqliteProjectRepository(client.db);
  sessions = new SqliteSessionRepository(client.db);
  sync = new SqliteSessionSyncRepository(client.db);
  automation = new SqliteAutomationRepository(client.db);

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
    reviewItems: new SqliteReviewItemRepository(client.db),
    automation,
    evidence: new EvidenceSnapshotService(
      new SqliteEvidenceSnapshotRepository(client.db),
      new FileEvidenceStore(tempDir),
      new SqliteReviewItemRepository(client.db)
    ),
    adapters,
    desktopSync,
    clock: () => clockNow
  });

  const project = projects.create({ name: "Background sync", rootPath: tempDir, defaultRuleIds: [], agentAdapterIds: ["codex"] }, clockNow);
  projectId = project.id;
  automation.patchSettings(projectId, { pollIntervalMs, expectedRevision: 1 }, clockNow);
  sessionId = sessions.createDiscovered({ projectId, agentAdapterId: "codex", externalSessionId, title: "Rollout" }, clockNow).session.id;
});

afterEach(async () => {
  client.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("background transcript sync", () => {
  test("binds a discovered session at the end of the rollout and then advances without a browser", async () => {
    await writeFile(rolloutPath, [
      messageRow("user", "history question", new Date(clockNow - 5_000).toISOString()),
      messageRow("assistant", "history answer", new Date(clockNow - 4_000).toISOString()),
      ""
    ].join("\n"), "utf8");

    // First pass only binds: enabling automation must not replay the whole history.
    const bound = await service.syncSessionTranscript({ sessionId });
    expect(bound).toMatchObject({ newEvents: 0, status: "WATCHING", startOrdinal: null, nextPollScheduled: true });

    // The bind happened at EOF, so the offset already covers the historical rows.
    const stateAfterBind = client.db.prepare("SELECT byte_offset, events_ingested FROM session_sync_state WHERE session_id = ?")
      .get(sessionId) as { byte_offset: number; events_ingested: number };
    expect(stateAfterBind.byte_offset).toBeGreaterThan(0);
    expect(stateAfterBind.events_ingested).toBe(0);

    const appended = new Date(clockNow).toISOString();
    await appendFile(rolloutPath, `${messageRow("user", "new question", appended)}\n`, "utf8");

    // The next poll happens one cadence later, so its bucket is a different one.
    clockNow += pollIntervalMs;
    const ingested = await service.syncSessionTranscript({ sessionId });
    expect(ingested).toMatchObject({
      newEvents: 1,
      status: "WATCHING",
      startOrdinal: 0,
      endOrdinal: 1,
      partialLine: false,
      resetReason: null,
      nextPollScheduled: true
    });
    expect(ingested.startByteOffset).toBe(stateAfterBind.byte_offset);
    expect(ingested.endByteOffset).toBeGreaterThan(ingested.startByteOffset!);
    expect(syncStateRow()).toMatchObject({ events_ingested: 1 });
  });

  test("keeps the poll chain alive with a time-bucketed job", async () => {
    await writeFile(rolloutPath, `${messageRow("user", "hello", new Date(clockNow).toISOString())}\n`, "utf8");

    await service.syncSessionTranscript({ sessionId });
    const jobs = syncJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "QUEUED", available_at: clockNow + pollIntervalMs });
    expect(jobs[0]!.idempotency_key).toBe(`SYNC_SESSION_TRANSCRIPT:${sessionId}:poll:${Math.floor((clockNow + pollIntervalMs) / pollIntervalMs)}`);

    // A second terminal attempt inside the same poll window collapses into the same job.
    await service.syncSessionTranscript({ sessionId });
    expect(syncJobs()).toHaveLength(1);
  });

  test("leaves a partial trailing line for the next read and does not advance past it", async () => {
    await writeFile(rolloutPath, `${messageRow("user", "complete", new Date(clockNow).toISOString())}\n`, "utf8");
    await service.syncSessionTranscript({ sessionId });
    const completeOffset = syncStateRow().byte_offset;

    const pending = messageRow("user", "half written", new Date(clockNow).toISOString());
    await appendFile(rolloutPath, pending.slice(0, 40), "utf8");

    const partial = await service.syncSessionTranscript({ sessionId });
    expect(partial).toMatchObject({ newEvents: 0, partialLine: true });
    expect(syncStateRow().byte_offset).toBe(completeOffset);

    await appendFile(rolloutPath, `${pending.slice(40)}\n`, "utf8");
    const completed = await service.syncSessionTranscript({ sessionId });
    expect(completed).toMatchObject({ newEvents: 1, partialLine: false });
    expect(syncStateRow().byte_offset).toBeGreaterThan(completeOffset);
  });

  test("retains the last successful offset when the rollout becomes unreadable", async () => {
    await writeFile(rolloutPath, `${messageRow("user", "first", new Date(clockNow).toISOString())}\n`, "utf8");
    // Bind at EOF, then ingest one real event so there is progress worth preserving.
    await service.syncSessionTranscript({ sessionId });
    await appendFile(rolloutPath, `${messageRow("assistant", "second", new Date(clockNow).toISOString())}\n`, "utf8");
    clockNow += pollIntervalMs;
    expect(await service.syncSessionTranscript({ sessionId })).toMatchObject({ newEvents: 1 });

    const offsetBefore = syncStateRow().byte_offset;
    expect(syncStateRow().events_ingested).toBe(1);

    await rm(rolloutPath, { force: true });
    clockNow += pollIntervalMs;
    const failed = await service.syncSessionTranscript({ sessionId });

    expect(failed).toMatchObject({ newEvents: 0, status: "ERROR", nextPollScheduled: true });
    expect(syncStateRow()).toMatchObject({ byte_offset: offsetBefore, events_ingested: 1, status: "ERROR" });
    expect(syncStateRow().last_error).toBeTruthy();
    // The chain keeps polling, so a transient lock resolves itself.
    expect(syncJobs().some((job) => job.status === "QUEUED")).toBe(true);
  });

  test("does not read or re-arm when the project automation mode is OFF", async () => {
    await writeFile(rolloutPath, `${messageRow("user", "ignored", new Date(clockNow).toISOString())}\n`, "utf8");
    automation.patchSettings(projectId, { mode: "OFF", expectedRevision: 2 }, clockNow);

    const summary = await service.syncSessionTranscript({ sessionId });

    expect(summary).toMatchObject({ newEvents: 0, nextPollScheduled: false, status: "UNBOUND" });
    expect(syncJobs()).toHaveLength(0);
    expect(syncStateRow()).toBeUndefined();
  });

  test("lists WATCHING sessions as due work once the project poll interval elapses", async () => {
    await writeFile(rolloutPath, `${messageRow("user", "first", new Date(clockNow).toISOString())}\n`, "utf8");
    await service.syncSessionTranscript({ sessionId });

    const syncedAt = Date.parse(syncStateRow().last_synced_at!);
    // `last_synced_at` is compared at second precision, so the "not yet due" probe keeps a
    // full second of margin instead of one millisecond.
    expect(sync.listDueForSync({ now: syncedAt + pollIntervalMs - 1_001, defaultPollIntervalMs: pollIntervalMs })).toHaveLength(0);
    expect(sync.listDueForSync({ now: syncedAt + pollIntervalMs, defaultPollIntervalMs: pollIntervalMs }))
      .toEqual([expect.objectContaining({ session_id: sessionId, status: "WATCHING" })]);
  });

  test("excludes OFF projects from due work", async () => {
    await writeFile(rolloutPath, `${messageRow("user", "first", new Date(clockNow).toISOString())}\n`, "utf8");
    await service.syncSessionTranscript({ sessionId });
    const syncedAt = Date.parse(syncStateRow().last_synced_at!);

    automation.patchSettings(projectId, { mode: "OFF", expectedRevision: 2 }, clockNow);
    expect(sync.listDueForSync({ now: syncedAt + pollIntervalMs * 10, defaultPollIntervalMs: pollIntervalMs })).toHaveLength(0);
  });

  test("re-arms a stalled poll chain through the due-sync sweep", async () => {
    await writeFile(rolloutPath, `${messageRow("user", "first", new Date(clockNow).toISOString())}\n`, "utf8");
    await service.syncSessionTranscript({ sessionId });

    // Simulate a dead chain: the queued follow-up job is gone (for example the daemon was
    // killed after exhausting its retries) while the session is still WATCHING.
    client.db.prepare("UPDATE automation_jobs SET status = 'FAILED' WHERE kind = 'SYNC_SESSION_TRANSCRIPT'").run();

    const syncedAt = Date.parse(syncStateRow().last_synced_at!);
    clockNow = syncedAt + pollIntervalMs * 2;

    const stale = await service.enqueueDueSyncJobs({ projectId });
    expect(stale).toMatchObject({ dueSessions: 1, jobsEnqueued: 1 });
    const queued = syncJobs().filter((job) => job.status === "QUEUED");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.available_at).toBe(clockNow);

    // A second sweep within the same bucket is a no-op rather than a duplicate.
    expect(await service.enqueueDueSyncJobs({ projectId })).toMatchObject({ jobsEnqueued: 0 });
  });

  test("skips the sweep for projects that are switched off", async () => {
    await writeFile(rolloutPath, `${messageRow("user", "first", new Date(clockNow).toISOString())}\n`, "utf8");
    await service.syncSessionTranscript({ sessionId });
    automation.patchSettings(projectId, { mode: "OFF", expectedRevision: 2 }, clockNow);
    clockNow = Date.parse(syncStateRow().last_synced_at!) + pollIntervalMs * 5;

    expect(await service.enqueueDueSyncJobs({ projectId })).toMatchObject({ dueSessions: 0, jobsEnqueued: 0 });
  });

  test("fails loudly when a sync job carries no session", async () => {
    await expect(
      service.handleSyncJob({
        id: "ajob_1",
        kind: "SYNC_SESSION_TRANSCRIPT",
        projectId,
        sessionId: null,
        resourceType: "SESSION",
        resourceId: "sess_missing",
        idempotencyKey: "key",
        status: "RUNNING",
        availableAt: new Date(clockNow).toISOString(),
        attempts: 1,
        maxAttempts: 4,
        failureCode: null,
        failureMessage: null,
        startedAt: null,
        endedAt: null,
        createdAt: new Date(clockNow).toISOString(),
        updatedAt: new Date(clockNow).toISOString(),
        revision: 2,
        payload: {}
      })
    ).rejects.toMatchObject({ code: "SYNC_JOB_MISSING_SESSION" });
  });

  test("restarts the ordinal space when the reader rewinds after the file shrinks", async () => {
    await writeFile(rolloutPath, "", "utf8");
    await service.syncSessionTranscript({ sessionId });

    const stamp = new Date(clockNow).toISOString();
    await appendFile(rolloutPath, `${messageRow("user", "first message", stamp)}\n${messageRow("user", "second message", stamp)}\n`, "utf8");
    clockNow += pollIntervalMs;
    const first = await service.syncSessionTranscript({ sessionId });
    expect(first).toMatchObject({ newEvents: 2, startOrdinal: 0, endOrdinal: 2, resetReason: null });

    // A rollout rewritten shorter than the stored offset makes the reader rewind. The ordinal
    // space has to restart with it, otherwise the re-read rows would claim positions that no
    // longer match the content, and identical content could never deduplicate.
    await writeFile(rolloutPath, `${messageRow("user", "only message", stamp)}\n`, "utf8");
    clockNow += pollIntervalMs;
    const rewound = await service.syncSessionTranscript({ sessionId });

    expect(rewound).toMatchObject({ newEvents: 1, startOrdinal: 0, endOrdinal: 1, resetReason: "offset_beyond_eof" });
    expect(syncStateRow()).toMatchObject({ events_ingested: 1 });
  });

  test("records the sync activity timestamp for the status endpoint", async () => {
    await writeFile(rolloutPath, `${messageRow("user", "first", new Date(clockNow).toISOString())}\n`, "utf8");
    await service.syncSessionTranscript({ sessionId });

    const status = automation.listProjectStatuses().find((entry) => entry.projectId === projectId);
    expect(status?.lastSyncAt).toBe(new Date(clockNow).toISOString());
  });
});
