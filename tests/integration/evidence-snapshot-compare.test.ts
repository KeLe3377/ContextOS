import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";

let server: FastifyInstance | undefined;
let tempDir: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-evidence-compare-"));
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
  if (server) await server.close();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  server = undefined;
  tempDir = undefined;
});

describe("Evidence Snapshot compare", () => {
  test("returns deterministic metadata differences without returning content", async () => {
    const projectId = await createProject("Compare");
    const first = await createSnapshot(projectId, { title: "First", evidenceType: "TEXT", contentText: "same content" });

    const identical = await compare(first.id, first.id);
    expect(identical).toEqual({
      baseSnapshotId: first.id,
      otherSnapshotId: first.id,
      projectId,
      identical: true,
      changedFields: [],
      fields: {
        contentHash: { base: first.contentHash, other: first.contentHash, same: true },
        sizeBytes: { base: first.sizeBytes, other: first.sizeBytes, same: true },
        evidenceType: { base: "TEXT", other: "TEXT", same: true },
        sourceId: { base: null, other: null, same: true }
      }
    });
    expect(JSON.stringify(identical)).not.toContain("same content");

    const changed = await createSnapshot(projectId, { title: "Changed", evidenceType: "FILE", contentText: "different and longer content" });
    const comparison = await compare(first.id, changed.id);
    expect(comparison.identical).toBe(false);
    expect(comparison.changedFields).toEqual(["contentHash", "sizeBytes", "evidenceType"]);
    expect(comparison.fields).toMatchObject({
      contentHash: { same: false },
      sizeBytes: { same: false },
      evidenceType: { base: "TEXT", other: "FILE", same: false },
      sourceId: { same: true }
    });
  });

  test("rejects cross-project comparisons", async () => {
    const firstProjectId = await createProject("First project");
    const secondProjectId = await createProject("Second project");
    const first = await createSnapshot(firstProjectId, { title: "First", evidenceType: "TEXT", contentText: "one" });
    const second = await createSnapshot(secondProjectId, { title: "Second", evidenceType: "TEXT", contentText: "two" });

    const response = await server!.inject({
      method: "POST",
      url: `/api/evidence-snapshots/${first.id}/compare`,
      payload: { otherSnapshotId: second.id }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: "CONFLICT",
      message: "Evidence Snapshots must belong to the same project"
    });
  });
});

async function createProject(name: string): Promise<string> {
  const response = await server!.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name, rootPath: "D:/project/ContextOS" }
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().id;
}

async function createSnapshot(projectId: string, input: { title: string; evidenceType: "TEXT" | "FILE"; contentText: string }): Promise<Record<string, any>> {
  const response = await server!.inject({
    method: "POST",
    url: "/api/evidence-snapshots",
    payload: { projectId, ...input }
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json();
}

async function compare(baseSnapshotId: string, otherSnapshotId: string): Promise<Record<string, any>> {
  const response = await server!.inject({
    method: "POST",
    url: `/api/evidence-snapshots/${baseSnapshotId}/compare`,
    payload: { otherSnapshotId }
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}
