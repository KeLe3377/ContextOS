import type { Database } from "better-sqlite3";
import type { z } from "zod";
import {
  automationJobKindSchema,
  automationJobStatusSchema,
  automationSettingsDefaults,
  extractionCandidatePayloadSchema,
  extractionCandidateProvenanceSchema,
  type AutomationJobDto,
  type AutomationJobKind,
  type AutomationJobStatus,
  type AutomationMode,
  type AutomationProjectStatus,
  type AutomationSettingsDto,
  type AutomationSettingsPatch,
  type CandidateKind,
  type CandidateStatus,
  type ExtractionCandidateDto,
  type ExtractionCandidatePayload,
  type ExtractionCandidateProvenance
} from "../../../contracts/src/automation.js";
import { ContextOsError } from "../../../shared/src/errors.js";
import { newId } from "../../../shared/src/id.js";

/**
 * Persistent storage for the zero-input automation pipeline.
 *
 * Boundary rules enforced here:
 * - A job is the only thing the scheduler can claim; claiming is atomic and bumps
 *   the attempt counter in the same transaction.
 * - A candidate row is the only thing an extractor can produce. Nothing in this
 *   repository writes decisions, work items, rules or context items.
 * - Timestamps are stored as epoch milliseconds, matching the rest of the schema,
 *   and projected as ISO strings at the contract boundary.
 */

export const automationJobMaxAttempts = 4;

const nonTerminalJobStatuses: AutomationJobStatus[] = ["QUEUED", "RUNNING"];
const activeCandidateStatuses: CandidateStatus[] = ["PENDING", "ACCEPTED"];

export type AutomationJobFailure = {
  code: string;
  message: string;
};

/** Internal job record. `payload` is stored but never projected onto the public DTO. */
export type AutomationJobRecord = AutomationJobDto & {
  payload: Record<string, unknown>;
};

export type EnqueueAutomationJobInput = {
  kind: AutomationJobKind;
  projectId?: string | null;
  sessionId?: string | null;
  resourceType: string;
  resourceId: string;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
  availableAt?: number;
  maxAttempts?: number;
};

export type EnqueueAutomationJobResult = {
  job: AutomationJobRecord;
  created: boolean;
};

export type UpsertExtractionCandidateInput = {
  projectId: string;
  sessionId?: string | null;
  sourceEvidenceId?: string | null;
  evidenceIds?: string[];
  kind: CandidateKind;
  fingerprint: string;
  payload: ExtractionCandidatePayload;
  confidence: number;
  extractorId: string;
  extractorVersion: string;
  /** Audit and replay facts only; never the candidate's source of truth. */
  provenance?: ExtractionCandidateProvenance;
};

export type UpsertExtractionCandidateResult = {
  candidate: ExtractionCandidateDto;
  created: boolean;
};

export type ExtractionCandidateListFilter = {
  projectId?: string;
  sessionId?: string;
  kind?: CandidateKind;
  status?: CandidateStatus;
  limit?: number;
};

export type ExtractionCandidateTransitionInput = {
  id: string;
  status: CandidateStatus;
  expectedRevision: number;
  target?: { resourceType: string; resourceId: string } | null;
  supersededById?: string | null;
};

export type AutomationProjectActivity = "DISCOVERY" | "SYNC" | "EXTRACTION";

type SettingsRow = {
  project_id: string;
  mode: AutomationMode;
  poll_interval_ms: number;
  max_concurrent_jobs: number;
  source_max_bytes: number;
  auto_accept_threshold: number;
  last_discovery_at: number | null;
  last_sync_at: number | null;
  last_extraction_at: number | null;
  created_at: number;
  updated_at: number;
  revision: number;
};

type JobRow = {
  id: string;
  kind: AutomationJobKind;
  project_id: string | null;
  session_id: string | null;
  resource_type: string;
  resource_id: string;
  payload_json: string;
  idempotency_key: string;
  status: AutomationJobStatus;
  available_at: number;
  started_at: number | null;
  ended_at: number | null;
  attempts: number;
  max_attempts: number;
  failure_code: string | null;
  failure_message: string | null;
  created_at: number;
  updated_at: number;
  revision: number;
};

type CandidateRow = {
  id: string;
  project_id: string;
  session_id: string | null;
  source_evidence_id: string | null;
  kind: CandidateKind;
  fingerprint: string;
  payload_json: string;
  confidence: number;
  status: CandidateStatus;
  extractor_id: string;
  extractor_version: string;
  target_resource_type: string | null;
  target_resource_id: string | null;
  reviewed_at: number | null;
  superseded_by_id: string | null;
  provenance_json: string;
  created_at: number;
  updated_at: number;
  revision: number;
};

type ProjectStatusRow = {
  project_id: string;
  mode: AutomationMode | null;
  last_discovery_at: number | null;
  last_sync_at: number | null;
  watching_sessions: number | null;
  last_evidence_at: number | null;
};

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export class SqliteAutomationRepository {
  constructor(private readonly db: Database) {}

  /**
   * The commit boundary for one extraction result.
   *
   * Candidates, their Evidence links and the Review Items that surface them must become visible
   * together: a partially persisted extraction would either lose a candidate or leave one in the
   * Review Inbox with nothing to review. Nested repository calls join this transaction, so the
   * whole unit either commits or rolls back as one.
   *
   * The extractor itself is a subprocess and is always called *before* this runs — never inside.
   */
  runExtractionTransaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  /**
   * The commit boundary for applying or rejecting one candidate.
   *
   * A candidate may only become ACCEPTED together with the governed object it produces, so the
   * domain write and the candidate's status change have to share one transaction. Nested
   * repository and service calls join it, which is what makes "accepted but nothing materialised"
   * unrepresentable.
   */
  runApplicationTransaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  /** Activity and audit for a candidate's life cycle. `before`/`after` are the DTOs. */
  recordCandidateAudit(input: {
    projectId: string;
    candidateId: string;
    action: "APPLY" | "REJECT";
    eventType: string;
    summary: string;
    before: ExtractionCandidateDto;
    after: ExtractionCandidateDto;
    actorType: "USER" | "SYSTEM";
    now: number;
  }): void {
    this.db.prepare(
      "INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'EXTRACTION_CANDIDATE', ?, ?, ?, ?, ?)"
    ).run(newId("act"), input.projectId, input.candidateId, input.eventType, input.summary, JSON.stringify({}), input.now);
    this.db.prepare(
      "INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, before_json, after_json, created_at) VALUES (?, ?, ?, 'EXTRACTION_CANDIDATE', ?, ?, ?, ?, ?)"
    ).run(
      newId("audit"),
      input.projectId,
      input.actorType,
      input.candidateId,
      input.action,
      JSON.stringify(input.before),
      JSON.stringify(input.after),
      input.now
    );
  }

  getSettings(projectId: string, now: number = Date.now()): AutomationSettingsDto {
    this.ensureSettingsRow(projectId, now);
    const row = this.db.prepare("SELECT * FROM project_automation_settings WHERE project_id = ?")
      .get(projectId) as SettingsRow | undefined;
    if (!row) throw new ContextOsError("NOT_FOUND", "Project not found", { id: projectId });
    return mapSettings(row);
  }

  patchSettings(projectId: string, patch: AutomationSettingsPatch, now: number): AutomationSettingsDto {
    const current = this.getSettings(projectId, now);
    const result = this.db.prepare(
      `UPDATE project_automation_settings
          SET mode = ?, poll_interval_ms = ?, max_concurrent_jobs = ?, source_max_bytes = ?,
              auto_accept_threshold = ?, updated_at = ?, revision = revision + 1
        WHERE project_id = ? AND revision = ?`
    ).run(
      patch.mode ?? current.mode,
      patch.pollIntervalMs ?? current.pollIntervalMs,
      patch.maxConcurrentJobs ?? current.maxConcurrentJobs,
      patch.sourceMaxBytes ?? current.sourceMaxBytes,
      patch.autoAcceptThreshold ?? current.autoAcceptThreshold,
      now,
      projectId,
      patch.expectedRevision
    );
    if (result.changes !== 1) {
      throw new ContextOsError("CONFLICT", "Automation settings revision conflict", {
        projectId,
        expectedRevision: patch.expectedRevision
      });
    }
    return this.getSettings(projectId, now);
  }

  /**
   * Records the last time a project completed a discovery, sync or extraction pass.
   *
   * Deliberately leaves `revision` and `updated_at` alone: background activity is not a
   * configuration change, and bumping the revision here would make a settings PATCH from the
   * UI fail with a spurious revision conflict whenever a poll happened in between.
   */
  markProjectActivity(projectId: string, activity: AutomationProjectActivity, now: number): void {
    this.ensureSettingsRow(projectId, now);
    const column = activity === "DISCOVERY"
      ? "last_discovery_at"
      : activity === "SYNC"
        ? "last_sync_at"
        : "last_extraction_at";
    const result = this.db.prepare(`UPDATE project_automation_settings SET ${column} = ? WHERE project_id = ?`)
      .run(now, projectId);
    if (result.changes !== 1) throw new ContextOsError("NOT_FOUND", "Project not found", { id: projectId });
  }

  /**
   * Enqueues a job unless a non-terminal job already owns the same idempotency key.
   * Returns the existing job with `created: false` in that case, so callers can treat
   * repeated enqueues as a no-op rather than a duplicate.
   */
  enqueue(input: EnqueueAutomationJobInput, now: number): EnqueueAutomationJobResult {
    return this.db.transaction(() => {
      const existing = this.findActiveJobByIdempotencyKey(input.idempotencyKey);
      if (existing) return { job: existing, created: false };

      const id = newId("ajob");
      try {
        this.db.prepare(
          `INSERT INTO automation_jobs
             (id, kind, project_id, session_id, resource_type, resource_id, payload_json, idempotency_key,
              status, available_at, max_attempts, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, 1)`
        ).run(
          id,
          input.kind,
          input.projectId ?? null,
          input.sessionId ?? null,
          input.resourceType,
          input.resourceId,
          JSON.stringify(input.payload ?? {}),
          input.idempotencyKey,
          input.availableAt ?? now,
          input.maxAttempts ?? automationJobMaxAttempts,
          now,
          now
        );
      } catch (error) {
        // The partial unique index rejected a duplicate that appeared between the read
        // and the write: return the winner instead of failing the caller.
        const winner = this.findActiveJobByIdempotencyKey(input.idempotencyKey);
        if (winner) return { job: winner, created: false };
        throw error;
      }

      return { job: this.getJobOrThrow(id), created: true };
    })();
  }

  /**
   * Claims the oldest due QUEUED job whose kind this daemon can actually run.
   *
   * The read and the status transition share one transaction, and the UPDATE re-asserts
   * `status = 'QUEUED'`, so two concurrent claimers cannot both win the same job. Kinds without
   * a registered handler are never claimed, so they keep their retry budget until one ships
   * instead of being claimed and failing their way to FAILED.
   */
  claimNext(now: number, kinds: readonly AutomationJobKind[] = automationJobKindSchema.options): AutomationJobRecord | null {
    const claimable = [...new Set(kinds)];
    if (claimable.length === 0) return null;
    const placeholders = claimable.map(() => "?").join(", ");

    return this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT id FROM automation_jobs
          WHERE status = 'QUEUED' AND available_at <= ? AND kind IN (${placeholders})
          ORDER BY available_at ASC, created_at ASC, id ASC
          LIMIT 1`
      ).get(now, ...claimable) as { id: string } | undefined;
      if (!row) return null;

      const updated = this.db.prepare(
        `UPDATE automation_jobs
            SET status = 'RUNNING', started_at = COALESCE(started_at, ?), attempts = attempts + 1,
                updated_at = ?, revision = revision + 1
          WHERE id = ? AND status = 'QUEUED'`
      ).run(now, now, row.id);
      if (updated.changes !== 1) return null;

      const job = this.getJobOrThrow(row.id);
      this.db.prepare(
        "INSERT INTO automation_job_attempts (id, job_id, attempt_number, status, started_at) VALUES (?, ?, ?, 'STARTED', ?)"
      ).run(newId("aattempt"), job.id, job.attempts, now);
      return job;
    })();
  }

  markSucceeded(jobId: string, now: number): AutomationJobRecord {
    return this.db.transaction(() => {
      const updated = this.db.prepare(
        `UPDATE automation_jobs
            SET status = 'SUCCEEDED', ended_at = ?, failure_code = NULL, failure_message = NULL,
                updated_at = ?, revision = revision + 1
          WHERE id = ? AND status = 'RUNNING'`
      ).run(now, now, jobId);
      if (updated.changes !== 1) throw this.jobStateConflict(jobId, "RUNNING");
      this.closeOpenAttempt(jobId, "SUCCEEDED", null, now);
      return this.getJobOrThrow(jobId);
    })();
  }

  /** Returns a failed RUNNING job to QUEUED with a caller-supplied next attempt time. */
  markRetryable(jobId: string, failure: AutomationJobFailure, availableAt: number, now: number): AutomationJobRecord {
    return this.db.transaction(() => {
      const updated = this.db.prepare(
        `UPDATE automation_jobs
            SET status = 'QUEUED', available_at = ?, ended_at = NULL, failure_code = ?, failure_message = ?,
                updated_at = ?, revision = revision + 1
          WHERE id = ? AND status = 'RUNNING'`
      ).run(availableAt, failure.code, failure.message, now, jobId);
      if (updated.changes !== 1) throw this.jobStateConflict(jobId, "RUNNING");
      this.closeOpenAttempt(jobId, "FAILED", failure, now);
      return this.getJobOrThrow(jobId);
    })();
  }

  markFailed(jobId: string, failure: AutomationJobFailure, now: number): AutomationJobRecord {
    return this.db.transaction(() => {
      const updated = this.db.prepare(
        `UPDATE automation_jobs
            SET status = 'FAILED', ended_at = ?, failure_code = ?, failure_message = ?,
                updated_at = ?, revision = revision + 1
          WHERE id = ? AND status = 'RUNNING'`
      ).run(now, failure.code, failure.message, now, jobId);
      if (updated.changes !== 1) throw this.jobStateConflict(jobId, "RUNNING");
      this.closeOpenAttempt(jobId, "FAILED", failure, now);
      return this.getJobOrThrow(jobId);
    })();
  }

  markCanceled(jobId: string, failure: AutomationJobFailure, now: number): AutomationJobRecord {
    return this.db.transaction(() => {
      const updated = this.db.prepare(
        `UPDATE automation_jobs
            SET status = 'CANCELED', ended_at = ?, failure_code = ?, failure_message = ?,
                updated_at = ?, revision = revision + 1
          WHERE id = ? AND status IN ('QUEUED', 'RUNNING')`
      ).run(now, failure.code, failure.message, now, jobId);
      if (updated.changes !== 1) throw this.jobStateConflict(jobId, "QUEUED or RUNNING");
      this.closeOpenAttempt(jobId, "CANCELED", failure, now);
      return this.getJobOrThrow(jobId);
    })();
  }

  /**
   * Restores jobs left RUNNING by a daemon crash. Attempts that already exhausted the
   * budget become FAILED; everything else goes back to QUEUED and is retried immediately.
   */
  recoverRunning(now: number): number {
    const rows = this.db.prepare("SELECT id, attempts, max_attempts FROM automation_jobs WHERE status = 'RUNNING'")
      .all() as Array<{ id: string; attempts: number; max_attempts: number }>;
    if (rows.length === 0) return 0;

    const failure: AutomationJobFailure = {
      code: "DAEMON_RESTARTED",
      message: "Daemon restarted while this automation job was running"
    };
    this.db.transaction(() => {
      for (const row of rows) {
        const exhausted = row.attempts >= row.max_attempts;
        this.db.prepare(
          `UPDATE automation_jobs
              SET status = ?, available_at = ?, ended_at = ?, failure_code = ?, failure_message = ?,
                  updated_at = ?, revision = revision + 1
            WHERE id = ? AND status = 'RUNNING'`
        ).run(exhausted ? "FAILED" : "QUEUED", now, exhausted ? now : null, failure.code, failure.message, now, row.id);
        this.closeOpenAttempt(row.id, "FAILED", failure, now);
      }
    })();
    return rows.length;
  }

  getJob(id: string): AutomationJobRecord | null {
    const row = this.db.prepare("SELECT * FROM automation_jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  findJobByIdempotencyKey(idempotencyKey: string): AutomationJobRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM automation_jobs WHERE idempotency_key = ? ORDER BY created_at DESC, id DESC LIMIT 1"
    ).get(idempotencyKey) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  countJobsByStatus(): Record<AutomationJobStatus, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS count FROM automation_jobs GROUP BY status")
      .all() as Array<{ status: AutomationJobStatus; count: number }>;
    return countRecord(automationJobStatusSchema.options, rows);
  }

  countJobsByKind(): Record<AutomationJobKind, number> {
    const rows = this.db.prepare("SELECT kind, COUNT(*) AS count FROM automation_jobs GROUP BY kind")
      .all() as Array<{ kind: AutomationJobKind; count: number }>;
    return countRecord(automationJobKindSchema.options, rows.map((row) => ({ status: row.kind, count: row.count })));
  }

  countActiveJobs(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM automation_jobs WHERE status IN ('QUEUED', 'RUNNING')")
      .get() as { count: number };
    return row.count;
  }

  listLatestFailures(limit = 5): AutomationJobDto[] {
    const safeLimit = Math.max(1, Math.min(limit, 50));
    const rows = this.db.prepare(
      "SELECT * FROM automation_jobs WHERE status = 'FAILED' ORDER BY ended_at DESC, updated_at DESC, id DESC LIMIT ?"
    ).all(safeLimit) as JobRow[];
    return rows.map(mapJob).map(toAutomationJobDto);
  }

  countPendingCandidates(projectId?: string): number {
    const row = projectId
      ? this.db.prepare("SELECT COUNT(*) AS count FROM extraction_candidates WHERE status = 'PENDING' AND project_id = ?").get(projectId)
      : this.db.prepare("SELECT COUNT(*) AS count FROM extraction_candidates WHERE status = 'PENDING'").get();
    return (row as { count: number }).count;
  }

  /**
   * Per-Project automation state, narrowed to what session continuity actually surfaces:
   * whether automation is on, when it last discovered and synced, how many Sessions it watches
   * and when it last captured Evidence. Candidate counts belong to the deferred pipeline.
   */
  listProjectStatuses(): AutomationProjectStatus[] {
    const rows = this.db.prepare(
      `SELECT projects.id AS project_id,
              settings.mode AS mode,
              settings.last_discovery_at AS last_discovery_at,
              settings.last_sync_at AS last_sync_at,
              (SELECT COUNT(*) FROM session_sync_state state
                JOIN sessions ON sessions.id = state.session_id
                WHERE sessions.project_id = projects.id AND state.status = 'WATCHING') AS watching_sessions,
              (SELECT MAX(evidence.created_at) FROM evidence_snapshots evidence
                WHERE evidence.project_id = projects.id) AS last_evidence_at
         FROM projects
         LEFT JOIN project_automation_settings settings ON settings.project_id = projects.id
        ORDER BY projects.created_at ASC, projects.id ASC`
    ).all() as ProjectStatusRow[];
    return rows.map((row) => ({
      projectId: row.project_id,
      mode: row.mode ?? automationSettingsDefaults.mode,
      lastDiscoveryAt: iso(row.last_discovery_at),
      lastSyncAt: iso(row.last_sync_at),
      watchingSessions: row.watching_sessions ?? 0,
      lastEvidenceAt: iso(row.last_evidence_at)
    }));
  }

  /**
   * Creates a candidate, or folds repeat evidence into the active candidate that already
   * carries the same `(project, kind, fingerprint)`. ACCEPTED history is never rewritten;
   * only PENDING candidates have their confidence and source refreshed.
   */
  upsertCandidate(input: UpsertExtractionCandidateInput, now: number): UpsertExtractionCandidateResult {
    return this.db.transaction(() => {
      const evidenceIds = uniqueEvidenceIds(input.sourceEvidenceId, input.evidenceIds);
      const existing = this.db.prepare(
        `SELECT * FROM extraction_candidates
          WHERE project_id = ? AND kind = ? AND fingerprint = ? AND status IN ('PENDING', 'ACCEPTED')
          ORDER BY created_at ASC, id ASC LIMIT 1`
      ).get(input.projectId, input.kind, input.fingerprint) as CandidateRow | undefined;

      if (existing) {
        this.linkCandidateEvidence(existing.id, evidenceIds, now);
        if (existing.status === "PENDING") {
          this.db.prepare(
            `UPDATE extraction_candidates
                SET confidence = MAX(confidence, ?),
                    source_evidence_id = COALESCE(source_evidence_id, ?),
                    updated_at = ?, revision = revision + 1
              WHERE id = ? AND status = 'PENDING'`
          ).run(input.confidence, input.sourceEvidenceId ?? null, now, existing.id);
        }
        return { candidate: this.getCandidateOrThrow(existing.id), created: false };
      }

      const id = newId("cand");
      this.db.prepare(
        `INSERT INTO extraction_candidates
           (id, project_id, session_id, source_evidence_id, kind, fingerprint, payload_json, confidence,
            status, extractor_id, extractor_version, provenance_json, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, 1)`
      ).run(
        id,
        input.projectId,
        input.sessionId ?? null,
        input.sourceEvidenceId ?? null,
        input.kind,
        input.fingerprint,
        JSON.stringify(input.payload),
        input.confidence,
        input.extractorId,
        input.extractorVersion,
        JSON.stringify(input.provenance ?? {}),
        now,
        now
      );
      this.linkCandidateEvidence(id, evidenceIds, now);
      return { candidate: this.getCandidateOrThrow(id), created: true };
    })();
  }

  linkCandidateEvidence(candidateId: string, evidenceIds: string[], now: number): void {
    const statement = this.db.prepare(
      "INSERT OR IGNORE INTO extraction_candidate_evidence (candidate_id, evidence_id, link_reason, created_at) VALUES (?, ?, 'SOURCE', ?)"
    );
    for (const evidenceId of uniqueEvidenceIds(null, evidenceIds)) statement.run(candidateId, evidenceId, now);
  }

  listCandidates(filter: ExtractionCandidateListFilter = {}): ExtractionCandidateDto[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.projectId) {
      clauses.push("project_id = ?");
      params.push(filter.projectId);
    }
    if (filter.sessionId) {
      clauses.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter.kind) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 200));
    const rows = this.db.prepare(
      `SELECT * FROM extraction_candidates ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`
    ).all(...params, limit) as CandidateRow[];
    return rows.map((row) => mapCandidate(row, this.listCandidateEvidenceIds(row.id)));
  }

  getCandidate(id: string): ExtractionCandidateDto | null {
    const row = this.db.prepare("SELECT * FROM extraction_candidates WHERE id = ?").get(id) as CandidateRow | undefined;
    return row ? mapCandidate(row, this.listCandidateEvidenceIds(row.id)) : null;
  }

  listCandidateEvidenceIds(candidateId: string): string[] {
    // Ordered by insertion so the direct source Evidence stays first in the projection.
    return (this.db.prepare(
      "SELECT evidence_id FROM extraction_candidate_evidence WHERE candidate_id = ? ORDER BY created_at ASC, rowid ASC"
    ).all(candidateId) as Array<{ evidence_id: string }>).map((row) => row.evidence_id);
  }

  /** Applies a reviewed status change guarded by the caller's expected revision. */
  transitionCandidate(input: ExtractionCandidateTransitionInput, now: number): ExtractionCandidateDto {
    const reviewedAt = input.status === "PENDING" ? null : now;
    const result = this.db.prepare(
      `UPDATE extraction_candidates
          SET status = ?, target_resource_type = ?, target_resource_id = ?, superseded_by_id = ?,
              reviewed_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?`
    ).run(
      input.status,
      input.target?.resourceType ?? null,
      input.target?.resourceId ?? null,
      input.supersededById ?? null,
      reviewedAt,
      now,
      input.id,
      input.expectedRevision
    );
    if (result.changes !== 1) {
      const current = this.db.prepare("SELECT revision FROM extraction_candidates WHERE id = ?")
        .get(input.id) as { revision: number } | undefined;
      if (!current) throw new ContextOsError("NOT_FOUND", "Extraction candidate not found", { id: input.id });
      throw new ContextOsError("CONFLICT", "Extraction candidate revision conflict", {
        id: input.id,
        expectedRevision: input.expectedRevision,
        currentRevision: current.revision
      });
    }
    return this.getCandidateOrThrow(input.id);
  }

  private ensureSettingsRow(projectId: string, now: number): void {
    // The SELECT only yields a row when the Project exists, so a missing Project falls
    // through to the NOT_FOUND check in getSettings instead of tripping the foreign key.
    this.db.prepare(
      `INSERT OR IGNORE INTO project_automation_settings
         (project_id, mode, poll_interval_ms, max_concurrent_jobs, source_max_bytes,
          auto_accept_threshold, created_at, updated_at, revision)
       SELECT id, ?, ?, ?, ?, ?, ?, ?, 1 FROM projects WHERE id = ?`
    ).run(
      automationSettingsDefaults.mode,
      automationSettingsDefaults.pollIntervalMs,
      automationSettingsDefaults.maxConcurrentJobs,
      automationSettingsDefaults.sourceMaxBytes,
      automationSettingsDefaults.autoAcceptThreshold,
      now,
      now,
      projectId
    );
  }

  private findActiveJobByIdempotencyKey(idempotencyKey: string): AutomationJobRecord | null {
    const placeholders = nonTerminalJobStatuses.map(() => "?").join(",");
    const row = this.db.prepare(
      `SELECT * FROM automation_jobs WHERE idempotency_key = ? AND status IN (${placeholders}) ORDER BY created_at ASC, id ASC LIMIT 1`
    ).get(idempotencyKey, ...nonTerminalJobStatuses) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  private closeOpenAttempt(jobId: string, status: "SUCCEEDED" | "FAILED" | "CANCELED", failure: AutomationJobFailure | null, now: number): void {
    this.db.prepare(
      `UPDATE automation_job_attempts SET status = ?, ended_at = ?, failure_code = ?, failure_message = ?
        WHERE job_id = ? AND status = 'STARTED'`
    ).run(status, now, failure?.code ?? null, failure?.message ?? null, jobId);
  }

  private getJobOrThrow(id: string): AutomationJobRecord {
    const job = this.getJob(id);
    if (!job) throw new ContextOsError("NOT_FOUND", "Automation job not found", { id });
    return job;
  }

  private getCandidateOrThrow(id: string): ExtractionCandidateDto {
    const candidate = this.getCandidate(id);
    if (!candidate) throw new ContextOsError("NOT_FOUND", "Extraction candidate not found", { id });
    return candidate;
  }

  private jobStateConflict(jobId: string, expected: string): ContextOsError {
    const row = this.db.prepare("SELECT status FROM automation_jobs WHERE id = ?").get(jobId) as { status: string } | undefined;
    if (!row) return new ContextOsError("NOT_FOUND", "Automation job not found", { id: jobId });
    return new ContextOsError("CONFLICT", "Automation job is not in the expected state", {
      id: jobId,
      expectedStatus: expected,
      currentStatus: row.status
    });
  }
}

/**
 * Projects an internal job record onto the public contract shape.
 * The stored payload is dropped here so it can never reach a status response or a log line.
 */
export function toAutomationJobDto(job: AutomationJobRecord): AutomationJobDto {
  const { payload: _payload, ...dto } = job;
  return dto;
}

function uniqueEvidenceIds(sourceEvidenceId: string | null | undefined, evidenceIds: string[] | undefined): string[] {
  const ids = [sourceEvidenceId, ...(evidenceIds ?? [])].filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

function countRecord<T extends string>(keys: readonly T[], rows: Array<{ status: T; count: number }>): Record<T, number> {
  const output = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
  for (const row of rows) output[row.status] = row.count;
  return output;
}

function mapSettings(row: SettingsRow): AutomationSettingsDto {
  return {
    id: `aset_${row.project_id}`,
    projectId: row.project_id,
    mode: row.mode,
    pollIntervalMs: row.poll_interval_ms,
    maxConcurrentJobs: row.max_concurrent_jobs,
    sourceMaxBytes: row.source_max_bytes,
    autoAcceptThreshold: row.auto_accept_threshold,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    revision: row.revision
  };
}

function mapJob(row: JobRow): AutomationJobRecord {
  return {
    id: row.id,
    kind: row.kind,
    projectId: row.project_id,
    sessionId: row.session_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    availableAt: new Date(row.available_at).toISOString(),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    revision: row.revision,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>
  };
}

function mapCandidate(row: CandidateRow, evidenceIds: string[]): ExtractionCandidateDto {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    sourceEvidenceId: row.source_evidence_id,
    evidenceIds,
    kind: row.kind,
    fingerprint: row.fingerprint,
    // Validated rather than cast: a malformed payload must fail loudly instead of reaching the
    // API or a review decision as an untyped object.
    payload: parseCandidateJson("payload_json", row.payload_json, extractionCandidatePayloadSchema),
    confidence: row.confidence,
    status: row.status,
    extractorId: row.extractor_id,
    extractorVersion: row.extractor_version,
    targetResourceType: row.target_resource_type,
    targetResourceId: row.target_resource_id,
    reviewedAt: iso(row.reviewed_at),
    supersededById: row.superseded_by_id,
    provenance: parseCandidateJson("provenance_json", row.provenance_json, extractionCandidateProvenanceSchema),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    revision: row.revision
  };
}

/**
 * A stable failure the scheduler can retry on. `column` is fixed vocabulary, and the raw JSON
 * never travels with the error because it holds extracted transcript content.
 */
function parseCandidateJson<S extends z.ZodTypeAny>(column: string, raw: string, schema: S): z.infer<S> {
  const fail = (reason: string): ContextOsError => new ContextOsError("CONFLICT", "Extraction candidate content failed validation", {
    failureCode: "EXTRACTION_PERSISTENCE_FAILED",
    column,
    reason
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw fail("JSON_PARSE");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw fail("SCHEMA_MISMATCH");
  return result.data;
}

export { activeCandidateStatuses };
