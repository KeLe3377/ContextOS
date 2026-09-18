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

  test("lists and versions draft decision content edits", async () => {
    const create = await server!.inject({
      method: "POST",
      url: "/api/decisions",
      payload: { projectId, title: "Versioned decision", statement: "Use A", rationale: "Fast", alternatives: ["Use B"] }
    });
    expect(create.statusCode).toBe(201);
    const decision = create.json();

    const initialVersions = await server!.inject({ method: "GET", url: `/api/decisions/${decision.id}/versions` });
    expect(initialVersions.statusCode).toBe(200);
    expect(initialVersions.json().items).toEqual([
      expect.objectContaining({ versionNumber: 1, statement: "Use A", rationale: "Fast", alternatives: ["Use B"] })
    ]);

    const patched = await server!.inject({
      method: "PATCH",
      url: `/api/decisions/${decision.id}`,
      payload: { title: "Versioned decision updated", statement: "Use C", rationale: "Safer", references: ["evidence_1"], expectedRevision: decision.revision }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ title: "Versioned decision updated" });
    expect(patched.json().currentVersionId).not.toBe(decision.currentVersionId);

    const versions = await server!.inject({ method: "GET", url: `/api/decisions/${decision.id}/versions` });
    expect(versions.json().items).toEqual([
      expect.objectContaining({ versionNumber: 2, statement: "Use C", rationale: "Safer", alternatives: ["Use B"], references: ["evidence_1"] }),
      expect.objectContaining({ versionNumber: 1, statement: "Use A" })
    ]);
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

  test("patches work item definition fields and dependencies", async () => {
    const dependency = (await server!.inject({
      method: "POST",
      url: "/api/work-items",
      payload: { projectId, title: "Dependency", acceptance: ["done"] }
    })).json();
    const item = (await server!.inject({
      method: "POST",
      url: "/api/work-items",
      payload: { projectId, title: "Original", acceptance: [] }
    })).json();

    const patched = await server!.inject({
      method: "PATCH",
      url: `/api/work-items/${item.id}`,
      payload: {
        title: "Updated",
        description: "Runnable by an agent",
        acceptance: ["passes tests", "updates docs"],
        executionContract: "Run build and tests",
        dependencyIds: [dependency.id],
        expectedRevision: item.revision
      }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ title: "Updated", description: "Runnable by an agent", acceptance: ["passes tests", "updates docs"], executionContract: "Run build and tests" });

    const dependencies = await server!.inject({ method: "GET", url: `/api/work-items/${item.id}/dependencies` });
    expect(dependencies.json().items).toEqual([expect.objectContaining({ dependsOnId: dependency.id })]);
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

  test("records review start and assignment in action history", async () => {
    const create = await server!.inject({
      method: "POST",
      url: "/api/review-items",
      payload: { projectId, sourceType: "RULE", sourceId: "rule_3", triggerType: "REQUIRE_REVIEW", summary: "Track review actions" }
    });
    const review = create.json();

    const assigned = await server!.inject({
      method: "POST",
      url: `/api/review-items/${review.id}/assign`,
      payload: { expectedRevision: review.revision, reviewerId: "local-user" }
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().reviewerId).toBe("local-user");

    const started = await server!.inject({
      method: "POST",
      url: `/api/review-items/${review.id}/start`,
      payload: { expectedRevision: assigned.json().revision }
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().status).toBe("IN_PROGRESS");

    const log = await server!.inject({ method: "GET", url: `/api/review-items/${review.id}/action-log` });
    expect(log.statusCode).toBe(200);
    expect(log.json().items).toEqual([
      expect.objectContaining({ action: "ASSIGN" }),
      expect.objectContaining({ action: "START" })
    ]);
  });

  test("returns workspace overview with next work, reviews, and context health", async () => {
    const work = await server!.inject({
      method: "POST",
      url: "/api/work-items",
      payload: { projectId, title: "Next implementation slice", acceptance: ["build passes"] }
    });
    const ready = await server!.inject({
      method: "POST",
      url: `/api/work-items/${work.json().id}/mark-ready`,
      payload: { expectedRevision: work.json().revision }
    });
    expect(ready.statusCode).toBe(200);
    await server!.inject({
      method: "POST",
      url: "/api/review-items",
      payload: { projectId, sourceType: "RULE", sourceId: "rule_overview", triggerType: "REQUIRE_REVIEW", summary: "Review overview work" }
    });
    await server!.inject({
      method: "POST",
      url: "/api/context-items",
      payload: { projectId, itemType: "FACT", title: "Active context", summary: "Context available", confidence: "HIGH" }
    });

    const overview = await server!.inject({ method: "GET", url: "/api/workspace/overview" });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      project: { id: projectId },
      kpis: { pendingReviews: 1, readyWorkItems: 1 },
      contextHealth: { activeContextItems: 0 }
    });
    expect(overview.json().nextWorkItems).toEqual([expect.objectContaining({ title: "Next implementation slice", status: "READY" })]);
    expect(overview.json().pendingReviews).toEqual([expect.objectContaining({ title: "Review overview work", status: "OPEN" })]);
  });
});



