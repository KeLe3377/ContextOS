import type { Database } from "better-sqlite3";
import type { StoredEvidence } from "../evidence/evidence-store.js";
import type {
  ContextConfidence,
  ContextItemDto,
  ContextItemInput,
  ContextItemPatch,
  ContextItemStatus,
  ContextItemVersionDto,
  ContextItemVersionRestoreResult,
  ContextItemType,
  ContextSourceDto,
  ContextSourceInput,
  ContextSourcePatch,
  ContextSourceSyncResult,
  ContextSourceStatus,
  ContextSourceType,
  EvidenceSnapshotDto,
  EvidenceSnapshotInput,
  EvidenceType
} from "../../../contracts/src/context.js";
import { ContextOsError } from "../../../shared/src/errors.js";
import { newId } from "../../../shared/src/id.js";

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function parseJsonObject(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

function ensureChanged(changes: number, exists: unknown, type: string, id: string, expectedRevision: number): void {
  if (changes > 0) return;
  if (!exists) throw new ContextOsError("NOT_FOUND", `${type} not found`, { id });
  throw new ContextOsError("CONFLICT", `${type} revision conflict`, { id, expectedRevision });
}

type ContextSourceRow = {
  id: string;
  project_id: string;
  source_type: ContextSourceType;
  name: string;
  locator: string;
  description: string | null;
  status: ContextSourceStatus;
  metadata_json: string;
  last_snapshot_id: string | null;
  last_checked_at: number | null;
  created_at: number;
  updated_at: number;
  revision: number;
  archived_at: number | null;
};

export class SqliteContextSourceRepository {
  constructor(private readonly db: Database) {}

  create(input: ContextSourceInput, now: number): ContextSourceDto {
    const id = newId("src");
    this.db.prepare("INSERT INTO context_sources (id, project_id, source_type, name, locator, description, status, metadata_json, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, 1)")
      .run(id, input.projectId, input.sourceType, input.name, input.locator, input.description ?? null, JSON.stringify(input.metadata), now, now);
    return this.getByIdOrThrow(id);
  }

  list(options: { projectId?: string; status?: string; q?: string; limit: number }): ContextSourceDto[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.projectId) { where.push("project_id = ?"); params.push(options.projectId); }
    if (options.status) { where.push("status = ?"); params.push(options.status); }
    if (options.q) { where.push("(name LIKE ? OR locator LIKE ?)"); params.push(`%${options.q}%`, `%${options.q}%`); }
    params.push(options.limit);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM context_sources ${whereSql} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...params) as ContextSourceRow[]).map(mapContextSource);
  }

  getById(id: string): ContextSourceDto | null {
    const row = this.db.prepare("SELECT * FROM context_sources WHERE id = ?").get(id) as ContextSourceRow | undefined;
    return row ? mapContextSource(row) : null;
  }

  getByIdOrThrow(id: string): ContextSourceDto {
    const item = this.getById(id);
    if (!item) throw new ContextOsError("NOT_FOUND", "Context Source not found", { id });
    return item;
  }

  patch(id: string, input: ContextSourcePatch, now: number): ContextSourceDto {
    const current = this.getByIdOrThrow(id);
    const result = this.db.prepare("UPDATE context_sources SET name = ?, description = ?, metadata_json = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
      .run(input.name ?? current.name, input.description ?? current.description, JSON.stringify(input.metadata ?? current.metadata), now, id, input.expectedRevision);
    ensureChanged(result.changes, current, "Context Source", id, input.expectedRevision);
    return this.getByIdOrThrow(id);
  }

  updateStatus(id: string, status: ContextSourceStatus, expectedRevision: number, now: number): ContextSourceDto {
    const archivedAt = status === "ARCHIVED" ? now : null;
    const result = this.db.prepare("UPDATE context_sources SET status = ?, archived_at = COALESCE(?, archived_at), updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
      .run(status, archivedAt, now, id, expectedRevision);
    ensureChanged(result.changes, this.getById(id), "Context Source", id, expectedRevision);
    return this.getByIdOrThrow(id);
  }
}

function mapContextSource(row: ContextSourceRow): ContextSourceDto {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceType: row.source_type,
    name: row.name,
    locator: row.locator,
    description: row.description,
    status: row.status,
    metadata: parseJsonObject(row.metadata_json),
    lastSnapshotId: row.last_snapshot_id,
    lastCheckedAt: iso(row.last_checked_at),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    revision: row.revision,
    archivedAt: iso(row.archived_at)
  };
}

type EvidenceSnapshotRow = {
  id: string;
  project_id: string;
  source_id: string | null;
  evidence_type: EvidenceType;
  title: string;
  uri: string | null;
  content_text: string | null;
  content_hash: string;
  storage_ref: string | null;
  size_bytes: number | null;
  metadata_json: string;
  captured_at: number;
  created_at: number;
};

export class SqliteEvidenceSnapshotRepository {
  constructor(private readonly db: Database) {}

  create(input: EvidenceSnapshotInput, now: number, stored?: StoredEvidence): EvidenceSnapshotDto {
    const id = newId("ev");
    const contentHash = stored?.contentHash ?? input.contentHash;
    if (!contentHash) throw new ContextOsError("INVALID_ARGUMENT", "Evidence Snapshot requires contentHash or contentText");
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO evidence_snapshots (id, project_id, source_id, evidence_type, title, uri, content_text, content_hash, storage_ref, size_bytes, metadata_json, captured_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, input.projectId, input.sourceId ?? null, input.evidenceType, input.title, input.uri ?? null, input.contentText ?? null, contentHash, stored?.storageRef ?? null, stored?.sizeBytes ?? null, JSON.stringify(input.metadata), now, now);
      if (input.sourceId) {
        this.db.prepare("UPDATE context_sources SET last_snapshot_id = ?, last_checked_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
          .run(id, now, now, input.sourceId);
      }
    })();
    return this.getByIdOrThrow(id);
  }

  list(options: { projectId?: string; sourceId?: string; q?: string; limit: number }): EvidenceSnapshotDto[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.projectId) { where.push("project_id = ?"); params.push(options.projectId); }
    if (options.sourceId) { where.push("source_id = ?"); params.push(options.sourceId); }
    if (options.q) { where.push("(title LIKE ? OR COALESCE(uri, '') LIKE ?)"); params.push(`%${options.q}%`, `%${options.q}%`); }
    params.push(options.limit);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM evidence_snapshots ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params) as EvidenceSnapshotRow[]).map(mapEvidenceSnapshot);
  }

  /**
   * The most recent batches of one stream for one Session, oldest first.
   *
   * Narrow on purpose: only the sync path needs it, and only to rebuild the continuity excerpt
   * from batches this daemon wrote. `limit` bounds how many blobs a single sync has to read.
   */
  listSessionStream(input: { projectId: string; sessionId: string; stream: string; limit: number }): EvidenceSnapshotDto[] {
    const rows = this.db.prepare(
      "SELECT * FROM evidence_snapshots WHERE project_id = ? AND json_extract(metadata_json, '$.sessionId') = ? AND json_extract(metadata_json, '$.stream') = ? ORDER BY created_at DESC, id DESC LIMIT ?"
    ).all(input.projectId, input.sessionId, input.stream, input.limit) as EvidenceSnapshotRow[];
    return rows.reverse().map(mapEvidenceSnapshot);
  }

  getById(id: string): EvidenceSnapshotDto | null {
    const row = this.db.prepare("SELECT * FROM evidence_snapshots WHERE id = ?").get(id) as EvidenceSnapshotRow | undefined;
    return row ? mapEvidenceSnapshot(row) : null;
  }

  getByIdOrThrow(id: string): EvidenceSnapshotDto {
    const item = this.getById(id);
    if (!item) throw new ContextOsError("NOT_FOUND", "Evidence Snapshot not found", { id });
    return item;
  }

  findByProjectAndContentHash(projectId: string, contentHash: string): EvidenceSnapshotDto | null {
    const row = this.db.prepare("SELECT * FROM evidence_snapshots WHERE project_id = ? AND content_hash = ?")
      .get(projectId, contentHash) as EvidenceSnapshotRow | undefined;
    return row ? mapEvidenceSnapshot(row) : null;
  }

  /**
   * Finds an automatically captured agent-output Snapshot by its full identity.
   *
   * The identity is Project + Session + stream + content hash: identical bytes legitimately
   * occur under a different Session or stream, and those must stay separate snapshots rather
   * than being folded into one another.
   */
  findAgentOutput(input: { projectId: string; sessionId: string; stream: string; contentHash: string }): EvidenceSnapshotDto | null {
    const row = this.db.prepare(
      `SELECT * FROM evidence_snapshots
        WHERE project_id = ? AND content_hash = ?
          AND json_extract(metadata_json, '$.sessionId') = ?
          AND json_extract(metadata_json, '$.stream') = ?
        ORDER BY created_at ASC, id ASC
        LIMIT 1`
    ).get(input.projectId, input.contentHash, input.sessionId, input.stream) as EvidenceSnapshotRow | undefined;
    return row ? mapEvidenceSnapshot(row) : null;
  }

  listStoredForRecovery(): EvidenceSnapshotDto[] {
    return (this.db.prepare("SELECT * FROM evidence_snapshots WHERE storage_ref IS NOT NULL ORDER BY created_at, id")
      .all() as EvidenceSnapshotRow[]).map(mapEvidenceSnapshot);
  }

  completeSourceSync(input: {
    sourceId: string;
    expectedRevision: number;
    snapshotId: string;
    snapshotInput?: EvidenceSnapshotInput;
    stored?: StoredEvidence;
    reused: boolean;
  }, now: number): ContextSourceSyncResult {
    const before = this.db.prepare("SELECT * FROM context_sources WHERE id = ?")
      .get(input.sourceId) as ContextSourceRow | undefined;
    if (!before) throw new ContextOsError("NOT_FOUND", "Context Source not found", { id: input.sourceId });

    this.db.transaction(() => {
      if (!input.reused) {
        const snapshot = input.snapshotInput;
        const contentHash = input.stored?.contentHash ?? snapshot?.contentHash;
        if (!snapshot || !contentHash) {
          throw new ContextOsError("INVALID_ARGUMENT", "New source sync snapshot requires content");
        }
        this.db.prepare("INSERT INTO evidence_snapshots (id, project_id, source_id, evidence_type, title, uri, content_text, content_hash, storage_ref, size_bytes, metadata_json, captured_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(input.snapshotId, snapshot.projectId, input.sourceId, snapshot.evidenceType, snapshot.title, snapshot.uri ?? null, snapshot.contentText ?? null, contentHash, input.stored?.storageRef ?? null, input.stored?.sizeBytes ?? null, JSON.stringify(snapshot.metadata), now, now);
      }

      const update = this.db.prepare("UPDATE context_sources SET last_snapshot_id = ?, last_checked_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND status = 'ACTIVE'")
        .run(input.snapshotId, now, now, input.sourceId, input.expectedRevision);
      ensureChanged(update.changes, before, "Context Source", input.sourceId, input.expectedRevision);

      const after = this.db.prepare("SELECT * FROM context_sources WHERE id = ?")
        .get(input.sourceId) as ContextSourceRow;
      const metadata = JSON.stringify({ snapshotId: input.snapshotId, reused: input.reused });
      this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'CONTEXT_SOURCE', ?, 'CONTEXT_SOURCE_SYNCED', 'Context Source synced', ?, ?)")
        .run(newId("act"), before.project_id, input.sourceId, metadata, now);
      this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, before_json, after_json, created_at) VALUES (?, ?, 'USER', 'CONTEXT_SOURCE', ?, 'SYNC', ?, ?, ?)")
        .run(newId("audit"), before.project_id, input.sourceId, JSON.stringify(mapContextSource(before)), JSON.stringify(mapContextSource(after)), now);
    })();

    return {
      source: mapContextSource(this.db.prepare("SELECT * FROM context_sources WHERE id = ?").get(input.sourceId) as ContextSourceRow),
      snapshot: this.getByIdOrThrow(input.snapshotId),
      reused: input.reused
    };
  }
}

function mapEvidenceSnapshot(row: EvidenceSnapshotRow): EvidenceSnapshotDto {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id,
    evidenceType: row.evidence_type,
    title: row.title,
    uri: row.uri,
    contentText: row.content_text,
    contentHash: row.content_hash,
    storageRef: row.storage_ref,
    sizeBytes: row.size_bytes,
    metadata: parseJsonObject(row.metadata_json),
    capturedAt: new Date(row.captured_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString()
  };
}
type ContextItemRow = {
  id: string;
  project_id: string;
  source_snapshot_id: string | null;
  item_type: ContextItemType;
  status: ContextItemStatus;
  title: string;
  summary: string;
  body: string | null;
  confidence: ContextConfidence;
  metadata_json: string;
  created_at: number;
  updated_at: number;
  revision: number;
  archived_at: number | null;
};

type ContextItemVersionRow = {
  id: string;
  context_item_id: string;
  version_number: number;
  title: string;
  summary: string;
  body: string | null;
  confidence: ContextConfidence;
  metadata_json: string;
  created_by_type: string;
  created_by_id: string | null;
  created_at: number;
};

export class SqliteContextItemRepository {
  constructor(private readonly db: Database) {}

  create(input: ContextItemInput, now: number): ContextItemDto {
    const id = newId("ctx");
    const versionId = newId("ctxv");
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO context_items (id, project_id, source_snapshot_id, item_type, status, title, summary, body, confidence, metadata_json, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, 1)")
        .run(id, input.projectId, input.sourceSnapshotId ?? null, input.itemType, input.title, input.summary, input.body ?? null, input.confidence, JSON.stringify(input.metadata), now, now);
      this.db.prepare("INSERT INTO context_item_versions (id, context_item_id, version_number, title, summary, body, confidence, metadata_json, created_by_type, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'USER', ?)")
        .run(versionId, id, input.title, input.summary, input.body ?? null, input.confidence, JSON.stringify(input.metadata), now);
    })();
    return this.getByIdOrThrow(id);
  }

  list(options: { projectId?: string; status?: string; q?: string; limit: number }): ContextItemDto[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.projectId) { where.push("project_id = ?"); params.push(options.projectId); }
    if (options.status) { where.push("status = ?"); params.push(options.status); }
    if (options.q) { where.push("(title LIKE ? OR summary LIKE ?)"); params.push(`%${options.q}%`, `%${options.q}%`); }
    params.push(options.limit);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM context_items ${whereSql} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...params) as ContextItemRow[]).map(mapContextItem);
  }

  getById(id: string): ContextItemDto | null {
    const row = this.db.prepare("SELECT * FROM context_items WHERE id = ?").get(id) as ContextItemRow | undefined;
    return row ? mapContextItem(row) : null;
  }

  getByIdOrThrow(id: string): ContextItemDto {
    const item = this.getById(id);
    if (!item) throw new ContextOsError("NOT_FOUND", "Context Item not found", { id });
    return item;
  }

  listVersions(id: string): ContextItemVersionDto[] {
    this.getByIdOrThrow(id);
    return (this.db.prepare("SELECT * FROM context_item_versions WHERE context_item_id = ? ORDER BY version_number DESC")
      .all(id) as ContextItemVersionRow[]).map(mapContextItemVersion);
  }

  patch(id: string, input: ContextItemPatch, now: number): ContextItemDto {
    const current = this.getByIdOrThrow(id);
    const next = {
      title: input.title ?? current.title,
      summary: input.summary ?? current.summary,
      body: input.body ?? current.body,
      confidence: input.confidence ?? current.confidence,
      metadata: input.metadata ?? current.metadata
    };
    const versionNumber = (this.db.prepare("SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version FROM context_item_versions WHERE context_item_id = ?")
      .get(id) as { next_version: number }).next_version;
    const versionId = newId("ctxv");
    this.db.transaction(() => {
      const result = this.db.prepare("UPDATE context_items SET title = ?, summary = ?, body = ?, confidence = ?, metadata_json = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
        .run(next.title, next.summary, next.body, next.confidence, JSON.stringify(next.metadata), now, id, input.expectedRevision);
      ensureChanged(result.changes, current, "Context Item", id, input.expectedRevision);
      this.db.prepare("INSERT INTO context_item_versions (id, context_item_id, version_number, title, summary, body, confidence, metadata_json, created_by_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USER', ?)")
        .run(versionId, id, versionNumber, next.title, next.summary, next.body, next.confidence, JSON.stringify(next.metadata), now);
    })();
    return this.getByIdOrThrow(id);
  }

  restoreVersion(id: string, versionNumber: number, expectedRevision: number, now: number): ContextItemVersionRestoreResult {
    const current = this.getByIdOrThrow(id);
    const target = this.db.prepare("SELECT * FROM context_item_versions WHERE context_item_id = ? AND version_number = ?")
      .get(id, versionNumber) as ContextItemVersionRow | undefined;
    if (!target) {
      throw new ContextOsError("NOT_FOUND", "Context Item version not found", { id, versionNumber });
    }

    const restoredVersionId = newId("ctxv");
    let restoredVersionNumber = 0;
    this.db.transaction(() => {
      restoredVersionNumber = (this.db.prepare("SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version FROM context_item_versions WHERE context_item_id = ?")
        .get(id) as { next_version: number }).next_version;
      const result = this.db.prepare("UPDATE context_items SET title = ?, summary = ?, body = ?, confidence = ?, metadata_json = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
        .run(target.title, target.summary, target.body, target.confidence, target.metadata_json, now, id, expectedRevision);
      ensureChanged(result.changes, current, "Context Item", id, expectedRevision);
      this.db.prepare("INSERT INTO context_item_versions (id, context_item_id, version_number, title, summary, body, confidence, metadata_json, created_by_type, created_by_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RESTORE', ?, ?)")
        .run(restoredVersionId, id, restoredVersionNumber, target.title, target.summary, target.body, target.confidence, target.metadata_json, target.id, now);

      const after = this.getByIdOrThrow(id);
      const metadata = JSON.stringify({ restoredFromVersionId: target.id, restoredFromVersionNumber: versionNumber, newVersionNumber: restoredVersionNumber });
      this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'CONTEXT_ITEM', ?, 'CONTEXT_ITEM_VERSION_RESTORED', 'Context Item version restored', ?, ?)")
        .run(newId("act"), current.projectId, id, metadata, now);
      this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, before_json, after_json, created_at) VALUES (?, ?, 'USER', 'CONTEXT_ITEM', ?, 'RESTORE_VERSION', ?, ?, ?)")
        .run(newId("audit"), current.projectId, id, JSON.stringify(current), JSON.stringify(after), now);
    })();

    const version = this.db.prepare("SELECT * FROM context_item_versions WHERE id = ?")
      .get(restoredVersionId) as ContextItemVersionRow;
    return { item: this.getByIdOrThrow(id), version: mapContextItemVersion(version) };
  }

  updateStatus(id: string, status: ContextItemStatus, expectedRevision: number, now: number): ContextItemDto {
    const archivedAt = status === "ARCHIVED" ? now : null;
    const result = this.db.prepare("UPDATE context_items SET status = ?, archived_at = COALESCE(?, archived_at), updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
      .run(status, archivedAt, now, id, expectedRevision);
    ensureChanged(result.changes, this.getById(id), "Context Item", id, expectedRevision);
    return this.getByIdOrThrow(id);
  }
}

function mapContextItem(row: ContextItemRow): ContextItemDto {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceSnapshotId: row.source_snapshot_id,
    itemType: row.item_type,
    status: row.status,
    title: row.title,
    summary: row.summary,
    body: row.body,
    confidence: row.confidence,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    revision: row.revision,
    archivedAt: iso(row.archived_at)
  };
}

function mapContextItemVersion(row: ContextItemVersionRow): ContextItemVersionDto {
  return {
    id: row.id,
    contextItemId: row.context_item_id,
    versionNumber: row.version_number,
    title: row.title,
    summary: row.summary,
    body: row.body,
    confidence: row.confidence,
    metadata: parseJsonObject(row.metadata_json),
    createdByType: row.created_by_type,
    createdById: row.created_by_id,
    createdAt: new Date(row.created_at).toISOString()
  };
}




