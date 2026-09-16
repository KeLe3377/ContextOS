import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

    const contentResponse = await server!.inject({
      method: "POST",
      url: `/api/evidence-snapshots/${first.id}/compare-content`,
      payload: { otherSnapshotId: second.id }
    });
    expect(contentResponse.statusCode).toBe(409);
    expect(contentResponse.json().error.code).toBe("CONFLICT");
  });

  test("compares verified text content with line positions and bounded output", async () => {
    const projectId = await createProject("Content compare");
    const first = await createSnapshot(projectId, { title: "First", evidenceType: "TEXT", contentText: "alpha\nbeta\ngamma\n" });
    const changed = await createSnapshot(projectId, { title: "Changed", evidenceType: "TEXT", contentText: "alpha\nBETA\ngamma\ndelta\n" });

    const identical = await compareContent(first.id, first.id);
    expect(identical).toMatchObject({ identical: true, addedLines: 0, removedLines: 0, changes: [], truncated: false });

    const comparison = await compareContent(first.id, changed.id);
    expect(comparison).toMatchObject({
      baseSnapshotId: first.id,
      otherSnapshotId: changed.id,
      projectId,
      identical: false,
      addedLines: 2,
      removedLines: 1,
      truncated: false
    });
    expect(comparison.changes).toEqual([
      expect.objectContaining({ kind: "REMOVED", baseStartLine: 2, otherStartLine: 2, lineCount: 1, text: "beta\n", truncated: false }),
      expect.objectContaining({ kind: "ADDED", baseStartLine: 3, otherStartLine: 2, lineCount: 1, text: "BETA\n", truncated: false }),
      expect.objectContaining({ kind: "ADDED", baseStartLine: 4, otherStartLine: 4, lineCount: 1, text: "delta\n", truncated: false })
    ]);

    const longChange = await createSnapshot(projectId, { title: "Long", evidenceType: "TEXT", contentText: `alpha\n${"x".repeat(200)}\n` });
    const truncated = await compareContent(first.id, longChange.id, 100);
    expect(truncated.truncated).toBe(true);
    expect(truncated.changes.reduce((length: number, change: { text: string }) => length + change.text.length, 0)).toBeLessThanOrEqual(100);
  });

  test("rejects content comparison when stored Evidence fails verification", async () => {
    const projectId = await createProject("Integrity compare");
    const first = await createSnapshot(projectId, { title: "First", evidenceType: "TEXT", contentText: "trusted" });
    const second = await createSnapshot(projectId, { title: "Second", evidenceType: "TEXT", contentText: "also trusted" });
    await writeFile(join(tempDir!, second.storageRef), "tampered", "utf8");

    const response = await server!.inject({
      method: "POST",
      url: `/api/evidence-snapshots/${first.id}/compare-content`,
      payload: { otherSnapshotId: second.id }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");

    const reviews = await server!.inject({ method: "GET", url: `/api/review-items?projectId=${projectId}` });
    expect(reviews.json().items).toEqual([
      expect.objectContaining({ sourceId: second.id, triggerType: "EVIDENCE_CONTENT_MISMATCH" })
    ]);
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

async function compareContent(baseSnapshotId: string, otherSnapshotId: string, maxChars?: number): Promise<Record<string, any>> {
  const response = await server!.inject({
    method: "POST",
    url: `/api/evidence-snapshots/${baseSnapshotId}/compare-content`,
    payload: { otherSnapshotId, ...(maxChars === undefined ? {} : { maxChars }) }
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
