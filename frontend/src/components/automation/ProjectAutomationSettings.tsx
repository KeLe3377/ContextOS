import { useState } from "react";
import { automationEnabledText, validateAutomationPatch, type AutomationMode } from "../../automation";
import { Badge, Panel } from "../../ui";

/** 与后端 schema 一致的输入范围，前端不允许必然失败的值。 */
export const automationSettingRanges = {
  pollIntervalMs: { min: 5_000, max: 300_000, step: 5_000 },
  maxConcurrentJobs: { min: 1, max: 4, step: 1 },
  sourceMaxBytes: { min: 1_024, max: 1_000_000, step: 1_024 },
  autoAcceptThreshold: { min: 0, max: 1, step: 0.05 }
} as const;

export type AutomationSettingsValues = {
  mode: AutomationMode;
  pollIntervalMs: number;
  maxConcurrentJobs: number;
  sourceMaxBytes: number;
  autoAcceptThreshold: number;
  revision: number;
};

/**
 * 项目自动化设置。
 *
 * 界面只表达“启用 / 关闭”：开启即让守护进程发现并持续保存 Codex 会话，关闭即停止。
 * 其余字段仍按后端契约一并提交，因为数据层保持原样，只是不再占用界面空间。
 * 保存时携带 expectedRevision，冲突时提示已被其他操作更新并重新载入最新值。
 */
export function ProjectAutomationSettings({
  values,
  onSave
}: {
  values: AutomationSettingsValues | null;
  onSave: (patch: Record<string, unknown>) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState<AutomationSettingsValues | null>(values);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const current = draft || values;
  if (!current) return <Panel title="自动化设置" iconName="tune"><div className="empty-note">正在加载自动化设置…</div></Panel>;

  const enabled = current.mode !== "OFF";
  const patch = (next: Partial<AutomationSettingsValues>) => setDraft({ ...current, ...next });

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      // 先按共享契约校验，避免把必然失败的值发给后端。
      const body = validateAutomationPatch({
        mode: current.mode,
        pollIntervalMs: current.pollIntervalMs,
        maxConcurrentJobs: current.maxConcurrentJobs,
        sourceMaxBytes: current.sourceMaxBytes,
        autoAcceptThreshold: current.autoAcceptThreshold,
        expectedRevision: current.revision
      });
      const conflict = await onSave(body as Record<string, unknown>);
      if (conflict) {
        setMessage({ text: "设置已被其他操作更新，已重新载入最新值。", error: true });
        setDraft(null);
        return;
      }
      setMessage({ text: "自动化设置已保存。", error: false });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "保存失败", error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="自动化设置" iconName="tune" meta={<Badge text={automationEnabledText(current.mode)} tone={enabled ? "blue" : ""} />}>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => patch({ mode: event.target.checked ? "SUGGEST_ONLY" : "OFF" })}
        />
        <span>启用自动化：自动发现并持续保存 Codex 会话</span>
      </label>
      <label>轮询间隔（毫秒）
        <input
          type="number"
          value={current.pollIntervalMs}
          min={automationSettingRanges.pollIntervalMs.min}
          max={automationSettingRanges.pollIntervalMs.max}
          step={automationSettingRanges.pollIntervalMs.step}
          onChange={(event) => patch({ pollIntervalMs: Number(event.target.value) })}
        />
      </label>
      <div className="list-row">
        <button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存设置"}</button>
        {message ? <span className="muted">{message.text}</span> : null}
      </div>
    </Panel>
  );
}
