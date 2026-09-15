import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type StoredEvidence = {
  storageRef: string;
  sizeBytes: number;
  contentHash: string;
};

export class FileEvidenceStore {
  constructor(private readonly rootDir: string) {}

  writeText(input: { snapshotId: string; contentText: string; contentHash?: string }): StoredEvidence {
    const bytes = Buffer.from(input.contentText, "utf8");
    const contentHash = input.contentHash ?? `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const storageRef = `evidence/${input.snapshotId}.txt`;
    const finalPath = join(this.rootDir, storageRef);
    const tempPath = `${finalPath}.tmp`;
    mkdirSync(dirname(finalPath), { recursive: true });

    try {
      writeFileSync(tempPath, bytes, { flag: "wx" });
      renameSync(tempPath, finalPath);
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }

    return { storageRef, sizeBytes: bytes.byteLength, contentHash };
  }
}
