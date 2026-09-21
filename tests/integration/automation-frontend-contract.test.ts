import { describe, expect, test } from "vitest";
import {
  automationModeText,
  candidateActions,
  candidateKindText,
  candidateStatusText,
  contextItemTypeText,
  failureCodeText,
  jobStatusText,
  parseApplicationResult,
  parseAutomationSettings,
  parseAutomationStatus,
  parseCandidate,
  parseCandidateList,
  parseDiscovery,
  parseReviewResolve,
  reviewTriggerText,
  safeProvenance
} from "../../frontend/src/automation.js";

/**
 * 前端访问层的契约测试。
 *
 * 重点是两件事：界面文案必须是中文，且不把 transcript、提示词、模型输出或本地路径带出来。
 */

const candidatePayload = {
  id: "cand_1",
  projectId: "proj_1",
  sessionId: "sess_1",
  sourceEvidenceId: "ev_1",
  evidenceIds: ["ev_1"],
  kind: "CONTEXT_ITEM",
  fingerprint: "sha256:abc",
  payload: { kind: "CONTEXT_ITEM", itemType: "SUMMARY", title: "标题", summary: "摘要", confidence: "HIGH" },
  confidence: 0.9,
  status: "PENDING",
  extractorId: "codex-cli",
  extractorVersion: "1.0.0",
  targetResourceType: null,
  targetResourceId: null,
  reviewedAt: null,
  supersededById: null,
  provenance: {
    sourceArtifactId: "cmp_1",
    sourceEvidenceId: "ev_1",
    extractorId: "codex-cli",
    extractorVersion: "1.0.0",
    extractionInputHash: "sha256:input"
  },
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
  revision: 1
};

describe("前端中文文案映射", () => {
  test("自动化模式不出现内部枚举", () => {
    expect(automationModeText("OFF")).toBe("关闭");
    expect(automationModeText("SUGGEST_ONLY")).toBe("仅生成建议");
    expect(automationModeText("AUTO_ACCEPT_HIGH_CONFIDENCE")).toBe("自动接受高置信度建议");
    for (const label of Object.values({
      a: automationModeText("OFF"),
      b: automationModeText("SUGGEST_ONLY"),
      c: automationModeText("AUTO_ACCEPT_HIGH_CONFIDENCE")
    })) {
      expect(label).not.toMatch(/AUTO_ACCEPT_HIGH_CONFIDENCE|SUGGEST_ONLY|^OFF$/);
    }
  });

  test("候选状态与类型使用中文", () => {
    expect(candidateStatusText("PENDING")).toBe("待审核");
    expect(candidateStatusText("ACCEPTED")).toBe("已接受");
    expect(candidateStatusText("REJECTED")).toBe("已拒绝");
    expect(candidateStatusText("SUPERSEDED")).toBe("已被取代");
    expect(candidateKindText("RESUME_CAPSULE")).toBe("恢复摘要");
    expect(candidateKindText("CONTEXT_ITEM")).toBe("上下文条目");
    expect(contextItemTypeText("OPEN_QUESTION")).toBe("待确认问题");
    expect(contextItemTypeText("HANDOFF")).toBe("交接信息");
    expect(jobStatusText("QUEUED")).toBe("排队中");
    expect(reviewTriggerText("AUTOMATION_SUGGESTION")).toBe("自动提取建议");
  });

  test("失败码有中文解释", () => {
    expect(failureCodeText("EXTRACTOR_TIMEOUT")).toBe("提取超时");
    expect(failureCodeText("CANDIDATE_TARGET_SESSION_MISSING")).toBe("缺少目标会话，无法应用");
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

  test("解析状态汇总与候选列表", () => {
    const status = parseAutomationStatus({
      generatedAt: "2026-09-21T00:00:00.000Z",
      scheduler: { running: true, startedAt: null, lastTickAt: null, activeJobs: 0 },
      jobs: { total: 2, byStatus: { QUEUED: 1, RUNNING: 0, SUCCEEDED: 1, FAILED: 0, CANCELED: 0 } },
      candidates: { pending: 3 },
      recentFailures: [{ id: "job_1", kind: "EXTRACT_EVIDENCE_CONTEXT", failureCode: "EXTRACTOR_TIMEOUT", failureMessage: "超时" }],
      projects: [{ projectId: "proj_1", mode: "SUGGEST_ONLY", lastDiscoveryAt: null, lastSyncAt: null, lastExtractionAt: null, pendingCandidates: 3 }]
    });
    expect(status.projects).toHaveLength(1);
    expect(status.candidates.pending).toBe(3);
    expect(status.scheduler.running).toBe(true);
    expect(parseCandidateList({ candidates: [candidatePayload] })).toHaveLength(1);
    expect(parseCandidate(candidatePayload).kind).toBe("CONTEXT_ITEM");
  });

  test("发现响应区分已入队", () => {
    expect(parseDiscovery({ projectId: "proj_1", jobId: "job_1", created: true })).toEqual({
      projectId: "proj_1",
      jobId: "job_1",
      created: true
    });
  });

  test("解析应用结果并校验候选结构", () => {
    const result = parseApplicationResult({
      outcome: "APPLIED",
      candidate: { ...candidatePayload, status: "ACCEPTED", targetResourceType: "CONTEXT_ITEM", targetResourceId: "ci_1" },
      target: { resourceType: "CONTEXT_ITEM", resourceId: "ci_1" }
    });
    expect(result.outcome).toBe("APPLIED");
    expect(result.candidate.status).toBe("ACCEPTED");
    expect(result.target).toEqual({ resourceType: "CONTEXT_ITEM", resourceId: "ci_1" });
  });

  test("解析审查解决结果", () => {
    const resolved = parseReviewResolve({
      reviewItem: {
        id: "rev_1",
        projectId: "proj_1",
        sourceType: "EXTRACTION_CANDIDATE",
        sourceId: "cand_1",
        triggerType: "AUTOMATION_SUGGESTION",
        status: "RESOLVED",
        priority: "MEDIUM",
        summary: "自动提取建议",
        proposedResolution: null,
        reviewerId: null,
        resolutionType: "APPROVED",
        resolutionReason: "ok",
        resolvedAt: "2026-09-21T00:00:00.000Z",
        createdAt: "2026-09-21T00:00:00.000Z",
        updatedAt: "2026-09-21T00:00:00.000Z",
        revision: 2
      },
      application: { outcome: "APPLIED", candidate: candidatePayload, target: null }
    });
    expect(resolved.reviewItem.status).toBe("RESOLVED");
    expect(resolved.application.outcome).toBe("APPLIED");
  });

  test("拒绝结构不合法的响应", () => {
    expect(() => parseCandidate({ ...candidatePayload, kind: "RULE" })).toThrow();
    expect(() => parseCandidateList({ candidates: "not-an-array" })).toThrow();
  });
});

describe("按状态决定可用操作", () => {
  test("待审核可执行接受、拒绝与重试", () => {
    expect(candidateActions(parseCandidate(candidatePayload))).toEqual({ accept: true, reject: true, retry: true });
  });

  test("已接受不再显示接受或拒绝", () => {
    const accepted = parseCandidate({ ...candidatePayload, status: "ACCEPTED" });
    expect(candidateActions(accepted)).toEqual({ accept: false, reject: false, retry: false });
  });

  test("已拒绝不再显示接受", () => {
    const rejected = parseCandidate({ ...candidatePayload, status: "REJECTED" });
    expect(candidateActions(rejected)).toEqual({ accept: false, reject: false, retry: true });
  });
});

describe("溯源字段脱敏", () => {
  test("只暴露安全的溯源字段", () => {
    const rows = safeProvenance(parseCandidate(candidatePayload));
    const flattened = JSON.stringify(rows);
    expect(rows.map(([label]) => label)).toEqual(["提取器", "提取器版本", "压缩产物", "来源证据"]);
    expect(flattened).not.toContain("extractionInputHash");
    expect(flattened).not.toContain("transcript");
    expect(flattened).not.toContain("prompt");
    expect(flattened).not.toMatch(/[A-Za-z]:[\\/]/);
  });
});
