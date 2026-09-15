import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";

let server: FastifyInstance | undefined;
let tempDir: string | undefined;
let projectId: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-core-"));
  server = await createDaemonServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      dataDir: tempDir,
      databaseFile: join(tempDir, "contextos.sqlite")
    }
  });
  const projectResponse = await server.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "Core", rootPath: "D:/project/ContextOS" }
  });
  projectId = projectResponse.json().id;
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("core resource APIs", () => {
  test("creates and continues sessions", async () => {
    const create = await server!.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, agentAdapterId: "codex", title: "Implement backend", intent: "Task 3" }
    });
    expect(create.statusCode).toBe(201);
    const session = create.json();
    expect(session.status).toBe("CREATED");

    const continued = await server!.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: session.revision }
    });
    expect(continued.statusCode).toBe(200);
    expect(continued.json().status).toBe("RUNNING");
  });

  test("creates and accepts decisions", async () => {
    const create = await server!.inject({
      method: "POST",
      url: "/api/decisions",
      payload: { projectId, title: "Use SQLite", statement: "Use SQLite locally", rationale: "Local-first single user" }
    });
    expect(create.statusCode).toBe(201);
    const decision = create.json();
    expect(decision.status).toBe("DRAFT");

    const accepted = await server!.inject({
      method: "POST",
      url: `/api/decisions/${decision.id}/accept`,
      payload: { expectedRevision: decision.revision }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe("ACCEPTED");
  });

  test("creates and completes work items", async () => {
    const create = await server!.inject({
      method: "POST",
      url: "/api/work-items",
      payload: { projectId, title: "Wire API", acceptance: ["tests pass"] }
    });
    expect(create.statusCode).toBe(201);
    const workItem = create.json();
    expect(workItem.status).toBe("BACKLOG");

    const ready = await server!.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/mark-ready`,
      payload: { expectedRevision: workItem.revision }
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe("READY");

    const done = await server!.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/complete`,
      payload: { expectedRevision: ready.json().revision }
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().status).toBe("DONE");
  });

  test("creates and resolves review items with a written reason", async () => {
    const create = await server!.inject({
      method: "POST",
      url: "/api/review-items",
      payload: { projectId, sourceType: "RULE", sourceId: "rule_1", triggerType: "REQUIRE_REVIEW", summary: "Rule requires review" }
    });
    expect(create.statusCode).toBe(201);
    const review = create.json();
    expect(review.status).toBe("OPEN");

    const resolved = await server!.inject({
      method: "POST",
      url: `/api/review-items/${review.id}/resolve`,
      payload: { expectedRevision: review.revision, resolutionType: "APPROVED", resolutionReason: "Evidence checked" }
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().status).toBe("RESOLVED");
    expect(resolved.json().resolutionReason).toBe("Evidence checked");
  });
});
