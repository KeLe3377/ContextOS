# ContextOS Zero-Input Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a daemon-owned, persistent automation loop that discovers Codex work, ingests evidence, creates governed extraction candidates, and lets users review them instead of manually entering project context.

**Architecture:** Add an automation scheduler and repositories beside the existing runtime services. Discovery and ingestion produce immutable Evidence; a structured extractor produces candidates; reconciliation and policy decide whether candidates remain pending or are applied through existing domain services. Existing manual flows and immutable Context Packages remain intact.

**Tech Stack:** TypeScript, Node.js, Fastify, better-sqlite3, Zod, React, Vitest, Playwright, Codex app-server/CLI.

**Design:** `docs/superpowers/specs/2026-09-20-contextos-zero-input-automation-design.md`

---

## Delivery Scope

This plan implements the 8-12 day MVP boundary first:

- persistent scheduler and project automation settings;
- automatic Codex thread discovery and Session binding;
- daemon-owned transcript polling;
- immutable Evidence for synchronized event batches;
- structured Resume Capsule and Context Item candidates;
- review, accept, reject, retry, and Context Package verification;
- automation health in the existing UI.

Decision and Work Item extraction schemas are reserved in the candidate contract, but their extractor prompts and application handlers are deferred until the MVP accuracy is measured. Rule generation, auto-starting Agents, and Desktop UI control remain out of scope.

## File Map

| Path | Responsibility |
|---|---|
| `migrations/0012_automation.sql` | Automation settings, jobs, attempts, candidates, candidate evidence links |
| `packages/contracts/src/automation.ts` | Public settings, status, job and candidate schemas |
| `packages/application/src/ports/context-extractor.ts` | Extractor interface and typed input/output |
| `packages/application/src/core/automation-scheduler.ts` | Polling lifecycle, claiming, dispatch and shutdown |
| `packages/application/src/core/automation-service.ts` | Discovery, sync, extraction, reconciliation and candidate actions |
| `packages/application/src/core/automation-policy.ts` | Risk classification and acceptance decisions |
| `packages/infrastructure/src/sqlite/automation-repository.ts` | Persistent settings, jobs and candidates |
| `packages/infrastructure/src/extraction/codex-context-extractor.ts` | Bounded Codex CLI structured extraction |
| `apps/daemon/src/http/routes/automation.ts` | Automation HTTP routes |
| `apps/daemon/src/bootstrap.ts` | Composition root and lifecycle hooks |
| `frontend/src/App.tsx` | Existing-page automation status and review actions |
| `tests/integration/automation-*.test.ts` | Scheduler, discovery, extraction, policy and API tests |
| `tests/e2e/automation-review.spec.ts` | User-visible zero-input workflow |

## Task 1: Define Automation Contracts

**Files:**
- Create: `packages/contracts/src/automation.ts`
- Test: `tests/integration/automation-contracts.test.ts`

- [ ] **Step 1: Write contract tests for settings and candidates**

Cover these exact invariants:

```ts
expect(automationModeSchema.parse("SUGGEST_ONLY")).toBe("SUGGEST_ONLY");
expect(() => automationSettingsPatchSchema.parse({ pollIntervalMs: 999 })).toThrow();
expect(extractionCandidateSchema.parse(validCandidate).status).toBe("PENDING");
expect(() => extractionCandidatePayloadSchema.parse({ kind: "RULE" })).toThrow();
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `npx vitest run tests/integration/automation-contracts.test.ts`  
Expected: FAIL because `packages/contracts/src/automation.ts` does not exist.

- [ ] **Step 3: Implement the Zod contracts**

Define:

```ts
automationModeSchema = z.enum(["OFF", "SUGGEST_ONLY", "AUTO_ACCEPT_HIGH_CONFIDENCE"])
automationJobKindSchema = z.enum([
  "DISCOVER_CODEX_THREADS",
  "SYNC_SESSION_TRANSCRIPT",
  "DISCOVER_PROJECT_SOURCES",
  "SYNC_CONTEXT_SOURCE",
  "EXTRACT_EVIDENCE_CONTEXT",
  "RECONCILE_EXTRACTION_CANDIDATES"
])
candidateKindSchema = z.enum(["RESUME_CAPSULE", "CONTEXT_ITEM", "DECISION", "WORK_ITEM"])
candidateStatusSchema = z.enum(["PENDING", "ACCEPTED", "REJECTED", "SUPERSEDED"])
```

Set `pollIntervalMs` to 5,000-300,000, `maxConcurrentJobs` to 1-4, and `sourceMaxBytes` to 1,024-1,000,000. Candidate payloads must be discriminated unions and exclude Rule.

- [ ] **Step 4: Run the contract test**

Run: `npx vitest run tests/integration/automation-contracts.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit the contract**

```powershell
git add packages/contracts/src/automation.ts tests/integration/automation-contracts.test.ts
git commit -m "feat: define automation contracts"
```

## Task 2: Add Persistent Automation Storage

**Files:**
- Create: `migrations/0012_automation.sql`
- Create: `packages/infrastructure/src/sqlite/automation-repository.ts`
- Modify: `packages/infrastructure/src/sqlite/schema.ts`
- Test: `tests/integration/automation-repository.test.ts`
- Modify: `tests/integration/sqlite-migration.test.ts`

- [ ] **Step 1: Add failing migration and repository tests**

Assert that:

- default project mode is `SUGGEST_ONLY`;
- enqueueing the same active `idempotency_key` twice returns one job;
- only an available QUEUED job can be claimed;
- a RUNNING job can become SUCCEEDED or retryable QUEUED;
- candidate `(project_id, kind, fingerprint)` is unique while active;
- accepting or rejecting uses `expectedRevision`.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `npx vitest run tests/integration/automation-repository.test.ts tests/integration/sqlite-migration.test.ts`  
Expected: FAIL because migration 0012 and the repository are absent.

- [ ] **Step 3: Create migration 0012**

Create tables:

```sql
project_automation_settings
automation_jobs
automation_job_attempts
extraction_candidates
extraction_candidate_evidence
```

Add foreign keys, revision columns, indices for due jobs and pending candidates, and a partial unique index preventing duplicate non-terminal jobs by `idempotency_key`.

- [ ] **Step 4: Implement `SqliteAutomationRepository`**

Expose focused methods:

```ts
getSettings(projectId)
patchSettings(projectId, patch, now)
enqueue(input, now)
claimNext(now)
markSucceeded(jobId, now)
markRetryable(jobId, failure, availableAt, now)
markFailed(jobId, failure, now)
recoverRunning(now)
upsertCandidate(input, now)
listCandidates(filter)
getCandidate(id)
transitionCandidate(id, status, target, expectedRevision, now)
```

Use transactions for claim and state transitions.

- [ ] **Step 5: Run repository and migration tests**

Run: `npx vitest run tests/integration/automation-repository.test.ts tests/integration/sqlite-migration.test.ts`  
Expected: PASS, including migration from schema 0011 to 0012.

- [ ] **Step 6: Commit persistence**

```powershell
git add migrations/0012_automation.sql packages/infrastructure/src/sqlite/automation-repository.ts packages/infrastructure/src/sqlite/schema.ts tests/integration/automation-repository.test.ts tests/integration/sqlite-migration.test.ts
git commit -m "feat: persist automation jobs and candidates"
```

## Task 3: Build the Scheduler Lifecycle

**Files:**
- Create: `packages/application/src/core/automation-scheduler.ts`
- Modify: `apps/daemon/src/bootstrap.ts`
- Test: `tests/integration/automation-scheduler.test.ts`
- Modify: `tests/integration/daemon-health.test.ts`

- [ ] **Step 1: Write scheduler lifecycle tests**

Use a fake repository, fake clock and fake dispatcher. Verify:

- `start()` recovers RUNNING jobs once;
- one tick claims at most the configured concurrency;
- successful dispatch marks SUCCEEDED;
- failures schedule 5s, 30s, 2m and 10m retries;
- the fourth failed attempt becomes FAILED;
- `stop()` prevents new claims and waits for active dispatches;
- duplicate `start()` is idempotent.

- [ ] **Step 2: Run the test and confirm failure**

Run: `npx vitest run tests/integration/automation-scheduler.test.ts`  
Expected: FAIL because `AutomationScheduler` is absent.

- [ ] **Step 3: Implement the scheduler**

Inject repository, dispatcher, clock and timer functions. Do not embed domain handlers in the scheduler. Keep one timer owned by the daemon and expose a status snapshot with `running`, `lastTickAt`, `activeJobs` and counts.

- [ ] **Step 4: Wire lifecycle in bootstrap**

Construct the scheduler after repositories and services exist. Start it from Fastify `onReady`; stop it in `onClose` before closing SQLite. Extend `/api/health` recovery metadata with recovered automation jobs, without exposing payload text.

- [ ] **Step 5: Run scheduler and health tests**

Run: `npx vitest run tests/integration/automation-scheduler.test.ts tests/integration/daemon-health.test.ts tests/integration/runtime-recovery.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit scheduler lifecycle**

```powershell
git add packages/application/src/core/automation-scheduler.ts apps/daemon/src/bootstrap.ts tests/integration/automation-scheduler.test.ts tests/integration/daemon-health.test.ts
git commit -m "feat: run persistent automation scheduler"
```

## Task 4: Automate Codex Thread Discovery and Binding

**Files:**
- Create: `packages/application/src/core/project-thread-matcher.ts`
- Create: `packages/application/src/core/automation-service.ts`
- Modify: `packages/infrastructure/src/sqlite/core-repositories.ts`
- Test: `tests/integration/automation-discovery.test.ts`

- [ ] **Step 1: Write project matching tests**

Cover exact root match, normalized Windows path case, parent-directory ambiguity, multiple matching projects, archived projects, already-bound threads and missing thread titles.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/integration/automation-discovery.test.ts`  
Expected: FAIL because matcher and service are absent.

- [ ] **Step 3: Implement pure project matching**

Return one of:

```ts
{ kind: "EXACT", projectId: string }
{ kind: "REVIEW", projectIds: string[], reason: string }
{ kind: "IGNORE", reason: string }
```

Do not query SQLite inside the matcher.

- [ ] **Step 4: Add external-session repository lookups**

Add methods to find a Session by `(agentAdapterId, externalSessionId)` and to atomically create an automatically discovered Session only when no binding exists.

- [ ] **Step 5: Implement discovery handling**

For exact matches, create and bind a Session, then enqueue `SYNC_SESSION_TRANSCRIPT`. For ambiguous matches, create a deduplicated Review Item. Use the app-server candidate `name`, then `preview`, then the UUID prefix for title.

- [ ] **Step 6: Run discovery regressions**

Run: `npx vitest run tests/integration/automation-discovery.test.ts tests/integration/desktop-sync-candidates.test.ts tests/integration/desktop-sync.test.ts`  
Expected: PASS with no change to manual binding.

- [ ] **Step 7: Commit discovery**

```powershell
git add packages/application/src/core/project-thread-matcher.ts packages/application/src/core/automation-service.ts packages/infrastructure/src/sqlite/core-repositories.ts tests/integration/automation-discovery.test.ts
git commit -m "feat: automatically discover codex sessions"
```

## Task 5: Move Transcript Polling Into the Daemon

**Files:**
- Modify: `packages/application/src/core/desktop-sync-service.ts`
- Modify: `packages/infrastructure/src/sqlite/session-sync-repository.ts`
- Modify: `packages/application/src/core/automation-service.ts`
- Test: `tests/integration/automation-transcript-sync.test.ts`
- Modify: `tests/integration/desktop-sync.test.ts`

- [ ] **Step 1: Write background sync tests**

Verify that a WATCHING state is listable as due work, sync advances offsets without a browser request, partial lines do not advance past incomplete JSON, and file read errors retain the last successful offset.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/integration/automation-transcript-sync.test.ts`  
Expected: FAIL because due sync listing and background dispatch are absent.

- [ ] **Step 3: Add due-sync repository query**

Return WATCHING sessions whose `last_synced_at` is older than the project poll interval. Keep polling configuration in project automation settings, not in React state.

- [ ] **Step 4: Extract reusable sync result handling**

Keep `DesktopSyncService.sync(sessionId)` as the single parser/offset path. Add a callback or returned persistence input so successful non-empty batches can be stored as Evidence after offset persistence.

- [ ] **Step 5: Schedule recurring sync jobs**

After each terminal sync attempt, enqueue the next `SYNC_SESSION_TRANSCRIPT` using a time-bucketed idempotency key. `OFF` projects must not enqueue another job.

- [ ] **Step 6: Run sync regression tests**

Run: `npx vitest run tests/integration/automation-transcript-sync.test.ts tests/integration/desktop-sync.test.ts tests/integration/codex-transcript-tailer.test.ts`  
Expected: PASS.

- [ ] **Step 7: Commit background synchronization**

```powershell
git add packages/application/src/core/desktop-sync-service.ts packages/infrastructure/src/sqlite/session-sync-repository.ts packages/application/src/core/automation-service.ts tests/integration/automation-transcript-sync.test.ts tests/integration/desktop-sync.test.ts
git commit -m "feat: sync desktop transcripts in daemon"
```

## Task 6: Persist Incremental Transcript Evidence

**Files:**
- Modify: `packages/application/src/core/automation-service.ts`
- Modify: `packages/application/src/core/context-services.ts`
- Modify: `packages/infrastructure/src/sqlite/context-repositories.ts`
- Test: `tests/integration/automation-evidence.test.ts`

- [ ] **Step 1: Write evidence ordering and idempotency tests**

Verify that Evidence is committed before extraction is enqueued, empty syncs create nothing, replayed batches reuse the same content hash, and metadata contains session ID plus ordinal and byte ranges without transcript secrets in logs.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/integration/automation-evidence.test.ts`  
Expected: FAIL because synchronized batches are not persisted as Evidence.

- [ ] **Step 3: Add an application-level Evidence creation method**

Create `AGENT_OUTPUT` Evidence with canonical serialized events, `stream=desktop-sync`, parser version, external session ID, start/end ordinals and source byte offsets. Reuse the FileEvidenceStore and hash-based deduplication.

- [ ] **Step 4: Enqueue extraction only after commit**

Use `EXTRACT_EVIDENCE_CONTEXT:{evidenceId}:{extractorVersion}` as the idempotency key. A failed enqueue must leave Evidence intact and visible for a later repair pass.

- [ ] **Step 5: Run evidence and recovery tests**

Run: `npx vitest run tests/integration/automation-evidence.test.ts tests/integration/evidence-recovery.test.ts tests/integration/evidence-store.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit evidence ingestion**

```powershell
git add packages/application/src/core/automation-service.ts packages/application/src/core/context-services.ts packages/infrastructure/src/sqlite/context-repositories.ts tests/integration/automation-evidence.test.ts
git commit -m "feat: persist automatic transcript evidence"
```

## Task 7: Implement Structured Context Extraction

**Files:**
- Create: `packages/application/src/ports/context-extractor.ts`
- Create: `packages/infrastructure/src/extraction/codex-context-extractor.ts`
- Create: `packages/infrastructure/src/extraction/extraction-input.ts`
- Modify: `apps/daemon/src/bootstrap.ts`
- Test: `tests/integration/context-extractor.test.ts`

- [ ] **Step 1: Write extractor tests using a fake spawned process**

Cover valid JSON, malformed JSON, schema mismatch, timeout, non-zero exit, oversized input, injected AGENTS/environment messages and output containing unexpected extra fields.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/integration/context-extractor.test.ts`  
Expected: FAIL because the extractor port and adapter are absent.

- [ ] **Step 3: Define the extractor port**

Use a discriminated result with `resumeCapsule` and `contextItems`. Context Items allow only FACT, SUMMARY, CONSTRAINT, OPEN_QUESTION, RISK and HANDOFF. Every candidate must include evidence IDs and a stable normalized fingerprint input.

- [ ] **Step 4: Build bounded extraction input**

Prefer existing compacted events when present; otherwise retain all user/assistant messages, recent tool events and exact file/error strings within the configured byte limit. Remove known AGENTS and environment injection events before invoking Codex.

- [ ] **Step 5: Implement the Codex CLI adapter**

Write input to a run-scoped file under the ContextOS data directory. Spawn Codex with a fixed schema prompt, timeout and captured stdout limit. Parse stdout once, validate it with Zod, and always remove the temporary input file in `finally`. Do not log input or output bodies.

- [ ] **Step 6: Run extractor tests and build**

Run: `npx vitest run tests/integration/context-extractor.test.ts`  
Run: `npm run build`  
Expected: tests PASS and TypeScript exits 0.

- [ ] **Step 7: Commit extraction adapter**

```powershell
git add packages/application/src/ports/context-extractor.ts packages/infrastructure/src/extraction/codex-context-extractor.ts packages/infrastructure/src/extraction/extraction-input.ts apps/daemon/src/bootstrap.ts tests/integration/context-extractor.test.ts
git commit -m "feat: extract structured context candidates"
```

## Task 8: Reconcile Candidates and Apply Policy

**Files:**
- Create: `packages/application/src/core/automation-policy.ts`
- Modify: `packages/application/src/core/automation-service.ts`
- Modify: `packages/infrastructure/src/sqlite/automation-repository.ts`
- Modify: `packages/infrastructure/src/sqlite/core-repositories.ts`
- Test: `tests/integration/automation-candidates.test.ts`

- [ ] **Step 1: Write reconciliation and policy tests**

Verify stable deduplication, additional Evidence links, conflicting candidate coexistence, manual resource protection, `OFF`, `SUGGEST_ONLY`, and the high-confidence allowlist. Explicitly assert that CONSTRAINT, RISK, DECISION and WORK_ITEM remain pending.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/integration/automation-candidates.test.ts`  
Expected: FAIL because policy and reconciliation are absent.

- [ ] **Step 3: Implement policy as a pure function**

Return:

```ts
{ action: "IGNORE" | "REVIEW" | "AUTO_ACCEPT"; reason: string }
```

Only Resume Capsule and SUMMARY/HANDOFF Context Items at or above the configured threshold may return AUTO_ACCEPT.

- [ ] **Step 4: Implement candidate reconciliation**

Upsert by project, kind and fingerprint; link every supporting Evidence; never mutate ACCEPTED/REJECTED history; create a new conflicting candidate rather than overwrite a manually accepted target.

- [ ] **Step 5: Create deduplicated Review Items**

Use `sourceType=EXTRACTION_CANDIDATE`, `sourceId=candidate.id`, `triggerType=AUTOMATION_SUGGESTION`. Store a concise summary and proposed resolution, not the full transcript.

- [ ] **Step 6: Run policy and review regressions**

Run: `npx vitest run tests/integration/automation-candidates.test.ts tests/integration/evidence-integrity-review.test.ts tests/integration/core-resources-api.test.ts`  
Expected: PASS.

- [ ] **Step 7: Commit candidate governance**

```powershell
git add packages/application/src/core/automation-policy.ts packages/application/src/core/automation-service.ts packages/infrastructure/src/sqlite/automation-repository.ts packages/infrastructure/src/sqlite/core-repositories.ts tests/integration/automation-candidates.test.ts
git commit -m "feat: govern extracted context candidates"
```

## Task 9: Add Candidate and Automation APIs

**Files:**
- Create: `apps/daemon/src/http/routes/automation.ts`
- Modify: `apps/daemon/src/bootstrap.ts`
- Modify: `packages/application/src/core/automation-service.ts`
- Test: `tests/integration/automation-api.test.ts`

- [ ] **Step 1: Write API tests**

Cover settings GET/PATCH, status, manual discovery trigger, candidate list/detail, accept, reject and retry. Assert loopback behavior, Zod errors, revision conflict responses and idempotent accept.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/integration/automation-api.test.ts`  
Expected: FAIL with route-not-found responses.

- [ ] **Step 3: Implement routes**

Register the endpoints from the design. Keep status payloads free of transcript content and local secrets. `run-discovery` enqueues work and returns 202; it does not execute app-server calls inside the request.

- [ ] **Step 4: Apply candidates through domain services**

Resume Capsule candidates call the existing capsule patch path. Context Item candidates call `ContextItemService.create()` and activate only when policy allows or the user explicitly accepts. Update candidate status and target resource reference atomically.

- [ ] **Step 5: Run API and domain regressions**

Run: `npx vitest run tests/integration/automation-api.test.ts tests/integration/context-resources-api.test.ts tests/integration/idempotency-api.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit APIs**

```powershell
git add apps/daemon/src/http/routes/automation.ts apps/daemon/src/bootstrap.ts packages/application/src/core/automation-service.ts tests/integration/automation-api.test.ts
git commit -m "feat: expose automation review APIs"
```

## Task 10: Discover and Sync High-Value Project Sources

**Files:**
- Create: `packages/application/src/core/project-source-discovery.ts`
- Modify: `packages/application/src/core/automation-service.ts`
- Test: `tests/integration/automation-source-discovery.test.ts`

- [ ] **Step 1: Write source allowlist tests**

Use fixture trees containing allowed root files, first-level docs, hidden directories, `node_modules`, nested docs and oversized files. Assert only the documented allowlist is returned and paths remain within the real Project root.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/integration/automation-source-discovery.test.ts`  
Expected: FAIL because source discovery is absent.

- [ ] **Step 3: Implement deterministic discovery**

Normalize real paths, reject symlink escapes, sort results, enforce maximum count and bytes, and attach a discovery reason to each result.

- [ ] **Step 4: Reuse ContextSourceService**

Create missing FILE Sources and call existing sync behavior. Do not create a new Evidence snapshot when the content hash is unchanged. Enqueue extraction after a new snapshot commits.

- [ ] **Step 5: Run source and evidence regressions**

Run: `npx vitest run tests/integration/automation-source-discovery.test.ts tests/integration/context-resources-api.test.ts tests/integration/evidence-store.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit source discovery**

```powershell
git add packages/application/src/core/project-source-discovery.ts packages/application/src/core/automation-service.ts tests/integration/automation-source-discovery.test.ts
git commit -m "feat: discover project context sources"
```

## Task 11: Convert the UI to Review-First Automation

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`
- Test: `tests/e2e/automation-review.spec.ts`

- [ ] **Step 1: Write the Playwright workflow test**

Assert that Overview shows scheduler state, Sessions shows daemon-owned sync, Review Inbox renders a candidate with Evidence source, accepting it creates a Context Item, and Settings can switch between OFF and SUGGEST_ONLY.

- [ ] **Step 2: Run and confirm failure**

Run: `npx playwright test tests/e2e/automation-review.spec.ts`  
Expected: FAIL because automation controls are absent.

- [ ] **Step 3: Add typed frontend API calls**

Load automation status and pending candidates with the existing request helpers. Keep explicit loading, empty and error states. Poll status only for display; polling must not execute synchronization.

- [ ] **Step 4: Update existing pages**

Add compact automation health to Overview, source badges to Sessions/Context, candidate actions to Review Inbox, and mode/interval controls to Settings and Projects. Do not add a new top-level page or nested cards.

- [ ] **Step 5: Remove frontend ownership of sync scheduling**

Replace the Sessions-page interval action with persisted enable/disable controls. Preserve “Sync now” as an explicit command.

- [ ] **Step 6: Run frontend verification**

Run: `npm run frontend:typecheck`  
Run: `npx playwright test tests/e2e/automation-review.spec.ts`  
Expected: typecheck exits 0 and the workflow passes at desktop and mobile project viewports.

- [ ] **Step 7: Commit the review-first UI**

```powershell
git add frontend/src/App.tsx frontend/src/styles.css tests/e2e/automation-review.spec.ts
git commit -m "feat: add review-first automation UI"
```

## Task 12: Verify Context Package Integration and Document Operations

**Files:**
- Modify: `tests/integration/runtime-api.test.ts`
- Modify: `CONTEXTOS_USAGE.md`
- Modify: `README.md`
- Create: `docs/2026-09-20-zero-input-automation-operations.md`

- [ ] **Step 1: Add the Context Package acceptance test**

Create Evidence and a pending Context Item candidate, assert it is absent from a package, accept it, create a new Session/Package, and assert the active item plus source Evidence are selected with deterministic reasons.

- [ ] **Step 2: Run and confirm the new assertion fails before final wiring**

Run: `npx vitest run tests/integration/runtime-api.test.ts`  
Expected: FAIL until accepted candidates are applied through the existing context services.

- [ ] **Step 3: Complete package application wiring**

Ensure candidate acceptance creates the Context Item with `sourceSnapshotId`, activates it, records the target ID, and leaves previously created packages immutable.

- [ ] **Step 4: Write operations documentation**

Document modes, scheduler lifecycle, retry behavior, status API, safe shutdown, extraction availability, data locations, manual fallback and how to disable automation without deleting evidence.

- [ ] **Step 5: Update user documentation**

Change the recommended workflow from manual Session/Source creation to project confirmation plus candidate review. Preserve a separate manual workflow for OFF mode.

- [ ] **Step 6: Run the full verification suite**

Run: `npm test`  
Run: `npm run build:all`  
Run: `npx playwright test tests/e2e/automation-review.spec.ts`  
Expected: all tests pass, both TypeScript builds exit 0, and the E2E workflow passes.

- [ ] **Step 7: Perform a real local smoke test**

With a temporary ContextOS data directory and a disposable Codex thread:

1. register the ContextOS Project once;
2. confirm the daemon creates and binds a Session;
3. append a complete user/assistant turn;
4. close the browser and confirm Evidence plus a candidate still appear;
5. accept the candidate and confirm the next Context Package includes it;
6. restart the daemon and confirm no duplicate resources are created.

- [ ] **Step 8: Commit integration and documentation**

```powershell
git add tests/integration/runtime-api.test.ts CONTEXTOS_USAGE.md README.md docs/2026-09-20-zero-input-automation-operations.md
git commit -m "docs: document zero-input automation operations"
```

## Completion Gate

- [ ] `npm test` passes.
- [ ] `npm run build:all` passes.
- [ ] Automation E2E passes.
- [ ] OFF mode preserves the complete manual workflow.
- [ ] Browser closure does not stop daemon synchronization.
- [ ] Restart recovery creates no duplicate Session, Evidence or Candidate.
- [ ] No transcript content or secret appears in logs, settings responses or job payload summaries.
- [ ] Pending candidates are excluded from Context Packages.
- [ ] Accepted candidates retain Evidence provenance.
- [ ] README, usage guide and operations guide agree with runtime behavior.

