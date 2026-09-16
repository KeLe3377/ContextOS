import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";

let server: FastifyInstance | undefined;
let tempDir: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-idempotency-"));
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

describe("idempotency keys", () => {
  test("replays a retried create response without creating a duplicate resource", async () => {
    if (!server) throw new Error("missing server");
    const payload = { name: "Idempotent Project", rootPath: "D:/project/ContextOS" };
    const headers = { "idempotency-key": "project-create-1" };

    const first = await server.inject({ method: "POST", url: "/api/projects", headers, payload });
    expect(first.statusCode).toBe(201);

    const second = await server.inject({ method: "POST", url: "/api/projects", headers, payload });
    expect(second.statusCode).toBe(201);
    expect(second.headers["x-idempotent-replay"]).toBe("true");
    expect(second.json().id).toBe(first.json().id);

    const listed = await server.inject({ method: "GET", url: "/api/projects" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);
  });

  test("rejects reusing a key for a different request", async () => {
    if (!server) throw new Error("missing server");
    const headers = { "idempotency-key": "project-create-2" };

    const first = await server.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: { name: "First", rootPath: "D:/project/ContextOS" }
    });
    expect(first.statusCode).toBe(201);

    const second = await server.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: { name: "Second", rootPath: "D:/project/ContextOS" }
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("CONFLICT");
  });
});
