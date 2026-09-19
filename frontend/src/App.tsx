import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";

const API_BASE = localStorage.getItem("contextos.apiBase") || "http://127.0.0.1:4721";

type AnyRecord = Record<string, any>;
type PageId = "overview" | "projects" | "sessions" | "review" | "decisions" | "work" | "context" | "rules" | "settings";
type ModalKind = null | "project" | "session" | "rule" | "transcript" | "existingTranscript" | "desktopSync" | "resumeCapsule" | "source" | "sourceEdit" | "contextItem" | "contextItemEdit" | "decision" | "decisionEdit" | "workItem" | "workItemEdit" | "workItemBlock" | "workItemResolveBlocker" | "reviewAssign" | "reviewResolve" | "reviewDismiss";

type PageDef = {
  title: string;
  subtitle: string;
  actions: Array<[icon: string, label: string, kind: string, id: string]>;
  narrow?: boolean;
};

type WorkspaceData = {
  health: AnyRecord | null;
  overview: AnyRecord | null;
  projects: AnyRecord[];
  sessions: AnyRecord[];
  reviews: AnyRecord[];
  decisions: AnyRecord[];
  workItems: AnyRecord[];
  contextSources: AnyRecord[];
  evidenceSnapshots: AnyRecord[];
  contextItems: AnyRecord[];
  rules: AnyRecord[];
  settings: AnyRecord | null;
  runtimeHealth: AnyRecord | null;
  adapters: AnyRecord[];
};

class ActionCanceled extends Error {
  constructor() {
    super("操作已取消");
  }
}

type SessionDetails = {
  sessionId: string;
  contextPack: AnyRecord | null;
  evidence: AnyRecord[];
  resumeCapsule: AnyRecord | null;
  runtimeStatus: AnyRecord | null;
  runs: AnyRecord[];
  activity: AnyRecord[];
  transcriptEvents: AnyRecord | null;
  desktopSync: AnyRecord | null;
};

const navGroups: Array<{ label: string; items: Array<[PageId, string, string]> }> = [
  { label: "工作区", items: [["overview", "dashboard", "概览"], ["projects", "folder_open", "项目"], ["sessions", "terminal", "会话"]] },
  { label: "治理", items: [["review", "inbox", "审查收件箱"], ["decisions", "gavel", "决策"], ["work", "check_box", "工作项"], ["context", "account_tree", "上下文"]] },
  { label: "系统", items: [["rules", "policy", "规则"], ["settings", "settings", "设置"]] }
];

const pages: Record<PageId, PageDef> = {
  overview: { title: "概览", subtitle: "工作区状态、待处理审查以及下一步可执行工作。", actions: [["refresh", "刷新上下文", "", "refresh-context"]] },
  projects: { title: "项目", subtitle: "受控工作区边界及活动的上下文策略。", actions: [["create_new_folder", "添加项目", "primary", "add-project"], ["tune", "编辑默认值", "", "edit-defaults"]] },
  sessions: { title: "会话", subtitle: "带有不可变证据引用的具体智能体工作片段。", actions: [["add", "新建会话", "primary", "new-session"], ["sync", "同步对话记录", "", "sync-transcript"], ["link", "Desktop 同步", "", "desktop-sync"], ["play_arrow", "在智能体中继续", "", "continue-in-agent"], ["hub", "导入已有会话", "", "import-existing-session"], ["upload_file", "导入对话记录", "", "import-transcript"], ["download", "导出摘要胶囊", "", "export-capsule"]] },
  review: { title: "审查收件箱", subtitle: "派生上下文或规则生效前需要人工决定的事项。", actions: [["rule", "批准选中", "primary", "approve-selected"], ["close", "拒绝", "", "reject"]] },
  decisions: { title: "决策", subtitle: "持久的选择、基本原理、来源与版本历史。", actions: [["add", "记录决策", "primary", "record-decision"], ["compare_arrows", "版本对比", "", "compare-versions"]] },
  work: { title: "工作项", subtitle: "具有就绪信号和阻塞依赖的可执行工作单元。", actions: [["play_arrow", "启动就绪项", "primary", "start-ready-item"], ["add_task", "创建工作项", "", "create-item"]] },
  context: { title: "上下文", subtitle: "受控源、不可变证据快照与派生上下文项。", actions: [["add", "添加数据源", "primary", "add-source"], ["add_box", "添加上下文项", "", "add-context-item"], ["sync", "同步数据源", "", "sync-sources"]] },
  rules: { title: "规则", subtitle: "控制自动化智能体行为的版本化治理指令。", actions: [["add", "新建规则", "primary", "new-rule"], ["history", "版本历史", "", "version-history"]] },
  settings: { title: "设置", subtitle: "配置 ContextOS 的运行方式、智能体连接及工作上下文处理。", actions: [["restart_alt", "重置更改", "", "reset-changes"], ["check", "保存更改", "primary", "save-changes"]], narrow: true }
};

const enabledActions = new Set(["refresh-context", "add-project", "new-session", "sync-transcript", "desktop-sync", "continue-in-agent", "import-existing-session", "import-transcript", "export-capsule", "approve-selected", "reject", "record-decision", "compare-versions", "start-ready-item", "create-item", "add-source", "add-context-item", "sync-sources", "new-rule", "reset-changes", "save-changes"]);

function emptyData(): WorkspaceData {
  return {
    health: null,
    overview: null,
    projects: [],
    sessions: [],
    reviews: [],
    decisions: [],
    workItems: [],
    contextSources: [],
    evidenceSnapshots: [],
    contextItems: [],
    rules: [],
    settings: null,
    runtimeHealth: null,
    adapters: []
  };
}

async function fetchJson(path: string, options: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      signal: controller.signal
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error?.message || `${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

function sendJson(path: string, method: string, payload: unknown) {
  return fetchJson(path, { method, body: JSON.stringify(payload) });
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error("请求失败") };
  }
}

const iconPaths: Record<string, ReactNode> = {
  account_tree: <><path d="M6 4v5h12V4H6Z" /><path d="M6 15v5h5v-5H6Z" /><path d="M13 15v5h5v-5h-5Z" /><path d="M12 9v3M8.5 12h7M8.5 12v3M15.5 12v3" /></>,
  add: <path d="M12 5v14M5 12h14" />,
  add_box: <><path d="M5 5h14v14H5z" /><path d="M12 8v8M8 12h8" /></>,
  add_task: <><path d="M5 12l4 4L19 6" /><path d="M5 20h14" /></>,
  archive: <><path d="M4 7h16M6 7v13h12V7M9 11h6" /><path d="M5 4h14v3H5z" /></>,
  article: <><path d="M7 4h8l4 4v12H7z" /><path d="M15 4v4h4M10 12h6M10 16h6M10 8h2" /></>,
  block: <><circle cx="12" cy="12" r="8" /><path d="M7 7l10 10" /></>,
  cancel: <><circle cx="12" cy="12" r="8" /><path d="M9 9l6 6M15 9l-6 6" /></>,
  check: <path d="M5 12l4 4L19 6" />,
  check_box: <><path d="M5 5h14v14H5z" /><path d="M8 12l3 3 5-7" /></>,
  check_circle: <><circle cx="12" cy="12" r="8" /><path d="M8 12l3 3 5-6" /></>,
  close: <path d="M7 7l10 10M17 7 7 17" />,
  compare_arrows: <><path d="M7 7h11M15 4l3 3-3 3M17 17H6M9 14l-3 3 3 3" /></>,
  content_copy: <><path d="M8 8h11v12H8z" /><path d="M5 16V4h11" /></>,
  create_new_folder: <><path d="M3 7h7l2 2h9v10H3z" /><path d="M15 11v6M12 14h6" /></>,
  dashboard: <><path d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z" /></>,
  database: <><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" /></>,
  download: <><path d="M12 4v11M8 11l4 4 4-4" /><path d="M5 20h14" /></>,
  edit_note: <><path d="M5 6h10M5 10h8M5 14h6" /><path d="M14 19l5-5 2 2-5 5h-2z" /></>,
  fact_check: <><path d="M4 5h16v14H4z" /><path d="M8 9h5M8 14h4M15 14l2 2 4-5" /></>,
  folder_open: <path d="M3 8h7l2 2h9l-2 9H4zM3 8V6h7l2 2" />,
  folder_managed: <><path d="M3 8h7l2 2h9l-2 9H4zM3 8V6h7l2 2" /><path d="M14 15l2 2 4-5" /></>,
  gavel: <><path d="M13 5l6 6M11 7l6 6M5 19l6-6" /><path d="M9 5l10 10-3 3L6 8z" /></>,
  hub: <><circle cx="12" cy="12" r="3" /><circle cx="5" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="12" cy="20" r="2" /><path d="M7 7l3 3M17 7l-3 3M12 15v3" /></>,
  history: <><path d="M4 12a8 8 0 1 0 2-5" /><path d="M4 5v5h5M12 8v5l3 2" /></>,
  inbox: <><path d="M4 5h16l-2 14H6z" /><path d="M4 13h5l2 3h2l2-3h5" /></>,
  inventory_2: <><path d="M4 7h16v13H4z" /><path d="M4 7l3-4h10l3 4M9 11h6" /></>,
  link: <><path d="M10 7l1-1a4 4 0 0 1 6 6l-1 1M14 17l-1 1a4 4 0 0 1-6-6l1-1M9 15l6-6" /></>,
  lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  manage_search: <><circle cx="10" cy="10" r="5" /><path d="M14 14l5 5M4 20h7" /></>,
  monitor_heart: <><path d="M4 6h16v11H4z" /><path d="M8 21h8M12 17v4" /><path d="M7 12h3l1-3 2 6 1-3h3" /></>,
  pause_circle: <><circle cx="12" cy="12" r="8" /><path d="M10 9v6M14 9v6" /></>,
  play_arrow: <path d="M8 5v14l11-7z" />,
  playlist_add_check: <><path d="M4 7h9M4 12h8M4 17h6" /><path d="M14 15l2 2 4-5" /></>,
  policy: <><path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" /><path d="M9 12l2 2 4-5" /></>,
  progress_activity: <><circle cx="12" cy="12" r="8" strokeDasharray="30 18" /><path d="M12 4v4" /></>,
  publish: <><path d="M12 19V5M8 9l4-4 4 4" /><path d="M5 19h14" /></>,
  rate_review: <><path d="M4 5h16v11H8l-4 4z" /><path d="M8 9h8M8 13h5" /></>,
  refresh: <><path d="M19 8a7 7 0 1 0 1 5" /><path d="M19 4v4h-4" /></>,
  restart_alt: <><path d="M18 9a6 6 0 1 1-2-4" /><path d="M18 4v5h-5" /></>,
  rule: <><path d="M6 4h12v16H6z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  science: <><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3" /><path d="M8 16h8" /></>,
  search: <><circle cx="10" cy="10" r="5" /><path d="M14 14l5 5" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></>,
  smart_toy: <><rect x="5" y="8" width="14" height="10" rx="2" /><path d="M12 8V4M9 13h.01M15 13h.01M9 18v2M15 18v2" /></>,
  stop_circle: <><circle cx="12" cy="12" r="8" /><path d="M9 9h6v6H9z" /></>,
  sync: <><path d="M18 8a6 6 0 0 0-10-2L6 8" /><path d="M6 4v4h4M6 16a6 6 0 0 0 10 2l2-2" /><path d="M18 20v-4h-4" /></>,
  task_alt: <><circle cx="12" cy="12" r="8" /><path d="M8 12l3 3 5-6" /></>,
  terminal: <><path d="M4 5h16v14H4z" /><path d="M7 9l3 3-3 3M12 15h5" /></>,
  toggle_off: <><rect x="4" y="7" width="16" height="10" rx="5" /><circle cx="9" cy="12" r="3" /></>,
  toggle_on: <><rect x="4" y="7" width="16" height="10" rx="5" /><circle cx="15" cy="12" r="3" /></>,
  tune: <><path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h7M15 17h5" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="13" cy="17" r="2" /></>,
  undo: <><path d="M9 7H4v5" /><path d="M4 12a8 8 0 1 0 2-5" /></>,
  upload_file: <><path d="M7 4h8l4 4v12H7z" /><path d="M15 4v4h4M12 17V10M9 13l3-3 3 3" /></>,
  verified: <><path d="M12 3l3 2 4 .5.5 4 2.5 2.5-2.5 2.5-.5 4-4 .5-3 2-3-2-4-.5-.5-4L2 12l2.5-2.5.5-4 4-.5z" /><path d="M8 12l3 3 5-6" /></>,
  visibility: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="3" /></>
};

function icon(name: string) {
  return (
    <svg className="app-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {iconPaths[name] || <circle cx="12" cy="12" r="7" />}
    </svg>
  );
}

function stripWrappingQuotes(value: FormDataEntryValue | null) {
  return String(value ?? "").trim().replace(/^["'](.+)["']$/, "$1");
}

function linesValue(value: FormDataEntryValue | null) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function prettyJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

function copyText(value: string | null | undefined) {
  if (!value) return;
  void navigator.clipboard?.writeText(value);
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function isArchived(item: AnyRecord) {
  return item.status === "ARCHIVED" || Boolean(item.archivedAt);
}

function fmtDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "-";
}

function transcriptStructure(metadata: AnyRecord | null | undefined) {
  if (!metadata) return "无对话记录元数据";
  const counts = metadata.eventCounts || {};
  const parts = [
    `${metadata.messageCount || 0} 条消息`,
    metadata.eventCount ? `${metadata.eventCount} 个事件` : null,
    counts.toolCall ? `${counts.toolCall} 次工具调用` : null,
    counts.toolResult ? `${counts.toolResult} 个工具结果` : null,
    counts.summary ? `${counts.summary} 条摘要` : null,
    `${metadata.turnCount || 0} 轮对话`,
    metadata.transcriptTruncated ? "已截断" : "完整"
  ];
  return parts.filter(Boolean).join(" · ");
}

function transcriptEventLabel(event: AnyRecord) {
  const suffix = event.truncated ? " · output truncated" : "";
  if (event.kind === "message") return `${String(event.role || "message").toUpperCase()} message${suffix}`;
  if (event.kind === "tool_call") return `Tool call${event.name ? ` · ${event.name}` : ""}${suffix}`;
  if (event.kind === "tool_result") return `Tool result${suffix}`;
  return `Summary${suffix}`;
}

function transcriptEventPreview(event: AnyRecord) {
  const value = String(event.text || event.callId || "");
  return value.length > 220 ? `${value.slice(0, 220)}...` : value;
}

function toneForStatus(status: string | null | undefined) {
  if (["ACTIVE", "RUNNING", "READY", "SUCCEEDED", "DONE", "ACCEPTED", "RESOLVED", "VALID"].includes(String(status))) return "green";
  if (["OPEN", "DRAFT", "PROPOSED", "CREATED", "IN_PROGRESS", "IN_REVIEW"].includes(String(status))) return "blue";
  if (["BLOCKED", "PAUSED", "DISABLED", "STALE"].includes(String(status))) return "amber";
  if (["FAILED", "CANCELED", "ARCHIVED", "INVALID", "DISMISSED"].includes(String(status))) return "red";
  return "";
}

function desktopSyncStatusLabel(status: unknown) {
  if (status === "WATCHING") return "监听中";
  if (status === "IDLE") return "空闲";
  if (status === "ERROR") return "出错";
  return "未绑定";
}

function Badge({ text, tone = "" }: { text: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{text}</span>;
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <div className="empty-note">{children}</div>;
}

function Panel({ title, iconName, children, meta = "" }: { title: string; iconName: string; children: ReactNode; meta?: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-title">{icon(iconName)}{title}</div>
        <div className="panel-meta mono">{meta}</div>
      </div>
      {children}
    </section>
  );
}

function Table({ headers, rows, empty = "暂无记录。" }: { headers: string[]; rows: ReactNode[][]; empty?: string }) {
  if (!rows.length) return <EmptyNote>{empty}</EmptyNote>;
  return (
    <div className="table-scroll">
      <table>
        <thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function Rows({ rows, empty = "暂无条目。" }: { rows: Array<[ReactNode, ReactNode, string, ReactNode?]>; empty?: string }) {
  if (!rows.length) return <EmptyNote>{empty}</EmptyNote>;
  return (
    <div>
      {rows.map(([title, status, tone, sub], index) => (
        <div className="list-row" key={index}>
          <div>
            <div className="title-sm">{title}</div>
            {sub ? <div className="muted">{sub}</div> : null}
          </div>
          <Badge text={status} tone={tone} />
        </div>
      ))}
    </div>
  );
}

export function App() {
  const initialPage = (location.hash.replace("#", "") || "overview") as PageId;
  const [page, setPage] = useState<PageId>(pages[initialPage] ? initialPage : "overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [data, setData] = useState<WorkspaceData>(() => emptyData());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [desktopSyncAuto, setDesktopSyncAuto] = useState(() => localStorage.getItem("contextos.desktopSyncAuto") === "true");
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null);
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [selectedContextSourceId, setSelectedContextSourceId] = useState<string | null>(null);
  const [sessionDetails, setSessionDetails] = useState<SessionDetails | null>(null);
  const [sessionDetailsLoading, setSessionDetailsLoading] = useState(false);
  const [reviewActionLog, setReviewActionLog] = useState<{ reviewId: string; items: AnyRecord[]; loading: boolean; error: string | null } | null>(null);
  const [decisionVersions, setDecisionVersions] = useState<{ decisionId: string; items: AnyRecord[]; loading: boolean; error: string | null } | null>(null);
  const [workItemDetail, setWorkItemDetail] = useState<{ workItemId: string; readiness: AnyRecord | null; dependencies: AnyRecord[]; children: AnyRecord[]; attempts: AnyRecord[]; activity: AnyRecord[]; loading: boolean; error: string | null } | null>(null);
  const [ruleDetail, setRuleDetail] = useState<{ ruleId: string; versions: AnyRecord[]; evaluations: AnyRecord[]; usage: AnyRecord | null; loading: boolean; error: string | null } | null>(null);
  const [ruleInstructionPreview, setRuleInstructionPreview] = useState<AnyRecord | null>(null);
  const [modal, setModal] = useState<{ kind: ModalKind; sessionId?: string; reviewId?: string; decisionId?: string; workItemId?: string; sourceId?: string; sourceSnapshotId?: string; contextItemId?: string }>({ kind: null });
  const [evidenceDetail, setEvidenceDetail] = useState<{ snapshot: AnyRecord; content: AnyRecord | null; loading: boolean; error: string | null } | null>(null);
  const [evidenceCompare, setEvidenceCompare] = useState<{ base: AnyRecord; other: AnyRecord; metadata: AnyRecord | null; content: AnyRecord | null; loading: boolean; error: string | null } | null>(null);
  const [contextItemDetail, setContextItemDetail] = useState<{ item: AnyRecord; versions: AnyRecord[]; loading: boolean; error: string | null } | null>(null);
  const preferredProjectIdRef = useRef<string | null>(null);
  const preferredSessionIdRef = useRef<string | null>(null);
  const preferredReviewIdRef = useRef<string | null>(null);
  const preferredDecisionIdRef = useRef<string | null>(null);
  const preferredWorkItemIdRef = useRef<string | null>(null);
  const preferredRuleIdRef = useRef<string | null>(null);
  const preferredContextSourceIdRef = useRef<string | null>(null);

  const availableAdapters = useCallback(() => data.adapters.filter((adapter) => adapter.available), [data.adapters]);
  const defaultAdapterId = useCallback(() => {
    const configured = data.settings?.defaultAdapterId;
    if (configured && data.adapters.some((adapter) => adapter.id === configured)) return configured;
    return availableAdapters()[0]?.id || data.adapters[0]?.id || "codex";
  }, [availableAdapters, data.adapters, data.settings?.defaultAdapterId]);
  const adapterList = data.adapters.length ? data.adapters : [{ id: "codex", displayName: "Codex", available: true }];

  const loadSessionDetails = useCallback(async (session: AnyRecord | undefined): Promise<SessionDetails | null> => {
    if (!session) return null;
    const [contextPack, evidence, resumeCapsule, runtimeStatus, runs, activity, transcriptEvents, desktopSync] = await Promise.all([
      settle(fetchJson(`/api/sessions/${session.id}/context-pack`)),
      settle(fetchJson(`/api/sessions/${session.id}/evidence`)),
      settle(fetchJson(`/api/sessions/${session.id}/resume-capsule`)),
      settle(fetchJson(`/api/sessions/${session.id}/runtime-status`)),
      settle(fetchJson(`/api/sessions/${session.id}/runs`)),
      settle(fetchJson(`/api/sessions/${session.id}/activity`)),
      settle(fetchJson(`/api/sessions/${session.id}/transcript-events`)),
      settle(fetchJson(`/api/sessions/${session.id}/desktop-sync`))
    ]);
    return {
      sessionId: session.id,
      contextPack: contextPack.ok ? contextPack.value : null,
      evidence: evidence.ok ? evidence.value?.items ?? [] : [],
      resumeCapsule: resumeCapsule.ok ? resumeCapsule.value : null,
      runtimeStatus: runtimeStatus.ok ? runtimeStatus.value : null,
      runs: runs.ok ? runs.value?.items ?? [] : [],
      activity: activity.ok ? activity.value?.items ?? [] : [],
      transcriptEvents: transcriptEvents.ok ? transcriptEvents.value : null,
      desktopSync: desktopSync.ok ? desktopSync.value : null
    };
  }, []);

  const loadReviewActionLog = useCallback(async (reviewId: string | null): Promise<{ reviewId: string; items: AnyRecord[]; loading: boolean; error: string | null } | null> => {
    if (!reviewId) return null;
    const result = await settle(fetchJson(`/api/review-items/${reviewId}/action-log`));
    return {
      reviewId,
      items: result.ok ? result.value?.items ?? [] : [],
      loading: false,
      error: result.ok ? null : result.error.message
    };
  }, []);

  const loadDecisionVersions = useCallback(async (decisionId: string | null): Promise<{ decisionId: string; items: AnyRecord[]; loading: boolean; error: string | null } | null> => {
    if (!decisionId) return null;
    const result = await settle(fetchJson(`/api/decisions/${decisionId}/versions`));
    return {
      decisionId,
      items: result.ok ? result.value?.items ?? [] : [],
      loading: false,
      error: result.ok ? null : result.error.message
    };
  }, []);

  const loadWorkItemDetail = useCallback(async (workItemId: string | null): Promise<{ workItemId: string; readiness: AnyRecord | null; dependencies: AnyRecord[]; children: AnyRecord[]; attempts: AnyRecord[]; activity: AnyRecord[]; loading: boolean; error: string | null } | null> => {
    if (!workItemId) return null;
    const [readiness, dependencies, children, attempts, activity] = await Promise.all([
      settle(fetchJson(`/api/work-items/${workItemId}/readiness`)),
      settle(fetchJson(`/api/work-items/${workItemId}/dependencies`)),
      settle(fetchJson(`/api/work-items/${workItemId}/children`)),
      settle(fetchJson(`/api/work-items/${workItemId}/attempts`)),
      settle(fetchJson(`/api/work-items/${workItemId}/activity`))
    ]);
    const error = !readiness.ok ? readiness.error.message : !dependencies.ok ? dependencies.error.message : !children.ok ? children.error.message : !attempts.ok ? attempts.error.message : !activity.ok ? activity.error.message : null;
    return { workItemId, readiness: readiness.ok ? readiness.value : null, dependencies: dependencies.ok ? dependencies.value?.items ?? [] : [], children: children.ok ? children.value?.items ?? [] : [], attempts: attempts.ok ? attempts.value?.items ?? [] : [], activity: activity.ok ? activity.value?.items ?? [] : [], loading: false, error };
  }, []);

  const loadRuleDetail = useCallback(async (ruleId: string | null): Promise<{ ruleId: string; versions: AnyRecord[]; evaluations: AnyRecord[]; usage: AnyRecord | null; loading: boolean; error: string | null } | null> => {
    if (!ruleId) return null;
    const [versions, evaluations, usage] = await Promise.all([
      settle(fetchJson(`/api/rules/${ruleId}/versions`)),
      settle(fetchJson(`/api/rules/${ruleId}/evaluations`)),
      settle(fetchJson(`/api/rules/${ruleId}/usage`))
    ]);
    const error = !versions.ok ? versions.error.message : !evaluations.ok ? evaluations.error.message : !usage.ok ? usage.error.message : null;
    return { ruleId, versions: versions.ok ? versions.value?.items ?? [] : [], evaluations: evaluations.ok ? evaluations.value?.items ?? [] : [], usage: usage.ok ? usage.value : null, loading: false, error };
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const requests = {
      health: fetchJson("/api/health"),
      overview: fetchJson("/api/workspace/overview"),
      projects: fetchJson("/api/projects"),
      sessions: fetchJson("/api/sessions"),
      reviews: fetchJson("/api/review-items"),
      decisions: fetchJson("/api/decisions"),
      workItems: fetchJson("/api/work-items"),
      contextSources: fetchJson("/api/context-sources"),
      evidenceSnapshots: fetchJson("/api/evidence-snapshots"),
      contextItems: fetchJson("/api/context-items"),
      rules: fetchJson("/api/rules"),
      settings: fetchJson("/api/settings"),
      runtimeHealth: fetchJson("/api/runtime/health"),
      adapters: fetchJson("/api/agent-adapters")
    };
    const entries = await Promise.all(Object.entries(requests).map(async ([key, promise]) => [key, await settle(promise)] as const));
    const next = emptyData();
    const failures: string[] = [];
    for (const [key, result] of entries) {
      if (result.ok) {
        (next as AnyRecord)[key] = Array.isArray((result.value as AnyRecord)?.items) ? (result.value as AnyRecord).items : result.value;
      } else {
        failures.push(`${key}: ${result.error.message}`);
      }
    }
    next.projects = next.projects.filter((project) => !isArchived(project));
    next.sessions = next.sessions.filter((session) => !isArchived(session));
    next.contextSources = next.contextSources.filter((source) => !isArchived(source));
    next.contextItems = next.contextItems.filter((item) => !isArchived(item));
    const selectedProject = next.projects.find((project) => project.id === preferredProjectIdRef.current) || next.projects[0];
    const selectedSession = next.sessions.find((session) => session.id === preferredSessionIdRef.current) || next.sessions[0];
    const selectedReview = next.reviews.find((review) => review.id === preferredReviewIdRef.current) || next.reviews.find((review) => ["OPEN", "IN_PROGRESS"].includes(review.status)) || next.reviews[0];
    const selectedDecision = next.decisions.find((decision) => decision.id === preferredDecisionIdRef.current) || next.decisions[0];
    const selectedWorkItem = next.workItems.find((item) => item.id === preferredWorkItemIdRef.current) || next.workItems.find((item) => ["READY", "IN_PROGRESS", "BLOCKED"].includes(item.status)) || next.workItems[0];
    const selectedRule = next.rules.find((rule) => rule.id === preferredRuleIdRef.current) || next.rules[0];
    const selectedContextSource = next.contextSources.find((source) => source.id === preferredContextSourceIdRef.current) || next.contextSources[0];
    setData(next);
    setError(failures.length === entries.length ? "守护进程不可用" : failures[0] || null);
    preferredProjectIdRef.current = selectedProject?.id || null;
    preferredSessionIdRef.current = selectedSession?.id || null;
    preferredReviewIdRef.current = selectedReview?.id || null;
    preferredDecisionIdRef.current = selectedDecision?.id || null;
    preferredWorkItemIdRef.current = selectedWorkItem?.id || null;
    preferredRuleIdRef.current = selectedRule?.id || null;
    preferredContextSourceIdRef.current = selectedContextSource?.id || null;
    setSelectedProjectId(selectedProject?.id || null);
    setSelectedSessionId(selectedSession?.id || null);
    setSelectedReviewId(selectedReview?.id || null);
    setSelectedDecisionId(selectedDecision?.id || null);
    setSelectedWorkItemId(selectedWorkItem?.id || null);
    setSelectedRuleId(selectedRule?.id || null);
    setSelectedContextSourceId(selectedContextSource?.id || null);
    setSessionDetailsLoading(Boolean(selectedSession));
    setSessionDetails(await loadSessionDetails(selectedSession));
    setSessionDetailsLoading(false);
    setReviewActionLog(await loadReviewActionLog(selectedReview?.id || null));
    setDecisionVersions(await loadDecisionVersions(selectedDecision?.id || null));
    setWorkItemDetail(await loadWorkItemDetail(selectedWorkItem?.id || null));
    setRuleDetail(await loadRuleDetail(selectedRule?.id || null));
    setLoading(false);
  }, [loadDecisionVersions, loadReviewActionLog, loadRuleDetail, loadSessionDetails, loadWorkItemDetail]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const onHashChange = () => {
      const next = location.hash.replace("#", "") as PageId;
      if (pages[next]) {
        setPage(next);
        setActionMessage(null);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    localStorage.setItem("contextos.desktopSyncAuto", String(desktopSyncAuto));
  }, [desktopSyncAuto]);

  const runAction = useCallback(async (task: () => Promise<unknown>, successMessage: string) => {
    setActionLoading(true);
    setActionMessage(null);
    try {
      await task();
      setActionLoading(false);
      setActionMessage({ text: successMessage, error: false });
      await loadData();
    } catch (actionError) {
      setActionLoading(false);
      if (actionError instanceof ActionCanceled) return;
      setActionMessage({ text: actionError instanceof Error ? actionError.message : "操作失败", error: true });
    }
  }, [loadData]);

  const confirmDestructiveAction = useCallback((message: string) => {
    if (!data.settings?.confirmDestructiveActions) return true;
    if (window.confirm(message)) return true;
    throw new ActionCanceled();
  }, [data.settings?.confirmDestructiveActions]);

  const projectById = useCallback((projectId: string) => data.projects.find((item) => item.id === projectId), [data.projects]);
  const sessionById = useCallback((sessionId: string) => data.sessions.find((item) => item.id === sessionId), [data.sessions]);
  const sourceById = useCallback((sourceId: string) => data.contextSources.find((item) => item.id === sourceId), [data.contextSources]);
  const ruleById = useCallback((ruleId: string) => data.rules.find((item) => item.id === ruleId), [data.rules]);
  const decisionById = useCallback((decisionId: string) => data.decisions.find((item) => item.id === decisionId), [data.decisions]);
  const workItemById = useCallback((workItemId: string) => data.workItems.find((item) => item.id === workItemId), [data.workItems]);
  const reviewById = useCallback((reviewId: string) => data.reviews.find((item) => item.id === reviewId), [data.reviews]);

  const selectProject = useCallback((projectId: string) => {
    preferredProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
  }, []);

  const selectSession = useCallback(async (sessionId: string) => {
    const session = sessionById(sessionId);
    preferredSessionIdRef.current = sessionId;
    setSelectedSessionId(sessionId);
    setSessionDetails(null);
    setSessionDetailsLoading(Boolean(session));
    setSessionDetails(await loadSessionDetails(session));
    setSessionDetailsLoading(false);
  }, [loadSessionDetails, sessionById]);

  const openSession = useCallback(async (sessionId: string) => {
    await selectSession(sessionId);
    location.hash = "sessions";
  }, [selectSession]);

  const selectReview = useCallback(async (reviewId: string) => {
    preferredReviewIdRef.current = reviewId;
    setSelectedReviewId(reviewId);
    setReviewActionLog({ reviewId, items: [], loading: true, error: null });
    setReviewActionLog(await loadReviewActionLog(reviewId));
  }, [loadReviewActionLog]);

  const selectDecision = useCallback(async (decisionId: string) => {
    preferredDecisionIdRef.current = decisionId;
    setSelectedDecisionId(decisionId);
    setDecisionVersions({ decisionId, items: [], loading: true, error: null });
    setDecisionVersions(await loadDecisionVersions(decisionId));
  }, [loadDecisionVersions]);

  const selectWorkItem = useCallback(async (workItemId: string) => {
    preferredWorkItemIdRef.current = workItemId;
    setSelectedWorkItemId(workItemId);
    setWorkItemDetail({ workItemId, readiness: null, dependencies: [], children: [], attempts: [], activity: [], loading: true, error: null });
    setWorkItemDetail(await loadWorkItemDetail(workItemId));
  }, [loadWorkItemDetail]);

  const selectRule = useCallback(async (ruleId: string) => {
    preferredRuleIdRef.current = ruleId;
    setSelectedRuleId(ruleId);
    setRuleDetail({ ruleId, versions: [], evaluations: [], usage: null, loading: true, error: null });
    setRuleDetail(await loadRuleDetail(ruleId));
  }, [loadRuleDetail]);

  const selectContextSource = useCallback((sourceId: string) => {
    preferredContextSourceIdRef.current = sourceId;
    setSelectedContextSourceId(sourceId);
  }, []);

  const archiveProject = useCallback(async (projectId: string) => {
    const project = projectById(projectId);
    if (!project) throw new Error("没有可归档的项目");
    if (!confirmDestructiveAction(`Archive project "${project.name}"?`)) return;
    await sendJson(`/api/projects/${project.id}/archive`, "POST", { expectedRevision: project.revision });
  }, [confirmDestructiveAction, projectById]);

  const transitionProject = useCallback(async (projectId: string, action: string) => {
    const project = projectById(projectId);
    if (!project) throw new Error("没有可用的项目");
    if (action === "archive" && !confirmDestructiveAction(`Archive project "${project.name}"?`)) return;
    await sendJson(`/api/projects/${project.id}/${action}`, "POST", { expectedRevision: project.revision });
  }, [confirmDestructiveAction, projectById]);

  const archiveSession = useCallback(async (sessionId: string) => {
    const session = sessionById(sessionId);
    if (!session) throw new Error("没有可归档的会话");
    if (!confirmDestructiveAction(`Archive session "${session.title || session.id}"?`)) return;
    await sendJson(`/api/sessions/${session.id}/archive`, "POST", { expectedRevision: session.revision });
  }, [confirmDestructiveAction, sessionById]);

  const continueSession = useCallback(async (sessionId: string) => {
    const session = sessionById(sessionId);
    if (!session) throw new Error("没有可继续的会话");
    await sendJson(`/api/sessions/${session.id}/continue`, "POST", { expectedRevision: session.revision });
    window.setTimeout(() => void loadData(), 500);
  }, [loadData, sessionById]);

  const importTranscriptAuto = useCallback(async (sessionId: string, input: AnyRecord = {}) => {
    const session = sessionById(sessionId);
    if (!session) throw new Error("没有可用于导入对话记录的会话");
    await sendJson(`/api/sessions/${session.id}/import-transcript/auto`, "POST", input);
  }, [sessionById]);

  const syncSessionTranscript = useCallback(async (sessionId: string) => {
    const session = sessionById(sessionId);
    if (!session) throw new Error("没有可用于同步对话记录的会话");
    await sendJson(`/api/sessions/${session.id}/sync-transcript`, "POST", {});
  }, [sessionById]);

  const bindDesktopSync = useCallback(async (sessionId: string, input: AnyRecord = {}) => {
    const session = sessionById(sessionId);
    if (!session) throw new Error("没有可用于 Desktop 同步的会话");
    await sendJson(`/api/sessions/${session.id}/desktop-sync/bind`, "POST", {
      externalSessionId: String(input.externalSessionId || "").trim() || undefined,
      transcriptPath: String(input.transcriptPath || "").trim() || undefined,
      fromBeginning: input.fromBeginning === true
    });
  }, [sessionById]);

  const syncDesktopSync = useCallback(async (sessionId: string) => {
    const session = sessionById(sessionId);
    if (!session) throw new Error("没有可用于 Desktop 同步的会话");
    return sendJson(`/api/sessions/${session.id}/desktop-sync/sync`, "POST", {});
  }, [sessionById]);

  const unbindDesktopSync = useCallback(async (sessionId: string) => {
    const session = sessionById(sessionId);
    if (!session) throw new Error("没有可用于 Desktop 同步的会话");
    await sendJson(`/api/sessions/${session.id}/desktop-sync`, "DELETE", {});
  }, [sessionById]);

  const interruptSession = useCallback(async (sessionId: string) => {
    const session = sessionById(sessionId);
    if (!session) throw new Error("没有可中断的会话");
    if (!confirmDestructiveAction(`Interrupt the active run for "${session.title || session.id}"?`)) return;
    await sendJson(`/api/sessions/${session.id}/interrupt`, "POST", { expectedRevision: session.revision });
  }, [confirmDestructiveAction, sessionById]);

  const exportSessionCapsule = useCallback(async (sessionId: string) => {
    const session = sessionById(sessionId);
    if (!session) throw new Error("没有可导出的会话");
    const [contextPack, evidence, resumeCapsule, runtimeStatus, activity, transcriptEvents] = await Promise.all([
      settle(fetchJson(`/api/sessions/${session.id}/context-pack`)),
      settle(fetchJson(`/api/sessions/${session.id}/evidence`)),
      settle(fetchJson(`/api/sessions/${session.id}/resume-capsule`)),
      settle(fetchJson(`/api/sessions/${session.id}/runtime-status`)),
      settle(fetchJson(`/api/sessions/${session.id}/activity`)),
      settle(fetchJson(`/api/sessions/${session.id}/transcript-events`))
    ]);
    const capsule = {
      schemaVersion: "contextos.session-capsule.v1",
      exportedAt: new Date().toISOString(),
      session,
      contextPack: contextPack.ok ? contextPack.value : null,
      evidence: evidence.ok ? evidence.value?.items ?? [] : [],
      resumeCapsule: resumeCapsule.ok ? resumeCapsule.value : null,
      runtimeStatus: runtimeStatus.ok ? runtimeStatus.value : null,
      activity: activity.ok ? activity.value?.items ?? [] : [],
      transcriptEvents: transcriptEvents.ok ? transcriptEvents.value : null,
      warnings: [
        contextPack.ok ? null : `contextPack: ${contextPack.error.message}`,
        evidence.ok ? null : `evidence: ${evidence.error.message}`,
        resumeCapsule.ok ? null : `resumeCapsule: ${resumeCapsule.error.message}`,
        runtimeStatus.ok ? null : `runtimeStatus: ${runtimeStatus.error.message}`,
        activity.ok ? null : `activity: ${activity.error.message}`,
        transcriptEvents.ok ? null : `transcriptEvents: ${transcriptEvents.error.message}`
      ].filter(Boolean)
    };
    downloadJson(`contextos-session-${session.id}.json`, capsule);
  }, [sessionById]);

  const syncSource = useCallback(async (sourceId: string) => {
    const source = sourceById(sourceId);
    if (!source) throw new Error("没有可同步的数据源");
    await sendJson(`/api/context-sources/${source.id}/sync`, "POST", { expectedRevision: source.revision });
  }, [sourceById]);
  const transitionSource = useCallback(async (sourceId: string, action: string) => {
    const source = sourceById(sourceId);
    if (!source) throw new Error("没有可用的数据源");
    if (action === "archive" && !confirmDestructiveAction(`Archive context source "${source.name}"?`)) return;
    await sendJson(`/api/context-sources/${source.id}/${action}`, "POST", { expectedRevision: source.revision });
  }, [confirmDestructiveAction, sourceById]);

  const syncActiveSources = useCallback(async () => {
    const sources = data.contextSources.filter((source) => source.status === "ACTIVE");
    if (!sources.length) throw new Error("没有处于启用状态的数据源可同步");
    for (const source of sources) await syncSource(source.id);
  }, [data.contextSources, syncSource]);

  const verifyEvidence = useCallback((snapshotId: string) => sendJson(`/api/evidence-snapshots/${snapshotId}/verify`, "POST", {}), []);
  const openEvidenceDetail = useCallback(async (snapshot: AnyRecord) => {
    setEvidenceDetail({ snapshot, content: null, loading: true, error: null });
    try {
      const content = await fetchJson(`/api/evidence-snapshots/${snapshot.id}/content?maxChars=50000`);
      setEvidenceDetail({ snapshot, content, loading: false, error: null });
    } catch (detailError) {
      setEvidenceDetail({ snapshot, content: null, loading: false, error: detailError instanceof Error ? detailError.message : "Evidence content unavailable" });
    }
  }, []);
  const openEvidenceCompare = useCallback(async (base: AnyRecord, other: AnyRecord) => {
    setEvidenceCompare({ base, other, metadata: null, content: null, loading: true, error: null });
    const [metadata, content] = await Promise.all([
      settle(sendJson(`/api/evidence-snapshots/${base.id}/compare`, "POST", { otherSnapshotId: other.id })),
      settle(sendJson(`/api/evidence-snapshots/${base.id}/compare-content`, "POST", { otherSnapshotId: other.id, maxChars: 50000 }))
    ]);
    setEvidenceCompare({
      base,
      other,
      metadata: metadata.ok ? metadata.value : null,
      content: content.ok ? content.value : null,
      loading: false,
      error: metadata.ok && content.ok ? null : [metadata.ok ? null : metadata.error.message, content.ok ? null : content.error.message].filter(Boolean).join("; ")
    });
  }, []);
  const transitionContextItem = useCallback(async (itemId: string, action: string) => {
    const item = data.contextItems.find((entry) => entry.id === itemId);
    if (!item) throw new Error("没有可用的上下文项");
    if (action === "archive" && !confirmDestructiveAction(`Archive context item "${item.title}"?`)) return;
    await sendJson(`/api/context-items/${item.id}/${action}`, "POST", { expectedRevision: item.revision });
  }, [confirmDestructiveAction, data.contextItems]);
  const openContextItemDetail = useCallback(async (item: AnyRecord) => {
    setContextItemDetail({ item, versions: [], loading: true, error: null });
    try {
      const result = await fetchJson(`/api/context-items/${item.id}/versions`);
      setContextItemDetail({ item, versions: result.items || [], loading: false, error: null });
    } catch (detailError) {
      setContextItemDetail({ item, versions: [], loading: false, error: detailError instanceof Error ? detailError.message : "Context item versions unavailable" });
    }
  }, []);
  const restoreContextItemVersion = useCallback(async (itemId: string, versionNumber: number) => {
    const item = data.contextItems.find((entry) => entry.id === itemId);
    if (!item) throw new Error("没有可用的上下文项");
    await sendJson(`/api/context-items/${item.id}/versions/${versionNumber}/restore`, "POST", { expectedRevision: item.revision });
    setContextItemDetail(null);
  }, [data.contextItems]);
  const validateRule = useCallback((ruleId: string) => sendJson(`/api/rules/${ruleId}/validate`, "POST", {}), []);
  const testRule = useCallback((ruleId: string) => sendJson(`/api/rules/${ruleId}/test`, "POST", { eventType: "session.continue", resourceType: "SESSION", data: {} }), []);
  const transitionRule = useCallback(async (ruleId: string, action: string) => {
    const rule = ruleById(ruleId);
    if (!rule) throw new Error("没有可用的规则");
    await sendJson(`/api/rules/${rule.id}/${action}`, "POST", { expectedRevision: rule.revision });
  }, [ruleById]);
  const renderRuleInstructions = useCallback(async (target: string, apply: boolean) => {
    const project = data.projects.find((item) => item.id === selectedProjectId) || data.projects[0];
    if (!project) throw new Error("Create a project before rendering rule instructions");
    const result = await sendJson("/api/rules/render-instructions", "POST", { projectId: project.id, target, apply });
    setRuleInstructionPreview(result);
  }, [data.projects, selectedProjectId]);
  const transitionDecision = useCallback(async (decisionId: string, action: string) => {
    const decision = decisionById(decisionId);
    if (!decision) throw new Error("没有可用的决策");
    if (action === "archive" && !confirmDestructiveAction(`Archive decision "${decision.title}"?`)) return;
    if (action === "supersede" && !confirmDestructiveAction(`Supersede accepted decision "${decision.title}"?`)) return;
    if (action === "reverse" && !confirmDestructiveAction(`Reverse accepted decision "${decision.title}"?`)) return;
    await sendJson(`/api/decisions/${decision.id}/${action}`, "POST", { expectedRevision: decision.revision });
  }, [confirmDestructiveAction, decisionById]);
  const transitionWorkItem = useCallback(async (workItemId: string, action: string) => {
    const item = workItemById(workItemId);
    if (!item) throw new Error("没有可用的工作项");
    if (action === "cancel" && !confirmDestructiveAction(`取消 work item "${item.title}"?`)) return;
    await sendJson(`/api/work-items/${item.id}/${action}`, "POST", { expectedRevision: item.revision });
  }, [confirmDestructiveAction, workItemById]);
  const startWorkItemSession = useCallback(async (workItemId: string) => {
    const item = workItemById(workItemId);
    if (!item) throw new Error("没有可用的工作项");
    await sendJson(`/api/work-items/${item.id}/start-session`, "POST", { expectedRevision: item.revision });
  }, [workItemById]);
  const resolveReview = useCallback(async (reviewId: string, input: AnyRecord) => {
    const review = reviewById(reviewId);
    if (!review) throw new Error("没有可用的审查项");
    await sendJson(`/api/review-items/${review.id}/resolve`, "POST", { ...input, expectedRevision: review.revision });
  }, [reviewById]);
  const dismissReview = useCallback(async (reviewId: string, reason: string) => {
    const review = reviewById(reviewId);
    if (!review) throw new Error("没有可用的审查项");
    await sendJson(`/api/review-items/${review.id}/dismiss`, "POST", { resolutionReason: reason, expectedRevision: review.revision });
  }, [reviewById]);
  const startReview = useCallback(async (reviewId: string) => {
    const review = reviewById(reviewId);
    if (!review) throw new Error("没有可用的审查项");
    await sendJson(`/api/review-items/${review.id}/start`, "POST", { expectedRevision: review.revision });
  }, [reviewById]);
  const assignReview = useCallback(async (reviewId: string, reviewerId: string) => {
    const review = reviewById(reviewId);
    if (!review) throw new Error("没有可用的审查项");
    await sendJson(`/api/review-items/${review.id}/assign`, "POST", { reviewerId, expectedRevision: review.revision });
  }, [reviewById]);

  // Desktop sync is a tail, not a subscription: nothing pushes to us, so a
  // bound session only stays current while we poll the byte offset.
  useEffect(() => {
    const sessionId = selectedSessionId;
    const bound = Boolean(sessionDetails?.desktopSync?.transcriptPath);
    if (!desktopSyncAuto || page !== "sessions" || !sessionId || !bound) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const result = (await syncDesktopSync(sessionId)) as AnyRecord;
        if (cancelled) return;
        setSessionDetails((current) => (current && current.sessionId === sessionId ? { ...current, desktopSync: result } : current));
      } catch {
        // A failed poll keeps the last known state; the manual button surfaces errors.
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [desktopSyncAuto, page, selectedSessionId, sessionDetails?.desktopSync?.transcriptPath, syncDesktopSync]);

  const handleAction = useCallback((action: string) => {
    if (action === "refresh-context" || action === "reset-changes") return void loadData();
    if (action === "add-project") return setModal({ kind: "project" });
    if (action === "new-session") return data.projects[0] ? setModal({ kind: "session" }) : setActionMessage({ text: "请先创建项目，再开始会话", error: true });
    if (action === "new-rule") return data.projects[0] ? setModal({ kind: "rule" }) : setActionMessage({ text: "请先创建项目，再添加规则", error: true });
    if (action === "add-source") return data.projects[0] ? setModal({ kind: "source" }) : setActionMessage({ text: "请先创建项目，再添加数据源", error: true });
    if (action === "add-context-item") {
      const selectedSource = selectedContextSourceId ? data.contextSources.find((item) => item.id === selectedContextSourceId) : null;
      const snapshot = selectedSource?.lastSnapshotId ? data.evidenceSnapshots.find((item) => item.id === selectedSource.lastSnapshotId) : null;
      return data.projects[0] ? setModal({ kind: "contextItem", sourceSnapshotId: snapshot?.id }) : setActionMessage({ text: "请先创建项目，再添加上下文项", error: true });
    }
    if (action === "record-decision") return data.projects[0] ? setModal({ kind: "decision" }) : setActionMessage({ text: "请先创建项目，再记录决策", error: true });
    if (action === "compare-versions") return document.getElementById("decision-version-compare")?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (action === "create-item") return data.projects[0] ? setModal({ kind: "workItem" }) : setActionMessage({ text: "请先创建项目，再创建工作项", error: true });
    if (action === "start-ready-item") {
      const item = data.workItems.find((workItem) => workItem.status === "READY");
      if (!item) return setActionMessage({ text: "没有就绪的工作项", error: true });
      return void runAction(() => startWorkItemSession(item.id), "工作项会话已启动");
    }
    if (action === "approve-selected" || action === "reject") {
      const selectedReview = selectedReviewId ? data.reviews.find((item) => item.id === selectedReviewId) : null;
      const review = selectedReview && ["OPEN", "IN_PROGRESS"].includes(selectedReview.status) ? selectedReview : data.reviews.find((item) => ["OPEN", "IN_PROGRESS"].includes(item.status));
      if (!review) return setActionMessage({ text: "没有待处理的审查项", error: true });
      return setModal({ kind: action === "approve-selected" ? "reviewResolve" : "reviewDismiss", reviewId: review.id });
    }
    if (action === "sync-sources") return void runAction(syncActiveSources, "数据源已同步");
    if (action === "continue-in-agent") {
      const selected = selectedSessionId ? data.sessions.find((item) => item.id === selectedSessionId) : null;
      const session = selected && ["CREATED", "PAUSED", "FAILED", "COMPLETED"].includes(selected.status) ? selected : data.sessions.find((item) => ["CREATED", "PAUSED", "FAILED", "COMPLETED"].includes(item.status));
      if (!session) return setActionMessage({ text: "请先创建会话，再在智能体中继续", error: true });
      return void runAction(() => continueSession(session.id), "会话已在智能体中继续");
    }
    if (action === "desktop-sync") {
      const session = selectedSessionId ? data.sessions.find((item) => item.id === selectedSessionId) : null;
      if (!session) return setActionMessage({ text: "请先创建或选择会话，再绑定 Desktop 同步", error: true });
      return setModal({ kind: "desktopSync", sessionId: session.id });
    }
    if (action === "import-transcript") {
      const session = selectedSessionId ? data.sessions.find((item) => item.id === selectedSessionId) : data.sessions[0];
      if (!session) return setActionMessage({ text: "请先创建会话，再导入对话记录", error: true });
      return setModal({ kind: "transcript", sessionId: session.id });
    }
    if (action === "sync-transcript") {
      const session = selectedSessionId ? data.sessions.find((item) => item.id === selectedSessionId) : data.sessions[0];
      if (!session) return setActionMessage({ text: "请先创建或选择会话，再同步对话记录", error: true });
      return void runAction(() => syncSessionTranscript(session.id), "已从智能体同步对话记录");
    }
    if (action === "import-existing-session") {
      const session = selectedSessionId ? data.sessions.find((item) => item.id === selectedSessionId) : data.sessions[0];
      if (!session) return setActionMessage({ text: "请先创建 ContextOS 会话，再导入已有智能体会话", error: true });
      return setModal({ kind: "existingTranscript", sessionId: session.id });
    }
    if (action === "export-capsule") {
      const session = selectedSessionId ? data.sessions.find((item) => item.id === selectedSessionId) : data.sessions[0];
      if (!session) return setActionMessage({ text: "请先创建或选择会话，再导出摘要胶囊", error: true });
      return void runAction(() => exportSessionCapsule(session.id), "会话摘要胶囊已导出");
    }
    if (action === "save-changes" && data.settings) {
      const select = document.getElementById("setting-default-adapter") as HTMLSelectElement | null;
      const confirm = document.getElementById("setting-confirm-destructive") as HTMLInputElement | null;
      const startup = document.getElementById("setting-launch-startup") as HTMLInputElement | null;
      return void runAction(() => sendJson("/api/settings", "PATCH", {
        defaultAdapterId: select?.value || defaultAdapterId(),
        confirmDestructiveActions: Boolean(confirm?.checked),
        launchAtStartup: Boolean(startup?.checked),
        expectedRevision: data.settings!.revision
      }), "设置已保存");
    }
  }, [continueSession, data.contextSources, data.evidenceSnapshots, data.projects, data.reviews, data.sessions, data.settings, data.workItems, defaultAdapterId, exportSessionCapsule, loadData, runAction, selectedContextSourceId, selectedReviewId, selectedSessionId, startWorkItemSession, syncActiveSources, syncSessionTranscript, transitionWorkItem]);

  const navigate = (next: PageId) => {
    setPage(next);
    setActionMessage(null);
    location.hash = next;
  };

  const renderPage = () => {
    if (loading) return <><PageHeader pageDef={pages[page]} actionLoading={actionLoading} error={error} actionMessage={actionMessage} onAction={handleAction} /><EmptyNote>正在加载工作区数据...</EmptyNote></>;
    const props = { data, actionLoading, runAction, archiveProject, transitionProject, archiveSession, continueSession, importTranscriptAuto, syncSessionTranscript, bindDesktopSync, syncDesktopSync, unbindDesktopSync, desktopSyncAuto, setDesktopSyncAuto, interruptSession, exportSessionCapsule, syncSource, transitionSource, verifyEvidence, openEvidenceDetail, openEvidenceCompare, transitionContextItem, openContextItemDetail, restoreContextItemVersion, validateRule, testRule, transitionRule, renderRuleInstructions, transitionDecision, transitionWorkItem, startWorkItemSession, resolveReview, dismissReview, startReview, assignReview, setModal, defaultAdapterId, adapterList, selectedProjectId, selectProject, selectedSessionId, selectSession, openSession, sessionDetails, sessionDetailsLoading, selectedReviewId, selectReview, reviewActionLog, selectedDecisionId, selectDecision, decisionVersions, selectedWorkItemId, selectWorkItem, workItemDetail, selectedRuleId, selectRule, ruleDetail, ruleInstructionPreview, selectedContextSourceId, selectContextSource };
    switch (page) {
      case "overview": return <OverviewPage data={data} header={<PageHeader pageDef={pages.overview} actionLoading={actionLoading} error={error} actionMessage={actionMessage} onAction={handleAction} />} />;
      case "projects": return <ProjectsPage {...props} header={<PageHeader pageDef={pages.projects} actionLoading={actionLoading} error={error} actionMessage={actionMessage} onAction={handleAction} />} />;
      case "sessions": return <SessionsPage {...props} header={<PageHeader pageDef={pages.sessions} actionLoading={actionLoading} error={error} actionMessage={actionMessage} onAction={handleAction} />} />;
      case "review": return <ReviewPage {...props} header={<PageHeader pageDef={pages.review} actionLoading={actionLoading} error={error} actionMessage={actionMessage} onAction={handleAction} />} />;
      case "decisions": return <DecisionsPage {...props} header={<PageHeader pageDef={pages.decisions} actionLoading={actionLoading} error={error} actionMessage={actionMessage} onAction={handleAction} />} />;
      case "work": return <WorkPage {...props} header={<PageHeader pageDef={pages.work} actionLoading={actionLoading} error={error} actionMessage={actionMessage} onAction={handleAction} />} />;
      case "context": return <ContextPage {...props} header={<PageHeader pageDef={pages.context} actionLoading={actionLoading} error={error} actionMessage={actionMessage} onAction={handleAction} />} />;
      case "rules": return <RulesPage {...props} header={<PageHeader pageDef={pages.rules} actionLoading={actionLoading} error={error} actionMessage={actionMessage} onAction={handleAction} />} />;
      case "settings": return <SettingsPage {...props} header={<PageHeader pageDef={pages.settings} actionLoading={actionLoading} error={error} actionMessage={actionMessage} onAction={handleAction} />} />;
    }
  };

  return (
    <>
      <aside className="sidebar">
        <div>
          <div className="brand"><div className="brand-mark">{icon("terminal")}</div><div><div className="brand-title">ContextOS</div><div className="brand-sub mono">智能体工作区</div></div></div>
          <div className="nav">
            {navGroups.map((group) => (
              <div className="nav-group" key={group.label}>
                <div className="nav-label mono">{group.label}</div>
                {group.items.map(([id, ic, label]) => (
                  <button className={`nav-item ${page === id ? "active" : ""}`} data-nav={id} key={id} onClick={() => navigate(id)}>
                    <span className="nav-left">{icon(ic)}<span>{label}</span></span>{id === "review" && data.reviews.length ? <span className="count mono">{data.reviews.length}</span> : null}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="daemon"><div className="daemon-main"><span className="dot" /><div><div className="daemon-title">{data.health ? "守护进程运行中" : loading ? "检查守护进程" : "守护进程离线"}</div><div className="daemon-sub mono">{API_BASE.replace(/^https?:\/\//, "")}</div></div></div><button className="icon-btn" onClick={() => navigate("settings")} title="设置">{icon("settings")}</button></div>
      </aside>
      <div className="shell">
        <header className="topbar">
          <div className="crumbs mono"><span>工作区</span><span>/</span><span className="crumb-current">{pages[page].title}</span><ProjectPill project={data.projects[0]} /></div>
          <div className="top-actions">
            <div className="search">{icon("search")}<input placeholder="搜索项目、会话、决策..." /></div>
            <div className="agent-pill mono"><span className="dot" /><span>{data.adapters.filter((adapter) => adapter.available).length} 个已连接</span><span className="quiet">·</span><strong>{data.adapters.length} 个适配器可用</strong></div>
            <button className="icon-btn" title="刷新" onClick={() => void loadData()}>{icon("refresh")}</button>
            <div className="identity"><div className="avatar">AD</div><div><strong>Adam</strong><div className="daemon-sub mono">首席架构师</div></div></div>
          </div>
        </header>
        <main className="main"><div className={`page ${pages[page].narrow ? "narrow" : ""}`}>{renderPage()}</div></main>
      </div>
      <WorkspaceModal
        modal={modal}
        setModal={setModal}
        data={data}
        defaultAdapterId={defaultAdapterId}
        adapterList={adapterList}
        sessionDetails={sessionDetails}
        decisionVersions={decisionVersions}
        workItemDetail={workItemDetail}
        selectedProjectId={selectedProjectId}
        runAction={runAction}
        confirmDestructiveAction={confirmDestructiveAction}
        bindDesktopSync={bindDesktopSync}
      />
      <EvidenceDetail detail={evidenceDetail} onClose={() => setEvidenceDetail(null)} />
      <EvidenceCompare detail={evidenceCompare} onClose={() => setEvidenceCompare(null)} />
      <ContextItemDetail detail={contextItemDetail} actionLoading={actionLoading} runAction={runAction} restoreContextItemVersion={restoreContextItemVersion} onClose={() => setContextItemDetail(null)} />
    </>
  );
}

function PageHeader({ pageDef, actionLoading, error, actionMessage, onAction }: { pageDef: PageDef; actionLoading: boolean; error: string | null; actionMessage: { text: string; error: boolean } | null; onAction: (action: string) => void }) {
  return (
    <section className="page-head">
      <div>
        <h1>{pageDef.title}</h1>
        <p className="lead">{pageDef.subtitle}</p>
        {error ? <p className="lead">{error}. Showing available local data.</p> : null}
        {actionMessage ? <p className={`action-notice ${actionMessage.error ? "error" : "success"}`}>{actionMessage.text}</p> : null}
      </div>
      <div className="actions">
        {pageDef.actions.map(([ic, label, kind, id]) => {
          const disabled = !enabledActions.has(id) || actionLoading;
          return <button className={`btn ${kind || ""}`} data-action={id} disabled={disabled} key={id} onClick={() => onAction(id)}>{icon(actionLoading && enabledActions.has(id) ? "progress_activity" : ic)}<span>{label}</span></button>;
        })}
      </div>
    </section>
  );
}

function ProjectPill({ project }: { project?: AnyRecord }) {
  return <span className="project-pill">{icon("folder_managed")} {project ? `${project.name} (${project.rootPath})` : "未加载项目"}</span>;
}

function OverviewPage({ data, header }: { data: WorkspaceData; header: ReactNode }) {
  const overview = data.overview;
  const activeProject = overview?.project || data.projects[0];
  const nextWork = overview?.nextWorkItems || data.workItems.filter((item) => ["READY", "IN_PROGRESS"].includes(item.status)).map((item) => ({ id: item.id, title: item.title, status: item.status, subtitle: item.description || "", updatedAt: item.updatedAt }));
  const pendingReviews = overview?.pendingReviews || data.reviews.map((item) => ({ id: item.id, title: item.summary, status: item.status, subtitle: item.proposedResolution || "", updatedAt: item.updatedAt }));
  const kpis = overview?.kpis || { sessions: data.sessions.length, pendingReviews: data.reviews.length, readyWorkItems: nextWork.length, activeContextItems: data.contextItems.filter((item) => item.status === "ACTIVE").length, activeRules: data.rules.filter((item) => item.status === "ACTIVE").length };
  const contextHealth = overview?.contextHealth || { activeSources: data.contextSources.filter((item) => item.status === "ACTIVE").length, pausedSources: data.contextSources.filter((item) => item.status === "PAUSED").length, evidenceSnapshots: data.evidenceSnapshots.length, activeContextItems: data.contextItems.filter((item) => item.status === "ACTIVE").length, staleContextItems: data.contextItems.filter((item) => item.status === "STALE").length };
  const latestPackage = overview?.latestContextPackage;
  return (
    <>
      {header}
      <div className="kpi-grid">{[[kpis.sessions, "会话"], [kpis.readyWorkItems, "就绪工作"], [kpis.pendingReviews, "需要审查"], [kpis.activeContextItems, "活动上下文"], [kpis.activeRules, "活动规则"]].map(([value, label]) => <div className="kpi" key={String(label)}><div className="kpi-value">{value}</div><div className="kpi-label mono">{label}</div></div>)}</div>
      <div className="grid cols-12" style={{ marginTop: 16 }}>
        <div className="span-8 stack">
          <Panel title="当前项目" iconName="folder_open">{activeProject ? <div className="pad stack"><div className="split"><div><div className="title-sm">{activeProject.name}</div><div className="muted">{activeProject.description || "智能体工作区治理"}</div></div><Badge text={activeProject.status} tone={toneForStatus(activeProject.status)} /></div><div className="progress"><span style={{ width: "72%" }} /></div><div className="split mono muted"><span>边界：{activeProject.rootPath}</span><span>版本：{activeProject.revision}</span></div></div> : <EmptyNote>请创建一个项目以开始使用 ContextOS。</EmptyNote>}</Panel>
          <Panel title="下一步工作项" iconName="task_alt" meta={`${nextWork.length} ready signals`}><Rows rows={nextWork.slice(0, 5).map((item: AnyRecord) => [item.title, item.status, toneForStatus(item.status), item.subtitle || ""])} empty="暂无就绪工作项。" /></Panel>
          <Panel title="最新上下文包" iconName="inventory_2" meta={latestPackage?.id || "无上下文包"}>
            {latestPackage ? <div className="stack compact"><div className="metric-row"><span>用途</span><strong>{latestPackage.purpose}</strong></div><div className="metric-row"><span>进行中的工作项</span><strong>{latestPackage.workItems?.length || 0}</strong></div><div className="metric-row"><span>决策 / 规则</span><strong>{(latestPackage.decisions?.length || 0) + (latestPackage.rules?.length || 0)}</strong></div><div className="metric-row"><span>上下文 / 证据</span><strong>{latestPackage.contextItems.length} / {latestPackage.evidenceSnapshots.length}</strong></div>{[...(latestPackage.workItems || []), ...latestPackage.contextItems].slice(0, 4).map((item: AnyRecord) => <div className="metric-row" key={`${item.resourceType}-${item.id}`}><span>{item.title}</span><Badge text={item.selectionReason} tone="blue" /></div>)}</div> : <EmptyNote>请继续一个会话以生成上下文包。</EmptyNote>}
          </Panel>
        </div>
        <div className="span-4 stack">
          <Panel title="治理队列" iconName="inbox"><Rows rows={pendingReviews.slice(0, 5).map((item: AnyRecord) => [item.title, item.status, toneForStatus(item.status), item.subtitle || ""])} empty="暂无待审查项。" /></Panel>
          <Panel title="上下文健康度" iconName="link"><div className="metric-row"><span>活动数据源</span><strong>{contextHealth.activeSources}</strong></div><div className="metric-row"><span>暂停数据源</span><strong>{contextHealth.pausedSources}</strong></div><div className="metric-row"><span>证据快照</span><strong>{contextHealth.evidenceSnapshots}</strong></div><div className="metric-row"><span>过期上下文</span><strong>{contextHealth.staleContextItems}</strong></div></Panel>
        </div>
      </div>
    </>
  );
}

function ProjectsPage(props: AnyRecord & { header: ReactNode }) {
  const { data, header, actionLoading, runAction, archiveProject, transitionProject, selectedProjectId, selectProject } = props;
  const selectedProject = data.projects.find((project: AnyRecord) => project.id === selectedProjectId) || data.projects[0];
  const projectSessions = selectedProject ? data.sessions.filter((item: AnyRecord) => item.projectId === selectedProject.id) : [];
  const projectWork = selectedProject ? data.workItems.filter((item: AnyRecord) => item.projectId === selectedProject.id) : [];
  const projectSources = selectedProject ? data.contextSources.filter((item: AnyRecord) => item.projectId === selectedProject.id) : [];
  const projectEvidence = selectedProject ? data.evidenceSnapshots.filter((item: AnyRecord) => item.projectId === selectedProject.id) : [];
  const projectRules = selectedProject ? data.rules.filter((item: AnyRecord) => item.projectId === selectedProject.id) : [];
  const projectDecisions = selectedProject ? data.decisions.filter((item: AnyRecord) => item.projectId === selectedProject.id) : [];
  const latestSessions = [...projectSessions].sort((a: AnyRecord, b: AnyRecord) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, 5);
  const activeWork = projectWork.filter((item: AnyRecord) => ["READY", "IN_PROGRESS", "BLOCKED", "IN_REVIEW"].includes(item.status)).slice(0, 5);
  return <>{header}<div className="grid cols-12"><div className="span-8 stack">
    <Panel title="项目注册表" iconName="folder_open"><Table headers={["项目", "边界", "规则", "健康度", "操作"]} rows={data.projects.map((project: AnyRecord) => [
      <div className={`session-cell ${project.id === selectedProject?.id ? "selected" : ""}`}><strong>{project.name}</strong><div className="muted">{project.description || "智能体工作区"}</div></div>,
      <span className="mono">{project.rootPath}</span>,
      <Badge text={`${project.defaultRuleIds?.length || 0} defaults`} tone="blue" />,
      <Badge text={project.status} tone={toneForStatus(project.status)} />,
      <div className="row-actions">
        <button className="icon-btn table-action" title="查看项目详情" disabled={actionLoading} onClick={() => selectProject(project.id)}>{icon("visibility")}</button>
        <button className="icon-btn table-action" title="暂停项目" disabled={project.status !== "ACTIVE" || actionLoading} onClick={() => runAction(() => transitionProject(project.id, "pause"), "项目已暂停")}>{icon("pause_circle")}</button>
        <button className="icon-btn table-action" title="启用项目" disabled={project.status !== "PAUSED" || actionLoading} onClick={() => runAction(() => transitionProject(project.id, "activate"), "项目已启用")}>{icon("toggle_on")}</button>
        <button className="icon-btn table-action" title="归档项目" disabled={actionLoading} onClick={() => runAction(() => archiveProject(project.id), "项目已归档")}>{icon("archive")}</button>
      </div>
    ])} empty="暂无项目。" /></Panel>
  </div><div className="span-4 stack">
    <Panel title="所选项目" iconName="folder_open" meta={selectedProject?.id || "未选择项目"}>
      {selectedProject ? <div className="session-detail">
        <div className="detail-grid source-detail-grid">
          <div><span className="mono muted">状态</span><strong>{selectedProject.status}</strong></div>
          <div><span className="mono muted">版本</span><strong>{selectedProject.revision}</strong></div>
          <div><span className="mono muted">更新时间</span><strong>{fmtDate(selectedProject.updatedAt)}</strong></div>
          <div className="detail-wide"><span className="mono muted">名称</span><strong>{selectedProject.name}</strong></div>
          <div className="detail-wide"><span className="mono muted">根路径</span><strong className="mono">{selectedProject.rootPath}</strong></div>
          <div className="detail-wide"><span className="mono muted">描述</span><strong>{selectedProject.description || "-"}</strong></div>
          <div className="detail-wide"><span className="mono muted">智能体适配器</span><strong>{selectedProject.agentAdapterIds?.length ? selectedProject.agentAdapterIds.join(", ") : "工作区 default"}</strong></div>
          <div className="detail-wide"><span className="mono muted">默认规则</span><strong>{selectedProject.defaultRuleIds?.length ? selectedProject.defaultRuleIds.join(", ") : "无默认值"}</strong></div>
        </div>
        <div className="row-actions">
          <button className="btn" disabled={selectedProject.status !== "ACTIVE" || actionLoading} onClick={() => runAction(() => transitionProject(selectedProject.id, "pause"), "项目已暂停")}>{icon("pause_circle")}<span>暂停</span></button>
          <button className="btn primary" disabled={selectedProject.status !== "PAUSED" || actionLoading} onClick={() => runAction(() => transitionProject(selectedProject.id, "activate"), "项目已启用")}>{icon("toggle_on")}<span>启用</span></button>
          <button className="btn" disabled={actionLoading} onClick={() => runAction(() => archiveProject(selectedProject.id), "项目已归档")}>{icon("archive")}<span>归档</span></button>
        </div>
      </div> : <EmptyNote>请选择或创建一个项目以检查其工作区边界。</EmptyNote>}
    </Panel>
    <Panel title="工作区 Footprint" iconName="inventory_2" meta={selectedProject ? selectedProject.name : ""}>
      {selectedProject ? <div className="kpi-grid compact-kpis">
        <div className="kpi"><div className="kpi-value">{projectSessions.length}</div><div className="kpi-label mono">会话</div></div>
        <div className="kpi"><div className="kpi-value">{projectWork.length}</div><div className="kpi-label mono">工作项</div></div>
        <div className="kpi"><div className="kpi-value">{projectSources.length}</div><div className="kpi-label mono">数据源</div></div>
        <div className="kpi"><div className="kpi-value">{projectEvidence.length}</div><div className="kpi-label mono">证据</div></div>
        <div className="kpi"><div className="kpi-value">{projectRules.length}</div><div className="kpi-label mono">规则</div></div>
        <div className="kpi"><div className="kpi-value">{projectDecisions.length}</div><div className="kpi-label mono">决策</div></div>
      </div> : <EmptyNote>未选择项目。</EmptyNote>}
    </Panel>
    <Panel title="最近会话" iconName="terminal" meta={`${latestSessions.length} shown`}>
      {latestSessions.length ? <div className="stack compact">{latestSessions.map((session: AnyRecord) => <div className="metric-row evidence-row" key={session.id}><div className="evidence-row-main"><div className="title-sm">{session.title || session.id}</div><div className="muted mono">{session.agentAdapterId} · {fmtDate(session.updatedAt)}</div></div><Badge text={session.status} tone={toneForStatus(session.status)} /></div>)}</div> : <EmptyNote>该项目暂无会话。</EmptyNote>}
    </Panel>
    <Panel title="活动工作" iconName="task_alt" meta={`${activeWork.length} active`}>
      {activeWork.length ? <div className="stack compact">{activeWork.map((item: AnyRecord) => <div className="metric-row evidence-row" key={item.id}><div className="evidence-row-main"><div className="title-sm">{item.title}</div><div className="muted">{item.description || item.id}</div></div><Badge text={item.status} tone={toneForStatus(item.status)} /></div>)}</div> : <EmptyNote>该项目暂无活动工作。</EmptyNote>}
    </Panel>
  </div></div></>;
}

function SessionsPage(props: AnyRecord & { header: ReactNode }) {
  const { data, header, selectedSessionId, selectSession, sessionDetails: details, sessionDetailsLoading, actionLoading, runAction, archiveSession, continueSession, syncSessionTranscript, bindDesktopSync, syncDesktopSync, unbindDesktopSync, desktopSyncAuto, setDesktopSyncAuto, interruptSession, exportSessionCapsule, openEvidenceDetail, setModal } = props;
  const canContinue = (status: string) => ["CREATED", "PAUSED", "FAILED", "COMPLETED"].includes(status);
  const evidenceMeta = (item: AnyRecord) => [item.metadata?.adapterId ? `适配器 ${item.metadata.adapterId}` : null, item.metadata?.externalSessionId ? `外部会话 ${item.metadata.externalSessionId}` : null, item.metadata?.parserVersion || null, item.metadata?.messageCount ? `${item.metadata.messageCount} 条消息` : null, item.metadata?.eventCount ? `${item.metadata.eventCount} 个事件` : null, item.metadata?.turnCount ? `${item.metadata.turnCount} 轮对话` : null].filter(Boolean).join(" · ");
  const selectedSession = data.sessions.find((session: AnyRecord) => session.id === selectedSessionId) || data.sessions[0];
  const contextItemCount = details?.contextPack?.contextItems?.length ?? 0;
  const evidencePackageCount = details?.contextPack?.evidenceSnapshots?.length ?? 0;
  const runtime = details?.runtimeStatus;
  const runs = details?.runs || [];
  const desktopSync = details?.desktopSync ?? null;
  const desktopSyncCapabilities = (desktopSync?.capabilities ?? {}) as AnyRecord;
  const latestAgentTranscript = details?.evidence.find((item: AnyRecord) => item.metadata?.stream === "imported-transcript" && item.metadata?.adapterId);
  const syncLabel = latestAgentTranscript?.metadata?.sourceUpdatedAt ? `上次同步 ${fmtDate(latestAgentTranscript.metadata.sourceUpdatedAt)}` : selectedSession?.externalSessionId ? "已绑定，尚未同步" : "尚未绑定";
  return (
    <>{header}<div className="stack">
      <Panel title="会话片段" iconName="terminal"><Table headers={["会话", "智能体", "开始时间", "更新时间", "状态", "操作"]} rows={data.sessions.map((session: AnyRecord) => [
        <div className={`session-cell ${session.id === selectedSession?.id ? "selected" : ""}`}><strong>{session.title || session.id}</strong><div className="muted">{session.intent || ""}</div>{session.externalSessionId ? <div className="muted mono">已绑定 {session.externalSessionId}</div> : <div className="muted mono">未绑定</div>}</div>,
        session.agentAdapterId,
        fmtDate(session.startedAt),
        fmtDate(session.updatedAt),
        <Badge text={session.status} tone={toneForStatus(session.status)} />,
        <div className="row-actions">
          <button className="icon-btn table-action" title="查看会话详情" disabled={actionLoading} onClick={() => void selectSession(session.id)}>{icon("visibility")}</button>
          <button className="icon-btn table-action" title="在智能体中继续" disabled={!canContinue(session.status) || actionLoading} onClick={() => runAction(() => continueSession(session.id), "会话已在智能体中继续")}>{icon("play_arrow")}</button>
          <button className="icon-btn table-action" title="中断受管运行" disabled={session.status !== "RUNNING" || actionLoading} onClick={() => runAction(() => interruptSession(session.id), "会话已中断")}>{icon("stop_circle")}</button>
          <button className="icon-btn table-action" title="同步智能体对话记录" disabled={actionLoading} onClick={() => runAction(() => syncSessionTranscript(session.id), "已从智能体同步对话记录")}>{icon("sync")}</button>
          <button className="icon-btn table-action" title="导入已有智能体会话" disabled={actionLoading} onClick={() => setModal({ kind: "existingTranscript", sessionId: session.id })}>{icon("manage_search")}</button>
          <button className="icon-btn table-action" title="粘贴对话记录" disabled={actionLoading} onClick={() => setModal({ kind: "transcript", sessionId: session.id })}>{icon("edit_note")}</button>
          <button className="icon-btn table-action" title="导出会话摘要胶囊" disabled={actionLoading} onClick={() => runAction(() => exportSessionCapsule(session.id), "会话摘要胶囊已导出")}>{icon("download")}</button>
          <button className="icon-btn table-action" title="归档会话" disabled={session.status === "RUNNING" || actionLoading} onClick={() => runAction(() => archiveSession(session.id), "会话已归档")}>{icon("archive")}</button>
        </div>
      ])} empty="暂无会话。" /></Panel>
      <Panel title="所选会话详情" iconName="inventory_2" meta={selectedSession ? selectedSession.id : "未选择会话"}>
        {sessionDetailsLoading ? <EmptyNote>正在加载所选会话详情...</EmptyNote> : null}
        {selectedSession && details ? <div className="session-detail">
          <div className="detail-grid">
            <div><span className="mono muted">状态</span><strong>{selectedSession.status}</strong></div>
            <div><span className="mono muted">智能体</span><strong>{selectedSession.agentAdapterId}</strong></div>
            <div><span className="mono muted">版本</span><strong>{selectedSession.revision}</strong></div>
            <div className="detail-wide"><span className="mono muted">标题</span><strong>{selectedSession.title || selectedSession.id}</strong></div>
            <div className="detail-wide"><span className="mono muted">意图</span><strong>{selectedSession.intent || "-"}</strong></div>
            <div className="detail-wide detail-with-action"><div><span className="mono muted">外部智能体会话</span><strong className="mono">{selectedSession.externalSessionId || "Not bound"}</strong></div><button className="icon-btn table-action" title="复制外部会话 ID" disabled={!selectedSession.externalSessionId} onClick={() => copyText(selectedSession.externalSessionId)}>{icon("content_copy")}</button></div>
            <div className="detail-wide detail-with-action"><div><span className="mono muted">对话记录同步</span><strong>{syncLabel}</strong><div className="muted mono">{latestAgentTranscript ? transcriptStructure(latestAgentTranscript.metadata) : "Uses Codex/Claude transcript discovery for this Project"}</div></div><button className="icon-btn table-action" title="立即同步智能体对话记录" disabled={actionLoading} onClick={() => runAction(() => syncSessionTranscript(selectedSession.id), "已从智能体同步对话记录")}>{icon("sync")}</button></div>
          </div>
          <div className="kpi-grid compact-kpis">
            <div className="kpi"><div className="kpi-value">{contextItemCount}</div><div className="kpi-label mono">上下文项</div></div>
            <div className="kpi"><div className="kpi-value">{evidencePackageCount}</div><div className="kpi-label mono">上下文包证据</div></div>
            <div className="kpi"><div className="kpi-value">{details.evidence.length}</div><div className="kpi-label mono">会话证据</div></div>
            <div className="kpi"><div className="kpi-value">{details.resumeCapsule?.status || "-"}</div><div className="kpi-label mono">恢复状态</div></div>
          </div>
          <div>
            <div className="title-sm evidence-section-title">Desktop 同步</div>
            {desktopSync ? <div className="stack compact">
              <div className="detail-grid">
                <div><span className="mono muted">同步状态</span><strong><Badge text={desktopSyncStatusLabel(desktopSync.status)} tone={desktopSync.status === "ERROR" ? "red" : desktopSync.status === "WATCHING" ? "green" : "amber"} /></strong></div>
                <div><span className="mono muted">已摄入事件</span><strong>{desktopSync.eventsIngested ?? 0}</strong></div>
                <div><span className="mono muted">读取位置</span><strong className="mono">{desktopSync.byteOffset ?? 0}{desktopSync.fileSize === null || desktopSync.fileSize === undefined ? "" : ` / ${desktopSync.fileSize}`}</strong><div className="muted mono">已读字节 / 文件总字节</div></div>
                <div><span className="mono muted">滞后</span><strong>{desktopSync.lagMs === null || desktopSync.lagMs === undefined ? "-" : `${desktopSync.lagMs} ms`}</strong></div>
                <div className="detail-wide"><span className="mono muted">对话记录文件</span><strong className="mono">{desktopSync.transcriptPath || "未绑定"}</strong></div>
                <div className="detail-wide"><span className="mono muted">最近同步</span><strong>{desktopSync.lastSyncedAt ? fmtDate(desktopSync.lastSyncedAt) : "尚未同步"}</strong><div className="muted mono">{desktopSync.lastEventAt ? `最近事件 ${fmtDate(desktopSync.lastEventAt)}` : "尚无结构化事件"}</div></div>
                {desktopSync.lastError ? <div className="detail-wide"><span className="mono muted">错误</span><strong>{desktopSync.lastError}</strong></div> : null}
              </div>
              <div className="stack compact">
                <div className="metric-row evidence-row"><div className="evidence-row-main"><div className="title-sm">只读增量读取对话记录</div><div className="muted">ContextOS 只读取智能体自己写入的 rollout 文件，从不回写。</div></div><Badge text={desktopSyncCapabilities.desktopReadSync ? "支持" : "不支持"} tone={desktopSyncCapabilities.desktopReadSync ? "green" : "amber"} /></div>
                <div className="metric-row evidence-row"><div className="evidence-row-main"><div className="title-sm">同一 UUID 命令行续跑</div><div className="muted">绑定外部会话后可用受管 CLI 在同一 UUID 上继续。</div></div><Badge text={desktopSyncCapabilities.managedCliResume ? "支持" : "待绑定"} tone={desktopSyncCapabilities.managedCliResume ? "green" : "amber"} /></div>
                <div className="metric-row evidence-row"><div className="evidence-row-main"><div className="title-sm">反向操控 Desktop 界面</div><div className="muted">需要 app-server 单写者锁，仍在调研。</div></div><Badge text="调研中" tone="blue" /></div>
              </div>
              {desktopSync.transcriptPath && desktopSyncAuto ? <div className="muted mono">自动同步已开启：停留在会话页时每 5 秒增量读取一次新事件</div> : null}
              <div className="row-actions">
                <button className={`btn ${desktopSync.transcriptPath ? "" : "primary"}`} disabled={actionLoading} onClick={() => setModal({ kind: "desktopSync", sessionId: selectedSession.id })}>{icon("link")}<span>{desktopSync.transcriptPath ? "重新绑定" : "绑定会话"}</span></button>
                <button className="btn" disabled={!desktopSync.transcriptPath || actionLoading} onClick={() => runAction(() => syncDesktopSync(selectedSession.id), "已从 Desktop 对话记录同步")}>{icon("sync")}<span>立即同步</span></button>
                <button className="btn" disabled={!desktopSync.transcriptPath || actionLoading} onClick={() => setDesktopSyncAuto(!desktopSyncAuto)}>{icon(desktopSyncAuto ? "pause_circle" : "play_arrow")}<span>{desktopSyncAuto ? "停止自动同步" : "自动同步"}</span></button>
                <button className="btn" disabled={!desktopSync.transcriptPath || actionLoading} onClick={() => runAction(() => unbindDesktopSync(selectedSession.id), "已解除 Desktop 同步绑定")}>{icon("link_off")}<span>解除绑定</span></button>
              </div>
            </div> : <EmptyNote>该会话的 Desktop 同步状态不可用。</EmptyNote>}
          </div>
          <div className="detail-grid">
            <div className="detail-wide detail-with-action"><div><span className="mono muted">上下文包</span><strong className="mono">{details.contextPack?.id || "Not generated"}</strong></div><button className="icon-btn table-action" title="复制上下文包 ID" disabled={!details.contextPack?.id} onClick={() => copyText(details.contextPack?.id)}>{icon("content_copy")}</button></div>
            <div className="detail-wide"><span className="mono muted">运行时</span><strong>{runtime?.run?.status || "No active run"}</strong><div className="muted mono">{runtime?.process ? `pid ${runtime.process.pid} · managed ${runtime.process.managed} · running ${runtime.process.running}` : "No managed process"}</div>{runtime?.run?.failureMessage ? <div className="muted">{runtime.run.failureCode}: {runtime.run.failureMessage}</div> : null}</div>
            <div className="detail-wide"><span className="mono muted">恢复摘要</span><strong>{details.resumeCapsule?.summary || "No resume capsule yet"}</strong></div>
            <div className="detail-wide"><span className="mono muted">下一步动作</span><strong>{details.resumeCapsule?.nextAction || "-"}</strong></div>
          </div>
          <div className="row-actions">
            <button className="btn primary" disabled={!canContinue(selectedSession.status) || actionLoading} onClick={() => runAction(() => continueSession(selectedSession.id), "会话已在智能体中继续")}>{icon("play_arrow")}<span>继续</span></button>
            <button className="btn" disabled={selectedSession.status !== "RUNNING" || actionLoading} onClick={() => runAction(() => interruptSession(selectedSession.id), "会话已中断")}>{icon("stop_circle")}<span>中断</span></button>
            <button className="btn" disabled={actionLoading} onClick={() => runAction(() => syncSessionTranscript(selectedSession.id), "已从智能体同步对话记录")}>{icon("sync")}<span>同步对话记录</span></button>
            <button className="btn" disabled={actionLoading} onClick={() => setModal({ kind: "resumeCapsule", sessionId: selectedSession.id })}>{icon("edit_note")}<span>编辑摘要胶囊</span></button>
            <button className="btn" disabled={actionLoading} onClick={() => setModal({ kind: "existingTranscript", sessionId: selectedSession.id })}>{icon("manage_search")}<span>导入已有</span></button>
            <button className="btn" disabled={actionLoading} onClick={() => setModal({ kind: "transcript", sessionId: selectedSession.id })}>{icon("edit_note")}<span>粘贴对话记录</span></button>
            <button className="btn" disabled={actionLoading} onClick={() => runAction(() => exportSessionCapsule(selectedSession.id), "会话摘要胶囊已导出")}>{icon("download")}<span>导出摘要胶囊</span></button>
          </div>
          <div>
            <div className="title-sm evidence-section-title">运行历史</div>
            {runs.length ? <div className="stack compact">{runs.map((run: AnyRecord) => <div className="metric-row evidence-row" key={run.id}><div className="evidence-row-main"><div className="title-sm">{run.failureMessage || `智能体运行 ${run.status.toLowerCase()}`}</div><div className="muted mono">{run.id} · {fmtDate(run.startedAt || run.createdAt)}{run.endedAt ? ` · 结束于 ${fmtDate(run.endedAt)}` : ""}</div><div className="muted mono">{run.pid ? `pid ${run.pid}` : "无 pid"}{run.exitCode !== null && run.exitCode !== undefined ? ` · 退出码 ${run.exitCode}` : ""}</div></div><Badge text={run.failureCode || run.status} tone={toneForStatus(run.status)} /></div>)}</div> : <EmptyNote>暂无智能体运行记录。</EmptyNote>}
          </div>
          {details.contextPack ? <div>
            <div className="title-sm evidence-section-title">上下文包选择</div>
            <div className="stack compact">{[
              ...(details.contextPack.workItems || []), ...(details.contextPack.decisions || []),
              ...details.contextPack.contextItems, ...details.contextPack.evidenceSnapshots,
              ...(details.contextPack.rules || [])
            ].map((item: AnyRecord) => <div className="metric-row evidence-row" key={`${item.resourceType}-${item.id}`}><div className="evidence-row-main"><div className="title-sm">{item.title}</div><div className="muted">{item.summary || item.contentHash || "No inline summary"}</div></div><Badge text={item.selectionReason} tone="blue" /></div>)}</div>
          </div> : null}
          {details.activity.length ? <div>
            <div className="title-sm evidence-section-title">近期活动</div>
            <div className="stack compact">{details.activity.slice(0, 8).map((item: AnyRecord) => <div className="metric-row evidence-row" key={`${item.kind}-${item.id}`}><div className="evidence-row-main"><div className="title-sm">{item.summary || item.eventType}</div><div className="muted mono">{fmtDate(item.createdAt)} · {item.kind}{item.actorType ? ` · ${item.actorType}` : ""}</div>{Object.keys(item.metadata || {}).length ? <div className="muted mono">{Object.entries(item.metadata).slice(0, 3).map(([key, value]) => `${key}: ${String(value)}`).join(" · ")}</div> : null}</div><Badge text={item.eventType} tone={item.kind === "AUDIT" ? "blue" : toneForStatus(item.eventType)} /></div>)}</div>
          </div> : <EmptyNote>该会话还没有记录任何运行时活动。</EmptyNote>}
          {details.transcriptEvents?.events?.length ? <div>
            <div className="title-sm evidence-section-title">对话记录事件</div>
            <div className="muted mono">解析器 {details.transcriptEvents.parserVersion || "未知"} · {details.transcriptEvents.eventCount} 个事件 · 显示最近 {Math.min(12, details.transcriptEvents.returnedEventCount)} 条{details.transcriptEvents.eventsTruncated ? "（取自 200 条事件窗口）" : ""}{details.transcriptEvents.transcriptTruncated ? " · 对话记录在导入上限处被截断" : ""} · 证据 {details.transcriptEvents.evidenceSnapshotId}</div>
            <div className="stack compact">{details.transcriptEvents.events.slice(-12).map((event: AnyRecord) => <div className="metric-row evidence-row" key={`${event.ordinal}-${event.kind}`}><div className="evidence-row-main"><div className="title-sm">{transcriptEventLabel(event)}</div>{event.timestamp ? <div className="muted mono">{fmtDate(event.timestamp)}</div> : null}<div className="muted mono">{transcriptEventPreview(event)}</div></div><Badge text={`#${event.ordinal} ${event.kind}`} tone={event.kind === "message" ? "blue" : event.kind === "summary" ? "green" : "amber"} /></div>)}</div>
          </div> : <EmptyNote>该会话还没有导入任何结构化对话记录事件。</EmptyNote>}
          {details.evidence.length ? <div>
            <div className="title-sm evidence-section-title">证据快照</div>
            <div className="stack compact">{details.evidence.slice(0, 8).map((item: AnyRecord) => <div className="metric-row evidence-row" key={item.id}><div className="evidence-row-main"><div className="title-sm">{item.title}</div><div className="muted mono">{evidenceMeta(item) || item.storageRef || item.id}</div></div><div className="row-actions"><Badge text={item.evidenceType} tone="blue" /><button className="icon-btn table-action" title="查看证据内容" disabled={actionLoading} onClick={() => void openEvidenceDetail(item)}>{icon("visibility")}</button><button className="icon-btn table-action" title="复制证据引用" disabled={actionLoading} onClick={() => copyText(`${item.id}\n${item.storageRef || ""}\n${item.contentHash || ""}`)}>{icon("content_copy")}</button></div></div>)}</div>
          </div> : <EmptyNote>该会话还没有捕获任何证据快照。</EmptyNote>}
        </div> : !sessionDetailsLoading ? <EmptyNote>请选择或创建一个会话以检查其上下文包、运行时状态、证据及恢复胶囊。</EmptyNote> : null}
      </Panel>
    </div></>
  );
}

function ReviewPage(props: AnyRecord & { header: ReactNode }) {
  const { data, header, actionLoading, runAction, setModal, selectedReviewId, selectReview, reviewActionLog, startReview } = props;
  const selectedReview = data.reviews.find((item: AnyRecord) => item.id === selectedReviewId) || data.reviews.find((item: AnyRecord) => ["OPEN", "IN_PROGRESS"].includes(item.status)) || data.reviews[0];
  const sourceObject = selectedReview ? [...data.rules, ...data.sessions, ...data.contextItems, ...data.evidenceSnapshots, ...data.decisions, ...data.workItems].find((item: AnyRecord) => item.id === selectedReview.sourceId) : null;
  const logItems = selectedReview && reviewActionLog?.reviewId === selectedReview.id ? reviewActionLog.items : [];
  return <>{header}<div className="grid cols-12"><div className="span-8 stack">
    <Panel title="审查队列" iconName="inbox"><Table headers={["审查项", "来源", "优先级", "状态", "操作"]} rows={data.reviews.map((item: AnyRecord) => [
      <div className={`session-cell ${item.id === selectedReview?.id ? "selected" : ""}`}><strong>{item.summary}</strong><div className="muted">{item.proposedResolution || item.triggerType}</div></div>,
      <span className="mono">{item.sourceType} · {item.sourceId}</span>,
      <Badge text={item.priority} tone={item.priority === "URGENT" || item.priority === "HIGH" ? "amber" : "blue"} />,
      <Badge text={item.status} tone={toneForStatus(item.status)} />,
      <div className="row-actions">
        <button className="icon-btn table-action" title="查看审查详情" disabled={actionLoading} onClick={() => void selectReview(item.id)}>{icon("visibility")}</button>
        <button className="icon-btn table-action" title="开始审查" disabled={item.status !== "OPEN" || actionLoading} onClick={() => runAction(() => startReview(item.id), "审查已开始")}>{icon("play_arrow")}</button>
        <button className="icon-btn table-action" title="指派审查人" disabled={!["OPEN", "IN_PROGRESS"].includes(item.status) || actionLoading} onClick={() => setModal({ kind: "reviewAssign", reviewId: item.id })}>{icon("manage_search")}</button>
        <button className="icon-btn table-action" title="解决审查" disabled={!["OPEN", "IN_PROGRESS"].includes(item.status) || actionLoading} onClick={() => setModal({ kind: "reviewResolve", reviewId: item.id })}>{icon("task_alt")}</button>
        <button className="icon-btn table-action" title="驳回审查" disabled={!["OPEN", "IN_PROGRESS"].includes(item.status) || actionLoading} onClick={() => setModal({ kind: "reviewDismiss", reviewId: item.id })}>{icon("block")}</button>
      </div>
    ])} empty="暂无审查项。" /></Panel>
  </div><div className="span-4 stack">
    <Panel title="所选审查" iconName="rate_review" meta={selectedReview?.id || "No review"}>
      {selectedReview ? <div className="session-detail">
        <div className="detail-grid source-detail-grid">
          <div><span className="mono muted">状态</span><strong>{selectedReview.status}</strong></div>
          <div><span className="mono muted">优先级</span><strong>{selectedReview.priority}</strong></div>
          <div><span className="mono muted">触发条件</span><strong>{selectedReview.triggerType}</strong></div>
          <div className="detail-wide"><span className="mono muted">摘要</span><strong>{selectedReview.summary}</strong></div>
          <div className="detail-wide"><span className="mono muted">来源</span><strong className="mono">{selectedReview.sourceType} · {selectedReview.sourceId}</strong><div className="muted">{sourceObject?.title || sourceObject?.name || sourceObject?.summary || "Source object is not currently loaded in this workspace view."}</div></div>
          <div className="detail-wide"><span className="mono muted">建议处理方式</span><strong>{selectedReview.proposedResolution || "-"}</strong></div>
          <div><span className="mono muted">审查人</span><strong>{selectedReview.reviewerId || "-"}</strong></div>
          <div><span className="mono muted">版本</span><strong>{selectedReview.revision}</strong></div>
          <div><span className="mono muted">更新时间</span><strong>{fmtDate(selectedReview.updatedAt)}</strong></div>
          {selectedReview.resolutionReason ? <div className="detail-wide"><span className="mono muted">解决方案</span><strong>{selectedReview.resolutionType || "-"}</strong><div className="muted">{selectedReview.resolutionReason}</div></div> : null}
        </div>
        <div className="row-actions">
          <button className="btn primary" disabled={selectedReview.status !== "OPEN" || actionLoading} onClick={() => runAction(() => startReview(selectedReview.id), "审查已开始")}>{icon("play_arrow")}<span>开始</span></button>
          <button className="btn" disabled={!["OPEN", "IN_PROGRESS"].includes(selectedReview.status) || actionLoading} onClick={() => setModal({ kind: "reviewAssign", reviewId: selectedReview.id })}>{icon("manage_search")}<span>指派</span></button>
          <button className="btn" disabled={!["OPEN", "IN_PROGRESS"].includes(selectedReview.status) || actionLoading} onClick={() => setModal({ kind: "reviewResolve", reviewId: selectedReview.id })}>{icon("task_alt")}<span>解决</span></button>
          <button className="btn" disabled={!["OPEN", "IN_PROGRESS"].includes(selectedReview.status) || actionLoading} onClick={() => setModal({ kind: "reviewDismiss", reviewId: selectedReview.id })}>{icon("block")}<span>驳回</span></button>
        </div>
      </div> : <EmptyNote>未选择审查项。</EmptyNote>}
    </Panel>
    <Panel title="操作日志" iconName="playlist_add_check" meta={selectedReview ? `${logItems.length} actions` : ""}>
      {reviewActionLog?.loading ? <EmptyNote>正在加载审查操作日志...</EmptyNote> : null}
      {reviewActionLog?.error ? <EmptyNote>{reviewActionLog.error}</EmptyNote> : null}
      {logItems.length ? <div className="version-list">{logItems.map((entry: AnyRecord) => <div className="version-row" key={entry.id}><div><div className="title-sm">{entry.action}</div><div className="muted mono">{fmtDate(entry.createdAt)}</div><div className="muted">{entry.after?.resolutionReason || entry.after?.status || ""}</div></div></div>)}</div> : !reviewActionLog?.loading && !reviewActionLog?.error ? <EmptyNote>暂无操作历史。</EmptyNote> : null}
    </Panel>
  </div></div></>;
}

function DecisionsPage(props: AnyRecord & { header: ReactNode }) {
  const { data, header, actionLoading, runAction, transitionDecision, selectedDecisionId, selectDecision, decisionVersions, setModal } = props;
  const selectedDecision = data.decisions.find((item: AnyRecord) => item.id === selectedDecisionId) || data.decisions[0];
  const versions = selectedDecision && decisionVersions?.decisionId === selectedDecision.id ? decisionVersions.items : [];
  const currentVersion = selectedDecision ? versions.find((version: AnyRecord) => version.id === selectedDecision.currentVersionId) || versions[0] : null;
  const orderedVersions = [...versions].sort((left: AnyRecord, right: AnyRecord) => Number(right.versionNumber) - Number(left.versionNumber));
  const [baseVersionId, setBaseVersionId] = useState<string>("");
  const [targetVersionId, setTargetVersionId] = useState<string>("");
  const baseVersion = orderedVersions.find((version: AnyRecord) => version.id === baseVersionId) || orderedVersions[1] || orderedVersions[0];
  const targetVersion = orderedVersions.find((version: AnyRecord) => version.id === targetVersionId) || orderedVersions[0];
  const comparisonFields: Array<[string, string]> = [["statement", "Statement"], ["rationale", "Rationale"], ["problemContext", "Problem context"], ["consequences", "Consequences"], ["alternatives", "Alternatives"], ["references", "References"]];
  const displayDecisionValue = (value: unknown) => Array.isArray(value) ? (value.length ? value.join("; ") : "-") : String(value || "-");
  return <>{header}<div className="grid cols-12"><div className="span-8 stack">
    <Panel title="决策注册表" iconName="gavel"><Table headers={["决策", "版本", "更新时间", "状态", "操作"]} rows={data.decisions.map((item: AnyRecord) => [
      <div className={`session-cell ${item.id === selectedDecision?.id ? "selected" : ""}`}><strong>{item.title}</strong><div className="muted mono">{item.id}</div></div>,
      item.currentVersionId || "-",
      fmtDate(item.updatedAt),
      <Badge text={item.status} tone={toneForStatus(item.status)} />,
      <div className="row-actions">
        <button className="icon-btn table-action" title="查看决策详情" disabled={actionLoading} onClick={() => void selectDecision(item.id)}>{icon("visibility")}</button>
        <button className="icon-btn table-action" title="编辑决策" disabled={!["DRAFT", "PROPOSED"].includes(item.status) || actionLoading} onClick={() => setModal({ kind: "decisionEdit", decisionId: item.id })}>{icon("edit_note")}</button>
        <button className="icon-btn table-action" title="将决策送审" disabled={!["DRAFT", "PROPOSED"].includes(item.status) || actionLoading} onClick={() => runAction(() => transitionDecision(item.id, "review"), "决策已送审")}>{icon("rate_review")}</button>
        <button className="icon-btn table-action" title="提交决策审议" disabled={item.status !== "DRAFT" || actionLoading} onClick={() => runAction(() => transitionDecision(item.id, "propose"), "决策已提交审议")}>{icon("publish")}</button>
        <button className="icon-btn table-action" title="接受决策" disabled={!["DRAFT", "PROPOSED"].includes(item.status) || actionLoading} onClick={() => runAction(() => transitionDecision(item.id, "accept"), "决策已接受")}>{icon("check_circle")}</button>
        <button className="icon-btn table-action" title="取代已接受的决策" disabled={item.status !== "ACCEPTED" || actionLoading} onClick={() => runAction(() => transitionDecision(item.id, "supersede"), "决策已被取代")}>{icon("history")}</button>
        <button className="icon-btn table-action" title="撤销已接受的决策" disabled={item.status !== "ACCEPTED" || actionLoading} onClick={() => runAction(() => transitionDecision(item.id, "reverse"), "决策已撤销")}>{icon("undo")}</button>
        <button className="icon-btn table-action" title="归档决策" disabled={!["DRAFT", "PROPOSED", "SUPERSEDED", "REVERSED"].includes(item.status) || actionLoading} onClick={() => runAction(() => transitionDecision(item.id, "archive"), "决策已归档")}>{icon("archive")}</button>
      </div>
    ])} empty="暂无决策。" /></Panel>
  </div><div className="span-4 stack">
    <Panel title="所选决策" iconName="gavel" meta={selectedDecision?.id || "No decision"}>
      {selectedDecision ? <div className="session-detail">
        <div className="detail-grid source-detail-grid">
          <div><span className="mono muted">状态</span><strong>{selectedDecision.status}</strong></div>
          <div><span className="mono muted">版本</span><strong>{selectedDecision.revision}</strong></div>
          <div><span className="mono muted">更新时间</span><strong>{fmtDate(selectedDecision.updatedAt)}</strong></div>
          <div className="detail-wide"><span className="mono muted">标题</span><strong>{selectedDecision.title}</strong></div>
          <div className="detail-wide"><span className="mono muted">决策内容</span><strong>{currentVersion?.statement || "-"}</strong></div>
          <div className="detail-wide"><span className="mono muted">理由</span><strong>{currentVersion?.rationale || "-"}</strong></div>
          <div className="detail-wide"><span className="mono muted">问题背景</span><strong>{currentVersion?.problemContext || "-"}</strong></div>
          <div className="detail-wide"><span className="mono muted">影响</span><strong>{currentVersion?.consequences || "-"}</strong></div>
          <div className="detail-wide"><span className="mono muted">备选方案</span><strong>{currentVersion?.alternatives?.length ? currentVersion.alternatives.join("; ") : "-"}</strong></div>
          <div className="detail-wide"><span className="mono muted">参考资料</span><strong>{currentVersion?.references?.length ? currentVersion.references.join("; ") : "-"}</strong></div>
        </div>
        <div className="row-actions">
          <button className="btn" disabled={!["DRAFT", "PROPOSED"].includes(selectedDecision.status) || actionLoading} onClick={() => setModal({ kind: "decisionEdit", decisionId: selectedDecision.id })}>{icon("edit_note")}<span>编辑</span></button>
          <button className="btn" disabled={!["DRAFT", "PROPOSED"].includes(selectedDecision.status) || actionLoading} onClick={() => runAction(() => transitionDecision(selectedDecision.id, "review"), "决策已送审")}>{icon("rate_review")}<span>审查</span></button>
          <button className="btn primary" disabled={selectedDecision.status !== "DRAFT" || actionLoading} onClick={() => runAction(() => transitionDecision(selectedDecision.id, "propose"), "决策已提交审议")}>{icon("publish")}<span>提交审议</span></button>
          <button className="btn" disabled={!["DRAFT", "PROPOSED"].includes(selectedDecision.status) || actionLoading} onClick={() => runAction(() => transitionDecision(selectedDecision.id, "accept"), "决策已接受")}>{icon("check_circle")}<span>接受</span></button>
          <button className="btn" disabled={selectedDecision.status !== "ACCEPTED" || actionLoading} onClick={() => runAction(() => transitionDecision(selectedDecision.id, "supersede"), "决策已被取代")}>{icon("history")}<span>取代</span></button>
          <button className="btn" disabled={selectedDecision.status !== "ACCEPTED" || actionLoading} onClick={() => runAction(() => transitionDecision(selectedDecision.id, "reverse"), "决策已撤销")}>{icon("undo")}<span>撤销</span></button>
          <button className="btn" disabled={!["DRAFT", "PROPOSED", "SUPERSEDED", "REVERSED"].includes(selectedDecision.status) || actionLoading} onClick={() => runAction(() => transitionDecision(selectedDecision.id, "archive"), "决策已归档")}>{icon("archive")}<span>归档</span></button>
        </div>
      </div> : <EmptyNote>未选择决策。</EmptyNote>}
    </Panel>
    <Panel title="决策版本" iconName="article" meta={selectedDecision ? `${versions.length} versions` : ""}>
      {decisionVersions?.loading ? <EmptyNote>正在加载决策版本...</EmptyNote> : null}
      {decisionVersions?.error ? <EmptyNote>{decisionVersions.error}</EmptyNote> : null}
      {versions.length ? <div className="version-list">{versions.map((version: AnyRecord) => <div className="version-row" key={version.id}><div><div className="title-sm">v{version.versionNumber} · {version.state}</div><div className="muted">{version.statement}</div><div className="muted mono">{version.createdByType}{version.createdById ? `:${version.createdById}` : ""} · {fmtDate(version.createdAt)}</div></div></div>)}</div> : !decisionVersions?.loading && !decisionVersions?.error ? <EmptyNote>该决策暂无记录版本。</EmptyNote> : null}
    </Panel>
    <Panel title="版本对比" iconName="compare_arrows" meta={baseVersion && targetVersion ? `v${baseVersion.versionNumber} to v${targetVersion.versionNumber}` : ""}>
      <div id="decision-version-compare" className="version-compare">
        {orderedVersions.length ? <>
          <div className="version-selectors">
            <label><span className="mono muted">基线版本</span><select value={baseVersion?.id || ""} onChange={(event) => setBaseVersionId(event.target.value)}>{orderedVersions.map((version: AnyRecord) => <option value={version.id} key={version.id}>v{version.versionNumber} · {version.state}</option>)}</select></label>
            <label><span className="mono muted">目标版本</span><select value={targetVersion?.id || ""} onChange={(event) => setTargetVersionId(event.target.value)}>{orderedVersions.map((version: AnyRecord) => <option value={version.id} key={version.id}>v{version.versionNumber} · {version.state}</option>)}</select></label>
          </div>
          <div className="version-comparison-list">{comparisonFields.map(([field, label]) => {
            const baseValue = displayDecisionValue(baseVersion?.[field]);
            const targetValue = displayDecisionValue(targetVersion?.[field]);
            const changed = baseValue !== targetValue;
            return <div className="compare-field" key={field}><div className="split"><strong>{label}</strong><Badge text={changed ? "changed" : "same"} tone={changed ? "amber" : "green"} /></div><div className="compare-values"><div><span className="mono muted">v{baseVersion?.versionNumber}</span><p>{baseValue}</p></div><div><span className="mono muted">v{targetVersion?.versionNumber}</span><p>{targetValue}</p></div></div></div>;
          })}</div>
        </> : <EmptyNote>请选择一个具有版本历史的决策进行对比。</EmptyNote>}
      </div>
    </Panel>
  </div></div></>;
}

function WorkPage(props: AnyRecord & { header: ReactNode }) {
  const { data, header, actionLoading, runAction, transitionWorkItem, startWorkItemSession, selectedWorkItemId, selectWorkItem, workItemDetail, openSession, setModal } = props;
  const selectedItem = data.workItems.find((item: AnyRecord) => item.id === selectedWorkItemId) || data.workItems[0];
  const detail = selectedItem && workItemDetail?.workItemId === selectedItem.id ? workItemDetail : null;
  const canStartSession = (item: AnyRecord) => ["READY", "IN_PROGRESS"].includes(item.status);
  return <>{header}<div className="grid cols-12"><div className="span-8 stack">
  <Panel title="执行就绪度" iconName="task_alt"><Table headers={["工作项", "父项", "验收条件", "更新时间", "状态", "操作"]} rows={data.workItems.map((item: AnyRecord) => [
    <div className={`session-cell ${item.id === selectedItem?.id ? "selected" : ""}`}><strong>{item.title}</strong><div className="muted">{item.description || ""}</div></div>,
    item.parentId || "-",
    `${item.acceptance?.length || 0}`,
    fmtDate(item.updatedAt),
    <Badge text={item.status} tone={toneForStatus(item.status)} />,
    <div className="row-actions">
      <button className="icon-btn table-action" title="查看工作项详情" disabled={actionLoading} onClick={() => void selectWorkItem(item.id)}>{icon("visibility")}</button>
      <button className="icon-btn table-action" title="编辑工作项" disabled={["DONE", "CANCELED"].includes(item.status) || actionLoading} onClick={() => setModal({ kind: "workItemEdit", workItemId: item.id })}>{icon("edit_note")}</button>
      <button className="icon-btn table-action" title="标记为就绪" disabled={item.status !== "BACKLOG" || actionLoading} onClick={() => runAction(() => transitionWorkItem(item.id, "mark-ready"), "工作项已标记为就绪")}>{icon("playlist_add_check")}</button>
      <button className="icon-btn table-action" title="开始工作项" disabled={item.status !== "READY" || actionLoading} onClick={() => runAction(() => transitionWorkItem(item.id, "start"), "工作项已开始")}>{icon("play_arrow")}</button>
      <button className="icon-btn table-action" title="启动智能体会话" disabled={!canStartSession(item) || actionLoading} onClick={() => runAction(() => startWorkItemSession(item.id), "工作项会话已启动")}>{icon("terminal")}</button>
      <button className="icon-btn table-action" title="阻塞工作项" disabled={item.status !== "IN_PROGRESS" || actionLoading} onClick={() => setModal({ kind: "workItemBlock", workItemId: item.id })}>{icon("pause_circle")}</button>
      <button className="icon-btn table-action" title="解决阻塞" disabled={item.status !== "BLOCKED" || actionLoading} onClick={() => setModal({ kind: "workItemResolveBlocker", workItemId: item.id })}>{icon("play_arrow")}</button>
      <button className="icon-btn table-action" title="送审" disabled={item.status !== "IN_PROGRESS" || actionLoading} onClick={() => runAction(() => transitionWorkItem(item.id, "send-to-review"), "工作项已送审")}>{icon("rate_review")}</button>
      <button className="icon-btn table-action" title="完成工作项" disabled={!["IN_PROGRESS", "IN_REVIEW"].includes(item.status) || actionLoading} onClick={() => runAction(() => transitionWorkItem(item.id, "complete"), "工作项已完成")}>{icon("check_circle")}</button>
      <button className="icon-btn table-action" title="重开工作项" disabled={!["DONE", "CANCELED"].includes(item.status) || actionLoading} onClick={() => runAction(() => transitionWorkItem(item.id, "reopen"), "工作项已重开")}>{icon("undo")}</button>
      <button className="icon-btn table-action" title="取消 work" disabled={!["BACKLOG", "READY", "IN_PROGRESS", "BLOCKED", "IN_REVIEW"].includes(item.status) || actionLoading} onClick={() => runAction(() => transitionWorkItem(item.id, "cancel"), "工作项已取消")}>{icon("cancel")}</button>
    </div>
  ])} empty="暂无工作项。" /></Panel>
  </div><div className="span-4 stack">
    <Panel title="所选工作项" iconName="check_box" meta={selectedItem?.id || "No work item"}>
      {selectedItem ? <div className="session-detail">
        <div className="detail-grid source-detail-grid">
          <div><span className="mono muted">状态</span><strong>{selectedItem.status}</strong></div>
          <div><span className="mono muted">版本</span><strong>{selectedItem.revision}</strong></div>
          <div><span className="mono muted">就绪</span><strong>{detail?.readiness?.ready ? "YES" : "NO"}</strong></div>
          <div className="detail-wide"><span className="mono muted">标题</span><strong>{selectedItem.title}</strong></div>
          <div className="detail-wide"><span className="mono muted">描述</span><strong>{selectedItem.description || "-"}</strong></div>
          <div className="detail-wide"><span className="mono muted">验收条件</span><strong>{selectedItem.acceptance?.length ? selectedItem.acceptance.join("; ") : "-"}</strong></div>
          <div className="detail-wide"><span className="mono muted">执行契约</span><strong>{selectedItem.executionContract || "-"}</strong></div>
          {selectedItem.readinessState?.blocker?.reason ? <div className="detail-wide"><span className="mono muted">阻塞</span><strong>{selectedItem.readinessState.blocker.reason}</strong><div className="muted mono">{fmtDate(selectedItem.readinessState.blocker.blockedAt)}</div>{selectedItem.readinessState.blocker.resolution ? <div className="muted">Resolved: {selectedItem.readinessState.blocker.resolution}</div> : null}</div> : null}
        </div>
        <div className="row-actions">
          <button className="btn" disabled={["DONE", "CANCELED"].includes(selectedItem.status) || actionLoading} onClick={() => setModal({ kind: "workItemEdit", workItemId: selectedItem.id })}>{icon("edit_note")}<span>编辑</span></button>
          <button className="btn primary" disabled={selectedItem.status !== "BACKLOG" || actionLoading} onClick={() => runAction(() => transitionWorkItem(selectedItem.id, "mark-ready"), "工作项已标记为就绪")}>{icon("playlist_add_check")}<span>设为就绪</span></button>
          <button className="btn" disabled={selectedItem.status !== "READY" || actionLoading} onClick={() => runAction(() => transitionWorkItem(selectedItem.id, "start"), "工作项已开始")}>{icon("play_arrow")}<span>开始</span></button>
          <button className="btn" disabled={!canStartSession(selectedItem) || actionLoading} onClick={() => runAction(() => startWorkItemSession(selectedItem.id), "工作项会话已启动")}>{icon("terminal")}<span>启动会话</span></button>
          <button className="btn" disabled={selectedItem.status !== "IN_PROGRESS" || actionLoading} onClick={() => setModal({ kind: "workItemBlock", workItemId: selectedItem.id })}>{icon("pause_circle")}<span>阻塞</span></button>
          <button className="btn" disabled={selectedItem.status !== "BLOCKED" || actionLoading} onClick={() => setModal({ kind: "workItemResolveBlocker", workItemId: selectedItem.id })}>{icon("play_arrow")}<span>解决阻塞</span></button>
          <button className="btn" disabled={!["IN_PROGRESS", "IN_REVIEW"].includes(selectedItem.status) || actionLoading} onClick={() => runAction(() => transitionWorkItem(selectedItem.id, "complete"), "工作项已完成")}>{icon("check_circle")}<span>完成</span></button>
        </div>
      </div> : <EmptyNote>未选择工作项。</EmptyNote>}
    </Panel>
    <Panel title="就绪度与依赖" iconName="account_tree" meta={detail ? `${detail.dependencies.length} dependencies` : ""}>
      {detail?.loading ? <EmptyNote>正在加载工作项就绪度...</EmptyNote> : null}
      {detail?.error ? <EmptyNote>{detail.error}</EmptyNote> : null}
      {detail?.readiness ? <div className="metric-row"><span>可立即启动</span><strong>{detail.readiness.ready ? "Yes" : "No"}</strong></div> : null}
      {detail?.readiness?.blockerReason ? <div className="metric-row"><span>手动阻塞</span><strong>{detail.readiness.blockerReason}</strong></div> : null}
      {detail?.readiness?.blockers?.length ? detail.readiness.blockers.map((blocker: AnyRecord) => <div className="metric-row" key={blocker.dependsOnId}><span className="mono">{blocker.dependsOnId}</span><Badge text={blocker.status} tone={toneForStatus(blocker.status)} /></div>) : null}
      {detail && !detail.dependencies.length && !detail.readiness?.blockers?.length ? <EmptyNote>无阻塞依赖。</EmptyNote> : null}
    </Panel>
    <Panel title="子工作项" iconName="account_tree" meta={detail ? `${detail.children.length} children` : ""}>
      {detail?.children?.length ? <div className="stack compact">{detail.children.map((child: AnyRecord) => <div className="metric-row evidence-row" key={child.id}><div className="evidence-row-main"><div className="title-sm">{child.title}</div><div className="muted">{child.description || child.id}</div></div><div className="row-actions"><Badge text={child.status} tone={toneForStatus(child.status)} /><button className="icon-btn table-action" title="打开子工作项" disabled={actionLoading} onClick={() => void selectWorkItem(child.id)}>{icon("visibility")}</button></div></div>)}</div> : detail && !detail.loading ? <EmptyNote>无子工作项。</EmptyNote> : null}
    </Panel>
    <Panel title="智能体尝试" iconName="terminal" meta={detail ? `${detail.attempts.length} 次尝试` : ""}>
      {detail?.loading ? <EmptyNote>正在加载智能体尝试...</EmptyNote> : null}
      {detail?.attempts?.length ? <div className="stack compact">{detail.attempts.map((attempt: AnyRecord) => <div className="metric-row evidence-row" key={attempt.id}>
        <div className="evidence-row-main">
          <div className="title-sm">{attempt.session?.title || attempt.summary || "Agent session"}</div>
          <div className="muted mono">{fmtDate(attempt.startedAt || attempt.createdAt)} · {attempt.sessionId || "no session"}</div>
          {attempt.endedAt ? <div className="muted mono">Ended {fmtDate(attempt.endedAt)} · run {attempt.resultRef || "-"}</div> : null}
          {attempt.failureMessage ? <div className="muted">{attempt.failureCode}: {attempt.failureMessage}</div> : null}
          {attempt.session?.intent ? <div className="muted">{String(attempt.session.intent).split("\n")[0]}</div> : null}
        </div>
        <div className="row-actions">
          <Badge text={attempt.status} tone={toneForStatus(attempt.status)} />
          <button className="icon-btn table-action" title="打开关联会话" disabled={!attempt.sessionId || actionLoading} onClick={() => attempt.sessionId ? void openSession(attempt.sessionId) : undefined}>{icon("visibility")}</button>
        </div>
      </div>)}</div> : detail && !detail.loading ? <EmptyNote>该工作项尚未启动智能体会话。</EmptyNote> : null}
    </Panel>
    <Panel title="工作项活动" iconName="history" meta={detail ? `${detail.activity.length} events` : ""}>
      {detail?.activity?.length ? <div className="stack compact">{detail.activity.slice(0, 20).map((entry: AnyRecord) => <div className="metric-row evidence-row" key={`${entry.kind}-${entry.id}`}><div className="evidence-row-main"><div className="title-sm">{entry.summary || entry.eventType}</div><div className="muted mono">{fmtDate(entry.createdAt)} · {entry.kind}{entry.actorType ? ` · ${entry.actorType}` : ""}</div></div><Badge text={entry.eventType} tone={entry.kind === "AUDIT" ? "blue" : toneForStatus(entry.eventType)} /></div>)}</div> : detail && !detail.loading ? <EmptyNote>暂无工作项活动记录。</EmptyNote> : null}
    </Panel>
  </div></div></>;
}

function ContextPage(props: AnyRecord & { header: ReactNode }) {
  const { data, header, selectedContextSourceId, selectContextSource, actionLoading, runAction, syncSource, transitionSource, verifyEvidence, openEvidenceDetail, openEvidenceCompare, transitionContextItem, openContextItemDetail, setModal } = props;
  const selectedSource = data.contextSources.find((source: AnyRecord) => source.id === selectedContextSourceId) || data.contextSources[0];
  const sourceSnapshots = selectedSource ? data.evidenceSnapshots.filter((snapshot: AnyRecord) => snapshot.sourceId === selectedSource.id) : [];
  const sourceSnapshotIds = new Set(sourceSnapshots.map((snapshot: AnyRecord) => snapshot.id));
  const sourceItems = data.contextItems.filter((item: AnyRecord) => item.sourceSnapshotId && sourceSnapshotIds.has(item.sourceSnapshotId));
  const latestSnapshot = sourceSnapshots.find((snapshot: AnyRecord) => snapshot.id === selectedSource?.lastSnapshotId) || sourceSnapshots[0];
  return (
    <>{header}<div className="grid cols-12"><div className="span-8 stack">
      <Panel title="数据源" iconName="database"><Table headers={["数据源", "类型", "上次同步", "快照", "状态", "操作"]} rows={data.contextSources.map((source: AnyRecord) => [<div className={`session-cell ${source.id === selectedSource?.id ? "selected" : ""}`}><strong>{source.name}</strong><div className="muted mono">{source.locator}</div></div>, source.sourceType, fmtDate(source.lastCheckedAt), source.lastSnapshotId || "-", <Badge text={source.status} tone={toneForStatus(source.status)} />, <div className="row-actions"><button className="icon-btn table-action" title="查看数据源详情" disabled={actionLoading} onClick={() => selectContextSource(source.id)}>{icon("visibility")}</button><button className="icon-btn table-action" title="编辑数据源" disabled={actionLoading} onClick={() => setModal({ kind: "sourceEdit", sourceId: source.id })}>{icon("edit_note")}</button><button className="icon-btn table-action" title="同步数据源" disabled={source.status !== "ACTIVE" || actionLoading} onClick={() => runAction(() => syncSource(source.id), "数据源已同步")}>{icon("sync")}</button><button className="icon-btn table-action" title="暂停数据源" disabled={source.status !== "ACTIVE" || actionLoading} onClick={() => runAction(() => transitionSource(source.id, "pause"), "数据源已暂停")}>{icon("pause_circle")}</button><button className="icon-btn table-action" title="恢复数据源" disabled={source.status !== "PAUSED" || actionLoading} onClick={() => runAction(() => transitionSource(source.id, "resume"), "数据源已恢复")}>{icon("play_arrow")}</button><button className="icon-btn table-action" title="归档数据源" disabled={source.status === "ARCHIVED" || actionLoading} onClick={() => runAction(() => transitionSource(source.id, "archive"), "数据源已归档")}>{icon("archive")}</button></div>])} empty="暂无上下文源。" /></Panel>
      <Panel title="证据快照" iconName="fact_check"><Table headers={["证据", "类型", "采集时间", "存储", "操作"]} rows={data.evidenceSnapshots.slice(0, 12).map((snapshot: AnyRecord) => [<><strong>{snapshot.title}</strong><div className="muted mono">{snapshot.contentHash || "-"}</div></>, <Badge text={snapshot.evidenceType} tone="blue" />, fmtDate(snapshot.capturedAt), <span className="mono">{snapshot.storageRef || "-"}</span>, <div className="row-actions"><button className="icon-btn table-action" title="查看证据内容" disabled={actionLoading} onClick={() => void openEvidenceDetail(snapshot)}>{icon("visibility")}</button><button className="icon-btn table-action" title="派生上下文项" disabled={actionLoading} onClick={() => setModal({ kind: "contextItem", sourceSnapshotId: snapshot.id })}>{icon("add_box")}</button><button className="icon-btn table-action" title="复制证据引用" disabled={actionLoading} onClick={() => copyText(`${snapshot.id}\n${snapshot.storageRef || ""}\n${snapshot.contentHash}`)}>{icon("content_copy")}</button><button className="icon-btn table-action" title="校验证据" disabled={actionLoading} onClick={() => runAction(() => verifyEvidence(snapshot.id), "证据已校验")}>{icon("verified")}</button></div>])} empty="暂无证据快照。" /></Panel>
    </div><div className="span-4 stack">
      <Panel title="所选数据源" iconName="database" meta={selectedSource?.id || "No source"}>
        {selectedSource ? <div className="session-detail">
          <div className="detail-grid source-detail-grid">
            <div><span className="mono muted">状态</span><strong>{selectedSource.status}</strong></div>
            <div><span className="mono muted">类型</span><strong>{selectedSource.sourceType}</strong></div>
            <div><span className="mono muted">版本</span><strong>{selectedSource.revision}</strong></div>
            <div className="detail-wide"><span className="mono muted">名称</span><strong>{selectedSource.name}</strong></div>
            <div className="detail-wide"><span className="mono muted">定位符</span><strong className="mono">{selectedSource.locator}</strong></div>
            <div className="detail-wide"><span className="mono muted">描述</span><strong>{selectedSource.description || "-"}</strong></div>
            <div className="detail-wide detail-with-action"><div><span className="mono muted">最新快照</span><strong className="mono">{selectedSource.lastSnapshotId || "No snapshot"}</strong><div className="muted mono">{selectedSource.lastCheckedAt ? `checked ${fmtDate(selectedSource.lastCheckedAt)}` : "Never checked"}</div></div><button className="icon-btn table-action" title="打开最新快照" disabled={!latestSnapshot || actionLoading} onClick={() => latestSnapshot ? void openEvidenceDetail(latestSnapshot) : undefined}>{icon("visibility")}</button></div>
          </div>
          <div className="row-actions">
            <button className="btn primary" disabled={selectedSource.status !== "ACTIVE" || actionLoading} onClick={() => runAction(() => syncSource(selectedSource.id), "数据源已同步")}>{icon("sync")}<span>同步</span></button>
            <button className="btn" disabled={actionLoading} onClick={() => setModal({ kind: "sourceEdit", sourceId: selectedSource.id })}>{icon("edit_note")}<span>编辑</span></button>
            <button className="btn" disabled={selectedSource.status !== "ACTIVE" || actionLoading} onClick={() => runAction(() => transitionSource(selectedSource.id, "pause"), "数据源已暂停")}>{icon("pause_circle")}<span>暂停</span></button>
            <button className="btn" disabled={selectedSource.status !== "PAUSED" || actionLoading} onClick={() => runAction(() => transitionSource(selectedSource.id, "resume"), "数据源已恢复")}>{icon("play_arrow")}<span>恢复</span></button>
            <button className="btn" disabled={selectedSource.status === "ARCHIVED" || actionLoading} onClick={() => runAction(() => transitionSource(selectedSource.id, "archive"), "数据源已归档")}>{icon("archive")}<span>归档</span></button>
          </div>
          <pre className="evidence-metadata">{prettyJson(selectedSource.metadata)}</pre>
        </div> : <EmptyNote>请选择或创建一个上下文源以检查血缘。</EmptyNote>}
      </Panel>
      <Panel title="数据源血缘" iconName="account_tree" meta={selectedSource ? `${sourceSnapshots.length} snapshots` : ""}>
        {selectedSource ? <div>
          <div className="metric-row"><span>证据快照</span><strong>{sourceSnapshots.length}</strong></div>
          <div className="metric-row"><span>派生上下文项</span><strong>{sourceItems.length}</strong></div>
          <div className="metric-row"><span>最新快照</span><strong className="mono">{latestSnapshot?.id || "-"}</strong></div>
          {sourceSnapshots.length ? <div className="stack compact source-linked-list">{sourceSnapshots.slice(0, 5).map((snapshot: AnyRecord) => <div className="metric-row evidence-row" key={snapshot.id}><div className="evidence-row-main"><div className="title-sm">{snapshot.title}</div><div className="muted mono">{fmtDate(snapshot.capturedAt)} · {snapshot.contentHash}</div></div><div className="row-actions"><button className="icon-btn table-action" title="查看证据内容" disabled={actionLoading} onClick={() => void openEvidenceDetail(snapshot)}>{icon("visibility")}</button><button className="icon-btn table-action" title="派生上下文项" disabled={actionLoading} onClick={() => setModal({ kind: "contextItem", sourceSnapshotId: snapshot.id })}>{icon("add_box")}</button><button className="icon-btn table-action" title="与最新快照比较" disabled={!latestSnapshot || latestSnapshot.id === snapshot.id || actionLoading} onClick={() => latestSnapshot ? void openEvidenceCompare(snapshot, latestSnapshot) : undefined}>{icon("compare_arrows")}</button><button className="icon-btn table-action" title="校验证据" disabled={actionLoading} onClick={() => runAction(() => verifyEvidence(snapshot.id), "证据已校验")}>{icon("verified")}</button></div></div>)}</div> : <EmptyNote>该源暂无捕获的快照。</EmptyNote>}
        </div> : <EmptyNote>未选择数据源。</EmptyNote>}
      </Panel>
      <Panel title="派生上下文项" iconName="inventory_2" meta={selectedSource ? `${sourceItems.length} linked` : ""}><Table headers={["上下文项", "状态", "操作"]} rows={(selectedSource ? sourceItems : data.contextItems).slice(0, 8).map((item: AnyRecord) => [<><strong>{item.title}</strong><div className="muted">{item.summary}</div><div className="muted mono">{item.itemType} · {item.confidence} · {item.sourceSnapshotId || "manual"}</div></>, <Badge text={item.status} tone={toneForStatus(item.status)} />, <div className="row-actions"><button className="icon-btn table-action" title="查看版本" disabled={actionLoading} onClick={() => void openContextItemDetail(item)}>{icon("visibility")}</button><button className="icon-btn table-action" title="编辑上下文项" disabled={actionLoading} onClick={() => setModal({ kind: "contextItemEdit", contextItemId: item.id })}>{icon("edit_note")}</button><button className="icon-btn table-action" title="启用上下文项" disabled={item.status === "ACTIVE" || item.status === "ARCHIVED" || actionLoading} onClick={() => runAction(() => transitionContextItem(item.id, "activate"), "上下文项已启用")}>{icon("toggle_on")}</button><button className="icon-btn table-action" title="标记为过期" disabled={item.status !== "ACTIVE" || actionLoading} onClick={() => runAction(() => transitionContextItem(item.id, "mark-stale"), "上下文项已标记为过期")}>{icon("restart_alt")}</button><button className="icon-btn table-action" title="归档上下文项" disabled={item.status === "ARCHIVED" || actionLoading} onClick={() => runAction(() => transitionContextItem(item.id, "archive"), "上下文项已归档")}>{icon("archive")}</button></div>])} empty={selectedSource ? "该源暂无派生的上下文项。" : "暂无上下文项。"} /></Panel>
    </div></div></>
  );
}

function RulesPage(props: AnyRecord & { header: ReactNode }) {
  const { data, header, actionLoading, runAction, validateRule, testRule, transitionRule, renderRuleInstructions, selectedProjectId, selectedRuleId, selectRule, ruleDetail, ruleInstructionPreview } = props;
  const selectedProject = data.projects.find((project: AnyRecord) => project.id === selectedProjectId) || data.projects[0];
  const selectedRule = data.rules.find((rule: AnyRecord) => rule.id === selectedRuleId) || data.rules[0];
  const detail = selectedRule && ruleDetail?.ruleId === selectedRule.id ? ruleDetail : null;
  const currentVersion = selectedRule ? detail?.versions.find((version: AnyRecord) => version.id === selectedRule.currentVersionId) || detail?.versions[0] : null;
  return <>{header}<div className="grid cols-12"><div className="span-8 stack">
    <Panel title="规则集" iconName="policy" meta={selectedProject?.name || "工作区"}><Table headers={["规则", "版本", "状态", "操作"]} rows={data.rules.map((rule: AnyRecord) => [
      <div className={`session-cell ${rule.id === selectedRule?.id ? "selected" : ""}`}><strong>{rule.title}</strong><div className="muted">{rule.description || ""}</div></div>,
      rule.currentVersionId || "-",
      <Badge text={rule.status} tone={toneForStatus(rule.status)} />,
      <div className="row-actions">
        <button className="icon-btn table-action" title="查看规则详情" disabled={actionLoading} onClick={() => void selectRule(rule.id)}>{icon("visibility")}</button>
        <button className="icon-btn table-action" title="校验规则" disabled={actionLoading} onClick={() => runAction(() => validateRule(rule.id), "规则已校验")}>{icon("rule")}</button>
        <button className="icon-btn table-action" title="针对 session.continue 试算" disabled={actionLoading} onClick={() => runAction(() => testRule(rule.id), "规则已试算")}>{icon("science")}</button>
        <button className="icon-btn table-action" title="启用规则" disabled={!["DRAFT", "DISABLED"].includes(rule.status) || actionLoading} onClick={() => runAction(() => transitionRule(rule.id, "activate"), "规则已启用")}>{icon("toggle_on")}</button>
        <button className="icon-btn table-action" title="停用规则" disabled={rule.status !== "ACTIVE" || actionLoading} onClick={() => runAction(() => transitionRule(rule.id, "disable"), "规则已停用")}>{icon("toggle_off")}</button>
      </div>
    ])} empty="暂无规则。" /></Panel>
    <Panel title="智能体指令导出" iconName="upload_file" meta={ruleInstructionPreview?.path || "AGENTS.md / CLAUDE.md"}>
      <div className="row-actions">
        <button className="btn" disabled={actionLoading || !data.projects[0]} onClick={() => runAction(() => renderRuleInstructions("PROJECT_AGENTS", false), "已生成项目 AGENTS.md 预览")}>{icon("visibility")}<span>预览 AGENTS.md</span></button>
        <button className="btn primary" disabled={actionLoading || !data.projects[0]} onClick={() => runAction(() => renderRuleInstructions("PROJECT_AGENTS", true), "项目 AGENTS.md 已更新")}>{icon("check_circle")}<span>应用 AGENTS.md</span></button>
        <button className="btn" disabled={actionLoading || !data.projects[0]} onClick={() => runAction(() => renderRuleInstructions("PROJECT_CLAUDE", false), "已生成项目 CLAUDE.md 预览")}>{icon("visibility")}<span>预览 CLAUDE.md</span></button>
        <button className="btn" disabled={actionLoading || !data.projects[0]} onClick={() => runAction(() => renderRuleInstructions("PROJECT_CLAUDE", true), "项目 CLAUDE.md 已更新")}>{icon("check_circle")}<span>应用 CLAUDE.md</span></button>
      </div>
      {ruleInstructionPreview ? <div className="stack compact"><div className="metric-row"><span>目标</span><strong>{ruleInstructionPreview.target}</strong></div><div className="metric-row"><span>启用中的规则</span><strong>{ruleInstructionPreview.activeRuleCount}</strong></div><div className="metric-row"><span>已应用</span><Badge text={ruleInstructionPreview.applied ? "YES" : "NO"} tone={ruleInstructionPreview.applied ? "green" : "blue"} /></div><pre className="evidence-metadata">{ruleInstructionPreview.nextContent}</pre></div> : <EmptyNote>在应用生成指令前请先预览。</EmptyNote>}
    </Panel>
  </div><div className="span-4 stack">
    <Panel title="所选规则" iconName="policy" meta={selectedRule?.id || "No rule"}>
      {selectedRule ? <div className="session-detail">
        <div className="detail-grid source-detail-grid">
          <div><span className="mono muted">状态</span><strong>{selectedRule.status}</strong></div>
          <div><span className="mono muted">版本</span><strong>{selectedRule.revision}</strong></div>
          <div><span className="mono muted">校验</span><strong>{currentVersion?.validationState || "UNKNOWN"}</strong></div>
          <div className="detail-wide"><span className="mono muted">标题</span><strong>{selectedRule.title}</strong></div>
          <div className="detail-wide"><span className="mono muted">描述</span><strong>{selectedRule.description || "-"}</strong></div>
          <div><span className="mono muted">执行方式</span><strong>{currentVersion?.enforcementMode || "-"}</strong></div>
          <div><span className="mono muted">优先级</span><strong>{currentVersion?.precedence ?? "-"}</strong></div>
          <div><span className="mono muted">使用情况</span><strong>{detail?.usage ? `${detail.usage.matchedCount}/${detail.usage.evaluationCount}` : "-"}</strong></div>
          <div className="detail-wide"><span className="mono muted">效果</span><pre className="evidence-metadata">{prettyJson(currentVersion?.effect || {})}</pre></div>
          <div className="detail-wide"><span className="mono muted">作用范围</span><pre className="evidence-metadata">{prettyJson(currentVersion?.scope || {})}</pre></div>
        </div>
        <div className="row-actions">
          <button className="btn" disabled={actionLoading} onClick={() => runAction(() => validateRule(selectedRule.id), "规则已校验")}>{icon("rule")}<span>校验</span></button>
          <button className="btn" disabled={actionLoading} onClick={() => runAction(() => testRule(selectedRule.id), "规则已试算")}>{icon("science")}<span>试算</span></button>
          <button className="btn primary" disabled={!["DRAFT", "DISABLED"].includes(selectedRule.status) || actionLoading} onClick={() => runAction(() => transitionRule(selectedRule.id, "activate"), "规则已启用")}>{icon("toggle_on")}<span>启用</span></button>
          <button className="btn" disabled={selectedRule.status !== "ACTIVE" || actionLoading} onClick={() => runAction(() => transitionRule(selectedRule.id, "disable"), "规则已停用")}>{icon("toggle_off")}<span>停用</span></button>
        </div>
      </div> : <EmptyNote>未选择规则。</EmptyNote>}
    </Panel>
    <Panel title="版本与评估" iconName="history" meta={detail ? `${detail.versions.length} versions` : ""}>
      {detail?.loading ? <EmptyNote>正在加载规则详情...</EmptyNote> : null}
      {detail?.error ? <EmptyNote>{detail.error}</EmptyNote> : null}
      {detail?.versions?.length ? <div className="version-list">{detail.versions.slice(0, 4).map((version: AnyRecord) => <div className="version-row" key={version.id}><div><div className="title-sm">v{version.versionNumber} · {version.validationState}</div><div className="muted mono">{version.enforcementMode} · precedence {version.precedence}</div><div className="muted">{version.validationErrors?.join("; ") || "无验证错误"}</div></div></div>)}</div> : null}
      {detail?.evaluations?.length ? <div className="version-list">{detail.evaluations.slice(0, 4).map((entry: AnyRecord) => <div className="version-row" key={entry.id}><div><div className="title-sm">{entry.result}</div><div className="muted">{entry.explanation}</div><div className="muted mono">{fmtDate(entry.createdAt)}</div></div></div>)}</div> : null}
      {detail && !detail.versions.length && !detail.evaluations.length ? <EmptyNote>暂无版本或评估记录。</EmptyNote> : null}
    </Panel>
  </div></div></>;
}

function SettingsPage(props: AnyRecord & { header: ReactNode }) {
  const { data, header, defaultAdapterId, adapterList, openSession } = props;
  const settings = data.settings;
  const runtimeHealth = data.runtimeHealth;
  const connected = data.adapters.filter((adapter: AnyRecord) => adapter.available).length;
  const failedRuns = runtimeHealth?.sessionRuns?.latestFailed || [];
  const failedJobs = runtimeHealth?.jobs?.latestFailed || [];
  return (
    <>{header}<div className="stack">
      <Panel title="常规" iconName="tune" meta="工作区 & Defaults">
        {settings ? <>
          <div className="setting-row"><div><div className="title-sm">默认适配器</div><div className="muted">当会话未指定时使用的适配器。</div></div><select id="setting-default-adapter" defaultValue={defaultAdapterId()}>{adapterList.map((adapter: AnyRecord) => <option value={adapter.id} disabled={!adapter.available} key={adapter.id}>{adapter.displayName}{adapter.available ? "" : " (unavailable)"}</option>)}</select></div>
          <div className="setting-row"><div><div className="title-sm">审查关卡</div><div className="muted">破坏性操作前要求确认。</div></div><label className="toggle"><input id="setting-confirm-destructive" type="checkbox" defaultChecked={settings.confirmDestructiveActions} /><span>{settings.confirmDestructiveActions ? "已启用" : "已禁用"}</span></label></div>
          <div className="setting-row"><div><div className="title-sm">开机启动</div><div className="muted">随桌面会话启动本地守护进程。</div></div><label className="toggle"><input id="setting-launch-startup" type="checkbox" defaultChecked={settings.launchAtStartup} /><span>{settings.launchAtStartup ? "已启用" : "已禁用"}</span></label></div>
          <div className="setting-row"><div><div className="title-sm">数据目录</div><div className="muted mono">{settings.dataDirectory}</div></div><Badge text={`rev ${settings.revision}`} /></div>
        </> : <EmptyNote>设置不可用。</EmptyNote>}
      </Panel>
      <Panel title="运行时健康" iconName="monitor_heart" meta={runtimeHealth ? fmtDate(runtimeHealth.generatedAt) : "不可用"}>
        {runtimeHealth ? <>
          <div className="kpi-grid compact-kpis">
            <div className="kpi"><div className="kpi-value">{runtimeHealth.sessionRuns.running}</div><div className="kpi-label mono">进行中的运行</div></div>
            <div className="kpi"><div className="kpi-value">{runtimeHealth.sessionRuns.failed}</div><div className="kpi-label mono">失败的运行</div></div>
            <div className="kpi"><div className="kpi-value">{runtimeHealth.jobs.byStatus?.FAILED || 0}</div><div className="kpi-label mono">失败的任务</div></div>
            <div className="kpi"><div className="kpi-value">{runtimeHealth.outbox.pending}</div><div className="kpi-label mono">发件箱 pending</div></div>
          </div>
          <div className="setting-row"><div><div className="title-sm">任务生命周期</div><div className="muted mono">{Object.entries(runtimeHealth.jobs.byStatus || {}).map(([status, count]) => `${status}:${count}`).join(" · ")}</div></div><Badge text={`${runtimeHealth.jobs.total} jobs`} /></div>
          <div className="setting-row"><div><div className="title-sm">发件箱</div><div className="muted">运行时支持事件使用的内部投递队列。</div></div><Badge text={`${runtimeHealth.outbox.failed} failed`} tone={runtimeHealth.outbox.failed ? "red" : "green"} /></div>
          {failedRuns.length || failedJobs.length ? <div className="stack compact">
            {[...failedRuns.map((run: AnyRecord) => ({ id: run.id, sessionId: run.sessionId, title: run.failureMessage || run.failureCode || "Session run failed", meta: `${run.sessionId} · ${fmtDate(run.updatedAt)}`, badge: run.failureCode || run.status })),
              ...failedJobs.map((job: AnyRecord) => ({ id: job.id, title: job.failureMessage || job.failureCode || job.kind, meta: `${job.resourceType} ${job.resourceId} · ${fmtDate(job.updatedAt)}`, badge: job.failureCode || job.status }))].slice(0, 6).map((item: AnyRecord) => (
              <div className="metric-row evidence-row" key={item.id}><div className="evidence-row-main"><div className="title-sm">{item.title}</div><div className="muted mono">{item.meta}</div></div><div className="row-actions"><Badge text={item.badge} tone="red" />{item.sessionId ? <button className="icon-btn table-action" title="打开所属会话" onClick={() => void openSession(item.sessionId)}>{icon("visibility")}</button> : null}</div></div>
            ))}
          </div> : <EmptyNote>当前无失败的运行时工作记录。</EmptyNote>}
        </> : <EmptyNote>运行时健康不可用。</EmptyNote>}
      </Panel>
      <Panel title="智能体适配器" iconName="smart_toy"><div className="setting-row"><div><div className="title-sm">已连接适配器</div><div className="muted">当发现成功时连接 Codex 和 Claude Code。</div></div><Badge text={`${connected} 个已连接`} tone={connected ? "green" : "amber"} /></div>{data.adapters.length ? data.adapters.map((adapter: AnyRecord) => <div className="setting-row" key={adapter.id}><div><div className="title-sm">{adapter.displayName}</div><div className="muted mono">{adapter.version || adapter.error || adapter.command}</div></div><Badge text={adapter.available ? "可用" : "不可用"} tone={adapter.available ? "green" : "red"} /></div>) : <EmptyNote>未发现适配器。</EmptyNote>}</Panel>
      <Panel title="存储与隐私" iconName="lock"><div className="setting-row"><div><div className="title-sm">证据保留</div><div className="muted">保留不可变源快照，除非明确归档。</div></div><Badge text="无限期保留" /></div><div className="setting-row"><div><div className="title-sm">凭据脱敏</div><div className="muted">在索引源材料前清除凭据。</div></div><Badge text="已启用" tone="green" /></div><div className="setting-row"><div><div className="title-sm">桥接模式</div><div className="muted">面向桌面智能体的本地 CLI 与 IPC 集成。</div></div><Badge text="CLI / IPC 桥接" tone="blue" /></div></Panel>
    </div></>
  );
}

function EvidenceDetail({ detail, onClose }: { detail: { snapshot: AnyRecord; content: AnyRecord | null; loading: boolean; error: string | null } | null; onClose: () => void }) {
  if (!detail) return null;
  const { snapshot, content, loading, error } = detail;
  const reference = [snapshot.id, snapshot.storageRef, snapshot.contentHash].filter(Boolean).join("\n");
  return (
    <div className="dialog-backdrop">
      <div className="dialog-card evidence-detail">
        <div className="dialog-head"><h2>{snapshot.title}</h2><button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>{icon("close")}</button></div>
        <div className="dialog-fields">
          <div className="detail-grid compact-detail">
            <div><span className="mono muted">类型</span><strong>{snapshot.evidenceType}</strong></div>
            <div><span className="mono muted">大小</span><strong>{snapshot.sizeBytes ?? "-"}</strong></div>
            <div><span className="mono muted">采集时间</span><strong>{fmtDate(snapshot.capturedAt)}</strong></div>
            <div className="detail-wide"><span className="mono muted">存储</span><strong className="mono">{snapshot.storageRef || "inline"}</strong></div>
            <div className="detail-wide"><span className="mono muted">哈希</span><strong className="mono evidence-hash">{snapshot.contentHash}</strong></div>
          </div>
          <div className="row-actions">
            <button type="button" className="btn" onClick={() => copyText(reference)}>{icon("content_copy")}<span>复制引用</span></button>
            <button type="button" className="btn" disabled={!content?.contentText} onClick={() => copyText(content?.contentText)}>{icon("article")}<span>复制内容</span></button>
          </div>
          {loading ? <EmptyNote>正在加载已验证的证据内容...</EmptyNote> : null}
          {error ? <EmptyNote>{error}</EmptyNote> : null}
          {content ? <>
            <div className="split muted mono"><span>{content.returnedChars} / {content.totalChars} chars</span><span>{content.truncated ? "truncated" : "complete"}</span></div>
            <pre className="evidence-content">{content.contentText}</pre>
          </> : null}
          <div>
            <div className="title-sm">元数据</div>
            <pre className="evidence-metadata">{prettyJson(snapshot.metadata)}</pre>
          </div>
        </div>
        <div className="dialog-actions"><button type="button" className="btn primary" onClick={onClose}>完成</button></div>
      </div>
    </div>
  );
}

function EvidenceCompare({ detail, onClose }: { detail: { base: AnyRecord; other: AnyRecord; metadata: AnyRecord | null; content: AnyRecord | null; loading: boolean; error: string | null } | null; onClose: () => void }) {
  if (!detail) return null;
  const { base, other, metadata, content, loading, error } = detail;
  const fields = metadata?.fields || {};
  const changes = content?.changes || [];
  return (
    <div className="dialog-backdrop">
      <div className="dialog-card evidence-detail">
        <div className="dialog-head"><h2>Compare 证据快照</h2><button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>{icon("close")}</button></div>
        <div className="dialog-fields">
          <div className="detail-grid compact-detail">
            <div><span className="mono muted">基线</span><strong>{base.title}</strong></div>
            <div><span className="mono muted">对比</span><strong>{other.title}</strong></div>
            <div><span className="mono muted">结果</span><strong>{content ? (content.identical ? "Identical" : "Changed") : metadata ? (metadata.identical ? "Identical metadata" : "Changed metadata") : "-"}</strong></div>
            <div className="detail-wide"><span className="mono muted">基线 ID</span><strong className="mono">{base.id}</strong></div>
            <div className="detail-wide"><span className="mono muted">对比 ID</span><strong className="mono">{other.id}</strong></div>
          </div>
          {loading ? <EmptyNote>正在对比已验证的证据内容...</EmptyNote> : null}
          {error ? <EmptyNote>{error}</EmptyNote> : null}
          {metadata ? <div className="compare-grid">
            {["contentHash", "sizeBytes", "evidenceType", "sourceId"].map((field) => <div className="compare-field" key={field}><div className="split"><strong>{field}</strong><Badge text={fields[field]?.same ? "same" : "changed"} tone={fields[field]?.same ? "green" : "amber"} /></div><div className="muted mono">{String(fields[field]?.base ?? "-")}</div><div className="muted mono">{String(fields[field]?.other ?? "-")}</div></div>)}
          </div> : null}
          {content ? <div className="compare-summary">
            <div className="metric-row"><span>新增行</span><strong>{content.addedLines}</strong></div>
            <div className="metric-row"><span>删除行</span><strong>{content.removedLines}</strong></div>
            <div className="metric-row"><span>输出</span><strong>{content.truncated ? "truncated" : "complete"}</strong></div>
          </div> : null}
          {changes.length ? <div className="version-list">
            {changes.map((change: AnyRecord, index: number) => <div className={`compare-change ${change.kind === "ADDED" ? "added" : "removed"}`} key={`${change.kind}-${index}`}><div className="split"><strong>{change.kind}</strong><span className="muted mono">base {change.baseStartLine} · other {change.otherStartLine} · {change.lineCount} lines</span></div><pre className="evidence-content compare-content">{change.text}</pre></div>)}
          </div> : !loading && content ? <EmptyNote>无内容差异。</EmptyNote> : null}
        </div>
        <div className="dialog-actions"><button type="button" className="btn primary" onClick={onClose}>完成</button></div>
      </div>
    </div>
  );
}

function ContextItemDetail({ detail, actionLoading, runAction, restoreContextItemVersion, onClose }: { detail: { item: AnyRecord; versions: AnyRecord[]; loading: boolean; error: string | null } | null; actionLoading: boolean; runAction: (task: () => Promise<unknown>, successMessage: string) => Promise<void>; restoreContextItemVersion: (itemId: string, versionNumber: number) => Promise<void>; onClose: () => void }) {
  if (!detail) return null;
  const { item, versions, loading, error } = detail;
  return (
    <div className="dialog-backdrop">
      <div className="dialog-card evidence-detail">
        <div className="dialog-head"><h2>{item.title}</h2><button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>{icon("close")}</button></div>
        <div className="dialog-fields">
          <div className="detail-grid compact-detail">
            <div><span className="mono muted">类型</span><strong>{item.itemType}</strong></div>
            <div><span className="mono muted">状态</span><strong>{item.status}</strong></div>
            <div><span className="mono muted">置信度</span><strong>{item.confidence}</strong></div>
            <div className="detail-wide"><span className="mono muted">摘要</span><strong>{item.summary}</strong></div>
            <div className="detail-wide"><span className="mono muted">来源快照</span><strong className="mono">{item.sourceSnapshotId || "-"}</strong></div>
          </div>
          {item.body ? <pre className="evidence-metadata">{item.body}</pre> : null}
          {loading ? <EmptyNote>正在加载上下文项版本...</EmptyNote> : null}
          {error ? <EmptyNote>{error}</EmptyNote> : null}
          {versions.length ? <div className="version-list">
            {versions.map((version) => (
              <div className="version-row" key={version.id}>
                <div>
                  <div className="title-sm">v{version.versionNumber} · {version.title}</div>
                  <div className="muted">{version.summary}</div>
                  <div className="muted mono">{version.createdByType}{version.createdById ? `:${version.createdById}` : ""} · {fmtDate(version.createdAt)}</div>
                </div>
                <button type="button" className="btn" disabled={actionLoading} onClick={() => runAction(() => restoreContextItemVersion(item.id, version.versionNumber), "上下文项版本已恢复")}>{icon("restart_alt")}<span>恢复</span></button>
              </div>
            ))}
          </div> : !loading && !error ? <EmptyNote>该上下文项暂无版本记录。</EmptyNote> : null}
        </div>
        <div className="dialog-actions"><button type="button" className="btn primary" onClick={onClose}>完成</button></div>
      </div>
    </div>
  );
}

function WorkspaceModal({ modal, setModal, data, defaultAdapterId, adapterList, sessionDetails, decisionVersions, workItemDetail, selectedProjectId, runAction, confirmDestructiveAction, bindDesktopSync }: AnyRecord) {
  const project = data.projects.find((item: AnyRecord) => item.id === selectedProjectId) || data.projects[0];
  const session = modal.sessionId ? data.sessions.find((item: AnyRecord) => item.id === modal.sessionId) : data.sessions[0];
  const review = modal.reviewId ? data.reviews.find((item: AnyRecord) => item.id === modal.reviewId) : data.reviews[0];
  const decision = modal.decisionId ? data.decisions.find((item: AnyRecord) => item.id === modal.decisionId) : data.decisions[0];
  const modalDecisionVersions = decision && decisionVersions?.decisionId === decision.id ? decisionVersions.items : [];
  const decisionVersion = decision ? modalDecisionVersions.find((item: AnyRecord) => item.id === decision.currentVersionId) || modalDecisionVersions[0] : null;
  const workItem = modal.workItemId ? data.workItems.find((item: AnyRecord) => item.id === modal.workItemId) : data.workItems[0];
  const source = modal.sourceId ? data.contextSources.find((item: AnyRecord) => item.id === modal.sourceId) : null;
  const contextItem = modal.contextItemId ? data.contextItems.find((item: AnyRecord) => item.id === modal.contextItemId) : null;
  const selectedSnapshot = modal.sourceSnapshotId ? data.evidenceSnapshots.find((item: AnyRecord) => item.id === modal.sourceSnapshotId) : null;
  const resumeCapsule = session && sessionDetails?.sessionId === session.id ? sessionDetails.resumeCapsule : null;
  const defaultProjectId = selectedSnapshot?.projectId || session?.projectId || project?.id || "";
  const close = () => setModal({ kind: null });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const kind = modal.kind as ModalKind;
    close();
    if (kind === "project") {
      const adapterIds = (data.adapters.filter((adapter: AnyRecord) => adapter.available).length ? data.adapters.filter((adapter: AnyRecord) => adapter.available) : data.adapters).map((adapter: AnyRecord) => adapter.id);
      void runAction(() => sendJson("/api/projects", "POST", { name: values.get("name"), rootPath: stripWrappingQuotes(values.get("rootPath")), description: values.get("description") || undefined, defaultRuleIds: [], agentAdapterIds: adapterIds.length ? adapterIds : ["codex"] }), "项目已创建");
    }
    if (kind === "session") {
      void runAction(() => sendJson("/api/sessions", "POST", { projectId: values.get("projectId"), agentAdapterId: values.get("agentAdapterId") || defaultAdapterId(), title: values.get("title"), intent: values.get("intent") }), "会话已创建");
    }
    if (kind === "rule") {
      void runAction(() => sendJson("/api/rules", "POST", { projectId: project.id, title: values.get("title"), description: values.get("description") || undefined, scope: { eventTypes: ["session.continue"] }, conditions: [], effect: { reason: values.get("reason") }, enforcementMode: values.get("enforcementMode"), precedence: 100, exceptions: [] }), "规则草稿已创建");
    }
    if (kind === "decision") {
      void runAction(() => sendJson("/api/decisions", "POST", { projectId: values.get("projectId"), title: values.get("title"), statement: values.get("statement"), rationale: values.get("rationale"), problemContext: values.get("problemContext") || undefined, alternatives: linesValue(values.get("alternatives")), consequences: values.get("consequences") || undefined, references: linesValue(values.get("references")) }), "决策已记录");
    }
    if (kind === "decisionEdit") {
      void runAction(() => sendJson(`/api/decisions/${decision.id}`, "PATCH", { title: values.get("title"), statement: values.get("statement"), rationale: values.get("rationale"), problemContext: values.get("problemContext") || undefined, alternatives: linesValue(values.get("alternatives")), consequences: values.get("consequences") || undefined, references: linesValue(values.get("references")), expectedRevision: decision.revision }), "决策已更新");
    }
    if (kind === "workItem") {
      void runAction(() => sendJson("/api/work-items", "POST", { projectId: values.get("projectId"), parentId: values.get("parentId") || undefined, title: values.get("title"), description: values.get("description") || undefined, acceptance: linesValue(values.get("acceptance")), executionContract: values.get("executionContract") || undefined }), "工作项已创建");
    }
    if (kind === "workItemEdit") {
      void runAction(() => sendJson(`/api/work-items/${workItem.id}`, "PATCH", {
        parentId: values.get("parentId") || null,
        dependencyIds: linesValue(values.get("dependencyIds")),
        title: values.get("title"),
        description: values.get("description") || null,
        acceptance: linesValue(values.get("acceptance")),
        executionContract: values.get("executionContract") || null,
        expectedRevision: workItem.revision
      }), "工作项已更新");
    }
    if (kind === "workItemBlock") {
      void runAction(() => {
        confirmDestructiveAction(`Block work item "${workItem.title}"?`);
        return sendJson(`/api/work-items/${workItem.id}/block`, "POST", { reason: values.get("reason"), expectedRevision: workItem.revision });
      }, "工作项已阻塞");
    }
    if (kind === "workItemResolveBlocker") {
      void runAction(() => sendJson(`/api/work-items/${workItem.id}/resolve-blocker`, "POST", { resolution: values.get("resolution"), expectedRevision: workItem.revision }), "工作项阻塞已解决");
    }
    if (kind === "contextItem") {
      void runAction(() => sendJson("/api/context-items", "POST", { projectId: values.get("projectId"), sourceSnapshotId: values.get("sourceSnapshotId") || undefined, itemType: values.get("itemType"), title: values.get("title"), summary: values.get("summary"), body: values.get("body") || undefined, confidence: values.get("confidence"), metadata: {} }), "上下文项已创建");
    }
    if (kind === "contextItemEdit") {
      void runAction(() => {
        if (!contextItem) throw new Error("Context item is no longer available");
        return sendJson(`/api/context-items/${contextItem.id}`, "PATCH", {
        title: values.get("title"),
        summary: values.get("summary"),
        body: values.get("body") || undefined,
        confidence: values.get("confidence"),
        metadata: contextItem.metadata || {},
        expectedRevision: contextItem.revision
        });
      }, "上下文项已更新");
    }
    if (kind === "transcript") {
      void runAction(() => sendJson(`/api/sessions/${session.id}/import-transcript`, "POST", { contentText: values.get("contentText"), title: values.get("title") || undefined, summary: values.get("summary") || undefined }), "对话记录已导入");
    }
    if (kind === "existingTranscript") {
      void runAction(() => sendJson(`/api/sessions/${session.id}/import-transcript/auto`, "POST", {
        externalSessionId: String(values.get("externalSessionId") || "").trim() || undefined,
        title: values.get("title") || undefined,
        summary: values.get("summary") || undefined
      }), "已有智能体会话已导入");
    }
    if (kind === "desktopSync") {
      void runAction(() => bindDesktopSync(session.id, {
        externalSessionId: String(values.get("externalSessionId") || "").trim(),
        transcriptPath: String(values.get("transcriptPath") || "").trim(),
        fromBeginning: values.get("fromBeginning") === "true"
      }), "已绑定 Desktop 对话记录");
    }
    if (kind === "resumeCapsule") {
      const nextAction = String(values.get("nextAction") || "").trim();
      void runAction(() => sendJson(`/api/sessions/${session.id}/resume-capsule`, "PATCH", {
        summary: values.get("summary"),
        nextAction: nextAction || null,
        expectedRevision: session.revision
      }), "摘要胶囊已更新");
    }
    if (kind === "source") {
      void runAction(() => sendJson("/api/context-sources", "POST", { projectId: project.id, sourceType: values.get("sourceType"), name: values.get("name"), locator: stripWrappingQuotes(values.get("locator")), description: values.get("description") || undefined, metadata: {} }), "数据源已创建");
    }
    if (kind === "sourceEdit") {
      void runAction(() => {
        if (!source) throw new Error("Context source is no longer available");
        return sendJson(`/api/context-sources/${source.id}`, "PATCH", {
          name: values.get("name"),
          description: values.get("description") || undefined,
          metadata: source.metadata || {},
          expectedRevision: source.revision
        });
      }, "数据源已更新");
    }
    if (kind === "reviewAssign") {
      void runAction(() => sendJson(`/api/review-items/${review.id}/assign`, "POST", { reviewerId: values.get("reviewerId"), expectedRevision: review.revision }), "审查已指派");
    }
    if (kind === "reviewResolve") {
      void runAction(() => sendJson(`/api/review-items/${review.id}/resolve`, "POST", { resolutionType: values.get("resolutionType"), resolutionReason: values.get("resolutionReason"), expectedRevision: review.revision }), "审查已解决");
    }
    if (kind === "reviewDismiss") {
      void runAction(() => sendJson(`/api/review-items/${review.id}/dismiss`, "POST", { resolutionReason: values.get("resolutionReason"), expectedRevision: review.revision }), "审查已驳回");
    }
  };

  if (!modal.kind) return null;
  const title = modal.kind === "project" ? "Add Project" : modal.kind === "session" ? "New Session" : modal.kind === "rule" ? "New Rule" : modal.kind === "source" ? "Add Context Source" : modal.kind === "sourceEdit" ? "Edit Context Source" : modal.kind === "contextItem" ? "Add Context Item" : modal.kind === "contextItemEdit" ? "Edit Context Item" : modal.kind === "decision" ? "记录决策" : modal.kind === "decisionEdit" ? "Edit Decision" : modal.kind === "workItem" ? "Create Work Item" : modal.kind === "workItemEdit" ? "Edit Work Item" : modal.kind === "workItemBlock" ? "Block Work Item" : modal.kind === "workItemResolveBlocker" ? "Resolve Work Item Blocker" : modal.kind === "reviewAssign" ? "Assign Review" : modal.kind === "reviewResolve" ? "Resolve Review" : modal.kind === "reviewDismiss" ? "Dismiss Review" : modal.kind === "existingTranscript" ? "Import Existing Agent Session" : modal.kind === "desktopSync" ? "绑定 Desktop 同步" : modal.kind === "resumeCapsule" ? "Edit Resume Capsule" : "导入对话记录";
  const submitLabel = modal.kind === "project" ? "创建项目" : modal.kind === "session" ? "创建会话" : modal.kind === "rule" ? "创建规则" : modal.kind === "source" ? "创建数据源" : modal.kind === "sourceEdit" ? "保存数据源" : modal.kind === "contextItem" ? "创建上下文项" : modal.kind === "contextItemEdit" ? "保存上下文项" : modal.kind === "decision" ? "记录决策" : modal.kind === "decisionEdit" ? "保存决策" : modal.kind === "workItem" ? "创建工作项" : modal.kind === "workItemEdit" ? "保存工作项" : modal.kind === "workItemBlock" ? "阻塞工作" : modal.kind === "workItemResolveBlocker" ? "解决阻塞" : modal.kind === "reviewAssign" ? "指派" : modal.kind === "reviewResolve" ? "解决" : modal.kind === "reviewDismiss" ? "驳回" : modal.kind === "existingTranscript" ? "导入已有会话" : modal.kind === "desktopSync" ? "绑定" : modal.kind === "resumeCapsule" ? "保存摘要胶囊" : "导入对话记录";
  return (
    <div className="dialog-backdrop">
      <form className="dialog-form dialog-card" onSubmit={submit}>
        <div className="dialog-head"><h2>{title}</h2><button type="button" className="icon-btn" aria-label="关闭" onClick={close}>{icon("close")}</button></div>
        <div className="dialog-fields">
          {modal.kind === "project" ? <><label>项目名称<input className="field" name="name" required /></label><label>根路径<input className="field mono" name="rootPath" required placeholder="D:/project/my-workspace" /></label><label>描述<input className="field" name="description" /></label></> : null}
          {modal.kind === "session" ? <><label>项目<select name="projectId" defaultValue={defaultProjectId} required>{data.projects.map((item: AnyRecord) => <option value={item.id} key={item.id}>{item.name} · {item.rootPath}</option>)}</select></label><label>标题<input className="field" name="title" required defaultValue={`Session ${new Date().toLocaleString()}`} /></label><label>意图<input className="field" name="intent" required placeholder="需要智能体协助做什么？" /></label><label>智能体<select name="agentAdapterId" defaultValue={defaultAdapterId()}>{adapterList.map((adapter: AnyRecord) => <option value={adapter.id} disabled={!adapter.available} key={adapter.id}>{adapter.displayName}{adapter.available ? "" : " (unavailable)"}</option>)}</select></label></> : null}
          {modal.kind === "rule" ? <><label>规则标题<input className="field" name="title" required /></label><label>描述<input className="field" name="description" /></label><label>执行方式<select name="enforcementMode" defaultValue="REQUIRE_REVIEW"><option>REQUIRE_REVIEW</option><option>BLOCK</option><option>WARNING</option><option>ADVISORY</option></select></label><label>原因<input className="field" name="reason" required /></label></> : null}
          {modal.kind === "decision" ? <><label>项目<select name="projectId" defaultValue={defaultProjectId} required>{data.projects.map((item: AnyRecord) => <option value={item.id} key={item.id}>{item.name} · {item.rootPath}</option>)}</select></label><label>标题<input className="field" name="title" required placeholder="例如：本地存储改用 SQLite" /></label><label>决策内容<textarea className="field" name="statement" required rows={3} placeholder="要做出什么决策？" /></label><label>理由<textarea className="field" name="rationale" required rows={3} placeholder="为什么现在这是正确的选择？" /></label><label>问题背景<input className="field" name="problemContext" /></label><label>备选方案<textarea className="field" name="alternatives" rows={3} placeholder="每行一个备选方案" /></label><label>影响<textarea className="field" name="consequences" rows={3} /></label><label>参考资料<textarea className="field" name="references" rows={2} placeholder="每行一条参考资料" /></label></> : null}
          {modal.kind === "decisionEdit" && decision ? <><label>状态<input className="field mono" value={`${decision.status} · rev ${decision.revision}`} disabled /></label><label>标题<input className="field" name="title" required defaultValue={decision.title} /></label><label>决策内容<textarea className="field" name="statement" required rows={3} defaultValue={decisionVersion?.statement || ""} /></label><label>理由<textarea className="field" name="rationale" required rows={3} defaultValue={decisionVersion?.rationale || ""} /></label><label>问题背景<input className="field" name="problemContext" defaultValue={decisionVersion?.problemContext || ""} /></label><label>备选方案<textarea className="field" name="alternatives" rows={3} defaultValue={(decisionVersion?.alternatives || []).join("\n")} /></label><label>影响<textarea className="field" name="consequences" rows={3} defaultValue={decisionVersion?.consequences || ""} /></label><label>参考资料<textarea className="field" name="references" rows={2} defaultValue={(decisionVersion?.references || []).join("\n")} /></label></> : null}
          {modal.kind === "workItem" ? <><label>项目<select name="projectId" defaultValue={defaultProjectId} required>{data.projects.map((item: AnyRecord) => <option value={item.id} key={item.id}>{item.name} · {item.rootPath}</option>)}</select></label><label>父项<select name="parentId" defaultValue=""><option value="">无父项</option>{data.workItems.map((item: AnyRecord) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label><label>标题<input className="field" name="title" required placeholder="例如：搭建审查工作流界面" /></label><label>描述<textarea className="field" name="description" rows={3} /></label><label>验收条件<textarea className="field" name="acceptance" rows={4} placeholder="每行一条验收标准" /></label><label>执行契约<textarea className="field" name="executionContract" rows={3} placeholder="这项工作完成时必须满足什么？" /></label></> : null}
          {modal.kind === "workItemEdit" && workItem ? <><label>状态<input className="field mono" value={`${workItem.status} · rev ${workItem.revision}`} disabled /></label><label>父项<select name="parentId" defaultValue={workItem.parentId || ""}><option value="">无父项</option>{data.workItems.filter((item: AnyRecord) => item.id !== workItem.id).map((item: AnyRecord) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label><label>标题<input className="field" name="title" required defaultValue={workItem.title} /></label><label>描述<textarea className="field" name="description" rows={3} defaultValue={workItem.description || ""} /></label><label>验收条件<textarea className="field" name="acceptance" rows={4} defaultValue={(workItem.acceptance || []).join("\n")} /></label><label>执行契约<textarea className="field" name="executionContract" rows={3} defaultValue={workItem.executionContract || ""} /></label><label>依赖项<textarea className="field mono" name="dependencyIds" rows={3} defaultValue={(workItemDetail?.workItemId === workItem.id ? workItemDetail.dependencies : []).map((item: AnyRecord) => item.dependsOnId).join("\n")} placeholder="每行一个工作项 ID" /></label></> : null}
          {modal.kind === "workItemBlock" && workItem ? <><label>工作项<input className="field" value={workItem.title} disabled /></label><label>阻塞原因<textarea className="field" name="reason" required rows={4} placeholder="是什么阻碍了这项工作继续？" /></label></> : null}
          {modal.kind === "workItemResolveBlocker" && workItem ? <><label>工作项<input className="field" value={workItem.title} disabled /></label><label>当前阻塞<textarea className="field" value={workItem.readinessState?.blocker?.reason || ""} disabled rows={3} /></label><label>解决方案<textarea className="field" name="resolution" required rows={4} placeholder="发生了什么变化，使工作可以继续？" /></label></> : null}
          {modal.kind === "contextItem" ? <><label>项目<select name="projectId" defaultValue={defaultProjectId} required>{data.projects.map((item: AnyRecord) => <option value={item.id} key={item.id}>{item.name} · {item.rootPath}</option>)}</select></label><label>来源证据<select name="sourceSnapshotId" defaultValue={modal.sourceSnapshotId || ""}><option value="">无来源快照</option>{data.evidenceSnapshots.map((snapshot: AnyRecord) => <option value={snapshot.id} key={snapshot.id}>{snapshot.title}</option>)}</select></label><label>类型<select name="itemType" defaultValue="FACT"><option>FACT</option><option>SUMMARY</option><option>CONSTRAINT</option><option>OPEN_QUESTION</option><option>RISK</option><option>HANDOFF</option></select></label><label>置信度<select name="confidence" defaultValue="MEDIUM"><option>LOW</option><option>MEDIUM</option><option>HIGH</option></select></label><label>标题<input className="field" name="title" required defaultValue={selectedSnapshot ? `Context from ${selectedSnapshot.title}` : ""} placeholder="上下文项标题" /></label><label>摘要<textarea className="field" name="summary" required rows={3} placeholder="简短可复用的上下文陈述" /></label><label>正文<textarea className="field" name="body" rows={5} defaultValue={selectedSnapshot ? `Source evidence: ${selectedSnapshot.id}\nHash: ${selectedSnapshot.contentHash}\nStorage: ${selectedSnapshot.storageRef || "inline"}` : ""} placeholder="细节、理由、约束或交接说明" /></label></> : null}
          {modal.kind === "contextItemEdit" && contextItem ? <><label>来源证据<input className="field mono" value={contextItem.sourceSnapshotId || "manual"} disabled /></label><label>置信度<select name="confidence" defaultValue={contextItem.confidence}><option>LOW</option><option>MEDIUM</option><option>HIGH</option></select></label><label>标题<input className="field" name="title" required defaultValue={contextItem.title} /></label><label>摘要<textarea className="field" name="summary" required rows={3} defaultValue={contextItem.summary} /></label><label>正文<textarea className="field" name="body" rows={5} defaultValue={contextItem.body || ""} /></label><div className="muted mono">rev {contextItem.revision} · {contextItem.status}</div></> : null}
          {modal.kind === "source" ? <><label>项目<input className="field" value={project?.name || ""} disabled /></label><label>类型<select name="sourceType" defaultValue="FILE"><option>FILE</option><option>DIRECTORY</option><option>URL</option><option>USER_NOTE</option><option>AGENT_OUTPUT</option></select></label><label>名称<input className="field" name="name" required placeholder="README、docs 目录、设计说明…" /></label><label>定位符<input className="field mono" name="locator" required placeholder="README.md、docs/ 或 https://…" /></label><label>描述<input className="field" name="description" /></label></> : null}
          {modal.kind === "sourceEdit" && source ? <><label>数据源类型<input className="field mono" value={source.sourceType} disabled /></label><label>定位符<input className="field mono" value={source.locator} disabled /></label><label>名称<input className="field" name="name" required defaultValue={source.name} /></label><label>描述<input className="field" name="description" defaultValue={source.description || ""} /></label><div className="muted mono">rev {source.revision} · {source.status}</div></> : null}
          {modal.kind === "transcript" ? <><label>会话<input className="field mono" value={session?.title || session?.id || ""} disabled /></label><label>标题<input className="field" name="title" defaultValue="Imported transcript" /></label><label>摘要<input className="field" name="summary" placeholder="摘要胶囊需要记住什么？" /></label><label>对话记录文本<textarea className="field" name="contentText" required rows={9} placeholder="粘贴 Codex 对话记录或重要片段" /></label></> : null}
          {modal.kind === "existingTranscript" ? <><label>ContextOS 会话<input className="field mono" value={session?.title || session?.id || ""} disabled /></label><label>外部会话 ID<input className="field mono" name="externalSessionId" placeholder="01a0ade8-6848-7d91-a328-b7780587365e" /></label><label>标题<input className="field" name="title" defaultValue={`Imported ${session?.agentAdapterId || "agent"} transcript`} /></label><label>摘要<input className="field" name="summary" placeholder="摘要胶囊需要记住什么？" /></label></> : null}
          {modal.kind === "desktopSync" ? <><label>ContextOS 会话<input className="field mono" value={session?.title || session?.id || ""} disabled /></label><label>外部会话 ID<input className="field mono" name="externalSessionId" defaultValue={session?.externalSessionId || ""} placeholder="01a0ade8-6848-7d91-a328-b7780587365e" /></label><label>对话记录路径（可选）<input className="field mono" name="transcriptPath" placeholder="留空则按外部会话 ID 自动查找" /></label><label>起始位置<select className="field" name="fromBeginning" defaultValue="false"><option value="false">从文件末尾开始（只同步新内容）</option><option value="true">从文件开头重新读取</option></select></label></> : null}
          {modal.kind === "resumeCapsule" ? <><label>会话<input className="field mono" value={session?.title || session?.id || ""} disabled /></label><label>摘要<textarea className="field" name="summary" required rows={4} defaultValue={resumeCapsule?.summary || ""} /></label><label>下一步动作<input className="field" name="nextAction" defaultValue={resumeCapsule?.nextAction || ""} placeholder="下一步应该做什么？" /></label></> : null}
          {modal.kind === "reviewAssign" ? <><label>审查<input className="field" value={review?.summary || ""} disabled /></label><label>审查人 ID<input className="field mono" name="reviewerId" required defaultValue={review?.reviewerId || "local-user"} placeholder="local-user" /></label></> : null}
          {modal.kind === "reviewResolve" ? <><label>审查<input className="field" value={review?.summary || ""} disabled /></label><label>解决方案<select name="resolutionType" defaultValue="APPROVED"><option>APPROVED</option><option>FIXED</option><option>ACKNOWLEDGED</option></select></label><label>原因<textarea className="field" name="resolutionReason" required rows={4} placeholder="检查或批准了什么？" /></label></> : null}
          {modal.kind === "reviewDismiss" ? <><label>审查<input className="field" value={review?.summary || ""} disabled /></label><label>原因<textarea className="field" name="resolutionReason" required rows={4} placeholder="为什么它不再适用？" /></label></> : null}
        </div>
        <div className="dialog-actions"><button type="button" className="btn" onClick={close}>取消</button><button type="submit" className="btn primary">{submitLabel}</button></div>
      </form>
    </div>
  );
}
