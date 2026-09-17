import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";

const API_BASE = localStorage.getItem("contextos.apiBase") || "http://127.0.0.1:4721";

type AnyRecord = Record<string, any>;
type PageId = "overview" | "projects" | "sessions" | "review" | "decisions" | "work" | "context" | "rules" | "settings";
type ModalKind = null | "project" | "session" | "rule" | "transcript" | "existingTranscript" | "resumeCapsule" | "source" | "contextItem" | "decision" | "workItem" | "reviewResolve" | "reviewDismiss";

type PageDef = {
  title: string;
  subtitle: string;
  actions: Array<[string, string, string?]>;
  narrow?: boolean;
};

type WorkspaceData = {
  health: AnyRecord | null;
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
  adapters: AnyRecord[];
};

type SessionDetails = {
  sessionId: string;
  contextPack: AnyRecord | null;
  evidence: AnyRecord[];
  resumeCapsule: AnyRecord | null;
  runtimeStatus: AnyRecord | null;
};

const navGroups: Array<{ label: string; items: Array<[PageId, string, string]> }> = [
  { label: "Workspace", items: [["overview", "dashboard", "Overview"], ["projects", "folder_open", "Projects"], ["sessions", "terminal", "Sessions"]] },
  { label: "Governance", items: [["review", "inbox", "Review Inbox"], ["decisions", "gavel", "Decisions"], ["work", "check_box", "Work Items"], ["context", "account_tree", "Context"]] },
  { label: "System", items: [["rules", "policy", "Rules"], ["settings", "settings", "Settings"]] }
];

const pages: Record<PageId, PageDef> = {
  overview: { title: "Overview", subtitle: "Workspace status, pending governance, and the next executable work.", actions: [["refresh", "Refresh Context"]] },
  projects: { title: "Projects", subtitle: "Governed workspace boundaries and their active context policies.", actions: [["create_new_folder", "Add Project", "primary"], ["tune", "Edit Defaults"]] },
  sessions: { title: "Sessions", subtitle: "Concrete agent work episodes with immutable evidence references.", actions: [["add", "New Session", "primary"], ["sync", "Sync Transcript"], ["play_arrow", "Continue in Agent"], ["hub", "Import Existing Session"], ["upload_file", "Import Transcript"], ["download", "Export Capsule"]] },
  review: { title: "Review Inbox", subtitle: "Human decisions required before derived context or rules become active.", actions: [["rule", "Approve Selected", "primary"], ["close", "Reject"]] },
  decisions: { title: "Decisions", subtitle: "Durable choices, rationale, provenance, and version history.", actions: [["add", "Record Decision", "primary"], ["compare_arrows", "Compare Versions"]] },
  work: { title: "Work Items", subtitle: "Executable units of work with readiness signals and blocked dependencies.", actions: [["play_arrow", "Start Ready Item", "primary"], ["add_task", "Create Item"]] },
  context: { title: "Context", subtitle: "Governed sources, immutable evidence snapshots, and derived context items.", actions: [["add", "Add Source", "primary"], ["add_box", "Add Context Item"], ["sync", "Sync Sources"]] },
  rules: { title: "Rules", subtitle: "Versioned governance instructions controlling automated agent behavior.", actions: [["add", "New Rule", "primary"], ["history", "Version History"]] },
  settings: { title: "Settings", subtitle: "Configure how ContextOS runs, connects to agents, and handles work context.", actions: [["restart_alt", "Reset changes"], ["check", "Save changes", "primary"]], narrow: true }
};

const enabledActions = new Set(["refresh-context", "add-project", "new-session", "sync-transcript", "continue-in-agent", "import-existing-session", "import-transcript", "export-capsule", "approve-selected", "reject", "record-decision", "start-ready-item", "create-item", "add-source", "add-context-item", "sync-sources", "new-rule", "reset-changes", "save-changes"]);

function emptyData(): WorkspaceData {
  return {
    health: null,
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
    return { ok: false, error: error instanceof Error ? error : new Error("Request failed") };
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
  inbox: <><path d="M4 5h16l-2 14H6z" /><path d="M4 13h5l2 3h2l2-3h5" /></>,
  inventory_2: <><path d="M4 7h16v13H4z" /><path d="M4 7l3-4h10l3 4M9 11h6" /></>,
  link: <><path d="M10 7l1-1a4 4 0 0 1 6 6l-1 1M14 17l-1 1a4 4 0 0 1-6-6l1-1M9 15l6-6" /></>,
  lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  manage_search: <><circle cx="10" cy="10" r="5" /><path d="M14 14l5 5M4 20h7" /></>,
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

function actionId(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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

function toneForStatus(status: string | null | undefined) {
  if (["ACTIVE", "RUNNING", "READY", "SUCCEEDED", "DONE", "ACCEPTED", "RESOLVED", "VALID"].includes(String(status))) return "green";
  if (["OPEN", "DRAFT", "PROPOSED", "CREATED", "IN_PROGRESS", "IN_REVIEW"].includes(String(status))) return "blue";
  if (["BLOCKED", "PAUSED", "DISABLED", "STALE"].includes(String(status))) return "amber";
  if (["FAILED", "CANCELED", "ARCHIVED", "INVALID", "DISMISSED"].includes(String(status))) return "red";
  return "";
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

function Table({ headers, rows, empty = "No records yet." }: { headers: string[]; rows: ReactNode[][]; empty?: string }) {
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

function Rows({ rows, empty = "No items yet." }: { rows: Array<[ReactNode, ReactNode, string, ReactNode?]>; empty?: string }) {
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
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionDetails, setSessionDetails] = useState<SessionDetails | null>(null);
  const [sessionDetailsLoading, setSessionDetailsLoading] = useState(false);
  const [modal, setModal] = useState<{ kind: ModalKind; sessionId?: string; reviewId?: string }>({ kind: null });
  const [evidenceDetail, setEvidenceDetail] = useState<{ snapshot: AnyRecord; content: AnyRecord | null; loading: boolean; error: string | null } | null>(null);
  const [contextItemDetail, setContextItemDetail] = useState<{ item: AnyRecord; versions: AnyRecord[]; loading: boolean; error: string | null } | null>(null);
  const preferredSessionIdRef = useRef<string | null>(null);

  const availableAdapters = useCallback(() => data.adapters.filter((adapter) => adapter.available), [data.adapters]);
  const defaultAdapterId = useCallback(() => {
    const configured = data.settings?.defaultAdapterId;
    if (configured && data.adapters.some((adapter) => adapter.id === configured)) return configured;
    return availableAdapters()[0]?.id || data.adapters[0]?.id || "codex";
  }, [availableAdapters, data.adapters, data.settings?.defaultAdapterId]);
  const adapterList = data.adapters.length ? data.adapters : [{ id: "codex", displayName: "Codex", available: true }];

  const loadSessionDetails = useCallback(async (session: AnyRecord | undefined): Promise<SessionDetails | null> => {
    if (!session) return null;
    const [contextPack, evidence, resumeCapsule, runtimeStatus] = await Promise.all([
      settle(fetchJson(`/api/sessions/${session.id}/context-pack`)),
      settle(fetchJson(`/api/sessions/${session.id}/evidence`)),
      settle(fetchJson(`/api/sessions/${session.id}/resume-capsule`)),
      settle(fetchJson(`/api/sessions/${session.id}/runtime-status`))
    ]);
    return {
      sessionId: session.id,
      contextPack: contextPack.ok ? contextPack.value : null,
      evidence: evidence.ok ? evidence.value.items : [],
      resumeCapsule: resumeCapsule.ok ? resumeCapsule.value : null,
      runtimeStatus: runtimeStatus.ok ? runtimeStatus.value : null
    };
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const requests = {
      health: fetchJson("/api/health"),
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
    const selectedSession = next.sessions.find((session) => session.id === preferredSessionIdRef.current) || next.sessions[0];
    setData(next);
    setError(failures.length === entries.length ? "Daemon unavailable" : failures[0] || null);
    preferredSessionIdRef.current = selectedSession?.id || null;
    setSelectedSessionId(selectedSession?.id || null);
    setSessionDetailsLoading(Boolean(selectedSession));
    setSessionDetails(await loadSessionDetails(selectedSession));
    setSessionDetailsLoading(false);
    setLoading(false);
  }, [loadSessionDetails]);

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
      setActionMessage({ text: actionError instanceof Error ? actionError.message : "Action failed", error: true });
    }
  }, [loadData]);

  const projectById = useCallback((projectId: string) => data.projects.find((item) => item.id === projectId), [data.projects]);
  const sessionById = useCallback((sessionId: string) => data.sessions.find((item) => item.id === sessionId), [data.sessions]);
  const sourceById = useCallback((sourceId: string) => data.contextSources.find((item) => item.id === sourceId), [data.contextSources]);
  const ruleById = useCallback((ruleId: string) => data.rules.find((item) => item.id === ruleId), [data.rules]);
  const decisionById = useCallback((decisionId: string) => data.decisions.find((item) => item.id === decisionId), [data.decisions]);
  const workItemById = useCallback((workItemId: string) => data.workItems.find((item) => item.id === workItemId), [data.workItems]);
  const reviewById = useCallback((reviewId: string) => data.reviews.find((item) => item.id === reviewId), [data.reviews]);

  const selectSession = useCallback(async (sessionId: string) => {
    const session = sessionById(sessionId);
    preferredSessionIdRef.current = sessionId;
    setSelectedSessionId(sessionId);
    setSessionDetails(null);
    setSessionDetailsLoading(Boolean(session));
    setSessionDetails(await loadSessionDetails(session));
    setSessionDetailsLoading(false);
  }, [loadSessionDetails, sessionById]);

  const archiveProject = useCallback(async (projectId: string) => {
    const project = projectById(projectId);
    if (!project) throw new Error("No project is available to archive");
    await sendJson(`/api/projects/${project.id}/archive`, "POST", { expectedRevision: project.revision });
  }, [projectById]);

  const archiveSession = useCallback(async (sessionId: string) => {
    const session = sessionById(sessionId);
    if (!session) throw new Error("No session is available to archive");
    await sendJson(`/api/sessions/${session.id}/archive`, "POST", { expectedRevision: session.revision });
  }, [sessionById]);

  const continueSession = useCallback(async (sessionId: string) => {
    const session = sessionById(sessionId);
    if (!session) throw new Error("No session is available to continue");
    await sendJson(`/api/sessions/${session.id}/continue`, "POST", { expectedRevision: session.revision });
    window.setTimeout(() => void loadData(), 500);
  }, [loadData, sessionById]);

  const importTranscriptAuto = useCallback(async (sessionId: string, input: AnyRecord = {}) => {
    const session = sessionById(sessionId);
    if (!session) throw new Error("No session is available for transcript import");
    await sendJson(`/api/sessions/${session.id}/import-transcript/auto`, "POST", input);
  }, [sessionById]);

  const syncSessionTranscript = useCallback(async (sessionId: string) => {
    const session = sessionById(sessionId);
    if (!session) throw new Error("No session is available for transcript sync");
    await sendJson(`/api/sessions/${session.id}/sync-transcript`, "POST", {});
  }, [sessionById]);

  const interruptSession = useCallback(async (sessionId: string) => {
    const session = sessionById(sessionId);
    if (!session) throw new Error("No session is available to interrupt");
    await sendJson(`/api/sessions/${session.id}/interrupt`, "POST", { expectedRevision: session.revision });
  }, [sessionById]);

  const exportSessionCapsule = useCallback(async (sessionId: string) => {
    const session = sessionById(sessionId);
    if (!session) throw new Error("No session is available to export");
    const [contextPack, evidence, resumeCapsule, runtimeStatus] = await Promise.all([
      settle(fetchJson(`/api/sessions/${session.id}/context-pack`)),
      settle(fetchJson(`/api/sessions/${session.id}/evidence`)),
      settle(fetchJson(`/api/sessions/${session.id}/resume-capsule`)),
      settle(fetchJson(`/api/sessions/${session.id}/runtime-status`))
    ]);
    const capsule = {
      schemaVersion: "contextos.session-capsule.v1",
      exportedAt: new Date().toISOString(),
      session,
      contextPack: contextPack.ok ? contextPack.value : null,
      evidence: evidence.ok ? evidence.value.items : [],
      resumeCapsule: resumeCapsule.ok ? resumeCapsule.value : null,
      runtimeStatus: runtimeStatus.ok ? runtimeStatus.value : null,
      warnings: [
        contextPack.ok ? null : `contextPack: ${contextPack.error.message}`,
        evidence.ok ? null : `evidence: ${evidence.error.message}`,
        resumeCapsule.ok ? null : `resumeCapsule: ${resumeCapsule.error.message}`,
        runtimeStatus.ok ? null : `runtimeStatus: ${runtimeStatus.error.message}`
      ].filter(Boolean)
    };
    downloadJson(`contextos-session-${session.id}.json`, capsule);
  }, [sessionById]);

  const syncSource = useCallback(async (sourceId: string) => {
    const source = sourceById(sourceId);
    if (!source) throw new Error("No context source is available to sync");
    await sendJson(`/api/context-sources/${source.id}/sync`, "POST", { expectedRevision: source.revision });
  }, [sourceById]);
  const transitionSource = useCallback(async (sourceId: string, action: string) => {
    const source = sourceById(sourceId);
    if (!source) throw new Error("No context source is available");
    await sendJson(`/api/context-sources/${source.id}/${action}`, "POST", { expectedRevision: source.revision });
  }, [sourceById]);

  const syncActiveSources = useCallback(async () => {
    const sources = data.contextSources.filter((source) => source.status === "ACTIVE");
    if (!sources.length) throw new Error("No active context sources are available to sync");
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
  const transitionContextItem = useCallback(async (itemId: string, action: string) => {
    const item = data.contextItems.find((entry) => entry.id === itemId);
    if (!item) throw new Error("No context item is available");
    await sendJson(`/api/context-items/${item.id}/${action}`, "POST", { expectedRevision: item.revision });
  }, [data.contextItems]);
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
    if (!item) throw new Error("No context item is available");
    await sendJson(`/api/context-items/${item.id}/versions/${versionNumber}/restore`, "POST", { expectedRevision: item.revision });
    setContextItemDetail(null);
  }, [data.contextItems]);
  const validateRule = useCallback((ruleId: string) => sendJson(`/api/rules/${ruleId}/validate`, "POST", {}), []);
  const testRule = useCallback((ruleId: string) => sendJson(`/api/rules/${ruleId}/test`, "POST", { eventType: "session.continue", resourceType: "SESSION", data: {} }), []);
  const transitionRule = useCallback(async (ruleId: string, action: string) => {
    const rule = ruleById(ruleId);
    if (!rule) throw new Error("No rule is available");
    await sendJson(`/api/rules/${rule.id}/${action}`, "POST", { expectedRevision: rule.revision });
  }, [ruleById]);
  const transitionDecision = useCallback(async (decisionId: string, action: string) => {
    const decision = decisionById(decisionId);
    if (!decision) throw new Error("No decision is available");
    await sendJson(`/api/decisions/${decision.id}/${action}`, "POST", { expectedRevision: decision.revision });
  }, [decisionById]);
  const transitionWorkItem = useCallback(async (workItemId: string, action: string) => {
    const item = workItemById(workItemId);
    if (!item) throw new Error("No work item is available");
    await sendJson(`/api/work-items/${item.id}/${action}`, "POST", { expectedRevision: item.revision });
  }, [workItemById]);
  const resolveReview = useCallback(async (reviewId: string, input: AnyRecord) => {
    const review = reviewById(reviewId);
    if (!review) throw new Error("No review item is available");
    await sendJson(`/api/review-items/${review.id}/resolve`, "POST", { ...input, expectedRevision: review.revision });
  }, [reviewById]);
  const dismissReview = useCallback(async (reviewId: string, reason: string) => {
    const review = reviewById(reviewId);
    if (!review) throw new Error("No review item is available");
    await sendJson(`/api/review-items/${review.id}/dismiss`, "POST", { resolutionReason: reason, expectedRevision: review.revision });
  }, [reviewById]);

  const handleAction = useCallback((action: string) => {
    if (action === "refresh-context" || action === "reset-changes") return void loadData();
    if (action === "add-project") return setModal({ kind: "project" });
    if (action === "new-session") return data.projects[0] ? setModal({ kind: "session" }) : setActionMessage({ text: "Create a project before starting a session", error: true });
    if (action === "new-rule") return data.projects[0] ? setModal({ kind: "rule" }) : setActionMessage({ text: "Create a project before adding rules", error: true });
    if (action === "add-source") return data.projects[0] ? setModal({ kind: "source" }) : setActionMessage({ text: "Create a project before adding context sources", error: true });
    if (action === "add-context-item") return data.projects[0] ? setModal({ kind: "contextItem" }) : setActionMessage({ text: "Create a project before adding context items", error: true });
    if (action === "record-decision") return data.projects[0] ? setModal({ kind: "decision" }) : setActionMessage({ text: "Create a project before recording decisions", error: true });
    if (action === "create-item") return data.projects[0] ? setModal({ kind: "workItem" }) : setActionMessage({ text: "Create a project before creating work items", error: true });
    if (action === "start-ready-item") {
      const item = data.workItems.find((workItem) => workItem.status === "READY");
      if (!item) return setActionMessage({ text: "No ready work item is available", error: true });
      return void runAction(() => transitionWorkItem(item.id, "start"), "Work item started");
    }
    if (action === "approve-selected" || action === "reject") {
      const review = data.reviews.find((item) => ["OPEN", "IN_PROGRESS"].includes(item.status));
      if (!review) return setActionMessage({ text: "No open review item is available", error: true });
      return setModal({ kind: action === "approve-selected" ? "reviewResolve" : "reviewDismiss", reviewId: review.id });
    }
    if (action === "sync-sources") return void runAction(syncActiveSources, "Context sources synced");
    if (action === "continue-in-agent") {
      const selected = selectedSessionId ? data.sessions.find((item) => item.id === selectedSessionId) : null;
      const session = selected && ["CREATED", "PAUSED", "FAILED", "COMPLETED"].includes(selected.status) ? selected : data.sessions.find((item) => ["CREATED", "PAUSED", "FAILED", "COMPLETED"].includes(item.status));
      if (!session) return setActionMessage({ text: "Create a session before continuing in an agent", error: true });
      return void runAction(() => continueSession(session.id), "Session continued in Agent");
    }
    if (action === "import-transcript") {
      const session = selectedSessionId ? data.sessions.find((item) => item.id === selectedSessionId) : data.sessions[0];
      if (!session) return setActionMessage({ text: "Create a session before importing a transcript", error: true });
      return setModal({ kind: "transcript", sessionId: session.id });
    }
    if (action === "sync-transcript") {
      const session = selectedSessionId ? data.sessions.find((item) => item.id === selectedSessionId) : data.sessions[0];
      if (!session) return setActionMessage({ text: "Create or select a session before syncing a transcript", error: true });
      return void runAction(() => syncSessionTranscript(session.id), "Transcript synced from agent");
    }
    if (action === "import-existing-session") {
      const session = selectedSessionId ? data.sessions.find((item) => item.id === selectedSessionId) : data.sessions[0];
      if (!session) return setActionMessage({ text: "Create a ContextOS session before importing an existing agent session", error: true });
      return setModal({ kind: "existingTranscript", sessionId: session.id });
    }
    if (action === "export-capsule") {
      const session = selectedSessionId ? data.sessions.find((item) => item.id === selectedSessionId) : data.sessions[0];
      if (!session) return setActionMessage({ text: "Create or select a session before exporting a capsule", error: true });
      return void runAction(() => exportSessionCapsule(session.id), "Session capsule exported");
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
      }), "Settings saved");
    }
  }, [continueSession, data.projects, data.reviews, data.sessions, data.settings, data.workItems, defaultAdapterId, exportSessionCapsule, loadData, runAction, selectedSessionId, syncActiveSources, syncSessionTranscript, transitionWorkItem]);

  const navigate = (next: PageId) => {
    setPage(next);
    setActionMessage(null);
    location.hash = next;
  };

  const renderPage = () => {
    if (loading) return <><PageHeader pageDef={pages[page]} actionLoading={actionLoading} error={error} actionMessage={actionMessage} onAction={handleAction} /><EmptyNote>Loading workspace data...</EmptyNote></>;
    const props = { data, actionLoading, runAction, archiveProject, archiveSession, continueSession, importTranscriptAuto, syncSessionTranscript, interruptSession, exportSessionCapsule, syncSource, transitionSource, verifyEvidence, openEvidenceDetail, transitionContextItem, openContextItemDetail, restoreContextItemVersion, validateRule, testRule, transitionRule, transitionDecision, transitionWorkItem, resolveReview, dismissReview, setModal, defaultAdapterId, adapterList, selectedSessionId, selectSession, sessionDetails, sessionDetailsLoading };
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
          <div className="brand"><div className="brand-mark">{icon("terminal")}</div><div><div className="brand-title">ContextOS</div><div className="brand-sub mono">AGENT WORKSPACE</div></div></div>
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
        <div className="daemon"><div className="daemon-main"><span className="dot" /><div><div className="daemon-title">{data.health ? "Daemon running" : loading ? "Checking daemon" : "Daemon offline"}</div><div className="daemon-sub mono">{API_BASE.replace(/^https?:\/\//, "")}</div></div></div><button className="icon-btn" onClick={() => navigate("settings")} title="Settings">{icon("settings")}</button></div>
      </aside>
      <div className="shell">
        <header className="topbar">
          <div className="crumbs mono"><span>Workspace</span><span>/</span><span className="crumb-current">{pages[page].title}</span><ProjectPill project={data.projects[0]} /></div>
          <div className="top-actions">
            <div className="search">{icon("search")}<input placeholder="Search projects, sessions, decisions..." /></div>
            <div className="agent-pill mono"><span className="dot" /><span>{data.adapters.filter((adapter) => adapter.available).length} connected</span><span className="quiet">·</span><strong>{data.adapters.length} adapters available</strong></div>
            <button className="icon-btn" title="Refresh" onClick={() => void loadData()}>{icon("refresh")}</button>
            <div className="identity"><div className="avatar">AD</div><div><strong>Adam</strong><div className="daemon-sub mono">Lead Architect</div></div></div>
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
        runAction={runAction}
      />
      <EvidenceDetail detail={evidenceDetail} onClose={() => setEvidenceDetail(null)} />
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
        {pageDef.actions.map(([ic, label, kind]) => {
          const id = actionId(label);
          const disabled = !enabledActions.has(id) || actionLoading;
          return <button className={`btn ${kind || ""}`} data-action={id} disabled={disabled} key={id} onClick={() => onAction(id)}>{icon(actionLoading && enabledActions.has(id) ? "progress_activity" : ic)}<span>{label}</span></button>;
        })}
      </div>
    </section>
  );
}

function ProjectPill({ project }: { project?: AnyRecord }) {
  return <span className="project-pill">{icon("folder_managed")} {project ? `${project.name} (${project.rootPath})` : "No project loaded"}</span>;
}

function OverviewPage({ data, header }: { data: WorkspaceData; header: ReactNode }) {
  const activeProject = data.projects[0];
  const readyWork = data.workItems.filter((item) => ["READY", "IN_PROGRESS"].includes(item.status));
  return (
    <>
      {header}
      <div className="kpi-grid">{[[data.sessions.length, "Sessions indexed"], [data.decisions.length, "Decisions active"], [data.workItems.length, "Work items"], [data.reviews.length, "Review required"]].map(([value, label]) => <div className="kpi" key={String(label)}><div className="kpi-value">{value}</div><div className="kpi-label mono">{label}</div></div>)}</div>
      <div className="grid cols-12" style={{ marginTop: 16 }}>
        <div className="span-8 stack">
          <Panel title="Current Project" iconName="folder_open">{activeProject ? <div className="pad stack"><div className="split"><div><div className="title-sm">{activeProject.name}</div><div className="muted">{activeProject.description || "Agent workspace governance"}</div></div><Badge text={activeProject.status} tone={toneForStatus(activeProject.status)} /></div><div className="progress"><span style={{ width: "72%" }} /></div><div className="split mono muted"><span>Boundary: {activeProject.rootPath}</span><span>Revision: {activeProject.revision}</span></div></div> : <EmptyNote>Create a project to start using ContextOS.</EmptyNote>}</Panel>
          <Panel title="Next Work Items" iconName="task_alt" meta={`${readyWork.length} ready signals`}><Rows rows={readyWork.slice(0, 4).map((item) => [item.title, item.status, toneForStatus(item.status), item.description || ""])} empty="No ready work items." /></Panel>
        </div>
        <div className="span-4 stack">
          <Panel title="Governance Queue" iconName="inbox"><Rows rows={data.reviews.slice(0, 4).map((item) => [item.summary, item.status, toneForStatus(item.status), item.proposedResolution || ""])} empty="No pending review items." /></Panel>
          <Panel title="Linked Activity" iconName="link"><div className="metric-row"><span>Sessions</span><strong>{data.sessions.length}</strong></div><div className="metric-row"><span>Decisions</span><strong>{data.decisions.length}</strong></div><div className="metric-row"><span>Context Items</span><strong>{data.contextItems.length}</strong></div></Panel>
        </div>
      </div>
    </>
  );
}

function ProjectsPage(props: AnyRecord & { header: ReactNode }) {
  const { data, header, actionLoading, runAction, archiveProject } = props;
  return <>{header}<Panel title="Project Register" iconName="folder_open"><Table headers={["Project", "Boundary", "Rules", "Health", "Activity", "Action"]} rows={data.projects.map((project: AnyRecord) => [<><strong>{project.name}</strong><div className="muted">{project.description || "Agent workspace"}</div></>, <span className="mono">{project.rootPath}</span>, <Badge text={`${project.defaultRuleIds?.length || 0} defaults`} tone="blue" />, <Badge text={project.status} tone={toneForStatus(project.status)} />, `rev ${project.revision}`, <button className="icon-btn table-action" title="Archive project" disabled={actionLoading} onClick={() => runAction(() => archiveProject(project.id), "Project archived")}>{icon("archive")}</button>])} empty="No projects yet." /></Panel></>;
}

function SessionsPage(props: AnyRecord & { header: ReactNode }) {
  const { data, header, selectedSessionId, selectSession, sessionDetails: details, sessionDetailsLoading, actionLoading, runAction, archiveSession, continueSession, syncSessionTranscript, interruptSession, exportSessionCapsule, openEvidenceDetail, setModal } = props;
  const canContinue = (status: string) => ["CREATED", "PAUSED", "FAILED", "COMPLETED"].includes(status);
  const evidenceMeta = (item: AnyRecord) => [item.metadata?.adapterId ? `adapter ${item.metadata.adapterId}` : null, item.metadata?.externalSessionId ? `external ${item.metadata.externalSessionId}` : null, item.metadata?.parserVersion || null, item.metadata?.messageCount ? `${item.metadata.messageCount} messages` : null, item.metadata?.turnCount ? `${item.metadata.turnCount} turns` : null].filter(Boolean).join(" · ");
  const selectedSession = data.sessions.find((session: AnyRecord) => session.id === selectedSessionId) || data.sessions[0];
  const contextItemCount = details?.contextPack?.contextItems?.length ?? 0;
  const evidencePackageCount = details?.contextPack?.evidenceSnapshots?.length ?? 0;
  const runtime = details?.runtimeStatus;
  const latestAgentTranscript = details?.evidence.find((item: AnyRecord) => item.metadata?.stream === "imported-transcript" && item.metadata?.adapterId);
  const syncLabel = latestAgentTranscript?.metadata?.sourceUpdatedAt ? `Last synced ${fmtDate(latestAgentTranscript.metadata.sourceUpdatedAt)}` : selectedSession?.externalSessionId ? "Bound, not synced yet" : "Not bound yet";
  return (
    <>{header}<div className="stack">
      <Panel title="Session Episodes" iconName="terminal"><Table headers={["Session", "Agent", "Started", "Updated", "Status", "Action"]} rows={data.sessions.map((session: AnyRecord) => [
        <div className={`session-cell ${session.id === selectedSession?.id ? "selected" : ""}`}><strong>{session.title || session.id}</strong><div className="muted">{session.intent || ""}</div>{session.externalSessionId ? <div className="muted mono">bound {session.externalSessionId}</div> : <div className="muted mono">not bound</div>}</div>,
        session.agentAdapterId,
        fmtDate(session.startedAt),
        fmtDate(session.updatedAt),
        <Badge text={session.status} tone={toneForStatus(session.status)} />,
        <div className="row-actions">
          <button className="icon-btn table-action" title="View session details" disabled={actionLoading} onClick={() => void selectSession(session.id)}>{icon("visibility")}</button>
          <button className="icon-btn table-action" title="Continue in Agent" disabled={!canContinue(session.status) || actionLoading} onClick={() => runAction(() => continueSession(session.id), "Session continued in Agent")}>{icon("play_arrow")}</button>
          <button className="icon-btn table-action" title="Interrupt managed run" disabled={session.status !== "RUNNING" || actionLoading} onClick={() => runAction(() => interruptSession(session.id), "Session interrupted")}>{icon("stop_circle")}</button>
          <button className="icon-btn table-action" title="Sync agent transcript" disabled={actionLoading} onClick={() => runAction(() => syncSessionTranscript(session.id), "Transcript synced from agent")}>{icon("sync")}</button>
          <button className="icon-btn table-action" title="Import existing agent session" disabled={actionLoading} onClick={() => setModal({ kind: "existingTranscript", sessionId: session.id })}>{icon("manage_search")}</button>
          <button className="icon-btn table-action" title="Paste transcript" disabled={actionLoading} onClick={() => setModal({ kind: "transcript", sessionId: session.id })}>{icon("edit_note")}</button>
          <button className="icon-btn table-action" title="Export session capsule" disabled={actionLoading} onClick={() => runAction(() => exportSessionCapsule(session.id), "Session capsule exported")}>{icon("download")}</button>
          <button className="icon-btn table-action" title="Archive session" disabled={session.status === "RUNNING" || actionLoading} onClick={() => runAction(() => archiveSession(session.id), "Session archived")}>{icon("archive")}</button>
        </div>
      ])} empty="No sessions yet." /></Panel>
      <Panel title="Selected Session Detail" iconName="inventory_2" meta={selectedSession ? selectedSession.id : "No session"}>
        {sessionDetailsLoading ? <EmptyNote>Loading selected session detail...</EmptyNote> : null}
        {selectedSession && details ? <div className="session-detail">
          <div className="detail-grid">
            <div><span className="mono muted">STATUS</span><strong>{selectedSession.status}</strong></div>
            <div><span className="mono muted">AGENT</span><strong>{selectedSession.agentAdapterId}</strong></div>
            <div><span className="mono muted">REVISION</span><strong>{selectedSession.revision}</strong></div>
            <div className="detail-wide"><span className="mono muted">TITLE</span><strong>{selectedSession.title || selectedSession.id}</strong></div>
            <div className="detail-wide"><span className="mono muted">INTENT</span><strong>{selectedSession.intent || "-"}</strong></div>
            <div className="detail-wide detail-with-action"><div><span className="mono muted">EXTERNAL AGENT SESSION</span><strong className="mono">{selectedSession.externalSessionId || "Not bound"}</strong></div><button className="icon-btn table-action" title="Copy external session ID" disabled={!selectedSession.externalSessionId} onClick={() => copyText(selectedSession.externalSessionId)}>{icon("content_copy")}</button></div>
            <div className="detail-wide detail-with-action"><div><span className="mono muted">TRANSCRIPT SYNC</span><strong>{syncLabel}</strong><div className="muted mono">{latestAgentTranscript ? `${latestAgentTranscript.metadata?.messageCount || 0} messages · ${latestAgentTranscript.metadata?.turnCount || 0} turns · ${latestAgentTranscript.metadata?.transcriptTruncated ? "truncated" : "complete"}` : "Uses Codex/Claude transcript discovery for this Project"}</div></div><button className="icon-btn table-action" title="Sync agent transcript now" disabled={actionLoading} onClick={() => runAction(() => syncSessionTranscript(selectedSession.id), "Transcript synced from agent")}>{icon("sync")}</button></div>
          </div>
          <div className="kpi-grid compact-kpis">
            <div className="kpi"><div className="kpi-value">{contextItemCount}</div><div className="kpi-label mono">Context items</div></div>
            <div className="kpi"><div className="kpi-value">{evidencePackageCount}</div><div className="kpi-label mono">Package evidence</div></div>
            <div className="kpi"><div className="kpi-value">{details.evidence.length}</div><div className="kpi-label mono">Session evidence</div></div>
            <div className="kpi"><div className="kpi-value">{details.resumeCapsule?.status || "-"}</div><div className="kpi-label mono">Resume status</div></div>
          </div>
          <div className="detail-grid">
            <div className="detail-wide detail-with-action"><div><span className="mono muted">CONTEXT PACKAGE</span><strong className="mono">{details.contextPack?.id || "Not generated"}</strong></div><button className="icon-btn table-action" title="Copy context package ID" disabled={!details.contextPack?.id} onClick={() => copyText(details.contextPack?.id)}>{icon("content_copy")}</button></div>
            <div className="detail-wide"><span className="mono muted">RUNTIME</span><strong>{runtime?.run?.status || "No active run"}</strong><div className="muted mono">{runtime?.process ? `pid ${runtime.process.pid} · managed ${runtime.process.managed} · running ${runtime.process.running}` : "No managed process"}</div></div>
            <div className="detail-wide"><span className="mono muted">RESUME SUMMARY</span><strong>{details.resumeCapsule?.summary || "No resume capsule yet"}</strong></div>
            <div className="detail-wide"><span className="mono muted">NEXT ACTION</span><strong>{details.resumeCapsule?.nextAction || "-"}</strong></div>
          </div>
          <div className="row-actions">
            <button className="btn primary" disabled={!canContinue(selectedSession.status) || actionLoading} onClick={() => runAction(() => continueSession(selectedSession.id), "Session continued in Agent")}>{icon("play_arrow")}<span>Continue</span></button>
            <button className="btn" disabled={selectedSession.status !== "RUNNING" || actionLoading} onClick={() => runAction(() => interruptSession(selectedSession.id), "Session interrupted")}>{icon("stop_circle")}<span>Interrupt</span></button>
            <button className="btn" disabled={actionLoading} onClick={() => runAction(() => syncSessionTranscript(selectedSession.id), "Transcript synced from agent")}>{icon("sync")}<span>Sync Transcript</span></button>
            <button className="btn" disabled={actionLoading} onClick={() => setModal({ kind: "resumeCapsule", sessionId: selectedSession.id })}>{icon("edit_note")}<span>Edit Capsule</span></button>
            <button className="btn" disabled={actionLoading} onClick={() => setModal({ kind: "existingTranscript", sessionId: selectedSession.id })}>{icon("manage_search")}<span>Import Existing</span></button>
            <button className="btn" disabled={actionLoading} onClick={() => setModal({ kind: "transcript", sessionId: selectedSession.id })}>{icon("edit_note")}<span>Paste Transcript</span></button>
            <button className="btn" disabled={actionLoading} onClick={() => runAction(() => exportSessionCapsule(selectedSession.id), "Session capsule exported")}>{icon("download")}<span>Export Capsule</span></button>
          </div>
          {details.evidence.length ? <div>
            <div className="title-sm evidence-section-title">Evidence Snapshots</div>
            <div className="stack compact">{details.evidence.slice(0, 8).map((item: AnyRecord) => <div className="metric-row evidence-row" key={item.id}><div className="evidence-row-main"><div className="title-sm">{item.title}</div><div className="muted mono">{evidenceMeta(item) || item.storageRef || item.id}</div></div><div className="row-actions"><Badge text={item.evidenceType} tone="blue" /><button className="icon-btn table-action" title="Open evidence content" disabled={actionLoading} onClick={() => void openEvidenceDetail(item)}>{icon("visibility")}</button><button className="icon-btn table-action" title="Copy evidence reference" disabled={actionLoading} onClick={() => copyText(`${item.id}\n${item.storageRef || ""}\n${item.contentHash || ""}`)}>{icon("content_copy")}</button></div></div>)}</div>
          </div> : <EmptyNote>No evidence has been captured for this session yet.</EmptyNote>}
        </div> : !sessionDetailsLoading ? <EmptyNote>Select or create a session to inspect its context package, runtime state, evidence, and resume capsule.</EmptyNote> : null}
      </Panel>
    </div></>
  );
}

function ReviewPage(props: AnyRecord & { header: ReactNode }) {
  const { data, header, actionLoading, setModal } = props;
  return <>{header}<Panel title="Pending Review Items" iconName="inbox"><Table headers={["Review", "Source", "Priority", "Status", "Action"]} rows={data.reviews.map((item: AnyRecord) => [
    <><strong>{item.summary}</strong><div className="muted">{item.proposedResolution || item.triggerType}</div></>,
    <span className="mono">{item.sourceType} · {item.sourceId}</span>,
    <Badge text={item.priority} tone={item.priority === "URGENT" || item.priority === "HIGH" ? "amber" : "blue"} />,
    <Badge text={item.status} tone={toneForStatus(item.status)} />,
    <div className="row-actions">
      <button className="icon-btn table-action" title="Resolve review" disabled={!["OPEN", "IN_PROGRESS"].includes(item.status) || actionLoading} onClick={() => setModal({ kind: "reviewResolve", reviewId: item.id })}>{icon("task_alt")}</button>
      <button className="icon-btn table-action" title="Dismiss review" disabled={!["OPEN", "IN_PROGRESS"].includes(item.status) || actionLoading} onClick={() => setModal({ kind: "reviewDismiss", reviewId: item.id })}>{icon("block")}</button>
    </div>
  ])} empty="No review items." /></Panel></>;
}

function DecisionsPage(props: AnyRecord & { header: ReactNode }) {
  const { data, header, actionLoading, runAction, transitionDecision } = props;
  return <>{header}<Panel title="Decision Register" iconName="gavel"><Table headers={["Decision", "Version", "Updated", "State", "Action"]} rows={data.decisions.map((item: AnyRecord) => [
    <><strong>{item.title}</strong><div className="muted mono">{item.id}</div></>,
    item.currentVersionId || "-",
    fmtDate(item.updatedAt),
    <Badge text={item.status} tone={toneForStatus(item.status)} />,
    <div className="row-actions">
      <button className="icon-btn table-action" title="Propose decision" disabled={item.status !== "DRAFT" || actionLoading} onClick={() => runAction(() => transitionDecision(item.id, "propose"), "Decision proposed")}>{icon("publish")}</button>
      <button className="icon-btn table-action" title="Accept decision" disabled={!["DRAFT", "PROPOSED"].includes(item.status) || actionLoading} onClick={() => runAction(() => transitionDecision(item.id, "accept"), "Decision accepted")}>{icon("check_circle")}</button>
      <button className="icon-btn table-action" title="Archive decision" disabled={!["DRAFT", "PROPOSED", "SUPERSEDED", "REVERSED"].includes(item.status) || actionLoading} onClick={() => runAction(() => transitionDecision(item.id, "archive"), "Decision archived")}>{icon("archive")}</button>
    </div>
  ])} empty="No decisions yet." /></Panel></>;
}

function WorkPage(props: AnyRecord & { header: ReactNode }) {
  const { data, header, actionLoading, runAction, transitionWorkItem } = props;
  return <>{header}<Panel title="Execution Readiness" iconName="task_alt"><Table headers={["Work item", "Parent", "Acceptance", "Updated", "Status", "Action"]} rows={data.workItems.map((item: AnyRecord) => [
    <><strong>{item.title}</strong><div className="muted">{item.description || ""}</div></>,
    item.parentId || "-",
    `${item.acceptance?.length || 0}`,
    fmtDate(item.updatedAt),
    <Badge text={item.status} tone={toneForStatus(item.status)} />,
    <div className="row-actions">
      <button className="icon-btn table-action" title="Mark ready" disabled={item.status !== "BACKLOG" || actionLoading} onClick={() => runAction(() => transitionWorkItem(item.id, "mark-ready"), "Work item marked ready")}>{icon("playlist_add_check")}</button>
      <button className="icon-btn table-action" title="Start work" disabled={item.status !== "READY" || actionLoading} onClick={() => runAction(() => transitionWorkItem(item.id, "start"), "Work item started")}>{icon("play_arrow")}</button>
      <button className="icon-btn table-action" title="Block work" disabled={item.status !== "IN_PROGRESS" || actionLoading} onClick={() => runAction(() => transitionWorkItem(item.id, "block"), "Work item blocked")}>{icon("pause_circle")}</button>
      <button className="icon-btn table-action" title="Send to review" disabled={item.status !== "IN_PROGRESS" || actionLoading} onClick={() => runAction(() => transitionWorkItem(item.id, "send-to-review"), "Work item sent to review")}>{icon("rate_review")}</button>
      <button className="icon-btn table-action" title="Complete work" disabled={!["IN_PROGRESS", "IN_REVIEW"].includes(item.status) || actionLoading} onClick={() => runAction(() => transitionWorkItem(item.id, "complete"), "Work item completed")}>{icon("check_circle")}</button>
      <button className="icon-btn table-action" title="Reopen work" disabled={!["DONE", "CANCELED"].includes(item.status) || actionLoading} onClick={() => runAction(() => transitionWorkItem(item.id, "reopen"), "Work item reopened")}>{icon("undo")}</button>
      <button className="icon-btn table-action" title="Cancel work" disabled={!["BACKLOG", "READY", "IN_PROGRESS", "BLOCKED", "IN_REVIEW"].includes(item.status) || actionLoading} onClick={() => runAction(() => transitionWorkItem(item.id, "cancel"), "Work item canceled")}>{icon("cancel")}</button>
    </div>
  ])} empty="No work items yet." /></Panel></>;
}

function ContextPage(props: AnyRecord & { header: ReactNode }) {
  const { data, header, actionLoading, runAction, syncSource, transitionSource, verifyEvidence, openEvidenceDetail, transitionContextItem, openContextItemDetail } = props;
  return (
    <>{header}<div className="grid cols-12"><div className="span-8 stack">
      <Panel title="Sources" iconName="database"><Table headers={["Source", "Type", "Last sync", "Snapshots", "State", "Action"]} rows={data.contextSources.map((source: AnyRecord) => [<><strong>{source.name}</strong><div className="muted mono">{source.locator}</div></>, source.sourceType, fmtDate(source.lastCheckedAt), source.lastSnapshotId || "-", <Badge text={source.status} tone={toneForStatus(source.status)} />, <div className="row-actions"><button className="icon-btn table-action" title="Sync source" disabled={source.status !== "ACTIVE" || actionLoading} onClick={() => runAction(() => syncSource(source.id), "Context source synced")}>{icon("sync")}</button><button className="icon-btn table-action" title="Pause source" disabled={source.status !== "ACTIVE" || actionLoading} onClick={() => runAction(() => transitionSource(source.id, "pause"), "Context source paused")}>{icon("pause_circle")}</button><button className="icon-btn table-action" title="Resume source" disabled={source.status !== "PAUSED" || actionLoading} onClick={() => runAction(() => transitionSource(source.id, "resume"), "Context source resumed")}>{icon("play_arrow")}</button><button className="icon-btn table-action" title="Archive source" disabled={source.status === "ARCHIVED" || actionLoading} onClick={() => runAction(() => transitionSource(source.id, "archive"), "Context source archived")}>{icon("archive")}</button></div>])} empty="No context sources yet." /></Panel>
      <Panel title="Evidence Snapshots" iconName="fact_check"><Table headers={["Evidence", "Type", "Captured", "Storage", "Action"]} rows={data.evidenceSnapshots.slice(0, 12).map((snapshot: AnyRecord) => [<><strong>{snapshot.title}</strong><div className="muted mono">{snapshot.contentHash || "-"}</div></>, <Badge text={snapshot.evidenceType} tone="blue" />, fmtDate(snapshot.capturedAt), <span className="mono">{snapshot.storageRef || "-"}</span>, <div className="row-actions"><button className="icon-btn table-action" title="Open evidence content" disabled={actionLoading} onClick={() => void openEvidenceDetail(snapshot)}>{icon("visibility")}</button><button className="icon-btn table-action" title="Copy evidence reference" disabled={actionLoading} onClick={() => copyText(`${snapshot.id}\n${snapshot.storageRef || ""}\n${snapshot.contentHash}`)}>{icon("content_copy")}</button><button className="icon-btn table-action" title="Verify evidence" disabled={actionLoading} onClick={() => runAction(() => verifyEvidence(snapshot.id), "Evidence verified")}>{icon("verified")}</button></div>])} empty="No evidence snapshots yet." /></Panel>
    </div><div className="span-4 stack"><Panel title="Integrity Boundary" iconName="verified"><div className="metric-row"><span>Evidence snapshots</span><strong>{data.evidenceSnapshots.length}</strong></div><div className="metric-row"><span>Derived context items</span><strong>{data.contextItems.length}</strong></div><div className="metric-row"><span>Stored evidence</span><strong>{data.evidenceSnapshots.filter((item: AnyRecord) => item.storageRef).length}</strong></div></Panel><Panel title="Context Items" iconName="inventory_2"><Table headers={["Item", "State", "Action"]} rows={data.contextItems.slice(0, 8).map((item: AnyRecord) => [<><strong>{item.title}</strong><div className="muted">{item.summary}</div><div className="muted mono">{item.itemType} · {item.confidence}</div></>, <Badge text={item.status} tone={toneForStatus(item.status)} />, <div className="row-actions"><button className="icon-btn table-action" title="View versions" disabled={actionLoading} onClick={() => void openContextItemDetail(item)}>{icon("visibility")}</button><button className="icon-btn table-action" title="Activate item" disabled={item.status === "ACTIVE" || item.status === "ARCHIVED" || actionLoading} onClick={() => runAction(() => transitionContextItem(item.id, "activate"), "Context item activated")}>{icon("toggle_on")}</button><button className="icon-btn table-action" title="Mark stale" disabled={item.status !== "ACTIVE" || actionLoading} onClick={() => runAction(() => transitionContextItem(item.id, "mark-stale"), "Context item marked stale")}>{icon("restart_alt")}</button><button className="icon-btn table-action" title="Archive item" disabled={item.status === "ARCHIVED" || actionLoading} onClick={() => runAction(() => transitionContextItem(item.id, "archive"), "Context item archived")}>{icon("archive")}</button></div>])} empty="No context items yet." /></Panel></div></div></>
  );
}

function RulesPage(props: AnyRecord & { header: ReactNode }) {
  const { data, header, actionLoading, runAction, validateRule, testRule, transitionRule } = props;
  return <>{header}<Panel title="Rule Set" iconName="policy" meta={data.projects[0]?.name || "Workspace"}><Table headers={["Rule", "Version", "State", "Action"]} rows={data.rules.map((rule: AnyRecord) => [<><strong>{rule.title}</strong><div className="muted">{rule.description || ""}</div></>, rule.currentVersionId || "-", <Badge text={rule.status} tone={toneForStatus(rule.status)} />, <div className="row-actions"><button className="icon-btn table-action" title="Validate rule" disabled={actionLoading} onClick={() => runAction(() => validateRule(rule.id), "Rule validated")}>{icon("rule")}</button><button className="icon-btn table-action" title="Test against session.continue" disabled={actionLoading} onClick={() => runAction(() => testRule(rule.id), "Rule tested")}>{icon("science")}</button><button className="icon-btn table-action" title="Activate rule" disabled={!["DRAFT", "DISABLED"].includes(rule.status) || actionLoading} onClick={() => runAction(() => transitionRule(rule.id, "activate"), "Rule activated")}>{icon("toggle_on")}</button><button className="icon-btn table-action" title="Disable rule" disabled={rule.status !== "ACTIVE" || actionLoading} onClick={() => runAction(() => transitionRule(rule.id, "disable"), "Rule disabled")}>{icon("toggle_off")}</button></div>])} empty="No rules yet." /></Panel></>;
}

function SettingsPage(props: AnyRecord & { header: ReactNode }) {
  const { data, header, defaultAdapterId, adapterList } = props;
  const settings = data.settings;
  const connected = data.adapters.filter((adapter: AnyRecord) => adapter.available).length;
  return (
    <>{header}<div className="stack">
      <Panel title="General" iconName="tune" meta="Workspace & Defaults">
        {settings ? <>
          <div className="setting-row"><div><div className="title-sm">Default adapter</div><div className="muted">Adapter used when a session does not specify one.</div></div><select id="setting-default-adapter" defaultValue={defaultAdapterId()}>{adapterList.map((adapter: AnyRecord) => <option value={adapter.id} disabled={!adapter.available} key={adapter.id}>{adapter.displayName}{adapter.available ? "" : " (unavailable)"}</option>)}</select></div>
          <div className="setting-row"><div><div className="title-sm">Review gate</div><div className="muted">Require confirmation before destructive actions.</div></div><label className="toggle"><input id="setting-confirm-destructive" type="checkbox" defaultChecked={settings.confirmDestructiveActions} /><span>{settings.confirmDestructiveActions ? "Enabled" : "Disabled"}</span></label></div>
          <div className="setting-row"><div><div className="title-sm">Launch at startup</div><div className="muted">Start the local daemon with the desktop session.</div></div><label className="toggle"><input id="setting-launch-startup" type="checkbox" defaultChecked={settings.launchAtStartup} /><span>{settings.launchAtStartup ? "Enabled" : "Disabled"}</span></label></div>
          <div className="setting-row"><div><div className="title-sm">Data directory</div><div className="muted mono">{settings.dataDirectory}</div></div><Badge text={`rev ${settings.revision}`} /></div>
        </> : <EmptyNote>Settings unavailable.</EmptyNote>}
      </Panel>
      <Panel title="Agent Adapters" iconName="smart_toy"><div className="setting-row"><div><div className="title-sm">Connected adapters</div><div className="muted">Codex and Claude Code are attached when discovery succeeds.</div></div><Badge text={`${connected} connected`} tone={connected ? "green" : "amber"} /></div>{data.adapters.length ? data.adapters.map((adapter: AnyRecord) => <div className="setting-row" key={adapter.id}><div><div className="title-sm">{adapter.displayName}</div><div className="muted mono">{adapter.version || adapter.error || adapter.command}</div></div><Badge text={adapter.available ? "Available" : "Unavailable"} tone={adapter.available ? "green" : "red"} /></div>) : <EmptyNote>No adapters discovered.</EmptyNote>}</Panel>
      <Panel title="Storage & Privacy" iconName="lock"><div className="setting-row"><div><div className="title-sm">Evidence retention</div><div className="muted">Keep immutable source snapshots unless explicitly archived.</div></div><Badge text="Retain indefinitely" /></div><div className="setting-row"><div><div className="title-sm">Secret redaction</div><div className="muted">Scrub credentials before indexing source material.</div></div><Badge text="Enabled" tone="green" /></div><div className="setting-row"><div><div className="title-sm">Bridge mode</div><div className="muted">Local CLI and IPC integration for desktop agents.</div></div><Badge text="CLI / IPC bridge" tone="blue" /></div></Panel>
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
        <div className="dialog-head"><h2>{snapshot.title}</h2><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>{icon("close")}</button></div>
        <div className="dialog-fields">
          <div className="detail-grid compact-detail">
            <div><span className="mono muted">TYPE</span><strong>{snapshot.evidenceType}</strong></div>
            <div><span className="mono muted">SIZE</span><strong>{snapshot.sizeBytes ?? "-"}</strong></div>
            <div><span className="mono muted">CAPTURED</span><strong>{fmtDate(snapshot.capturedAt)}</strong></div>
            <div className="detail-wide"><span className="mono muted">STORAGE</span><strong className="mono">{snapshot.storageRef || "inline"}</strong></div>
            <div className="detail-wide"><span className="mono muted">HASH</span><strong className="mono evidence-hash">{snapshot.contentHash}</strong></div>
          </div>
          <div className="row-actions">
            <button type="button" className="btn" onClick={() => copyText(reference)}>{icon("content_copy")}<span>Copy Reference</span></button>
            <button type="button" className="btn" disabled={!content?.contentText} onClick={() => copyText(content?.contentText)}>{icon("article")}<span>Copy Content</span></button>
          </div>
          {loading ? <EmptyNote>Loading verified evidence content...</EmptyNote> : null}
          {error ? <EmptyNote>{error}</EmptyNote> : null}
          {content ? <>
            <div className="split muted mono"><span>{content.returnedChars} / {content.totalChars} chars</span><span>{content.truncated ? "truncated" : "complete"}</span></div>
            <pre className="evidence-content">{content.contentText}</pre>
          </> : null}
          <div>
            <div className="title-sm">Metadata</div>
            <pre className="evidence-metadata">{prettyJson(snapshot.metadata)}</pre>
          </div>
        </div>
        <div className="dialog-actions"><button type="button" className="btn primary" onClick={onClose}>Done</button></div>
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
        <div className="dialog-head"><h2>{item.title}</h2><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>{icon("close")}</button></div>
        <div className="dialog-fields">
          <div className="detail-grid compact-detail">
            <div><span className="mono muted">TYPE</span><strong>{item.itemType}</strong></div>
            <div><span className="mono muted">STATUS</span><strong>{item.status}</strong></div>
            <div><span className="mono muted">CONFIDENCE</span><strong>{item.confidence}</strong></div>
            <div className="detail-wide"><span className="mono muted">SUMMARY</span><strong>{item.summary}</strong></div>
            <div className="detail-wide"><span className="mono muted">SOURCE SNAPSHOT</span><strong className="mono">{item.sourceSnapshotId || "-"}</strong></div>
          </div>
          {item.body ? <pre className="evidence-metadata">{item.body}</pre> : null}
          {loading ? <EmptyNote>Loading context item versions...</EmptyNote> : null}
          {error ? <EmptyNote>{error}</EmptyNote> : null}
          {versions.length ? <div className="version-list">
            {versions.map((version) => (
              <div className="version-row" key={version.id}>
                <div>
                  <div className="title-sm">v{version.versionNumber} · {version.title}</div>
                  <div className="muted">{version.summary}</div>
                  <div className="muted mono">{version.createdByType}{version.createdById ? `:${version.createdById}` : ""} · {fmtDate(version.createdAt)}</div>
                </div>
                <button type="button" className="btn" disabled={actionLoading} onClick={() => runAction(() => restoreContextItemVersion(item.id, version.versionNumber), "Context item version restored")}>{icon("restart_alt")}<span>Restore</span></button>
              </div>
            ))}
          </div> : !loading && !error ? <EmptyNote>No versions recorded for this context item.</EmptyNote> : null}
        </div>
        <div className="dialog-actions"><button type="button" className="btn primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}

function WorkspaceModal({ modal, setModal, data, defaultAdapterId, adapterList, sessionDetails, runAction }: AnyRecord) {
  const project = data.projects[0];
  const session = modal.sessionId ? data.sessions.find((item: AnyRecord) => item.id === modal.sessionId) : data.sessions[0];
  const review = modal.reviewId ? data.reviews.find((item: AnyRecord) => item.id === modal.reviewId) : data.reviews[0];
  const resumeCapsule = sessionDetails?.sessionId === session?.id ? sessionDetails.resumeCapsule : null;
  const defaultProjectId = session?.projectId || project?.id || "";
  const close = () => setModal({ kind: null });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const kind = modal.kind as ModalKind;
    close();
    if (kind === "project") {
      const adapterIds = (data.adapters.filter((adapter: AnyRecord) => adapter.available).length ? data.adapters.filter((adapter: AnyRecord) => adapter.available) : data.adapters).map((adapter: AnyRecord) => adapter.id);
      void runAction(() => sendJson("/api/projects", "POST", { name: values.get("name"), rootPath: stripWrappingQuotes(values.get("rootPath")), description: values.get("description") || undefined, defaultRuleIds: [], agentAdapterIds: adapterIds.length ? adapterIds : ["codex"] }), "Project created");
    }
    if (kind === "session") {
      void runAction(() => sendJson("/api/sessions", "POST", { projectId: values.get("projectId"), agentAdapterId: values.get("agentAdapterId") || defaultAdapterId(), title: values.get("title"), intent: values.get("intent") }), "Session created");
    }
    if (kind === "rule") {
      void runAction(() => sendJson("/api/rules", "POST", { projectId: project.id, title: values.get("title"), description: values.get("description") || undefined, scope: { eventTypes: ["session.continue"] }, conditions: [], effect: { reason: values.get("reason") }, enforcementMode: values.get("enforcementMode"), precedence: 100, exceptions: [] }), "Rule draft created");
    }
    if (kind === "decision") {
      void runAction(() => sendJson("/api/decisions", "POST", { projectId: values.get("projectId"), title: values.get("title"), statement: values.get("statement"), rationale: values.get("rationale"), problemContext: values.get("problemContext") || undefined, alternatives: linesValue(values.get("alternatives")), consequences: values.get("consequences") || undefined, references: linesValue(values.get("references")) }), "Decision recorded");
    }
    if (kind === "workItem") {
      void runAction(() => sendJson("/api/work-items", "POST", { projectId: values.get("projectId"), parentId: values.get("parentId") || undefined, title: values.get("title"), description: values.get("description") || undefined, acceptance: linesValue(values.get("acceptance")), executionContract: values.get("executionContract") || undefined }), "Work item created");
    }
    if (kind === "contextItem") {
      void runAction(() => sendJson("/api/context-items", "POST", { projectId: values.get("projectId"), sourceSnapshotId: values.get("sourceSnapshotId") || undefined, itemType: values.get("itemType"), title: values.get("title"), summary: values.get("summary"), body: values.get("body") || undefined, confidence: values.get("confidence"), metadata: {} }), "Context item created");
    }
    if (kind === "transcript") {
      void runAction(() => sendJson(`/api/sessions/${session.id}/import-transcript`, "POST", { contentText: values.get("contentText"), title: values.get("title") || undefined, summary: values.get("summary") || undefined }), "Transcript imported");
    }
    if (kind === "existingTranscript") {
      void runAction(() => sendJson(`/api/sessions/${session.id}/import-transcript/auto`, "POST", {
        externalSessionId: String(values.get("externalSessionId") || "").trim() || undefined,
        title: values.get("title") || undefined,
        summary: values.get("summary") || undefined
      }), "Existing agent session imported");
    }
    if (kind === "resumeCapsule") {
      const nextAction = String(values.get("nextAction") || "").trim();
      void runAction(() => sendJson(`/api/sessions/${session.id}/resume-capsule`, "PATCH", {
        summary: values.get("summary"),
        nextAction: nextAction || null,
        expectedRevision: session.revision
      }), "Resume capsule updated");
    }
    if (kind === "source") {
      void runAction(() => sendJson("/api/context-sources", "POST", { projectId: project.id, sourceType: values.get("sourceType"), name: values.get("name"), locator: stripWrappingQuotes(values.get("locator")), description: values.get("description") || undefined, metadata: {} }), "Context source created");
    }
    if (kind === "reviewResolve") {
      void runAction(() => sendJson(`/api/review-items/${review.id}/resolve`, "POST", { resolutionType: values.get("resolutionType"), resolutionReason: values.get("resolutionReason"), expectedRevision: review.revision }), "Review resolved");
    }
    if (kind === "reviewDismiss") {
      void runAction(() => sendJson(`/api/review-items/${review.id}/dismiss`, "POST", { resolutionReason: values.get("resolutionReason"), expectedRevision: review.revision }), "Review dismissed");
    }
  };

  if (!modal.kind) return null;
  const title = modal.kind === "project" ? "Add Project" : modal.kind === "session" ? "New Session" : modal.kind === "rule" ? "New Rule" : modal.kind === "source" ? "Add Context Source" : modal.kind === "contextItem" ? "Add Context Item" : modal.kind === "decision" ? "Record Decision" : modal.kind === "workItem" ? "Create Work Item" : modal.kind === "reviewResolve" ? "Resolve Review" : modal.kind === "reviewDismiss" ? "Dismiss Review" : modal.kind === "existingTranscript" ? "Import Existing Agent Session" : modal.kind === "resumeCapsule" ? "Edit Resume Capsule" : "Import Transcript";
  const submitLabel = modal.kind === "project" ? "Create Project" : modal.kind === "session" ? "Create Session" : modal.kind === "rule" ? "Create Rule" : modal.kind === "source" ? "Create Source" : modal.kind === "contextItem" ? "Create Context Item" : modal.kind === "decision" ? "Record Decision" : modal.kind === "workItem" ? "Create Item" : modal.kind === "reviewResolve" ? "Resolve" : modal.kind === "reviewDismiss" ? "Dismiss" : modal.kind === "existingTranscript" ? "Import Existing Session" : modal.kind === "resumeCapsule" ? "Save Capsule" : "Import Transcript";
  return (
    <div className="dialog-backdrop">
      <form className="dialog-form dialog-card" onSubmit={submit}>
        <div className="dialog-head"><h2>{title}</h2><button type="button" className="icon-btn" aria-label="Close" onClick={close}>{icon("close")}</button></div>
        <div className="dialog-fields">
          {modal.kind === "project" ? <><label>Project name<input className="field" name="name" required /></label><label>Root path<input className="field mono" name="rootPath" required placeholder="D:/project/my-workspace" /></label><label>Description<input className="field" name="description" /></label></> : null}
          {modal.kind === "session" ? <><label>Project<select name="projectId" defaultValue={defaultProjectId} required>{data.projects.map((item: AnyRecord) => <option value={item.id} key={item.id}>{item.name} · {item.rootPath}</option>)}</select></label><label>Title<input className="field" name="title" required defaultValue={`Session ${new Date().toLocaleString()}`} /></label><label>Intent<input className="field" name="intent" required placeholder="What should the agent help with?" /></label><label>Agent<select name="agentAdapterId" defaultValue={defaultAdapterId()}>{adapterList.map((adapter: AnyRecord) => <option value={adapter.id} disabled={!adapter.available} key={adapter.id}>{adapter.displayName}{adapter.available ? "" : " (unavailable)"}</option>)}</select></label></> : null}
          {modal.kind === "rule" ? <><label>Rule title<input className="field" name="title" required /></label><label>Description<input className="field" name="description" /></label><label>Enforcement<select name="enforcementMode" defaultValue="REQUIRE_REVIEW"><option>REQUIRE_REVIEW</option><option>BLOCK</option><option>WARNING</option><option>ADVISORY</option></select></label><label>Reason<input className="field" name="reason" required /></label></> : null}
          {modal.kind === "decision" ? <><label>Project<select name="projectId" defaultValue={defaultProjectId} required>{data.projects.map((item: AnyRecord) => <option value={item.id} key={item.id}>{item.name} · {item.rootPath}</option>)}</select></label><label>Title<input className="field" name="title" required placeholder="Adopt SQLite for local storage" /></label><label>Statement<textarea className="field" name="statement" required rows={3} placeholder="What decision is being made?" /></label><label>Rationale<textarea className="field" name="rationale" required rows={3} placeholder="Why is this the right choice now?" /></label><label>Problem context<input className="field" name="problemContext" /></label><label>Alternatives<textarea className="field" name="alternatives" rows={3} placeholder="One alternative per line" /></label><label>Consequences<textarea className="field" name="consequences" rows={3} /></label><label>References<textarea className="field" name="references" rows={2} placeholder="One reference per line" /></label></> : null}
          {modal.kind === "workItem" ? <><label>Project<select name="projectId" defaultValue={defaultProjectId} required>{data.projects.map((item: AnyRecord) => <option value={item.id} key={item.id}>{item.name} · {item.rootPath}</option>)}</select></label><label>Parent<select name="parentId" defaultValue=""><option value="">No parent</option>{data.workItems.map((item: AnyRecord) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label><label>Title<input className="field" name="title" required placeholder="Build review workflow UI" /></label><label>Description<textarea className="field" name="description" rows={3} /></label><label>Acceptance<textarea className="field" name="acceptance" rows={4} placeholder="One acceptance criterion per line" /></label><label>Execution contract<textarea className="field" name="executionContract" rows={3} placeholder="What must be true when this work is done?" /></label></> : null}
          {modal.kind === "contextItem" ? <><label>Project<select name="projectId" defaultValue={defaultProjectId} required>{data.projects.map((item: AnyRecord) => <option value={item.id} key={item.id}>{item.name} · {item.rootPath}</option>)}</select></label><label>Source evidence<select name="sourceSnapshotId" defaultValue=""><option value="">No source snapshot</option>{data.evidenceSnapshots.map((snapshot: AnyRecord) => <option value={snapshot.id} key={snapshot.id}>{snapshot.title}</option>)}</select></label><label>Type<select name="itemType" defaultValue="FACT"><option>FACT</option><option>SUMMARY</option><option>CONSTRAINT</option><option>OPEN_QUESTION</option><option>RISK</option><option>HANDOFF</option></select></label><label>Confidence<select name="confidence" defaultValue="MEDIUM"><option>LOW</option><option>MEDIUM</option><option>HIGH</option></select></label><label>Title<input className="field" name="title" required placeholder="Context item title" /></label><label>Summary<textarea className="field" name="summary" required rows={3} placeholder="Short reusable context statement" /></label><label>Body<textarea className="field" name="body" rows={5} placeholder="Details, rationale, constraints, or handoff notes" /></label></> : null}
          {modal.kind === "source" ? <><label>Project<input className="field" value={project?.name || ""} disabled /></label><label>Type<select name="sourceType" defaultValue="FILE"><option>FILE</option><option>DIRECTORY</option><option>URL</option><option>USER_NOTE</option><option>AGENT_OUTPUT</option></select></label><label>Name<input className="field" name="name" required placeholder="README, docs folder, design note..." /></label><label>Locator<input className="field mono" name="locator" required placeholder="README.md or docs/ or https://..." /></label><label>Description<input className="field" name="description" /></label></> : null}
          {modal.kind === "transcript" ? <><label>Session<input className="field mono" value={session?.title || session?.id || ""} disabled /></label><label>Title<input className="field" name="title" defaultValue="Imported transcript" /></label><label>Summary<input className="field" name="summary" placeholder="What should the resume capsule remember?" /></label><label>Transcript text<textarea className="field" name="contentText" required rows={9} placeholder="Paste Codex transcript or the important conversation excerpt" /></label></> : null}
          {modal.kind === "existingTranscript" ? <><label>ContextOS session<input className="field mono" value={session?.title || session?.id || ""} disabled /></label><label>External session ID<input className="field mono" name="externalSessionId" placeholder="01a0ade8-6848-7d91-a328-b7780587365e" /></label><label>Title<input className="field" name="title" defaultValue={`Imported ${session?.agentAdapterId || "agent"} transcript`} /></label><label>Summary<input className="field" name="summary" placeholder="What should the resume capsule remember?" /></label></> : null}
          {modal.kind === "resumeCapsule" ? <><label>Session<input className="field mono" value={session?.title || session?.id || ""} disabled /></label><label>Summary<textarea className="field" name="summary" required rows={4} defaultValue={resumeCapsule?.summary || ""} /></label><label>Next action<input className="field" name="nextAction" defaultValue={resumeCapsule?.nextAction || ""} placeholder="What should happen next?" /></label></> : null}
          {modal.kind === "reviewResolve" ? <><label>Review<input className="field" value={review?.summary || ""} disabled /></label><label>Resolution<select name="resolutionType" defaultValue="APPROVED"><option>APPROVED</option><option>FIXED</option><option>ACKNOWLEDGED</option></select></label><label>Reason<textarea className="field" name="resolutionReason" required rows={4} placeholder="What was checked or approved?" /></label></> : null}
          {modal.kind === "reviewDismiss" ? <><label>Review<input className="field" value={review?.summary || ""} disabled /></label><label>Reason<textarea className="field" name="resolutionReason" required rows={4} placeholder="Why is this no longer applicable?" /></label></> : null}
        </div>
        <div className="dialog-actions"><button type="button" className="btn" onClick={close}>Cancel</button><button type="submit" className="btn primary">{submitLabel}</button></div>
      </form>
    </div>
  );
}
