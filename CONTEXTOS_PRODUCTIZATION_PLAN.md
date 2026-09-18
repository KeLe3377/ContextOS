# ContextOS Productization Plan

Updated: 2026-09-17

This document is the current working plan for finishing ContextOS. It consolidates the older design documents, marks what is in scope, what has already landed, and what should be built next.

## 1. Design Document Inventory

### Current Source Of Truth

| File | Role | Current Status |
|---|---|---|
| `DESIGN.md` | Approved product/design baseline: positioning, domain model, page ownership, visual rules, and page contracts. | Keep as product boundary reference. |
| `docs/2026-09-14-contextos-design-v2.md` | V2 product concept: Agent Workspace, evidence-first model, Project/Session/Decision/Work Item/Rule, phased V0.x roadmap. | Keep as product strategy reference. Some tech choices are outdated. |
| `docs/2026-09-14-contextos-frontend-design-api.md` | Frontend page ownership and resource API contract. | Keep as UI/API intent. Some endpoint names differ from implementation. |
| `docs/2026-09-14-contextos-backend-architecture.md` | Backend module boundaries, local daemon, runtime, adapter, evidence, job, audit, recovery principles. | Keep as architecture intent. |
| `docs/2026-09-14-contextos-database-design.md` | SQLite persistence baseline and invariants. | Keep for invariants. Implementation uses pragmatic raw SQL/better-sqlite3 rather than a full Drizzle-domain rewrite. |
| `docs/2026-09-16-contextos-complete-status-and-roadmap.md` | Previous status and roadmap after backend/React first pass. | Partially outdated; this document supersedes it for execution order. |
| `CONTEXTOS_USAGE.md` | User-facing operating guide. | Keep and update after major user-facing changes. |
| `README.md` | Product overview and local startup guide. | Keep concise; link to usage and this plan. |

### Historical Archives

| File | Meaning |
|---|---|
| `.archives/2026-09-14_设计ContextOS产品界面_方案确定.md` | UI/product-page design conversation. |
| `.archives/2026-09-14_设计ContextOS前后端架构_方案确定.md` | Architecture design conversation. |
| `.archives/2026-09-15_转换ContextOS前端原型_完成.md` | Old frontend prototype conversion history. |
| `.archives/2026-09-16_完善ContextOS后端Codex闭环_PhaseE完成.md` | Backend Codex loop work history. |
| `.archives/2026-09-16_完善ContextOS后端闭环_PhaseH完成并规划全量遗留_上下文恢复.md` | Reliability/backend continuation context. |
| `.archives/2026-09-17_完成ContextOS前端React迁移与Codex闭环_完成.md` | React migration and Codex loop archive. |

Archives are evidence/history, not active implementation specs. Use them only to recover rationale.

## 2. Product Boundary

### ContextOS Is

ContextOS is a local-first Agent Workspace and project-level work-context governance system for developers using Codex, Claude Code, Cursor, and similar coding agents.

It manages:

- Project boundaries.
- Agent work Sessions.
- Immutable Evidence Snapshots.
- Derived Context Items with provenance and versions.
- durable Decisions.
- executable Work Items.
- governance Review Items.
- versioned Rules.
- local agent adapters and context delivery.

### ContextOS Is Not

ContextOS is not:

- a chatbot;
- a generic memory engine;
- a personal profile/personality product;
- a marketing dashboard;
- a project-management suite;
- a knowledge graph UI;
- a cloud/team product in the current phase;
- a replacement for Codex, Claude Code, or Cursor execution.

### Core Integrity Rules

- Original transcripts and Evidence Snapshots are read-only evidence.
- Derived content can be edited only through explicit versions.
- AI or agent output may propose content; the user controls activation and governance.
- Lifecycle changes use explicit action endpoints, not arbitrary status mutation.
- Every injected or active derived object must expose provenance.
- Local data and paths stay inside project/data-directory safety boundaries.

## 3. Current Implementation Baseline

As of 2026-09-17, the current project has:

- React + TypeScript + Vite frontend served by the daemon.
- Local Fastify daemon on `127.0.0.1:4721`.
- SQLite persistence through `better-sqlite3`.
- Codex and Claude Code adapter first pass.
- Project and Session creation/archive.
- Session continue/resume/interrupt/runtime status.
- Codex transcript import and external session binding.
- Context Source create/sync/pause/resume/archive.
- Evidence Snapshot storage, verify, content view, metadata compare/content compare backend.
- Context Item create/activate/stale/archive/version list/version restore.
- Rule create/validate/test/activate/disable.
- Review resolve/dismiss backend and frontend action first pass.
- Decision create/propose/accept/archive frontend/backend first pass.
- Work Item create and lifecycle frontend/backend first pass.
- Runtime recovery for stale daemon locks and orphaned runs.
- Full test baseline currently passing.

The repository is already ahead of the old “static prototype” and “backend-only MVP” documents. Future work should productize the existing pages, not invent new pages.

## 4. Design Drift And Superseded Assumptions

These older design details are no longer binding:

- `Next.js + Tailwind + shadcn/ui`: current frontend is intentionally React + Vite + plain CSS.
- `Prisma`: current persistence is raw SQL/better-sqlite3, with Drizzle only as a dependency/tooling option.
- “V0.1 Claude Code first”: current practical loop is Codex-first, with Claude Code first-pass adapter.
- “Cursor in early adapter set”: Cursor is deferred.
- product pages for Jobs/Audit/Outbox: explicitly out of product scope; they remain infrastructure.
- knowledge graph / memory-feed / personality profile UI: out of scope.
- adding new primary navigation modules: out of scope unless the product boundary is explicitly changed.

## 5. Completion Definition

ContextOS is “complete enough for the original local product vision” when:

- a user can create or select a Project and see accurate project state;
- a user can create/import/continue/interrupt/archive Sessions and inspect their evidence;
- existing Codex conversations can be imported and bound predictably;
- Context Sources can be maintained and synced into immutable Evidence;
- Evidence can be viewed, verified, compared, and linked to derived context;
- Context Items, Decisions, Work Items, Review Items, and Rules can be created, edited where allowed, versioned, transitioned, and inspected;
- Rules affect runtime actions through warning/review/block behavior;
- context package delivery into agents is understandable and reproducible;
- startup, shutdown, stale locks, orphaned runs, and evidence corruption have clear recovery behavior;
- the UI has stable object-detail workflows rather than scattered one-off tables;
- docs explain daily use without asking the user to read design files.

## 6. Development Plan

Development must proceed in small, verified increments. Each increment should:

- touch an existing product page or backend module;
- connect frontend to real backend behavior;
- run `npm run build:all`, targeted tests, and `npm test` when the blast radius is broad;
- commit locally after verification.

### Phase 1: Product Shell And Object Detail Workspaces

Goal: turn the current table-first UI into usable object pages without adding navigation.

Tasks:

- Add selected-object detail workspaces for Projects, Sessions, Review Items, Decisions, Work Items, Context, and Rules.
- Preserve page ownership: each page owns only its resource.
- Add stable loading, empty, save-error, conflict, and read-only states.
- Add destructive confirmation for archive/cancel/block actions when `confirmDestructiveActions` is enabled.
- Keep tables dense, but make detail inspection and editing possible without modal overload.

Acceptance:

- The user can click a row and inspect the object’s meaningful fields.
- Existing row actions still work.
- No page embeds another module’s full editor.

### Phase 2: Sessions And Transcript Continuity

Goal: make Sessions the reliable daily entry point.

Tasks:

- Session detail: identity, intent, adapter, external session ID, runtime status, context package, evidence, resume capsule.
- Show managed process output evidence in a readable detail panel.
- Add import history and clear failure messages for transcript import.
- Add resume capsule edit/refresh first pass if backend supports it.
- Make `Continue in Agent` behavior explicit: launch new vs resume bound external session.

Acceptance:

- The user can tell exactly whether a Session is bound to a Codex/Claude conversation.
- Continue failures show useful evidence and next action.
- Manual transcript import and existing-session import are visually distinct.

### Phase 3: Context And Evidence Productization

Goal: complete the Source -> Evidence -> Context Item chain.

Tasks:

- Context Source detail: locator, status, last sync, last snapshot, metadata, pause/resume/archive.
- Evidence detail: content, verify result, metadata, provenance, hash/size.
- Evidence compare UI only where it answers a real user workflow: compare two snapshots from the same project/source.
- Context Item detail: source snapshot, derived label, body, version history, restore, lifecycle.
- Add source edit/patch where backend contract permits it.

Acceptance:

- Evidence and derived Context Items are visually and behaviorally distinct.
- The user can recover “where did this context come from?”
- Old versions remain inspectable.

### Phase 4: Review Inbox As Governance Queue

Goal: Review Inbox becomes the place to process system-generated or rule-generated governance issues.

Tasks:

- Review detail workspace with trigger, source reference, priority, proposed resolution, status, and action log.
- Start/assign if backend exists; otherwise implement backend minimally.
- Resolve/dismiss with required written reason.
- Link to source object without embedding its editor.
- Generate useful review items from evidence verify failures and rule `REQUIRE_REVIEW`.

Acceptance:

- A Review Item can be processed end to end.
- Resolution reason is persisted and visible.
- Source object remains owned by its original page.

### Phase 5: Decisions

Goal: Decisions become durable, versioned records, not just rows.

Tasks:

- Decision detail: statement, context, rationale, alternatives, consequences, references.
- Edit draft/proposed Decision via PATCH or new version depending on backend rule.
- Implement supersede/reverse lifecycle if not already complete.
- Add version history and compare if useful.
- Link Decision to Evidence/Session references as compact provenance.

Acceptance:

- Accepted decisions cannot be silently overwritten.
- User can record why a direction was chosen or rejected.
- Decision state transitions are clear.

### Phase 6: Work Items

Goal: Work Items become actionable units that guide the next agent session.

Tasks:

- Work Item detail: definition, acceptance criteria, execution contract, dependencies, child items, attempts.
- Add dependency management and cycle-safe backend checks.
- Add readiness view.
- Add block/resolve-blocker flow.
- Link execution attempts to Sessions.

Acceptance:

- A Work Item can move Backlog -> Ready -> In Progress -> Review/Done.
- Blocked state has a reason and can be resolved.
- Next work is visible from Overview and context package generation.

### Phase 7: Rules Manager

Goal: Rules become understandable and enforceable.

Tasks:

- Rule detail: scope, conditions, effect, enforcement mode, precedence, exceptions.
- Improve validation feedback.
- Show deterministic test result and recent evaluations.
- Implement conflict/usage views only if backend data exists.
- Add export/rendering targets later: project `AGENTS.md`, `CLAUDE.md`, Cursor rules.

Acceptance:

- A user can understand what a rule does before activating it.
- `WARNING`, `REQUIRE_REVIEW`, and `BLOCK` have visible runtime consequences.
- Invalid rules cannot be activated.

### Phase 8: Overview And Context Package Quality

Goal: Overview becomes the daily “continue work” screen.

Tasks:

- Implement/align `/api/workspace/overview`.
- Show current project, last session, next work items, pending reviews, context health.
- Improve context package selection: active work, recent decisions, active context items, relevant evidence, active rules.
- Record selection reasons and truncation.
- Make context package readable in Session detail.

Acceptance:

- User can open ContextOS and know what to do next.
- Continue in Agent uses a context package whose contents can be explained.

### Phase 9: Runtime, Jobs, Audit, And Reliability Hardening

Goal: make the product safe to use repeatedly.

Tasks:

- Job lease/claim/retry where runtime work needs it.
- Runtime health summary in Settings/Health without creating Jobs page.
- Outbox dispatcher only when there is a real consumer.
- Activity/Audit query endpoints as supporting data for object detail views.
- Evidence recovery and orphaned run recovery remain tested.
- Improve graceful shutdown and restart behavior.

Acceptance:

- Daemon restart does not leave misleading RUNNING state.
- Failed background work is visible from the owning resource.
- Internal infrastructure remains internal.

### Phase 10: Adapter Deepening

Goal: make adapters trustworthy before adding more.

Tasks:

- Deepen Codex transcript schema: messages, tool calls, tool results, summaries, output truncation.
- Deepen Claude Code transcript schema to parity where practical.
- Normalize agent events.
- Add Cursor only after Codex/Claude Code transcript and lifecycle behavior are stable.

Acceptance:

- Adapter contract tests cover discovery, launch, resume, import, inspect, interrupt, and transcript normalization.
- Product behavior does not depend on agent-specific implementation leaking into UI.

### Phase 11: Packaging, E2E, Documentation

Goal: make ContextOS easy to run and verify.

Tasks:

- Add browser E2E smoke for main flows.
- Add screenshot/layout checks for the desktop shell and dense tables.
- Keep `CONTEXTOS_USAGE.md` updated after each product milestone.
- Update README only for stable user-facing commands.
- Consider installer/autostart after the local product flow is stable.

Acceptance:

- A fresh local checkout can install, build, start, and pass tests.
- User guide matches actual UI.
- Main flows are covered by automated tests, not only manual clicking.

## 7. Immediate Next Implementation Slice

Recommended next slice: Phase 1 + Phase 2, Sessions detail workspace.

Why:

- Sessions are the main daily workflow.
- Many user confusions have centered on Session, transcript binding, Continue behavior, runtime status, and Evidence.
- It builds on real backend behavior already present.
- It does not add new product scope.

Concrete first increment:

- Add selected Session detail panel to `frontend/src/App.tsx`.
- Show session identity, project, adapter, external agent session, runtime status, latest context package, resume capsule, and linked evidence.
- Keep row actions but make their result visible in the detail panel.
- Verify with `npm run build:all`, `npm test -- tests/integration/runtime-api.test.ts tests/integration/transcript-import-api.test.ts`, and full `npm test` if frontend wiring touches shared state.

Completed follow-up on 2026-09-17:

- Added selected-session capsule export from the Sessions header, table rows, and detail panel.
- Added Session detail actions for opening/copying linked evidence and copying bound external/context package IDs.
- Added `PATCH /api/sessions/:id/resume-capsule` with revision conflict protection, preserving run/evidence history.
- Added frontend Edit Capsule flow backed by the new API.
- Added explicit Session transcript sync: `POST /api/sessions/:id/sync-transcript`, Sessions page action, detail/table sync buttons, and sync freshness metadata.
- Verified with `npm run build:all`, targeted Session tests, `npm test`, and `git diff --check`.

Phase 3 first increment completed on 2026-09-17:

- Added selected Context Source workspace on the Context page.
- Linked Sources to latest Evidence, source snapshot history, and derived Context Items.
- Added source-level Sync/Pause/Resume/Archive and evidence open/verify actions inside the selected-source workflow.
- Added Evidence compare UI for comparing a Source snapshot against the latest snapshot using existing metadata/content compare APIs.
- Added Evidence-to-Context derivation entry points so a snapshot can prefill the Context Item creation flow.
- Added Context Item edit flow backed by `PATCH /api/context-items/:id`, preserving provenance while creating backend versions.
- Added Context Source edit flow backed by `PATCH /api/context-sources/:id` for mutable source fields, keeping locator/type immutable in the UI.
- Verified with `npm run build:all`, `npm test`, and `git diff --check`.

Phase 4 first increment completed on 2026-09-18:

- Added selected Review workspace with source/trigger/priority/reviewer/resolution detail.
- Added Review start, assign, resolve, and dismiss actions from the queue and detail panel.
- Added frontend Review action log display backed by `/api/review-items/:id/action-log`.
- Extended Review audit history so assignment and start actions are recorded, not only final resolve/dismiss actions.
- Verified with targeted Review tests, frontend build, full build/test, and `git diff --check`.

Phase 5 first increment completed on 2026-09-18:

- Added Decision version DTOs and `/api/decisions/:id/versions`.
- Extended draft/proposed Decision PATCH so body edits create a new `decision_versions` row and move `currentVersionId`.
- Added Decision detail workspace with statement, rationale, context, consequences, alternatives, references, and version history.
- Added Decision edit flow for mutable draft/proposed decisions while preserving the existing accepted/closed immutability rule.
- Verified with `npm run build:all`, targeted Decision tests, full `npm test`, and `git diff --check`.

Phase 6 first increment completed on 2026-09-18:

- Added Work Item detail workspace with description, acceptance criteria, execution contract, readiness, and blocking dependencies.
- Added Work Item edit flow for mutable items, including parent, dependencies, acceptance criteria, and execution contract.
- Extended Work Item PATCH contract/backend so definition fields are actually persisted.
- Verified with `npm run build:all`, targeted Work Item tests, full `npm test`, and `git diff --check`.

Phase 6 execution-loop increment completed on 2026-09-18:

- Linked Work Item attempts to the full managed Session lifecycle instead of leaving them permanently `STARTED`.
- Reconciled attempt states to `SUCCEEDED`, `FAILED`, or `CANCELED`, including daemon-restart recovery, and preserved the latest Session run reference.
- Added Work Item activity and audit records for attempt lifecycle changes.
- Added direct navigation from a Work Item attempt to its linked Session, with completion time and run reference visible in the Work detail workspace.

Phase 7 first increment completed on 2026-09-18:

- Added Rules detail workspace with current version, validation state, enforcement, effect, scope, usage, versions, and recent evaluations.
- Added `POST /api/rules/render-instructions` to render active ContextOS Rules into managed `AGENTS.md` / `CLAUDE.md` blocks.
- Supported project and global instruction targets: `PROJECT_AGENTS`, `PROJECT_CLAUDE`, `GLOBAL_AGENTS`, and `GLOBAL_CLAUDE`.
- Added frontend preview/apply controls for project `AGENTS.md` and `CLAUDE.md`.
- Preserved existing file content by replacing only the `CONTEXTOS_RULES` managed block.
- Verified with `npm run build:all`, targeted Rules tests, full `npm test`, and `git diff --check`.

Phase 8 first increment completed on 2026-09-18:

- Added `/api/workspace/overview` as a real daily-start endpoint composed from Project, Session, Review, Work Item, Context, and Rule services.
- Added Overview KPIs for sessions, pending reviews, ready work, active context, and active rules.
- Added next-work, governance queue, context-health, last-session, and latest-context-package data to the overview DTO.
- Updated the frontend Overview page to use the backend overview endpoint with local fallback.
- Surfaced latest context package selection reasons on Overview.
- Verified with `npm run build:all`, targeted Overview tests, full `npm test`, and `git diff --check`.

After that, continue down the phases in order unless a blocker in real use forces a narrower fix.
