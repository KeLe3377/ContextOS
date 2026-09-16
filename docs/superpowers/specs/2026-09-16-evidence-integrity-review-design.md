# Evidence Integrity Review Design

Date: 2026-09-16

## Goal

Turn actionable Evidence verification failures into durable Review Items without producing duplicate alerts on repeated verification. Keep Review resolution under the existing human review workflow.

## Scope

The first pass applies only when `POST /api/evidence-snapshots/:id/verify` returns:

- `FILE_MISSING`
- `CONTENT_MISMATCH`

`NO_STORAGE_REF` and `EVIDENCE_STORE_UNAVAILABLE` remain verification results without automatic Review Items. They describe missing persistence configuration or an Evidence record without a file reference rather than detected corruption of a stored file.

Successful verification does not automatically resolve or dismiss an existing Review Item. Closing a Review Item still requires the existing resolution reason and audit path.

## API Contract

The verify endpoint keeps its existing HTTP status and verification fields and adds:

```ts
type EvidenceVerificationResult = EvidenceVerification & {
  reviewItem: ReviewItemDto | null;
};
```

Behavior:

- Verified Evidence returns `reviewItem: null`.
- `FILE_MISSING` returns the created or reused Review Item.
- `CONTENT_MISMATCH` returns the created or reused Review Item.
- Other verification failures return `reviewItem: null`.
- Global `Idempotency-Key` behavior remains available but is not required for deduplication.

## Review Item Mapping

All generated items use `sourceType = EVIDENCE_SNAPSHOT` and `sourceId = snapshot.id`.

| Verification failure | triggerType | priority | summary intent |
|---|---|---|---|
| `FILE_MISSING` | `EVIDENCE_FILE_MISSING` | `HIGH` | Stored Evidence file is missing |
| `CONTENT_MISMATCH` | `EVIDENCE_CONTENT_MISMATCH` | `URGENT` | Stored Evidence content does not match recorded integrity metadata |

The proposed resolution for a missing file recommends restoring the original immutable file or recapturing Evidence as a new Snapshot. The mismatch resolution recommends preserving the suspect file for investigation and recapturing trusted content as a new Snapshot rather than overwriting it.

## Deduplication

The repository looks for the newest Review Item matching:

```text
source_type = EVIDENCE_SNAPSHOT
source_id = <snapshot id>
trigger_type = <mapped failure trigger>
status IN (OPEN, IN_PROGRESS)
```

If found, it returns that item unchanged. If not found, it creates a new `OPEN` item. Therefore:

- repeated verification of the same active failure reuses one item;
- a different failure type creates a separate item;
- a failure that recurs after the previous item was `RESOLVED` or `DISMISSED` creates a new item.

## Components And Data Flow

`EvidenceSnapshotService` owns the orchestration because it already combines Snapshot metadata with file verification. It receives `SqliteReviewItemRepository` as an optional dependency, preserving direct unit construction compatibility.

For an actionable failure:

1. Load the Evidence Snapshot.
2. Verify its file through `FileEvidenceStore`.
3. Map the failure code to Review Item fields.
4. Call `findOrCreateOpenEvidenceIssue` on the Review Repository.
5. Return the verification fields plus the Review Item.

`createDaemonServer` passes the existing shared Review Repository to `EvidenceSnapshotService`; no new repository instance or migration is required.

## Persistence And Audit

`findOrCreateOpenEvidenceIssue` uses one SQLite transaction. When it creates a Review Item, the same transaction also records:

- a Project Activity Event with `resourceType = EVIDENCE_SNAPSHOT`, the Snapshot ID, and an event type matching the trigger;
- a system Audit Event for `REVIEW_ITEM` creation containing the generated Review Item.

Reusing an existing active Review Item does not append duplicate Activity or Audit records.

## Error Handling

- A missing Snapshot keeps the existing `NOT_FOUND` response.
- Review Item persistence failures fail the verify request rather than silently returning an untracked integrity failure.
- The filesystem result is never rewritten or weakened to make Review creation succeed.
- No Evidence file is modified or deleted by verification.

## Verification

Integration tests must prove:

- successful verification returns `reviewItem: null`;
- missing files create a `HIGH` Review Item with the expected mapping;
- hash or size mismatches create an `URGENT` Review Item;
- repeated verification reuses the same active Review Item and creates only one Activity/Audit record;
- resolving the item and verifying the still-broken Evidence creates a new Review Item;
- `NO_STORAGE_REF` does not create a Review Item.

Run focused integration tests, the full suite, TypeScript build, frontend syntax check, and `git diff --check` before the implementation commit.
