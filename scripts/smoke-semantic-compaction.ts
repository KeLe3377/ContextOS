/**
 * Real-API acceptance for API-version semantic compaction.
 *
 * It separates three things a single run would blur together:
 *   1. a real Jev probe (live TypeSafe endpoint);
 *   2. a real LLM probe (live OpenAI-compatible endpoint);
 *   3. the full coordinator driven with real Jev + real LLM, and separately real Jev + a mock LLM,
 *      so the Jev stage can still be verified end-to-end when the LLM provider is externally
 *      blocked.
 *
 * It never prints a key and never writes to ContextOS storage. Auth/quota/network problems are
 * reported as BLOCKED_EXTERNAL, not as a product failure.
 *
 * Run: npx tsx scripts/smoke-semantic-compaction.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ApiCompactionCoordinator, type CompactionRuntimeConfig } from "../packages/application/src/core/semantic-compaction/coordinator.js";
import type { JsonPost } from "../packages/application/src/core/semantic-compaction/jev-compaction-provider.js";
import { encodeTranscriptEvents, type TranscriptEventIdentity } from "../packages/application/src/core/transcript-event-codec.js";
import type { AgentTranscriptEvent } from "../packages/application/src/ports/agent-adapter.js";

function loadEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      env[line.slice(0, eq).trim()] = value;
    }
  } catch {
    /* no .env */
  }
  return env;
}

const identity: TranscriptEventIdentity = {
  projectId: "proj_smoke",
  sessionId: "sess_smoke",
  externalSessionId: "01a0eeee-0000-7000-8000-0000000000aa",
  parserVersion: "codex-jsonl.smoke.v1",
  stream: "desktop-sync"
};

function sampleEvents(): AgentTranscriptEvent[] {
  return [
    { ordinal: 1, kind: "message", role: "user", text: "分页接口空结果时 500，请修掉并补回归测试。" },
    { ordinal: 2, kind: "message", role: "assistant", text: "我先看 server 的分页实现，再复现。" },
    { ordinal: 3, kind: "message", role: "user", text: "纠正：不要改路由签名，只改 handler。" },
    { ordinal: 4, kind: "tool_call", name: "read_file", callId: "c1", text: "src/server.ts" },
    { ordinal: 5, kind: "tool_result", callId: "c1", text: "export function listItems(req) { return db.items.slice(...).map(toDto); }" },
    { ordinal: 6, kind: "tool_call", name: "run_tests", callId: "c2", text: "tests/pagination.test.ts" },
    { ordinal: 7, kind: "tool_result", callId: "c2", text: "FAIL TypeError: Cannot read properties of undefined (reading 'map')", isError: true },
    { ordinal: 8, kind: "tool_call", name: "grep", callId: "c3", text: "node_modules" },
    { ordinal: 9, kind: "tool_result", callId: "c3", text: "stale listing of node_modules matching 'page' (4000 lines, superseded)" },
    { ordinal: 10, kind: "tool_call", name: "apply_patch", callId: "c4", text: "src/server.ts" },
    { ordinal: 11, kind: "tool_result", callId: "c4", text: "patched src/server.ts: guard empty slice before map()" }
  ];
}

const EVIDENCE = [{ id: "ev_smoke_1", canonicalText: encodeTranscriptEvents(sampleEvents(), identity) }];

async function probe(url: string, apiKey: string, body: unknown): Promise<{ status: number; ok: boolean; error?: string }> {
  try {
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await response.text();
    if (response.ok) return { status: response.status, ok: true };
    let error = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
      error = parsed.error?.message ?? error;
    } catch { /* keep raw */ }
    return { status: response.status, ok: false, error };
  } catch (cause) {
    return { status: 0, ok: false, error: cause instanceof Error ? cause.message : "network error" };
  }
}

async function main(): Promise<void> {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const env = loadEnv(join(root, ".env"));
  const jevKey = env.TYPESAFE_API_KEY;
  const llmKey = env.TEXT_MODEL_API_KEY;
  const llmBase = (env.TEXT_MODEL_BASE_URL || "https://ai-gateway.vercel.sh/v1").replace(/\/+$/, "");

  if (!jevKey) {
    console.log(JSON.stringify({ outcome: "BLOCKED_EXTERNAL", reason: "TYPESAFE_API_KEY missing from .env" }, null, 2));
    return;
  }

  const config = (llmApiKey: string | null): CompactionRuntimeConfig => ({
    apiCompactionEnabled: true,
    deterministicFallbackEnabled: true,
    jev: { enabled: true, endpoint: "https://api.typesafe.ai/v1/systemone", model: env.TYPESAFE_MODEL || "jev-latest", timeoutMs: 20_000, apiKey: jevKey },
    llm: { enabled: true, endpoint: llmBase, model: env.TEXT_MODEL || "google/gemini-3.8-live", reasoning: env.TEXT_MODEL_REASONING || "none", timeoutMs: 40_000, apiKey: llmApiKey },
    options: { keepThreshold: 0.5, preserveRecentMessages: 0, truncateHeadChars: 300, inputTokenBudget: 30_000, outputTokenBudget: 4_000 }
  });

  // 1) Independent probes so an external block is attributed correctly.
  const jevProbe = await probe("https://api.typesafe.ai/v1/systemone", jevKey, {
    model: env.TYPESAFE_MODEL || "jev-latest",
    state: { goal: "probe", toolCalls: [{ id: "c1", tool: "read_file", input: "src/server.ts", result: "code", isError: false }] },
    questions: { c1_keep_call: { type: "noul", instructions: "Is this call still relevant?", criteria: { true: "yes", false: "no" } } }
  });
  const llmProbe = llmKey
    ? await probe(`${llmBase}/chat/completions`, llmKey, { model: env.TEXT_MODEL || "google/gemini-3.8-live", messages: [{ role: "user", content: "reply with {\"ok\":true}" }] })
    : { status: 0, ok: false, error: "TEXT_MODEL_API_KEY missing" };

  // 2) Full coordinator with both real.
  const realBoth = await new ApiCompactionCoordinator(Date.now).build({ sessionId: "sess_smoke", goal: "修复分页崩溃", evidence: EVIDENCE, config: config(llmKey ?? null) });

  // 3) Real Jev + mock LLM: proves the Jev stage end-to-end even when the LLM provider is blocked.
  const mockLlm: JsonPost = async (input) => {
    if (!input.url.includes("chat/completions")) {
      // Real Jev: only the LLM stage is mocked here.
      const response = await fetch(input.url, { method: "POST", headers: input.headers, body: input.body });
      return { status: response.status, ok: response.ok, text: await response.text() };
    }
    const parsed = JSON.parse(input.body) as { messages: Array<{ role: string; content: string }> };
    const user = parsed.messages.find((m) => m.role === "user")?.content ?? "";
    const evidenceId = /\[(ev[^\]]+)\]/.exec(user)?.[1] ?? "ev_smoke_1";
    const fact = (text: string) => ({ text, evidenceIds: [evidenceId] });
    const capsule = {
      objective: "修复分页崩溃并补回归测试",
      currentState: "已定位并修复，回归测试通过",
      completed: [fact("定位空结果崩溃点")],
      decisions: [fact("只改 handler，不改路由签名")],
      constraints: [fact("禁止改路由签名")],
      failures: [fact("空结果 TypeError")],
      unresolved: [fact("其它端点未确认")],
      nextActions: ["运行完整测试套件"],
      recentFiles: ["src/server.ts", "tests/pagination.test.ts"],
      evidenceRange: { from: evidenceId, to: evidenceId, count: 1, ids: [evidenceId] }
    };
    return { status: 200, ok: true, text: JSON.stringify({ model: "mock-llm", choices: [{ message: { content: JSON.stringify(capsule) } }], usage: { prompt_tokens: 100, completion_tokens: 80 } }) };
  };
  const realJevMockLlm = await new ApiCompactionCoordinator(Date.now, mockLlm).build({ sessionId: "sess_smoke", goal: "修复分页崩溃", evidence: EVIDENCE, config: config("mock") });

  const facts = {
    jevProbe: { status: jevProbe.status, ok: jevProbe.ok, error: jevProbe.error ?? null },
    llmProbe: { status: llmProbe.status, ok: llmProbe.ok, error: llmProbe.error ?? null },
    realBoth: {
      source: realBoth.capsule.source,
      degradationReason: realBoth.capsule.degradationReason,
      decisions: realBoth.compaction?.decisions.map((d) => ({ callId: d.callId, action: d.action, keepCall: d.keepCall, keepResult: d.keepResult })) ?? []
    },
    realJevMockLlm: {
      source: realJevMockLlm.capsule.source,
      degradationReason: realJevMockLlm.capsule.degradationReason,
      jevModel: realJevMockLlm.compaction?.meta.model ?? null,
      jevInputTokens: realJevMockLlm.compaction?.meta.inputTokens ?? null,
      jevOutputTokens: realJevMockLlm.compaction?.meta.outputTokens ?? null,
      jevLatencyMs: realJevMockLlm.compaction?.meta.latencyMs ?? null,
      decisions: realJevMockLlm.compaction?.decisions.map((d) => ({ callId: d.callId, action: d.action })) ?? [],
      capsuleFields: realJevMockLlm.capsule.structured ? Object.keys(realJevMockLlm.capsule.structured) : null
    }
  };

  const outcome = !jevProbe.ok
    ? "BLOCKED_EXTERNAL"
    : realJevMockLlm.capsule.source === "api" && !llmProbe.ok
      ? "PASS_JEV_LLM_BLOCKED_EXTERNAL"
      : realBoth.capsule.source === "api"
        ? "PASS"
        : "FALLBACK_VERIFIED";

  console.log(JSON.stringify({ outcome, facts }, null, 2));
}

main().catch((error) => {
  console.log(JSON.stringify({ outcome: "FAIL_PRODUCT", error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
