import { useState } from "react";
import {
  candidateActions,
  candidateKindText,
  candidateStatusText,
  contextItemTypeText,
  safeProvenance,
  parseApplicationResult,
  type ExtractionCandidateDto
} from "../../automation";
import { Badge, EmptyNote, Panel, fmtDate } from "../../ui";

/**
 * 提取建议详情与操作。
 *
 * 只展示安全的溯源字段；所有操作都携带 expectedRevision；
 * 接受成功后给出正式目标资源，供页面跳转到会话或上下文条目。
 */
export function CandidateDetail({
  candidate,
  onAccept,
  onReject,
  onRetry,
  onOpenTarget
}: {
  candidate: ExtractionCandidateDto | null;
  onAccept: (expectedRevision: number) => Promise<unknown>;
  onReject: (expectedRevision: number) => Promise<unknown>;
  onRetry: (expectedRevision: number) => Promise<unknown>;
  onOpenTarget: (resourceType: string, resourceId: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  if (!candidate) return <Panel title="提取建议" iconName="lightbulb"><EmptyNote>请选择一条提取建议。</EmptyNote></Panel>;

  const actions = candidateActions(candidate);
  const payload = candidate.payload as Record<string, unknown>;

  const run = async (kind: string, work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(kind);
    setMessage(null);
    try {
      const result = parseApplicationResult(await work());
      setMessage({
        text: result.outcome === "APPLIED" ? "已应用并生成正式对象。"
          : result.outcome === "ALREADY_APPLIED" ? "该建议此前已应用，未重复生成对象。"
            : result.outcome === "REJECTED" ? "已拒绝该建议。" : "该建议此前已拒绝。",
        error: false
      });
      if (result.target) onOpenTarget(result.target.resourceType, result.target.resourceId);
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "操作失败", error: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title="提取建议" iconName="lightbulb" meta={<Badge text={candidateStatusText(candidate.status)} tone={candidate.status === "ACCEPTED" ? "green" : candidate.status === "REJECTED" ? "red" : "blue"}/>}>
      <div className="metric-row"><span>类型</span><strong>{candidateKindText(candidate.kind)}</strong></div>
      {payload.itemType ? <div className="metric-row"><span>条目类型</span><strong>{contextItemTypeText(String(payload.itemType))}</strong></div> : null}
      <div className="metric-row"><span>标题</span><strong>{String(payload.title || payload.summary || "无标题")}</strong></div>
      {payload.summary ? <div className="metric-row"><span>摘要</span><strong>{String(payload.summary)}</strong></div> : null}
      <div className="metric-row"><span>置信度</span><strong>{candidate.confidence.toFixed(2)}</strong></div>
      <div className="metric-row"><span>来源证据</span><strong className="mono">{candidate.sourceEvidenceId || "无"}</strong></div>
      {safeProvenance(candidate).map(([label, value]) => (
        <div className="metric-row" key={label}><span>{label}</span><strong className="mono">{value}</strong></div>
      ))}
      {candidate.targetResourceType ? (
        <div className="metric-row">
          <span>正式目标</span>
          <strong className="mono">{candidate.targetResourceType} · {candidate.targetResourceId}</strong>
        </div>
      ) : null}
      <div className="metric-row"><span>更新时间</span><strong>{fmtDate(candidate.updatedAt)}</strong></div>
      <div className="metric-row"><span>版本</span><strong className="mono">{candidate.revision}</strong></div>

      <div className="list-row">
        {actions.accept ? <button className="btn primary" disabled={busy !== null} onClick={() => void run("accept", () => onAccept(candidate.revision))}>{busy === "accept" ? "应用中…" : "接受"}</button> : null}
        {actions.reject ? <button className="btn" disabled={busy !== null} onClick={() => void run("reject", () => onReject(candidate.revision))}>{busy === "reject" ? "提交中…" : "拒绝"}</button> : null}
        {actions.retry ? <button className="btn" disabled={busy !== null} onClick={() => void run("retry", () => onRetry(candidate.revision))}>{busy === "retry" ? "入队中…" : "重新提取"}</button> : null}
      </div>
      {message ? <div className="muted">{message.text}</div> : null}
    </Panel>
  );
}
