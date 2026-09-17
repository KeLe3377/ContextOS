import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ContextOsError } from "../../../packages/shared/src/errors.js";

export type RuntimeLock = {
  release(): void;
};

export function acquireRuntimeLock(dataDir: string): RuntimeLock {
  const lockDir = join(dataDir, ".daemon.lock");
  let lockCreated = false;
  try {
    mkdirSync(dataDir, { recursive: true });
    createLockDirectory(lockDir);
    lockCreated = true;
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  } catch (error) {
    if (lockCreated) rmSync(lockDir, { recursive: true, force: true });
    if (error instanceof ContextOsError) throw error;
    throw new ContextOsError("CONFLICT", "ContextOS data directory is already in use", {
      reason: error instanceof Error ? error.message : "lock unavailable"
    });
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      rmSync(lockDir, { recursive: true, force: true });
    }
  };
}

function createLockDirectory(lockDir: string): void {
  try {
    mkdirSync(lockDir);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    const owner = readLockOwner(lockDir);
    if (owner && isProcessRunning(owner.pid)) {
      throw new ContextOsError("CONFLICT", "ContextOS data directory is already in use", {
        pid: owner.pid,
        createdAt: owner.createdAt
      });
    }
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir);
  }
}

function readLockOwner(lockDir: string): { pid: number; createdAt?: string } | null {
  try {
    const value = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8")) as { pid?: unknown; createdAt?: unknown };
    return typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0
      ? { pid: value.pid, createdAt: typeof value.createdAt === "string" ? value.createdAt : undefined }
      : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
