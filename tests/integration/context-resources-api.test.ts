import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  test("captures evidence, verifies its file, and promotes it into an active context item", async () => {
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

    const contentText = "Evidence store comes before agent adapters.";
    const expectedHash = `sha256:${createHash("sha256").update(contentText).digest("hex")}`;
    const snapshotResponse = await server!.inject({
      method: "POST",
      url: "/api/evidence-snapshots",
      payload: {
        projectId,
        sourceId: source.id,
        evidenceType: "TEXT",
        title: "Backend plan excerpt",
        contentText
      }
    });
    expect(snapshotResponse.statusCode).toBe(201);
    const snapshot = snapshotResponse.json();
    expect(snapshot.sourceId).toBe(source.id);
    expect(snapshot.contentHash).toBe(expectedHash);
    expect(snapshot.storageRef).toMatch(new RegExp(`^evidence/${projectId}/`));
    expect(snapshot.sizeBytes).toBe(Buffer.byteLength(contentText, "utf8"));
    await expect(readFile(join(tempDir!, snapshot.storageRef), "utf8")).resolves.toBe(contentText);

    const verification = await server!.inject({ method: "POST", url: `/api/evidence-snapshots/${snapshot.id}/verify`, payload: {} });
    expect(verification.statusCode).toBe(200);
    expect(verification.json()).toMatchObject({
      storageRef: snapshot.storageRef,
      exists: true,
      verified: true,
      expectedHash,
      actualHash: expectedHash,
      expectedSizeBytes: Buffer.byteLength(contentText, "utf8"),
      actualSizeBytes: Buffer.byteLength(contentText, "utf8"),
      failureCode: null
    });

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

  test("rejects mismatched evidence content hashes", async () => {
    const snapshotResponse = await server!.inject({
      method: "POST",
      url: "/api/evidence-snapshots",
      payload: {
        projectId,
        evidenceType: "TEXT",
        title: "Bad hash",
        contentText: "This content has a real hash.",
        contentHash: "sha256:not-the-real-hash"
      }
    });
    expect(snapshotResponse.statusCode).toBe(400);
    expect(snapshotResponse.json().error.code).toBe("INVALID_ARGUMENT");
  });

  test("lists contiguous Context Item content versions with provenance", async () => {
    const createdResponse = await server!.inject({
      method: "POST",
      url: "/api/context-items",
      payload: {
        projectId,
        itemType: "CONSTRAINT",
        title: "Runtime boundary",
        summary: "Keep the daemon local.",
        confidence: "MEDIUM",
        metadata: { source: "design" }
      }
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json();

    const activatedResponse = await server!.inject({
      method: "POST",
      url: `/api/context-items/${created.id}/activate`,
      payload: { expectedRevision: created.revision }
    });
    expect(activatedResponse.statusCode).toBe(200);
    const activated = activatedResponse.json();

    const patchedResponse = await server!.inject({
      method: "PATCH",
      url: `/api/context-items/${created.id}`,
      payload: {
        summary: "Keep the daemon bound to loopback.",
        confidence: "HIGH",
        metadata: { source: "verified-design" },
        expectedRevision: activated.revision
      }
    });
    expect(patchedResponse.statusCode).toBe(200);

    const versionsResponse = await server!.inject({
      method: "GET",
      url: `/api/context-items/${created.id}/versions`
    });
    expect(versionsResponse.statusCode).toBe(200);
    expect(versionsResponse.json().items).toEqual([
      expect.objectContaining({
        contextItemId: created.id,
        versionNumber: 2,
        summary: "Keep the daemon bound to loopback.",
        confidence: "HIGH",
        metadata: { source: "verified-design" },
        createdByType: "USER",
        createdById: null
      }),
      expect.objectContaining({
        contextItemId: created.id,
        versionNumber: 1,
        summary: "Keep the daemon local.",
        confidence: "MEDIUM",
        metadata: { source: "design" },
        createdByType: "USER",
        createdById: null
      })
    ]);
  });
});
