import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CompactionEvent } from "../../packages/contracts/src/compaction.js";
import { SqliteClient } from "../../packages/infrastructure/src/sqlite/client.js";
import { SqliteCompactionArtifactRepository, type CompactionArtifactInput } from "../../packages/infrastructure/src/sqlite/compaction-artifact-repository.js";
import { SqliteSessionRepository } from "../../packages/infrastructure/src/sqlite/core-repositories.js";
import { runMigrations } from "../../packages/infrastructure/src/sqlite/migrations.js";
import { SqliteProjectRepository } from "../../packages/infrastructure/src/sqlite/project-repository.js";

const now = 1_760_000_000_000;

let tempDir: string;
let client: SqliteClient;
let artifacts: SqliteCompactionArtifactRepository;
let projectId: string;
let sessionId: string;
let evidenceId: string;

const events: CompactionEvent[] = [
  { ordinal: 1, kind: "message", role: "user", text: "hello" },
  { ordinal: 2, kind: "tool_call", name: "shell", callId: "call_a", text: "{}" },
  { ordinal: 3, kind: "tool_result", callId: "call_a", text: "ok", isError: false }
];

function artifactInput(overrides: Partial<CompactionArtifactInput> = {}): CompactionArtifactInput {
  return {
    projectId,
    sessionId,
    sourceEvidenceId: evidenceId,
    sourceContentHash: "sha256:source",
    providerId: "deterministic",
    providerVersion: "contextos-deterministic-compaction.v1",
    sanitizerVersion: "contextos-transcript-sanitizer.v1",
    optionsHash: "sha256:options",
    status: "SUCCEEDED",
    events,
    decisions: [{ callId: "call_a", ordinal: 2, action: "KEEP", reason: "BELOW_THRESHOLD", charsBefore: 2, charsAfter: 2 }],
    stats: {
      messagesBefore: 3,
      messagesAfter: 3,
      charsBefore: 20,
      charsAfter: 20,
      pairedCalls: 1,
      truncatedResults: 0,
      pinnedMessages: 1
    },
    failureCode: null,
    ...overrides
  };
}

function insertEvidence(id: string, hash: string): void {
  client.db.prepare(
    "INSERT INTO evidence_snapshots (id, project_id, evidence_type, title, content_text, content_hash, metadata_json, captured_at, created_at) VALUES (?, ?, 'AGENT_OUTPUT', 'Batch', 'body', ?, '{}', ?, ?)"
  ).run(id, projectId, hash, now, now);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-artifacts-"));
  client = SqliteClient.open({ databaseFile: join(tempDir, "contextos.sqlite") });
  runMigrations(client);
  artifacts = new SqliteCompactionArtifactRepository(client.db);
  projectId = new SqliteProjectRepository(client.db)
    .create({ name: "Artifacts", rootPath: tempDir, defaultRuleIds: [], agentAdapterIds: ["codex"] }, now).id;
  sessionId = new SqliteSessionRepository(client.db)
    .create({ projectId, agentAdapterId: "codex", title: "Session" }, now).id;
  evidenceId = "ev_source";
  insertEvidence(evidenceId, "sha256:source");
});

afterEach(async () => {
  client.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("compaction artifact storage", () => {
  test("creates an artifact once and reuses it for the same identity", () => {
    const first = artifacts.findOrCreate(artifactInput(), now);
    expect(first.created).toBe(true);
    expect(first.artifact).toMatchObject({
      projectId,
      sessionId,
      sourceEvidenceId: evidenceId,
      sourceContentHash: "sha256:source",
      providerId: "deterministic",
      status: "SUCCEEDED",
      failureCode: null,
      revision: 1
    });
    expect(first.artifact.events).toEqual(events);
    expect(first.artifact.decisions).toEqual([{ callId: "call_a", ordinal: 2, action: "KEEP", reason: "BELOW_THRESHOLD", charsBefore: 2, charsAfter: 2 }]);
    expect(first.artifact.stats).toEqual({ messagesBefore: 3, messagesAfter: 3, charsBefore: 20, charsAfter: 20, pairedCalls: 1, truncatedResults: 0, pinnedMessages: 1 });

    const second = artifacts.findOrCreate(artifactInput(), now + 1_000);
    expect(second.created).toBe(false);
    expect(second.artifact.id).toBe(first.artifact.id);
    expect(client.db.prepare("SELECT COUNT(*) AS count FROM compaction_artifacts").get()).toEqual({ count: 1 });
  });

  test("treats every identity dimension as significant", () => {
    const first = artifacts.findOrCreate(artifactInput(), now);

    for (const override of [
      { providerId: "jev" },
      { providerVersion: "v2" },
      { sanitizerVersion: "v2" },
      { optionsHash: "sha256:other-options" }
    ]) {
      const changed = artifacts.findOrCreate(artifactInput(override), now);
      expect(changed.created).toBe(true);
      expect(changed.artifact.id).not.toBe(first.artifact.id);
    }

    // The content hash dimension needs its own source Evidence row, because an artifact may only
    // ever point at bytes that actually exist with that hash.
    insertEvidence("ev_other", "sha256:other");
    const otherContent = artifacts.findOrCreate(artifactInput({ sourceEvidenceId: "ev_other", sourceContentHash: "sha256:other" }), now);
    expect(otherContent.created).toBe(true);
    expect(otherContent.artifact.id).not.toBe(first.artifact.id);

    expect(artifacts.findByIdentity({
      sourceContentHash: "sha256:source",
      providerId: "deterministic",
      providerVersion: "contextos-deterministic-compaction.v1",
      sanitizerVersion: "contextos-transcript-sanitizer.v1",
      optionsHash: "sha256:options"
    })?.id).toBe(first.artifact.id);
    expect(client.db.prepare("SELECT COUNT(*) AS count FROM compaction_artifacts").get()).toEqual({ count: 6 });
  });

  test("refuses an artifact whose source hash does not match its Evidence", () => {
    const { artifact } = artifacts.findOrCreate(artifactInput(), now);

    // Corrupt the stored hash the way a bad migration or a manual edit would.
    client.db.prepare("UPDATE compaction_artifacts SET source_content_hash = 'sha256:tampered' WHERE id = ?").run(artifact.id);

    expect(() => artifacts.getByIdOrThrow(artifact.id)).toThrowError(/failed validation/i);
  });

  test("lists the artifacts derived from one Evidence row", () => {
    const first = artifacts.findOrCreate(artifactInput(), now);
    const second = artifacts.findOrCreate(artifactInput({ optionsHash: "sha256:other-options" }), now + 1_000);
    insertEvidence("ev_unrelated", "sha256:unrelated");
    artifacts.findOrCreate(artifactInput({ sourceEvidenceId: "ev_unrelated", sourceContentHash: "sha256:unrelated" }), now);

    expect(artifacts.listByEvidence(evidenceId).map((artifact) => artifact.id)).toEqual([first.artifact.id, second.artifact.id]);
    expect(artifacts.listByEvidence("ev_missing")).toEqual([]);
  });

  test("relies on the Evidence table to keep one row per project and content hash", () => {
    // The artifact identity is content based, and Evidence already refuses a second row with the
    // same (project, content hash) — so within a project an artifact maps to one source blob.
    expect(() => insertEvidence("ev_duplicate", "sha256:source")).toThrow();
  });

  test("stores a fallback artifact together with its failure code", () => {
    const { artifact } = artifacts.findOrCreate(
      artifactInput({
        status: "FALLBACK",
        failureCode: "COMPACTION_PROVIDER_FAILED",
        decisions: [],
        stats: { messagesBefore: 3, messagesAfter: 3, charsBefore: 20, charsAfter: 20, pairedCalls: 0, truncatedResults: 0, pinnedMessages: 0 }
      }),
      now
    );

    expect(artifact).toMatchObject({ status: "FALLBACK", failureCode: "COMPACTION_PROVIDER_FAILED", decisions: [] });
    expect(artifact.events).toEqual(events);
  });

  test("reports a missing artifact clearly", () => {
    expect(artifacts.getById("cmp_missing")).toBeNull();
    expect(() => artifacts.getByIdOrThrow("cmp_missing")).toThrowError(/not found/i);
  });

  test("refuses an artifact for an Evidence row that does not exist", () => {
    expect(() => artifacts.findOrCreate(artifactInput({ sourceEvidenceId: "ev_missing" }), now)).toThrow();
  });
});

describe("compaction artifact validation", () => {
  let counter = 0;

  /**
   * Each assertion gets its own artifact: corrupting a shared row would make a later read fail
   * for the previous reason instead of the one under test.
   */
  function corrupt(column: "events_json" | "decisions_json" | "stats_json", value: string): string {
    counter += 1;
    const { artifact } = artifacts.findOrCreate(artifactInput({ optionsHash: `sha256:options-${counter}` }), now);
    client.db.prepare(`UPDATE compaction_artifacts SET ${column} = ? WHERE id = ?`).run(value, artifact.id);
    return artifact.id;
  }

  function expectInvalid(id: string, column: string, reason: string): void {
    try {
      artifacts.getByIdOrThrow(id);
    } catch (error) {
      expect(error).toMatchObject({
        code: "CONFLICT",
        details: { failureCode: "COMPACTION_ARTIFACT_INVALID", column, reason }
      });
      // The raw JSON can hold transcript content, so it must never reach the error.
      expect(JSON.stringify(error)).not.toContain("truncated payload");
      return;
    }
    throw new Error(`Expected artifact ${id} to be rejected`);
  }

  test("rejects a column that is not JSON at all", () => {
    expectInvalid(corrupt("events_json", "truncated payload"), "events_json", "JSON_PARSE");
    expectInvalid(corrupt("decisions_json", "truncated payload"), "decisions_json", "JSON_PARSE");
    expectInvalid(corrupt("stats_json", "truncated payload"), "stats_json", "JSON_PARSE");
  });

  test("rejects an event that does not match the schema", () => {
    expectInvalid(corrupt("events_json", JSON.stringify([{ ordinal: "1", kind: "message" }])), "events_json", "SCHEMA_MISMATCH");
    expectInvalid(corrupt("events_json", JSON.stringify([{ ordinal: 1, kind: "not-a-kind" }])), "events_json", "SCHEMA_MISMATCH");
    // An extra field is rejected rather than trusted.
    expectInvalid(corrupt("events_json", JSON.stringify([{ ordinal: 1, kind: "message", sessionId: "sess_other" }])), "events_json", "SCHEMA_MISMATCH");
    expectInvalid(corrupt("events_json", JSON.stringify({ ordinal: 1, kind: "message" })), "events_json", "SCHEMA_MISMATCH");
  });

  test("rejects duplicate and non-ascending event ordinals", () => {
    const duplicate = JSON.stringify([
      { ordinal: 1, kind: "message", text: "a" },
      { ordinal: 1, kind: "message", text: "b" }
    ]);
    expectInvalid(corrupt("events_json", duplicate), "events_json", "DUPLICATE_ORDINAL");

    const descending = JSON.stringify([
      { ordinal: 5, kind: "message", text: "a" },
      { ordinal: 2, kind: "message", text: "b" }
    ]);
    expectInvalid(corrupt("events_json", descending), "events_json", "NON_INCREASING_ORDINAL");
  });

  test("rejects a decision or stats column that does not match the schema", () => {
    expectInvalid(corrupt("decisions_json", JSON.stringify([{ callId: "call_a", action: "KEEP" }])), "decisions_json", "SCHEMA_MISMATCH");
    expectInvalid(corrupt("stats_json", JSON.stringify({ messagesBefore: 1 })), "stats_json", "SCHEMA_MISMATCH");
    expectInvalid(corrupt("stats_json", JSON.stringify({ ...artifactInput().stats, extra: 1 })), "stats_json", "SCHEMA_MISMATCH");
  });

  test("accepts a well-formed artifact", () => {
    const { artifact } = artifacts.findOrCreate(artifactInput(), now);
    expect(artifacts.getByIdOrThrow(artifact.id).events).toEqual(events);
  });
});
