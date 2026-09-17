import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";
import { CodexAdapter } from "../../packages/infrastructure/src/adapters/codex-adapter.js";

let server: FastifyInstance | undefined;
let tempDir: string | undefined;
let projectId: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-core-"));
  server = await createDaemonServer({
    agentAdapter: new CodexAdapter(process.execPath, ["-e", ""], process.platform, join(tempDir, "codex-sessions")),
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

    const db = new Database(join(tempDir!, "contextos.sqlite"), { readonly: true });
    try {
      const activity = db.prepare("SELECT event_type FROM activity_events WHERE resource_id = ? ORDER BY created_at, id").all(session.id);
      const audit = db.prepare("SELECT action FROM audit_events WHERE resource_id = ? ORDER BY created_at, id").all(session.id);
      expect(activity).toEqual(expect.arrayContaining([{ event_type: "SESSION_CREATED" }, { event_type: "SESSION_RUNNING" }]));
      expect(audit).toEqual(expect.arrayContaining([{ action: "CREATE" }, { action: "STATUS_RUNNING" }]));
    } finally {
      db.close();
    }
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

    const started = await server!.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/start`,
      payload: { expectedRevision: ready.json().revision }
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().status).toBe("IN_PROGRESS");

    const done = await server!.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/complete`,
      payload: { expectedRevision: started.json().revision }
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

  test("enforces project and session lifecycle boundaries", async () => {
    const sessionResponse = await server!.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, agentAdapterId: "codex", title: "Archive me" }
    });
    const session = sessionResponse.json();
    const archivedSession = await server!.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/archive`,
      payload: { expectedRevision: session.revision }
    });
    expect(archivedSession.statusCode).toBe(200);

    const continued = await server!.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: archivedSession.json().revision }
    });
    expect(continued.statusCode).toBe(409);

    const project = await server!.inject({ method: "GET", url: `/api/projects/${projectId}` });
    const archivedProject = await server!.inject({
      method: "POST",
      url: `/api/projects/${projectId}/archive`,
      payload: { expectedRevision: project.json().revision }
    });
    expect(archivedProject.statusCode).toBe(200);

    const createUnderArchived = await server!.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, agentAdapterId: "codex", title: "Rejected" }
    });
    expect(createUnderArchived.statusCode).toBe(409);
  });

  test("rejects patches to accepted decisions", async () => {
    const create = await server!.inject({
      method: "POST",
      url: "/api/decisions",
      payload: { projectId, title: "Immutable", statement: "Keep history", rationale: "Governance" }
    });
    const decision = create.json();
    const accepted = await server!.inject({
      method: "POST",
      url: `/api/decisions/${decision.id}/accept`,
      payload: { expectedRevision: decision.revision }
    });
    const patched = await server!.inject({
      method: "PATCH",
      url: `/api/decisions/${decision.id}`,
      payload: { title: "Silent rewrite", expectedRevision: accepted.json().revision }
    });
    expect(patched.statusCode).toBe(409);
    expect(patched.json().error.code).toBe("CONFLICT");
  });

  test("prevents dependency cycles and exposes readiness blockers", async () => {
    const createItem = async (title: string) => (await server!.inject({
      method: "POST",
      url: "/api/work-items",
      payload: { projectId, title, acceptance: [] }
    })).json();
    const prerequisite = await createItem("Prerequisite");
    const dependent = await createItem("Dependent");

    const linked = await server!.inject({
      method: "PATCH",
      url: `/api/work-items/${dependent.id}`,
      payload: { dependencyIds: [prerequisite.id], expectedRevision: dependent.revision }
    });
    expect(linked.statusCode).toBe(200);

    const readiness = await server!.inject({ method: "GET", url: `/api/work-items/${dependent.id}/readiness` });
    expect(readiness.json()).toMatchObject({ ready: false, blockers: [{ dependsOnId: prerequisite.id, status: "BACKLOG" }] });

    const blockedReady = await server!.inject({
      method: "POST",
      url: `/api/work-items/${dependent.id}/mark-ready`,
      payload: { expectedRevision: linked.json().revision }
    });
    expect(blockedReady.statusCode).toBe(409);

    const cycle = await server!.inject({
      method: "PATCH",
      url: `/api/work-items/${prerequisite.id}`,
      payload: { dependencyIds: [dependent.id], expectedRevision: prerequisite.revision }
    });
    expect(cycle.statusCode).toBe(400);
    expect(cycle.json().error.code).toBe("INVALID_ARGUMENT");
  });

  test("requires a dismissal reason and records review action history", async () => {
    const create = await server!.inject({
      method: "POST",
      url: "/api/review-items",
      payload: { projectId, sourceType: "RULE", sourceId: "rule_2", triggerType: "REQUIRE_REVIEW", summary: "Dismiss with reason" }
    });
    const review = create.json();

    const missingReason = await server!.inject({
      method: "POST",
      url: `/api/review-items/${review.id}/dismiss`,
      payload: { expectedRevision: review.revision }
    });
    expect(missingReason.statusCode).toBe(400);

    const dismissed = await server!.inject({
      method: "POST",
      url: `/api/review-items/${review.id}/dismiss`,
      payload: { expectedRevision: review.revision, resolutionReason: "No longer applicable" }
    });
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json()).toMatchObject({ status: "DISMISSED", resolutionReason: "No longer applicable" });

    const log = await server!.inject({ method: "GET", url: `/api/review-items/${review.id}/action-log` });
    expect(log.statusCode).toBe(200);
    expect(log.json().items).toEqual([expect.objectContaining({ action: "DISMISS" })]);
  });
});



