import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { DesktopSyncService } from "../../packages/application/src/core/desktop-sync-service.js";
import { AgentAdapterRegistry } from "../../packages/infrastructure/src/adapters/registry.js";
import { CodexAdapter } from "../../packages/infrastructure/src/adapters/codex-adapter.js";
import { CodexTranscriptTailer } from "../../packages/infrastructure/src/adapters/codex-transcript-tailer.js";
import { SqliteClient } from "../../packages/infrastructure/src/sqlite/client.js";
import { SqliteProjectRepository } from "../../packages/infrastructure/src/sqlite/project-repository.js";
import { SqliteSessionRepository } from "../../packages/infrastructure/src/sqlite/core-repositories.js";
import { SqliteSessionSyncRepository } from "../../packages/infrastructure/src/sqlite/session-sync-repository.js";
import { registerCoreResourceRoutes } from "../../apps/daemon/src/http/routes/core-resources.js";
import { runMigrations } from "../../packages/infrastructure/src/sqlite/migrations.js";
import { nowMs } from "../../packages/shared/src/clock.js";
import type { ExternalSessionCandidate } from "../../packages/application/src/ports/agent-adapter.js";
import type { DesktopSyncCandidate } from "../../packages/contracts/src/sessions.js";

let server: FastifyInstance;
let sqlite: SqliteClient | undefined;
let sessions: SqliteSessionRepository;
let sync: SqliteSessionSyncRepository;
let dataDir: string;
let sessionId: string;
let otherSessionId: string;
const requestedCwds: (string | undefined)[] = [];
let discovered: DesktopSyncCandidate[] = [];

function candidate(id: string, cwd: string): ExternalSessionCandidate {
  return {
    externalSessionId: id,
    transcriptPath: `${cwd}\\rollout-${id}.jsonl`,
    cwd,
    name: null,
    preview: `preview for ${id}`,
    updatedAt: new Date(nowMs()).toISOString(),
    status: "notLoaded",
    source: "vscode",
    turnCount: null
  };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "contextos-candidates-"));

  sqlite = SqliteClient.open({ databaseFile: join(dataDir, "contextos.sqlite") });
  runMigrations(sqlite);
  const projects = new SqliteProjectRepository(sqlite.db);
  sessions = new SqliteSessionRepository(sqlite.db);
  sync = new SqliteSessionSyncRepository(sqlite.db);
  const project = projects.create({ name: "Discovery project", rootPath: dataDir, defaultRuleIds: [], agentAdapterIds: ["codex"] }, nowMs());
  const session = sessions.create({ projectId: project.id, agentAdapterId: "codex", title: "Discovery", intent: "find threads" }, nowMs());
  const other = sessions.create({ projectId: project.id, agentAdapterId: "codex", title: "Other", intent: "already bound" }, nowMs());
  sessionId = session.id;
  otherSessionId = other.id;

  // A different Session already points at thread-2, so it must come back
  // flagged rather than offered as an empty pick that fails with CONFLICT.
  sync.upsert({
    sessionId: other.id,
    adapterId: "codex",
    externalSessionId: "thread-2",
    transcriptPath: join(dataDir, "rollout-thread-2.jsonl"),
    byteOffset: 0,
    eventsIngested: 0,
    lastEventAt: null,
    lastSyncedAt: new Date(nowMs()).toISOString(),
    status: "WATCHING",
    lastError: null,
    updatedAt: new Date(nowMs()).toISOString()
  });

  const adapter = new CodexAdapter("codex.cmd", ["exec"], "win32", dataDir);
  // Stand in for `codex app-server` so the test never spawns a real process.
  Object.assign(adapter, {
    listExternalSessions: async (input: { cwd?: string }): Promise<ExternalSessionCandidate[]> => {
      requestedCwds.push(input.cwd);
      return input.cwd === dataDir
        ? [candidate("thread-1", dataDir), candidate("thread-2", dataDir)]
        : [candidate("thread-2", dataDir), candidate("thread-3", dirname(dataDir))];
    }
  });

  const desktopSync = new DesktopSyncService({
    sessions,
    sync,
    adapters: new AgentAdapterRegistry([adapter]),
    tailer: new CodexTranscriptTailer(),
    resolveProjectRoot: () => dataDir
  });

  server = Fastify({ logger: false });
  await server.register(cors);
  await registerCoreResourceRoutes(server, {
    sessions: { getByIdOrThrow: (id: string) => sessions.getByIdOrThrow(id) } as never,
    decisions: {} as never,
    workItems: {} as never,
    reviewItems: {} as never,
    desktopSync
  });
  await server.ready();

  const response = await server.inject({ method: "GET", url: `/api/sessions/${sessionId}/desktop-sync/candidates` });
  expect(response.statusCode).toBe(200);
  discovered = (response.json() as { candidates: DesktopSyncCandidate[] }).candidates;
});

afterAll(async () => {
  await server?.close();
  sqlite?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("desktop sync candidate discovery", () => {
  it("scopes discovery to the project root and then its parent", () => {
    // Threads are usually recorded against the parent directory, so both are queried.
    expect(requestedCwds).toEqual([dataDir, dirname(dataDir)]);
  });

  it("merges both result sets without duplicating threads", () => {
    const ids = discovered.map((item) => item.externalSessionId);
    expect(ids).toEqual(["thread-1", "thread-2", "thread-3"]);
  });

  it("flags threads another Session already bound", () => {
    const bound = discovered.filter((item) => item.alreadyBound).map((item) => item.externalSessionId);
    expect(bound).toEqual(["thread-2"]);
  });

  it("does not flag the current Session's own binding", async () => {
    sync.upsert({
      sessionId,
      adapterId: "codex",
      externalSessionId: "thread-1",
      transcriptPath: join(dataDir, "rollout-thread-1.jsonl"),
      byteOffset: 0,
      eventsIngested: 0,
      lastEventAt: null,
      lastSyncedAt: new Date(nowMs()).toISOString(),
      status: "WATCHING",
      lastError: null,
      updatedAt: new Date(nowMs()).toISOString()
    });
    const response = await server.inject({ method: "GET", url: `/api/sessions/${sessionId}/desktop-sync/candidates` });
    const candidates = (response.json() as { candidates: DesktopSyncCandidate[] }).candidates;
    const own = candidates.find((item) => item.externalSessionId === "thread-1");
    expect(own?.alreadyBound).toBe(false);
    sync.remove(sessionId);
  });

  it("honours an explicit cwd override", async () => {
    requestedCwds.length = 0;
    const response = await server.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/desktop-sync/candidates?cwd=${encodeURIComponent("D:\\somewhere")}`
    });
    expect(response.statusCode).toBe(200);
    expect(requestedCwds).toEqual(["D:\\somewhere"]);
  });

  it("returns an empty list when the adapter cannot discover threads", async () => {
    const project = new SqliteProjectRepository(sqlite!.db).create({ name: "No discovery", rootPath: dataDir, defaultRuleIds: [], agentAdapterIds: ["codex"] }, nowMs());
    const plainSession = sessions.create({ projectId: project.id, agentAdapterId: "codex", title: "Plain", intent: "no discovery" }, nowMs());
    const plainAdapter = new CodexAdapter("codex.cmd", ["exec"], "win32", dataDir);
    // Explicitly unsupported — must not fall through to a real app-server spawn.
    Object.assign(plainAdapter, { listExternalSessions: undefined });
    const isolated = new DesktopSyncService({
      sessions,
      sync: new SqliteSessionSyncRepository(sqlite!.db),
      adapters: new AgentAdapterRegistry([plainAdapter]),
      tailer: new CodexTranscriptTailer(),
      resolveProjectRoot: () => dataDir
    });
    await expect(isolated.listCandidates(plainSession.id)).resolves.toEqual([]);
    expect(otherSessionId).toBeTruthy();
  });
});
