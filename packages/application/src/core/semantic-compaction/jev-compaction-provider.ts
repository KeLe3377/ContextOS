import type {
  CompactionOptions,
  CompactionResult,
  CompactionToolPair,
  JevCompactionProvider,
  PairDecision
} from "../../ports/semantic-compaction.js";
import { CompactionApiError } from "./errors.js";
import { buildProviderMeta } from "./meta.js";

/**
 * Jev-backed compaction provider.
 *
 * It asks the live TypeSafe/Jev endpoint two `noul` questions per tool pair: whether the call
 * still matters, and whether its full result must stay verbatim. The verdict is conservative:
 * a pair is only DROPped when *both* the call and the result are confidently low, because a
 * false deletion costs the user more than carrying some noise.
 */

export type JevProviderConfig = {
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
};

/** A single JSON POST, injected so tests never touch the network. */
export type JsonPost = (input: {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<{ status: number; ok: boolean; text: string }>;

export const defaultJsonPost: JsonPost = async (input) => {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(input.url, {
      method: "POST",
      headers: input.headers,
      body: input.body,
      signal: controller.signal
    });
    return { status: response.status, ok: response.ok, text: await response.text() };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
};

type JevResponse = {
  model?: string;
  answers: Record<string, { noul?: number }>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

const resultCapLadder = [600, 200, 80];

export class JevCompactionProviderImpl implements JevCompactionProvider {
  readonly id = "jev" as const;

  constructor(
    private readonly config: JevProviderConfig,
    private readonly clock: () => number,
    private readonly post: JsonPost = defaultJsonPost
  ) {}

  async compact(
    input: { pairs: readonly CompactionToolPair[]; options: CompactionOptions },
    signal?: AbortSignal
  ): Promise<CompactionResult> {
    const { options } = input;
    if (input.pairs.length === 0) {
      return {
        decisions: [],
        pairs: [],
        stats: { pairs: 0, keepFull: 0, keepCallOnly: 0, drop: 0, charsBefore: 0, charsAfter: 0 },
        meta: buildProviderMeta({ provider: this.id, model: this.config.model, now: this.clock() })
      };
    }

    const state = this.fitState(input.pairs, options);
    const questions = buildQuestions(input.pairs);
    const startedAt = this.clock();
    const response = await this.request(state, questions, signal);
    const latencyMs = this.clock() - startedAt;

    const decisions: PairDecision[] = [];
    const pairs: (CompactionToolPair & { action: "KEEP_FULL" | "KEEP_CALL_ONLY" | "DROP" })[] = [];
    let charsBefore = 0;
    let charsAfter = 0;

    for (const pair of input.pairs) {
      const keepCall = response.answers[`${pair.callId}_keep_call`]?.noul ?? 0;
      const keepResult = response.answers[`${pair.callId}_keep_result`]?.noul ?? 0;
      const { action, reason } = decide(pair, keepCall, keepResult, options.keepThreshold);
      decisions.push({ callId: pair.callId, action, reason, keepCall, keepResult });
      pairs.push({ ...pair, action });
      charsBefore += pair.resultText.length;
      charsAfter += action === "DROP" ? 0 : action === "KEEP_CALL_ONLY" ? Math.min(pair.resultText.length, options.truncateHeadChars) : pair.resultText.length;
    }

    return {
      decisions,
      pairs,
      stats: {
        pairs: input.pairs.length,
        keepFull: decisions.filter((d) => d.action === "KEEP_FULL").length,
        keepCallOnly: decisions.filter((d) => d.action === "KEEP_CALL_ONLY").length,
        drop: decisions.filter((d) => d.action === "DROP").length,
        charsBefore,
        charsAfter
      },
      meta: buildProviderMeta({
        provider: this.id,
        model: response.model ?? this.config.model,
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
        latencyMs,
        now: this.clock()
      })
    };
  }

  /** Picks the largest per-result cap whose state still fits the input token budget. */
  private fitState(pairs: readonly CompactionToolPair[], options: CompactionOptions): unknown {
    for (const cap of resultCapLadder) {
      const state = buildState(pairs, cap);
      if (estimateTokens(JSON.stringify(state)) <= options.inputTokenBudget) return state;
    }
    throw new CompactionApiError("TOKEN_BUDGET_EXCEEDED", "Jev state exceeds the input token budget");
  }

  private async request(state: unknown, questions: unknown, signal?: AbortSignal): Promise<JevResponse> {
    const body = JSON.stringify({ model: this.config.model, state, questions });
    const maxAttempts = 3;
    let lastStatus = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let result: { status: number; ok: boolean; text: string };
      try {
        result = await this.post(
          {
            url: this.config.endpoint,
            headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
            body,
            timeoutMs: this.config.timeoutMs,
            signal
          }
        );
      } catch (error) {
        if (signal?.aborted) throw new CompactionApiError("TIMEOUT", "Jev request aborted");
        if (error instanceof Error && error.name === "AbortError") throw new CompactionApiError("TIMEOUT", "Jev request timed out");
        throw new CompactionApiError("PROVIDER_ERROR", error instanceof Error ? error.message : "Jev request failed");
      }
      lastStatus = result.status;
      if (result.ok) return parseJevBody(result.text);
      if (result.status === 429 || result.status === 529) {
        if (attempt < maxAttempts) {
          await sleep(300 * 2 ** (attempt - 1));
          continue;
        }
        throw new CompactionApiError("RATE_LIMITED", `Jev rate limited (${result.status})`);
      }
      throw new CompactionApiError("HTTP_ERROR", `Jev request failed (${result.status})`);
    }
    throw new CompactionApiError("RATE_LIMITED", `Jev retries exhausted (${lastStatus})`);
  }
}

function parseJevBody(text: string): JevResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CompactionApiError("INVALID_JSON", "Jev returned malformed JSON");
  }
  if (!parsed || typeof parsed !== "object" || !("answers" in parsed) || (parsed as JevResponse).answers === null || typeof (parsed as JevResponse).answers !== "object") {
    throw new CompactionApiError("SCHEMA_INVALID", "Jev response is missing answers");
  }
  return parsed as JevResponse;
}

function buildState(pairs: readonly CompactionToolPair[], cap: number): unknown {
  return {
    goal: "Continue the captured agent session with the context it needs.",
    toolCalls: pairs.map((pair) => ({
      id: pair.callId,
      tool: pair.tool,
      input: pair.inputSummary,
      result: pair.resultText.slice(0, cap),
      isError: pair.isError
    }))
  };
}

function buildQuestions(pairs: readonly CompactionToolPair[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const pair of pairs) {
    const view = { tool: pair.tool, input: pair.inputSummary, result: pair.resultText.slice(0, 600), isError: pair.isError };
    questions[`${pair.callId}_keep_call`] = {
      type: "noul",
      instructions: {
        toolCall: view,
        question:
          "Is this tool call still worth keeping in a resume handoff? Keep it when it explains the current state, " +
          "carries a file path, command or necessary code context, records an error or failure, or documents a decision " +
          "or unfinished work. Drop it only when it is superseded, redundant or unrelated to the goal."
      },
      criteria: { true: "The call still matters for continuing the task", false: "The call is superseded, redundant or unrelated" }
    };
    questions[`${pair.callId}_keep_result`] = {
      type: "noul",
      instructions: {
        toolCall: view,
        question:
          "Does the FULL tool result still need to stay verbatim? Say yes when the result is an error, a failure, a " +
          "verification the user relies on, or the only copy of necessary code/output. Say no when the call itself is " +
          "enough and the result is verbose, stale, or reproducible."
      },
      criteria: { true: "The verbatim result must be preserved", false: "The call is enough; the result can be truncated" }
    };
  }
  return questions;
}

function decide(
  pair: CompactionToolPair,
  keepCall: number,
  keepResult: number,
  threshold: number
): { action: "KEEP_FULL" | "KEEP_CALL_ONLY" | "DROP"; reason: PairDecision["reason"] } {
  if (pair.pinned) return { action: "KEEP_FULL", reason: "pinned" };
  if (pair.isError) return { action: "KEEP_FULL", reason: "protected_failure" };
  const callKept = keepCall >= threshold;
  const resultKept = keepResult >= threshold;
  if (callKept && resultKept) return { action: "KEEP_FULL", reason: "kept" };
  if (callKept && !resultKept) return { action: "KEEP_CALL_ONLY", reason: "result_dropped" };
  // Call is low but the result still matters: keep both rather than risk a false deletion.
  if (!callKept && resultKept) return { action: "KEEP_FULL", reason: "kept" };
  return { action: "DROP", reason: "call_dropped" };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
