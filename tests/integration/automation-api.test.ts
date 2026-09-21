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

describe("automation API error surface", () => {
  test("returns NOT_FOUND for an unknown candidate", async () => {
    const response = await server!.inject({ method: "GET", url: "/api/automation/candidates/cand_missing" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

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

  test("lists and reads candidates", async () => {
    const first = seedCandidate({ fingerprint: "sha256:list-1" });
    const second = seedCandidate({ fingerprint: "sha256:list-2" });

    const listed = await server!.inject({ method: "GET", url: `/api/projects/${projectId}/automation/candidates` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().candidates.map((candidate: { id: string }) => candidate.id).sort())
      .toEqual([first.id, second.id].sort());

    const detail = await server!.inject({ method: "GET", url: `/api/automation/candidates/${first.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: first.id, status: "PENDING", kind: "CONTEXT_ITEM" });
  });

  test("accepting twice is idempotent and creates exactly one context item", async () => {
    const candidate = seedCandidate({ fingerprint: "sha256:accept" });

    const first = await post(`/api/automation/candidates/${candidate.id}/accept`, { expectedRevision: candidate.revision });
    expect(first.candidate).toMatchObject({ status: "ACCEPTED", targetResourceType: "CONTEXT_ITEM" });
    const target = first.candidate.targetResourceId;

    const second = await post(`/api/automation/candidates/${candidate.id}/accept`, { expectedRevision: first.candidate.revision });
    expect(second).toMatchObject({ outcome: "ALREADY_APPLIED" });
    expect(second.target.resourceId).toBe(target);

    const items = withDb((db) => db.prepare("SELECT COUNT(*) AS count FROM context_items WHERE project_id = ?").get(projectId) as { count: number });
    expect(items.count).toBe(1);
  });

  test("rejecting twice is idempotent", async () => {
    const candidate = seedCandidate({ fingerprint: "sha256:reject" });

    const first = await post(`/api/automation/candidates/${candidate.id}/reject`, { expectedRevision: candidate.revision });
    expect(first.candidate.status).toBe("REJECTED");

    const second = await post(`/api/automation/candidates/${candidate.id}/reject`, { expectedRevision: first.candidate.revision });
    expect(second).toMatchObject({ outcome: "ALREADY_REJECTED" });

    const items = withDb((db) => db.prepare("SELECT COUNT(*) AS count FROM context_items WHERE project_id = ?").get(projectId) as { count: number });
    expect(items.count).toBe(0);
  });

  test("retry replays the artifact recorded in provenance", async () => {
    seedEvidence();
    const withProvenance = seedCandidate({
      fingerprint: "sha256:retry-ok",
      provenance: { sourceArtifactId: "cmp_missing", sourceEvidenceId: "ev_source" }
    });
    // The artifact id is resolved from provenance: it is not found, which proves the lookup used it
    // instead of falling back to the "no source artifact" conflict below.
    const missing = await server!.inject({
      method: "POST",
      url: `/api/automation/candidates/${withProvenance.id}/retry`,
      payload: { expectedRevision: withProvenance.revision }
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("NOT_FOUND");
  });

  test("retry fails clearly when provenance has no artifact", async () => {
    const withoutProvenance = seedCandidate({ fingerprint: "sha256:retry-none" });

    const response = await server!.inject({
      method: "POST",
      url: `/api/automation/candidates/${withoutProvenance.id}/retry`,
      payload: { expectedRevision: withoutProvenance.revision }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
  });

  test("review approval applies the candidate and dismissal rejects it", async () => {
    const approved = seedCandidate({ fingerprint: "sha256:review-approve" });
    const approveReview = seedReview(approved.id);
    const approveResponse = await post(`/api/automation/review-items/${approveReview.id}/resolve`, {
      resolutionType: "APPROVED",
      resolutionReason: "looks right",
      expectedRevision: approveReview.revision
    });
    expect(approveResponse.application.outcome).toBe("APPLIED");
    expect(approveResponse.reviewItem.status).toBe("RESOLVED");

    const dismissed = seedCandidate({ fingerprint: "sha256:review-dismiss" });
    const dismissReview = seedReview(dismissed.id);
    const dismissResponse = await post(`/api/automation/review-items/${dismissReview.id}/resolve`, {
      resolutionType: "DISMISSED",
      resolutionReason: "not useful",
      expectedRevision: dismissReview.revision
    });
    expect(dismissResponse.application.outcome).toBe("REJECTED");
    expect(dismissResponse.reviewItem.status).toBe("DISMISSED");
  });

  test("returns 409 on a review revision conflict", async () => {
    const candidate = seedCandidate({ fingerprint: "sha256:conflict" });
    const review = seedReview(candidate.id);
    // Move the review item's revision forward behind the caller's back.
    withDb((db) => db.prepare("UPDATE review_items SET revision = revision + 1, updated_at = ? WHERE id = ?").run(Date.now(), review.id));

    const response = await server!.inject({
      method: "POST",
      url: `/api/automation/review-items/${review.id}/resolve`,
      payload: { resolutionType: "APPROVED", resolutionReason: "x", expectedRevision: review.revision }
    });
    expect(response.statusCode).toBe(409);
    expect(withDb((db) => new SqliteAutomationRepository(db).getCandidate(candidate.id)!.status)).toBe("PENDING");
  });

  test("returns 409 on a candidate revision conflict", async () => {
    const candidate = seedCandidate({ fingerprint: "sha256:candidate-conflict" });
    withDb((db) => db.prepare("UPDATE extraction_candidates SET revision = revision + 1 WHERE id = ?").run(candidate.id));

    const response = await server!.inject({
      method: "POST",
      url: `/api/automation/candidates/${candidate.id}/accept`,
      payload: { expectedRevision: candidate.revision }
    });
    expect(response.statusCode).toBe(409);
    expect(withDb((db) => new SqliteAutomationRepository(db).getCandidate(candidate.id)!.status)).toBe("PENDING");
  });

  test("rejects malformed bodies with 400", async () => {
    const candidate = seedCandidate({ fingerprint: "sha256:bad-body" });
    const response = await server!.inject({
      method: "POST",
      url: `/api/automation/candidates/${candidate.id}/accept`,
      payload: { expectedRevision: "not-a-number" }
    });
    expect(response.statusCode).toBe(400);
  });

  test("does not list another project's candidates", async () => {
    const other = await post("/api/projects", { name: "Other", rootPath: "D:/project/Other" });
    const otherProjectId = other.id as string;
    const mine = seedCandidate({ fingerprint: "sha256:mine" });
    const theirs = seedCandidate({ fingerprint: "sha256:theirs", projectId: otherProjectId });

    const listed = await server!.inject({ method: "GET", url: `/api/projects/${projectId}/automation/candidates` });
    const ids = listed.json().candidates.map((candidate: { id: string }) => candidate.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);

    const scoped = await server!.inject({ method: "GET", url: `/api/projects/${otherProjectId}/automation/candidates` });
    expect(scoped.json().candidates.map((candidate: { id: string }) => candidate.id)).toEqual([theirs.id]);
  });

  test("responses carry no transcript, prompt, model output or local path", async () => {
    const candidate = seedCandidate({ fingerprint: "sha256:leaks" });
    const review = seedReview(candidate.id);
    const accepted = await post(`/api/automation/candidates/${candidate.id}/accept`, { expectedRevision: candidate.revision });

    for (const body of [JSON.stringify(accepted), JSON.stringify(review)]) {
      expect(body).not.toContain(tempDir!);
      expect(body).not.toContain("prompt");
      expect(body.toLowerCase()).not.toContain("api key");
    }
  });
});
