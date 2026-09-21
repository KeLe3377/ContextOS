import {
  automationJobKindLabels,
  automationOverviewSchema,
  automationSettingsDtoSchema,
  automationSettingsPatchSchema,
  type ActiveAutomationJobKind,
  type AutomationMode,
  type AutomationOverviewDto,
  type AutomationProjectStatus
} from "../../packages/contracts/src/automation.js";
import { z } from "zod";

/**
 * 自动化能力的类型化访问层。
 *
 * 所有响应都经过共享契约的 Zod schema 校验后才交给页面，页面里不允许出现 `as` 强转。
 * 这里只放类型与调用，不放业务判断；页面文案统一使用 `labels` 中的中文映射，内部枚举不直接展示。
 *
 * 范围刻意收窄到“发现 Codex 会话 -> 增量保存 -> 恢复同一个会话”：提取建议、压缩产物和自动化
 * 审核都已退出运行路径，所以前端不再提供它们的读取或操作入口。
 */

export type { AutomationMode, AutomationOverviewDto, AutomationProjectStatus, ActiveAutomationJobKind };

const discoveryResponseSchema = z.object({
  projectId: z.string(),
  jobId: z.string(),
  created: z.boolean()
});

export type AutomationDiscoveryResponse = z.infer<typeof discoveryResponseSchema>;

/* ------------------------------------------------------------------ */
/* 中文文案映射：内部枚举不直接展示给用户                                */
/* ------------------------------------------------------------------ */

export const automationModeLabels: Record<AutomationMode, string> = {
  OFF: "关闭",
  SUGGEST_ONLY: "启用",
  AUTO_ACCEPT_HIGH_CONFIDENCE: "启用"
};

/** 界面只区分“启用 / 关闭”，其余模式在数据层保留但不再占用界面语义。 */
export function automationEnabledText(mode: AutomationMode | string | null | undefined): string {
  return mode === "OFF" ? "关闭" : "启用";
}

export const jobStatusLabels: Record<string, string> = {
  QUEUED: "排队中",
  RUNNING: "运行中",
  SUCCEEDED: "已完成",
  FAILED: "失败",
  CANCELED: "已取消"
};

export const contextItemTypeLabels: Record<string, string> = {
  FACT: "事实",
  SUMMARY: "摘要",
  CONSTRAINT: "约束",
  OPEN_QUESTION: "待确认问题",
  RISK: "风险",
  HANDOFF: "交接信息"
};

/**
 * 失败码的用户可读解释；技术代码保留在详情里，但旁边必须有中文。
 * 只保留当前活跃路径可能产生的失败码，延后流水线的失败码不再出现在新界面上。
 */
export const failureCodeLabels: Record<string, string> = {
  SYNC_JOB_MISSING_SESSION: "同步任务缺少会话",
  AUTOMATION_HANDLER_MISSING: "该任务类型已不再执行",
  DAEMON_RESTARTED: "守护进程重启导致任务中断",
  AUTOMATION_JOB_FAILED: "自动化任务失败",
  TRANSCRIPT_CODEC_EMPTY: "捕获内容为空",
  TRANSCRIPT_CODEC_INVALID_HEADER: "捕获内容格式无法识别",
  TRANSCRIPT_CODEC_UNSUPPORTED_VERSION: "捕获内容版本不受支持",
  TRANSCRIPT_CODEC_INVALID_EVENT: "捕获内容存在无法解析的事件",
  TRANSCRIPT_CODEC_DUPLICATE_ORDINAL: "捕获内容事件序号重复",
  TRANSCRIPT_CODEC_NON_INCREASING_ORDINAL: "捕获内容事件序号不递增",
  TRANSCRIPT_CODEC_EVENT_COUNT_MISMATCH: "捕获内容事件数量不符",
  TRANSCRIPT_CODEC_IDENTITY_MISMATCH: "捕获内容所属会话不匹配",
  FEATURE_DEFERRED: "该能力已延后，暂不可用"
};

export function failureCodeText(code: string | null | undefined): string {
  const key = String(code ?? "");
  return failureCodeLabels[key] ?? "未知失败";
}

export function automationModeText(mode: AutomationMode | string | null | undefined): string {
  return automationModeLabels[mode as AutomationMode] ?? "未知模式";
}

export function jobStatusText(status: string | null | undefined): string {
  return jobStatusLabels[String(status ?? "")] ?? "未知";
}

export function contextItemTypeText(itemType: string | null | undefined): string {
  return contextItemTypeLabels[String(itemType ?? "")] ?? "未分类";
}

/** 概览里只会出现发现与同步两类任务。 */
export function automationJobKindText(kind: string | null | undefined): string {
  return automationJobKindLabels[kind as ActiveAutomationJobKind] ?? String(kind ?? "未知任务");
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
  projectDiscovery: (projectId: string) => `/api/projects/${projectId}/automation/discovery`
} as const;

/** 概览里最近同步时间的取值：没有同步过就返回 null。 */
export function latestSyncAt(status: AutomationOverviewDto): string | null {
  return status.projects.map((project) => project.lastSyncAt).filter((value): value is string => Boolean(value)).sort().pop() ?? null;
}

/** 概览里最近一次捕获 Evidence 的时间。 */
export function latestEvidenceAt(status: AutomationOverviewDto): string | null {
  return status.projects.map((project) => project.lastEvidenceAt).filter((value): value is string => Boolean(value)).sort().pop() ?? null;
}

/** 概览里正在被监听的会话总数。 */
export function watchingSessionCount(status: AutomationOverviewDto): number {
  return status.projects.reduce((total, project) => total + project.watchingSessions, 0);
}
