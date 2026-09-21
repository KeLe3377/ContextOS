import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";
import { CodexAdapter } from "../../packages/infrastructure/src/adapters/codex-adapter.js";

let server: FastifyInstance | undefined;
let tempDir: string | undefined;
let projectId: string;

const sourceEvidenceId = "ev_source";

async function post(url: string, payload: Record<string, unknown>) {
  const response = await server!.inject({ method: "POST", url, payload });
  // Project creation answers 201; the automation mutations answer 200.
  expect([200, 201]).toContain(response.statusCode);
  return response.json() as Record<string, unknown>;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-automation-api-"));
  server = await createDaemonServer({
    agentAdapter: new CodexAdapter(process.execPath, ["-e", ""], process.platform, join(tempDir, "codex-sessions")),
    config: { host: "127.0.0.1", port: 0, dataDir: tempDir, databaseFile: join(tempDir, "contextos.sqlite") }
  });
  const project = await post("/api/projects", { name: "Automation", rootPath: "D:/project/ContextOS" });
  projectId = project.id as string;
  await server!.inject({
    method: "POST",
    url: "/api/evidence/snapshots",
    payload: { projectId, evidenceType: "AGENT_OUTPUT", title: "Batch", contentText: "body" }
  }).then(() => undefined);
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("automation API", () => {
  test("exposes the automation status", async () => {
    const response = await server!.inject({ method: "GET", url: "/api/automation/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty("projects");
  });

  test("reads and patches project automation settings", async () => {
    const initial = await server!.inject({ method: "GET", url: `/api/projects/${projectId}/automation/settings` });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ projectId, mode: "SUGGEST_ONLY" });

    const patched = await server!.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/automation/settings`,
      payload: { mode: "OFF", expectedRevision: initial.json().revision }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ mode: "OFF" });
  });

});

describe("automation API error surface", () => {
  test("returns NOT_FOUND for an unknown candidate", async () => {
    const response = await server!.inject({ method: "GET", url: "/api/automation/candidates/cand_missing" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  test("rejects an invalid settings patch", async () => {
    const settings = (await server!.inject({ method: "GET", url: `/api/projects/${projectId}/automation/settings` })).json();
    const response = await server!.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/automation/settings`,
      payload: { mode: "NOT_A_MODE", expectedRevision: settings.revision }
    });
    expect(response.statusCode).toBe(400);
  });
});
