import { useState } from "react";
import {
  automationEnabledText,
  failureCodeText,
  latestEvidenceAt,
  latestSyncAt,
  parseDiscovery,
  watchingSessionCount
} from "../../automation";
import type { AutomationOverviewDto } from "../../automation";
import { Badge, EmptyNote, Panel, Rows, fmtDate } from "../../ui";

/**
 * 概览页的自动化状态区。
 *
 * 只展示当前产品闭环能真实回答的字段：是否启用、调度状态、被监听的会话数、发现/同步任务状态、
 * 最近同步与最近捕获，以及脱敏后的失败码。运行发现返回 202 时明确显示“已入队”，
 * 不暗示发现已经完成。
 */
export function AutomationOverview({
  status,
  error,
  onRefresh,
  sendJson
}: {
  status: AutomationOverviewDto | null;
  error: string | null;
  onRefresh: () => void;
  sendJson: (path: string, method: string, payload: unknown) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const runDiscovery = async () => {
    const projectId = status?.projects[0]?.projectId;
    if (!projectId || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = parseDiscovery(await sendJson(`/api/projects/${projectId}/automation/discovery`, "POST", {}));
      setMessage({ text: response.created ? "发现任务已入队，等待调度执行。" : "已有发现任务在排队中。", error: false });
      onRefresh();
    } catch (requestError) {
      setMessage({ text: requestError instanceof Error ? requestError.message : "运行发现失败", error: true });
    } finally {
      setBusy(false);
    }
  };

  if (error) return <Panel title="自动化" iconName="bolt"><EmptyNote>自动化状态加载失败：{error}</EmptyNote></Panel>;
  if (!status) return <Panel title="自动化" iconName="bolt"><EmptyNote>正在加载自动化状态…</EmptyNote></Panel>;

  const byStatus = status.jobs.byStatus as Record<string, number | undefined>;

  return (
    <Panel title="自动化" iconName="bolt" meta={<Badge text={status.scheduler.running ? "调度运行中" : "调度已停止"} tone={status.scheduler.running ? "green" : ""} />}>
      <div className="metric-row"><span>监听中的会话</span><strong>{watchingSessionCount(status)}</strong></div>
      <div className="metric-row"><span>发现 / 同步任务（排队 / 运行 / 失败）</span><strong>{byStatus.QUEUED || 0} / {byStatus.RUNNING || 0} / {byStatus.FAILED || 0}</strong></div>
      <div className="metric-row"><span>最近同步</span><strong>{fmtDate(latestSyncAt(status))}</strong></div>
      <div className="metric-row"><span>最近捕获</span><strong>{fmtDate(latestEvidenceAt(status))}</strong></div>
      {status.projects.length === 0 ? <EmptyNote>还没有项目启用自动化。</EmptyNote> : (
        <Rows
          rows={status.projects.map((item) => [
            <span className="mono">{item.projectId}</span>,
            automationEnabledText(item.mode),
            item.mode === "OFF" ? "" : "blue",
            <span>监听中 {item.watchingSessions}</span>
          ])}
          empty="暂无自动化项目。"
        />
      )}
      {status.projects.length > 0 ? (
        <div className="list-row">
          <button className="btn" disabled={busy} onClick={() => void runDiscovery()}>{busy ? "正在入队…" : "运行发现"}</button>
          {message ? <span className="muted">{message.text}</span> : null}
        </div>
      ) : null}
      {status.recentFailures.length > 0 ? (
        <div className="stack compact">
          <div className="muted">最近失败</div>
          {status.recentFailures.slice(0, 3).map((failure) => (
            <div className="metric-row" key={failure.id}>
              <span>{failureCodeText(failure.failureCode)}</span>
              <span className="mono muted">{failure.failureCode || "无失败码"}</span>
            </div>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}
