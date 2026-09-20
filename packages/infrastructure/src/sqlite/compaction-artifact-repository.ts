import type { Database } from "better-sqlite3";
import type {
  CompactionArtifactDto,
  CompactionArtifactIdentity,
  CompactionArtifactStatus,
  CompactionEvent
} from "../../../contracts/src/compaction.js";
import { ContextOsError } from "../../../shared/src/errors.js";
import { newId } from "../../../shared/src/id.js";

/**
 * Storage for versioned compaction artifacts.
 *
 * The identity index is what makes compaction idempotent: the same source content under the same
 * provider, sanitizer and options resolves to the artifact that already exists, so a daemon
 * restart or a retried job never recomputes or duplicates it.
 */

export type CompactionArtifactInput = {
  projectId: string;
  sessionId: string | null;
  sourceEvidenceId: string;
  sourceContentHash: string;
  providerId: string;
  providerVersion: string;
  sanitizerVersion: string;
  optionsHash: string;
  status: CompactionArtifactStatus;
  events: CompactionEvent[];
  decisions: Array<Record<string, unknown>>;
  stats: Record<string, unknown>;
  failureCode: string | null;
};

export type CompactionArtifactRow = {
  id: string;
  project_id: string;
  session_id: string | null;
  source_evidence_id: string;
  source_content_hash: string;
  provider_id: string;
  provider_version: string;
  sanitizer_version: string;
  options_hash: string;
  status: CompactionArtifactStatus;
  events_json: string;
  decisions_json: string;
  stats_json: string;
  failure_code: string | null;
  created_at: number;
  updated_at: number;
  revision: number;
};

export class SqliteCompactionArtifactRepository {
  constructor(private readonly db: Database) {}

  findByIdentity(identity: CompactionArtifactIdentity): CompactionArtifactDto | null {
    const row = this.db.prepare(
      `SELECT * FROM compaction_artifacts
        WHERE source_content_hash = ? AND provider_id = ? AND provider_version = ?
          AND sanitizer_version = ? AND options_hash = ?
        ORDER BY created_at ASC, id ASC
        LIMIT 1`
    ).get(
      identity.sourceContentHash,
      identity.providerId,
      identity.providerVersion,
      identity.sanitizerVersion,
      identity.optionsHash
    ) as CompactionArtifactRow | undefined;
    return row ? mapArtifact(row) : null;
  }

  /**
   * Returns the artifact for this identity, creating it only when it does not exist yet.
   * A concurrent insert is resolved by re-reading instead of failing the caller.
   */
  findOrCreate(input: CompactionArtifactInput, now: number): { artifact: CompactionArtifactDto; created: boolean } {
    return this.db.transaction(() => {
      const identity: CompactionArtifactIdentity = {
        sourceContentHash: input.sourceContentHash,
        providerId: input.providerId,
        providerVersion: input.providerVersion,
        sanitizerVersion: input.sanitizerVersion,
        optionsHash: input.optionsHash
      };
      const existing = this.findByIdentity(identity);
      if (existing) return { artifact: existing, created: false };

      const id = newId("cmp");
      try {
        this.db.prepare(
          `INSERT INTO compaction_artifacts
             (id, project_id, session_id, source_evidence_id, source_content_hash, provider_id, provider_version,
              sanitizer_version, options_hash, status, events_json, decisions_json, stats_json, failure_code,
              created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        ).run(
          id,
          input.projectId,
          input.sessionId,
          input.sourceEvidenceId,
          input.sourceContentHash,
          input.providerId,
          input.providerVersion,
          input.sanitizerVersion,
          input.optionsHash,
          input.status,
          JSON.stringify(input.events),
          JSON.stringify(input.decisions),
          JSON.stringify(input.stats),
          input.failureCode,
          now,
          now
        );
      } catch (error) {
        const winner = this.findByIdentity(identity);
        if (winner) return { artifact: winner, created: false };
        throw error;
      }

      return { artifact: this.getByIdOrThrow(id), created: true };
    })();
  }

  getById(id: string): CompactionArtifactDto | null {
    const row = this.db.prepare("SELECT * FROM compaction_artifacts WHERE id = ?").get(id) as CompactionArtifactRow | undefined;
    return row ? mapArtifact(row) : null;
  }

  getByIdOrThrow(id: string): CompactionArtifactDto {
    const artifact = this.getById(id);
    if (!artifact) throw new ContextOsError("NOT_FOUND", "Compaction artifact not found", { id });
    return artifact;
  }

  listByEvidence(evidenceId: string): CompactionArtifactDto[] {
    return (this.db.prepare(
      "SELECT * FROM compaction_artifacts WHERE source_evidence_id = ? ORDER BY created_at ASC, id ASC"
    ).all(evidenceId) as CompactionArtifactRow[]).map(mapArtifact);
  }
}

function mapArtifact(row: CompactionArtifactRow): CompactionArtifactDto {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    sourceEvidenceId: row.source_evidence_id,
    sourceContentHash: row.source_content_hash,
    providerId: row.provider_id,
    providerVersion: row.provider_version,
    sanitizerVersion: row.sanitizer_version,
    optionsHash: row.options_hash,
    status: row.status,
    events: JSON.parse(row.events_json) as CompactionEvent[],
    decisions: JSON.parse(row.decisions_json) as Array<Record<string, unknown>>,
    stats: JSON.parse(row.stats_json) as Record<string, unknown>,
    failureCode: row.failure_code,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    revision: row.revision
  };
}
