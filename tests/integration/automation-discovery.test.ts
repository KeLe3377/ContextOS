import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AutomationJobRouter } from "../../packages/application/src/core/automation-job-router.js";
import { AutomationScheduler } from "../../packages/application/src/core/automation-scheduler.js";
import { AutomationService } from "../../packages/application/src/core/automation-service.js";
import {
  matchThreadToProject,
  normalizeProjectPath,
  threadMatchReasons,
  threadTitle
} from "../../packages/application/src/core/project-thread-matcher.js";
import type { AgentAdapter, ExternalSessionCandidate } from "../../packages/application/src/ports/agent-adapter.js";
import { AgentAdapterRegistry } from "../../packages/infrastructure/src/adapters/registry.js";
import { CodexTranscriptTailer } from "../../packages/infrastructure/src/adapters/codex-transcript-tailer.js";
import { EvidenceSnapshotService } from "../../packages/application/src/core/context-services.js";
import { FileEvidenceStore } from "../../packages/infrastructure/src/evidence/evidence-store.js";
import { DesktopSyncService } from "../../packages/application/src/core/desktop-sync-service.js";
import { SqliteAutomationRepository } from "../../packages/infrastructure/src/sqlite/automation-repository.js";
import { SqliteClient } from "../../packages/infrastructure/src/sqlite/client.js";
import { SqliteEvidenceSnapshotRepository } from "../../packages/infrastructure/src/sqlite/context-repositories.js";
import { SqliteReviewItemRepository, SqliteSessionRepository } from "../../packages/infrastructure/src/sqlite/core-repositories.js";
import { runMigrations } from "../../packages/infrastructure/src/sqlite/migrations.js";
import { SqliteProjectRepository } from "../../packages/infrastructure/src/sqlite/project-repository.js";
import { SqliteSessionSyncRepository } from "../../packages/infrastructure/src/sqlite/session-sync-repository.js";

const now = 1_760_000_000_000;

let tempDir: string;
let client: SqliteClient;
let projects: SqliteProjectRepository;
let sessions: SqliteSessionRepository;
let reviewItems: SqliteReviewItemRepository;
let automation: SqliteAutomationRepository;

function createFakeAdapter(id: string, threads: ExternalSessionCandidate[]): AgentAdapter {
  return {
    id,
    displayName: id,
    listExternalSessions: async (input: { cwd?: string; limit?: number }) => {
      const scope = normalizeProjectPath(input.cwd);
      return threads.filter((thread) => normalizeProjectPath(thread.cwd) === scope);
    }
  } as unknown as AgentAdapter;
}

function createService(adapters: AgentAdapter[]): AutomationService {
  const registry = new AgentAdapterRegistry(adapters);
  const sync = new SqliteSessionSyncRepository(client.db);
  const desktopSync = new DesktopSyncService({
    sessions,
    sync,
    adapters: registry,
    tailer: new CodexTranscriptTailer(),
    bindExternalSession: ({ sessionId, externalSessionId }) => {
      client.db.prepare("UPDATE sessions SET external_session_id = ?, revision = revision + 1 WHERE id = ?").run(externalSessionId, sessionId);
    }
  });
  return new AutomationService({
    projects,
    sessions,
    sync,
    reviewItems,
    automation,
    evidence: new EvidenceSnapshotService(new SqliteEvidenceSnapshotRepository(client.db), new FileEvidenceStore(tempDir), reviewItems),
    adapters: registry,
    desktopSync,
    clock: () => now
  });
}

function thread(overrides: Partial<ExternalSessionCandidate> & { externalSessionId: string }): ExternalSessionCandidate {
  return {
    transcriptPath: `${overrides.externalSessionId}.jsonl`,
    cwd: tempDir,
    name: null,
    preview: null,
    updatedAt: null,
    status: null,
    source: null,
    turnCount: null,
    ...overrides
  };
}

function createProject(name: string, rootPath = tempDir) {
  return projects.create({ name, rootPath, defaultRuleIds: [], agentAdapterIds: ["codex"] }, now);
}

function syncJobs() {
  return client.db.prepare("SELECT * FROM automation_jobs WHERE kind = 'SYNC_SESSION_TRANSCRIPT' ORDER BY created_at, id").all() as Array<Record<string, unknown>>;
}

function allSessions() {
  return client.db.prepare("SELECT id, project_id, external_session_id, title FROM sessions").all() as Array<{ id: string; project_id: string; external_session_id: string | null; title: string | null }>;
}

function projectStatus(projectId: string) {
  const status = automation.listProjectStatuses().find((entry) => entry.projectId === projectId);
  if (!status) throw new Error(`Missing automation status for ${projectId}`);
  return status;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-discovery-"));
  client = SqliteClient.open({ databaseFile: join(tempDir, "contextos.sqlite") });
  runMigrations(client);
  projects = new SqliteProjectRepository(client.db);
  sessions = new SqliteSessionRepository(client.db);
  reviewItems = new SqliteReviewItemRepository(client.db);
  automation = new SqliteAutomationRepository(client.db);
});

afterEach(async () => {
  client.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("project thread matching", () => {
  const projectsFixture = [
    { id: "proj_root", rootPath: "D:\\project\\ContextOS", status: "ACTIVE" as const }
  ];

  test("matches an exact project root", () => {
    expect(matchThreadToProject({ cwd: "D:\\project\\ContextOS", projects: projectsFixture }))
      .toEqual({ kind: "EXACT", projectId: "proj_root" });
  });

  test("normalizes Windows separators, trailing slashes and case", () => {
    expect(normalizeProjectPath("D:\\project\\ContextOS\\")).toBe("d:/project/contextos");
    expect(normalizeProjectPath("d:/PROJECT/contextos")).toBe("d:/project/contextos");
    expect(matchThreadToProject({ cwd: "d:/project/contextos/", projects: projectsFixture }))
      .toEqual({ kind: "EXACT", projectId: "proj_root" });
  });

  test("does not resolve a thread recorded against the parent directory", () => {
    expect(matchThreadToProject({ cwd: "D:\\project", projects: projectsFixture }))
      .toEqual({ kind: "REVIEW", projectIds: ["proj_root"], reason: threadMatchReasons.parentDirectory });
  });

  test("refuses to pick between several matching projects", () => {
    const result = matchThreadToProject({
      cwd: "D:\\project\\ContextOS",
      projects: [
        ...projectsFixture,
        { id: "proj_duplicate", rootPath: "D:/PROJECT/ContextOS", status: "ACTIVE" }
      ]
    });
    expect(result).toEqual({
      kind: "REVIEW",
      projectIds: ["proj_root", "proj_duplicate"],
      reason: threadMatchReasons.multipleProjects
    });
  });

  test("ignores archived projects and prefers an active match", () => {
    expect(matchThreadToProject({
      cwd: "D:\\project\\ContextOS",
      projects: [{ id: "proj_archived", rootPath: "D:\\project\\ContextOS", status: "ARCHIVED" }]
    })).toEqual({ kind: "IGNORE", reason: threadMatchReasons.projectArchived });

    expect(matchThreadToProject({
      cwd: "D:\\project\\ContextOS",
      projects: [
        { id: "proj_archived", rootPath: "D:\\project\\ContextOS", status: "ARCHIVED" },
        { id: "proj_active", rootPath: "D:\\project\\ContextOS", status: "ACTIVE" }
      ]
    })).toEqual({ kind: "EXACT", projectId: "proj_active" });
  });

  test("ignores threads without a usable cwd and unrelated directories", () => {
    expect(matchThreadToProject({ cwd: null, projects: projectsFixture }))
      .toEqual({ kind: "IGNORE", reason: threadMatchReasons.missingCwd });
    expect(matchThreadToProject({ cwd: "   ", projects: projectsFixture }))
      .toEqual({ kind: "IGNORE", reason: threadMatchReasons.missingCwd });
    expect(matchThreadToProject({ cwd: "D:\\elsewhere", projects: projectsFixture }))
      .toEqual({ kind: "IGNORE", reason: threadMatchReasons.noProjectMatch });
  });

  test("falls back from name to preview to the external id prefix", () => {
    expect(threadTitle({ externalSessionId: "01a0bbbb-0000-7000-8000-000000000001", name: "Sidebar name", preview: "first message" }))
      .toBe("Sidebar name");
    expect(threadTitle({ externalSessionId: "01a0bbbb-0000-7000-8000-000000000001", name: "   ", preview: "  first\nmessage  " }))
      .toBe("first message");
    expect(threadTitle({ externalSessionId: "01a0bbbb-0000-7000-8000-000000000001" }))
      .toBe("01a0bbbb");
  });
});

describe("automation discovery", () => {
  test("binds an exact match and queues a transcript sync", async () => {
    const project = createProject("ContextOS");
    const service = createService([createFakeAdapter("codex", [
      thread({ externalSessionId: "01a0bbbb-0000-7000-8000-000000000001", name: "Zero input automation" })
    ])]);

    const summary = await service.discoverCodexThreads();

    expect(summary).toMatchObject({ projectsScanned: 1, threadsSeen: 1, sessionsCreated: 1, syncJobsEnqueued: 1, alreadyBound: 0, needsReview: 0 });
    const created = allSessions();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      project_id: project.id,
      external_session_id: "01a0bbbb-0000-7000-8000-000000000001",
      title: "Zero input automation"
    });

    const jobs = syncJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "QUEUED", project_id: project.id, session_id: created[0]!.id });

    // Discovery is recorded so the status endpoint can report the last pass.
    expect(projectStatus(project.id).lastDiscoveryAt).toBe(new Date(now).toISOString());
  });

  test("is idempotent across repeated discovery passes", async () => {
    createProject("ContextOS");
    const service = createService([createFakeAdapter("codex", [
      thread({ externalSessionId: "01a0bbbb-0000-7000-8000-000000000002" })
    ])]);

    await service.discoverCodexThreads();
    const second = await service.discoverCodexThreads();

    expect(second).toMatchObject({ sessionsCreated: 0, syncJobsEnqueued: 0, alreadyBound: 1 });
    expect(allSessions()).toHaveLength(1);
    expect(syncJobs()).toHaveLength(1);
  });

  test("never re-binds a thread another Session already owns", async () => {
    const project = createProject("ContextOS");
    const externalSessionId = "01a0bbbb-0000-7000-8000-000000000003";
    sessions.createDiscovered({ projectId: project.id, agentAdapterId: "codex", externalSessionId, title: "Manual binding" }, now);

    const service = createService([createFakeAdapter("codex", [thread({ externalSessionId })])]);
    const summary = await service.discoverCodexThreads();

    expect(summary).toMatchObject({ sessionsCreated: 0, alreadyBound: 1 });
    expect(allSessions()).toHaveLength(1);
    expect(allSessions()[0]!.title).toBe("Manual binding");
  });

  test("raises one deduplicated Review Item for a parent-directory match", async () => {
    const project = createProject("ContextOS");
    const service = createService([createFakeAdapter("codex", [
      thread({ externalSessionId: "01a0bbbb-0000-7000-8000-000000000004", cwd: dirname(tempDir) })
    ])]);

    const first = await service.discoverCodexThreads();
    const second = await service.discoverCodexThreads();

    expect(first).toMatchObject({ needsReview: 1, sessionsCreated: 0 });
    expect(second).toMatchObject({ needsReview: 1, sessionsCreated: 0 });
    expect(allSessions()).toHaveLength(0);

    const open = reviewItems.list({ projectId: project.id, limit: 50 });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      sourceType: "CODEX_THREAD",
      sourceId: "01a0bbbb-0000-7000-8000-000000000004",
      triggerType: threadMatchReasons.parentDirectory,
      status: "OPEN"
    });
    // The Review Item carries decision context only, never transcript text.
    expect(open[0]!.proposedResolution).toContain("Candidate projects:");
  });

  test("raises a Review Item when several projects match the same root", async () => {
    createProject("ContextOS");
    createProject("ContextOS duplicate");
    const service = createService([createFakeAdapter("codex", [
      thread({ externalSessionId: "01a0bbbb-0000-7000-8000-000000000005" })
    ])]);

    const summary = await service.discoverCodexThreads();

    // The same thread is evaluated once per scanned Project, so the counter reports two
    // review decisions while the Review Item itself is deduplicated to a single row.
    expect(summary).toMatchObject({ needsReview: 2, sessionsCreated: 0 });
    expect(allSessions()).toHaveLength(0);
    const items = reviewItems.list({ limit: 50 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ triggerType: threadMatchReasons.multipleProjects });
  });

  test("does nothing while the project automation mode is OFF", async () => {
    const project = createProject("ContextOS");
    automation.patchSettings(project.id, { mode: "OFF", expectedRevision: 1 }, now);
    const service = createService([createFakeAdapter("codex", [
      thread({ externalSessionId: "01a0bbbb-0000-7000-8000-000000000006" })
    ])]);

    const summary = await service.discoverCodexThreads();

    expect(summary).toMatchObject({ projectsScanned: 0, threadsSeen: 0, sessionsCreated: 0, syncJobsEnqueued: 0 });
    expect(allSessions()).toHaveLength(0);
    expect(syncJobs()).toHaveLength(0);
  });

  test("ignores threads whose cwd belongs to an archived project", async () => {
    const project = createProject("ContextOS");
    client.db.prepare("UPDATE projects SET status = 'ARCHIVED' WHERE id = ?").run(project.id);
    const service = createService([createFakeAdapter("codex", [
      thread({ externalSessionId: "01a0bbbb-0000-7000-8000-000000000007" })
    ])]);

    const summary = await service.discoverCodexThreads();

    expect(summary).toMatchObject({ sessionsCreated: 0, needsReview: 0, ignored: 1 });
    expect(allSessions()).toHaveLength(0);
  });

  test("falls back to the preview and then the id prefix for the title", async () => {
    createProject("ContextOS");
    const service = createService([createFakeAdapter("codex", [
      thread({ externalSessionId: "01a0bbbb-0000-7000-8000-000000000008", preview: "First user message" }),
      thread({ externalSessionId: "01a0bbbb-0000-7000-8000-000000000009" })
    ])]);

    await service.discoverCodexThreads();

    const titles = allSessions().map((row) => row.title).sort();
    expect(titles).toEqual(["01a0bbbb", "First user message"]);
  });

  test("skips projects whose adapter cannot list threads", async () => {
    const project = createProject("ContextOS");
    const service = createService([{ id: "codex", displayName: "Codex" } as unknown as AgentAdapter]);

    const summary = await service.discoverCodexThreads();

    expect(summary).toMatchObject({ projectsScanned: 0, threadsSeen: 0 });
    expect(projectStatus(project.id).lastDiscoveryAt).toBeNull();
  });

  test("scopes discovery to a single project when asked", async () => {
    const target = createProject("ContextOS");
    const otherRoot = join(tempDir, "nested-project");
    createProject("Other", otherRoot);
    const service = createService([createFakeAdapter("codex", [
      thread({ externalSessionId: "01a0bbbb-0000-7000-8000-00000000000a", cwd: tempDir }),
      thread({ externalSessionId: "01a0bbbb-0000-7000-8000-00000000000b", cwd: otherRoot })
    ])]);

    const summary = await service.discoverCodexThreads({ projectId: target.id });

    expect(summary).toMatchObject({ projectsScanned: 1, sessionsCreated: 1 });
    expect(allSessions()).toHaveLength(1);
    expect(allSessions()[0]!.project_id).toBe(target.id);
  });
});

describe("automation job routing", () => {
  test("routes a discovery job through the router and the service", async () => {
    createProject("ContextOS");
    const service = createService([createFakeAdapter("codex", [
      thread({ externalSessionId: "01a0bbbb-0000-7000-8000-00000000000c" })
    ])]);
    const router = new AutomationJobRouter().register("DISCOVER_CODEX_THREADS", (job) => service.handleDiscoveryJob(job));

    // The scheduler never learns about discovery semantics: it only claims and dispatches.
    const scheduler = new AutomationScheduler({
      repository: automation,
      dispatcher: router,
      clock: () => now,
      setTimer: () => () => {}
    });
    automation.enqueue(
      {
        kind: "DISCOVER_CODEX_THREADS",
        resourceType: "PROJECT",
        resourceId: "all",
        idempotencyKey: "DISCOVER_CODEX_THREADS:all:1",
        availableAt: 0
      },
      now
    );

    scheduler.start();
    await scheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));

    expect(router.registeredKinds()).toEqual(["DISCOVER_CODEX_THREADS"]);
    expect(allSessions()).toHaveLength(1);
    const jobs = client.db.prepare("SELECT status FROM automation_jobs WHERE kind = 'DISCOVER_CODEX_THREADS'").all() as Array<{ status: string }>;
    expect(jobs).toEqual([{ status: "SUCCEEDED" }]);
    await scheduler.stop();
  });

  test("fails a job whose kind has no handler instead of silently succeeding", async () => {
    const router = new AutomationJobRouter();
    await expect(
      router.dispatch({
        id: "ajob_1",
        kind: "SYNC_SESSION_TRANSCRIPT",
        projectId: null,
        sessionId: null,
        resourceType: "SESSION",
        resourceId: "sess_1",
        idempotencyKey: "key",
        status: "RUNNING",
        availableAt: new Date(now).toISOString(),
        attempts: 1,
        maxAttempts: 4,
        failureCode: null,
        failureMessage: null,
        startedAt: null,
        endedAt: null,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        revision: 2,
        payload: {}
      })
    ).rejects.toMatchObject({ code: "AUTOMATION_HANDLER_MISSING" });
  });
});
