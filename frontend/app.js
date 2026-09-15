const navGroups = [
  { label: "Workspace", items: [
    ["overview", "dashboard", "Overview"],
    ["projects", "folder_open", "Projects"],
    ["sessions", "terminal", "Sessions"],
  ] },
  { label: "Governance", items: [
    ["review", "inbox", "Review Inbox", "4"],
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
  overview: {
    title: "Overview",
    subtitle: "Workspace status, pending governance, and the next executable work.",
    actions: [["refresh", "Refresh Context"], ["arrow_outward", "Continue in Agent", "primary"]],
  },
  projects: {
    title: "Projects",
    subtitle: "Governed workspace boundaries and their active context policies.",
    actions: [["create_new_folder", "Add Project", "primary"], ["tune", "Edit Defaults"]],
  },
  sessions: {
    title: "Sessions",
    subtitle: "Concrete agent work episodes with immutable evidence references.",
    actions: [["play_arrow", "Resume Session", "primary"], ["download", "Export Capsule"]],
  },
  review: {
    title: "Review Inbox",
    subtitle: "Human decisions required before derived context or rules become active.",
    actions: [["rule", "Approve Selected", "primary"], ["close", "Reject"]],
  },
  decisions: {
    title: "Decisions",
    subtitle: "Durable choices, rationale, provenance, and version history.",
    actions: [["add", "Record Decision", "primary"], ["compare_arrows", "Compare Versions"]],
  },
  work: {
    title: "Work Items",
    subtitle: "Executable units of work with readiness signals and blocked dependencies.",
    actions: [["play_arrow", "Start Ready Item", "primary"], ["add_task", "Create Item"]],
  },
  context: {
    title: "Context",
    subtitle: "Governed sources, immutable evidence snapshots, and derived context items.",
    actions: [["sync", "Sync Sources", "primary"], ["fact_check", "Review Derived Items"]],
  },
  rules: {
    title: "Rules",
    subtitle: "Versioned governance instructions controlling automated agent behavior.",
    actions: [["add", "New Rule", "primary"], ["history", "Version History"]],
  },
  settings: {
    title: "Settings",
    subtitle: "Configure how ContextOS runs, connects to agents, and handles work context.",
    actions: [["restart_alt", "Reset changes"], ["check", "Save changes", "primary"]],
    narrow: true,
  },
};

const state = { page: location.hash.replace("#", "") || "overview" };
if (!pages[state.page]) state.page = "overview";

function icon(name) {
  return `<span class="material-symbols-outlined">${name}</span>`;
}

function badge(text, tone = "") {
  return `<span class="badge ${tone}">${text}</span>`;
}

function button([ic, label, kind]) {
  return `<button class="btn ${kind || ""}">${icon(ic)}<span>${label}</span></button>`;
}

function shell() {
  return `
    <aside class="sidebar">
      <div>
        <div class="brand">
          <div class="brand-mark">${icon("terminal")}</div>
          <div><div class="brand-title">ContextOS</div><div class="brand-sub mono">AGENT WORKSPACE</div></div>
        </div>
        <div class="nav">
          ${navGroups.map(group => `
            <div class="nav-group">
              <div class="nav-label mono">${group.label}</div>
              ${group.items.map(([id, ic, label, count]) => `
                <button class="nav-item ${state.page === id ? "active" : ""}" data-nav="${id}">
                  <span class="nav-left">${icon(ic)}<span>${label}</span></span>
                  ${count ? `<span class="count mono">${count}</span>` : ""}
                </button>
              `).join("")}
            </div>
          `).join("")}
        </div>
      </div>
      <div class="daemon">
        <div class="daemon-main">
          <span class="dot"></span>
          <div><div class="daemon-title">Daemon running</div><div class="daemon-sub mono">localhost:7777</div></div>
        </div>
        <button class="icon-btn" data-nav="settings" title="Settings">${icon("settings")}</button>
      </div>
    </aside>
    <div class="shell">
      <header class="topbar">
        <div class="crumbs mono">
          <span>Workspace</span><span>/</span><span class="crumb-current">${pages[state.page].title}</span>
          <span class="project-pill">${icon("folder_managed")} ContextOS (D:/project/ContextOS)</span>
        </div>
        <div class="top-actions">
          <div class="search">${icon("search")}<input placeholder="Search projects, sessions, decisions..." /></div>
          <div class="agent-pill mono"><span class="dot"></span><span>1 connected</span><span class="quiet">·</span><strong>2 adapters available</strong></div>
          <button class="icon-btn" title="Notifications">${icon("notifications")}</button>
          <div class="identity"><div class="avatar">AD</div><div><strong>Adam</strong><div class="daemon-sub mono">Lead Architect</div></div></div>
        </div>
      </header>
      <main class="main"><div class="page ${pages[state.page].narrow ? "narrow" : ""}" id="view"></div></main>
    </div>
  `;
}

function pageHeader(page) {
  return `
    <section class="page-head">
      <div><h1>${page.title}</h1><p class="lead">${page.subtitle}</p></div>
      <div class="actions">${page.actions.map(button).join("")}</div>
    </section>
  `;
}

function panel(title, ic, body, meta = "") {
  return `<section class="panel"><div class="panel-head"><div class="panel-title">${icon(ic)}${title}</div><div class="panel-meta mono">${meta}</div></div>${body}</section>`;
}

function renderOverview() {
  return `
    ${pageHeader(pages.overview)}
    <div class="kpi-grid">
      ${[
        ["18", "Sessions indexed"],
        ["7", "Decisions active"],
        ["12", "Work items"],
        ["4", "Review required"],
      ].map(([v, l]) => `<div class="kpi"><div class="kpi-value">${v}</div><div class="kpi-label mono">${l}</div></div>`).join("")}
    </div>
    <div class="grid cols-12" style="margin-top:16px">
      <div class="span-8 stack">
        ${panel("Current Project", "folder_open", `
          <div class="pad stack">
            <div class="split"><div><div class="title-sm">ContextOS product interface</div><div class="muted">Design phase workspace with governed sources and executable next steps.</div></div>${badge("Design phase", "blue")}</div>
            <div class="progress"><span style="width:72%"></span></div>
            <div class="split mono muted"><span>Boundary: D:/project/ContextOS</span><span>Health: clean</span></div>
          </div>
        `)}
        ${panel("Next Work Items", "task_alt", rows([
          ["Implement frontend shell", "Ready", "blue"],
          ["Connect settings persistence", "Blocked", "amber"],
          ["Verify derived context labels", "Ready", "green"],
        ]), "3 ready signals")}
      </div>
      <div class="span-4 stack">
        ${panel("Governance Queue", "inbox", rows([
          ["4 imported artifacts", "Review", "amber"],
          ["0 conflicting rules", "Clean", "green"],
          ["1 stale summary", "Needs check", "amber"],
        ]))}
        ${panel("Linked Activity", "link", `
          <div class="metric-row"><span>Sessions</span><strong>18</strong></div>
          <div class="metric-row"><span>Decisions</span><strong>7</strong></div>
          <div class="metric-row"><span>Context Items</span><strong>143</strong></div>
        `)}
      </div>
    </div>
  `;
}

function rows(items) {
  return `<div>${items.map(([title, status, tone, sub]) => `
    <div class="list-row"><div><div class="title-sm">${title}</div>${sub ? `<div class="muted">${sub}</div>` : ""}</div>${badge(status, tone)}</div>
  `).join("")}</div>`;
}

function table(headers, data) {
  return `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${data.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function renderProjects() {
  return `${pageHeader(pages.projects)}${panel("Project Register", "folder_open", table(
    ["Project", "Boundary", "Rules", "Health", "Activity"],
    [
      ["<strong>ContextOS</strong><div class='muted'>Agent workspace governance</div>", "<span class='mono'>D:/project/ContextOS</span>", badge("Product Design", "blue"), badge("Clean", "green"), "18 sessions"],
      ["<strong>Memory Indexer</strong><div class='muted'>Semantic source extraction</div>", "<span class='mono'>D:/project/memory-indexer</span>", badge("Strict Mainline"), badge("Review", "amber"), "6 sessions"],
      ["<strong>UI Prototype Lab</strong><div class='muted'>Design import workspace</div>", "<span class='mono'>D:/project/prototypes</span>", badge("Local Only"), badge("Clean", "green"), "9 screens"],
    ]
  ))}`;
}

function renderSessions() {
  return `${pageHeader(pages.sessions)}${panel("Session Episodes", "terminal", table(
    ["Session", "Agent", "Evidence", "Derived Output", "Status"],
    [
      ["<strong>Design cleanup pass</strong><div class='muted mono'>2026-09-14 22:18</div>", "Figma Plugin", "7 frame screenshots", "UI deltas", badge("Synced", "green")],
      ["<strong>Frontend conversion</strong><div class='muted mono'>2026-09-15 09:40</div>", "Codex", "Stitch export", "Static prototype", badge("Active", "blue")],
      ["<strong>Architecture planning</strong><div class='muted mono'>2026-09-14 16:05</div>", "Claude Code", "Transcript snapshot", "Decision candidates", badge("Indexed", "green")],
    ]
  ))}`;
}

function renderReview() {
  return `${pageHeader(pages.review)}${panel("Pending Review Items", "inbox", rows([
    ["Imported Figma adjustments", "Needs approval", "amber", "Verify copied screens match Pure Light Workspace constraints."],
    ["Derived context summary", "Proposed", "blue", "Source evidence is attached and read-only."],
    ["Rule inheritance update", "Gate required", "amber", "Would affect future agent sessions in this project."],
    ["Work item readiness inference", "Validate", "amber", "Check whether dependencies are actually available."],
  ]))}`;
}

function renderDecisions() {
  return `${pageHeader(pages.decisions)}${panel("Decision Register", "gavel", table(
    ["ID", "Decision", "Rationale", "Version", "State"],
    [
      ["DEC-042", "Keep evidence immutable", "Original transcripts remain read-only; derived artifacts use versions.", "v2.1", badge("Active", "green")],
      ["DEC-043", "Use Pure Light Workspace", "Daily developer operations need dense, quiet scanning.", "v1.0", badge("Active", "green")],
      ["DEC-044", "Single Settings page", "No extra tabs until configuration complexity demands them.", "v1.0", badge("Accepted", "blue")],
    ]
  ))}`;
}

function renderWork() {
  return `${pageHeader(pages.work)}${panel("Execution Readiness", "task_alt", table(
    ["Work item", "Owner", "Inputs", "Readiness", "Status"],
    [
      ["<strong>Build frontend prototype</strong><div class='muted'>Convert Stitch screens into reusable static views.</div>", "Codex", "Design export, product spec", "92%", badge("Ready", "green")],
      ["<strong>Persist settings changes</strong><div class='muted'>Wire local save state to backend contract later.</div>", "Codex", "Contract draft pending", "48%", badge("Blocked", "amber")],
      ["<strong>Validate context labels</strong><div class='muted'>Confirm evidence snapshots are not presented as derived items.</div>", "Adam", "DESIGN.md", "81%", badge("Ready", "blue")],
    ]
  ))}`;
}

function renderContext() {
  return `${pageHeader(pages.context)}<div class="grid cols-12">
    <div class="span-8">${panel("Sources", "database", table(
      ["Source", "Type", "Last sync", "Trust", "State"],
      [
        ["Codex Chat", "Artifact", "15 mins ago", "Derived", badge("Synced", "green")],
        ["Claude Code", "Transcript", "Today 08:30", "Evidence", badge("Synced", "green")],
        ["Design Specs", "Manual import", "Yesterday", "Derived", badge("4 unreviewed", "amber")],
      ]
    ))}</div>
    <div class="span-4">${panel("Integrity Boundary", "verified", `
      <div class="metric-row"><span>Evidence snapshots</span><strong>36</strong></div>
      <div class="metric-row"><span>Derived context items</span><strong>143</strong></div>
      <div class="metric-row"><span>Unlabeled derived items</span><strong>0</strong></div>
    `)}</div>
  </div>`;
}

function renderRules() {
  return `${pageHeader(pages.rules)}${panel("Active Rule Set", "policy", rows([
    ["Read-only original transcripts", "Enforced", "green", "Autonomous agents cannot modify raw evidence."],
    ["Architecture specs outrank ad-hoc prompt notes", "Enforced", "green", "Local docs remain the source of truth for implementation."],
    ["Decision mutations require human review", "Enforced", "green", "Governed changes are staged before activation."],
    ["Secrets are redacted before indexing", "Enforced", "green", "Environment tokens and auth headers are scrubbed."],
  ]), "Product Design")}`;
}

function renderSettings() {
  return `${pageHeader(pages.settings)}<div class="stack">
    ${panel("General", "tune", `
      <div class="setting-row"><div><div class="title-sm">Default project</div><div class="muted">Project used when ContextOS starts without an explicit target.</div></div><input class="field mono" value="ContextOS" /></div>
      <div class="setting-row"><div><div class="title-sm">Resume capsule mode</div><div class="muted">Controls how agents receive compact handoff context.</div></div><select><option>Evidence-linked summary</option></select></div>
      <div class="setting-row"><div><div class="title-sm">Review gate</div><div class="muted">Require approval before activating derived governance content.</div></div><label class="toggle"><input type="checkbox" checked /> Enabled</label></div>
    `, "Workspace & Defaults")}
    ${panel("Agent Adapters", "smart_toy", `
      <div class="setting-row"><div><div class="title-sm">Connected adapter</div><div class="muted">Codex is currently attached to this workspace.</div></div>${badge("1 connected", "green")}</div>
      <div class="setting-row"><div><div class="title-sm">Available adapters</div><div class="muted">Claude Code and Cursor can be attached when needed.</div></div>${badge("2 adapters available", "blue")}</div>
      <div class="setting-row"><div><div class="title-sm">Adapter protocol</div><div class="muted">Local command and desktop bridge integration.</div></div>${badge("3 agent adapters")}</div>
    `)}
    ${panel("Storage & Privacy", "lock", `
      <div class="setting-row"><div><div class="title-sm">Evidence retention</div><div class="muted">Keep immutable source snapshots unless explicitly archived.</div></div><select><option>Retain indefinitely</option></select></div>
      <div class="setting-row"><div><div class="title-sm">Secret redaction</div><div class="muted">Scrub credentials before indexing source material.</div></div><label class="toggle"><input type="checkbox" checked /> Enabled</label></div>
      <div class="setting-row"><div><div class="title-sm">Bridge mode</div><div class="muted">Local CLI and IPC integration for desktop agents.</div></div>${badge("CLI / IPC bridge", "blue")}</div>
    `)}
  </div>`;
}

const renderers = { overview: renderOverview, projects: renderProjects, sessions: renderSessions, review: renderReview, decisions: renderDecisions, work: renderWork, context: renderContext, rules: renderRules, settings: renderSettings };

function render() {
  document.getElementById("app").innerHTML = shell();
  document.getElementById("view").innerHTML = renderers[state.page]();
  document.querySelectorAll("[data-nav]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.page = btn.dataset.nav;
      location.hash = state.page;
      render();
    });
  });
}

window.addEventListener("hashchange", () => {
  const next = location.hash.replace("#", "");
  if (pages[next] && next !== state.page) {
    state.page = next;
    render();
  }
});

render();

