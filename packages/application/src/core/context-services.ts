import type {
  ContextItemDto,
  ContextItemInput,
  ContextItemPatch,
  ContextItemStatus,
  ContextSourceDto,
  ContextSourceInput,
  ContextSourcePatch,
  ContextSourceStatus,
  EvidenceSnapshotCompareDto,
  EvidenceSnapshotDto,
  EvidenceSnapshotInput
} from "../../../contracts/src/context.js";
import type { ReviewItemDto, ReviewItemInput } from "../../../contracts/src/review-items.js";
import type { EvidenceVerification, FileEvidenceStore, StoredEvidence } from "../../../infrastructure/src/evidence/evidence-store.js";
import type { SqliteReviewItemRepository } from "../../../infrastructure/src/sqlite/core-repositories.js";
import type {
  SqliteContextItemRepository,
  SqliteContextSourceRepository,
  SqliteEvidenceSnapshotRepository
} from "../../../infrastructure/src/sqlite/context-repositories.js";
import { nowMs } from "../../../shared/src/clock.js";
import { newId } from "../../../shared/src/id.js";
import { ContextOsError } from "../../../shared/src/errors.js";

export class ContextSourceService {
  constructor(private readonly sources: SqliteContextSourceRepository) {}

  create(input: ContextSourceInput): ContextSourceDto {
    return this.sources.create(input, nowMs());
  }

  list(input: { projectId?: string; status?: string; q?: string; limit: number }): ContextSourceDto[] {
    return this.sources.list(input);
  }

  get(id: string): ContextSourceDto {
    return this.sources.getByIdOrThrow(id);
  }

  patch(id: string, input: ContextSourcePatch): ContextSourceDto {
    return this.sources.patch(id, input, nowMs());
  }

  transition(id: string, action: "resume" | "pause" | "archive", expectedRevision: number): ContextSourceDto {
    const status: ContextSourceStatus = action === "resume" ? "ACTIVE" : action === "pause" ? "PAUSED" : "ARCHIVED";
    return this.sources.updateStatus(id, status, expectedRevision, nowMs());
  }
}

export class EvidenceSnapshotService {
  constructor(
    private readonly snapshots: SqliteEvidenceSnapshotRepository,
    private readonly evidenceStore?: FileEvidenceStore,
    private readonly reviewItems?: SqliteReviewItemRepository
  ) {}

  create(input: EvidenceSnapshotInput): EvidenceSnapshotDto {
    const stored: StoredEvidence | undefined = input.contentText && this.evidenceStore
      ? this.evidenceStore.writeText({ snapshotId: newId("evblob"), projectId: input.projectId, contentText: input.contentText, contentHash: input.contentHash })
      : undefined;
    return this.snapshots.create(input, nowMs(), stored);
  }

  list(input: { projectId?: string; sourceId?: string; q?: string; limit: number }): EvidenceSnapshotDto[] {
    return this.snapshots.list(input);
  }

  get(id: string): EvidenceSnapshotDto {
    return this.snapshots.getByIdOrThrow(id);
  }

  verify(id: string): EvidenceVerification & { reviewItem: ReviewItemDto | null } {
    const snapshot = this.snapshots.getByIdOrThrow(id);
    if (!this.evidenceStore) {
      return {
        storageRef: snapshot.storageRef,
        exists: false,
        verified: false,
        expectedHash: snapshot.contentHash,
        actualHash: null,
        expectedSizeBytes: snapshot.sizeBytes,
        actualSizeBytes: null,
        failureCode: "EVIDENCE_STORE_UNAVAILABLE",
        failureMessage: "Evidence store is not configured",
        reviewItem: null
      };
    }
    const verification = this.evidenceStore.verify({
      storageRef: snapshot.storageRef,
      expectedHash: snapshot.contentHash,
      expectedSizeBytes: snapshot.sizeBytes
    });
    const reviewInput = evidenceReviewInput(snapshot, verification.failureCode);
    const reviewItem = reviewInput && this.reviewItems
      ? this.reviewItems.findOrCreateOpenEvidenceIssue(reviewInput, nowMs())
      : null;
    return { ...verification, reviewItem };
  }

  compare(baseSnapshotId: string, otherSnapshotId: string): EvidenceSnapshotCompareDto {
    const base = this.snapshots.getByIdOrThrow(baseSnapshotId);
    const other = this.snapshots.getByIdOrThrow(otherSnapshotId);
    if (base.projectId !== other.projectId) {
      throw new ContextOsError("CONFLICT", "Evidence Snapshots must belong to the same project", {
        baseSnapshotId,
        otherSnapshotId
      });
    }

    const fields = {
      contentHash: compareField(base.contentHash, other.contentHash),
      sizeBytes: compareField(base.sizeBytes, other.sizeBytes),
      evidenceType: compareField(base.evidenceType, other.evidenceType),
      sourceId: compareField(base.sourceId, other.sourceId)
    };
    const changedFields = (Object.keys(fields) as Array<keyof typeof fields>).filter((field) => !fields[field].same);
    return {
      baseSnapshotId,
      otherSnapshotId,
      projectId: base.projectId,
      identical: changedFields.length === 0,
      changedFields,
      fields
    };
  }
}

function compareField<T>(base: T, other: T): { base: T; other: T; same: boolean } {
  return { base, other, same: base === other };
}

function evidenceReviewInput(snapshot: EvidenceSnapshotDto, failureCode: string | null): ReviewItemInput | null {
  if (failureCode === "FILE_MISSING") {
    return {
      projectId: snapshot.projectId,
      sourceType: "EVIDENCE_SNAPSHOT",
      sourceId: snapshot.id,
      triggerType: "EVIDENCE_FILE_MISSING",
      priority: "HIGH",
      summary: `Evidence file is missing: ${snapshot.title}`,
      proposedResolution: "Restore the original immutable file or recapture the content as a new Evidence Snapshot."
    };
  }
  if (failureCode === "CONTENT_MISMATCH") {
    return {
      projectId: snapshot.projectId,
      sourceType: "EVIDENCE_SNAPSHOT",
      sourceId: snapshot.id,
      triggerType: "EVIDENCE_CONTENT_MISMATCH",
      priority: "URGENT",
      summary: `Evidence integrity mismatch: ${snapshot.title}`,
      proposedResolution: "Preserve the suspect file for investigation and recapture trusted content as a new Evidence Snapshot."
    };
  }
  return null;
}

export class ContextItemService {
  constructor(private readonly items: SqliteContextItemRepository) {}

  create(input: ContextItemInput): ContextItemDto {
    return this.items.create(input, nowMs());
  }

  list(input: { projectId?: string; status?: string; q?: string; limit: number }): ContextItemDto[] {
    return this.items.list(input);
  }

  get(id: string): ContextItemDto {
    return this.items.getByIdOrThrow(id);
  }

  patch(id: string, input: ContextItemPatch): ContextItemDto {
    return this.items.patch(id, input, nowMs());
  }

  transition(id: string, action: "activate" | "mark-stale" | "archive", expectedRevision: number): ContextItemDto {
    const status: ContextItemStatus = action === "activate" ? "ACTIVE" : action === "mark-stale" ? "STALE" : "ARCHIVED";
    return this.items.updateStatus(id, status, expectedRevision, nowMs());
  }
}

