import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileEvidenceStore } from "../../packages/infrastructure/src/evidence/evidence-store.js";

let tempDir: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-evidence-store-"));
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("FileEvidenceStore", () => {
  test("writes new evidence under a project partition", () => {
    if (!tempDir) throw new Error("missing tempDir");
    const store = new FileEvidenceStore(tempDir);
    const stored = store.writeText({ projectId: "proj_123", snapshotId: "ev_123", contentText: "partitioned evidence" });

    expect(stored.storageRef).toBe("evidence/proj_123/ev_123.txt");
    expect(store.verify({
      storageRef: stored.storageRef,
      expectedHash: stored.contentHash,
      expectedSizeBytes: stored.sizeBytes
    })).toMatchObject({
      exists: true,
      verified: true,
      failureCode: null
    });
  });

  test("still verifies legacy unpartitioned evidence references", async () => {
    if (!tempDir) throw new Error("missing tempDir");
    const content = "legacy evidence";
    const bytes = Buffer.from(content, "utf8");
    const expectedHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    await mkdir(join(tempDir, "evidence"), { recursive: true });
    await writeFile(join(tempDir, "evidence", "legacy.txt"), bytes);

    const store = new FileEvidenceStore(tempDir);
    expect(store.verify({
      storageRef: "evidence/legacy.txt",
      expectedHash,
      expectedSizeBytes: bytes.byteLength
    })).toMatchObject({
      exists: true,
      verified: true,
      failureCode: null
    });
  });

  test("refuses to verify storage references outside the evidence root", async () => {
    if (!tempDir) throw new Error("missing tempDir");
    const content = "not evidence";
    const expectedHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    await writeFile(join(tempDir, "outside.txt"), content, "utf8");

    const store = new FileEvidenceStore(tempDir);
    expect(store.verify({
      storageRef: "outside.txt",
      expectedHash,
      expectedSizeBytes: Buffer.byteLength(content)
    })).toMatchObject({
      exists: false,
      verified: false,
      actualHash: null,
      failureCode: "INVALID_STORAGE_REF"
    });
  });
});
