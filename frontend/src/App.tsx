import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";

const API_BASE = localStorage.getItem("contextos.apiBase") || "http://127.0.0.1:4721";

type AnyRecord = Record<string, any>;
type PageId = "overview" | "projects" | "sessions" | "review" | "decisions" | "work" | "context" | "rules" | "settings";
type ModalKind = null | "project" | "session" | "rule" | "transcript" | "existingTranscript" | "source";

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
  sessions: { title: "Sessions", subtitle: "Concrete agent work episodes with immutable evidence references.", actions: [["add", "New Session", "primary"], ["play_arrow", "Continue in Agent"], ["hub", "Import Existing Session"], ["upload_file", "Import Transcript"], ["download", "Export Capsule"]] },
  review: { title: "Review Inbox", subtitle: "Human decisions required before derived context or rules become active.", actions: [["rule", "Approve Selected", "primary"], ["close", "Reject"]] },
  decisions: { title: "Decisions", subtitle: "Durable choices, rationale, provenance, and version history.", actions: [["add", "Record Decision", "primary"], ["compare_arrows", "Compare Versions"]] },
  work: { title: "Work Items", subtitle: "Executable units of work with readiness signals and blocked dependencies.", actions: [["play_arrow", "Start Ready Item", "primary"], ["add_task", "Create Item"]] },
  context: { title: "Context", subtitle: "Governed sources, immutable evidence snapshots, and derived context items.", actions: [["add", "Add Source", "primary"], ["sync", "Sync Sources"], ["fact_check", "Review Derived Items"]] },
  rules: { title: "Rules", subtitle: "Versioned governance instructions controlling automated agent behavior.", actions: [["add", "New Rule", "primary"], ["history", "Version History"]] },
  settings: { title: "Settings", subtitle: "Configure how ContextOS runs, connects to agents, and handles work context.", actions: [["restart_alt", "Reset changes"], ["check", "Save changes", "primary"]], narrow: true }
};

const enabledActions = new Set(["refresh-context", "add-project", "new-session", "continue-in-agent", "import-existing-session", "import-transcript", "add-source", "sync-sources", "new-rule", "reset-changes", "save-changes"]);

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

function icon(name: string) {
  return <span className="material-symbols-outlined">{name}</span>;
}

function actionId(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function stripWrappingQuotes(value: FormDataEntryValue | null) {
  return String(value ?? "").trim().replace(/^["'](.+)["']$/, "$1");
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
    <table>
      <thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
    </table>
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
  const [sessionDetails, setSessionDetails] = useState<SessionDetails | null>(null);
  const [modal, setModal] = useState<{ kind: ModalKind; sessionId?: string }>({ kind: null });

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
    setData(next);
    setError(failures.length === entries.length ? "Daemon unavailable" : failures[0] || null);
    setSessionDetails(await loadSessionDetails(next.sessions[0]));
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

  const interruptSession = useCallback(async (sessionId: string) => {
    const session = sessionById(sessionId);
    if (!session) throw new Error("No session is available to interrupt");
    await sendJson(`/api/sessions/${session.id}/interrupt`, "POST", { expectedRevision: session.revision });
  }, [sessionById]);

  const syncSource = useCallback(async (sourceId: string) => {
    const source = sourceById(sourceId);
    if (!source) throw new Error("No context source is available to sync");
    await sendJson(`/api/context-sources/${source.id}/sync`, "POST", { expectedRevision: source.revision });
  }, [sourceById]);

  const syncActiveSources = useCallback(async () => {
    const sources = data.contextSources.filter((source) => source.status === "ACTIVE");
    if (!sources.length) throw new Error("No active context sources are available to sync");
    for (const source of sources) await syncSource(source.id);
  }, [data.contextSources, syncSource]);

  const verifyEvidence = useCallback((snapshotId: string) => sendJson(`/api/evidence-snapshots/${snapshotId}/verify`, "POST", {}), []);
  const validateRule = useCallback((ruleId: string) => sendJson(`/api/rules/${ruleId}/validate`, "POST", {}), []);
  const testRule = useCallback((ruleId: string) => sendJson(`/api/rules/${ruleId}/test`, "POST", { eventType: "session.continue", resourceType: "SESSION", data: {} }), []);
  const transitionRule = useCallback(async (ruleId: string, action: string) => {
    const rule = ruleById(ruleId);
    if (!rule) throw new Error("No rule is available");
    await sendJson(`/api/rules/${rule.id}/${action}`, "POST", { expectedRevision: rule.revision });
  }, [ruleById]);

  const handleAction = useCallback((action: string) => {
    if (action === "refresh-context" || action === "reset-changes") return void loadData();
    if (action === "add-project") return setModal({ kind: "project" });
    if (action === "new-session") return data.projects[0] ? setModal({ kind: "session" }) : setActionMessage({ text: "Create a project before starting a session", error: true });
    if (action === "new-rule") return data.projects[0] ? setModal({ kind: "rule" }) : setActionMessage({ text: "Create a project before adding rules", error: true });
    if (action === "add-source") return data.projects[0] ? setModal({ kind: "source" }) : setActionMessage({ text: "Create a project before adding context sources", error: true });
    if (action === "sync-sources") return void runAction(syncActiveSources, "Context sources synced");
    if (action === "continue-in-agent") {
      const session = data.sessions.find((item) => ["CREATED", "PAUSED", "FAILED", "COMPLETED"].includes(item.status));
      if (!session) return setActionMessage({ text: "Create a session before continuing in an agent", error: true });
      return void runAction(() => continueSession(session.id), "Session continued in Agent");
    }
    if (action === "import-transcript") {
      const session = data.sessions[0];
      if (!session) return setActionMessage({ text: "Create a session before importing a transcript", error: true });
      return setModal({ kind: "transcript", sessionId: session.id });
    }
    if (action === "import-existing-session") {
      const session = data.sessions[0];
      if (!session) return setActionMessage({ text: "Create a ContextOS session before importing an existing agent session", error: true });
      return setModal({ kind: "existingTranscript", sessionId: session.id });
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
  }, [continueSession, data.projects, data.sessions, data.settings, defaultAdapterId, loadData, runAction, syncActiveSources]);

  const navigate = (next: PageId) => {
    setPage(next);
    setActionMessage(null);
    location.hash = next;
  };

  const renderPage = () => {
    if (loading) return <><PageHeader pageDef={pages[page]} actionLoading={actionLoading} error={error} actionMessage={actionMessage} onAction={handleAction} /><EmptyNote>Loading workspace data...</EmptyNote></>;
    const props = { data, actionLoading, runAction, archiveProject, archiveSession, continueSession, importTranscriptAuto, interruptSession, syncSource, verifyEvidence, validateRule, testRule, transitionRule, setModal, defaultAdapterId, adapterList, sessionDetails };
    switch (page) {
      case "overview": return <OverviewPage data={data} header={<PageHeader pageDef={pages.overview} actionLoading={actionLoading} error={error} actionMessage={actionMessage} onAction={handleAction} />} />;
      case "projects": return <ProjectsPage {...props} header={<PageHeader pageDef={pages.projects} actionLoading={actionLoading} error={error} actionMessage={actionMessage} onAction={handleAction} />} />;
      case "sessions": return <SessionsPage {...props} header={<PageHeader pageDef={pages.sessions} actionLoading={actionLoading} error={error} actionMessage={actionMessage} onAction={handleAction} />} />;
      case "review": return <ReviewPage data={data} header={<PageHeader pageDef={pages.review} actionLoading={actionLoading} error={error} actionMessage={actionMessage} onAction={handleAction} />} />;
      case "decisions": return <DecisionsPage data={data} header={<PageHeader pageDef={pages.decisions} actionLoading={actionLoading} error={error} actionMessage={actionMessage} onAction={handleAction} />} />;
      case "work": return <WorkPage data={data} header={<PageHeader pageDef={pages.work} actionLoading={actionLoading} error={error} actionMessage={actionMessage} onAction={handleAction} />} />;
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
        runAction={runAction}
      />
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
  const { data, header, sessionDetails: details, actionLoading, runAction, archiveSession, continueSession, importTranscriptAuto, interruptSession, setModal } = props;
  const canContinue = (status: string) => ["CREATED", "PAUSED", "FAILED", "COMPLETED"].includes(status);
  const evidenceMeta = (item: AnyRecord) => [item.metadata?.adapterId ? `adapter ${item.metadata.adapterId}` : null, item.metadata?.externalSessionId ? `external ${item.metadata.externalSessionId}` : null, item.metadata?.parserVersion || null, item.metadata?.messageCount ? `${item.metadata.messageCount} messages` : null, item.metadata?.turnCount ? `${item.metadata.turnCount} turns` : null].filter(Boolean).join(" · ");
  return (
    <>{header}<div className="stack">
      <Panel title="Session Episodes" iconName="terminal"><Table headers={["Session", "Agent", "Started", "Updated", "Status", "Action"]} rows={data.sessions.map((session: AnyRecord) => [
        <><strong>{session.title || session.id}</strong><div className="muted">{session.intent || ""}</div></>,
        session.agentAdapterId,
        fmtDate(session.startedAt),
        fmtDate(session.updatedAt),
        <Badge text={session.status} tone={toneForStatus(session.status)} />,
        <div className="row-actions">
          <button className="icon-btn table-action" title="Continue in Agent" disabled={!canContinue(session.status) || actionLoading} onClick={() => runAction(() => continueSession(session.id), "Session continued in Agent")}>{icon("play_arrow")}</button>
          <button className="icon-btn table-action" title="Interrupt managed run" disabled={session.status !== "RUNNING" || actionLoading} onClick={() => runAction(() => interruptSession(session.id), "Session interrupted")}>{icon("stop_circle")}</button>
          <button className="icon-btn table-action" title="Import existing agent session" disabled={actionLoading} onClick={() => setModal({ kind: "existingTranscript", sessionId: session.id })}>{icon("manage_search")}</button>
          <button className="icon-btn table-action" title="Paste transcript" disabled={actionLoading} onClick={() => setModal({ kind: "transcript", sessionId: session.id })}>{icon("edit_note")}</button>
          <button className="icon-btn table-action" title="Archive session" disabled={session.status === "RUNNING" || actionLoading} onClick={() => runAction(() => archiveSession(session.id), "Session archived")}>{icon("archive")}</button>
        </div>
      ])} empty="No sessions yet." /></Panel>
      <Panel title="Latest Session Context" iconName="inventory_2" meta={details ? details.sessionId : "No session"}>
        {details ? <div className="detail-grid">
          <div><span className="mono muted">CONTEXT ITEMS</span><strong>{details.contextPack?.contextItems?.length ?? 0}</strong></div>
          <div><span className="mono muted">EVIDENCE</span><strong>{details.evidence.length}</strong></div>
          <div><span className="mono muted">RESUME STATUS</span><strong>{details.resumeCapsule?.status || "Not available"}</strong></div>
          <div className="detail-wide"><span className="mono muted">CONTEXT PACKAGE</span><strong>{details.contextPack?.id || "Not generated"}</strong></div>
          <div className="detail-wide"><span className="mono muted">EXTERNAL AGENT SESSION</span><strong>{data.sessions.find((session: AnyRecord) => session.id === details.sessionId)?.externalSessionId || "Not bound"}</strong></div>
          <div className="detail-wide"><span className="mono muted">RUNTIME</span><strong>{details.runtimeStatus?.run?.status || "No active run"}</strong><div className="muted mono">{details.runtimeStatus?.process ? `pid ${details.runtimeStatus.process.pid} · managed ${details.runtimeStatus.process.managed} · running ${details.runtimeStatus.process.running}` : "No managed process"}</div></div>
          <div className="detail-wide"><span className="mono muted">NEXT ACTION</span><strong>{details.resumeCapsule?.nextAction || "-"}</strong></div>
          {details.evidence.length ? <div className="detail-wide"><span className="mono muted">EVIDENCE SNAPSHOTS</span><div className="stack compact">{details.evidence.slice(0, 6).map((item: AnyRecord) => <div className="metric-row evidence-row" key={item.id}><div><div className="title-sm">{item.title}</div><div className="muted mono">{evidenceMeta(item) || item.storageRef || item.id}</div></div><Badge text={item.evidenceType} tone="blue" /></div>)}</div></div> : null}
        </div> : <EmptyNote>Continue a session to generate its context package and resume capsule.</EmptyNote>}
      </Panel>
    </div></>
  );
}

function ReviewPage({ data, header }: { data: WorkspaceData; header: ReactNode }) {
  return <>{header}<Panel title="Pending Review Items" iconName="inbox"><Rows rows={data.reviews.map((item) => [item.summary, item.priority, toneForStatus(item.status), `${item.sourceType} · ${item.status}`])} empty="No review items." /></Panel></>;
}

function DecisionsPage({ data, header }: { data: WorkspaceData; header: ReactNode }) {
  return <>{header}<Panel title="Decision Register" iconName="gavel"><Table headers={["ID", "Decision", "Version", "Updated", "State"]} rows={data.decisions.map((item) => [item.id, <strong>{item.title}</strong>, item.currentVersionId || "-", fmtDate(item.updatedAt), <Badge text={item.status} tone={toneForStatus(item.status)} />])} empty="No decisions yet." /></Panel></>;
}

function WorkPage({ data, header }: { data: WorkspaceData; header: ReactNode }) {
  return <>{header}<Panel title="Execution Readiness" iconName="task_alt"><Table headers={["Work item", "Parent", "Acceptance", "Updated", "Status"]} rows={data.workItems.map((item) => [<><strong>{item.title}</strong><div className="muted">{item.description || ""}</div></>, item.parentId || "-", `${item.acceptance?.length || 0}`, fmtDate(item.updatedAt), <Badge text={item.status} tone={toneForStatus(item.status)} />])} empty="No work items yet." /></Panel></>;
}

function ContextPage(props: AnyRecord & { header: ReactNode }) {
  const { data, header, actionLoading, runAction, syncSource, verifyEvidence } = props;
  return (
    <>{header}<div className="grid cols-12"><div className="span-8 stack">
      <Panel title="Sources" iconName="database"><Table headers={["Source", "Type", "Last sync", "Snapshots", "State", "Action"]} rows={data.contextSources.map((source: AnyRecord) => [<><strong>{source.name}</strong><div className="muted mono">{source.locator}</div></>, source.sourceType, fmtDate(source.lastCheckedAt), source.lastSnapshotId || "-", <Badge text={source.status} tone={toneForStatus(source.status)} />, <button className="icon-btn table-action" title="Sync source" disabled={source.status !== "ACTIVE" || actionLoading} onClick={() => runAction(() => syncSource(source.id), "Context source synced")}>{icon("sync")}</button>])} empty="No context sources yet." /></Panel>
      <Panel title="Evidence Snapshots" iconName="fact_check"><Table headers={["Evidence", "Type", "Captured", "Storage", "Action"]} rows={data.evidenceSnapshots.slice(0, 12).map((snapshot: AnyRecord) => [<><strong>{snapshot.title}</strong><div className="muted mono">{snapshot.contentHash || "-"}</div></>, <Badge text={snapshot.evidenceType} tone="blue" />, fmtDate(snapshot.capturedAt), <span className="mono">{snapshot.storageRef || "-"}</span>, <button className="icon-btn table-action" title="Verify evidence" disabled={actionLoading} onClick={() => runAction(() => verifyEvidence(snapshot.id), "Evidence verified")}>{icon("verified")}</button>])} empty="No evidence snapshots yet." /></Panel>
    </div><div className="span-4"><Panel title="Integrity Boundary" iconName="verified"><div className="metric-row"><span>Evidence snapshots</span><strong>{data.evidenceSnapshots.length}</strong></div><div className="metric-row"><span>Derived context items</span><strong>{data.contextItems.length}</strong></div><div className="metric-row"><span>Unlabeled derived items</span><strong>0</strong></div></Panel></div></div></>
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

function WorkspaceModal({ modal, setModal, data, defaultAdapterId, adapterList, runAction }: AnyRecord) {
  const project = data.projects[0];
  const session = modal.sessionId ? data.sessions.find((item: AnyRecord) => item.id === modal.sessionId) : data.sessions[0];
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
    if (kind === "source") {
      void runAction(() => sendJson("/api/context-sources", "POST", { projectId: project.id, sourceType: values.get("sourceType"), name: values.get("name"), locator: stripWrappingQuotes(values.get("locator")), description: values.get("description") || undefined, metadata: {} }), "Context source created");
    }
  };

  if (!modal.kind) return null;
  const title = modal.kind === "project" ? "Add Project" : modal.kind === "session" ? "New Session" : modal.kind === "rule" ? "New Rule" : modal.kind === "source" ? "Add Context Source" : modal.kind === "existingTranscript" ? "Import Existing Agent Session" : "Import Transcript";
  const submitLabel = modal.kind === "project" ? "Create Project" : modal.kind === "session" ? "Create Session" : modal.kind === "rule" ? "Create Rule" : modal.kind === "source" ? "Create Source" : modal.kind === "existingTranscript" ? "Import Existing Session" : "Import Transcript";
  return (
    <div className="dialog-backdrop">
      <form className="dialog-form dialog-card" onSubmit={submit}>
        <div className="dialog-head"><h2>{title}</h2><button type="button" className="icon-btn" aria-label="Close" onClick={close}>{icon("close")}</button></div>
        <div className="dialog-fields">
          {modal.kind === "project" ? <><label>Project name<input className="field" name="name" required /></label><label>Root path<input className="field mono" name="rootPath" required placeholder="D:/project/my-workspace" /></label><label>Description<input className="field" name="description" /></label></> : null}
          {modal.kind === "session" ? <><label>Project<select name="projectId" defaultValue={defaultProjectId} required>{data.projects.map((item: AnyRecord) => <option value={item.id} key={item.id}>{item.name} · {item.rootPath}</option>)}</select></label><label>Title<input className="field" name="title" required defaultValue={`Session ${new Date().toLocaleString()}`} /></label><label>Intent<input className="field" name="intent" required placeholder="What should the agent help with?" /></label><label>Agent<select name="agentAdapterId" defaultValue={defaultAdapterId()}>{adapterList.map((adapter: AnyRecord) => <option value={adapter.id} disabled={!adapter.available} key={adapter.id}>{adapter.displayName}{adapter.available ? "" : " (unavailable)"}</option>)}</select></label></> : null}
          {modal.kind === "rule" ? <><label>Rule title<input className="field" name="title" required /></label><label>Description<input className="field" name="description" /></label><label>Enforcement<select name="enforcementMode" defaultValue="REQUIRE_REVIEW"><option>REQUIRE_REVIEW</option><option>BLOCK</option><option>WARNING</option><option>ADVISORY</option></select></label><label>Reason<input className="field" name="reason" required /></label></> : null}
          {modal.kind === "source" ? <><label>Project<input className="field" value={project?.name || ""} disabled /></label><label>Type<select name="sourceType" defaultValue="FILE"><option>FILE</option><option>DIRECTORY</option><option>URL</option><option>USER_NOTE</option><option>AGENT_OUTPUT</option></select></label><label>Name<input className="field" name="name" required placeholder="README, docs folder, design note..." /></label><label>Locator<input className="field mono" name="locator" required placeholder="README.md or docs/ or https://..." /></label><label>Description<input className="field" name="description" /></label></> : null}
          {modal.kind === "transcript" ? <><label>Session<input className="field mono" value={session?.title || session?.id || ""} disabled /></label><label>Title<input className="field" name="title" defaultValue="Imported transcript" /></label><label>Summary<input className="field" name="summary" placeholder="What should the resume capsule remember?" /></label><label>Transcript text<textarea className="field" name="contentText" required rows={9} placeholder="Paste Codex transcript or the important conversation excerpt" /></label></> : null}
          {modal.kind === "existingTranscript" ? <><label>ContextOS session<input className="field mono" value={session?.title || session?.id || ""} disabled /></label><label>External session ID<input className="field mono" name="externalSessionId" placeholder="01a0ade8-6848-7d91-a328-b7780587365e" /></label><label>Title<input className="field" name="title" defaultValue={`Imported ${session?.agentAdapterId || "agent"} transcript`} /></label><label>Summary<input className="field" name="summary" placeholder="What should the resume capsule remember?" /></label></> : null}
        </div>
        <div className="dialog-actions"><button type="button" className="btn" onClick={close}>Cancel</button><button type="submit" className="btn primary">{submitLabel}</button></div>
      </form>
    </div>
  );
}
