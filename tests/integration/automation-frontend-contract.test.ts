import { describe, expect, test } from "vitest";
import {
  automationEnabledText,
  automationJobKindText,
  automationModeText,
  contextItemTypeText,
  failureCodeText,
  jobStatusText,
  latestEvidenceAt,
  latestSyncAt,
  parseAutomationSettings,
  parseAutomationStatus,
  parseDiscovery,
  validateAutomationPatch,
  watchingSessionCount
} from "../../frontend/src/automation.js";

/**
 * 前端访问层的契约测试。
 *
 * 只覆盖仍在运行路径上的能力：启用/关闭文案、任务状态、最近同步与最近捕获、发现入队。
 * 界面文案必须是中文，且不把 transcript、提示词、模型输出或本地路径带出来。
 */

const overview = {
  generatedAt: "2026-09-21T00:00:00.000Z",
  scheduler: { running: true, startedAt: null, lastTickAt: null, activeJobs: 0 },
  activeKinds: ["DISCOVER_CODEX_THREADS", "SYNC_SESSION_TRANSCRIPT"],
  jobs: { total: 2, byStatus: { QUEUED: 1, RUNNING: 0, SUCCEEDED: 1, FAILED: 0, CANCELED: 0 } },
  recentFailures: [{ id: "job_1", kind: "SYNC_SESSION_TRANSCRIPT", failureCode: "AUTOMATION_JOB_FAILED", failureMessage: "同步失败" }],
  projects: [
    { projectId: "proj_1", mode: "SUGGEST_ONLY", lastDiscoveryAt: null, lastSyncAt: "2026-09-21T00:00:01.000Z", watchingSessions: 2, lastEvidenceAt: "2026-09-21T00:00:02.000Z" },
    { projectId: "proj_2", mode: "OFF", lastDiscoveryAt: null, lastSyncAt: null, watchingSessions: 0, lastEvidenceAt: null }
  ]
};

describe("前端中文文案映射", () => {
  test("自动化只表达启用与关闭", () => {
    expect(automationEnabledText("OFF")).toBe("关闭");
    expect(automationEnabledText("SUGGEST_ONLY")).toBe("启用");
    expect(automationEnabledText("AUTO_ACCEPT_HIGH_CONFIDENCE")).toBe("启用");
    expect(automationModeText("OFF")).toBe("关闭");
    // 内部枚举不直接出现在界面上。
    for (const label of [automationEnabledText("SUGGEST_ONLY"), automationModeText("AUTO_ACCEPT_HIGH_CONFIDENCE")]) {
      expect(label).not.toMatch(/AUTO_ACCEPT_HIGH_CONFIDENCE|SUGGEST_ONLY|^OFF$/);
    }
  });

  test("任务类型与状态使用中文", () => {
    expect(automationJobKindText("DISCOVER_CODEX_THREADS")).toBe("发现 Codex 会话");
    expect(automationJobKindText("SYNC_SESSION_TRANSCRIPT")).toBe("同步会话记录");
    expect(jobStatusText("QUEUED")).toBe("排队中");
    expect(contextItemTypeText("HANDOFF")).toBe("交接信息");
  });

  test("失败码有中文解释", () => {
    expect(failureCodeText("AUTOMATION_JOB_FAILED")).toBe("自动化任务失败");
    expect(failureCodeText("FEATURE_DEFERRED")).toBe("该能力已延后，暂不可用");
    expect(failureCodeText("SOMETHING_NEW")).toBe("未知失败");
  });
});

describe("前端响应解析", () => {
  test("解析自动化设置", () => {
    const settings = parseAutomationSettings({
      id: "set_1",
      projectId: "proj_1",
      mode: "SUGGEST_ONLY",
      pollIntervalMs: 30_000,
      maxConcurrentJobs: 1,
      sourceMaxBytes: 262_144,
      autoAcceptThreshold: 0.9,
      createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
      revision: 2
    });
    expect(settings).toMatchObject({ mode: "SUGGEST_ONLY", revision: 2 });
  });

  test("解析状态汇总并派生概览数值", () => {
    const status = parseAutomationStatus(overview);
    expect(status.scheduler.running).toBe(true);
    expect(status.activeKinds).toEqual(["DISCOVER_CODEX_THREADS", "SYNC_SESSION_TRANSCRIPT"]);
    expect(status.projects).toHaveLength(2);
    expect(watchingSessionCount(status)).toBe(2);
    expect(latestSyncAt(status)).toBe("2026-09-21T00:00:01.000Z");
    expect(latestEvidenceAt(status)).toBe("2026-09-21T00:00:02.000Z");
  });

  test("状态响应里不再出现提取建议或压缩产物字段", () => {
    const status = parseAutomationStatus(overview);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("pendingCandidates");
    expect(serialized).not.toContain("lastExtractionAt");
    expect(serialized).not.toContain("COMPACT_EVIDENCE");
    expect(serialized).not.toContain("EXTRACT_EVIDENCE_CONTEXT");
  });

  test("发现响应区分已入队", () => {
    expect(parseDiscovery({ projectId: "proj_1", jobId: "job_1", created: true })).toEqual({
      projectId: "proj_1",
      jobId: "job_1",
      created: true
    });
  });

  test("轮询间隔仍受最小 5000ms 约束", () => {
    expect(() => validateAutomationPatch({ pollIntervalMs: 1_000, expectedRevision: 1 })).toThrow();
    expect(validateAutomationPatch({ pollIntervalMs: 5_000, expectedRevision: 1 })).toMatchObject({ pollIntervalMs: 5_000 });
  });
});
