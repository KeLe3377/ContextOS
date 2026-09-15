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
  sessions: { title: "Sessions", subtitle: "Concrete agent work episodes with immutable evidence references.", actions: [["play_arrow", "Resume Session", "primary"], ["download", "Export Capsule"]] },
  review: { title: "Review Inbox", subtitle: "Human decisions required before derived context or rules become active.", actions: [["rule", "Approve Selected", "primary"], ["close", "Reject"]] },
  decisions: { title: "Decisions", subtitle: "Durable choices, rationale, provenance, and version history.", actions: [["add", "Record Decision", "primary"], ["compare_arrows", "Compare Versions"]] },
  work: { title: "Work Items", subtitle: "Executable units of work with readiness signals and blocked dependencies.", actions: [["play_arrow", "Start Ready Item", "primary"], ["add_task", "Create Item"]] },
  context: { title: "Context", subtitle: "Governed sources, immutable evidence snapshots, and derived context items.", actions: [["sync", "Sync Sources", "primary"], ["fact_check", "Review Derived Items"]] },
  rules: { title: "Rules", subtitle: "Versioned governance instructions controlling automated agent behavior.", actions: [["add", "New Rule", "primary"], ["history", "Version History"]] },
  settings: { title: "Settings", subtitle: "Configure how ContextOS runs, connects to agents, and handles work context.", actions: [["restart_alt", "Reset changes"], ["check", "Save changes", "primary"]], narrow: true },
};

const state = {
  page: location.hash.replace("#", "") || "overview",
  loading: true,
  error: null,
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

async function fetchJson(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`${API_BASE}${path}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
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
  state.loading = false;
  render();
}

async function settle(promise) {
  try { return { ok: true, value: await promise }; }
  catch (error) { return { ok: false, error }; }
}

function icon(name) { return `<span class="material-symbols-outlined">${name}</span>`; }
function esc(value) { return String(value ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }
function badge(text, tone = "") { return `<span class="badge ${tone}">${esc(text)}</span>`; }
function actionId(label) { return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function button([ic, label, kind]) { return `<button class="btn ${kind || ""}" data-action="${actionId(label)}">${icon(ic)}<span>${label}</span></button>`; }
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
  return `<section class="page-head"><div><h1>${page.title}</h1><p class="lead">${page.subtitle}</p>${notice}</div><div class="actions">${page.actions.map(button).join("")}</div></section>`;
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
  return `${pageHeader(pages.sessions)}${panel("Session Episodes", "terminal", table(["Session", "Agent", "Started", "Updated", "Status"], state.data.sessions.map(session => [`<strong>${esc(session.title || session.id)}</strong><div class='muted'>${esc(session.intent || "")}</div>`, esc(session.agentAdapterId), fmtDate(session.startedAt), fmtDate(session.updatedAt), badge(session.status, toneForStatus(session.status))]), "No sessions yet."))}`;
}

function renderReview() { return `${pageHeader(pages.review)}${panel("Pending Review Items", "inbox", rows(state.data.reviews.map(item => [esc(item.summary), item.priority, toneForStatus(item.status), `${esc(item.sourceType)} · ${esc(item.status)}`]), "No review items."))}`; }
function renderDecisions() { return `${pageHeader(pages.decisions)}${panel("Decision Register", "gavel", table(["ID", "Decision", "Version", "Updated", "State"], state.data.decisions.map(item => [esc(item.id), `<strong>${esc(item.title)}</strong>`, esc(item.currentVersionId || "-"), fmtDate(item.updatedAt), badge(item.status, toneForStatus(item.status))]), "No decisions yet."))}`; }
function renderWork() { return `${pageHeader(pages.work)}${panel("Execution Readiness", "task_alt", table(["Work item", "Parent", "Acceptance", "Updated", "Status"], state.data.workItems.map(item => [`<strong>${esc(item.title)}</strong><div class='muted'>${esc(item.description || "")}</div>`, esc(item.parentId || "-"), `${item.acceptance?.length || 0}`, fmtDate(item.updatedAt), badge(item.status, toneForStatus(item.status))]), "No work items yet."))}`; }

function renderContext() {
  const d = state.data;
  return `${pageHeader(pages.context)}<div class="grid cols-12"><div class="span-8">${panel("Sources", "database", table(["Source", "Type", "Last sync", "Snapshots", "State"], d.contextSources.map(source => [`<strong>${esc(source.name)}</strong><div class='muted mono'>${esc(source.locator)}</div>`, esc(source.sourceType), fmtDate(source.lastCheckedAt), esc(source.lastSnapshotId || "-"), badge(source.status, toneForStatus(source.status))]), "No context sources yet."))}</div><div class="span-4">${panel("Integrity Boundary", "verified", `<div class="metric-row"><span>Evidence snapshots</span><strong>${d.evidenceSnapshots.length}</strong></div><div class="metric-row"><span>Derived context items</span><strong>${d.contextItems.length}</strong></div><div class="metric-row"><span>Unlabeled derived items</span><strong>0</strong></div>`)}</div></div>`;
}

function renderRules() { return `${pageHeader(pages.rules)}${panel("Active Rule Set", "policy", rows(state.data.rules.map(rule => [esc(rule.title), rule.status, toneForStatus(rule.status), esc(rule.description || `version ${rule.currentVersionId || "-"}`)]), "No rules yet."), state.data.projects[0]?.name || "Workspace")}`; }

function renderSettings() {
  const settings = state.data.settings;
  const adapters = state.data.adapters;
  const connected = adapters.filter(a => a.available).length;
  return `${pageHeader(pages.settings)}<div class="stack">
    ${panel("General", "tune", settings ? `<div class="setting-row"><div><div class="title-sm">Default adapter</div><div class="muted">Adapter used when a session does not specify one.</div></div>${badge(settings.defaultAdapterId || "codex", "blue")}</div><div class="setting-row"><div><div class="title-sm">Review gate</div><div class="muted">Require confirmation before destructive actions.</div></div>${badge(settings.confirmDestructiveActions ? "Enabled" : "Disabled", settings.confirmDestructiveActions ? "green" : "amber")}</div><div class="setting-row"><div><div class="title-sm">Data directory</div><div class="muted mono">${esc(settings.dataDirectory)}</div></div>${badge(`rev ${settings.revision}`)}</div>` : emptyNote("Settings unavailable."), "Workspace & Defaults")}
    ${panel("Agent Adapters", "smart_toy", `<div class="setting-row"><div><div class="title-sm">Connected adapter</div><div class="muted">Codex is attached when discovery succeeds.</div></div>${badge(`${connected} connected`, connected ? "green" : "amber")}</div>${adapters.map(adapter => `<div class="setting-row"><div><div class="title-sm">${esc(adapter.displayName)}</div><div class="muted mono">${esc(adapter.version || adapter.error || adapter.command)}</div></div>${badge(adapter.available ? "Available" : "Unavailable", adapter.available ? "green" : "red")}</div>`).join("") || emptyNote("No adapters discovered.")}`)}
    ${panel("Storage & Privacy", "lock", `<div class="setting-row"><div><div class="title-sm">Evidence retention</div><div class="muted">Keep immutable source snapshots unless explicitly archived.</div></div>${badge("Retain indefinitely")}</div><div class="setting-row"><div><div class="title-sm">Secret redaction</div><div class="muted">Scrub credentials before indexing source material.</div></div>${badge("Enabled", "green")}</div><div class="setting-row"><div><div class="title-sm">Bridge mode</div><div class="muted">Local CLI and IPC integration for desktop agents.</div></div>${badge("CLI / IPC bridge", "blue")}</div>`)}
  </div>`;
}

const renderers = { overview: renderOverview, projects: renderProjects, sessions: renderSessions, review: renderReview, decisions: renderDecisions, work: renderWork, context: renderContext, rules: renderRules, settings: renderSettings };

function render() {
  document.getElementById("app").innerHTML = shell();
  document.getElementById("view").innerHTML = state.loading ? `${pageHeader(pages[state.page])}${emptyNote("Loading workspace data...")}` : renderers[state.page]();
  document.querySelectorAll("[data-nav]").forEach(btn => btn.addEventListener("click", () => { state.page = btn.dataset.nav; location.hash = state.page; render(); }));
  document.querySelectorAll("[data-action='refresh-context']").forEach(btn => btn.addEventListener("click", loadData));
}

window.addEventListener("hashchange", () => {
  const next = location.hash.replace("#", "");
  if (pages[next] && next !== state.page) { state.page = next; render(); }
});

render();
loadData();
