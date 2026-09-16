import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, test } from "vitest";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";

const originalCommand = process.env.CONTEXTOS_CODEX_COMMAND;
const originalArgs = process.env.CONTEXTOS_CODEX_ARGS;
let cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0).reverse()) await cleanup();
  setEnv("CONTEXTOS_CODEX_COMMAND", originalCommand);
  setEnv("CONTEXTOS_CODEX_ARGS", originalArgs);
});

describe("transcript import API", () => {
  test("imports transcript evidence into a completed session and preserves capsule history", async () => {
    const { server, tempDir } = await createTestServer();
    const { project, session } = await createSession(server);
    const continued = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: session.revision }
    });
    expect(continued.statusCode).toBe(200);
    await waitForSessionStatus(server, session.id, "COMPLETED");

    const priorCapsuleResponse = await server.inject({ method: "GET", url: `/api/sessions/${session.id}/resume-capsule` });
    const priorCapsule = priorCapsuleResponse.json();
    const contentText = "user: preserve this decision\nassistant: imported evidence is durable\n";
    const response = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/import-transcript`,
      payload: { contentText, title: "Imported conversation", summary: "Imported outcome" }
    });

    expect(response.statusCode).toBe(201);
    const result = response.json();
    expect(result.evidence).toMatchObject({
      projectId: project.id,
      evidenceType: "AGENT_OUTPUT",
      title: "Imported conversation",
      metadata: {
        sessionId: session.id,
        stream: "imported-transcript",
        importedAt: expect.any(String)
      }
    });
    expect(result.evidence.storageRef).toMatch(new RegExp(`^evidence/${project.id}/`));
    await expect(readFile(join(tempDir, result.evidence.storageRef), "utf8")).resolves.toBe(contentText);

    const verification = await server.inject({
      method: "POST",
      url: `/api/evidence-snapshots/${result.evidence.id}/verify`,
      payload: {}
    });
    expect(verification.statusCode).toBe(200);
    expect(verification.json()).toMatchObject({ exists: true, verified: true, failureCode: null });
    expect(result.resumeCapsule).toMatchObject({
      sessionId: session.id,
      status: "COMPLETED",
      summary: "Imported outcome",
      lastRunId: priorCapsule.lastRunId
    });
    expect(result.resumeCapsule.evidenceSnapshotIds).toEqual([
      ...priorCapsule.evidenceSnapshotIds,
      result.evidence.id
    ]);

    const refreshedSession = await server.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    expect(refreshedSession.json().status).toBe("COMPLETED");
    const db = new Database(join(tempDir, "contextos.sqlite"), { readonly: true });
    try {
      const activityCount = db.prepare("SELECT COUNT(*) AS count FROM activity_events WHERE resource_id = ? AND event_type = 'TRANSCRIPT_IMPORTED'").get(session.id) as { count: number };
      const auditCount = db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE resource_id = ? AND action = 'TRANSCRIPT_IMPORTED'").get(session.id) as { count: number };
      expect(activityCount.count).toBe(1);
      expect(auditCount.count).toBe(1);
    } finally {
      db.close();
    }
  });

  test("uses deterministic defaults and rejects blank transcript fields", async () => {
    const { server } = await createTestServer();
    const { session } = await createSession(server);
    const response = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/import-transcript`,
      payload: { contentText: "an imported transcript" }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      evidence: { title: "Imported Codex transcript" },
      resumeCapsule: { status: "CREATED", summary: "Imported transcript captured." }
    });

    for (const payload of [
      { contentText: "   " },
      { contentText: "valid", summary: "   " },
      { contentText: "valid", title: "   " }
    ]) {
      const invalid = await server.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/import-transcript`,
        payload
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe("INVALID_ARGUMENT");
    }
  });

  test("replays transcript imports by idempotency key without duplicate evidence", async () => {
    const { server, tempDir } = await createTestServer();
    const { session } = await createSession(server);
    const request = {
      method: "POST" as const,
      url: `/api/sessions/${session.id}/import-transcript`,
      headers: { "idempotency-key": "transcript-import-0001" },
      payload: { contentText: "idempotent transcript" }
    };
    const first = await server.inject(request);
    const replay = await server.inject(request);

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["x-idempotent-replay"]).toBe("true");
    expect(replay.json().evidence.id).toBe(first.json().evidence.id);

    const db = new Database(join(tempDir, "contextos.sqlite"), { readonly: true });
    try {
      const row = db.prepare("SELECT COUNT(*) AS count FROM evidence_snapshots WHERE json_extract(metadata_json, '$.sessionId') = ? AND json_extract(metadata_json, '$.stream') = 'imported-transcript'").get(session.id) as { count: number };
      expect(row.count).toBe(1);
    } finally {
      db.close();
    }
  });
});

async function createTestServer(): Promise<{ server: FastifyInstance; tempDir: string }> {
  process.env.CONTEXTOS_CODEX_COMMAND = process.execPath;
  process.env.CONTEXTOS_CODEX_ARGS = JSON.stringify(["-e", "console.log('transcript-import-base')"]);
  const tempDir = await mkdtemp(join(tmpdir(), "contextos-transcript-import-"));
  const server = await createDaemonServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      dataDir: tempDir,
      databaseFile: join(tempDir, "contextos.sqlite")
    }
  });
  cleanupTasks.push(async () => {
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  });
  return { server, tempDir };
}

async function createSession(server: FastifyInstance): Promise<{ project: { id: string }; session: { id: string; revision: number } }> {
  const projectResponse = await server.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "Transcript import", rootPath: "D:/project/ContextOS" }
  });
  expect(projectResponse.statusCode).toBe(201);
  const project = projectResponse.json();
  const sessionResponse = await server.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { projectId: project.id, agentAdapterId: "codex", title: "Import target", intent: "Preserve imported context" }
  });
  expect(sessionResponse.statusCode).toBe(201);
  return { project, session: sessionResponse.json() };
}

async function waitForSessionStatus(server: FastifyInstance, sessionId: string, status: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const response = await server.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    if (response.json().status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Session did not reach ${status}`);
}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
