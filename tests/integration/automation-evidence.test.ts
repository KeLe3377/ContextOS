import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AutomationService } from "../../packages/application/src/core/automation-service.js";
import { EvidenceSnapshotService } from "../../packages/application/src/core/context-services.js";
import { DesktopSyncService } from "../../packages/application/src/core/desktop-sync-service.js";
import type { AgentAdapter, AgentTranscriptEvent } from "../../packages/application/src/ports/agent-adapter.js";
import { AgentAdapterRegistry } from "../../packages/infrastructure/src/adapters/registry.js";
import { CodexTranscriptTailer } from "../../packages/infrastructure/src/adapters/codex-transcript-tailer.js";
import { FileEvidenceStore } from "../../packages/infrastructure/src/evidence/evidence-store.js";
import { SqliteAutomationRepository } from "../../packages/infrastructure/src/sqlite/automation-repository.js";
import { SqliteClient } from "../../packages/infrastructure/src/sqlite/client.js";
import { SqliteEvidenceSnapshotRepository } from "../../packages/infrastructure/src/sqlite/context-repositories.js";
import { SqliteReviewItemRepository, SqliteSessionRepository } from "../../packages/infrastructure/src/sqlite/core-repositories.js";
import { runMigrations } from "../../packages/infrastructure/src/sqlite/migrations.js";
import { SqliteProjectRepository } from "../../packages/infrastructure/src/sqlite/project-repository.js";
import { SqliteSessionSyncRepository } from "../../packages/infrastructure/src/sqlite/session-sync-repository.js";
import type { SessionContinuity, SessionContinuityWriter } from "../../packages/application/src/core/session-continuity.js";

const externalSessionId = "01a0dddd-0000-7000-8000-000000000001";
const pollIntervalMs = 30_000;
const parserVersion = "codex-jsonl.test.v1";

let tempDir: string;
let rolloutPath: string;
let client: SqliteClient;
let projects: SqliteProjectRepository;
let sessions: SqliteSessionRepository;
let automation: SqliteAutomationRepository;
let evidenceRepository: SqliteEvidenceSnapshotRepository;
let service: AutomationService;
let projectId: string;
let sessionId: string;
let clockNow: number;
let continuityWrites: Array<{ sessionId: string } & SessionContinuity>;

const recordingWriter: SessionContinuityWriter = {
  write: (input) => {
    continuityWrites.push(input);
  }
};

function messageRow(role: "user" | "assistant", text: string, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] }
  });
}

function createTranscriptAdapter(): AgentAdapter {
  return {
    id: "codex",
    displayName: "Codex",
    transcriptParserVersion: parserVersion,
    resolveTranscriptPath: () => rolloutPath,
    parseTranscriptRows: ({ rows, startOrdinal }: { rows: string[]; startOrdinal: number }): AgentTranscriptEvent[] => {
      const events: AgentTranscriptEvent[] = [];
      let ordinal = startOrdinal;
      for (const row of rows) {
        let parsed: { timestamp?: string; type?: string; payload?: { type?: string; role?: "user" | "assistant"; content?: Array<{ text?: string }> } };
        try {
          parsed = JSON.parse(row) as typeof parsed;
        } catch {
          continue;
        }
        if (parsed.type !== "response_item" || parsed.payload?.type !== "message") continue;
        ordinal += 1;
        events.push({
          ordinal,
          timestamp: parsed.timestamp,
          kind: "message",
          role: parsed.payload.role,
          text: parsed.payload.content?.[0]?.text
        });
      }
      return events;
    }
  } as unknown as AgentAdapter;
}

function evidenceRows() {
  return client.db.prepare(
    "SELECT id, project_id, evidence_type, title, content_text, content_hash, storage_ref, metadata_json FROM evidence_snapshots ORDER BY created_at, id"
  ).all() as Array<{
    id: string;
    project_id: string;
    evidence_type: string;
    title: string;
    content_text: string | null;
    content_hash: string;
    storage_ref: string | null;
    metadata_json: string;
  }>;
}

function compactionJobs() {
  return client.db.prepare(
    "SELECT id, status, resource_type, resource_id, idempotency_key, payload_json FROM automation_jobs WHERE kind = 'COMPACT_EVIDENCE' ORDER BY created_at, id"
  ).all() as Array<{
    id: string;
    status: string;
    resource_type: string;
    resource_id: string;
    idempotency_key: string;
    payload_json: string;
  }>;
}

/** Binds the discovered Session at an empty rollout so later appends are read from byte 0. */
async function bindAtEnd(): Promise<void> {
  await writeFile(rolloutPath, "", "utf8");
  await service.syncSessionTranscript({ sessionId });
}

async function appendMessage(text: string): Promise<void> {
  await appendFile(rolloutPath, `${messageRow("user", text, new Date(clockNow).toISOString())}\n`, "utf8");
}

async function syncOnce() {
  clockNow += pollIntervalMs;
  return service.syncSessionTranscript({ sessionId });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-evidence-"));
  rolloutPath = join(tempDir, "rollout.jsonl");
  clockNow = Math.floor(Date.now() / 1000) * 1000;
  continuityWrites = [];

  client = SqliteClient.open({ databaseFile: join(tempDir, "contextos.sqlite") });
  runMigrations(client);
  projects = new SqliteProjectRepository(client.db);
  sessions = new SqliteSessionRepository(client.db);
  const sync = new SqliteSessionSyncRepository(client.db);
  automation = new SqliteAutomationRepository(client.db);
  evidenceRepository = new SqliteEvidenceSnapshotRepository(client.db);
  const reviewItems = new SqliteReviewItemRepository(client.db);

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
  service = new AutomationService({
    projects,
    sessions,
    sync,
    reviewItems,
    automation,
    evidence: new EvidenceSnapshotService(evidenceRepository, new FileEvidenceStore(tempDir), reviewItems),
    adapters,
    desktopSync,
    resumeCapsuleWriter: recordingWriter,
    clock: () => clockNow
  });

  const project = projects.create({ name: "Evidence project", rootPath: tempDir, defaultRuleIds: [], agentAdapterIds: ["codex"] }, clockNow);
  projectId = project.id;
  automation.patchSettings(projectId, { pollIntervalMs, expectedRevision: 1 }, clockNow);
  sessionId = sessions.createDiscovered({ projectId, agentAdapterId: "codex", externalSessionId, title: "Rollout" }, clockNow).session.id;
});

afterEach(async () => {
  client.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("automatic transcript evidence", () => {
  test("stores one Evidence snapshot per batch and derives continuity from it", async () => {
    await bindAtEnd();
    await appendMessage("first message");
    const summary = await syncOnce();

    expect(summary).toMatchObject({ newEvents: 1, evidenceReused: false });
    expect(summary.evidenceId).toBeTruthy();

    const rows = evidenceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ evidence_type: "AGENT_OUTPUT", project_id: projectId });
    expect(rows[0]!.content_hash).toMatch(/^sha256:/);

    // No deferred pipeline job is queued any more; continuity is derived in the same unit.
    expect(compactionJobs()).toHaveLength(0);
    expect(continuityWrites).toEqual([
      expect.objectContaining({
        sessionId,
        evidenceSnapshotIds: [summary.evidenceId],
        nextAction: "first message"
      })
    ]);
    expect(continuityWrites[0]!.contextText).toContain("first message");
  });

  test("records provenance without copying the transcript body into metadata", async () => {
    await bindAtEnd();
    await appendMessage("SECRET-TRANSCRIPT-BODY");
    const summary = await syncOnce();

    const snapshot = evidenceRepository.getByIdOrThrow(summary.evidenceId!);
    expect(snapshot.metadata).toMatchObject({
      sessionId,
      adapterId: "codex",
      stream: "desktop-sync",
      parserVersion,
      startOrdinal: 0,
      endOrdinal: 1,
      partialLine: false,
      resetReason: null
    });
    expect(snapshot.metadata.startByteOffset).toBe(0);
    expect(snapshot.metadata.endByteOffset).toBeGreaterThan(0);

    // The body lives exactly once, in the immutable blob; the row keeps only hash and reference.
    expect(snapshot.contentText).toBeNull();
    expect(snapshot.storageRef).toMatch(new RegExp(`^evidence/${projectId}/`));
    expect(await readFile(join(tempDir, snapshot.storageRef!), "utf8")).toContain("SECRET-TRANSCRIPT-BODY");
    expect(JSON.stringify(snapshot.metadata)).not.toContain("SECRET-TRANSCRIPT-BODY");
    expect(snapshot.title).not.toContain("SECRET-TRANSCRIPT-BODY");
  });

  test("creates nothing when a sync reads no new events", async () => {
    await bindAtEnd();
    const idleBind = await syncOnce();
    expect(idleBind).toMatchObject({ newEvents: 0, evidenceId: null, evidenceReused: false });
    expect(evidenceRows()).toHaveLength(0);
    expect(compactionJobs()).toHaveLength(0);

    await appendMessage("only message");
    await syncOnce();
    expect(evidenceRows()).toHaveLength(1);
    expect(continuityWrites).toHaveLength(1);

    const idle = await syncOnce();
    expect(idle).toMatchObject({ newEvents: 0, evidenceId: null });
    expect(evidenceRows()).toHaveLength(1);
    // An empty read cannot change the excerpt.
    expect(continuityWrites).toHaveLength(1);
  });

  test("reuses the existing Evidence when the same rows are re-read after an offset reset", async () => {
    await bindAtEnd();
    await appendMessage("replayed message");
    const first = await syncOnce();
    expect(first).toMatchObject({ evidenceReused: false });
    expect(evidenceRows()).toHaveLength(1);

    // Rewind the reader the way an `offset_beyond_eof` reset does, without resetting the
    // ordinal counter: the replayed batch has different ordinals but identical content.
    client.db.prepare("UPDATE session_sync_state SET byte_offset = 0, events_ingested = 0 WHERE session_id = ?").run(sessionId);
    const replay = await syncOnce();

    expect(replay).toMatchObject({ newEvents: 1, evidenceReused: true, evidenceId: first.evidenceId });
    expect(evidenceRows()).toHaveLength(1);
    // No second continuity write: the reused Evidence was already folded into the excerpt.
    expect(continuityWrites).toHaveLength(1);
  });

  test("captures successive batches as separate Evidence rows", async () => {
    await bindAtEnd();
    await appendMessage("first batch");
    const first = await syncOnce();
    await appendMessage("second batch");
    const second = await syncOnce();

    expect(second.evidenceId).not.toBe(first.evidenceId);
    const rows = evidenceRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.content_hash)).toHaveLength(2);
    expect(rows[1]!.metadata_json).toContain('"startOrdinal":1');
    expect(rows[1]!.metadata_json).toContain('"endOrdinal":2');
    // Each new batch rebuilds the excerpt, and the newest one names both Evidence rows.
    expect(continuityWrites).toHaveLength(2);
    expect(continuityWrites[1]!.evidenceSnapshotIds).toEqual([first.evidenceId, second.evidenceId]);
    expect(continuityWrites[1]!.contextText).toContain("first batch");
    expect(continuityWrites[1]!.contextText).toContain("second batch");
  });
});
