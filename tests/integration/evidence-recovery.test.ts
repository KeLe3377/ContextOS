import { access, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";

let server: FastifyInstance | undefined;
let tempDir: string | undefined;

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

describe("evidence startup recovery", () => {
  test("reconciles temporary, orphaned, missing, and mismatched Evidence files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "contextos-evidence-recovery-"));
    const config = {
      host: "127.0.0.1",
      port: 0,
      dataDir: tempDir,
      databaseFile: join(tempDir, "contextos.sqlite")
    };
    server = await createDaemonServer({ config });

    const projectResponse = await server.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Evidence recovery", rootPath: tempDir }
    });
    const project = projectResponse.json();
    const missing = await createEvidence(project.id, "Missing", "missing content");
    const mismatched = await createEvidence(project.id, "Mismatched", "original content");

    await server.close();
    server = undefined;
    await unlink(join(tempDir, missing.storageRef));
    await writeFile(join(tempDir, mismatched.storageRef), "tampered content", "utf8");

    const orphanPath = join(tempDir, "evidence", project.id, "orphan.txt");
    const temporaryPath = join(tempDir, "evidence", project.id, "interrupted.txt.123.456.tmp");
    await mkdir(dirname(orphanPath), { recursive: true });
    await writeFile(orphanPath, "orphan content", "utf8");
    await writeFile(temporaryPath, "partial content", "utf8");

    server = await createDaemonServer({ config });
    const health = await server.inject({ method: "GET", url: "/api/health" });
    expect(health.json().recovery.evidence).toEqual({
      temporaryFilesRemoved: 1,
      orphanFilesQuarantined: 1,
      snapshotsChecked: 2,
      missingFilesDetected: 1,
      mismatchedFilesDetected: 1
    });

    await expect(access(temporaryPath)).rejects.toThrow();
    await expect(access(orphanPath)).rejects.toThrow();
    await expect(access(join(tempDir, "recovery", "evidence-orphans", project.id, "orphan.txt"))).resolves.toBeUndefined();

    const reviews = await server.inject({ method: "GET", url: `/api/review-items?projectId=${project.id}` });
    expect(reviews.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: missing.id, triggerType: "EVIDENCE_FILE_MISSING", status: "OPEN" }),
      expect.objectContaining({ sourceId: mismatched.id, triggerType: "EVIDENCE_CONTENT_MISMATCH", status: "OPEN" })
    ]));

    await server.close();
    server = await createDaemonServer({ config });
    const secondHealth = await server.inject({ method: "GET", url: "/api/health" });
    expect(secondHealth.json().recovery.evidence).toMatchObject({
      temporaryFilesRemoved: 0,
      orphanFilesQuarantined: 0,
      snapshotsChecked: 2,
      missingFilesDetected: 1,
      mismatchedFilesDetected: 1
    });
    const secondReviews = await server.inject({ method: "GET", url: `/api/review-items?projectId=${project.id}` });
    expect(secondReviews.json().items).toHaveLength(2);
  });
});

async function createEvidence(projectId: string, title: string, contentText: string): Promise<{ id: string; storageRef: string }> {
  const response = await server!.inject({
    method: "POST",
    url: "/api/evidence-snapshots",
    payload: { projectId, evidenceType: "TEXT", title, contentText }
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}
