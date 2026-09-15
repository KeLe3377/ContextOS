import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";

let server: FastifyInstance | undefined;
let tempDir: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-runtime-"));
  server = await createDaemonServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      dataDir: tempDir,
      databaseFile: join(tempDir, "contextos.sqlite")
    }
  });
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

describe("runtime APIs", () => {
  test("returns settings and codex adapter status", async () => {
    const settings = await server!.inject({ method: "GET", url: "/api/settings" });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().id).toBe("singleton");
    expect(settings.json().confirmDestructiveActions).toBe(true);

    const adapters = await server!.inject({ method: "GET", url: "/api/agent-adapters" });
    expect(adapters.statusCode).toBe(200);
    expect(adapters.json().items[0].id).toBe("codex");
    expect(adapters.json().items[0].capabilities).toContain("launch");
  });
});
