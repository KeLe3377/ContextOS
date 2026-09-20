import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { ContextOsError } from "../../packages/shared/src/errors.js";

let server: FastifyInstance;
let sqlite: SqliteClient | undefined;
let sessions: SqliteSessionRepository;
let dataDir: string;
let transcriptDir: string;
let transcriptPath: string;
let sessionId: string;
const externalSessionId = "01a0test-0000-7000-8000-000000000001";

function codexRow(type: string, payload: Record<string, unknown>, timestamp?: string): string {
  return JSON.stringify({ timestamp: timestamp ?? new Date(nowMs()).toISOString(), type, payload });
}

function messageRow(role: "user" | "assistant", text: string, timestamp: string): string {
  return codexRow("response_item", { type: "message", role, content: [{ type: "input_text", text }] }, timestamp);
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "contextos-sync-"));
  transcriptDir = await mkdtemp(join(tmpdir(), "contextos-rollout-"));
  transcriptPath = join(transcriptDir, `rollout-${externalSessionId}.jsonl`);

  const t0 = new Date(nowMs() - 4000).toISOString();
  const t1 = new Date(nowMs() - 2000).toISOString();
  await writeFile(
    transcriptPath,
    [
      codexRow("session_meta", { id: externalSessionId, cwd: dataDir }),
      messageRow("user", "first question", t0),
      messageRow("assistant", "first answer", t1),
      ""
    ].join("\n"),
    "utf8"
  );

  sqlite = SqliteClient.open({ databaseFile: join(dataDir, "contextos.sqlite") });
  runMigrations(sqlite);
  const projects = new SqliteProjectRepository(sqlite.db);
  sessions = new SqliteSessionRepository(sqlite.db);
  const sync = new SqliteSessionSyncRepository(sqlite.db);
  const project = projects.create({ name: "Sync project", rootPath: dataDir, defaultRuleIds: [], agentAdapterIds: ["codex"] }, nowMs());
  const session = sessions.create({ projectId: project.id, agentAdapterId: "codex", title: "Desktop sync", intent: "watch rollout" }, nowMs());
  sessionId = session.id;

  const adapters = new AgentAdapterRegistry([new CodexAdapter("codex.cmd", ["exec"], "win32", transcriptDir)]);
  const desktopSync = new DesktopSyncService({
    sessions,
    sync,
    adapters,
    tailer: new CodexTranscriptTailer(),
    // Mirrors production: the daemon writes the external id onto the Session row,
    // which is what makes `continue` resume instead of launching a new thread.
    bindExternalSession: ({ sessionId: id, externalSessionId: external }) => {
      sqlite!.db.prepare("UPDATE sessions SET external_session_id = ?, revision = revision + 1 WHERE id = ?").run(external, id);
    }
  });

  server = Fastify({ logger: false });
  // Mirror the daemon's error mapping so ContextOsError codes surface as real
  // HTTP statuses instead of an opaque 500.
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof ContextOsError) {
      const statusCode = error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : 400;
      return reply.status(statusCode).send({ code: error.code, message: error.message });
    }
    return reply.status(500).send({ code: "INTERNAL", message: error instanceof Error ? error.message : "Request failed" });
  });
  await server.register(cors);
  await registerCoreResourceRoutes(server, {
    sessions: { getByIdOrThrow: (id: string) => sessions.getByIdOrThrow(id) } as never,
    decisions: {} as never,
    workItems: {} as never,
    reviewItems: {} as never,
    desktopSync
  });
  await server.ready();
});

afterAll(async () => {
  await server?.close();
  sqlite?.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(transcriptDir, { recursive: true, force: true });
});

describe("desktop sync API", () => {
  it("starts unbound and binds to the rollout file", async () => {
    const unbound = await server.inject({ method: "GET", url: `/api/sessions/${sessionId}/desktop-sync` });
    expect(unbound.statusCode).toBe(200);
    expect(unbound.json()).toMatchObject({ status: "UNBOUND", transcriptPath: null });
    expect(unbound.json().capabilities).toMatchObject({ desktopReadSync: true, managedCliResume: false, desktopUiControl: false });

    const bound = await server.inject({ method: "POST", url: `/api/sessions/${sessionId}/desktop-sync/bind`, payload: { externalSessionId, fromBeginning: true } });
    expect(bound.statusCode).toBe(201);
    expect(bound.json()).toMatchObject({
      status: "WATCHING",
      externalSessionId,
      transcriptPath,
      byteOffset: 0,
      eventsIngested: 0
    });
    // Once bound, the same external id can be resumed over the CLI.
    expect(bound.json().capabilities).toMatchObject({ desktopReadSync: true, managedCliResume: true, desktopUiControl: false });
    // The external id must land on the Session row too, otherwise `continue`
    // would launch a fresh agent thread instead of resuming this UUID.
    expect(sessions.getByIdOrThrow(sessionId).externalSessionId).toBe(externalSessionId);
  });

  it("tails only new complete lines and advances the byte offset", async () => {
    const first = await server.inject({ method: "POST", url: `/api/sessions/${sessionId}/desktop-sync/sync` });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.newEvents).toBe(2);
    expect(firstBody.newEventTimestamps).toBe(2);
    expect(firstBody.partialLine).toBe(false);
    expect(firstBody.events.map((event: { text: string }) => event.text)).toEqual(["first question", "first answer"]);
    expect(firstBody.byteOffset).toBeGreaterThan(0);
    expect(firstBody.eventsIngested).toBe(2);
    expect(firstBody.lastEventAt).toBeTruthy();
    expect(firstBody.lagMs).toBeGreaterThanOrEqual(0);

    // A second sync with no new content must be a no-op instead of re-reading the file.
    const idle = await server.inject({ method: "POST", url: `/api/sessions/${sessionId}/desktop-sync/sync` });
    expect(idle.json()).toMatchObject({ newEvents: 0, eventsIngested: 2, byteOffset: firstBody.byteOffset });

    // Append a new user message: only that event is picked up.
    const t2 = new Date(nowMs()).toISOString();
    await appendFile(transcriptPath, `${messageRow("user", "second question", t2)}\n`, "utf8");
    const second = await server.inject({ method: "POST", url: `/api/sessions/${sessionId}/desktop-sync/sync` });
    expect(second.json()).toMatchObject({ newEvents: 1, eventsIngested: 3, lastEventAt: t2 });
    expect(second.json().events[0]).toMatchObject({ kind: "message", role: "user", text: "second question" });
  });

  it("leaves a partial trailing line for the next read", async () => {
    // Codex can be killed mid-write; the half-written record must not be ingested
    // yet, and the byte offset must not advance past it.
    const pending = messageRow("user", "third question", new Date(nowMs()).toISOString());
    await appendFile(transcriptPath, pending.slice(0, 40), "utf8");

    const partial = await server.inject({ method: "POST", url: `/api/sessions/${sessionId}/desktop-sync/sync` });
    expect(partial.statusCode).toBe(200);
    expect(partial.json()).toMatchObject({ newEvents: 0, partialLine: true, eventsIngested: 3 });

    await appendFile(transcriptPath, `${pending.slice(40)}\n`, "utf8");
    const completed = await server.inject({ method: "POST", url: `/api/sessions/${sessionId}/desktop-sync/sync` });
    expect(completed.json()).toMatchObject({ newEvents: 1, eventsIngested: 4, partialLine: false });
    expect(completed.json().events[0]).toMatchObject({ kind: "message", role: "user", text: "third question" });
  });

  it("reports errors instead of throwing when the rollout disappears", async () => {
    await rm(transcriptPath, { force: true });
    const failed = await server.inject({ method: "POST", url: `/api/sessions/${sessionId}/desktop-sync/sync` });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({ newEvents: 0 });
    const state = await server.inject({ method: "GET", url: `/api/sessions/${sessionId}/desktop-sync` });
    expect(state.json().status).toBe("ERROR");
    expect(state.json().lastError).toBeTruthy();
  });

  it("refuses to rebind a Session that already points at another external session", async () => {
    const conflict = await server.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/desktop-sync/bind`,
      payload: { externalSessionId: "01a0test-0000-7000-8000-000000000999" }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "CONFLICT" });
    // The original binding is untouched.
    expect(sessions.getByIdOrThrow(sessionId).externalSessionId).toBe(externalSessionId);
  });
});

/**
 * The daemon-owned automation loop persists each ingested batch as immutable Evidence, which
 * needs the exact ordinal and byte range the parser covered. These assertions pin that
 * contract down so the ingestion path cannot silently drift.
 */
describe("desktop sync ingestion batches", () => {
  const batchExternalSessionId = "01a0batch-0000-7000-8000-000000000001";
  let batchDir: string;
  let batchRollout: string;
  let batchClient: SqliteClient | undefined;
  let batchSessions: SqliteSessionRepository;
  let batchSessionId: string;

  beforeAll(async () => {
    batchDir = await mkdtemp(join(tmpdir(), "contextos-batch-"));
    batchRollout = join(batchDir, `rollout-${batchExternalSessionId}.jsonl`);
    await writeFile(batchRollout, [
      codexRow("session_meta", { id: batchExternalSessionId, cwd: batchDir }),
      messageRow("user", "one", new Date(nowMs() - 3000).toISOString()),
      messageRow("assistant", "two", new Date(nowMs() - 2000).toISOString()),
      ""
    ].join("\n"), "utf8");

    batchClient = SqliteClient.open({ databaseFile: join(batchDir, "contextos.sqlite") });
    runMigrations(batchClient);
    const projects = new SqliteProjectRepository(batchClient.db);
    batchSessions = new SqliteSessionRepository(batchClient.db);
    const project = projects.create({ name: "Batch project", rootPath: batchDir, defaultRuleIds: [], agentAdapterIds: ["codex"] }, nowMs());
    batchSessionId = batchSessions.create({ projectId: project.id, agentAdapterId: "codex", title: "Batch", intent: "batch" }, nowMs()).id;
  });

  afterAll(async () => {
    batchClient?.close();
    await rm(batchDir, { recursive: true, force: true });
  });

  it("returns the ordinal and byte range of the ingested batch", () => {
    const service = new DesktopSyncService({
      sessions: batchSessions,
      sync: new SqliteSessionSyncRepository(batchClient!.db),
      adapters: new AgentAdapterRegistry([new CodexAdapter("codex.cmd", ["exec"], "win32", batchDir)]),
      tailer: new CodexTranscriptTailer()
    });

    service.bind(batchSessionId, { externalSessionId: batchExternalSessionId, fromBeginning: true });

    const first = service.syncForIngestion(batchSessionId);
    expect(first.result.newEvents).toBe(2);
    expect(first.batch).toMatchObject({
      sessionId: batchSessionId,
      adapterId: "codex",
      externalSessionId: batchExternalSessionId,
      transcriptPath: batchRollout,
      parserVersion: "codex-jsonl.v5",
      startOrdinal: 0,
      endOrdinal: 2,
      partialLine: false,
      resetReason: null
    });
    expect(first.batch!.startByteOffset).toBe(0);
    expect(first.batch!.endByteOffset).toBe(first.result.byteOffset);
    expect(first.batch!.events.map((event) => event.text)).toEqual(["one", "two"]);

    // Nothing new to read means nothing to persist.
    const second = service.syncForIngestion(batchSessionId);
    expect(second.result.newEvents).toBe(0);
    expect(second.batch).toBeNull();
  });
});
