import { useState } from "react";
import { automationModeText, validateAutomationPatch, type AutomationMode } from "../../automation";
import { Badge, Panel } from "../../ui";

/** 与后端 schema 一致的输入范围，前端不允许必然失败的值。 */
export const automationSettingRanges = {
  pollIntervalMs: { min: 5_000, max: 300_000, step: 5_000 },
  maxConcurrentJobs: { min: 1, max: 4, step: 1 },
  sourceMaxBytes: { min: 1_024, max: 1_000_000, step: 1_024 },
  autoAcceptThreshold: { min: 0, max: 1, step: 0.05 }
} as const;

const modes: AutomationMode[] = ["OFF", "SUGGEST_ONLY", "AUTO_ACCEPT_HIGH_CONFIDENCE"];

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
 * 所有可见文案为中文，内部枚举不直接显示；保存时携带 expectedRevision，
 * 409 时提示已被其他操作更新并重新加载最新值。
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
    <Panel title="自动化设置" iconName="tune" meta={<Badge text={automationModeText(current.mode)} tone={current.mode === "OFF" ? "" : "blue"} />}>
      <label>自动化模式
        <select value={current.mode} onChange={(event) => patch({ mode: event.target.value as AutomationMode })}>
          {modes.map((mode) => <option value={mode} key={mode}>{automationModeText(mode)}</option>)}
        </select>
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
      <label>最大并发任务数
        <input
          type="number"
          value={current.maxConcurrentJobs}
          min={automationSettingRanges.maxConcurrentJobs.min}
          max={automationSettingRanges.maxConcurrentJobs.max}
          step={automationSettingRanges.maxConcurrentJobs.step}
          onChange={(event) => patch({ maxConcurrentJobs: Number(event.target.value) })}
        />
      </label>
      <label>单次来源读取上限（字节）
        <input
          type="number"
          value={current.sourceMaxBytes}
          min={automationSettingRanges.sourceMaxBytes.min}
          max={automationSettingRanges.sourceMaxBytes.max}
          step={automationSettingRanges.sourceMaxBytes.step}
          onChange={(event) => patch({ sourceMaxBytes: Number(event.target.value) })}
        />
      </label>
      <label>自动接受阈值
        <input
          type="range"
          value={current.autoAcceptThreshold}
          min={automationSettingRanges.autoAcceptThreshold.min}
          max={automationSettingRanges.autoAcceptThreshold.max}
          step={automationSettingRanges.autoAcceptThreshold.step}
          onChange={(event) => patch({ autoAcceptThreshold: Number(event.target.value) })}
        />
        <span className="mono">{current.autoAcceptThreshold.toFixed(2)}</span>
      </label>
      <div className="list-row">
        <button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存设置"}</button>
        {message ? <span className="muted">{message.text}</span> : null}
      </div>
    </Panel>
  );
}
