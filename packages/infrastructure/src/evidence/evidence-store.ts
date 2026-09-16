import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

export type EvidenceFileRecovery = {
  temporaryFilesRemoved: number;
  orphanFilesQuarantined: number;
};

export class FileEvidenceStore {
  constructor(private readonly rootDir: string) {}

  writeText(input: { snapshotId: string; contentText: string; contentHash?: string; projectId?: string }): StoredEvidence {
    const bytes = Buffer.from(input.contentText, "utf8");
    const contentHash = hashBytes(bytes);
    if (input.contentHash && input.contentHash !== contentHash) {
      throw new ContextOsError("INVALID_ARGUMENT", "Evidence contentHash does not match contentText", {
        expected: input.contentHash,
        actual: contentHash
      });
    }

    const storageRef = input.projectId
      ? `evidence/${sanitizeSegment(input.projectId)}/${input.snapshotId}.txt`
      : `evidence/${input.snapshotId}.txt`;
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

    const target = evidencePath(this.rootDir, input.storageRef);
    if (!target) {
      return {
        storageRef: input.storageRef,
        exists: false,
        verified: false,
        expectedHash: input.expectedHash,
        actualHash: null,
        expectedSizeBytes: input.expectedSizeBytes,
        actualSizeBytes: null,
        failureCode: "INVALID_STORAGE_REF",
        failureMessage: "Evidence storage reference is outside the evidence root"
      };
    }

    try {
      const bytes = readFileSync(target);
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

  remove(storageRef: string): void {
    const evidenceRoot = resolve(this.rootDir, "evidence");
    const target = resolve(this.rootDir, storageRef);
    const relativeTarget = relative(evidenceRoot, target);
    if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
      throw new ContextOsError("INVALID_ARGUMENT", "Evidence storageRef is outside the evidence root");
    }
    rmSync(target, { force: true });
  }

  recover(referencedStorageRefs: Iterable<string>): EvidenceFileRecovery {
    const evidenceRoot = resolve(this.rootDir, "evidence");
    const referenced = new Set(Array.from(referencedStorageRefs, (value) => value.replaceAll("\\", "/")));
    let temporaryFilesRemoved = 0;
    let orphanFilesQuarantined = 0;

    for (const filePath of listFiles(evidenceRoot)) {
      const storageRef = relative(resolve(this.rootDir), filePath).split(sep).join("/");
      if (filePath.endsWith(".tmp")) {
        rmSync(filePath, { force: true });
        temporaryFilesRemoved += 1;
        continue;
      }
      if (referenced.has(storageRef)) continue;

      const orphanRelativePath = relative(evidenceRoot, filePath);
      const target = availableRecoveryPath(resolve(this.rootDir, "recovery", "evidence-orphans", orphanRelativePath));
      mkdirSync(dirname(target), { recursive: true });
      renameSync(filePath, target);
      orphanFilesQuarantined += 1;
    }

    return { temporaryFilesRemoved, orphanFilesQuarantined };
  }
}

function listFiles(root: string): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

function availableRecoveryPath(target: string): string {
  if (!existsSync(target)) return target;
  let sequence = 1;
  while (existsSync(`${target}.${sequence}`)) sequence += 1;
  return `${target}.${sequence}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function evidencePath(rootDir: string, storageRef: string): string | null {
  const evidenceRoot = resolve(rootDir, "evidence");
  const target = resolve(rootDir, storageRef);
  const relativeTarget = relative(evidenceRoot, target);
  if (!relativeTarget || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
    return null;
  }
  return target;
}

function hashBytes(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
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

