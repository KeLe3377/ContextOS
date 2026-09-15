import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";

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
    expect(body.schemaVersion).toBe(5);
    expect(body.processState).toBe("ready");
    expect(body.requestId).toBe("test-request-1");
    expect(JSON.stringify(body)).not.toContain(tempDir);
    expect(JSON.stringify(body)).not.toContain("contextos.sqlite");
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
});


