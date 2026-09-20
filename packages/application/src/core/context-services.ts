import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { diffLines } from "diff";
import type {
  ContextItemDto,
  ContextItemInput,
  ContextItemPatch,
  ContextItemStatus,
  ContextItemVersionDto,
  ContextItemVersionRestoreResult,
  ContextSourceDto,
  ContextSourceInput,
  ContextSourcePatch,
  ContextSourceStatus,
  ContextSourceSyncResult,
  EvidenceSnapshotCompareDto,
  EvidenceSnapshotContentCompareDto,
  EvidenceSnapshotContentDto,
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

/**
 * An agent-output Evidence blob that has been written to disk but whose Snapshot row has not
 * been inserted yet, so a wider transaction can own the row.
 */
export type PreparedAgentOutput = {
  projectId: string;
  sessionId: string;
  stream: string;
  title: string;
  contentText: string;
  metadata: Record<string, unknown>;
  contentHash: string;
  /** Blob written for this snapshot, or null when there was nothing new to write. */
  stored: StoredEvidence | null;
  /** Set when identical content is already captured for this Project, Session and stream. */
  existing: EvidenceSnapshotDto | null;
};

function hashText(contentText: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(contentText, "utf8")).digest("hex")}`;
}

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

  /**
   * Writes the Evidence blob and computes its identity WITHOUT touching the database, so the
   * caller can include the Snapshot row in a wider transaction (see AutomationService).
   *
   * Returns `existing` when the same content is already captured for this Project, Session and
   * stream; in that case nothing is written and the caller only advances its own state.
   */
  prepareAgentOutput(input: {
    projectId: string;
    sessionId: string;
    stream: string;
    title: string;
    contentText: string;
    metadata: Record<string, unknown>;
  }): PreparedAgentOutput {
    const contentHash = hashText(input.contentText);
    const existing = this.snapshots.findAgentOutput({
      projectId: input.projectId,
      sessionId: input.sessionId,
      stream: input.stream,
      contentHash
    });
    if (existing) return { ...input, contentHash, stored: null, existing };

    const stored = this.evidenceStore
      ? this.evidenceStore.writeText({ snapshotId: newId("evblob"), projectId: input.projectId, contentText: input.contentText, contentHash })
      : null;
    return { ...input, contentHash, stored, existing: null };
  }

  /**
   * Inserts the Snapshot row for a prepared output.
   *
   * Blob-backed Evidence keeps its payload exactly once, in the Evidence Store: the row holds the
   * content hash and the storage reference, and `content_text` stays NULL. Without a store the
   * text stays inline, because a row with neither a blob nor inline text could never be read back.
   *
   * Safe to call inside an outer transaction: the row only becomes visible when that
   * transaction commits, which is what keeps the Snapshot and the reader offset in step.
   */
  commitPreparedAgentOutput(prepared: PreparedAgentOutput): EvidenceSnapshotDto {
    if (prepared.existing) return prepared.existing;
    return this.snapshots.create(
      {
        projectId: prepared.projectId,
        evidenceType: "AGENT_OUTPUT",
        title: prepared.title,
        contentText: prepared.stored ? undefined : prepared.contentText,
        contentHash: prepared.contentHash,
        // sessionId and stream are written from the identity fields, so the stored metadata can
        // never disagree with the values the deduplication lookup filters on.
        metadata: { ...prepared.metadata, sessionId: prepared.sessionId, stream: prepared.stream }
      },
      nowMs(),
      prepared.stored ?? undefined
    );
  }

  /**
   * Removes the blob written by `prepareAgentOutput` after the surrounding transaction failed,
   * so a rolled-back ingestion never leaves an unreferenced file behind.
   */
  discardPreparedAgentOutput(prepared: PreparedAgentOutput): void {
    if (!prepared.stored || !this.evidenceStore) return;
    this.evidenceStore.remove(prepared.stored.storageRef);
  }

  list(input: { projectId?: string; sourceId?: string; q?: string; limit: number }): EvidenceSnapshotDto[] {
    return this.snapshots.list(input);
  }

  get(id: string): EvidenceSnapshotDto {
    return this.snapshots.getByIdOrThrow(id);
  }

  /**
   * The complete, integrity-verified text of a Snapshot, for internal consumers that must read
   * the whole payload — the transcript event codec cannot work on a truncated prefix.
   *
   * Storage-backed Evidence goes through the Evidence Store with its hash and size verified;
   * inline Evidence stays supported; a mismatch or a missing file fails loudly rather than
   * returning partial or unverified content.
   */
  readFullText(id: string): { snapshot: EvidenceSnapshotDto; contentText: string } {
    const snapshot = this.snapshots.getByIdOrThrow(id);
    return { snapshot, contentText: this.readSnapshotContent(snapshot) };
  }

  content(id: string, maxChars: number): EvidenceSnapshotContentDto {
    const snapshot = this.snapshots.getByIdOrThrow(id);
    const contentText = this.readSnapshotContent(snapshot);
    const returnedText = contentText.slice(0, maxChars);
    return {
      snapshotId: snapshot.id,
      projectId: snapshot.projectId,
      title: snapshot.title,
      evidenceType: snapshot.evidenceType,
      contentText: returnedText,
      contentHash: snapshot.contentHash,
      storageRef: snapshot.storageRef,
      sizeBytes: snapshot.sizeBytes,
      returnedChars: returnedText.length,
      totalChars: contentText.length,
      truncated: returnedText.length < contentText.length
    };
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
    assertSameProject(base, other);

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

  compareContent(baseSnapshotId: string, otherSnapshotId: string, maxChars: number): EvidenceSnapshotContentCompareDto {
    const base = this.snapshots.getByIdOrThrow(baseSnapshotId);
    const other = this.snapshots.getByIdOrThrow(otherSnapshotId);
    assertSameProject(base, other);
    const baseText = this.readSnapshotContent(base);
    const otherText = this.readSnapshotContent(other);
    const parts = diffLines(baseText, otherText);
    let baseLine = 1;
    let otherLine = 1;
    let addedLines = 0;
    let removedLines = 0;
    let remainingChars = maxChars;
    let truncated = false;
    const changes: EvidenceSnapshotContentCompareDto["changes"] = [];

    for (const part of parts) {
      const lineCount = part.count ?? countLines(part.value);
      if (!part.added && !part.removed) {
        baseLine += lineCount;
        otherLine += lineCount;
        continue;
      }
      if (part.added) addedLines += lineCount;
      if (part.removed) removedLines += lineCount;
      const text = part.value.slice(0, remainingChars);
      const partTruncated = text.length < part.value.length;
      if (text.length > 0) {
        changes.push({
          kind: part.added ? "ADDED" : "REMOVED",
          baseStartLine: baseLine,
          otherStartLine: otherLine,
          lineCount,
          text,
          truncated: partTruncated
        });
        remainingChars -= text.length;
      }
      if (partTruncated || text.length === 0) truncated = true;
      if (part.added) otherLine += lineCount;
      if (part.removed) baseLine += lineCount;
    }

    return {
      baseSnapshotId,
      otherSnapshotId,
      projectId: base.projectId,
      identical: baseText === otherText,
      addedLines,
      removedLines,
      changes,
      truncated
    };
  }

  private readSnapshotContent(snapshot: EvidenceSnapshotDto): string {
    if (!snapshot.storageRef) {
      if (snapshot.contentText !== null) {
        const bytes = Buffer.from(snapshot.contentText, "utf8");
        const actualHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        const sizeMatches = snapshot.sizeBytes === null || bytes.byteLength === snapshot.sizeBytes;
        if (actualHash !== snapshot.contentHash || !sizeMatches) {
          throw new ContextOsError("CONFLICT", "Evidence content failed integrity verification", { failureCode: "CONTENT_MISMATCH" });
        }
        return snapshot.contentText;
      }
      throw new ContextOsError("INVALID_ARGUMENT", "Evidence Snapshot has no comparable text content", { id: snapshot.id });
    }
    if (!this.evidenceStore) {
      throw new ContextOsError("INVALID_CONFIG", "Evidence store is not configured");
    }
    try {
      return this.evidenceStore.readVerifiedText({
        storageRef: snapshot.storageRef,
        expectedHash: snapshot.contentHash,
        expectedSizeBytes: snapshot.sizeBytes
      });
    } catch (error) {
      if (error instanceof ContextOsError && error.code === "CONFLICT") this.verify(snapshot.id);
      throw error;
    }
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

function assertSameProject(base: EvidenceSnapshotDto, other: EvidenceSnapshotDto): void {
  if (base.projectId !== other.projectId) {
    throw new ContextOsError("CONFLICT", "Evidence Snapshots must belong to the same project", {
      baseSnapshotId: base.id,
      otherSnapshotId: other.id
    });
  }
}

function countLines(value: string): number {
  if (!value) return 0;
  return value.split(/\r\n|\r|\n/).length - (value.endsWith("\n") || value.endsWith("\r") ? 1 : 0);
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

  restoreVersion(id: string, versionNumber: number, expectedRevision: number): ContextItemVersionRestoreResult {
    return this.items.restoreVersion(id, versionNumber, expectedRevision, nowMs());
  }

  transition(id: string, action: "activate" | "mark-stale" | "archive", expectedRevision: number): ContextItemDto {
    const status: ContextItemStatus = action === "activate" ? "ACTIVE" : action === "mark-stale" ? "STALE" : "ARCHIVED";
    return this.items.updateStatus(id, status, expectedRevision, nowMs());
  }
}

