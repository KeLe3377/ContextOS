import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
    mkdirSync(lockDir);
    lockCreated = true;
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  } catch (error) {
    if (lockCreated) rmSync(lockDir, { recursive: true, force: true });
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
