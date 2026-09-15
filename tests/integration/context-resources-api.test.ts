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
  tempDir = await mkdtemp(join(tmpdir(), "contextos-context-"));
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
    payload: { name: "Context", rootPath: "D:/project/ContextOS" }
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

describe("context resource APIs", () => {
  test("captures evidence and promotes it into an active context item", async () => {
    const sourceResponse = await server!.inject({
      method: "POST",
      url: "/api/context-sources",
      payload: {
        projectId,
        sourceType: "FILE",
        name: "Backend plan",
        locator: "docs/backend-plan.md",
        metadata: { owner: "local" }
      }
    });
    expect(sourceResponse.statusCode).toBe(201);
    const source = sourceResponse.json();
    expect(source.status).toBe("ACTIVE");

    const snapshotResponse = await server!.inject({
      method: "POST",
      url: "/api/evidence-snapshots",
      payload: {
        projectId,
        sourceId: source.id,
        evidenceType: "TEXT",
        title: "Backend plan excerpt",
        contentText: "Evidence store comes before agent adapters.",
        contentHash: "sha256:context-api-test"
      }
    });
    expect(snapshotResponse.statusCode).toBe(201);
    const snapshot = snapshotResponse.json();
    expect(snapshot.sourceId).toBe(source.id);

    const refreshedSource = await server!.inject({ method: "GET", url: `/api/context-sources/${source.id}` });
    expect(refreshedSource.json().lastSnapshotId).toBe(snapshot.id);

    const itemResponse = await server!.inject({
      method: "POST",
      url: "/api/context-items",
      payload: {
        projectId,
        sourceSnapshotId: snapshot.id,
        itemType: "SUMMARY",
        title: "Implementation order",
        summary: "Evidence store should be implemented before agent adapters.",
        confidence: "HIGH"
      }
    });
    expect(itemResponse.statusCode).toBe(201);
    const item = itemResponse.json();
    expect(item.status).toBe("DRAFT");

    const activated = await server!.inject({
      method: "POST",
      url: `/api/context-items/${item.id}/activate`,
      payload: { expectedRevision: item.revision }
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().status).toBe("ACTIVE");
  });
});
