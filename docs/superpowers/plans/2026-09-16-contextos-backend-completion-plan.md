# ContextOS Backend Completion Plan

> **For agentic workers:** This plan continues from the simplified ContextOS backend MVP. Follow repository rules in `AGENT.md`: no CodeGraph unless initialized, no red-light test-first cycle unless requested, keep frontend/backend scope aligned with the existing pages, and keep Jobs/Audit/Outbox as internal support infrastructure rather than product pages.

**Goal:** Move ContextOS from the simplified end-to-end MVP to the original first-stage backend design without expanding product scope beyond the approved frontend pages.

**Architecture:** Keep the current modular TypeScript daemon, SQLite persistence, static frontend integration, and Codex-first adapter. Fill the skipped reliability, provenance, lifecycle, and contract gaps in small increments, using targeted verification after implementation.

**Tech Stack:** TypeScript, Node.js, Fastify, SQLite, better-sqlite3, Zod, Vitest, static frontend for now. React/Vite migration remains later, after backend behavior is stable.

---

## 1. Current Baseline

The simplified version is now useful enough to exercise the core loop:

- Daemon boots locally and exposes `/api/health`.
- SQLite migrations exist through runtime schema version 7.
- Project, Session, Review Item, Decision, Work Item, Context Source, Evidence Snapshot, Context Item, Rule, Settings, and Adapter endpoints have first-pass coverage.
- File-backed Evidence Snapshot storage exists in minimal form.
- Rule versioning and validation exist in simplified form.
- Settings, Jobs, Activity, Audit, Outbox, and Idempotency tables exist, but runtime behavior is minimal.
- Codex adapter can now resolve `codex.cmd` on Windows and discover the installed CLI.
- `POST /api/sessions/:id/continue` creates a session run/job and launches Codex through the adapter.
- Static frontend reads real daemon APIs from `http://127.0.0.1:4721` and does not need React yet.

This means the simplified E2E loop is basically complete:

```text
Project -> Session -> Continue -> Codex Adapter -> process launch -> frontend reads state
```

The remaining work is not to add pages. It is to make the loop reliable, inspectable, recoverable, and closer to the original ContextOS design.

## 2. Non-Negotiable Scope Rules

- Do not add new primary navigation pages.
- Do not create product pages for Jobs, Audit Activity, Outbox, or internal worker state.
- Keep official pages aligned to: Overview, Projects, Sessions, Review Inbox, Decisions, Work Items, Context, Rules, Settings footer/shell behavior.
- Keep ContextOS positioned as a local Agent Workspace and project-level governance container, not a general memory engine or chatbot.
- Keep Codex as the first real adapter. Claude Code and Cursor can be planned as later adapter implementations after the adapter contract is solid.
- Keep frontend as the current static frontend until backend behavior is stable enough to justify React/Vite migration.
- Verification is implementation-first: build/tests/startup checks after changes, not red-light test-first cycles.

## 3. Gap Map Against The Original Plan

### Original Task 1: Daemon Skeleton

Status: mostly done.

Remaining gaps:

- Data directory lock is not complete.
- Startup/shutdown lifecycle is minimal.
- Health does not yet expose scheduler/recovery status because scheduler/recovery is minimal.

Action: finish later during runtime recovery work, not as a separate large refactor.

### Original Task 2: SQLite, Migrations, Repository Contracts

Status: simplified done.

Remaining gaps:

- Drizzle schema is not central; current implementation uses raw SQL and better-sqlite3.
- Repository ports are pragmatic rather than full domain-first interfaces.
- Some original constraints are simplified or missing.
- Migration plan has diverged from the original numbering, but current schema version 7 is acceptable as project reality.

Action: do not rewrite to Drizzle now. Add missing constraints only when needed by behavior.

### Original Task 3: Core Resources

Status: minimal API done.

Remaining gaps:

- Lifecycle invariants are shallow.
- Explicit action endpoints are incomplete for the full design.
- Accepted Decision immutability and version semantics are not fully enforced.
- Work Item dependency/cycle behavior is minimal.
- Review Item resolution reason/action log behavior needs hardening.
- Idempotency and revision behavior is not uniformly applied.

Action: harden per object, starting only where frontend or runtime loop needs it.

### Original Task 4: Evidence Store And Context

Status: minimal done.

Remaining gaps:

- Evidence write path is not fully crash-safe: temp file, fsync, atomic rename, DB transaction, recovery.
- Evidence Snapshot immutability is not enforced at every layer.
- Context Item versions and provenance are simplified.
- Context Package manifest is missing.
- Transcript import is missing.
- Snapshot compare/verify is minimal or missing.

Action: prioritize Context Package and evidence integrity because they are needed for meaningful `Continue in Agent`.

### Original Task 5: Rules And Governance

Status: simplified done.

Remaining gaps:

- Rule conflicts, usage, evaluations, deterministic test, validate-all, and audit log are not complete.
- Rule evaluation is not connected to session continue or normalized runtime events.
- REQUIRE_REVIEW and BLOCK are not yet real runtime effects.

Action: keep Rules page API stable, then add evaluation persistence and Review Item generation after Agent event capture exists.

### Original Task 6: Jobs, Outbox, Leases, Recovery

Status: schema/minimal runtime done.

Remaining gaps:

- Jobs are records, not a full scheduler with claim/lease/retry/recovery.
- Process exit is not observed, so a launched run can stay `RUNNING` forever.
- Outbox is not dispatched.
- Idempotency table is not integrated with request handling.
- Startup recovery does not reconcile orphan RUNNING jobs/runs.

Action: this is the next practical backend improvement area. Start with process exit lifecycle, then lease/recovery.

### Original Task 7: Agent Adapters And Process Supervision

Status: Codex MVP only.

Remaining gaps:

- No full adapter interface for discover/import/launch/resume/status/interrupt.
- No adapter registry.
- No normalized Agent Events.
- No stdout/stderr capture into Evidence.
- No graceful interrupt or timeout handling.
- Claude Code and Cursor adapters are not implemented.

Action: deepen Codex first. Do not add Claude/Cursor until Codex lifecycle, evidence, and event capture are stable.

### Original Task 8: API Integration, Shutdown, Packaging

Status: static frontend reads APIs.

Remaining gaps:

- Overview aggregate endpoint is missing or incomplete.
- Frontend action buttons are not fully wired.
- Graceful shutdown is minimal.
- Packaging/install docs are incomplete.
- Full frontend API contract tests are missing.

Action: after runtime and evidence are reliable, wire only existing frontend actions.

## 4. Completion Phases

### Phase A: Stabilize The Current Codex Loop - first pass complete

Purpose: make the current loop truthful. If a Codex process exits or fails, ContextOS must not leave the Session/Run/Job falsely stuck in `RUNNING`.

Files likely touched:

- `packages/infrastructure/src/process-supervisor.ts`
- `packages/infrastructure/src/adapters/codex-adapter.ts`
- `packages/application/src/core/runtime-services.ts`
- `packages/infrastructure/src/sqlite/runtime-repository.ts`
- `tests/integration/runtime-api.test.ts`
- `tests/integration/codex-adapter.test.ts`

Steps:

- [ ] Keep the Windows `codex.cmd` fix and commit it with the plan or separately.
- [ ] Change `ProcessSupervisor.launch()` to return a process handle with `pid` and an `onExit` callback registration, or accept lifecycle callbacks at launch time.
- [ ] Add repository methods to mark continue success and failure on process exit:
  - `markContinueSucceeded({ jobId, runId, exitCode }, now)`
  - `markContinueExitedFailed({ jobId, runId, exitCode, signal, failureMessage }, now)`
- [ ] Update Session status when run exits:
  - exit code `0`: Session can become `COMPLETED` only for short smoke commands; real interactive Codex may need a future `PAUSED` or `NEEDS_REVIEW` decision.
  - non-zero exit: Session becomes `FAILED` with failure metadata.
- [ ] Add a safe smoke path using `CONTEXTOS_CODEX_ARGS='["--help"]'` for automated verification.
- [ ] Verify with `npm run build` and targeted runtime tests.

Can be short: yes. This phase should be small and direct.

### Phase B: Add Minimal Runtime Recovery - first pass complete

Purpose: daemon restart should not silently lie about jobs/runs created before a crash.

Files likely touched:

- `packages/infrastructure/src/sqlite/runtime-repository.ts`
- `packages/application/src/core/runtime-services.ts`
- `apps/daemon/src/bootstrap.ts`
- `tests/integration/runtime-api.test.ts`
- New: `tests/integration/runtime-recovery.test.ts`

Steps:

- [ ] Add startup recovery method that finds `RUNNING` jobs/runs older than daemon startup without a live supervisor handle.
- [ ] Mark orphan runs as `FAILED` with `failureCode = DAEMON_RESTARTED` for now.
- [ ] Add Activity/Audit entries for recovery decisions.
- [ ] Expose only summarized runtime health through `/api/health`; do not add a Jobs page.
- [ ] Verify daemon restart against a temp database.

Can be short: yes for first version. Lease/retry can be later.

### Phase C: Build Context Package MVP - first pass complete

Purpose: `Continue in Agent` should not just launch Codex; it should have a recorded input package explaining what ContextOS attempted to provide.

Files likely touched:

- `migrations/0008_context_packages.sql` if missing fields cannot fit current schema
- `packages/application/src/core/runtime-services.ts`
- `packages/application/src/core/context-services.ts`
- `packages/infrastructure/src/sqlite/context-repositories.ts`
- `packages/infrastructure/src/sqlite/runtime-repository.ts`
- `apps/daemon/src/http/routes/core-resources.ts`
- `tests/integration/context-resources-api.test.ts`
- `tests/integration/runtime-api.test.ts`

Steps:

- [ ] Create or complete `context_packages` persistence if current schema lacks usable manifest fields.
- [ ] Build a deterministic package from active Context Items and verified Evidence Snapshots for the project.
- [ ] Save package manifest with source IDs, versions, hashes, byte size, truncation flag, and selection reasons.
- [ ] Link `sessions.context_package_id` during continue.
- [ ] Add `GET /api/sessions/:id/context-pack` matching the existing Sessions page expectation.
- [ ] Keep package content compact; full content can remain as evidence/file reference.

Can be short: medium. This is core product value and should not be too shallow.

### Phase D: Harden Evidence Integrity - first pass complete

Purpose: Evidence Snapshot becomes trustworthy instead of just a row plus file.

Files likely touched:

- `packages/infrastructure/src/evidence/evidence-store.ts`
- `packages/infrastructure/src/sqlite/context-repositories.ts`
- `packages/application/src/core/context-services.ts`
- `apps/daemon/src/http/routes/context-resources.ts`
- `tests/integration/context-resources-api.test.ts`
- New: `tests/integration/evidence-integrity.test.ts`

Steps:

- [ ] Write evidence through temp file -> hash/size -> atomic rename -> DB metadata.
- [ ] Store evidence under `evidence/<project-id>/<snapshot-id>.txt` or a similarly stable internal path, not user-provided filenames.
- [ ] Add verification endpoint behavior that recomputes hash and size.
- [ ] Prevent mutation of content-bearing snapshot fields after creation.
- [ ] Add missing-file and hash-mismatch failure states.

Can be short: no. This is one of ContextOS's important product distinctions.

### Phase E: Session Evidence And Resume Capsule MVP - first pass complete

Purpose: after a run, ContextOS should leave a usable trace and a resume artifact, not just process status.

Files likely touched:

- `packages/infrastructure/src/process-supervisor.ts`
- `packages/infrastructure/src/adapters/codex-adapter.ts`
- `packages/application/src/core/runtime-services.ts`
- `packages/application/src/core/context-services.ts`
- `packages/infrastructure/src/sqlite/context-repositories.ts`
- `apps/daemon/src/http/routes/core-resources.ts`
- `tests/integration/runtime-api.test.ts`

Steps:

- [ ] Capture bounded stdout/stderr for non-interactive runs into Evidence Snapshot.
- [ ] For interactive Codex, record launch metadata first; deeper transcript capture can wait until adapter supports it safely.
- [ ] Add minimal `GET /api/sessions/:id/evidence` returning evidence references, not raw large payloads.
- [ ] Add minimal resume capsule field or Context Item type that records intent, last run status, result summary, and next suggested action.
- [ ] Add `GET /api/sessions/:id/resume-capsule` and `PATCH /api/sessions/:id/resume-capsule` only if frontend needs it now.

Can be short: medium. Transcript capture can be phased; launch/result evidence should come first.

### Phase F: Harden Core Resource Lifecycles - first pass complete

Purpose: make object actions obey the product model.

Files likely touched:

- `packages/application/src/core/core-services.ts`
- `packages/infrastructure/src/sqlite/core-repositories.ts`
- `apps/daemon/src/http/routes/core-resources.ts`
- `packages/contracts/src/*.ts`
- `tests/integration/core-resources-api.test.ts`

Steps:

- [x] Decisions: accepted decisions cannot be silently rewritten; material change uses supersede/reverse.
- [x] Work Items: prevent self-dependency and dependency cycles; readiness checks are explicit.
- [x] Review Items: resolve/dismiss requires reason and writes action log/audit metadata.
- [x] Sessions: archive/review/continue transitions reject invalid states.
- [x] Projects: archived projects reject new sessions and continue actions.
- [x] Apply expected revision consistently on mutating routes.

Can be short: medium. Do this object by object.

### Phase G: Rule Evaluation MVP - first pass complete

Purpose: Rules should influence runtime behavior, not only exist as editable records.

Files likely touched:

- `packages/application/src/core/rule-service.ts`
- `packages/application/src/core/runtime-services.ts`
- `packages/infrastructure/src/sqlite/rule-repository.ts`
- `packages/infrastructure/src/sqlite/runtime-repository.ts`
- `apps/daemon/src/http/routes/rules.ts`
- `tests/integration/rules-api.test.ts`

Steps:

- [x] Persist rule evaluations with input hash, rule version, result, explanation, and evaluator version.
- [x] Implement deterministic `POST /api/rules/:id/test` for structured sample input.
- [x] Implement `GET /api/rules/:id/evaluations` and compact usage data.
- [x] Connect `REQUIRE_REVIEW` to Review Item creation for session continue events.
- [x] Connect `BLOCK` to prevent the corresponding action.

Can be short: medium. Conflict analysis can be deferred after evaluation exists.

### Phase H: Idempotency, Audit, Activity, And Outbox Discipline

Purpose: make repeated requests and crashes safer while keeping these systems internal.

Files likely touched:

- `apps/daemon/src/http/*`
- `packages/infrastructure/src/sqlite/runtime-repository.ts`
- `packages/application/src/core/*`
- `tests/integration/*`

Steps:

- [ ] Implement `Idempotency-Key` handling for create/action endpoints that can be retried by UI.
- [ ] Ensure important lifecycle actions write Audit and Activity in the same transaction as resource change.
- [ ] Add an internal outbox dispatcher only after there is an actual consumer; until then keep outbox records as durable internal events.
- [ ] Make API errors include stable codes and request IDs without stack traces or secrets.

Can be short: medium. Idempotency should be incremental per route group.

### Phase I: Frontend Action Wiring Without New Pages - first pass complete

Purpose: let the existing static frontend operate the backend loop instead of only reading it.

Files likely touched:

- `frontend/app.js`
- `frontend/index.html`
- `frontend/styles.css`
- Existing route files only if a needed endpoint is missing.

Steps:

- [x] Wire existing `Continue in Agent` action to `POST /api/sessions/:id/continue`.
- [x] Wire create project/rule minimal forms where the existing UI already implies the action; no new Session form was introduced.
- [x] Add loading/error states in place, without new modules.
- [x] Refresh Overview/Sessions/Settings data after actions.
- [x] Keep React migration deferred.

Can be short: yes. Do after backend lifecycle is truthful.

### Phase J: Adapter Contract Deepening - first pass complete

Purpose: Codex first, then Claude Code/Cursor later.

Files likely touched:

- New: `packages/application/src/ports/agent-adapter.ts`
- New or modify: `packages/infrastructure/src/adapters/registry.ts`
- Modify: `packages/infrastructure/src/adapters/codex-adapter.ts`
- Modify: `packages/infrastructure/src/process-supervisor.ts`
- Tests under `tests/integration` and `tests/fixtures/adapters`

Steps:

- [x] Extract an adapter interface around current Codex behavior.
- [x] Add normalized capabilities: discover, launch, resume, inspectStatus, interrupt, importTranscript.
- [x] Add adapter registry with Codex only enabled initially.
- [x] Keep Codex non-interactive output covered by runtime/codex adapter tests.
- [ ] Add Claude Code and Cursor only after Codex passes the shared contract.

Can be short: no for full multi-agent support. Keep first pass Codex-only.

### Phase K: Packaging, Docs, And Final Backend Verification - first pass complete

Purpose: make the project usable repeatedly on the same machine.

Files likely touched:

- `README.md`
- `.env.example`
- `AGENT.md` if workflow rules change
- `apps/daemon/src/main.ts`
- `apps/daemon/src/bootstrap.ts`
- `tests/integration/restart-recovery.test.ts`

Steps:

- [x] Document how to start daemon, open frontend, create a project/session, and continue with Codex.
- [x] Document adapter prerequisites and Windows `codex.cmd` behavior.
- [x] Add graceful shutdown handling.
- [x] Run `npm run build` and `npm test`.
- [x] Run local startup smoke against health and adapter endpoints.

Can be short: yes for docs; shutdown/recovery may need its own pass.

## 5. Recommended Execution Order

Start with the smallest work that makes the current loop more truthful:

1. Phase A: Codex process lifecycle and exit status. First pass complete on 2026-09-16.
2. Phase B: minimal restart/orphan recovery. First pass complete on 2026-09-16.
3. Phase C: Context Package MVP. First pass complete on 2026-09-16.
4. Phase D: Evidence integrity hardening. First pass complete on 2026-09-16.
5. Phase E: Session evidence/resume capsule MVP. First pass complete on 2026-09-16.
6. Phase F: core lifecycle hardening.
7. Phase G: Rule evaluation MVP.
8. Phase H: idempotency/audit/activity discipline.
9. Phase I: frontend action wiring.
10. Phase J: adapter contract deepening. First pass complete on 2026-09-16.
11. Phase K: packaging/docs/final verification. First pass complete on 2026-09-16.

This order keeps the product loop intact while gradually restoring the original design depth.

## 6. First Implementation Slice

The next concrete slice should be Phase A.

Acceptance criteria:

- `new CodexAdapter().discover()` returns available on this Windows machine when Codex CLI is installed.
- `POST /api/sessions/:id/continue` still creates job/run/session state.
- For a short command such as `CONTEXTOS_CODEX_ARGS='["--help"]'`, process exit updates job/run/session instead of leaving them `RUNNING` forever.
- For a non-zero fake/smoke command, job/run/session record failure metadata.
- Build and targeted tests pass.

Verification commands:

```powershell
npm run build
npm test -- codex-adapter.test.ts runtime-api.test.ts
```

Manual smoke after implementation:

```powershell
$env:CONTEXTOS_CODEX_ARGS='["--help"]'
npm run dev
```

Then trigger `POST /api/sessions/:id/continue` and confirm the run no longer remains permanently `RUNNING` after the process exits.

## 7. Notes For Future Work

- The original design mentioned Drizzle, but the current working implementation uses better-sqlite3 with raw SQL migrations. Do not rewrite storage only to match the old wording unless it removes a real blocker.
- Jobs/Audit/Outbox are infrastructure. They may appear as counts, activity summaries, or diagnostics, but not as new product pages.
- Claude Code and Cursor are important for the product promise, but adding them before Codex lifecycle/evidence is stable will multiply uncertainty.
- Frontend React migration should wait until backend action semantics and DTOs are stable enough to avoid rework.




