import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";

let server: FastifyInstance | undefined;
let tempDir: string | undefined;
let projectId: string;
let projectRoot: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-context-"));
  projectRoot = join(tempDir, "project");
  await mkdir(projectRoot);
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
    payload: { name: "Context", rootPath: projectRoot }
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

  test("syncs local files, reuses unchanged evidence, and captures changed content", async () => {
    const relativePath = join("docs", "source.md");
    await mkdir(join(projectRoot, "docs"));
    await writeFile(join(projectRoot, relativePath), "first version", "utf8");
    const sourceResponse = await server!.inject({
      method: "POST",
      url: "/api/context-sources",
      payload: { projectId, sourceType: "FILE", name: "Local source", locator: relativePath }
    });
    const source = sourceResponse.json();

    const firstResponse = await server!.inject({
      method: "POST",
      url: `/api/context-sources/${source.id}/sync`,
      payload: { expectedRevision: source.revision }
    });
    expect(firstResponse.statusCode).toBe(200);
    const first = firstResponse.json();
    expect(first.reused).toBe(false);
    expect(first.source).toMatchObject({ lastSnapshotId: first.snapshot.id, revision: source.revision + 1 });
    expect(first.source.lastCheckedAt).not.toBeNull();
    expect(first.snapshot).toMatchObject({
      projectId,
      sourceId: source.id,
      evidenceType: "FILE",
      title: "Local source",
      uri: relativePath,
      sizeBytes: Buffer.byteLength("first version")
    });

    const verification = await server!.inject({ method: "POST", url: `/api/evidence-snapshots/${first.snapshot.id}/verify`, payload: {} });
    expect(verification.json()).toMatchObject({ verified: true, failureCode: null });

    const repeatedResponse = await server!.inject({
      method: "POST",
      url: `/api/context-sources/${source.id}/sync`,
      payload: { expectedRevision: first.source.revision }
    });
    expect(repeatedResponse.statusCode).toBe(200);
    const repeated = repeatedResponse.json();
    expect(repeated.reused).toBe(true);
    expect(repeated.snapshot.id).toBe(first.snapshot.id);

    await writeFile(join(projectRoot, relativePath), "second version", "utf8");
    const changedResponse = await server!.inject({
      method: "POST",
      url: `/api/context-sources/${source.id}/sync`,
      payload: { expectedRevision: repeated.source.revision }
    });
    expect(changedResponse.statusCode).toBe(200);
    const changed = changedResponse.json();
    expect(changed.reused).toBe(false);
    expect(changed.snapshot.id).not.toBe(first.snapshot.id);
    expect(changed.source.lastSnapshotId).toBe(changed.snapshot.id);

    await writeFile(join(projectRoot, relativePath), "third version", "utf8");
    const staleResponse = await server!.inject({
      method: "POST",
      url: `/api/context-sources/${source.id}/sync`,
      payload: { expectedRevision: repeated.source.revision }
    });
    expect(staleResponse.statusCode).toBe(409);
    expect(staleResponse.json().error.code).toBe("CONFLICT");
    await expect(readdir(join(tempDir!, "evidence", projectId))).resolves.toHaveLength(2);
  });

  test("rejects unsupported or inactive Context Sources", async () => {
    const urlSourceResponse = await server!.inject({
      method: "POST",
      url: "/api/context-sources",
      payload: { projectId, sourceType: "URL", name: "Remote", locator: "https://example.com" }
    });
    const urlSource = urlSourceResponse.json();
    const unsupported = await server!.inject({
      method: "POST",
      url: `/api/context-sources/${urlSource.id}/sync`,
      payload: { expectedRevision: urlSource.revision }
    });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json().error.code).toBe("INVALID_ARGUMENT");

    const fileSourceResponse = await server!.inject({
      method: "POST",
      url: "/api/context-sources",
      payload: { projectId, sourceType: "FILE", name: "Paused", locator: "paused.md" }
    });
    const fileSource = fileSourceResponse.json();
    const pausedResponse = await server!.inject({
      method: "POST",
      url: `/api/context-sources/${fileSource.id}/pause`,
      payload: { expectedRevision: fileSource.revision }
    });
    const paused = pausedResponse.json();
    const inactive = await server!.inject({
      method: "POST",
      url: `/api/context-sources/${fileSource.id}/sync`,
      payload: { expectedRevision: paused.revision }
    });
    expect(inactive.statusCode).toBe(409);
    expect(inactive.json().error.code).toBe("CONFLICT");

    const archivedResponse = await server!.inject({
      method: "POST",
      url: `/api/context-sources/${fileSource.id}/archive`,
      payload: { expectedRevision: paused.revision }
    });
    const archived = archivedResponse.json();
    const archivedSync = await server!.inject({
      method: "POST",
      url: `/api/context-sources/${fileSource.id}/sync`,
      payload: { expectedRevision: archived.revision }
    });
    expect(archivedSync.statusCode).toBe(409);
    expect(archivedSync.json().error.code).toBe("CONFLICT");
  });

  test("rejects missing files and locators outside the Project root", async () => {
    const missingResponse = await server!.inject({
      method: "POST",
      url: "/api/context-sources",
      payload: { projectId, sourceType: "FILE", name: "Missing", locator: "missing.md" }
    });
    const missing = missingResponse.json();
    const missingSync = await server!.inject({
      method: "POST",
      url: `/api/context-sources/${missing.id}/sync`,
      payload: { expectedRevision: missing.revision }
    });
    expect(missingSync.statusCode).toBe(400);
    expect(missingSync.json().error.code).toBe("INVALID_ARGUMENT");

    const traversalResponse = await server!.inject({
      method: "POST",
      url: "/api/context-sources",
      payload: { projectId, sourceType: "FILE", name: "Traversal", locator: join("..", "outside.md") }
    });
    const traversal = traversalResponse.json();
    const traversalSync = await server!.inject({
      method: "POST",
      url: `/api/context-sources/${traversal.id}/sync`,
      payload: { expectedRevision: traversal.revision }
    });
    expect(traversalSync.statusCode).toBe(400);
    expect(traversalSync.json().error.code).toBe("INVALID_ARGUMENT");
  });

  test("rejects a directory link that escapes the Project root", async () => {
    const outsideDir = join(tempDir!, "outside");
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, "secret.md"), "outside", "utf8");
    await symlink(outsideDir, join(projectRoot, "linked"), "junction");

    const sourceResponse = await server!.inject({
      method: "POST",
      url: "/api/context-sources",
      payload: { projectId, sourceType: "FILE", name: "Linked", locator: join("linked", "secret.md") }
    });
    const source = sourceResponse.json();
    const response = await server!.inject({
      method: "POST",
      url: `/api/context-sources/${source.id}/sync`,
      payload: { expectedRevision: source.revision }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_ARGUMENT");
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
