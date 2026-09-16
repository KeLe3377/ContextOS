import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { ContextOsError } from "../../../../packages/shared/src/errors.js";
import { nowMs } from "../../../../packages/shared/src/clock.js";

const ttlMs = 24 * 60 * 60 * 1000;
const keyPattern = /^[A-Za-z0-9._:-]{8,128}$/;

type StoredResponse = {
  statusCode: number;
  payload: unknown;
};

export function registerIdempotencyHooks(server: FastifyInstance, db: Database): void {
  server.addHook("preHandler", async (request, reply) => {
    if (!isIdempotentMethod(request.method)) return;
    const key = idempotencyKey(request.headers["idempotency-key"]);
    if (!key) return;
    if (!keyPattern.test(key)) {
      throw new ContextOsError("INVALID_ARGUMENT", "Idempotency-Key must be 8-128 URL-safe characters");
    }

    const requestHash = hashRequest({
      method: request.method,
      url: request.url,
      body: request.body
    });
    const currentTime = nowMs();
    db.prepare("DELETE FROM idempotency_keys WHERE expires_at <= ?").run(currentTime);
    const existing = db.prepare("SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?").get(key) as
      | { request_hash: string; response_json: string }
      | undefined;

    if (!existing) {
      request.idempotency = { key, requestHash };
      return;
    }
    if (existing.request_hash !== requestHash) {
      throw new ContextOsError("CONFLICT", "Idempotency-Key was already used for a different request");
    }

    const stored = JSON.parse(existing.response_json) as StoredResponse;
    reply.header("x-idempotent-replay", "true");
    reply.code(stored.statusCode).send(stored.payload);
  });

  server.addHook("onSend", async (request, reply, payload) => {
    if (!request.idempotency || reply.statusCode >= 500) return payload;
    const response: StoredResponse = {
      statusCode: reply.statusCode,
      payload: parsePayload(payload)
    };
    db.prepare("INSERT OR IGNORE INTO idempotency_keys (key, request_hash, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(request.idempotency.key, request.idempotency.requestHash, JSON.stringify(response), nowMs(), nowMs() + ttlMs);
    return payload;
  });
}

declare module "fastify" {
  interface FastifyRequest {
    idempotency?: {
      key: string;
      requestHash: string;
    };
  }
}

function isIdempotentMethod(method: string): boolean {
  return method === "POST" || method === "PATCH";
}

function idempotencyKey(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

function hashRequest(input: { method: string; url: string; body: unknown }): string {
  const body = stableJson(input.body ?? null);
  return `sha256:${createHash("sha256").update(`${input.method}\n${input.url}\n${body}`).digest("hex")}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)])
  );
}

function parsePayload(payload: unknown): unknown {
  if (Buffer.isBuffer(payload)) return JSON.parse(payload.toString("utf8"));
  if (typeof payload === "string") return JSON.parse(payload);
  return payload;
}
