import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AutomationService } from "../../packages/application/src/core/automation-service.js";
import { EvidenceSnapshotService } from "../../packages/application/src/core/context-services.js";
import { DesktopSyncService } from "../../packages/application/src/core/desktop-sync-service.js";
import type { SessionContinuityWriter } from "../../packages/application/src/core/session-continuity.js";
import { ApiCompactionCoordinator, type CompactionRuntimeConfig } from "../../packages/application/src/core/semantic-compaction/coordinator.js";
import type { JsonPost } from "../../packages/application/src/core/semantic-compaction/jev-compaction-provider.js";
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
import { SqliteRuntimeRepository } from "../../packages/infrastructure/src/sqlite/runtime-repository.js";
import { SqliteSessionSyncRepository } from "../../packages/infrastructure/src/sqlite/session-sync-repository.js";

const externalSessionId = "01a0dddd-0000-7000-8000-000000000002";
const pollIntervalMs = 30_000;

let tempDir: string;
let rolloutPath: string;
let client: SqliteClient;
let projects: SqliteProjectRepository;
let sessions: SqliteSessionRepository;
let sync: SqliteSessionSyncRepository;
let automation: SqliteAutomationRepository;
let runtime: SqliteRuntimeRepository;
let evidenceService: EvidenceSnapshotService;
let projectId: string;
let sessionId: string;
let clockNow: number;

function messageRow(role: "user" | "assistant", text: string, timestamp: string): string {
  return JSON.stringify({ timestamp, type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
}

function createTranscriptAdapter(): AgentAdapter {
  return {
    id: "codex",
    displayName: "Codex",
    transcriptParserVersion: "codex-jsonl.test.v1",
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
        events.push({ ordinal, timestamp: parsed.timestamp, kind: "message", role: parsed.payload.role, text: parsed.payload.content?.[0]?.text });
      }
      return events;
    }
  } as unknown as AgentAdapter;
}

function buildService(transport?: JsonPost): AutomationService {
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
  const resumeCapsuleWriter: SessionContinuityWriter = { write: (input) => runtime.writeSessionContinuity(input, clockNow) };
  const compaction = transport
    ? {
        coordinator: new ApiCompactionCoordinator(() => clockNow, transport),
        resolveConfig: (): CompactionRuntimeConfig => ({
          apiCompactionEnabled: true,
          deterministicFallbackEnabled: true,
          jev: { enabled: true, endpoint: "https://jev.test/systemone", model: "jev-latest", timeoutMs: 5_000, apiKey: "jev-key" },
          llm: { enabled: true, endpoint: "https://llm.test/v1", model: "m", reasoning: "none", timeoutMs: 5_000, apiKey: "llm-key" },
          options: { keepThreshold: 0.5, preserveRecentMessages: 6, truncateHeadChars: 300, inputTokenBudget: 100_000, outputTokenBudget: 100_000 }
        })
      }
    : undefined;
  return new AutomationService({
    projects, sessions, sync,
    reviewItems: new SqliteReviewItemRepository(client.db),
    automation, evidence: evidenceService, adapters, desktopSync, resumeCapsuleWriter,
    compaction,
    clock: () => clockNow
  });
}

/** A working LLM that cites whichever Evidence id the coordinator tagged the transcript with. */
const workingTransport: JsonPost = async (input) => {
  if (input.url.includes("chat/completions")) {
    const parsed = JSON.parse(input.body) as { messages: Array<{ role: string; content: string }> };
    const user = parsed.messages.find((m) => m.role === "user")?.content ?? "";
    const evidenceId = /\[(ev[^\]]+)\]/.exec(user)?.[1] ?? "ev_unknown";
    const fact = (text: string) => ({ text, evidenceIds: [evidenceId] });
    const capsule = {
      objective: "继续会话",
      currentState: "已捕获新事件",
      completed: [fact("已完成前置工作")],
      decisions: [fact("保持现有方案")],
      constraints: [fact("不要改接口签名")],
      failures: [fact("无")],
      unresolved: [fact("待确认后续步骤")],
      nextActions: ["继续实现"],
      recentFiles: ["src/server.ts"],
      evidenceRange: { from: evidenceId, to: evidenceId, count: 1, ids: [evidenceId] }
    };
    return { status: 200, ok: true, text: JSON.stringify({ model: "m", choices: [{ message: { content: JSON.stringify(capsule) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }) };
  }
  return { status: 200, ok: true, text: JSON.stringify({ model: "jev-latest", answers: {}, usage: {} }) };
};

const failingTransport: JsonPost = async (input) =>
  input.url.includes("chat/completions") ? { status: 500, ok: false, text: "llm down" } : { status: 500, ok: false, text: "jev down" };

async function captureOneBatch(service: AutomationService): Promise<void> {
  await writeFile(rolloutPath, [messageRow("user", "历史问题", new Date(clockNow - 5_000).toISOString()), ""].join("\n"), "utf8");
  await service.syncSessionTranscript({ sessionId }); // binds at EOF
  await appendFile(rolloutPath, [messageRow("user", "新需求：修复分页", new Date(clockNow).toISOString()), messageRow("assistant", "好的，我来处理", new Date(clockNow).toISOString()), ""].join("\n"), "utf8");
  await service.syncSessionTranscript({ sessionId }); // captures the new batch
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-semcomp-"));
  rolloutPath = join(tempDir, "rollout.jsonl");
  clockNow = Math.floor(Date.now() / 1000) * 1000;

  client = SqliteClient.open({ databaseFile: join(tempDir, "contextos.sqlite") });
  runMigrations(client);
  runtime = new SqliteRuntimeRepository(client.db);
  evidenceService = new EvidenceSnapshotService(new SqliteEvidenceSnapshotRepository(client.db), new FileEvidenceStore(tempDir), new SqliteReviewItemRepository(client.db));
  projects = new SqliteProjectRepository(client.db);
  sessions = new SqliteSessionRepository(client.db);
  sync = new SqliteSessionSyncRepository(client.db);
  automation = new SqliteAutomationRepository(client.db);

  const project = projects.create({ name: "Semantic compaction", rootPath: tempDir, defaultRuleIds: [], agentAdapterIds: ["codex"] }, clockNow);
  projectId = project.id;
  automation.patchSettings(projectId, { pollIntervalMs, expectedRevision: 1 }, clockNow);
  sessionId = sessions.createDiscovered({ projectId, agentAdapterId: "codex", externalSessionId, title: "Rollout" }, clockNow).session.id;
});

afterEach(async () => {
  client.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("semantic compaction on the sync path", () => {
  test("API 成功时 capsule.source=api，含结构化内容与可用的 contextText", async () => {
    const service = buildService(workingTransport);
    await captureOneBatch(service);
    const capsule = runtime.getResumeCapsule(sessionId);
    expect(capsule.source).toBe("api");
    expect(capsule.degradationReason).toBe(null);
    expect(capsule.structured?.objective).toBe("继续会话");
    expect(capsule.contextText).toContain("会话连续性");
    expect(capsule.meta?.provider).toBe("llm");
  });

  test("API 失败时降级到确定性 capsule，Continue 仍可用（contextText 非空、有 Evidence）", async () => {
    const service = buildService(failingTransport);
    await captureOneBatch(service);
    const capsule = runtime.getResumeCapsule(sessionId);
    expect(capsule.source).toBe("deterministic");
    expect(capsule.degradationReason).toBe("HTTP_ERROR");
    expect(capsule.structured).toBe(null);
    expect((capsule.contextText ?? "").length).toBeGreaterThan(0);
    expect(capsule.evidenceSnapshotIds.length).toBeGreaterThan(0);
  });

  test("未接入 compaction 时行为不变：capsule 有内容但 source 为空", async () => {
    const service = buildService(undefined);
    await captureOneBatch(service);
    const capsule = runtime.getResumeCapsule(sessionId);
    expect(capsule.source).toBe(null);
    expect((capsule.contextText ?? "").length).toBeGreaterThan(0);
  });
});
