import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AutomationService } from "../../packages/application/src/core/automation-service.js";
import { AutomationJobRouter } from "../../packages/application/src/core/automation-job-router.js";
import { AutomationScheduler } from "../../packages/application/src/core/automation-scheduler.js";
import { CompactionService, hashCompactionOptions } from "../../packages/application/src/core/compaction-service.js";
import { ContextOsCompactionAdapter } from "../../packages/application/src/core/compaction-adapter.js";
import { EvidenceSnapshotService } from "../../packages/application/src/core/context-services.js";
import { DesktopSyncService } from "../../packages/application/src/core/desktop-sync-service.js";
import { PrefixTranscriptSanitizer } from "../../packages/application/src/core/transcript-sanitizer.js";
import { encodeTranscriptEvents } from "../../packages/application/src/core/transcript-event-codec.js";
import type { AgentAdapter, AgentTranscriptEvent } from "../../packages/application/src/ports/agent-adapter.js";
import type { CompactionOptions, TranscriptCompactionProvider } from "../../packages/application/src/ports/transcript-compaction.js";
import { AgentAdapterRegistry } from "../../packages/infrastructure/src/adapters/registry.js";
import { CodexTranscriptTailer } from "../../packages/infrastructure/src/adapters/codex-transcript-tailer.js";
import { DeterministicCompactionProvider, defaultCompactionOptions } from "../../packages/infrastructure/src/compaction/deterministic-compaction-provider.js";
import { FileEvidenceStore } from "../../packages/infrastructure/src/evidence/evidence-store.js";
import { SqliteAutomationRepository } from "../../packages/infrastructure/src/sqlite/automation-repository.js";
import { SqliteClient } from "../../packages/infrastructure/src/sqlite/client.js";
import { SqliteCompactionArtifactRepository } from "../../packages/infrastructure/src/sqlite/compaction-artifact-repository.js";
import { SqliteEvidenceSnapshotRepository } from "../../packages/infrastructure/src/sqlite/context-repositories.js";
import { SqliteReviewItemRepository, SqliteSessionRepository } from "../../packages/infrastructure/src/sqlite/core-repositories.js";
import { runMigrations } from "../../packages/infrastructure/src/sqlite/migrations.js";
import { SqliteProjectRepository } from "../../packages/infrastructure/src/sqlite/project-repository.js";
import { SqliteSessionSyncRepository } from "../../packages/infrastructure/src/sqlite/session-sync-repository.js";

const externalSessionId = "01a0aaaa-0000-7000-8000-000000000001";
const pollIntervalMs = 30_000;
const agentsInjection = "# AGENTS.md instructions for D:\\project\\ContextOS\n\n<INSTRUCTIONS>be terse</INSTRUCTIONS>";
const longResult = "z".repeat(6_000);

let tempDir: string;
let rolloutPath: string;
let client: SqliteClient;
let projects: SqliteProjectRepository;
let sessions: SqliteSessionRepository;
let sync: SqliteSessionSyncRepository;
let automation: SqliteAutomationRepository;
let evidenceService: EvidenceSnapshotService;
let artifacts: SqliteCompactionArtifactRepository;
let automationService: AutomationService;
let projectId: string;
let sessionId: string;
let clockNow: number;
let parserVersion: string;
/** Whether the fixture parser can confirm a tool result succeeded. */
let confirmToolSuccess: boolean;

function messageRow(role: "user" | "assistant", text: string, timestamp: string): string {
  return JSON.stringify({ timestamp, type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
}

function toolCallRow(name: string, callId: string, text: string): string {
  return JSON.stringify({ type: "response_item", payload: { type: "function_call", name, call_id: callId, arguments: text } });
}

function toolResultRow(callId: string, text: string): string {
  return JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: callId, output: text } });
}

function createTranscriptAdapter(): AgentAdapter {
  return {
    id: "codex",
    displayName: "Codex",
    get transcriptParserVersion() {
      return parserVersion;
    },
    resolveTranscriptPath: () => rolloutPath,
    parseTranscriptRows: ({ rows, startOrdinal }: { rows: string[]; startOrdinal: number }): AgentTranscriptEvent[] => {
      const events: AgentTranscriptEvent[] = [];
      let ordinal = startOrdinal;
      for (const row of rows) {
        let parsed: {
          timestamp?: string;
          type?: string;
          payload?: {
            type?: string;
            role?: "user" | "assistant";
            content?: Array<{ text?: string }>;
            name?: string;
            call_id?: string;
            arguments?: string;
            output?: string;
          };
        };
        try {
          parsed = JSON.parse(row) as typeof parsed;
        } catch {
          continue;
        }
        if (parsed.type !== "response_item" || !parsed.payload?.type) continue;
        ordinal += 1;
        if (parsed.payload.type === "message") {
          events.push({ ordinal, timestamp: parsed.timestamp, kind: "message", role: parsed.payload.role, text: parsed.payload.content?.[0]?.text });
        } else if (parsed.payload.type === "function_call") {
          events.push({ ordinal, kind: "tool_call", name: parsed.payload.name, callId: parsed.payload.call_id, text: parsed.payload.arguments });
        } else if (parsed.payload.type === "function_call_output") {
          // A parser that can confirm success would set this; today's Codex parser cannot, which
          // is exactly why the fixtures default to an unknown outcome.
          events.push({
            ordinal,
            kind: "tool_result",
            callId: parsed.payload.call_id,
            text: parsed.payload.output,
            ...(confirmToolSuccess ? { isError: false } : {})
          });
        }
      }
      return events;
    }
  } as unknown as AgentAdapter;
}

function compactionService(options: {
  provider?: TranscriptCompactionProvider;
  compactionOptions?: CompactionOptions;
} = {}): CompactionService {
  return new CompactionService({
    evidence: evidenceService,
    artifacts,
    automation,
    sanitizer: new PrefixTranscriptSanitizer(),
    adapter: new ContextOsCompactionAdapter(),
    provider: options.provider ?? new DeterministicCompactionProvider(),
    options: options.compactionOptions ?? defaultCompactionOptions,
    extractor: { id: "codex-cli", version: "test.v1" },
    clock: () => clockNow
  });
}

function evidenceRow(id: string) {
  return client.db.prepare("SELECT id, content_text, content_hash, metadata_json, storage_ref FROM evidence_snapshots WHERE id = ?")
    .get(id) as { id: string; content_text: string; content_hash: string; metadata_json: string; storage_ref: string | null };
}

function extractJobs() {
  return client.db.prepare(
    "SELECT id, status, attempts, resource_type, resource_id, payload_json, idempotency_key FROM automation_jobs WHERE kind = 'EXTRACT_EVIDENCE_CONTEXT' ORDER BY created_at, id"
  ).all() as Array<{
    id: string;
    status: string;
    attempts: number;
    resource_type: string;
    resource_id: string;
    payload_json: string;
    idempotency_key: string;
  }>;
}

function artifactCount(): number {
  return (client.db.prepare("SELECT COUNT(*) AS count FROM compaction_artifacts").get() as { count: number }).count;
}

/** Files actually present under the Evidence root, used to prove the payload is stored once. */
async function evidenceFileCount(): Promise<number> {
  try {
    const entries = await readdir(join(tempDir, "evidence"), { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).length;
  } catch {
    return 0;
  }
}

function blobPath(evidenceId: string): string {
  const row = evidenceRow(evidenceId);
  if (!row.storage_ref) throw new Error(`Evidence ${evidenceId} has no storage reference`);
  return join(tempDir, row.storage_ref);
}

/**
 * Ingests one batch through the real sync path and returns the Evidence it produced.
 *
 * The batch holds an injected context message, a real turn, an oversized tool result and two
 * later turns — so the tool result sits outside the pinned window and is a truncation candidate.
 */
async function ingestBatch(): Promise<string> {
  await writeFile(rolloutPath, "", "utf8");
  await automationService.syncSessionTranscript({ sessionId });

  const stamp = new Date(clockNow).toISOString();
  await appendFile(rolloutPath, [
    `${messageRow("user", agentsInjection, stamp)}\n`,
    `${messageRow("user", "please look at the file", stamp)}\n`,
    `${toolCallRow("shell", "call_a", '{"command":"cat big.txt"}')}\n`,
    `${toolResultRow("call_a", longResult)}\n`,
    `${messageRow("assistant", "the file is large", stamp)}\n`,
    `${messageRow("user", "thanks, continue", stamp)}\n`
  ].join(""), "utf8");
  clockNow += pollIntervalMs;

  const summary = await automationService.syncSessionTranscript({ sessionId });
  if (!summary.evidenceId) throw new Error("Expected the sync to capture Evidence");
  return summary.evidenceId;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-compaction-"));
  rolloutPath = join(tempDir, "rollout.jsonl");
  clockNow = Math.floor(Date.now() / 1000) * 1000;
  parserVersion = "codex-jsonl.test.v1";
  confirmToolSuccess = false;

  client = SqliteClient.open({ databaseFile: join(tempDir, "contextos.sqlite") });
  runMigrations(client);
  projects = new SqliteProjectRepository(client.db);
  sessions = new SqliteSessionRepository(client.db);
  sync = new SqliteSessionSyncRepository(client.db);
  automation = new SqliteAutomationRepository(client.db);
  artifacts = new SqliteCompactionArtifactRepository(client.db);
  const reviewItems = new SqliteReviewItemRepository(client.db);
  evidenceService = new EvidenceSnapshotService(new SqliteEvidenceSnapshotRepository(client.db), new FileEvidenceStore(tempDir), reviewItems);

  const adapters = new AgentAdapterRegistry([createTranscriptAdapter()]);
  const desktopSync = new DesktopSyncService({
    sessions,
    sync,
    adapters,
    tailer: new CodexTranscriptTailer(),
    bindExternalSession: ({ sessionId: id, externalSessionId: external }) => {
      client.db.prepare("UPDATE sessions SET external_session_id = ?, revision = revision + 1 WHERE id = ?").run(external, id);
    }
  });
  automationService = new AutomationService({
    projects,
    sessions,
    sync,
    reviewItems,
    automation,
    evidence: evidenceService,
    adapters,
    desktopSync,
    clock: () => clockNow
  });

  const project = projects.create({ name: "Compaction", rootPath: tempDir, defaultRuleIds: [], agentAdapterIds: ["codex"] }, clockNow);
  projectId = project.id;
  automation.patchSettings(projectId, { pollIntervalMs, expectedRevision: 1 }, clockNow);
  sessionId = sessions.createDiscovered({ projectId, agentAdapterId: "codex", externalSessionId, title: "Rollout" }, clockNow).session.id;
});

afterEach(async () => {
  client.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("compaction of a committed Evidence batch", () => {
  test("produces a SUCCEEDED artifact and only then queues extraction", async () => {
    const evidenceId = await ingestBatch();
    expect(extractJobs()).toHaveLength(0);

    const summary = await compactionService().compactEvidence({ evidenceId });

    expect(summary).toMatchObject({ status: "SUCCEEDED", reused: false, extractionJobEnqueued: true });
    const artifact = artifacts.getByIdOrThrow(summary.artifactId);
    expect(artifact).toMatchObject({
      projectId,
      sessionId,
      sourceEvidenceId: evidenceId,
      providerId: "deterministic",
      sanitizerVersion: "contextos-transcript-sanitizer.v1",
      status: "SUCCEEDED",
      failureCode: null
    });
    expect(artifact.optionsHash).toBe(hashCompactionOptions(defaultCompactionOptions));
    // Today's Codex parser cannot confirm a tool outcome, so the conservative three-state rule
    // keeps the oversized result whole. Truncation with a confirmed outcome is covered below.
    expect(summary.truncatedResults).toBe(0);
    expect(artifact.events.find((event) => event.kind === "tool_result")?.text).toBe(longResult);

    const jobs = extractJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "QUEUED", resource_type: "COMPACTION_ARTIFACT", resource_id: artifact.id });
    expect(jobs[0]!.idempotency_key).toBe(`EXTRACT_EVIDENCE_CONTEXT:${artifact.id}:test.v1`);
    expect(JSON.parse(jobs[0]!.payload_json)).toMatchObject({ artifactId: artifact.id, sourceEvidenceId: evidenceId });
  });

  test("truncates an oversized result once the transcript confirms it succeeded", async () => {
    confirmToolSuccess = true;
    const evidenceId = await ingestBatch();

    const summary = await compactionService().compactEvidence({ evidenceId });

    expect(summary).toMatchObject({ status: "SUCCEEDED", truncatedResults: 1 });
    const artifact = artifacts.getByIdOrThrow(summary.artifactId);
    const resultText = artifact.events.find((event) => event.kind === "tool_result")?.text ?? "";
    expect(resultText).toContain("contextos-compaction");
    expect(resultText).toContain("re-run the tool");
    expect(resultText.length).toBeLessThan(longResult.length);
    // Nothing else was rewritten.
    expect(artifact.events.find((event) => event.text === "please look at the file")).toBeTruthy();
    expect(artifact.events.filter((event) => event.kind === "tool_call")).toHaveLength(1);
  });

  test("sanitizes known injections before compacting", async () => {
    const evidenceId = await ingestBatch();
    const summary = await compactionService().compactEvidence({ evidenceId });
    const artifact = artifacts.getByIdOrThrow(summary.artifactId);

    expect(artifact.events.some((event) => (event.text ?? "").startsWith("# AGENTS.md instructions"))).toBe(false);
    expect(artifact.events.some((event) => event.text === "please look at the file")).toBe(true);
  });

  test("reuses the artifact instead of recomputing it", async () => {
    const evidenceId = await ingestBatch();
    const first = await compactionService().compactEvidence({ evidenceId });
    const second = await compactionService().compactEvidence({ evidenceId });

    expect(second.artifactId).toBe(first.artifactId);
    expect(second.reused).toBe(true);
    expect(artifactCount()).toBe(1);
    // The queue key derives from the artifact id, so a retry cannot double-enqueue.
    expect(extractJobs()).toHaveLength(1);
  });

  test("does not duplicate the artifact after a daemon restart", async () => {
    const evidenceId = await ingestBatch();
    const first = await compactionService().compactEvidence({ evidenceId });

    // A restart rebuilds every repository and service over the same database.
    const restarted = compactionService();
    const second = await restarted.compactEvidence({ evidenceId });

    expect(second.artifactId).toBe(first.artifactId);
    expect(second.reused).toBe(true);
    expect(artifactCount()).toBe(1);
    expect(extractJobs()).toHaveLength(1);
  });

  test("produces a new artifact when the provider version or the options change", async () => {
    const evidenceId = await ingestBatch();
    const base = await compactionService().compactEvidence({ evidenceId });

    const otherProvider: TranscriptCompactionProvider = {
      id: "deterministic",
      version: "contextos-deterministic-compaction.v2",
      compact: (input) => new DeterministicCompactionProvider().compact(input)
    };
    const withNewProvider = await compactionService({ provider: otherProvider }).compactEvidence({ evidenceId });
    expect(withNewProvider.artifactId).not.toBe(base.artifactId);

    const withNewOptions = await compactionService({
      compactionOptions: { ...defaultCompactionOptions, maxToolResultChars: 1_000 }
    }).compactEvidence({ evidenceId });
    expect(withNewOptions.artifactId).not.toBe(base.artifactId);

    expect(artifactCount()).toBe(3);
    expect(extractJobs()).toHaveLength(3);
  });

  test("leaves the source Evidence byte for byte unchanged", async () => {
    const evidenceId = await ingestBatch();
    const before = evidenceRow(evidenceId);
    const blobBefore = before.storage_ref ? await readFile(join(tempDir, before.storage_ref), "utf8") : null;

    await compactionService().compactEvidence({ evidenceId });

    const after = evidenceRow(evidenceId);
    expect(after.content_hash).toBe(before.content_hash);
    expect(after.content_text).toBe(before.content_text);
    expect(after.metadata_json).toBe(before.metadata_json);
    if (before.storage_ref) {
      expect(await readFile(join(tempDir, before.storage_ref), "utf8")).toBe(blobBefore);
    }
  });

  test("never writes events into the Evidence metadata", async () => {
    const evidenceId = await ingestBatch();
    await compactionService().compactEvidence({ evidenceId });

    const metadata = JSON.parse(evidenceRow(evidenceId).metadata_json) as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("events");
    expect(metadata).not.toHaveProperty("compactedEvents");
    expect(metadata).not.toHaveProperty("eventsCompacted");
  });

  test("fails the job without forging an artifact when the blob cannot be decoded", async () => {
    const malformedId = "ev_malformed";
    const malformedText = "this is not a transcript blob";
    const malformedHash = `sha256:${createHash("sha256").update(Buffer.from(malformedText, "utf8")).digest("hex")}`;
    // The hash matches, so the content passes integrity verification and the codec is what rejects it.
    client.db.prepare(
      "INSERT INTO evidence_snapshots (id, project_id, evidence_type, title, content_text, content_hash, size_bytes, metadata_json, captured_at, created_at) VALUES (?, ?, 'AGENT_OUTPUT', 'Malformed', ?, ?, ?, ?, ?, ?)"
    ).run(
      malformedId,
      projectId,
      malformedText,
      malformedHash,
      Buffer.byteLength(malformedText),
      JSON.stringify({ sessionId, stream: "desktop-sync" }),
      clockNow,
      clockNow
    );

    await expect(compactionService().compactEvidence({ evidenceId: malformedId }))
      .rejects.toMatchObject({ code: "TRANSCRIPT_CODEC_INVALID_HEADER" });

    expect(artifactCount()).toBe(0);
    expect(extractJobs()).toHaveLength(0);
  });

  test("stores a FALLBACK artifact built from the sanitized events when the provider fails", async () => {
    const evidenceId = await ingestBatch();
    const failingProvider: TranscriptCompactionProvider = {
      id: "failing",
      version: "v1",
      async compact() {
        throw new Error("provider exploded");
      }
    };

    const summary = await compactionService({ provider: failingProvider }).compactEvidence({ evidenceId });

    expect(summary).toMatchObject({ status: "FALLBACK", truncatedResults: 0, extractionJobEnqueued: true });
    const artifact = artifacts.getByIdOrThrow(summary.artifactId);
    expect(artifact.status).toBe("FALLBACK");
    expect(artifact.failureCode).toBe("AUTOMATION_JOB_FAILED");
    expect(artifact.decisions).toEqual([]);
    // The sanitized events survive verbatim, so extraction still has usable input.
    expect(artifact.events.some((event) => event.text === "please look at the file")).toBe(true);
    expect(artifact.events.some((event) => (event.text ?? "").startsWith("# AGENTS.md instructions"))).toBe(false);
    expect(artifact.events.find((event) => event.kind === "tool_result")?.text).toBe(longResult);
    expect(extractJobs()).toHaveLength(1);
  });

  test("leaves the extraction job QUEUED while no extractor handler is registered", async () => {
    const evidenceId = await ingestBatch();
    await compactionService().compactEvidence({ evidenceId });

    // A router with no handlers stands in for a daemon where the extractor has not shipped yet.
    const scheduler = new AutomationScheduler({
      repository: automation,
      dispatcher: new AutomationJobRouter(),
      clock: () => clockNow,
      setTimer: () => () => {}
    });
    scheduler.start();
    await scheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
    await scheduler.stop();

    expect(extractJobs()).toEqual([expect.objectContaining({ status: "QUEUED", attempts: 0 })]);

    // The daemon registers discovery, sync and compaction — and deliberately not extraction, so
    // the queue keeps the job until the handler that persists candidates exists.
    const daemonRouter = new AutomationJobRouter()
      .register("DISCOVER_CODEX_THREADS", async () => {})
      .register("SYNC_SESSION_TRANSCRIPT", async () => {})
      .register("COMPACT_EVIDENCE", async () => {});
    expect(daemonRouter.registeredKinds()).not.toContain("EXTRACT_EVIDENCE_CONTEXT");
  });
});

describe("evidence storage boundary", () => {
  test("stores an automatically ingested batch once, in the blob", async () => {
    const evidenceId = await ingestBatch();
    const row = evidenceRow(evidenceId);

    // The database keeps the hash and the storage reference; the payload lives only in the store.
    expect(row.content_text).toBeNull();
    expect(row.storage_ref).toBeTruthy();
    expect(await evidenceFileCount()).toBe(1);
  });

  test("decodes compaction input from the verified blob", async () => {
    const evidenceId = await ingestBatch();
    const blob = await readFile(blobPath(evidenceId), "utf8");

    expect(blob.startsWith("contextos-transcript-events.v2")).toBe(true);
    expect(evidenceRow(evidenceId).content_text).toBeNull();

    const summary = await compactionService().compactEvidence({ evidenceId });

    expect(summary.status).toBe("SUCCEEDED");
    expect(artifacts.getByIdOrThrow(summary.artifactId).events.length).toBeGreaterThan(0);
  });

  test("fails without creating an artifact when the blob was tampered with", async () => {
    const evidenceId = await ingestBatch();
    await appendFile(blobPath(evidenceId), '\n{"ordinal":99,"kind":"message","text":"injected"}\n', "utf8");

    await expect(compactionService().compactEvidence({ evidenceId }))
      .rejects.toMatchObject({ code: "CONFLICT", details: { failureCode: "CONTENT_MISMATCH" } });

    expect(artifactCount()).toBe(0);
    expect(extractJobs()).toHaveLength(0);
  });

  test("fails without creating an artifact when the blob is gone", async () => {
    const evidenceId = await ingestBatch();
    await rm(blobPath(evidenceId), { force: true });

    await expect(compactionService().compactEvidence({ evidenceId }))
      .rejects.toMatchObject({ code: "CONFLICT", details: { failureCode: "FILE_MISSING" } });

    expect(artifactCount()).toBe(0);
    expect(extractJobs()).toHaveLength(0);
  });

  test("still reads inline Evidence that has no blob", async () => {
    const inlineEvents: AgentTranscriptEvent[] = [
      { ordinal: 1, kind: "message", role: "user", text: "inline question" },
      { ordinal: 2, kind: "message", role: "assistant", text: "inline answer" }
    ];
    const identity = { projectId, sessionId, externalSessionId, parserVersion, stream: "desktop-sync" };
    const contentText = encodeTranscriptEvents(inlineEvents, identity);
    const contentHash = `sha256:${createHash("sha256").update(Buffer.from(contentText, "utf8")).digest("hex")}`;

    const inlineId = "ev_inline";
    client.db.prepare(
      "INSERT INTO evidence_snapshots (id, project_id, evidence_type, title, content_text, content_hash, size_bytes, metadata_json, captured_at, created_at) VALUES (?, ?, 'AGENT_OUTPUT', 'Inline', ?, ?, ?, ?, ?, ?)"
    ).run(
      inlineId,
      projectId,
      contentText,
      contentHash,
      Buffer.byteLength(contentText),
      JSON.stringify({ sessionId, externalSessionId, parserVersion, stream: "desktop-sync" }),
      clockNow,
      clockNow
    );

    const summary = await compactionService().compactEvidence({ evidenceId: inlineId });

    expect(summary.status).toBe("SUCCEEDED");
    expect(artifacts.getByIdOrThrow(summary.artifactId).events).toEqual(inlineEvents);
  });

  test("leaves the blob byte for byte unchanged after compaction", async () => {
    const evidenceId = await ingestBatch();
    const path = blobPath(evidenceId);
    const before = await readFile(path, "utf8");
    const hashBefore = evidenceRow(evidenceId).content_hash;

    await compactionService().compactEvidence({ evidenceId });

    expect(await readFile(path, "utf8")).toBe(before);
    expect(evidenceRow(evidenceId).content_hash).toBe(hashBefore);
    expect(await evidenceFileCount()).toBe(1);
  });
});
