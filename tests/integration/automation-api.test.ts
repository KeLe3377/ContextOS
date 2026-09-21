import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";
import { CodexAdapter } from "../../packages/infrastructure/src/adapters/codex-adapter.js";
import { SqliteAutomationRepository } from "../../packages/infrastructure/src/sqlite/automation-repository.js";
import { SqliteClient } from "../../packages/infrastructure/src/sqlite/client.js";
import { SqliteReviewItemRepository, SqliteSessionRepository } from "../../packages/infrastructure/src/sqlite/core-repositories.js";
import { reviewSourceTypeExtractionCandidate, reviewTriggerAutomationSuggestion } from "../../packages/contracts/src/review-items.js";
import type { Database } from "better-sqlite3";

let server: FastifyInstance | undefined;
let tempDir: string | undefined;
let projectId: string;
let seedCounter = 0;

const sourceEvidenceId = "ev_source";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post<T = any>(url: string, payload: Record<string, unknown>): Promise<T> {
  const response = await server!.inject({ method: "POST", url, payload });
  // Project creation answers 201; the automation mutations answer 200.
  expect([200, 201]).toContain(response.statusCode);
  return response.json() as T;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-automation-api-"));
  server = await createDaemonServer({
    agentAdapter: new CodexAdapter(process.execPath, ["-e", ""], process.platform, join(tempDir, "codex-sessions")),
    config: { host: "127.0.0.1", port: 0, dataDir: tempDir, databaseFile: join(tempDir, "contextos.sqlite") }
  });
  const project = await post("/api/projects", { name: "Automation", rootPath: "D:/project/ContextOS" });
  projectId = project.id as string;
  await server!.inject({
    method: "POST",
    url: "/api/evidence/snapshots",
    payload: { projectId, evidenceType: "AGENT_OUTPUT", title: "Batch", contentText: "body" }
  }).then(() => undefined);
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("automation API", () => {
  test("exposes the automation status", async () => {
    const response = await server!.inject({ method: "GET", url: "/api/automation/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty("projects");
  });

  test("reads and patches project automation settings", async () => {
    const initial = await server!.inject({ method: "GET", url: `/api/projects/${projectId}/automation/settings` });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ projectId, mode: "SUGGEST_ONLY" });

    const patched = await server!.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/automation/settings`,
      payload: { mode: "OFF", expectedRevision: initial.json().revision }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ mode: "OFF" });
  });

});

/**
 * Seeds a candidate through a short-lived connection and closes it: the daemon keeps its own
 * connection, so nothing stays open when the temporary directory is removed.
 */
function seedEvidence() {
  return withDb((db) => {
    db.prepare(
      "INSERT OR IGNORE INTO evidence_snapshots (id, project_id, evidence_type, title, content_text, content_hash, metadata_json, captured_at, created_at) VALUES (?, ?, 'AGENT_OUTPUT', 'Batch', 'body', 'sha256:source', '{}', ?, ?)"
    ).run("ev_source", projectId, Date.now(), Date.now());
  });
}

function seedCandidate(options: {
  kind?: "RESUME_CAPSULE" | "CONTEXT_ITEM";
  sessionId?: string | null;
  fingerprint?: string;
  provenance?: Record<string, string>;
  projectId?: string;
} = {}) {
  const kind = options.kind ?? "CONTEXT_ITEM";
  const client = SqliteClient.open({ databaseFile: join(tempDir!, "contextos.sqlite") });
  try {
    return new SqliteAutomationRepository(client.db).upsertCandidate(
      {
        projectId: options.projectId ?? projectId,
        sessionId: options.sessionId === undefined ? null : options.sessionId,
        sourceEvidenceId: options.provenance ? "ev_source" : null,
        evidenceIds: options.provenance ? ["ev_source"] : [],
        kind,
        fingerprint: options.fingerprint ?? `sha256:${kind}-${seedCounter++}`,
        payload: kind === "RESUME_CAPSULE"
          ? { kind: "RESUME_CAPSULE", summary: "Capsule summary.", nextAction: "Next step." }
          : {
              kind: "CONTEXT_ITEM",
              itemType: "SUMMARY",
              title: "Daemon owns polling",
              summary: "The daemon polls transcripts.",
              confidence: "HIGH"
            },
        confidence: 0.9,
        extractorId: "api-test",
        extractorVersion: "1.0.0",
        ...(options.provenance ? { provenance: options.provenance } : {})
      },
      Date.now()
    ).candidate;
  } finally {
    client.close();
  }
}

function withDb<T>(work: (db: Database) => T): T {
  const client = SqliteClient.open({ databaseFile: join(tempDir!, "contextos.sqlite") });
  try {
    return work(client.db);
  } finally {
    client.close();
  }
}

function seedReview(candidateId: string) {
  return withDb((db) => new SqliteReviewItemRepository(db).findOrCreateOpen(
    {
      projectId,
      sourceType: reviewSourceTypeExtractionCandidate,
      sourceId: candidateId,
      triggerType: reviewTriggerAutomationSuggestion,
      priority: "MEDIUM",
      summary: "Extracted candidate"
    },
    Date.now()
  ));
}

/**
 * The candidate surface is retired: it must answer 410 with a stable code rather than silently
 * succeeding, doing nothing, or pretending the resource simply does not exist.
 */
describe("deferred extraction candidate API", () => {
  test("answers 410 FEATURE_DEFERRED for every candidate read and mutation", async () => {
    const candidate = seedCandidate({ fingerprint: "sha256:deferred" });
    const review = seedReview(candidate.id);

    const targets: Array<{ method: "GET" | "POST"; url: string; payload?: Record<string, unknown> }> = [
      { method: "GET", url: `/api/projects/${projectId}/automation/candidates` },
      { method: "GET", url: `/api/automation/candidates/${candidate.id}` },
      { method: "GET", url: "/api/automation/candidates/cand_missing" },
      { method: "POST", url: `/api/automation/candidates/${candidate.id}/accept`, payload: { expectedRevision: candidate.revision } },
      { method: "POST", url: `/api/automation/candidates/${candidate.id}/reject`, payload: { expectedRevision: candidate.revision } },
      { method: "POST", url: `/api/automation/candidates/${candidate.id}/retry`, payload: { expectedRevision: candidate.revision } },
      {
        method: "POST",
        url: `/api/automation/review-items/${review.id}/resolve`,
        payload: { resolutionType: "APPROVED", resolutionReason: "x", expectedRevision: review.revision }
      }
    ];

    for (const target of targets) {
      const response = await server!.inject({ method: target.method, url: target.url, payload: target.payload });
      expect(response.statusCode, `${target.method} ${target.url}`).toBe(410);
      expect(response.json().error.code, `${target.method} ${target.url}`).toBe("GONE");
      expect(response.json().error.message).toBeTruthy();
    }

    // Nothing was applied behind the 410: the candidate keeps its pre-request state.
    const stored = withDb((db) => new SqliteAutomationRepository(db).getCandidate(candidate.id)!);
    expect(stored.status).toBe("PENDING");
  });

  test("never leaks a local path or transcript fragment through the deferred surface", async () => {
    const candidate = seedCandidate({ fingerprint: "sha256:deferred-leak" });
    const response = await server!.inject({
      method: "POST",
      url: `/api/automation/candidates/${candidate.id}/accept`,
      payload: { expectedRevision: candidate.revision }
    });
    expect(response.statusCode).toBe(410);
    expect(response.body).not.toContain(tempDir!);
  });
});

describe("automation API error surface", () => {
  test("rejects an invalid settings patch", async () => {
    const settings = (await server!.inject({ method: "GET", url: `/api/projects/${projectId}/automation/settings` })).json();
    const response = await server!.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/automation/settings`,
      payload: { mode: "NOT_A_MODE", expectedRevision: settings.revision }
    });
    expect(response.statusCode).toBe(400);
  });

  test("discovery only enqueues work instead of discovering inside the request", async () => {
    const response = await server!.inject({ method: "POST", url: `/api/projects/${projectId}/automation/discovery` });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ projectId, created: true });

    // Nothing was discovered synchronously, but a discovery job is waiting for the scheduler.
    const jobs = withDb((db) => new SqliteAutomationRepository(db).countJobsByKind());
    expect(jobs.DISCOVER_CODEX_THREADS).toBe(1);
    const sessions = withDb((db) => db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number });
    expect(sessions.count).toBe(0);
  });
});
