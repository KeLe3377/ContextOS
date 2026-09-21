import type { Database } from "better-sqlite3";
import type { z } from "zod";
import {
  compactionDecisionsSchema,
  compactionEventsSchema,
  compactionStatsSchema,
  type CompactionArtifactDto,
  type CompactionArtifactIdentity,
  type CompactionArtifactStats,
  type CompactionArtifactStatus,
  type CompactionDecision,
  type CompactionEvent
} from "../../../contracts/src/compaction.js";
import { ContextOsError } from "../../../shared/src/errors.js";
import { newId } from "../../../shared/src/id.js";

/**
 * Storage for versioned compaction artifacts.
 *
 * The identity index is what makes compaction idempotent: the same source content under the same
 * provider, sanitizer and options resolves to the artifact that already exists, so a daemon
 * restart or a retried job never recomputes or duplicates it.
 *
 * Every JSON column is validated on the way out. `JSON.parse(...) as T` would hand the extractor
 * whatever the database happens to contain, so a malformed or mismatched row fails loudly with a
 * stable code instead — and the raw JSON is never echoed into the error, because it holds
 * transcript content.
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
  decisions: CompactionDecision[];
  stats: CompactionArtifactStats;
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
  /** Joined from the source Evidence row so the artifact can be tied to the exact bytes. */
  source_evidence_content_hash: string;
};

const artifactSelect = `
  SELECT artifact.*, evidence.content_hash AS source_evidence_content_hash
    FROM compaction_artifacts artifact
    JOIN evidence_snapshots evidence ON evidence.id = artifact.source_evidence_id
`;

export class SqliteCompactionArtifactRepository {
  constructor(private readonly db: Database) {}

  findByIdentity(identity: CompactionArtifactIdentity): CompactionArtifactDto | null {
    const row = this.db.prepare(
      `${artifactSelect}
        WHERE artifact.source_content_hash = ? AND artifact.provider_id = ? AND artifact.provider_version = ?
          AND artifact.sanitizer_version = ? AND artifact.options_hash = ?
        ORDER BY artifact.created_at ASC, artifact.id ASC
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
    const row = this.db.prepare(`${artifactSelect} WHERE artifact.id = ?`).get(id) as CompactionArtifactRow | undefined;
    return row ? mapArtifact(row) : null;
  }

  getByIdOrThrow(id: string): CompactionArtifactDto {
    const artifact = this.getById(id);
    if (!artifact) throw new ContextOsError("NOT_FOUND", "Compaction artifact not found", { id });
    return artifact;
  }

  listByEvidence(evidenceId: string): CompactionArtifactDto[] {
    return (this.db.prepare(
      `${artifactSelect} WHERE artifact.source_evidence_id = ? ORDER BY artifact.created_at ASC, artifact.id ASC`
    ).all(evidenceId) as CompactionArtifactRow[]).map(mapArtifact);
  }
}

function mapArtifact(row: CompactionArtifactRow): CompactionArtifactDto {
  const events = parseColumn("events_json", row.events_json, compactionEventsSchema);
  assertAscendingEventOrdinals(events);
  assertSourceHashMatches(row);

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
    events,
    decisions: parseColumn("decisions_json", row.decisions_json, compactionDecisionsSchema),
    stats: parseColumn("stats_json", row.stats_json, compactionStatsSchema),
    failureCode: row.failure_code,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    revision: row.revision
  };
}

function parseColumn<S extends z.ZodTypeAny>(column: string, raw: string, schema: S): z.infer<S> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw invalidArtifact(column, "JSON_PARSE");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw invalidArtifact(column, "SCHEMA_MISMATCH");
  return result.data;
}

function assertAscendingEventOrdinals(events: readonly CompactionEvent[]): void {
  let previous: number | null = null;
  for (const event of events) {
    if (previous === null) {
      previous = event.ordinal;
      continue;
    }
    if (event.ordinal === previous) throw invalidArtifact("events_json", "DUPLICATE_ORDINAL");
    if (event.ordinal < previous) throw invalidArtifact("events_json", "NON_INCREASING_ORDINAL");
    previous = event.ordinal;
  }
}

/** The artifact must still point at the exact Evidence bytes it was derived from. */
function assertSourceHashMatches(row: CompactionArtifactRow): void {
  if (row.source_evidence_content_hash !== row.source_content_hash) {
    throw invalidArtifact("source_content_hash", "SOURCE_HASH_MISMATCH");
  }
}

/**
 * A stable failure the scheduler can retry on. `column` and `reason` are fixed vocabulary and
 * never carry database content.
 */
function invalidArtifact(column: string, reason: string): ContextOsError {
  return new ContextOsError("CONFLICT", "Compaction artifact content failed validation", {
    failureCode: "COMPACTION_ARTIFACT_INVALID",
    column,
    reason
  });
}
