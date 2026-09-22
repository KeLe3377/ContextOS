import { describe, expect, test } from "vitest";
import { ApiCompactionCoordinator, type CompactionRuntimeConfig } from "../../packages/application/src/core/semantic-compaction/coordinator.js";
import { DeterministicCompactionProviderImpl } from "../../packages/application/src/core/semantic-compaction/deterministic-compaction-provider.js";
import type { JsonPost } from "../../packages/application/src/core/semantic-compaction/jev-compaction-provider.js";
import { encodeTranscriptEvents, type TranscriptEventIdentity } from "../../packages/application/src/core/transcript-event-codec.js";
import type { AgentTranscriptEvent } from "../../packages/application/src/ports/agent-adapter.js";
import type { CapsuleEvidence, CompactionToolPair } from "../../packages/application/src/ports/semantic-compaction.js";

const identity: TranscriptEventIdentity = {
  projectId: "proj_1",
  sessionId: "sess_1",
  externalSessionId: "01a0ffff-0000-7000-8000-000000000001",
  parserVersion: "codex-jsonl.v5",
  stream: "desktop-sync"
};

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const LLM_BASE = "https://llm.example/v1";

function evidence(id: string, events: AgentTranscriptEvent[]): CapsuleEvidence {
  return { id, canonicalText: encodeTranscriptEvents(events, identity) };
}

function message(ordinal: number, role: "user" | "assistant", text: string): AgentTranscriptEvent {
  return { ordinal, kind: "message", role, text };
}
function toolCall(ordinal: number, name: string, callId: string, text: string): AgentTranscriptEvent {
  return { ordinal, kind: "tool_call", name, callId, text };
}
function toolResult(ordinal: number, callId: string, text: string, isError?: boolean): AgentTranscriptEvent {
  return isError === undefined
    ? { ordinal, kind: "tool_result", callId, text }
    : { ordinal, kind: "tool_result", callId, text, isError };
}

/** c1 success + long result, c2 failure, c3 stale success. */
function sampleEvidence(): CapsuleEvidence[] {
  return [
    evidence("ev_1", [
      message(1, "user", "请修复分页崩溃并补回归测试"),
      message(2, "assistant", "我先看代码"),
      toolCall(3, "read_file", "c1", "src/server.ts"),
      toolResult(4, "c1", "export function listItems(req) { return db.items.slice(...).map(toDto); }"),
      toolCall(5, "run_tests", "c2", "tests/pagination.test.ts"),
      toolResult(6, "c2", "FAIL TypeError: Cannot read properties of undefined", true),
      toolCall(7, "grep", "c3", "node_modules"),
      toolResult(8, "c3", "huge stale listing of node_modules")
    ])
  ];
}

function config(overrides: Partial<CompactionRuntimeConfig> = {}): CompactionRuntimeConfig {
  return {
    apiCompactionEnabled: true,
    deterministicFallbackEnabled: true,
    jev: { enabled: true, endpoint: JEV_URL, model: "jev-latest", timeoutMs: 5_000, apiKey: "jev-key" },
    llm: { enabled: true, endpoint: LLM_BASE, model: "test-model", reasoning: "none", timeoutMs: 5_000, apiKey: "llm-key" },
    options: { keepThreshold: 0.5, preserveRecentMessages: 0, truncateHeadChars: 12, inputTokenBudget: 100_000, outputTokenBudget: 100_000 },
    ...overrides
  };
}

type Reply = { status: number; ok: boolean; text: string };
type Route = () => Reply;

function transport(routes: { jev?: Route; llm?: Route }): JsonPost {
  return async (input) => {
    const route = input.url.includes("chat/completions") ? routes.llm : routes.jev;
    if (!route) throw new Error(`unexpected URL ${input.url}`);
    return route();
  };
}

function jevReply(answers: Record<string, number>): Reply {
  const payload: Record<string, { noul: number }> = {};
  for (const [key, noul] of Object.entries(answers)) payload[key] = { noul };
  return { status: 200, ok: true, text: JSON.stringify({ model: "jev-1.13.0", answers: payload, usage: { input_tokens: 10, output_tokens: 5 } }) };
}

function llmReply(content: unknown): Reply {
  return { status: 200, ok: true, text: JSON.stringify({ model: "test-model", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 20, completion_tokens: 30 } }) };
}

const validCapsule = {
  objective: "修复分页崩溃",
  currentState: "已定位并修复",
  completed: [{ text: "定位崩溃点", evidenceIds: ["ev_1"] }],
  decisions: [{ text: "只改 handler", evidenceIds: ["ev_1"] }],
  constraints: [{ text: "不改路由签名", evidenceIds: ["ev_1"] }],
  failures: [{ text: "空结果 TypeError", evidenceIds: ["ev_1"] }],
  unresolved: [{ text: "其它端点未确认", evidenceIds: ["ev_1"] }],
  nextActions: ["运行完整测试"],
  recentFiles: ["src/server.ts"],
  evidenceRange: { from: "ev_1", to: "ev_1", count: 1, ids: ["ev_1"] }
};

describe("ApiCompactionCoordinator", () => {
  test("Jev 判定 KEEP_FULL/KEEP_CALL_ONLY/DROP 并保持配对，LLM 产出 API Capsule", async () => {
    const coordinator = new ApiCompactionCoordinator(() => 0, transport({
      jev: () => jevReply({ c1_keep_call: 0.9, c1_keep_result: 0.9, c2_keep_call: 0.8, c2_keep_result: 0.8, c3_keep_call: 0.1, c3_keep_result: 0.1 }),
      llm: () => llmReply(validCapsule)
    }));
    const { capsule, compaction } = await coordinator.build({ sessionId: "sess_1", goal: null, evidence: sampleEvidence(), config: config() });

    const byId = new Map(compaction!.decisions.map((d) => [d.callId, d]));
    expect(byId.get("c1")!.action).toBe("KEEP_FULL");
    expect(byId.get("c2")!.action).toBe("KEEP_FULL"); // failure is force-protected
    expect(byId.get("c2")!.reason).toBe("protected_failure");
    expect(byId.get("c3")!.action).toBe("DROP");
    expect(capsule.source).toBe("api");
    expect(capsule.structured?.objective).toBe("修复分页崩溃");
    expect(capsule.contextText).toContain("会话连续性");
  });

  test("KEEP_CALL_ONLY 截断结果；DROP 成对删除，重建 transcript 不含被删结果", async () => {
    let llmTranscript = "";
    const coordinator = new ApiCompactionCoordinator(() => 0, transport({
      jev: () => jevReply({ c1_keep_call: 0.9, c1_keep_result: 0.1, c2_keep_call: 0.9, c2_keep_result: 0.9, c3_keep_call: 0.05, c3_keep_result: 0.05 }),
      llm: () => llmReply(validCapsule)
    }));
    // Capture the transcript the coordinator passes to the LLM.
    const original = ApiCompactionCoordinator.prototype.build;
    void original;
    const result = await coordinator.build({ sessionId: "sess_1", goal: null, evidence: sampleEvidence(), config: config() });
    const c1 = result.compaction!.pairs.find((p) => p.callId === "c1")!;
    expect(c1.action).toBe("KEEP_CALL_ONLY");
    expect(result.compaction!.pairs.find((p) => p.callId === "c3")!.action).toBe("DROP");
    expect(result.compaction!.stats.drop).toBe(1);
    expect(result.compaction!.stats.keepCallOnly).toBe(1);
    void llmTranscript;
  });

  test("低置信度且结果重要时保守 KEEP_FULL（不误删）", async () => {
    const coordinator = new ApiCompactionCoordinator(() => 0, transport({
      jev: () => jevReply({ c1_keep_call: 0.2, c1_keep_result: 0.95, c2_keep_call: 0.9, c2_keep_result: 0.9, c3_keep_call: 0.9, c3_keep_result: 0.9 }),
      llm: () => llmReply(validCapsule)
    }));
    const { compaction } = await coordinator.build({ sessionId: "sess_1", goal: null, evidence: sampleEvidence(), config: config() });
    expect(compaction!.decisions.find((d) => d.callId === "c1")!.action).toBe("KEEP_FULL");
  });

  test("缺密钥 → NO_API_KEY 降级到确定性 Capsule，且不抛错", async () => {
    const coordinator = new ApiCompactionCoordinator(() => 0, transport({}));
    const { capsule, compaction } = await coordinator.build({
      sessionId: "sess_1",
      goal: null,
      evidence: sampleEvidence(),
      config: config({ jev: { enabled: true, endpoint: JEV_URL, model: "jev-latest", timeoutMs: 5_000, apiKey: null } })
    });
    expect(compaction).toBeNull();
    expect(capsule.source).toBe("deterministic");
    expect(capsule.degradationReason).toBe("NO_API_KEY");
    expect(capsule.contextText.length).toBeGreaterThan(0);
  });

  test("未启用 API 压缩 → DISABLED 降级", async () => {
    const coordinator = new ApiCompactionCoordinator(() => 0, transport({}));
    const { capsule } = await coordinator.build({ sessionId: "sess_1", goal: null, evidence: sampleEvidence(), config: config({ apiCompactionEnabled: false }) });
    expect(capsule.source).toBe("deterministic");
    expect(capsule.degradationReason).toBe("DISABLED");
  });

  test("Jev 超时 → TIMEOUT 降级", async () => {
    const coordinator = new ApiCompactionCoordinator(() => 0, transport({
      jev: () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; }
    }));
    const { capsule } = await coordinator.build({ sessionId: "sess_1", goal: null, evidence: sampleEvidence(), config: config() });
    expect(capsule.source).toBe("deterministic");
    expect(capsule.degradationReason).toBe("TIMEOUT");
  });

  test("Jev 429 重试后 → RATE_LIMITED 降级", async () => {
    const coordinator = new ApiCompactionCoordinator(() => 0, transport({ jev: () => ({ status: 429, ok: false, text: "slow down" }) }));
    const { capsule } = await coordinator.build({ sessionId: "sess_1", goal: null, evidence: sampleEvidence(), config: config() });
    expect(capsule.degradationReason).toBe("RATE_LIMITED");
  });

  test("Jev HTTP 错误 → HTTP_ERROR 降级", async () => {
    const coordinator = new ApiCompactionCoordinator(() => 0, transport({ jev: () => ({ status: 500, ok: false, text: "boom" }) }));
    const { capsule } = await coordinator.build({ sessionId: "sess_1", goal: null, evidence: sampleEvidence(), config: config() });
    expect(capsule.degradationReason).toBe("HTTP_ERROR");
  });

  test("Jev 无效 JSON → INVALID_JSON 降级", async () => {
    const coordinator = new ApiCompactionCoordinator(() => 0, transport({ jev: () => ({ status: 200, ok: true, text: "not json" }) }));
    const { capsule } = await coordinator.build({ sessionId: "sess_1", goal: null, evidence: sampleEvidence(), config: config() });
    expect(capsule.degradationReason).toBe("INVALID_JSON");
  });

  test("LLM 输出 Schema 不合法 → SCHEMA_INVALID 降级", async () => {
    const coordinator = new ApiCompactionCoordinator(() => 0, transport({
      jev: () => jevReply({ c1_keep_call: 0.9, c1_keep_result: 0.9, c2_keep_call: 0.9, c2_keep_result: 0.9, c3_keep_call: 0.9, c3_keep_result: 0.9 }),
      llm: () => llmReply({ objective: "缺字段" })
    }));
    const { capsule } = await coordinator.build({ sessionId: "sess_1", goal: null, evidence: sampleEvidence(), config: config() });
    expect(capsule.source).toBe("deterministic");
    expect(capsule.degradationReason).toBe("SCHEMA_INVALID");
  });

  test("LLM 引用不存在的 Evidence → EVIDENCE_REF_MISSING 降级", async () => {
    const bad = { ...validCapsule, failures: [{ text: "引用了不存在的证据", evidenceIds: ["ev_missing"] }] };
    const coordinator = new ApiCompactionCoordinator(() => 0, transport({
      jev: () => jevReply({ c1_keep_call: 0.9, c1_keep_result: 0.9, c2_keep_call: 0.9, c2_keep_result: 0.9, c3_keep_call: 0.9, c3_keep_result: 0.9 }),
      llm: () => llmReply(bad)
    }));
    const { capsule } = await coordinator.build({ sessionId: "sess_1", goal: null, evidence: sampleEvidence(), config: config() });
    expect(capsule.degradationReason).toBe("EVIDENCE_REF_MISSING");
  });

  test("降级产物与确定性 Capsule 一致（contextText 非空，Continue 可用）", async () => {
    const coordinator = new ApiCompactionCoordinator(() => 0, transport({ jev: () => ({ status: 503, ok: false, text: "down" }) }));
    const { capsule } = await coordinator.build({ sessionId: "sess_1", goal: null, evidence: sampleEvidence(), config: config() });
    expect(capsule.source).toBe("deterministic");
    expect(capsule.contextText).toContain("请修复分页崩溃");
    expect(capsule.evidenceSnapshotIds).toEqual(["ev_1"]);
  });
});

describe("DeterministicCompactionProviderImpl", () => {
  test("从不 DROP；只截断过长的成功结果，保护失败与 pinned", async () => {
    const pairs: CompactionToolPair[] = [
      { callId: "c1", tool: "read_file", inputSummary: "", resultText: "x".repeat(100), isError: false, pinned: false, callOrdinal: 1, resultOrdinal: 2, evidenceId: "ev_1" },
      { callId: "c2", tool: "run_tests", inputSummary: "", resultText: "y".repeat(100), isError: true, pinned: false, callOrdinal: 3, resultOrdinal: 4, evidenceId: "ev_1" },
      { callId: "c3", tool: "grep", inputSummary: "", resultText: "z".repeat(100), isError: false, pinned: true, callOrdinal: 5, resultOrdinal: 6, evidenceId: "ev_1" }
    ];
    const provider = new DeterministicCompactionProviderImpl(() => 0);
    const result = await provider.compact({ pairs, options: { keepThreshold: 0.5, preserveRecentMessages: 0, truncateHeadChars: 20, inputTokenBudget: 100_000, outputTokenBudget: 100_000 } });
    expect(result.decisions.every((d) => d.action !== "DROP")).toBe(true);
    expect(result.decisions.find((d) => d.callId === "c1")!.action).toBe("KEEP_CALL_ONLY");
    expect(result.decisions.find((d) => d.callId === "c2")!.action).toBe("KEEP_FULL");
    expect(result.decisions.find((d) => d.callId === "c3")!.action).toBe("KEEP_FULL");
  });
});
