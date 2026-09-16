import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ContextItemDto,
  ContextItemInput,
  ContextItemPatch,
  ContextItemStatus,
  ContextItemVersionDto,
  ContextSourceDto,
  ContextSourceInput,
  ContextSourcePatch,
  ContextSourceStatus,
  ContextSourceSyncResult,
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
import type { SqliteProjectRepository } from "../../../infrastructure/src/sqlite/project-repository.js";
import { nowMs } from "../../../shared/src/clock.js";
import { newId } from "../../../shared/src/id.js";
import { ContextOsError } from "../../../shared/src/errors.js";

export class ContextSourceService {
  constructor(
    private readonly sources: SqliteContextSourceRepository,
    private readonly snapshots: SqliteEvidenceSnapshotRepository,
    private readonly projects: SqliteProjectRepository,
    private readonly evidenceStore: FileEvidenceStore
  ) {}

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

  sync(id: string, expectedRevision: number): ContextSourceSyncResult {
    const source = this.sources.getByIdOrThrow(id);
    if (source.revision !== expectedRevision) {
      throw new ContextOsError("CONFLICT", "Context Source revision conflict", {
        id,
        expectedRevision,
        currentRevision: source.revision
      });
    }
    if (source.status !== "ACTIVE") {
      throw new ContextOsError("CONFLICT", "Only active Context Sources can be synced", { id, status: source.status });
    }
    if (source.sourceType !== "FILE") {
      throw new ContextOsError("INVALID_ARGUMENT", "Only FILE Context Sources can be synced", { id, sourceType: source.sourceType });
    }

    const project = this.projects.getByIdOrThrow(source.projectId);
    const sourcePath = resolveSourceFile(project.rootPath, source.locator);
    let contentText: string;
    try {
      if (!statSync(sourcePath).isFile()) {
        throw new ContextOsError("INVALID_ARGUMENT", "Context Source locator must identify a file", { id, locator: source.locator });
      }
      contentText = readFileSync(sourcePath, "utf8");
    } catch (error) {
      if (error instanceof ContextOsError) throw error;
      throw new ContextOsError("INVALID_ARGUMENT", "Context Source file could not be read", { id, locator: source.locator });
    }

    const contentHash = `sha256:${createHash("sha256").update(contentText, "utf8").digest("hex")}`;
    const existing = this.snapshots.findByProjectAndContentHash(source.projectId, contentHash);
    if (existing) {
      return this.snapshots.completeSourceSync({
        sourceId: id,
        expectedRevision,
        snapshotId: existing.id,
        reused: true
      }, nowMs());
    }

    const snapshotId = newId("ev");
    const stored = this.evidenceStore.writeText({ snapshotId, projectId: source.projectId, contentText, contentHash });
    try {
      return this.snapshots.completeSourceSync({
        sourceId: id,
        expectedRevision,
        snapshotId,
        snapshotInput: {
          projectId: source.projectId,
          sourceId: id,
          evidenceType: "FILE",
          title: source.name,
          uri: source.locator,
          contentHash,
          metadata: { sourceType: source.sourceType, locator: source.locator }
        },
        stored,
        reused: false
      }, nowMs());
    } catch (error) {
      try {
        this.evidenceStore.remove(stored.storageRef);
      } catch {
        // Preserve the database failure that caused the rollback.
      }
      throw error;
    }
  }
}

function resolveSourceFile(rootPath: string, locator: string): string {
  const resolvedRoot = resolve(rootPath);
  const candidate = resolve(resolvedRoot, locator);
  assertContained(resolvedRoot, candidate, locator);

  let realRoot: string;
  try {
    realRoot = realpathSync(resolvedRoot);
  } catch {
    throw new ContextOsError("INVALID_ARGUMENT", "Project root path could not be resolved", { rootPath });
  }

  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    throw new ContextOsError("INVALID_ARGUMENT", "Context Source file does not exist", { locator });
  }
  assertContained(realRoot, realCandidate, locator);
  return realCandidate;
}

function assertContained(rootPath: string, candidatePath: string, locator: string): void {
  const relativePath = relative(rootPath, candidatePath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new ContextOsError("INVALID_ARGUMENT", "Context Source locator is outside the Project root", { locator });
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

  recoverStoredEvidence(): { snapshotsChecked: number; missingFilesDetected: number; mismatchedFilesDetected: number } {
    const snapshots = this.snapshots.listStoredForRecovery();
    let missingFilesDetected = 0;
    let mismatchedFilesDetected = 0;
    for (const snapshot of snapshots) {
      const verification = this.verify(snapshot.id);
      if (verification.failureCode === "FILE_MISSING") missingFilesDetected += 1;
      if (verification.failureCode === "CONTENT_MISMATCH") mismatchedFilesDetected += 1;
    }
    return { snapshotsChecked: snapshots.length, missingFilesDetected, mismatchedFilesDetected };
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

  versions(id: string): ContextItemVersionDto[] {
    return this.items.listVersions(id);
  }

  patch(id: string, input: ContextItemPatch): ContextItemDto {
    return this.items.patch(id, input, nowMs());
  }

  transition(id: string, action: "activate" | "mark-stale" | "archive", expectedRevision: number): ContextItemDto {
    const status: ContextItemStatus = action === "activate" ? "ACTIVE" : action === "mark-stale" ? "STALE" : "ARCHIVED";
    return this.items.updateStatus(id, status, expectedRevision, nowMs());
  }
}

