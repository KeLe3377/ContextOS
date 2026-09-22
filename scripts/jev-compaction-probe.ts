/**
 * Real-Jev probe for the API-version session compaction design.
 *
 * It answers one question only: given a desensitised, mixed CN/EN agent conversation,
 * does the live TypeSafe/Jev endpoint correctly classify each tool call + result pair
 * into KEEP_FULL / KEEP_CALL_ONLY / DROP while protecting the things a resume must keep?
 *
 * It is a probe, not the product path: it reads the key from the repo-root `.env`
 * (gitignored), prints no secret and no credential, and never writes to ContextOS storage.
 *
 * Run: npx tsx scripts/jev-compaction-probe.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";

type ToolCall = {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
  /** Recent messages and the opening request are never candidates. */
  pinned: boolean;
};

type Decision = "KEEP_FULL" | "KEEP_CALL_ONLY" | "DROP";

type PairDecision = {
  id: string;
  tool: string;
  pinned: boolean;
  isError: boolean;
  keepCall: number;
  keepResult: number;
  decision: Decision;
  reason: string;
};

function loadEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return env;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/** Desensitised, mixed CN/EN conversation. Synthetic paths only, no real secrets. */
function sampleConversation(): { goal: string; recentMessages: { role: string; text: string }[]; toolCalls: ToolCall[] } {
  return {
    goal: "修复 API 分页在空结果时的崩溃，并让测试通过（Fix pagination crash on empty result and make tests pass）.",
    recentMessages: [
      { role: "user", text: "分页接口在空结果时会 500，请修掉，并补一条回归测试。" },
      { role: "assistant", text: "我先看 server 的分页实现，再跑测试复现。" },
      { role: "user", text: "纠正：不要改路由签名，只改 handler 内部逻辑。" },
      { role: "assistant", text: "明白，只改 handler，不动路由签名。已定位到空数组时的 undefined 访问。" },
      { role: "user", text: "好，改完跑一遍测试。" }
    ],
    toolCalls: [
      {
        id: "t1",
        tool: "read_file",
        input: { path: "src/server.ts" },
        result: "export function listItems(req) { const page = req.query.page; return db.items.slice(page * 20, (page + 1) * 20).map(toDto); } // 分页在 page=0 且结果为空时返回 undefined",
        isError: false,
        pinned: false
      },
      {
        id: "t2",
        tool: "run_tests",
        input: { pattern: "tests/pagination.test.ts" },
        result: "FAIL tests/pagination.test.ts > returns empty page\nTypeError: Cannot read properties of undefined (reading 'map')\n  at listItems (src/server.ts:12:61)\n1 failed, 0 passed",
        isError: true,
        pinned: false
      },
      {
        id: "t3",
        tool: "grep",
        input: { pattern: "page", path: "node_modules" },
        result: "(huge successful listing of 4000+ lines from node_modules matching 'page'; no longer relevant after the bug was located in src/server.ts)",
        isError: false,
        pinned: false
      },
      {
        id: "t4",
        tool: "apply_patch",
        input: { path: "src/server.ts" },
        result: "patched src/server.ts: guard empty slice before map(); added fallback to []",
        isError: false,
        pinned: false
      },
      {
        id: "t5",
        tool: "run_tests",
        input: { pattern: "tests/pagination.test.ts" },
        result: "PASS tests/pagination.test.ts > returns empty page\n1 passed, 0 failed",
        isError: false,
        pinned: false
      }
    ]
  };
}

function buildQuestions(toolCalls: ToolCall[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const call of toolCalls) {
    if (call.pinned) continue;
    const toolCallView = {
      tool: call.tool,
      input: call.input,
      result: call.result.slice(0, 600),
      isError: call.isError
    };
    questions[`${call.id}_keep_call`] = {
      type: "noul",
      instructions: {
        toolCall: toolCallView,
        question:
          "Is this tool call still worth keeping in a resume handoff? Keep it when it explains the current state, " +
          "carries a file path, command or necessary code context, records an error or failure, or documents a decision " +
          "or unfinished work. Drop it only when it is superseded, redundant, or unrelated to the goal."
      },
      criteria: {
        true: "The call still matters for continuing the task",
        false: "The call is superseded, redundant or unrelated"
      }
    };
    questions[`${call.id}_keep_result`] = {
      type: "noul",
      instructions: {
        toolCall: toolCallView,
        question:
          "Does the FULL tool result still need to stay verbatim? Say yes when the result is an error, a failure, a " +
          "verification the user relies on, or the only copy of necessary code/output. Say no when the call itself is " +
          "enough and the result is verbose, stale, or reproducible."
      },
      criteria: {
        true: "The verbatim result must be preserved",
        false: "The call is enough; the result can be truncated"
      }
    };
  }
  return questions;
}

function decide(call: ToolCall, keepCall: number, keepResult: number, threshold: number): PairDecision {
  if (call.pinned) {
    return { id: call.id, tool: call.tool, pinned: true, isError: call.isError, keepCall, keepResult, decision: "KEEP_FULL", reason: "pinned" };
  }
  if (call.isError) {
    return { id: call.id, tool: call.tool, pinned: false, isError: true, keepCall, keepResult, decision: "KEEP_FULL", reason: "protected_failure" };
  }
  if (keepCall >= threshold && keepResult >= threshold) {
    return { id: call.id, tool: call.tool, pinned: false, isError: false, keepCall, keepResult, decision: "KEEP_FULL", reason: "kept" };
  }
  if (keepCall >= threshold) {
    return { id: call.id, tool: call.tool, pinned: false, isError: false, keepCall, keepResult, decision: "KEEP_CALL_ONLY", reason: "result_dropped" };
  }
  return { id: call.id, tool: call.tool, pinned: false, isError: false, keepCall, keepResult, decision: "DROP", reason: "call_dropped" };
}

async function askJev(url: string, apiKey: string, model: string, state: unknown, questions: unknown): Promise<{ answers: Record<string, { noul?: number }>; usage?: { input_tokens?: number; output_tokens?: number } }> {
  const maxAttempts = 4;
  let attempt = 0;
  let lastError = "";
  while (attempt < maxAttempts) {
    attempt += 1;
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, state, questions })
    });
    const text = await response.text();
    if (response.ok) {
      try {
        return JSON.parse(text);
      } catch {
        throw new Error("Jev returned malformed JSON");
      }
    }
    lastError = `HTTP ${response.status}: ${text.slice(0, 200)}`;
    if (response.status === 429 || response.status === 529) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      continue;
    }
    throw new Error(lastError);
  }
  throw new Error(`Jev retries exhausted: ${lastError}`);
}

async function main(): Promise<void> {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const env = loadEnv(join(root, ".env"));
  const apiKey = env.TYPESAFE_API_KEY;
  const model = env.TYPESAFE_MODEL || "jev-latest";
  if (!apiKey) {
    console.log(JSON.stringify({ ok: false, blocked: "NO_API_KEY", note: "TYPESAFE_API_KEY missing from repo-root .env" }, null, 2));
    return;
  }

  const sample = sampleConversation();
  const questions = buildQuestions(sample.toolCalls);
  const state = {
    goal: sample.goal,
    recentMessages: sample.recentMessages,
    toolCalls: sample.toolCalls.map((call) => ({
      id: call.id,
      tool: call.tool,
      input: call.input,
      result: call.result.slice(0, 600),
      isError: call.isError
    }))
  };

  const threshold = 0.5;
  const startedAt = Date.now();
  const response = await askJev(SYSTEM_ONE_URL, apiKey, model, state, questions);
  const latencyMs = Date.now() - startedAt;

  const decisions: PairDecision[] = sample.toolCalls.map((call) => {
    const keepCall = response.answers[`${call.id}_keep_call`]?.noul ?? 0;
    const keepResult = response.answers[`${call.id}_keep_result`]?.noul ?? 0;
    return decide(call, keepCall, keepResult, threshold);
  });

  const charsBefore = sample.toolCalls.reduce((sum, call) => sum + call.result.length, 0);
  const charsAfter = sample.toolCalls.reduce((sum, call) => {
    const decision = decisions.find((d) => d.id === call.id)!;
    if (decision.decision === "DROP") return sum;
    if (decision.decision === "KEEP_CALL_ONLY") return sum + 300;
    return sum + call.result.length;
  }, 0);

  const result = {
    ok: true,
    provider: "typesafe-jev",
    endpoint: SYSTEM_ONE_URL,
    model: response.model ?? model,
    threshold,
    latencyMs,
    usage: response.usage ?? null,
    decisions,
    stats: {
      pairs: sample.toolCalls.length,
      keepFull: decisions.filter((d) => d.decision === "KEEP_FULL").length,
      keepCallOnly: decisions.filter((d) => d.decision === "KEEP_CALL_ONLY").length,
      drop: decisions.filter((d) => d.decision === "DROP").length,
      charsBefore,
      charsAfter,
      compressionRatio: Number((1 - charsAfter / charsBefore).toFixed(3))
    }
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
