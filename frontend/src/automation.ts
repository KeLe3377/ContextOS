import {
  automationOverviewSchema,
  automationSettingsDtoSchema,
  automationSettingsPatchSchema,
  extractionCandidateSchema,
  type AutomationMode,
  type AutomationOverviewDto,
  type AutomationProjectStatus,
  type CandidateKind,
  type CandidateStatus,
  type ExtractionCandidateDto
} from "../../packages/contracts/src/automation.js";
import { reviewItemDtoSchema, type ReviewItemDto } from "../../packages/contracts/src/review-items.js";
import { z } from "zod";

/**
 * 自动化能力的类型化访问层。
 *
 * 所有响应都经过共享契约的 Zod schema 校验后才交给页面，页面里不允许出现 `as` 强转。
 * 这里只放类型与调用，不放业务判断；页面文案统一使用 `labels` 中的中文映射，内部枚举不直接展示。
 */

export type { AutomationMode, AutomationOverviewDto, AutomationProjectStatus, CandidateKind, CandidateStatus, ExtractionCandidateDto, ReviewItemDto };

const discoveryResponseSchema = z.object({
  projectId: z.string(),
  jobId: z.string(),
  created: z.boolean()
});

const candidateListResponseSchema = z.object({
  candidates: z.array(z.unknown())
});

const applicationResultSchema = z.object({
  outcome: z.enum(["APPLIED", "ALREADY_APPLIED", "REJECTED", "ALREADY_REJECTED"]),
  candidate: z.unknown(),
  target: z
    .object({ resourceType: z.string(), resourceId: z.string() })
    .nullable()
});

const reviewResolveResponseSchema = z.object({
  reviewItem: z.unknown(),
  application: applicationResultSchema
});

export type AutomationDiscoveryResponse = z.infer<typeof discoveryResponseSchema>;
export type AutomationApplicationResult = {
  outcome: "APPLIED" | "ALREADY_APPLIED" | "REJECTED" | "ALREADY_REJECTED";
  candidate: ExtractionCandidateDto;
  target: { resourceType: string; resourceId: string } | null;
};

export type AutomationReviewResolveResponse = {
  reviewItem: ReviewItemDto;
  application: AutomationApplicationResult;
};

/* ------------------------------------------------------------------ */
/* 中文文案映射：内部枚举不直接展示给用户                                */
/* ------------------------------------------------------------------ */

export const automationModeLabels: Record<AutomationMode, string> = {
  OFF: "关闭",
  SUGGEST_ONLY: "仅生成建议",
  AUTO_ACCEPT_HIGH_CONFIDENCE: "自动接受高置信度建议"
};

export const candidateStatusLabels: Record<CandidateStatus, string> = {
  PENDING: "待审核",
  ACCEPTED: "已接受",
  REJECTED: "已拒绝",
  SUPERSEDED: "已被取代"
};

export const candidateKindLabels: Record<CandidateKind, string> = {
  RESUME_CAPSULE: "恢复摘要",
  CONTEXT_ITEM: "上下文条目",
  DECISION: "决策",
  WORK_ITEM: "工作项"
};

export const contextItemTypeLabels: Record<string, string> = {
  FACT: "事实",
  SUMMARY: "摘要",
  CONSTRAINT: "约束",
  OPEN_QUESTION: "待确认问题",
  RISK: "风险",
  HANDOFF: "交接信息"
};

export const jobStatusLabels: Record<string, string> = {
  QUEUED: "排队中",
  RUNNING: "运行中",
  SUCCEEDED: "已完成",
  FAILED: "失败",
  CANCELED: "已取消"
};

export const reviewTriggerLabels: Record<string, string> = {
  AUTOMATION_SUGGESTION: "自动提取建议"
};

/** 失败码的用户可读解释；技术代码保留在详情里，但旁边必须有中文。 */
export const failureCodeLabels: Record<string, string> = {
  COMPACTION_ARTIFACT_NOT_FOUND: "压缩产物不存在",
  COMPACTION_ARTIFACT_INVALID: "压缩产物内容校验失败",
  EXTRACTION_SOURCE_MISMATCH: "提取来源与项目不匹配",
  EXTRACTION_OUTPUT_INVALID: "提取结果不符合契约",
  EXTRACTION_EVIDENCE_OUT_OF_SCOPE: "提取结果引用了越界的证据",
  EXTRACTION_PERSISTENCE_FAILED: "提取结果写入失败",
  EXTRACTOR_UNAVAILABLE: "无法启动提取命令",
  EXTRACTOR_TIMEOUT: "提取超时",
  EXTRACTOR_EXIT_NONZERO: "提取命令异常退出",
  EXTRACTOR_STDOUT_LIMIT: "提取输出超出上限",
  EXTRACTOR_OUTPUT_NOT_JSON: "提取输出不是合法 JSON",
  EXTRACTOR_OUTPUT_SCHEMA_INVALID: "提取输出不符合要求的结构",
  EXTRACTOR_EVIDENCE_IDS_INVALID: "提取结果引用的证据无效",
  CANDIDATE_NOT_FOUND: "提取建议不存在",
  CANDIDATE_NOT_APPLICABLE: "该提取建议当前不可操作",
  CANDIDATE_KIND_NOT_APPLICABLE: "该类型暂不支持自动应用",
  CANDIDATE_TARGET_SESSION_MISSING: "缺少目标会话，无法应用",
  CANDIDATE_REVISION_CONFLICT: "数据已被他人更新",
  DAEMON_RESTARTED: "守护进程重启导致任务中断",
  AUTOMATION_JOB_FAILED: "自动化任务失败"
};

export function failureCodeText(code: string | null | undefined): string {
  const key = String(code ?? "");
  return failureCodeLabels[key] ?? "未知失败";
}

export function automationModeText(mode: AutomationMode | string | null | undefined): string {
  return automationModeLabels[mode as AutomationMode] ?? "未知模式";
}

export function candidateStatusText(status: CandidateStatus | string | null | undefined): string {
  return candidateStatusLabels[status as CandidateStatus] ?? "未知状态";
}

export function candidateKindText(kind: CandidateKind | string | null | undefined): string {
  return candidateKindLabels[kind as CandidateKind] ?? "未知类型";
}

export function jobStatusText(status: string | null | undefined): string {
  return jobStatusLabels[String(status ?? "")] ?? "未知";
}

export function contextItemTypeText(itemType: string | null | undefined): string {
  return contextItemTypeLabels[String(itemType ?? "")] ?? "未分类";
}

export function reviewTriggerText(triggerType: string | null | undefined): string {
  return reviewTriggerLabels[String(triggerType ?? "")] ?? "审查事项";
}

/* ------------------------------------------------------------------ */
/* 解析与调用                                                          */
/* ------------------------------------------------------------------ */

export function parseAutomationSettings(value: unknown) {
  return automationSettingsDtoSchema.parse(value);
}

export function parseAutomationStatus(value: unknown): AutomationOverviewDto {
  return automationOverviewSchema.parse(value);
}

export function parseCandidateList(value: unknown): ExtractionCandidateDto[] {
  const parsed = candidateListResponseSchema.parse(value);
  return parsed.candidates.map((entry) => extractionCandidateSchema.parse(entry));
}

export function parseCandidate(value: unknown): ExtractionCandidateDto {
  return extractionCandidateSchema.parse(value);
}

export function parseApplicationResult(value: unknown): AutomationApplicationResult {
  const parsed = applicationResultSchema.parse(value);
  return {
    outcome: parsed.outcome,
    candidate: extractionCandidateSchema.parse(parsed.candidate),
    target: parsed.target
  };
}

export function parseReviewResolve(value: unknown): AutomationReviewResolveResponse {
  const parsed = reviewResolveResponseSchema.parse(value);
  return {
    reviewItem: reviewItemDtoSchema.parse(parsed.reviewItem),
    application: parseApplicationResult(parsed.application)
  };
}

export function parseDiscovery(value: unknown): AutomationDiscoveryResponse {
  return discoveryResponseSchema.parse(value);
}

export function validateAutomationPatch(value: unknown) {
  return automationSettingsPatchSchema.parse(value);
}

/** 自动化接口路径，集中定义，页面里不散落字符串。 */
export const automationPaths = {
  status: "/api/automation/status",
  projectSettings: (projectId: string) => `/api/projects/${projectId}/automation/settings`,
  projectDiscovery: (projectId: string) => `/api/projects/${projectId}/automation/discovery`,
  projectCandidates: (projectId: string) => `/api/projects/${projectId}/automation/candidates`,
  candidate: (id: string) => `/api/automation/candidates/${id}`,
  accept: (id: string) => `/api/automation/candidates/${id}/accept`,
  reject: (id: string) => `/api/automation/candidates/${id}/reject`,
  retry: (id: string) => `/api/automation/candidates/${id}/retry`,
  reviewResolve: (id: string) => `/api/automation/review-items/${id}/resolve`
} as const;

/** 可进行的操作集合，供页面按状态决定按钮显隐。 */
export function candidateActions(candidate: ExtractionCandidateDto): { accept: boolean; reject: boolean; retry: boolean } {
  return {
    accept: candidate.status === "PENDING",
    reject: candidate.status === "PENDING",
    retry: candidate.status === "PENDING" || candidate.status === "REJECTED"
  };
}

/** 只展示安全的溯源字段，绝不把正文、提示词或本地路径交给界面。 */
export function safeProvenance(candidate: ExtractionCandidateDto): Array<[string, string]> {
  const provenance = candidate.provenance ?? {};
  const rows: Array<[string, string]> = [];
  if (provenance.extractorId) rows.push(["提取器", provenance.extractorId]);
  if (provenance.extractorVersion) rows.push(["提取器版本", provenance.extractorVersion]);
  if (provenance.sourceArtifactId) rows.push(["压缩产物", provenance.sourceArtifactId]);
  if (provenance.sourceEvidenceId) rows.push(["来源证据", provenance.sourceEvidenceId]);
  return rows;
}
