import type {
  ContextItemDto,
  ContextItemInput,
  ContextItemPatch,
  ContextItemStatus,
  ContextSourceDto,
  ContextSourceInput,
  ContextSourcePatch,
  ContextSourceStatus,
  EvidenceSnapshotDto,
  EvidenceSnapshotInput
} from "../../../contracts/src/context.js";
import type { FileEvidenceStore, StoredEvidence } from "../../../infrastructure/src/evidence/evidence-store.js";
import type {
  SqliteContextItemRepository,
  SqliteContextSourceRepository,
  SqliteEvidenceSnapshotRepository
} from "../../../infrastructure/src/sqlite/context-repositories.js";
import { nowMs } from "../../../shared/src/clock.js";
import { newId } from "../../../shared/src/id.js";

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
    private readonly evidenceStore?: FileEvidenceStore
  ) {}

  create(input: EvidenceSnapshotInput): EvidenceSnapshotDto {
    const stored: StoredEvidence | undefined = input.contentText && this.evidenceStore
      ? this.evidenceStore.writeText({ snapshotId: newId("evblob"), contentText: input.contentText, contentHash: input.contentHash })
      : undefined;
    return this.snapshots.create(input, nowMs(), stored);
  }

  list(input: { projectId?: string; sourceId?: string; q?: string; limit: number }): EvidenceSnapshotDto[] {
    return this.snapshots.list(input);
  }

  get(id: string): EvidenceSnapshotDto {
    return this.snapshots.getByIdOrThrow(id);
  }
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
