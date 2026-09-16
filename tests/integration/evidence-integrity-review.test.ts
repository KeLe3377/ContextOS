import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";

let server: FastifyInstance | undefined;
let tempDir: string | undefined;
let projectId: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-evidence-review-"));
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
    payload: { name: "Evidence review", rootPath: "D:/project/ContextOS" }
  });
  projectId = projectResponse.json().id;
});

afterEach(async () => {
  if (server) await server.close();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  server = undefined;
  tempDir = undefined;
});

describe("evidence integrity review", () => {
  test("creates one active missing-file review and creates a new item after resolution", async () => {
    const snapshot = await createStoredSnapshot("missing evidence", "content to remove");
    const healthy = await verify(snapshot.id);
    expect(healthy).toMatchObject({ verified: true, failureCode: null, reviewItem: null });

    await rm(join(tempDir!, snapshot.storageRef), { force: true });
    const firstFailure = await verify(snapshot.id);
    expect(firstFailure).toMatchObject({
      verified: false,
      failureCode: "FILE_MISSING",
      reviewItem: {
        projectId,
        sourceType: "EVIDENCE_SNAPSHOT",
        sourceId: snapshot.id,
        triggerType: "EVIDENCE_FILE_MISSING",
        status: "OPEN",
        priority: "HIGH"
      }
    });

    const repeated = await verify(snapshot.id);
    expect(repeated.reviewItem.id).toBe(firstFailure.reviewItem.id);
    expectDatabaseCounts(snapshot.id, "EVIDENCE_FILE_MISSING", 1);

    const resolved = await server!.inject({
      method: "POST",
      url: `/api/review-items/${firstFailure.reviewItem.id}/resolve`,
      payload: {
        resolutionType: "RECAPTURE_REQUIRED",
        resolutionReason: "Original file cannot be restored.",
        expectedRevision: firstFailure.reviewItem.revision
      }
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().status).toBe("RESOLVED");

    const recurrence = await verify(snapshot.id);
    expect(recurrence.reviewItem.id).not.toBe(firstFailure.reviewItem.id);
    expect(recurrence.reviewItem.status).toBe("OPEN");
    expectDatabaseCounts(snapshot.id, "EVIDENCE_FILE_MISSING", 2);
  });

  test("creates an urgent mismatch review but ignores snapshots without storage refs", async () => {
    const snapshot = await createStoredSnapshot("mismatched evidence", "trusted content");
    await writeFile(join(tempDir!, snapshot.storageRef), "tampered content", "utf8");
    const mismatch = await verify(snapshot.id);
    expect(mismatch).toMatchObject({
      verified: false,
      failureCode: "CONTENT_MISMATCH",
      reviewItem: {
        triggerType: "EVIDENCE_CONTENT_MISMATCH",
        priority: "URGENT",
        sourceId: snapshot.id
      }
    });

    const metadataOnlyResponse = await server!.inject({
      method: "POST",
      url: "/api/evidence-snapshots",
      payload: {
        projectId,
        evidenceType: "URL",
        title: "Remote evidence",
        uri: "https://example.com/evidence",
        contentHash: "sha256:external"
      }
    });
    expect(metadataOnlyResponse.statusCode).toBe(201);
    const noStorage = await verify(metadataOnlyResponse.json().id);
    expect(noStorage).toMatchObject({
      verified: false,
      failureCode: "NO_STORAGE_REF",
      reviewItem: null
    });
  });
});

async function createStoredSnapshot(title: string, contentText: string): Promise<{ id: string; storageRef: string }> {
  const response = await server!.inject({
    method: "POST",
    url: "/api/evidence-snapshots",
    payload: { projectId, evidenceType: "TEXT", title, contentText }
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function verify(snapshotId: string): Promise<Record<string, any>> {
  const response = await server!.inject({
    method: "POST",
    url: `/api/evidence-snapshots/${snapshotId}/verify`,
    payload: {}
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

function expectDatabaseCounts(snapshotId: string, triggerType: string, expected: number): void {
  const db = new Database(join(tempDir!, "contextos.sqlite"), { readonly: true });
  try {
    const reviews = db.prepare("SELECT COUNT(*) AS count FROM review_items WHERE source_type = 'EVIDENCE_SNAPSHOT' AND source_id = ? AND trigger_type = ?")
      .get(snapshotId, triggerType) as { count: number };
    const activities = db.prepare("SELECT COUNT(*) AS count FROM activity_events WHERE resource_type = 'EVIDENCE_SNAPSHOT' AND resource_id = ? AND event_type = ?")
      .get(snapshotId, triggerType) as { count: number };
    const audits = db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE resource_type = 'REVIEW_ITEM' AND action = 'CREATE' AND json_extract(after_json, '$.sourceId') = ? AND json_extract(after_json, '$.triggerType') = ?")
      .get(snapshotId, triggerType) as { count: number };
    expect(reviews.count).toBe(expected);
    expect(activities.count).toBe(expected);
    expect(audits.count).toBe(expected);
  } finally {
    db.close();
  }
}
