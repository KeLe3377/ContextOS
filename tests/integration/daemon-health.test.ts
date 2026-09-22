import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";
import type { AutomationSetTimer } from "../../packages/application/src/core/automation-scheduler.js";
import { SqliteClient } from "../../packages/infrastructure/src/sqlite/client.js";
import { runMigrations } from "../../packages/infrastructure/src/sqlite/migrations.js";

let server: FastifyInstance | undefined;
let tempDir: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-health-"));
});

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

function testConfig() {
  if (!tempDir) throw new Error("missing tempDir");
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: tempDir,
    databaseFile: join(tempDir, "contextos.sqlite")
  };
}

/**
 * Keeps the daemon's automation loop dormant so these tests observe startup behaviour
 * instead of racing a real background tick.
 */
function createControllableTimer() {
  let cancelCount = 0;
  let delayMs: number | null = null;
  const setTimer: AutomationSetTimer = (_handler, delay) => {
    delayMs = delay;
    return () => {
      cancelCount += 1;
      delayMs = null;
    };
  };
  return {
    setTimer,
    get delayMs() {
      return delayMs;
    },
    get cancels() {
      return cancelCount;
    }
  };
}

describe("daemon health endpoint", () => {
  test("returns daemon status without leaking local paths", async () => {
    server = await createDaemonServer({ config: testConfig() });

    const response = await server.inject({
      method: "GET",
      url: "/api/health",
      headers: { "x-request-id": "test-request-1" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");

    const body = response.json();
    expect(body.version).toMatch(/\d+\.\d+\.\d+/);
    expect(body.schemaVersion).toBe(15);
    expect(body.processState).toBe("ready");
    expect(body.recovery).toEqual({
      orphanContinuesRecovered: 0,
      automationJobsRecovered: 0,
      evidence: {
        temporaryFilesRemoved: 0,
        orphanFilesQuarantined: 0,
        snapshotsChecked: 0,
        missingFilesDetected: 0,
        mismatchedFilesDetected: 0
      }
    });
    expect(body.requestId).toBe("test-request-1");
    expect(JSON.stringify(body)).not.toContain(tempDir);
    expect(JSON.stringify(body)).not.toContain("contextos.sqlite");
  });

  test("starts the automation scheduler on ready and stops it before closing SQLite", async () => {
    const timer = createControllableTimer();
    server = await createDaemonServer({
      config: testConfig(),
      automationSetTimer: timer.setTimer,
      automationTickIntervalMs: 4_321
    });

    await server.ready();
    expect(timer.delayMs).toBe(4_321);

    await server.close();
    server = undefined;
    expect(timer.cancels).toBe(1);
  });

  test("recovers interrupted automation jobs on startup without leaking their payload", async () => {
    const config = testConfig();
    const writer = SqliteClient.open({ databaseFile: config.databaseFile });
    runMigrations(writer);
    writer.db.prepare("INSERT INTO projects (id, name, root_path, root_path_hash, status, created_at, updated_at) VALUES ('proj_1', 'Project', '.', 'hash', 'ACTIVE', 1, 1)").run();
    writer.db.prepare(
      `INSERT INTO automation_jobs
         (id, kind, project_id, session_id, resource_type, resource_id, payload_json, idempotency_key,
          status, available_at, started_at, attempts, max_attempts, created_at, updated_at, revision)
       VALUES ('ajob_1', 'SYNC_SESSION_TRANSCRIPT', 'proj_1', NULL, 'SESSION', 'sess_1',
               '{"transcriptPath":"secret-rollout.jsonl"}', 'SYNC_SESSION_TRANSCRIPT:sess_1:1',
               'RUNNING', 1, 1, 1, 4, 1, 1, 2)`
    ).run();
    writer.close();

    const timer = createControllableTimer();
    server = await createDaemonServer({ config, automationSetTimer: timer.setTimer });

    const response = await server.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().recovery.automationJobsRecovered).toBe(1);
    expect(JSON.stringify(response.json())).not.toContain("secret-rollout.jsonl");

    const reader = SqliteClient.open({ databaseFile: config.databaseFile });
    const row = reader.db.prepare("SELECT status, failure_code FROM automation_jobs WHERE id = 'ajob_1'")
      .get() as { status: string; failure_code: string | null };
    reader.close();
    expect(row).toEqual({ status: "QUEUED", failure_code: "DAEMON_RESTARTED" });
  });

  test("rejects non-loopback hosts before creating a server", async () => {
    await expect(
      createDaemonServer({
        config: {
          ...testConfig(),
          host: "0.0.0.0",
          port: 4721
        }
      })
    ).rejects.toMatchObject({
      code: "INVALID_CONFIG"
    });
  });

  test("rejects a second daemon for the same data directory until the first closes", async () => {
    const config = testConfig();
    server = await createDaemonServer({ config });

    await expect(createDaemonServer({ config })).rejects.toMatchObject({
      code: "CONFLICT"
    });

    await server.close();
    server = undefined;

    server = await createDaemonServer({ config });
    const response = await server.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
  });

  test("removes a stale data directory lock when the owner process is gone", async () => {
    const config = testConfig();
    const lockDir = join(tempDir!, ".daemon.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "owner.json"), JSON.stringify({ pid: 99999999, createdAt: "2026-09-17T00:00:00.000Z" }), "utf8");

    server = await createDaemonServer({ config });
    const response = await server.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
  });

  test("releases the data directory lock when server initialization fails", async () => {
    const config = testConfig();
    await expect(createDaemonServer({
      config: {
        ...config,
        databaseFile: tempDir!
      }
    })).rejects.toThrow();
    await expect(access(join(tempDir!, ".daemon.lock"))).rejects.toThrow();

    server = await createDaemonServer({ config });
    const response = await server.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
  });
});




