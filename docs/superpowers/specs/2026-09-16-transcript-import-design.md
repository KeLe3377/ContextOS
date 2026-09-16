# ContextOS Transcript Import Design

Date: 2026-09-16

## Goal

Add a deterministic first-pass API for manually importing transcript text into an existing ContextOS Session. The import preserves the transcript as project-partitioned Evidence and updates the Session Resume Capsule without launching an agent or changing the Session lifecycle state.

## Scope

The first pass accepts transcript text supplied directly by the caller. It does not discover Codex transcript files, parse message roles, summarize with an LLM, import live output, or add frontend UI.

Imports are allowed for Sessions in every lifecycle state, including `COMPLETED`, `FAILED`, and `ARCHIVED`, because this operation records historical evidence rather than resuming execution.

## API Contract

Add:

```text
POST /api/sessions/:id/import-transcript
```

Request body:

```json
{
  "contentText": "required non-empty transcript text",
  "summary": "optional caller-supplied Resume Capsule summary",
  "title": "optional Evidence title"
}
```

Contract rules:

- `contentText` is trimmed only for non-empty validation; stored bytes preserve the submitted text exactly.
- `contentText` has a maximum length of 1,000,000 characters. Fastify's existing request body limit remains an earlier transport-level bound where applicable.
- `summary`, when supplied, must contain non-whitespace text and is stored as supplied.
- Missing `summary` becomes `Imported transcript captured.`.
- Missing `title` becomes `Imported Codex transcript`.
- A missing Session returns the existing `NOT_FOUND` error envelope.
- Success returns HTTP 201 with `{ evidence, resumeCapsule }`.
- Existing global `Idempotency-Key` behavior applies to this POST endpoint without a route-specific mechanism.

## Application Flow

`SessionService` exposes the Session-scoped operation and delegates to `ContinueSessionService.importTranscript`. The runtime service:

1. Resolves the Session and its Project.
2. Writes the exact transcript text through `FileEvidenceStore` using the Session project ID.
3. Calls one repository transaction that inserts the Evidence row, records Session Activity and Audit events, and updates the Resume Capsule.
4. Returns the created Evidence and updated Resume Capsule.

The Evidence row uses:

- `evidenceType = AGENT_OUTPUT`
- project-partitioned `storageRef`
- metadata `sessionId`
- metadata `stream = imported-transcript`
- metadata `importedAt` as an ISO timestamp

Activity and Audit use the action/event name `TRANSCRIPT_IMPORTED` and reference the Evidence ID in metadata.

## Resume Capsule Behavior

Import does not change the Session status. The updated Capsule:

- copies the Session's current status;
- uses the supplied summary or the deterministic default;
- preserves the previous `lastRunId`;
- preserves existing Evidence IDs in order and appends the imported Evidence ID once;
- keeps the existing `nextAction` value.

If no prior Capsule exists, existing repository defaults apply for `lastRunId`, `nextAction`, and the initial Evidence list.

## Failure And Consistency

File creation happens before the SQLite transaction because the database row must not reference an absent file. If the database transaction fails, the service removes only the newly created Evidence file and rethrows the original error. Existing Evidence and Capsule state remain unchanged.

`FileEvidenceStore` gains a narrowly scoped removal operation that accepts the `storageRef` returned by the same write. It must keep path resolution inside the configured Evidence root.

## Verification

Integration coverage must prove:

- a transcript creates verifiable project-partitioned Evidence;
- metadata identifies `imported-transcript` and the Session;
- supplied and default summaries behave as specified;
- existing Capsule Evidence IDs and `lastRunId` are preserved;
- a completed Session accepts an import without status mutation;
- empty transcript text is rejected;
- repeated requests with the same `Idempotency-Key` replay rather than duplicate Evidence.

Run the focused integration tests, the full test suite, TypeScript build, frontend syntax check, and `git diff --check` before completion.
