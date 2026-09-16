import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";

let server: FastifyInstance | undefined;
let tempDir: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-projects-"));
  server = await createDaemonServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      dataDir: tempDir,
      databaseFile: join(tempDir, "contextos.sqlite")
    }
  });
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

describe("Project API", () => {
  test("creates, lists, reads, and archives projects with revision checks", async () => {
    const createResponse = await server!.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "ContextOS",
        description: "Local Agent workspace",
        rootPath: "D:/project/ContextOS",
        defaultRuleIds: [],
        agentAdapterIds: ["codex"]
      }
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    expect(created.id).toMatch(/^proj_/);
    expect(created.status).toBe("ACTIVE");
    expect(created.revision).toBe(1);

    const listResponse = await server!.inject({ method: "GET", url: "/api/projects" });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().items).toHaveLength(1);

    const detailResponse = await server!.inject({ method: "GET", url: `/api/projects/${created.id}` });
    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json().name).toBe("ContextOS");

    const archiveResponse = await server!.inject({
      method: "POST",
      url: `/api/projects/${created.id}/archive`,
      payload: { expectedRevision: created.revision }
    });
    expect(archiveResponse.statusCode).toBe(200);
    const archived = archiveResponse.json();
    expect(archived.status).toBe("ARCHIVED");
    expect(archived.revision).toBe(2);
    expect(archived.archivedAt).toBeTruthy();

    const conflictResponse = await server!.inject({
      method: "POST",
      url: `/api/projects/${created.id}/archive`,
      payload: { expectedRevision: created.revision }
    });
    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.json().error.code).toBe("CONFLICT");

    const db = new Database(join(tempDir!, "contextos.sqlite"), { readonly: true });
    try {
      const activity = db.prepare("SELECT event_type FROM activity_events WHERE resource_id = ? ORDER BY created_at, id").all(created.id);
      const audit = db.prepare("SELECT action FROM audit_events WHERE resource_id = ? ORDER BY created_at, id").all(created.id);
      expect(activity).toEqual([{ event_type: "PROJECT_CREATED" }, { event_type: "PROJECT_ARCHIVED" }]);
      expect(audit).toEqual([{ action: "CREATE" }, { action: "STATUS_ARCHIVED" }]);
    } finally {
      db.close();
    }
  });

  test("returns stable not found errors", async () => {
    const response = await server!.inject({ method: "GET", url: "/api/projects/proj_missing" });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({
      code: "NOT_FOUND",
      message: "Project not found"
    });
  });
});

