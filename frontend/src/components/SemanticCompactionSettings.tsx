import { useState } from "react";
import { compactionStatusText, maskedKey, type CompactionConfigValues } from "../semanticCompaction";
import { Badge, Panel } from "../ui";

/**
 * 语义压缩（API）配置。
 *
 * 密钥只在提交时一次性发送；输入框清空后不回显，只显示后端保存的掩码提示（••••abcd）。
 * 任何一项未配置或失败，Continue 都回退到确定性 Capsule，因此这里不会出现“必填”阻塞。
 */
export function SemanticCompactionSettings({
  config,
  onSave
}: {
  config: CompactionConfigValues | null;
  onSave: (compactionConfig: Record<string, unknown>) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState<CompactionConfigValues | null>(config);
  const [jevKey, setJevKey] = useState("");
  const [llmKey, setLlmKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const current = draft || config;
  if (!current) return <Panel title="语义压缩（API）" iconName="bolt"><div className="empty-note">正在加载语义压缩配置…</div></Panel>;

  const patch = (next: Partial<CompactionConfigValues>) => setDraft({ ...current, ...next });

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {
        apiCompactionEnabled: current.apiCompactionEnabled,
        deterministicFallbackEnabled: current.deterministicFallbackEnabled,
        jev: {
          enabled: current.jev.enabled,
          endpoint: current.jev.endpoint,
          model: current.jev.model,
          timeoutMs: current.jev.timeoutMs,
          // Only send a key when the user typed one; an empty box leaves the stored key untouched.
          ...(jevKey ? { apiKey: jevKey } : {})
        },
        llm: {
          enabled: current.llm.enabled,
          endpoint: current.llm.endpoint,
          model: current.llm.model,
          reasoning: current.llm.reasoning,
          timeoutMs: current.llm.timeoutMs,
          ...(llmKey ? { apiKey: llmKey } : {})
        },
        inputTokenBudget: current.inputTokenBudget,
        outputTokenBudget: current.outputTokenBudget,
        preserveRecentMessages: current.preserveRecentMessages,
        keepThreshold: current.keepThreshold,
        truncateHeadChars: current.truncateHeadChars
      };
      const conflict = await onSave(body);
      if (conflict) {
        setMessage({ text: "配置已被其他操作更新，请重新载入后再试。", error: true });
        setDraft(null);
        return;
      }
      // Clear the transient key inputs so the value never lingers in the DOM.
      setJevKey("");
      setLlmKey("");
      setMessage({ text: "语义压缩配置已保存。", error: false });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "保存失败", error: true });
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async (which: "jev" | "llm") => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await onSave({ [which]: { apiKey: null } });
      setMessage({ text: "已清除该 API Key。", error: false });
      setDraft(null);
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "清除失败", error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="语义压缩（API）" iconName="bolt" meta={<Badge text={current.apiCompactionEnabled ? "已启用" : "已关闭"} tone={current.apiCompactionEnabled ? "blue" : ""} />}>
      <div className="muted">{compactionStatusText(current)}</div>
      <label className="checkbox-row">
        <input type="checkbox" checked={current.apiCompactionEnabled} onChange={(event) => patch({ apiCompactionEnabled: event.target.checked })} />
        <span>启用 API 语义压缩（Jev 判定保留/截断/删除，LLM 生成中文 Resume Capsule）</span>
      </label>
      <label className="checkbox-row">
        <input type="checkbox" checked={current.deterministicFallbackEnabled} onChange={(event) => patch({ deterministicFallbackEnabled: event.target.checked })} />
        <span>启用确定性降级（API 关闭、缺密钥或失败时使用本地 Capsule）</span>
      </label>

      <div className="title-sm">Jev / TypeSafe</div>
      <label className="checkbox-row">
        <input type="checkbox" checked={current.jev.enabled} onChange={(event) => patch({ jev: { ...current.jev, enabled: event.target.checked } })} />
        <span>启用 Jev 判定</span>
      </label>
      <label>Endpoint
        <input className="field mono" value={current.jev.endpoint} onChange={(event) => patch({ jev: { ...current.jev, endpoint: event.target.value } })} />
      </label>
      <label>Model
        <input className="field mono" value={current.jev.model} onChange={(event) => patch({ jev: { ...current.jev, model: event.target.value } })} />
      </label>
      <label>API Key（当前：{maskedKey(current.jev.keyHint)}）
        <input className="field mono" type="password" autoComplete="off" value={jevKey} placeholder="粘贴以替换，留空则不变" onChange={(event) => setJevKey(event.target.value)} />
      </label>
      <div className="list-row">
        <button className="btn" disabled={busy || !current.jev.keyConfigured} onClick={() => void clearKey("jev")}>清除 Jev Key</button>
      </div>

      <div className="title-sm">LLM</div>
      <label className="checkbox-row">
        <input type="checkbox" checked={current.llm.enabled} onChange={(event) => patch({ llm: { ...current.llm, enabled: event.target.checked } })} />
        <span>启用 LLM 生成 Capsule</span>
      </label>
      <label>Base URL
        <input className="field mono" value={current.llm.endpoint} onChange={(event) => patch({ llm: { ...current.llm, endpoint: event.target.value } })} />
      </label>
      <label>Model
        <input className="field mono" value={current.llm.model} onChange={(event) => patch({ llm: { ...current.llm, model: event.target.value } })} />
      </label>
      <label>Reasoning
        <input className="field mono" value={current.llm.reasoning} onChange={(event) => patch({ llm: { ...current.llm, reasoning: event.target.value } })} />
      </label>
      <label>API Key（当前：{maskedKey(current.llm.keyHint)}）
        <input className="field mono" type="password" autoComplete="off" value={llmKey} placeholder="粘贴以替换，留空则不变" onChange={(event) => setLlmKey(event.target.value)} />
      </label>
      <div className="list-row">
        <button className="btn" disabled={busy || !current.llm.keyConfigured} onClick={() => void clearKey("llm")}>清除 LLM Key</button>
      </div>

      <div className="title-sm">预算与阈值</div>
      <label>输入 token 上限
        <input type="number" min={1000} value={current.inputTokenBudget} onChange={(event) => patch({ inputTokenBudget: Number(event.target.value) })} />
      </label>
      <label>输出 token 上限
        <input type="number" min={100} value={current.outputTokenBudget} onChange={(event) => patch({ outputTokenBudget: Number(event.target.value) })} />
      </label>
      <label>保留最近消息数
        <input type="number" min={0} value={current.preserveRecentMessages} onChange={(event) => patch({ preserveRecentMessages: Number(event.target.value) })} />
      </label>
      <label>保留阈值（0–1）
        <input type="number" min={0} max={1} step={0.05} value={current.keepThreshold} onChange={(event) => patch({ keepThreshold: Number(event.target.value) })} />
      </label>
      <label>截断结果保留字符数
        <input type="number" min={0} value={current.truncateHeadChars} onChange={(event) => patch({ truncateHeadChars: Number(event.target.value) })} />
      </label>

      <div className="list-row">
        <button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存语义压缩配置"}</button>
        {message ? <span className="muted">{message.text}</span> : null}
      </div>
    </Panel>
  );
}
