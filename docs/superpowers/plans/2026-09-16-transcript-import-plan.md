# Transcript Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Session-scoped API that stores supplied Codex transcript text as project-partitioned Evidence and updates the Resume Capsule atomically.

**Architecture:** Extend the existing Session route and service chain. The runtime service writes the file, a repository transaction persists Evidence plus Activity/Audit and Capsule state, and a failed transaction removes only the new file.

**Tech Stack:** TypeScript, Fastify, Zod, better-sqlite3, Vitest, Node.js filesystem APIs.

---

## File Map

- `packages/contracts/src/sessions.ts`: request and response types.
- `apps/daemon/src/http/routes/core-resources.ts`: HTTP endpoint.
- `packages/application/src/core/core-services.ts`: Session lookup and delegation.
- `packages/application/src/core/runtime-services.ts`: import orchestration.
- `packages/infrastructure/src/evidence/evidence-store.ts`: constrained failed-write cleanup.
- `packages/infrastructure/src/sqlite/runtime-repository.ts`: transactional persistence.
- `tests/integration/transcript-import-api.test.ts`: end-to-end coverage.
- Status and roadmap docs: record the completed first pass and remaining boundaries.

### Task 1: API Contract And Route

**Files:**
- Modify: `packages/contracts/src/sessions.ts`
- Modify: `apps/daemon/src/http/routes/core-resources.ts`

- [x] **Step 1: Add contract types**

Add a type-only `EvidenceSnapshotDto` import and these definitions:

```ts
export const transcriptImportInputSchema = z.object({
  contentText: z.string().max(1_000_000).refine((value) => value.trim().length > 0, "Transcript text is required"),
  summary: z.string().refine((value) => value.trim().length > 0, "Summary must not be blank").optional(),
  title: z.string().refine((value) => value.trim().length > 0, "Title must not be blank").optional()
});

export type TranscriptImportInput = z.infer<typeof transcriptImportInputSchema>;
export type TranscriptImportResult = {
  evidence: EvidenceSnapshotDto;
  resumeCapsule: ResumeCapsuleDto;
};
```

- [x] **Step 2: Register the route**

Import the schema and add:

```ts
server.post("/api/sessions/:id/import-transcript", async (request, reply) => {
  const { id } = paramsWithIdSchema.parse(request.params);
  const result = services.sessions.importTranscript(id, transcriptImportInputSchema.parse(request.body));
  reply.code(201);
  return result;
});
```

The global POST idempotency hook remains the only replay mechanism.

### Task 2: Runtime Orchestration And Cleanup

**Files:**
- Modify: `packages/infrastructure/src/evidence/evidence-store.ts`
- Modify: `packages/application/src/core/core-services.ts`
- Modify: `packages/application/src/core/runtime-services.ts`

- [x] **Step 1: Add constrained Evidence removal**

Import `resolve`, `relative`, and `isAbsolute`. Add:

```ts
remove(storageRef: string): void {
  const evidenceRoot = resolve(this.rootDir, "evidence");
  const target = resolve(this.rootDir, storageRef);
  const relativeTarget = relative(evidenceRoot, target);
  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new ContextOsError("INVALID_ARGUMENT", "Evidence storageRef is outside the evidence root");
  }
  rmSync(target, { force: true });
}
```

Never recursively delete and never remove directories.

- [x] **Step 2: Add Session delegation**

Import the transcript types and add:

```ts
importTranscript(id: string, input: TranscriptImportInput): TranscriptImportResult {
  if (!this.continueSession) throw new Error("Continue session runtime is not configured");
  return this.continueSession.importTranscript(this.sessions.getByIdOrThrow(id), input);
}
```

Do not reject ended Sessions or archived Projects.

- [x] **Step 3: Add runtime orchestration**

Add a method that requires the Evidence Store, generates `ev_*`, writes exact `contentText` using `projectId`, and calls:

```ts
this.runtime.importSessionTranscript({
  id: evidenceId,
  projectId: session.projectId,
  sessionId: session.id,
  title: input.title ?? "Imported Codex transcript",
  summary: input.summary ?? "Imported transcript captured.",
  contentHash: stored.contentHash,
  storageRef: stored.storageRef,
  sizeBytes: stored.sizeBytes
}, nowMs());
```

Wrap only the repository call in `try/catch`; on failure attempt `evidenceStore.remove(stored.storageRef)` and rethrow the original database error even if cleanup itself fails.

### Task 3: Transactional Persistence

**Files:**
- Modify: `packages/infrastructure/src/sqlite/runtime-repository.ts`

- [x] **Step 1: Add `importSessionTranscript`**

Use one `this.db.transaction` to:

1. Read the current Session row and Capsule.
2. Insert `evidence_snapshots` as `AGENT_OUTPUT` with metadata `{ sessionId, stream: "imported-transcript", importedAt }`.
3. Insert Session Activity and Audit records named `TRANSCRIPT_IMPORTED`, referencing the Evidence ID.
4. Update `runtime_state`, `last_activity_at`, and `updated_at`, incrementing revision without mutating Session status.

The next Capsule is:

```ts
const next: ResumeCapsuleDto = {
  sessionId: input.sessionId,
  status: input.sessionStatus,
  intent: row.intent,
  summary: input.summary,
  nextAction: current?.nextAction ?? null,
  lastRunId: current?.lastRunId ?? null,
  evidenceSnapshotIds: [...new Set([...(current?.evidenceSnapshotIds ?? []), input.id])],
  updatedAt: new Date(now).toISOString()
};
```

Return `{ evidence, resumeCapsule: next }`. Reuse `mapEvidenceSnapshot` through a focused private lookup.

- [x] **Step 2: Share Capsule parsing**

Extract existing `runtime_state` parsing into a private nullable helper used by both `getResumeCapsule` and import. Preserve the existing default Capsule behavior when no prior Capsule exists; do not add a migration.

### Task 4: Integration Coverage

**Files:**
- Create: `tests/integration/transcript-import-api.test.ts`

- [x] **Step 1: Test successful historical import**

Create a Project and Session, complete a short run, capture the prior Capsule, then import explicit text/title/summary. Assert HTTP 201, exact file contents, verifiable Evidence, `AGENT_OUTPUT`, project-partitioned path, `imported-transcript` metadata, `COMPLETED` status preservation, prior `lastRunId`, and appended Evidence IDs. Query SQLite readonly for one Activity and one Audit event.

- [x] **Step 2: Test defaults, validation, and idempotency**

Assert omitted title/summary use `Imported Codex transcript` and `Imported transcript captured.`. Assert whitespace-only `contentText`, `summary`, and `title` each return 400. Repeat a request with `Idempotency-Key: transcript-import-0001`; assert HTTP 201, `x-idempotent-replay: true`, the same Evidence ID, and one imported Evidence row.

- [x] **Step 3: Run focused tests**

```powershell
npm test -- --run tests/integration/transcript-import-api.test.ts tests/integration/runtime-api.test.ts tests/integration/evidence-store.test.ts
```

Expected: all selected files pass with zero failures.

### Task 5: Documentation And Full Verification

**Files:**
- Modify: `docs/2026-09-16-contextos-complete-status-and-roadmap.md`
- Modify: `docs/superpowers/plans/2026-09-16-contextos-backend-completion-plan.md`

- [x] **Step 1: Synchronize status docs**

Mark manual text transcript import as first-pass complete. Keep Codex file discovery, live bridging, role parsing, and frontend import UI explicitly pending.

- [x] **Step 2: Run full verification**

```powershell
npm run build
npm run frontend:build
npm test
git diff --check
```

Expected: every command exits 0 and Vitest reports zero failures.

- [x] **Step 3: Review the final diff**

Run `git status --short`, `git diff --stat`, and a scoped `git diff` over the files above. Confirm transcript import changes coexist with the pre-existing daemon lock and Evidence partition work. Do not create an implementation commit unless the user asks.
