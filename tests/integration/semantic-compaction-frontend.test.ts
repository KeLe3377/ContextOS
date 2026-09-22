import { describe, expect, test } from "vitest";
import {
  capsuleSourceLabel,
  compactionStatusText,
  maskedKey,
  type CompactionConfigValues
} from "../../frontend/src/semanticCompaction.js";

function config(overrides: Partial<CompactionConfigValues> = {}): CompactionConfigValues {
  return {
    apiCompactionEnabled: true,
    deterministicFallbackEnabled: true,
    jev: { enabled: true, endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", timeoutMs: 15_000, keyConfigured: true, keyHint: "1234" },
    llm: { enabled: true, endpoint: "https://ai-gateway.vercel.sh/v1", model: "m", reasoning: "none", timeoutMs: 30_000, keyConfigured: true, keyHint: "9876" },
    inputTokenBudget: 24_000,
    outputTokenBudget: 4_000,
    preserveRecentMessages: 6,
    keepThreshold: 0.5,
    truncateHeadChars: 300,
    configVersion: "v1",
    ...overrides
  };
}

describe("semantic compaction frontend contract", () => {
  test("maskedKey 只显示末四位，绝不回显完整密钥", () => {
    expect(maskedKey("1234")).toBe("••••1234");
    expect(maskedKey(null)).toBe("未配置");
    // Only a 4-char hint is ever shown, so a full key can never be reconstructed from it.
    expect(maskedKey("1234")).not.toContain("apikey");
  });

  test("状态文案区分 API / 缺密钥 / 关闭三种情况", () => {
    expect(compactionStatusText(config())).toContain("API 语义压缩已启用");
    expect(compactionStatusText(config({ apiCompactionEnabled: false }))).toContain("API 压缩已关闭");
    expect(compactionStatusText(config({ jev: { ...config().jev, keyConfigured: false } }))).toContain("缺少 API Key");
    expect(compactionStatusText(config({ llm: { ...config().llm, enabled: false } }))).toContain("已停用");
  });

  test("capsuleSourceLabel 区分 API / 确定性降级 / 未生成", () => {
    expect(capsuleSourceLabel({ source: "api" })).toBe("API 语义压缩");
    expect(capsuleSourceLabel({ source: "deterministic", degradationReason: "HTTP_ERROR" })).toBe("确定性降级（HTTP_ERROR）");
    expect(capsuleSourceLabel({ source: "deterministic" })).toBe("确定性 Capsule");
    expect(capsuleSourceLabel(null)).toBe("-");
    expect(capsuleSourceLabel({})).toBe("尚未生成");
  });
});
