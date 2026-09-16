import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";

const originalCommand = process.env.CONTEXTOS_CODEX_COMMAND;
const originalArgs = process.env.CONTEXTOS_CODEX_ARGS;

let tempDir: string | undefined;
let server: FastifyInstance | undefined;
let launchedPid: number | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  if (launchedPid) {
    try {
      process.kill(launchedPid);
    } catch {
      // The process may already have exited.
    }
    launchedPid = undefined;
  }
  if (tempDir) {
    await rmWithRetry(tempDir);
    tempDir = undefined;
  }
  restoreEnv();
});

describe("runtime recovery", () => {
  test("marks orphaned running continue runs failed on daemon restart", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "contextos-recovery-"));
    const databaseFile = join(tempDir, "contextos.sqlite");

    server = await createTestServer(databaseFile, ["-e", "setTimeout(() => {}, 5000)"]);
    const session = await createSession(server);

    const continued = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: session.revision }
    });
    expect(continued.statusCode).toBe(200);
    expect(continued.json().status).toBe("RUNNING");
    expect(continued.json().run.status).toBe("RUNNING");
    launchedPid = continued.json().run.pid;

    await server.close();
    server = undefined;

    server = await createTestServer(databaseFile, ["-e", ""]);
    const recovered = await server.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().status).toBe("FAILED");
    expect(recovered.json().completedAt).toBeTruthy();
  });
});

async function createTestServer(databaseFile: string, args: string[]): Promise<FastifyInstance> {
  if (!tempDir) throw new Error("missing tempDir");
  restoreEnv();
  process.env.CONTEXTOS_CODEX_COMMAND = process.execPath;
  process.env.CONTEXTOS_CODEX_ARGS = JSON.stringify(args);
  return createDaemonServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      dataDir: tempDir,
      databaseFile
    }
  });
}

async function createSession(instance: FastifyInstance): Promise<{ id: string; revision: number }> {
  const projectResponse = await instance.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "Recovery", rootPath: "D:/project/ContextOS" }
  });
  expect(projectResponse.statusCode).toBe(201);
  const project = projectResponse.json();

  const sessionResponse = await instance.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { projectId: project.id, agentAdapterId: "codex", title: "Recovery continue", intent: "Exercise orphan recovery" }
  });
  expect(sessionResponse.statusCode).toBe(201);
  return sessionResponse.json();
}

function restoreEnv(): void {
  setEnv("CONTEXTOS_CODEX_COMMAND", originalCommand);
  setEnv("CONTEXTOS_CODEX_ARGS", originalArgs);
}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function rmWithRetry(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
