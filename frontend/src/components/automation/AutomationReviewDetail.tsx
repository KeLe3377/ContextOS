import { useState } from "react";
import {
  candidateKindText,
  candidateStatusText,
  contextItemTypeText,
  failureCodeText,
  parseReviewResolve,
  reviewTriggerText,
  safeProvenance,
  type ExtractionCandidateDto,
  type ReviewItemDto
} from "../../automation";
import { Badge, EmptyNote, Panel } from "../../ui";

/**
 * 审查收件箱里的自动提取建议。
 *
 * 批准与驳回都走审查解决接口；失败时保持打开状态，界面不会提前移除该条目。
 * 内部枚举全部映射为中文，失败码保留技术值但同时给出中文解释。
 */
export function AutomationReviewDetail({
  review,
  candidate,
  onResolve,
  onOpenCandidate
}: {
  review: ReviewItemDto;
  candidate: ExtractionCandidateDto | null;
  onResolve: (resolutionType: string, reason: string, expectedRevision: number) => Promise<unknown>;
  onOpenCandidate: (candidateId: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const resolve = async (approve: boolean) => {
    if (busy) return;
    setBusy(approve ? "approve" : "dismiss");
    setMessage(null);
    try {
      const result = parseReviewResolve(await onResolve(approve ? "APPROVED" : "DISMISSED", approve ? "批准应用" : "驳回建议", review.revision));
      setMessage({
        text: result.reviewItem.status === "RESOLVED"
          ? (result.application.outcome === "APPLIED" ? "已批准并生成正式对象。" : "已批准（此前已应用）。")
          : "已驳回该建议。",
        error: false
      });
    } catch (error) {
      // 失败时条目仍保持打开，界面不移除。
      setMessage({ text: error instanceof Error ? error.message : "操作失败", error: true });
    } finally {
      setBusy(null);
    }
  };

  const payload = (candidate?.payload || {}) as Record<string, unknown>;

  return (
    <Panel title="自动提取建议" iconName="bolt" meta={<Badge text={reviewTriggerText(review.triggerType)} tone="blue" />}>
      <div className="metric-row"><span>来源</span><strong>{reviewTriggerText(review.triggerType)}</strong></div>
      {candidate ? (
        <>
          <div className="metric-row"><span>类型</span><strong>{candidateKindText(candidate.kind)}</strong></div>
          {payload.itemType ? <div className="metric-row"><span>条目类型</span><strong>{contextItemTypeText(String(payload.itemType))}</strong></div> : null}
          <div className="metric-row"><span>标题</span><strong>{String(payload.title || payload.summary || "无标题")}</strong></div>
          {payload.summary ? <div className="metric-row"><span>摘要</span><strong>{String(payload.summary)}</strong></div> : null}
          <div className="metric-row"><span>置信度</span><strong>{candidate.confidence.toFixed(2)}</strong></div>
          <div className="metric-row"><span>状态</span><strong>{candidateStatusText(candidate.status)}</strong></div>
          <div className="metric-row"><span>关联证据</span><strong className="mono">{(candidate.evidenceIds || []).join("、") || "无"}</strong></div>
          {safeProvenance(candidate).map(([label, value]) => (
            <div className="metric-row" key={label}><span>{label}</span><strong className="mono">{value}</strong></div>
          ))}
          <div className="list-row"><button className="btn" onClick={() => onOpenCandidate(candidate.id)}>查看提取建议详情</button></div>
        </>
      ) : <EmptyNote>未找到对应的提取建议。</EmptyNote>}

      <div className="list-row">
        <button className="btn primary" disabled={busy !== null} onClick={() => void resolve(true)}>{busy === "approve" ? "批准中…" : "批准"}</button>
        <button className="btn" disabled={busy !== null} onClick={() => void resolve(false)}>{busy === "dismiss" ? "提交中…" : "驳回"}</button>
      </div>
      {message ? <div className="muted">{message.text}</div> : null}
      {review.status === "OPEN" ? null : <div className="muted">当前状态：{review.status === "RESOLVED" ? "已解决" : review.status === "DISMISSED" ? "已驳回" : review.status}</div>}
    </Panel>
  );
}

export function failureHint(code: string | null | undefined) {
  return failureCodeText(code);
}
