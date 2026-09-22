/**
 * Pure helpers for the semantic-compaction settings screen.
 *
 * Kept free of JSX so the shared contract (status text, masked key) can be unit-tested in the
 * node test environment, exactly like the automation frontend contract.
 */

/** Mirrors the non-secret `compactionConfig` view returned by `GET /api/settings`. */
export type CompactionConfigValues = {
  apiCompactionEnabled: boolean;
  deterministicFallbackEnabled: boolean;
  jev: { enabled: boolean; endpoint: string; model: string; timeoutMs: number; keyConfigured: boolean; keyHint: string | null };
  llm: { enabled: boolean; endpoint: string; model: string; reasoning: string; timeoutMs: number; keyConfigured: boolean; keyHint: string | null };
  inputTokenBudget: number;
  outputTokenBudget: number;
  preserveRecentMessages: number;
  keepThreshold: number;
  truncateHeadChars: number;
  configVersion: string;
};

/** `••••abcd` for a saved key; never the key itself. */
export function maskedKey(hint: string | null): string {
  return hint ? `••••${hint}` : "未配置";
}

/** The one line that tells the user which capsule Continue will use, and why. */
export function compactionStatusText(config: CompactionConfigValues): string {
  if (!config.apiCompactionEnabled) return "API 压缩已关闭：Continue 使用确定性 Capsule";
  if (!config.jev.keyConfigured || !config.llm.keyConfigured) return "缺少 API Key：Continue 使用确定性 Capsule";
  if (!config.jev.enabled || !config.llm.enabled) return "已停用 Jev 或 LLM：Continue 使用确定性 Capsule";
  return "API 语义压缩已启用：Jev + LLM 生成 Capsule";
}

/** Human-readable label for the capsule source shown on a session. */
export function capsuleSourceLabel(capsule: { source?: string | null; degradationReason?: string | null } | null | undefined): string {
  if (!capsule) return "-";
  if (capsule.source === "api") return "API 语义压缩";
  if (capsule.source === "deterministic") {
    return capsule.degradationReason ? `确定性降级（${capsule.degradationReason}）` : "确定性 Capsule";
  }
  return "尚未生成";
}
