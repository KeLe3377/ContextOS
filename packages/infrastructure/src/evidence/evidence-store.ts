import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ContextOsError } from "../../../shared/src/errors.js";

export type StoredEvidence = {
  storageRef: string;
  sizeBytes: number;
  contentHash: string;
};

export type EvidenceVerification = {
  storageRef: string | null;
  exists: boolean;
  verified: boolean;
  expectedHash: string;
  actualHash: string | null;
  expectedSizeBytes: number | null;
  actualSizeBytes: number | null;
  failureCode: string | null;
  failureMessage: string | null;
};

export class FileEvidenceStore {
  constructor(private readonly rootDir: string) {}

  writeText(input: { snapshotId: string; contentText: string; contentHash?: string }): StoredEvidence {
    const bytes = Buffer.from(input.contentText, "utf8");
    const contentHash = hashBytes(bytes);
    if (input.contentHash && input.contentHash !== contentHash) {
      throw new ContextOsError("INVALID_ARGUMENT", "Evidence contentHash does not match contentText", {
        expected: input.contentHash,
        actual: contentHash
      });
    }

    const storageRef = `evidence/${input.snapshotId}.txt`;
    const finalPath = join(this.rootDir, storageRef);
    const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    mkdirSync(dirname(finalPath), { recursive: true });

    try {
      writeFileSync(tempPath, bytes, { flag: "wx" });
      fsyncFile(tempPath);
      renameSync(tempPath, finalPath);
      fsyncDirectory(dirname(finalPath));
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }

    return { storageRef, sizeBytes: bytes.byteLength, contentHash };
  }

  verify(input: { storageRef: string | null; expectedHash: string; expectedSizeBytes: number | null }): EvidenceVerification {
    if (!input.storageRef) {
      return {
        storageRef: null,
        exists: false,
        verified: false,
        expectedHash: input.expectedHash,
        actualHash: null,
        expectedSizeBytes: input.expectedSizeBytes,
        actualSizeBytes: null,
        failureCode: "NO_STORAGE_REF",
        failureMessage: "Evidence snapshot has no file storage reference"
      };
    }

    try {
      const bytes = readFileSync(join(this.rootDir, input.storageRef));
      const actualHash = hashBytes(bytes);
      const actualSizeBytes = bytes.byteLength;
      const hashMatches = actualHash === input.expectedHash;
      const sizeMatches = input.expectedSizeBytes === null || actualSizeBytes === input.expectedSizeBytes;
      return {
        storageRef: input.storageRef,
        exists: true,
        verified: hashMatches && sizeMatches,
        expectedHash: input.expectedHash,
        actualHash,
        expectedSizeBytes: input.expectedSizeBytes,
        actualSizeBytes,
        failureCode: hashMatches && sizeMatches ? null : "CONTENT_MISMATCH",
        failureMessage: hashMatches && sizeMatches ? null : "Evidence file hash or size does not match metadata"
      };
    } catch (error) {
      return {
        storageRef: input.storageRef,
        exists: false,
        verified: false,
        expectedHash: input.expectedHash,
        actualHash: null,
        expectedSizeBytes: input.expectedSizeBytes,
        actualSizeBytes: null,
        failureCode: "FILE_MISSING",
        failureMessage: error instanceof Error ? error.message : "Evidence file is missing"
      };
    }
  }
}

function hashBytes(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fsyncFile(path: string): void {
  try {
    const fd = openSync(path, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function fsyncDirectory(path: string): void {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is not uniformly supported on every Windows filesystem.
  }
}

