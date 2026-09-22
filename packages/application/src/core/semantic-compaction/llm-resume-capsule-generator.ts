import {
  structuredResumeCapsuleSchema,
  type StructuredResumeCapsule
} from "../../../../contracts/src/semantic-compaction.js";
import type { CapsuleInput, CapsuleResult, ResumeCapsuleGenerator } from "../../ports/semantic-compaction.js";
import { CompactionApiError } from "./errors.js";
import { buildProviderMeta } from "./meta.js";
import { defaultJsonPost, type JsonPost } from "./jev-compaction-provider.js";

/**
 * LLM-backed Resume Capsule generator.
 *
 * It receives the reconstructed (post-Jev) transcript, each line tagged with the Evidence id it
 * came from, and must return the structured Chinese capsule. Everything it returns is validated:
 * strict schema, every cited Evidence id must exist, and the response must fit the output token
 * budget. Any violation raises, and the coordinator falls back to the deterministic capsule.
 */

export type LlmProviderConfig = {
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  reasoning: string;
};

export class LlmResumeCapsuleGeneratorImpl implements ResumeCapsuleGenerator {
  readonly id = "llm" as const;

  constructor(
    private readonly config: LlmProviderConfig,
    private readonly clock: () => number,
    private readonly post: JsonPost = defaultJsonPost
  ) {}

  async generate(input: CapsuleInput, signal?: AbortSignal): Promise<CapsuleResult> {
    const evidenceIds = new Set(input.evidence.map((snapshot) => snapshot.id));
    const transcript = input.transcript ?? "";
    if (estimateTokens(transcript) > input.options.inputTokenBudget) {
      throw new CompactionApiError("TOKEN_BUDGET_EXCEEDED", "Compacted transcript exceeds the input token budget");
    }

    const startedAt = this.clock();
    const response = await this.request(transcript, input, signal);
    const latencyMs = this.clock() - startedAt;

    const structured = this.parseAndValidate(response.content, evidenceIds);
    const outputTokens = response.outputTokens ?? estimateTokens(JSON.stringify(structured));
    if (outputTokens > input.options.outputTokenBudget) {
      throw new CompactionApiError("TOKEN_BUDGET_EXCEEDED", "LLM capsule exceeds the output token budget");
    }

    return {
      source: "api",
      structured,
      summary: bound(structured.objective, 500),
      nextAction: structured.nextActions[0] ? bound(structured.nextActions[0], 500) : null,
      contextText: renderStructuredCapsule(structured),
      evidenceSnapshotIds: [...evidenceIds],
      meta: buildProviderMeta({
        provider: this.id,
        model: response.model ?? this.config.model,
        inputTokens: response.inputTokens ?? estimateTokens(transcript),
        outputTokens,
        latencyMs,
        now: this.clock()
      }),
      degradationReason: null
    };
  }

  private parseAndValidate(content: string, evidenceIds: ReadonlySet<string>): StructuredResumeCapsule {
    let json: unknown;
    try {
      json = JSON.parse(stripFences(content));
    } catch {
      throw new CompactionApiError("INVALID_JSON", "LLM returned malformed JSON");
    }
    const parsed = structuredResumeCapsuleSchema.safeParse(json);
    if (!parsed.success) {
      throw new CompactionApiError("SCHEMA_INVALID", "LLM capsule failed schema validation");
    }
    const capsule = parsed.data;
    const cited = [
      ...capsule.completed,
      ...capsule.decisions,
      ...capsule.constraints,
      ...capsule.failures,
      ...capsule.unresolved
    ].flatMap((fact) => fact.evidenceIds);
    const missing = cited.filter((id) => !evidenceIds.has(id));
    if (missing.length > 0) {
      throw new CompactionApiError("EVIDENCE_REF_MISSING", `LLM cited unknown Evidence: ${missing.slice(0, 3).join(", ")}`);
    }
    return capsule;
  }

  private async request(
    transcript: string,
    input: CapsuleInput,
    signal?: AbortSignal
  ): Promise<{ content: string; model?: string; inputTokens?: number; outputTokens?: number }> {
    const body = JSON.stringify({
      model: this.config.model,
      ...reasoningField(this.config.reasoning),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `Session: ${input.sessionId}`,
            input.goal ? `Goal: ${input.goal}` : null,
            "Captured transcript (each line is prefixed with its Evidence id in [brackets]):",
            transcript
          ]
            .filter(Boolean)
            .join("\n")
        }
      ]
    });

    let result: { status: number; ok: boolean; text: string };
    try {
      result = await this.post({
        url: chatCompletionsUrl(this.config.endpoint),
        headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
        body,
        timeoutMs: this.config.timeoutMs,
        signal
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new CompactionApiError("TIMEOUT", "LLM request timed out");
      }
      throw new CompactionApiError("PROVIDER_ERROR", error instanceof Error ? error.message : "LLM request failed");
    }
    if (!result.ok) {
      const reason = result.status === 429 || result.status === 529 ? "RATE_LIMITED" : "HTTP_ERROR";
      throw new CompactionApiError(reason, `LLM request failed (${result.status})`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      throw new CompactionApiError("INVALID_JSON", "LLM returned malformed JSON envelope");
    }
    const envelope = parsed as {
      model?: string;
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = envelope.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new CompactionApiError("SCHEMA_INVALID", "LLM response has no message content");
    }
    return { content, model: envelope.model, inputTokens: envelope.usage?.prompt_tokens, outputTokens: envelope.usage?.completion_tokens };
  }
}

const SYSTEM_PROMPT = [
  "You compress an agent session into a Resume Capsule so the same session can be continued.",
  "Return ONLY strict JSON matching this shape (no markdown, no extra fields):",
  '{"objective":string,"currentState":string,"completed":Fact[],"decisions":Fact[],"constraints":Fact[],"failures":Fact[],"unresolved":Fact[],"nextActions":string[],"recentFiles":string[],"evidenceRange":{"from":string,"to":string,"count":number,"ids":string[]}}',
  "where Fact = {\"text\":string,\"evidenceIds\":string[]}.",
  "Write all text in Chinese. Every fact MUST cite the Evidence ids it came from, using the ids shown in [brackets] on each transcript line. Never invent an id.",
  "Never drop user requirements, corrections, confirmed decisions, downstream constraints, errors or failures, unfinished work, file paths, commands, or necessary code context."
].join("\n");

function renderStructuredCapsule(capsule: StructuredResumeCapsule): string {
  const section = (title: string, facts: StructuredResumeCapsule["completed"]): string[] =>
    facts.length === 0 ? [`${title}: 无`] : [`${title}:`, ...facts.map((fact) => `- ${fact.text} [${fact.evidenceIds.join(", ")}]`)];
  return [
    "## 会话连续性（API 语义压缩）",
    `目标: ${capsule.objective}`,
    `当前状态: ${capsule.currentState}`,
    ...section("已完成", capsule.completed),
    ...section("已确认决定", capsule.decisions),
    ...section("约束", capsule.constraints),
    ...section("失败与错误", capsule.failures),
    ...section("未完成", capsule.unresolved),
    capsule.nextActions.length ? `下一步:\n${capsule.nextActions.map((action) => `- ${action}`).join("\n")}` : "下一步: 无",
    capsule.recentFiles.length ? `最近文件: ${capsule.recentFiles.join(", ")}` : "最近文件: 无",
    `Evidence 范围: ${capsule.evidenceRange.from} → ${capsule.evidenceRange.to}（${capsule.evidenceRange.count} 条）`
  ].join("\n");
}

function chatCompletionsUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

/**
 * Maps the free-form `reasoning` setting onto a request field only when it is unambiguous.
 *
 * OpenAI-compatible gateways disagree on this field: some want an object, some a number, some
 * reject a bare string outright. An empty value or the literal `none` means "send nothing", and
 * a JSON object is passed through as `reasoning`; anything else is omitted rather than risking a
 * 400 that would needlessly degrade the capsule.
 */
function reasoningField(reasoning: string): Record<string, unknown> {
  const trimmed = reasoning.trim();
  if (!trimmed || trimmed === "none") return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { reasoning: parsed };
  } catch {
    // Not JSON: fall through to omission.
  }
  return {};
}

function stripFences(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? fenced[1]! : trimmed;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function bound(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
