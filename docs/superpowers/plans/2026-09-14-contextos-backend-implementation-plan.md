# ContextOS Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build the first working ContextOS local daemon with SQLite persistence, governed resources, recoverable jobs, evidence storage, rules, and real Claude Code/Codex/Cursor adapter execution.

**Architecture:** Use a modular monolith at 127.0.0.1:4721. HTTP transport calls Application Services; Domain modules enforce invariants; Infrastructure implements Drizzle repositories, the file Evidence Store, processes, and SQLite-backed jobs. Long-running work is scheduled through jobs and normalized adapter events.

**Tech Stack:** TypeScript, Node.js, SQLite, better-sqlite3, Drizzle ORM, Drizzle Kit, Zod, Vitest, and the repository-standard HTTP framework.

---

## Scope and dependency order

The implementation is split into independently testable increments:

1. Repository and daemon skeleton
2. Database migrations and repository contracts
3. Core resources and REST actions
4. Evidence Store and Context
5. Rules and governance
6. Jobs, outbox, recovery, and process supervision
7. Agent adapters
8. Frontend contract integration and packaging

Do not start adapter work before the job and evidence contracts exist. Do not expose a route before its Application Service and contract test exist.

## Planned file map

apps/daemon/src/main.ts and bootstrap.ts own process startup.
apps/daemon/src/http owns REST routing and error mapping.
apps/daemon/src/runtime owns scheduler, shutdown, and runtime orchestration.
packages/contracts/src owns Zod request/response/event schemas.
packages/domain/src is split by project, session, governance, context, rule, and audit.
packages/application/src is split by use case service.
packages/infrastructure/src owns SQLite, evidence, adapters, process, and jobs.
migrations owns versioned SQL migrations.
tests/contract and tests/integration own API and cross-module verification.

### Task 1: Create the daemon workspace and runtime boundary

Files:
- Create: package.json, tsconfig.json, vitest.config.ts
- Create: apps/daemon/src/main.ts, apps/daemon/src/bootstrap.ts
- Create: packages/shared/src/id.ts, clock.ts, errors.ts
- Create: tests/integration/daemon-health.test.ts

- [ ] Add TypeScript, Node types, Vitest, Zod, Fastify, better-sqlite3, Drizzle ORM, and Drizzle Kit. Add scripts dev, build, test, test:watch, db:generate, and db:migrate.
- [ ] Implement newId(), nowMs(), and typed errors exposing code, message, and details.
- [ ] Load host, port, dataDir, and databaseFile. Default host to 127.0.0.1 and port to 4721; reject non-loopback hosts.
- [ ] Add GET /api/health returning daemon version, schema version, process state, and requestId without secrets or raw paths.
- [ ] Test an ephemeral server and assert HTTP 200, a non-empty version, and a request ID.
- [ ] Run npm test -- tests/integration/daemon-health.test.ts. Expected: passing health test.
- [ ] Commit with git add package.json tsconfig.json vitest.config.ts apps packages tests and git commit -m "feat: create ContextOS daemon skeleton".

### Task 2: Implement SQLite, Drizzle schema, migrations, and transaction ports

Files:
- Create: packages/infrastructure/src/sqlite/client.ts, schema.ts, transaction.ts, migrations.ts
- Create: packages/application/src/ports/repositories.ts
- Create: migrations/0001_base.sql, 0002_sessions.sql, 0003_governance.sql
- Create: tests/integration/sqlite-migration.test.ts, transaction.test.ts

- [ ] Open SQLite with better-sqlite3 and execute foreign_keys=ON, journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000, and temp_store=MEMORY. Expose close and transaction without exposing the raw handle to Domain.
- [ ] Create projects, settings, agent_adapters, sessions, session_runs, review_items, decisions, decision_versions, work_items, work_item_dependencies, and work_item_attempts with foreign keys, revisions, status checks, unique versions, and dependency keys.
- [ ] Define typed ProjectRepository, SessionRepository, DecisionRepository, WorkItemRepository, and ReviewItemRepository ports plus TransactionRunner.run(work).
- [ ] Test empty-database migration, foreign keys, required indexes, and rollback that leaves no resource or audit row.
- [ ] Run npm test -- tests/integration/sqlite-migration.test.ts tests/integration/transaction.test.ts.
- [ ] Commit with git add packages migrations tests and git commit -m "feat: add SQLite migrations and repository ports".

### Task 3: Implement core domain resources and REST contract

Files:
- Create: packages/contracts/src/common.ts, projects.ts, sessions.ts, governance.ts
- Create: packages/domain/src/project/project.ts, session/session.ts, decision/decision.ts, work-item/work-item.ts, review-item/review-item.ts
- Create: packages/application/src/project/project-service.ts, session/session-service.ts, governance/governance-services.ts
- Create: apps/daemon/src/http/routes/projects.ts, sessions.ts, governance.ts
- Create: tests/contract/core-resources.test.ts, tests/integration/core-resources.test.ts

- [ ] Define Zod schemas for list parameters, inputs, revision, Idempotency-Key, PageInfo, JobReceipt, and ApiError. Reject unknown lifecycle values.
- [ ] Write failing tests for Project archive, Session transitions, Accepted Decision immutability, Work Item self-reference/cycles, and Review Item resolution requiring a written reason.
- [ ] Implement domain methods returning new state or typed domain errors without HTTP or repository calls.
- [ ] Implement repositories and Application Services. Each service loads the resource, validates Project ownership, invokes Domain, performs a revision-checked transaction, writes Audit/Activity, and returns a DTO.
- [ ] Add list/detail/PATCH routes and explicit actions:
  projects activate, pause, archive, restore
  sessions continue, review, archive
  decisions propose, accept, supersede, reverse, archive, review
  work items mark-ready, start, block, resolve-blocker, send-to-review, complete, reopen, cancel
  review items assign, start, resolve, dismiss
- [ ] Contract-test success DTO, input validation, revision conflict, not found, and cross-project references.
- [ ] Run npm test -- tests/contract/core-resources.test.ts tests/integration/core-resources.test.ts.
- [ ] Commit with git add packages apps tests and git commit -m "feat: add governed core resources and REST actions".

### Task 4: Implement Evidence Store and Context lifecycle

Files:
- Create: packages/infrastructure/src/evidence/evidence-store.ts
- Create: packages/domain/src/evidence/evidence-snapshot.ts, context/context-source.ts, context/context-item.ts
- Create: packages/application/src/context/context-service.ts
- Create: apps/daemon/src/http/routes/context.ts
- Create: migrations/0004_context.sql
- Create: tests/integration/evidence-integrity.test.ts, tests/contract/context.test.ts

- [ ] Create context_sources, evidence_snapshots, context_items, context_item_versions, and context_packages. Evidence rows are append-only with unique storage_ref and content hash.
- [ ] Test that Snapshot content cannot be updated/deleted, Context Item versions require provenance, and a Package retains exact historical versions.
- [ ] Implement temporary-file write, hash/size, fsync, atomic rename, and SQLite metadata/Audit/Outbox commit. Startup recovery detects missing active files.
- [ ] Implement source create/edit/test/sync/enable/disable/archive, snapshot inspect/compare/verify, item version creation, and deterministic package construction.
- [ ] Register Context routes. Snapshot routes expose inspection and verification only; no edit/delete route exists.
- [ ] Run npm test -- tests/integration/evidence-integrity.test.ts tests/contract/context.test.ts.
- [ ] Commit with git add packages apps migrations tests and git commit -m "feat: add immutable evidence and context persistence".

### Task 5: Implement Rules, evaluation persistence, and Review generation

Files:
- Create: packages/domain/src/rule/rule.ts
- Create: packages/application/src/rule/rule-service.ts, evaluator.ts
- Create: apps/daemon/src/http/routes/rules.ts
- Create: migrations/0005_rules.sql
- Create: tests/integration/rules.test.ts, tests/contract/rules.test.ts

- [ ] Create rules, rule_versions, rule_conflicts, and rule_evaluations with validation state, precedence, enforcement mode, evaluator version, and input hash.
- [ ] Test invalid activation, unresolved conflicts, active-version immutability, deterministic tests, REQUIRE_REVIEW creation, and BLOCK preventing an action.
- [ ] Implement structured validation for scope, conditions, effect, exceptions, and precedence. Do not introduce a conversational rule model or full-screen code editor.
- [ ] Evaluate bounded normalized event references and resource summaries; persist rule version, evaluator version, input hash, result, explanation, and timestamp.
- [ ] Route REQUIRE_REVIEW to ReviewItemService and BLOCK to the calling Application Service.
- [ ] Register validate, activate, disable, archive, restore, new-version, conflicts, usage, evaluations, test, versions, compare, audit-log, and validate-all routes.
- [ ] Run npm test -- tests/integration/rules.test.ts tests/contract/rules.test.ts.
- [ ] Commit with git add packages apps migrations tests and git commit -m "feat: add versioned rule governance".

### Task 6: Implement Settings, jobs, outbox, leases, and recovery

Files:
- Create: packages/application/src/settings/settings-service.ts
- Create: packages/infrastructure/src/jobs/job-repository.ts, job-scheduler.ts, job-recovery.ts, outbox-dispatcher.ts
- Create: apps/daemon/src/http/routes/settings.ts
- Modify: apps/daemon/src/bootstrap.ts
- Create: migrations/0006_runtime.sql
- Create: tests/integration/jobs-recovery.test.ts, tests/contract/settings.test.ts

- [ ] Create jobs, job_attempts, activity_events, audit_events, outbox_events, and idempotency_keys with availability and lease indexes.
- [ ] Seed the singleton Settings record. Support startup, minimization, confirmation, adapter defaults, Context policy, data directory, retention, telemetry, cache clear, and export. Return requiresRestart for data directory and process policy changes.
- [ ] Claim due jobs in a short transaction, increment attempt, set worker/lease, and write job_attempts. Never hold a transaction during work.
- [ ] Retry only transient adapter/process/storage errors with bounded exponential backoff. Do not retry validation, permission, unsupported capability, or revision conflicts.
- [ ] Requeue expired leases and resolve orphan running runs as failed or resumable during startup.
- [ ] Write resources, Audit, Activity, and required Outbox records in one transaction. Dispatcher retries pending events.
- [ ] Test worker exit after claim, dispatcher exit after commit, daemon restart, duplicate idempotency key, and Evidence file/database mismatch.
- [ ] Run npm test -- tests/integration/jobs-recovery.test.ts tests/contract/settings.test.ts.
- [ ] Commit with git add packages apps migrations tests and git commit -m "feat: add recoverable jobs and runtime settings".

### Task 7: Implement Agent Adapter contracts and process supervision

Files:
- Create: packages/application/src/ports/agent-adapter.ts
- Create: packages/infrastructure/src/process/process-supervisor.ts
- Create: packages/infrastructure/src/adapters/registry.ts, claude-code-adapter.ts, codex-adapter.ts, cursor-adapter.ts
- Create: packages/application/src/session/continue-session-job.ts
- Create: tests/fixtures/adapters and tests/integration/adapter-contract.test.ts

- [ ] Define discover, importTranscript, launch, resume, inspectStatus, interrupt, and capabilities. Include parser version, adapter version, external IDs, and normalized errors.
- [ ] Define normalized events: run started, message received, tool called, tool completed, run completed, and run failed. Large payloads use Evidence references.
- [ ] Implement argv-only process launch, bounded output readers, timeout, exit/signal mapping, graceful interrupt, forced termination deadline, and persisted pid/run state.
- [ ] Implement each adapter's local discovery, transcript parser, launch/resume command, status inspection, capability list, and fixtures. Core code must not import adapter-specific paths.
- [ ] Connect the Continue Session job: build Package, create Run/Job, launch/resume, write Evidence, update Session projections, evaluate Rules, and create Review Items.
- [ ] Test discovery, import idempotency, launch/resume, event parsing, unsupported capability, non-zero exit, timeout, and interruption for every adapter.
- [ ] Run npm test -- tests/integration/adapter-contract.test.ts.
- [ ] Commit with git add packages tests and git commit -m "feat: add Agent adapters and supervised runs".

### Task 8: Complete API integration, shutdown, packaging, and final verification

Files:
- Modify: apps/daemon/src/bootstrap.ts and main.ts
- Create: apps/daemon/src/shutdown.ts
- Create: tests/contract/frontend-api-contract.test.ts, tests/integration/restart-recovery.test.ts
- Create: README.md and .env.example

- [ ] Register Overview, Projects, Sessions, Review Inbox, Decisions, Work Items, Context, Rules, Settings, and Health. Match the frontend contract and never expose database/debug details.
- [ ] Implement graceful shutdown: stop requests, stop claims, interrupt adapters, persist resumable runs, flush Outbox, close SQLite, release the data lock.
- [ ] Restart-test a queued Job and incomplete Session Run. Assert recoverable work is resumed and no incomplete run becomes successful.
- [ ] Verify every frontend route's method/path, success schema, pagination, errors, revision, idempotency, read-only, and missing-reference behavior.
- [ ] Document install, first start, data directory, port, logs, adapter prerequisites, migrations, tests, and recovery without secrets.
- [ ] Run npm run build, npm test, and npm run db:migrate against a fresh temporary database. Expected: build succeeds, tests pass, migration completes.
- [ ] Commit with git add . and git commit -m "feat: complete ContextOS backend foundation".

## Definition of done

- daemon listens only on 127.0.0.1:4721
- every frontend resource/action route has an Application Service and contract test
- Domain does not import Drizzle, SQLite, filesystem, or Agent-specific code
- Evidence Snapshot is append-only and has a verifiable file reference
- Derived Context Item versions have provenance
- mutable resources use revision conflict checks
- long-running work has Job, attempt, lease, retry, and recovery state
- Agent processes are supervised and adapter differences are isolated
- resource change, Audit, and required Outbox writes have explicit transaction boundaries
- startup and graceful shutdown recover incomplete work without claiming false success
- logs and API responses do not expose credentials, full transcripts, shell commands, or database internals
