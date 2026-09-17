const API_BASE = localStorage.getItem("contextos.apiBase") || "http://127.0.0.1:4721";

const navGroups = [
  { label: "Workspace", items: [
    ["overview", "dashboard", "Overview"],
    ["projects", "folder_open", "Projects"],
    ["sessions", "terminal", "Sessions"],
  ] },
  { label: "Governance", items: [
    ["review", "inbox", "Review Inbox"],
    ["decisions", "gavel", "Decisions"],
    ["work", "check_box", "Work Items"],
    ["context", "account_tree", "Context"],
  ] },
  { label: "System", items: [
    ["rules", "policy", "Rules"],
    ["settings", "settings", "Settings"],
  ] },
];

const pages = {
  overview: { title: "Overview", subtitle: "Workspace status, pending governance, and the next executable work.", actions: [["refresh", "Refresh Context"]] },
  projects: { title: "Projects", subtitle: "Governed workspace boundaries and their active context policies.", actions: [["create_new_folder", "Add Project", "primary"], ["tune", "Edit Defaults"]] },
  sessions: { title: "Sessions", subtitle: "Concrete agent work episodes with immutable evidence references.", actions: [["add", "New Session", "primary"], ["play_arrow", "Continue in Agent"], ["upload_file", "Import Transcript"], ["download", "Export Capsule"]] },
  review: { title: "Review Inbox", subtitle: "Human decisions required before derived context or rules become active.", actions: [["rule", "Approve Selected", "primary"], ["close", "Reject"]] },
  decisions: { title: "Decisions", subtitle: "Durable choices, rationale, provenance, and version history.", actions: [["add", "Record Decision", "primary"], ["compare_arrows", "Compare Versions"]] },
  work: { title: "Work Items", subtitle: "Executable units of work with readiness signals and blocked dependencies.", actions: [["play_arrow", "Start Ready Item", "primary"], ["add_task", "Create Item"]] },
  context: { title: "Context", subtitle: "Governed sources, immutable evidence snapshots, and derived context items.", actions: [["add", "Add Source", "primary"], ["sync", "Sync Sources"], ["fact_check", "Review Derived Items"]] },
  rules: { title: "Rules", subtitle: "Versioned governance instructions controlling automated agent behavior.", actions: [["add", "New Rule", "primary"], ["history", "Version History"]] },
  settings: { title: "Settings", subtitle: "Configure how ContextOS runs, connects to agents, and handles work context.", actions: [["restart_alt", "Reset changes"], ["check", "Save changes", "primary"]], narrow: true },
};

const state = {
  page: location.hash.replace("#", "") || "overview",
  loading: true,
  error: null,
  actionLoading: false,
  actionMessage: null,
  sessionDetails: null,
  data: emptyData()
};
if (!pages[state.page]) state.page = "overview";

function emptyData() {
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

async function fetchJson(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
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
    clearTimeout(timeout);
  }
}

function sendJson(path, method, payload) {
  return fetchJson(path, { method, body: JSON.stringify(payload) });
}

async function loadData() {
  state.loading = true;
  state.error = null;
  render();
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
  const entries = await Promise.all(Object.entries(requests).map(async ([key, promise]) => [key, await settle(promise)]));
  const next = emptyData();
  const failures = [];
  for (const [key, result] of entries) {
    if (result.ok) {
      next[key] = Array.isArray(result.value?.items) ? result.value.items : result.value;
    } else {
      failures.push(`${key}: ${result.error.message}`);
    }
  }
  state.data = next;
  state.error = failures.length === entries.length ? "Daemon unavailable" : failures[0] || null;
  state.sessionDetails = await loadSessionDetails(next.sessions[0]);
  state.loading = false;
  render();
}

async function loadSessionDetails(session) {
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
}

async function settle(promise) {
  try { return { ok: true, value: await promise }; }
  catch (error) { return { ok: false, error }; }
}

function icon(name) { return `<span class="material-symbols-outlined">${name}</span>`; }
function esc(value) { return String(value ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }
function stripWrappingQuotes(value) { return String(value ?? "").trim().replace(/^["'](.+)["']$/, "$1"); }
function badge(text, tone = "") { return `<span class="badge ${tone}">${esc(text)}</span>`; }
function actionId(label) { return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function availableAdapters() { return state.data.adapters.filter(adapter => adapter.available); }
function defaultAdapterId() {
  const configured = state.data.settings?.defaultAdapterId;
  const adapters = state.data.adapters;
  if (configured && adapters.some(adapter => adapter.id === configured)) return configured;
  return availableAdapters()[0]?.id || adapters[0]?.id || "codex";
}
function adapterOptions(selected = defaultAdapterId()) {
  const adapters = state.data.adapters.length ? state.data.adapters : [{ id: "codex", displayName: "Codex", available: true }];
  return adapters.map(adapter => `<option value="${esc(adapter.id)}" ${adapter.id === selected ? "selected" : ""} ${adapter.available ? "" : "disabled"}>${esc(adapter.displayName)}${adapter.available ? "" : " (unavailable)"}</option>`).join("");
}
const enabledActions = new Set(["refresh-context", "add-project", "new-session", "continue-in-agent", "import-transcript", "add-source", "sync-sources", "new-rule", "reset-changes", "save-changes"]);
function button([ic, label, kind]) {
  const id = actionId(label);
  const disabled = !enabledActions.has(id) || state.actionLoading;
  return `<button class="btn ${kind || ""}" data-action="${id}" ${disabled ? "disabled" : ""}>${icon(state.actionLoading && enabledActions.has(id) ? "progress_activity" : ic)}<span>${label}</span></button>`;
}
function fmtDate(value) { return value ? new Date(value).toLocaleString() : "-"; }
function toneForStatus(status) {
  if (["ACTIVE", "RUNNING", "READY", "SUCCEEDED", "DONE", "ACCEPTED", "RESOLVED", "VALID"].includes(status)) return "green";
  if (["OPEN", "DRAFT", "PROPOSED", "CREATED", "IN_PROGRESS", "IN_REVIEW"].includes(status)) return "blue";
  if (["BLOCKED", "PAUSED", "DISABLED", "STALE"].includes(status)) return "amber";
  if (["FAILED", "CANCELED", "ARCHIVED", "INVALID", "DISMISSED"].includes(status)) return "red";
  return "";
}

function shell() {
  const d = state.data;
  const adapterCount = d.adapters.length;
  const connected = d.adapters.filter(a => a.available).length;
  const daemonTitle = d.health ? "Daemon running" : state.loading ? "Checking daemon" : "Daemon offline";
  const daemonSub = d.health ? `${API_BASE.replace(/^https?:\/\//, "")}` : API_BASE.replace(/^https?:\/\//, "");
  return `
    <aside class="sidebar">
      <div>
        <div class="brand"><div class="brand-mark">${icon("terminal")}</div><div><div class="brand-title">ContextOS</div><div class="brand-sub mono">AGENT WORKSPACE</div></div></div>
        <div class="nav">
          ${navGroups.map(group => `<div class="nav-group"><div class="nav-label mono">${group.label}</div>${group.items.map(([id, ic, label]) => `
            <button class="nav-item ${state.page === id ? "active" : ""}" data-nav="${id}">
              <span class="nav-left">${icon(ic)}<span>${label}</span></span>${navCount(id)}
            </button>`).join("")}</div>`).join("")}
        </div>
      </div>
      <div class="daemon"><div class="daemon-main"><span class="dot"></span><div><div class="daemon-title">${daemonTitle}</div><div class="daemon-sub mono">${esc(daemonSub)}</div></div></div><button class="icon-btn" data-nav="settings" title="Settings">${icon("settings")}</button></div>
    </aside>
    <div class="shell">
      <header class="topbar">
        <div class="crumbs mono"><span>Workspace</span><span>/</span><span class="crumb-current">${pages[state.page].title}</span>${projectPill()}</div>
        <div class="top-actions">
          <div class="search">${icon("search")}<input placeholder="Search projects, sessions, decisions..." /></div>
          <div class="agent-pill mono"><span class="dot"></span><span>${connected} connected</span><span class="quiet">·</span><strong>${adapterCount} adapters available</strong></div>
          <button class="icon-btn" title="Refresh" data-action="refresh-context">${icon("refresh")}</button>
          <div class="identity"><div class="avatar">AD</div><div><strong>Adam</strong><div class="daemon-sub mono">Lead Architect</div></div></div>
        </div>
      </header>
      <main class="main"><div class="page ${pages[state.page].narrow ? "narrow" : ""}" id="view"></div></main>
    </div>`;
}

function navCount(id) {
  const counts = { review: state.data.reviews.length };
  return counts[id] ? `<span class="count mono">${counts[id]}</span>` : "";
}

function projectPill() {
  const project = state.data.projects[0];
  return project ? `<span class="project-pill">${icon("folder_managed")} ${esc(project.name)} (${esc(project.rootPath)})</span>` : `<span class="project-pill">${icon("folder_managed")} No project loaded</span>`;
}

function pageHeader(page) {
  const notice = state.error ? `<p class="lead">${esc(state.error)}. Showing available local data.</p>` : "";
  const actionNotice = state.actionMessage ? `<p class="action-notice ${state.actionMessage.error ? "error" : "success"}">${esc(state.actionMessage.text)}</p>` : "";
  return `<section class="page-head"><div><h1>${page.title}</h1><p class="lead">${page.subtitle}</p>${notice}${actionNotice}</div><div class="actions">${page.actions.map(button).join("")}</div></section>`;
}
function panel(title, ic, body, meta = "") { return `<section class="panel"><div class="panel-head"><div class="panel-title">${icon(ic)}${title}</div><div class="panel-meta mono">${esc(meta)}</div></div>${body}</section>`; }
function emptyNote(text) { return `<div class="empty-note">${esc(text)}</div>`; }
function rows(items, empty = "No items yet.") { return items.length ? `<div>${items.map(([title, status, tone, sub]) => `<div class="list-row"><div><div class="title-sm">${title}</div>${sub ? `<div class="muted">${sub}</div>` : ""}</div>${badge(status, tone)}</div>`).join("")}</div>` : emptyNote(empty); }
function table(headers, data, empty = "No records yet.") { return data.length ? `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${data.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>` : emptyNote(empty); }

function renderOverview() {
  const d = state.data;
  const activeProject = d.projects[0];
  const readyWork = d.workItems.filter(i => ["READY", "IN_PROGRESS"].includes(i.status));
  return `${pageHeader(pages.overview)}
    <div class="kpi-grid">${[
      [d.sessions.length, "Sessions indexed"], [d.decisions.length, "Decisions active"], [d.workItems.length, "Work items"], [d.reviews.length, "Review required"]
    ].map(([v, l]) => `<div class="kpi"><div class="kpi-value">${v}</div><div class="kpi-label mono">${l}</div></div>`).join("")}</div>
    <div class="grid cols-12" style="margin-top:16px"><div class="span-8 stack">
      ${panel("Current Project", "folder_open", activeProject ? `<div class="pad stack"><div class="split"><div><div class="title-sm">${esc(activeProject.name)}</div><div class="muted">${esc(activeProject.description || "Agent workspace governance")}</div></div>${badge(activeProject.status, toneForStatus(activeProject.status))}</div><div class="progress"><span style="width:72%"></span></div><div class="split mono muted"><span>Boundary: ${esc(activeProject.rootPath)}</span><span>Revision: ${activeProject.revision}</span></div></div>` : emptyNote("Create a project to start using ContextOS."))}
      ${panel("Next Work Items", "task_alt", rows(readyWork.slice(0, 4).map(item => [esc(item.title), item.status, toneForStatus(item.status), esc(item.description || "")]), "No ready work items."), `${readyWork.length} ready signals`)}
    </div><div class="span-4 stack">
      ${panel("Governance Queue", "inbox", rows(d.reviews.slice(0, 4).map(item => [esc(item.summary), item.status, toneForStatus(item.status), esc(item.proposedResolution || "")]), "No pending review items."))}
      ${panel("Linked Activity", "link", `<div class="metric-row"><span>Sessions</span><strong>${d.sessions.length}</strong></div><div class="metric-row"><span>Decisions</span><strong>${d.decisions.length}</strong></div><div class="metric-row"><span>Context Items</span><strong>${d.contextItems.length}</strong></div>`)}
    </div></div>`;
}

function renderProjects() {
  return `${pageHeader(pages.projects)}${panel("Project Register", "folder_open", table(["Project", "Boundary", "Rules", "Health", "Activity"], state.data.projects.map(project => [`<strong>${esc(project.name)}</strong><div class='muted'>${esc(project.description || "Agent workspace")}</div>`, `<span class='mono'>${esc(project.rootPath)}</span>`, badge(`${project.defaultRuleIds?.length || 0} defaults`, "blue"), badge(project.status, toneForStatus(project.status)), `rev ${project.revision}`]), "No projects yet."))}`;
}

function renderSessions() {
  const details = state.sessionDetails;
  const canContinue = status => ["CREATED", "PAUSED", "FAILED", "COMPLETED"].includes(status);
  const evidenceMeta = item => [
    item.metadata?.adapterId ? `adapter ${item.metadata.adapterId}` : null,
    item.metadata?.externalSessionId ? `external ${item.metadata.externalSessionId}` : null,
    item.metadata?.parserVersion ? item.metadata.parserVersion : null,
    item.metadata?.messageCount ? `${item.metadata.messageCount} messages` : null,
    item.metadata?.turnCount ? `${item.metadata.turnCount} turns` : null
  ].filter(Boolean).join(" · ");
  const evidenceList = details?.evidence.length
    ? `<div class="detail-wide"><span class="mono muted">EVIDENCE SNAPSHOTS</span><div class="stack compact">${details.evidence.slice(0, 6).map(item => `<div class="metric-row evidence-row"><div><div class="title-sm">${esc(item.title)}</div><div class="muted mono">${esc(evidenceMeta(item) || item.storageRef || item.id)}</div></div>${badge(item.evidenceType, "blue")}</div>`).join("")}</div></div>`
    : "";
  const detailBody = details ? `<div class="detail-grid">
    <div><span class="mono muted">CONTEXT ITEMS</span><strong>${details.contextPack?.contextItems?.length ?? 0}</strong></div>
    <div><span class="mono muted">EVIDENCE</span><strong>${details.evidence.length}</strong></div>
    <div><span class="mono muted">RESUME STATUS</span><strong>${esc(details.resumeCapsule?.status || "Not available")}</strong></div>
    <div class="detail-wide"><span class="mono muted">CONTEXT PACKAGE</span><strong>${esc(details.contextPack?.id || "Not generated")}</strong></div>
    <div class="detail-wide"><span class="mono muted">RUNTIME</span><strong>${esc(details.runtimeStatus?.run?.status || "No active run")}</strong><div class="muted mono">${details.runtimeStatus?.process ? `pid ${details.runtimeStatus.process.pid} · managed ${details.runtimeStatus.process.managed} · running ${details.runtimeStatus.process.running}` : "No managed process"}</div></div>
    <div class="detail-wide"><span class="mono muted">NEXT ACTION</span><strong>${esc(details.resumeCapsule?.nextAction || "-")}</strong></div>
    ${evidenceList}
  </div>` : emptyNote("Continue a session to generate its context package and resume capsule.");
  return `${pageHeader(pages.sessions)}<div class="stack">
    ${panel("Session Episodes", "terminal", table(["Session", "Agent", "Started", "Updated", "Status", "Action"], state.data.sessions.map(session => [
      `<strong>${esc(session.title || session.id)}</strong><div class='muted'>${esc(session.intent || "")}</div>`,
      esc(session.agentAdapterId), fmtDate(session.startedAt), fmtDate(session.updatedAt), badge(session.status, toneForStatus(session.status)),
      `<div class="row-actions"><button class="icon-btn table-action" data-session-continue="${esc(session.id)}" title="Continue in Agent" ${canContinue(session.status) && !state.actionLoading ? "" : "disabled"}>${icon("play_arrow")}</button><button class="icon-btn table-action" data-session-interrupt="${esc(session.id)}" title="Interrupt managed run" ${session.status === "RUNNING" && !state.actionLoading ? "" : "disabled"}>${icon("stop_circle")}</button><button class="icon-btn table-action" data-session-import-auto="${esc(session.id)}" title="Auto import transcript" ${state.actionLoading ? "disabled" : ""}>${icon("manage_search")}</button><button class="icon-btn table-action" data-session-import-manual="${esc(session.id)}" title="Paste transcript" ${state.actionLoading ? "disabled" : ""}>${icon("edit_note")}</button></div>`
    ]), "No sessions yet."))}
    ${panel("Latest Session Context", "inventory_2", detailBody, details ? details.sessionId : "No session")}
  </div>`;
}

function renderReview() { return `${pageHeader(pages.review)}${panel("Pending Review Items", "inbox", rows(state.data.reviews.map(item => [esc(item.summary), item.priority, toneForStatus(item.status), `${esc(item.sourceType)} · ${esc(item.status)}`]), "No review items."))}`; }
function renderDecisions() { return `${pageHeader(pages.decisions)}${panel("Decision Register", "gavel", table(["ID", "Decision", "Version", "Updated", "State"], state.data.decisions.map(item => [esc(item.id), `<strong>${esc(item.title)}</strong>`, esc(item.currentVersionId || "-"), fmtDate(item.updatedAt), badge(item.status, toneForStatus(item.status))]), "No decisions yet."))}`; }
function renderWork() { return `${pageHeader(pages.work)}${panel("Execution Readiness", "task_alt", table(["Work item", "Parent", "Acceptance", "Updated", "Status"], state.data.workItems.map(item => [`<strong>${esc(item.title)}</strong><div class='muted'>${esc(item.description || "")}</div>`, esc(item.parentId || "-"), `${item.acceptance?.length || 0}`, fmtDate(item.updatedAt), badge(item.status, toneForStatus(item.status))]), "No work items yet."))}`; }

function renderContext() {
  const d = state.data;
  return `${pageHeader(pages.context)}<div class="grid cols-12"><div class="span-8 stack">
    ${panel("Sources", "database", table(["Source", "Type", "Last sync", "Snapshots", "State", "Action"], d.contextSources.map(source => [`<strong>${esc(source.name)}</strong><div class='muted mono'>${esc(source.locator)}</div>`, esc(source.sourceType), fmtDate(source.lastCheckedAt), esc(source.lastSnapshotId || "-"), badge(source.status, toneForStatus(source.status)), `<button class="icon-btn table-action" data-source-sync="${esc(source.id)}" title="Sync source" ${source.status === "ACTIVE" && !state.actionLoading ? "" : "disabled"}>${icon("sync")}</button>`]), "No context sources yet."))}
    ${panel("Evidence Snapshots", "fact_check", table(["Evidence", "Type", "Captured", "Storage", "Action"], d.evidenceSnapshots.slice(0, 12).map(snapshot => [`<strong>${esc(snapshot.title)}</strong><div class='muted mono'>${esc(snapshot.contentHash || "-")}</div>`, badge(snapshot.evidenceType, "blue"), fmtDate(snapshot.capturedAt), `<span class='mono'>${esc(snapshot.storageRef || "-")}</span>`, `<button class="icon-btn table-action" data-evidence-verify="${esc(snapshot.id)}" title="Verify evidence" ${state.actionLoading ? "disabled" : ""}>${icon("verified")}</button>`]), "No evidence snapshots yet."))}
  </div><div class="span-4">${panel("Integrity Boundary", "verified", `<div class="metric-row"><span>Evidence snapshots</span><strong>${d.evidenceSnapshots.length}</strong></div><div class="metric-row"><span>Derived context items</span><strong>${d.contextItems.length}</strong></div><div class="metric-row"><span>Unlabeled derived items</span><strong>0</strong></div>`)}</div></div>`;
}

function renderRules() { return `${pageHeader(pages.rules)}${panel("Active Rule Set", "policy", rows(state.data.rules.map(rule => [esc(rule.title), rule.status, toneForStatus(rule.status), esc(rule.description || `version ${rule.currentVersionId || "-"}`)]), "No rules yet."), state.data.projects[0]?.name || "Workspace")}`; }

function renderSettings() {
  const settings = state.data.settings;
  const adapters = state.data.adapters;
  const connected = adapters.filter(a => a.available).length;
  return `${pageHeader(pages.settings)}<div class="stack">
    ${panel("General", "tune", settings ? `<div class="setting-row"><div><div class="title-sm">Default adapter</div><div class="muted">Adapter used when a session does not specify one.</div></div><select id="setting-default-adapter">${adapterOptions(defaultAdapterId())}</select></div><div class="setting-row"><div><div class="title-sm">Review gate</div><div class="muted">Require confirmation before destructive actions.</div></div><label class="toggle"><input id="setting-confirm-destructive" type="checkbox" ${settings.confirmDestructiveActions ? "checked" : ""} /><span>${settings.confirmDestructiveActions ? "Enabled" : "Disabled"}</span></label></div><div class="setting-row"><div><div class="title-sm">Launch at startup</div><div class="muted">Start the local daemon with the desktop session.</div></div><label class="toggle"><input id="setting-launch-startup" type="checkbox" ${settings.launchAtStartup ? "checked" : ""} /><span>${settings.launchAtStartup ? "Enabled" : "Disabled"}</span></label></div><div class="setting-row"><div><div class="title-sm">Data directory</div><div class="muted mono">${esc(settings.dataDirectory)}</div></div>${badge(`rev ${settings.revision}`)}</div>` : emptyNote("Settings unavailable."), "Workspace & Defaults")}
    ${panel("Agent Adapters", "smart_toy", `<div class="setting-row"><div><div class="title-sm">Connected adapters</div><div class="muted">Codex and Claude Code are attached when discovery succeeds.</div></div>${badge(`${connected} connected`, connected ? "green" : "amber")}</div>${adapters.map(adapter => `<div class="setting-row"><div><div class="title-sm">${esc(adapter.displayName)}</div><div class="muted mono">${esc(adapter.version || adapter.error || adapter.command)}</div></div>${badge(adapter.available ? "Available" : "Unavailable", adapter.available ? "green" : "red")}</div>`).join("") || emptyNote("No adapters discovered.")}`)}
    ${panel("Storage & Privacy", "lock", `<div class="setting-row"><div><div class="title-sm">Evidence retention</div><div class="muted">Keep immutable source snapshots unless explicitly archived.</div></div>${badge("Retain indefinitely")}</div><div class="setting-row"><div><div class="title-sm">Secret redaction</div><div class="muted">Scrub credentials before indexing source material.</div></div>${badge("Enabled", "green")}</div><div class="setting-row"><div><div class="title-sm">Bridge mode</div><div class="muted">Local CLI and IPC integration for desktop agents.</div></div>${badge("CLI / IPC bridge", "blue")}</div>`)}
  </div>`;
}

const renderers = { overview: renderOverview, projects: renderProjects, sessions: renderSessions, review: renderReview, decisions: renderDecisions, work: renderWork, context: renderContext, rules: renderRules, settings: renderSettings };

async function runAction(task, successMessage) {
  state.actionLoading = true;
  state.actionMessage = null;
  render();
  try {
    await task();
    state.actionLoading = false;
    state.actionMessage = { text: successMessage, error: false };
    await loadData();
  } catch (error) {
    state.actionLoading = false;
    state.actionMessage = { text: error instanceof Error ? error.message : "Action failed", error: true };
    render();
  }
}

async function continueSession(sessionId) {
  const session = state.data.sessions.find(item => item.id === sessionId);
  if (!session) throw new Error("No session is available to continue");
  await sendJson(`/api/sessions/${session.id}/continue`, "POST", { expectedRevision: session.revision });
  setTimeout(loadData, 500);
}

function sessionById(sessionId) {
  return state.data.sessions.find(item => item.id === sessionId);
}

async function importTranscriptAuto(sessionId) {
  const session = sessionById(sessionId);
  if (!session) throw new Error("No session is available for transcript import");
  await sendJson(`/api/sessions/${session.id}/import-transcript/auto`, "POST", {});
}

async function interruptSession(sessionId) {
  const session = sessionById(sessionId);
  if (!session) throw new Error("No session is available to interrupt");
  await sendJson(`/api/sessions/${session.id}/interrupt`, "POST", { expectedRevision: session.revision });
}

function sourceById(sourceId) {
  return state.data.contextSources.find(item => item.id === sourceId);
}

async function syncSource(sourceId) {
  const source = sourceById(sourceId);
  if (!source) throw new Error("No context source is available to sync");
  await sendJson(`/api/context-sources/${source.id}/sync`, "POST", { expectedRevision: source.revision });
}

async function syncActiveSources() {
  const sources = state.data.contextSources.filter(source => source.status === "ACTIVE");
  if (!sources.length) throw new Error("No active context sources are available to sync");
  for (const source of sources) await syncSource(source.id);
}

async function verifyEvidence(snapshotId) {
  await sendJson(`/api/evidence-snapshots/${snapshotId}/verify`, "POST", {});
}

function openTranscriptDialog(sessionId) {
  const session = sessionById(sessionId);
  if (!session) {
    state.actionMessage = { text: "Create a session before importing a transcript", error: true };
    render();
    return;
  }
  openFormDialog({
    title: "Import Transcript",
    submitLabel: "Import Transcript",
    fields: `
      <label>Session<input class="field mono" value="${esc(session.title || session.id)}" disabled /></label>
      <label>Title<input class="field" name="title" value="Imported transcript" /></label>
      <label>Summary<input class="field" name="summary" placeholder="What should the resume capsule remember?" /></label>
      <label>Transcript text<textarea class="field" name="contentText" required rows="9" placeholder="Paste Codex transcript or the important conversation excerpt"></textarea></label>`,
    onSubmit: values => runAction(() => sendJson(`/api/sessions/${session.id}/import-transcript`, "POST", {
      contentText: values.get("contentText"),
      title: values.get("title") || undefined,
      summary: values.get("summary") || undefined
    }), "Transcript imported")
  });
}

function openProjectDialog() {
  const adapterIds = (availableAdapters().length ? availableAdapters() : state.data.adapters).map(adapter => adapter.id);
  openFormDialog({
    title: "Add Project",
    submitLabel: "Create Project",
    fields: `
      <label>Project name<input class="field" name="name" required /></label>
      <label>Root path<input class="field mono" name="rootPath" required placeholder="D:/project/my-workspace" /></label>
      <label>Description<input class="field" name="description" /></label>`,
    onSubmit: values => runAction(() => sendJson("/api/projects", "POST", {
      name: values.get("name"),
      rootPath: stripWrappingQuotes(values.get("rootPath")),
      description: values.get("description") || undefined,
      defaultRuleIds: [],
      agentAdapterIds: adapterIds.length ? adapterIds : ["codex"]
    }), "Project created")
  });
}

function openSessionDialog() {
  const project = state.data.projects[0];
  if (!project) {
    state.actionMessage = { text: "Create a project before starting a session", error: true };
    render();
    return;
  }
  const defaultTitle = `Session ${new Date().toLocaleString()}`;
  openFormDialog({
    title: "New Session",
    submitLabel: "Create Session",
    fields: `
      <label>Project<input class="field" value="${esc(project.name)}" disabled /></label>
      <label>Title<input class="field" name="title" required value="${esc(defaultTitle)}" /></label>
      <label>Intent<input class="field" name="intent" required placeholder="What should the agent help with?" /></label>
      <label>Agent<select name="agentAdapterId">${adapterOptions(defaultAdapterId())}</select></label>`,
    onSubmit: values => runAction(async () => {
      state.page = "sessions";
      location.hash = "sessions";
      await sendJson("/api/sessions", "POST", {
        projectId: project.id,
        agentAdapterId: values.get("agentAdapterId") || defaultAdapterId(),
        title: values.get("title"),
        intent: values.get("intent")
      });
    }, "Session created")
  });
}

function openRuleDialog() {
  const project = state.data.projects[0];
  if (!project) {
    state.actionMessage = { text: "Create a project before adding rules", error: true };
    render();
    return;
  }
  openFormDialog({
    title: "New Rule",
    submitLabel: "Create Rule",
    fields: `
      <label>Rule title<input class="field" name="title" required /></label>
      <label>Description<input class="field" name="description" /></label>
      <label>Enforcement<select name="enforcementMode"><option>REQUIRE_REVIEW</option><option>BLOCK</option><option>WARNING</option><option>ADVISORY</option></select></label>
      <label>Reason<input class="field" name="reason" required /></label>`,
    onSubmit: values => runAction(() => sendJson("/api/rules", "POST", {
      projectId: project.id,
      title: values.get("title"),
      description: values.get("description") || undefined,
      scope: { eventTypes: ["session.continue"] },
      conditions: [],
      effect: { reason: values.get("reason") },
      enforcementMode: values.get("enforcementMode"),
      precedence: 100,
      exceptions: []
    }), "Rule draft created")
  });
}

function openContextSourceDialog() {
  const project = state.data.projects[0];
  if (!project) {
    state.actionMessage = { text: "Create a project before adding context sources", error: true };
    render();
    return;
  }
  openFormDialog({
    title: "Add Context Source",
    submitLabel: "Create Source",
    fields: `
      <label>Project<input class="field" value="${esc(project.name)}" disabled /></label>
      <label>Type<select name="sourceType"><option>FILE</option><option>DIRECTORY</option><option>URL</option><option>USER_NOTE</option><option>AGENT_OUTPUT</option></select></label>
      <label>Name<input class="field" name="name" required placeholder="README, docs folder, design note..." /></label>
      <label>Locator<input class="field mono" name="locator" required placeholder="README.md or docs/ or https://..." /></label>
      <label>Description<input class="field" name="description" /></label>`,
    onSubmit: values => runAction(async () => {
      state.page = "context";
      location.hash = "context";
      await sendJson("/api/context-sources", "POST", {
        projectId: project.id,
        sourceType: values.get("sourceType"),
        name: values.get("name"),
        locator: stripWrappingQuotes(values.get("locator")),
        description: values.get("description") || undefined,
        metadata: {}
      });
    }, "Context source created")
  });
}

function openFormDialog({ title, submitLabel, fields, onSubmit }) {
  document.getElementById("form-dialog")?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "form-dialog";
  dialog.innerHTML = `<form method="dialog" class="dialog-form"><div class="dialog-head"><h2>${esc(title)}</h2><button class="icon-btn" value="cancel" aria-label="Close">${icon("close")}</button></div><div class="dialog-fields">${fields}</div><div class="dialog-actions"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="default" data-submit>${esc(submitLabel)}</button></div></form>`;
  document.body.appendChild(dialog);
  dialog.querySelector("form").addEventListener("submit", event => {
    if (event.submitter?.dataset.submit === undefined) return;
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    dialog.close();
    dialog.remove();
    onSubmit(values);
  });
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
}

function handleAction(action) {
  if (action === "refresh-context" || action === "reset-changes") return loadData();
  if (action === "add-project") return openProjectDialog();
  if (action === "new-session") return openSessionDialog();
  if (action === "new-rule") return openRuleDialog();
  if (action === "add-source") return openContextSourceDialog();
  if (action === "sync-sources") return runAction(syncActiveSources, "Context sources synced");
  if (action === "continue-in-agent") {
    const session = state.data.sessions.find(item => ["CREATED", "PAUSED", "FAILED", "COMPLETED"].includes(item.status));
    if (!session) {
      state.actionMessage = { text: "Create a session before continuing in an agent", error: true };
      render();
      return;
    }
    return runAction(() => continueSession(session?.id), "Session continued in Agent");
  }
  if (action === "import-transcript") {
    const session = state.data.sessions[0];
    if (!session) {
      state.actionMessage = { text: "Create a session before importing a transcript", error: true };
      render();
      return;
    }
    return openTranscriptDialog(session.id);
  }
  if (action === "save-changes") {
    const settings = state.data.settings;
    if (!settings) return;
    const payload = {
      defaultAdapterId: document.getElementById("setting-default-adapter")?.value || defaultAdapterId(),
      confirmDestructiveActions: Boolean(document.getElementById("setting-confirm-destructive")?.checked),
      launchAtStartup: Boolean(document.getElementById("setting-launch-startup")?.checked),
      expectedRevision: settings.revision
    };
    return runAction(() => sendJson("/api/settings", "PATCH", payload), "Settings saved");
  }
}

function render() {
  document.getElementById("app").innerHTML = shell();
  document.getElementById("view").innerHTML = state.loading ? `${pageHeader(pages[state.page])}${emptyNote("Loading workspace data...")}` : renderers[state.page]();
  document.querySelectorAll("[data-nav]").forEach(btn => btn.addEventListener("click", () => { state.page = btn.dataset.nav; state.actionMessage = null; location.hash = state.page; render(); }));
  document.querySelectorAll("[data-action]").forEach(btn => btn.addEventListener("click", () => handleAction(btn.dataset.action)));
  document.querySelectorAll("[data-session-continue]").forEach(btn => btn.addEventListener("click", () => runAction(() => continueSession(btn.dataset.sessionContinue), "Session continued in Agent")));
  document.querySelectorAll("[data-session-interrupt]").forEach(btn => btn.addEventListener("click", () => runAction(() => interruptSession(btn.dataset.sessionInterrupt), "Session interrupted")));
  document.querySelectorAll("[data-session-import-auto]").forEach(btn => btn.addEventListener("click", () => runAction(() => importTranscriptAuto(btn.dataset.sessionImportAuto), "Transcript auto-imported")));
  document.querySelectorAll("[data-session-import-manual]").forEach(btn => btn.addEventListener("click", () => openTranscriptDialog(btn.dataset.sessionImportManual)));
  document.querySelectorAll("[data-source-sync]").forEach(btn => btn.addEventListener("click", () => runAction(() => syncSource(btn.dataset.sourceSync), "Context source synced")));
  document.querySelectorAll("[data-evidence-verify]").forEach(btn => btn.addEventListener("click", () => runAction(() => verifyEvidence(btn.dataset.evidenceVerify), "Evidence verified")));
}

window.addEventListener("hashchange", () => {
  const next = location.hash.replace("#", "");
  if (pages[next] && next !== state.page) { state.page = next; render(); }
});

render();
loadData();
