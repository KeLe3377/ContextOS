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
  tempDir = await mkdtemp(join(tmpdir(), "contextos-rules-"));
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
    payload: { name: "Rules", rootPath: "D:/project/ContextOS" }
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

describe("rules API", () => {
  test("validates and activates a versioned rule", async () => {
    const create = await server!.inject({
      method: "POST",
      url: "/api/rules",
      payload: {
        projectId,
        title: "Read-only original transcripts",
        description: "Autonomous agents cannot modify raw evidence.",
        scope: { resourceTypes: ["evidence_snapshot"] },
        conditions: [{ field: "sourceType", operator: "exists" }],
        effect: { action: "BLOCK", reason: "Evidence snapshots are immutable" },
        enforcementMode: "BLOCK",
        precedence: 10
      }
    });
    expect(create.statusCode).toBe(201);
    const rule = create.json();
    expect(rule.status).toBe("DRAFT");

    const blockedActivation = await server!.inject({
      method: "POST",
      url: `/api/rules/${rule.id}/activate`,
      payload: { expectedRevision: rule.revision }
    });
    expect(blockedActivation.statusCode).toBe(400);

    const validation = await server!.inject({ method: "POST", url: `/api/rules/${rule.id}/validate` });
    expect(validation.statusCode).toBe(200);
    expect(validation.json().valid).toBe(true);
    expect(validation.json().version.validationState).toBe("VALID");

    const activated = await server!.inject({
      method: "POST",
      url: `/api/rules/${rule.id}/activate`,
      payload: { expectedRevision: rule.revision }
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().status).toBe("ACTIVE");

    const versions = await server!.inject({ method: "GET", url: `/api/rules/${rule.id}/versions` });
    expect(versions.statusCode).toBe(200);
    expect(versions.json().items).toHaveLength(1);
  });
});
