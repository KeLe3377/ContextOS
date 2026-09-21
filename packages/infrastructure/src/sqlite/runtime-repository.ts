import type { Database } from "better-sqlite3";
import type { ContextPackageDto, EvidenceSnapshotDto } from "../../../contracts/src/context.js";
import type { ResourceActivityEventDto, RuntimeHealthDto, RuntimeJobDto, SessionRunDto, SettingsDto, SettingsPatch } from "../../../contracts/src/runtime.js";
import type { ResumeCapsuleDto, SessionStatus, TranscriptImportResult } from "../../../contracts/src/sessions.js";
import { ContextOsError } from "../../../shared/src/errors.js";
import { newId } from "../../../shared/src/id.js";

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function clipPackageText(value: string, maxLength = 4000): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n[truncated]`;
}

function formatWorkItemPackageSummary(item: PackageWorkItemRow): string {
  const acceptance = JSON.parse(item.acceptance_json) as string[];
  return clipPackageText([
    `Status: ${item.status}`,
    item.description,
    acceptance.length ? `Acceptance:\n${acceptance.map((entry) => `- ${entry}`).join("\n")}` : null,
    item.execution_contract ? `Execution contract:\n${item.execution_contract}` : null
  ].filter(Boolean).join("\n"));
}

function bool(value: number): boolean {
  return value === 1;
}

type SettingsRow = {
  id: "singleton";
  launch_at_startup: number;
  start_minimized: number;
  confirm_destructive_actions: number;
  local_endpoint: string;
  default_adapter_id: string | null;
  context_config_json: string;
  privacy_config_json: string;
  data_directory: string;
  created_at: number;
  updated_at: number;
  revision: number;
};

type JobRow = {
  id: string;
  kind: string;
  status: RuntimeJobDto["status"];
  resource_type: string;
  resource_id: string;
  payload_json: string;
  available_at: number;
  failure_code: string | null;
  failure_message: string | null;
  created_at: number;
  updated_at: number;
  revision: number;
};

type JobStatusCountRow = {
  status: RuntimeJobDto["status"];
  count: number;
};

type SessionRunRow = {
  id: string;
  session_id: string;
  job_id: string | null;
  external_run_id: string | null;
  status: SessionRunDto["status"];
  pid: number | null;
  started_at: number | null;
  ended_at: number | null;
  exit_code: number | null;
  failure_code: string | null;
  failure_message: string | null;
  adapter_version: string;
  created_at: number;
  updated_at: number;
  revision: number;
};

type SessionRunStatusCountRow = {
  status: SessionRunDto["status"];
  count: number;
};

type OutboxStatusCountRow = {
  status: "PENDING" | "DISPATCHED" | "FAILED";
  count: number;
};

type ActivityEventRow = {
  id: string;
  project_id: string | null;
  resource_type: string;
  resource_id: string;
  event_type: string;
  summary: string;
  metadata_json: string;
  created_at: number;
};

type AuditEventRow = {
  id: string;
  project_id: string | null;
  actor_type: string;
  resource_type: string;
  resource_id: string;
  action: string;
  after_json: string | null;
  created_at: number;
};

type ContextPackageRow = {
  id: string;
  project_id: string;
  name: string;
  purpose: string;
  context_item_ids_json: string;
  evidence_snapshot_ids_json: string;
  selection_manifest_json: string | null;
  created_at: number;
  updated_at: number;
  revision: number;
};

type PackageContextItemRow = {
  id: string;
  title: string;
  summary: string;
  source_snapshot_id: string | null;
  revision: number;
};

type PackageWorkItemRow = { id: string; title: string; description: string | null; status: string; acceptance_json: string; execution_contract: string | null; revision: number };
type PackageDecisionRow = { id: string; title: string; statement: string; rationale: string; content_hash: string; revision: number };
type PackageRuleRow = { id: string; title: string; description: string | null; enforcement_mode: string; effect_json: string; content_hash: string; revision: number };
type StoredContextPackageManifest = Pick<ContextPackageDto, "workItems" | "decisions" | "contextItems" | "evidenceSnapshots" | "rules"> & { schemaVersion: string; generatedFor: string };

type PackageEvidenceRow = {
  id: string;
  title: string;
  content_hash: string;
};

type EvidenceSnapshotRow = {
  id: string;
  project_id: string;
  source_id: string | null;
  evidence_type: EvidenceSnapshotDto["evidenceType"];
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

type ResumeSessionRow = {
  id: string;
  project_id: string;
  intent: string | null;
  status: SessionStatus;
  runtime_state: string;
  updated_at: number;
  external_session_id: string | null;
};

type ResumeCapsuleState = {
  summary?: string;
  nextAction?: string | null;
  /** Derived continuity excerpt; preserved by patch so editing summary/nextAction keeps it. */
  contextText?: string | null;
  lastRunId?: string | null;
  evidenceSnapshotIds?: string[];
  updatedAt?: string;
};

export class SqliteRuntimeRepository {
  constructor(private readonly db: Database) {}

  getSettings(): SettingsDto {
    const row = this.db.prepare("SELECT * FROM settings WHERE id = 'singleton'").get() as SettingsRow | undefined;
    if (!row) throw new ContextOsError("NOT_FOUND", "Settings not found");
    return mapSettings(row);
  }

  getRuntimeHealth(now: number): RuntimeHealthDto {
    const jobCounts = this.db.prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status").all() as JobStatusCountRow[];
    const runCounts = this.db.prepare("SELECT status, COUNT(*) AS count FROM session_runs GROUP BY status").all() as SessionRunStatusCountRow[];
    const outboxCounts = this.db.prepare("SELECT status, COUNT(*) AS count FROM outbox_events GROUP BY status").all() as OutboxStatusCountRow[];
    const latestFailedJobs = this.db.prepare("SELECT * FROM jobs WHERE status = 'FAILED' ORDER BY updated_at DESC, id DESC LIMIT 5")
      .all() as JobRow[];
    const latestFailedRuns = this.db.prepare("SELECT * FROM session_runs WHERE status = 'FAILED' ORDER BY updated_at DESC, id DESC LIMIT 5")
      .all() as SessionRunRow[];
    const jobByStatus = statusRecord<RuntimeJobDto["status"]>(["CREATED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"], jobCounts);
    const runByStatus = statusRecord<SessionRunDto["status"]>(["CREATED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"], runCounts);
    const outboxByStatus = statusRecord<OutboxStatusCountRow["status"]>(["PENDING", "DISPATCHED", "FAILED"], outboxCounts);
    return {
      generatedAt: new Date(now).toISOString(),
      jobs: {
        total: Object.values(jobByStatus).reduce((sum, count) => sum + count, 0),
        byStatus: jobByStatus,
        latestFailed: latestFailedJobs.map(mapJob)
      },
      sessionRuns: {
        total: Object.values(runByStatus).reduce((sum, count) => sum + count, 0),
        running: runByStatus.RUNNING,
        failed: runByStatus.FAILED,
        latestFailed: latestFailedRuns.map(mapSessionRun)
      },
      outbox: {
        pending: outboxByStatus.PENDING,
        failed: outboxByStatus.FAILED
      }
    };
  }

  listResourceActivity(input: { resourceType: string; resourceId: string; limit: number }): ResourceActivityEventDto[] {
    const limit = Math.max(1, Math.min(input.limit, 100));
    const activities = this.db.prepare("SELECT * FROM activity_events WHERE resource_type = ? AND resource_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(input.resourceType, input.resourceId, limit) as ActivityEventRow[];
    const audits = this.db.prepare("SELECT * FROM audit_events WHERE resource_type = ? AND resource_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(input.resourceType, input.resourceId, limit) as AuditEventRow[];
    return [
      ...activities.map(mapActivityEvent),
      ...audits.map(mapAuditEvent)
    ].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)).slice(0, limit);
  }

  patchSettings(input: SettingsPatch, now: number): SettingsDto {
    const current = this.getSettings();
    const result = this.db.prepare("UPDATE settings SET launch_at_startup = ?, start_minimized = ?, confirm_destructive_actions = ?, default_adapter_id = ?, updated_at = ?, revision = revision + 1 WHERE id = 'singleton' AND revision = ?")
      .run(
        input.launchAtStartup === undefined ? (current.launchAtStartup ? 1 : 0) : input.launchAtStartup ? 1 : 0,
        input.startMinimized === undefined ? (current.startMinimized ? 1 : 0) : input.startMinimized ? 1 : 0,
        input.confirmDestructiveActions === undefined ? (current.confirmDestructiveActions ? 1 : 0) : input.confirmDestructiveActions ? 1 : 0,
        input.defaultAdapterId === undefined ? current.defaultAdapterId : input.defaultAdapterId,
        now,
        input.expectedRevision
      );
    if (result.changes === 0) throw new ContextOsError("CONFLICT", "Settings revision conflict", { expectedRevision: input.expectedRevision });
    return this.getSettings();
  }

  createContinueSessionJob(input: { sessionId: string; projectId: string; adapterId: string; adapterVersion: string; launchInfo: Record<string, unknown>; contextPackageId?: string | null }, now: number): { job: RuntimeJobDto; run: SessionRunDto } {
    const jobId = newId("job");
    const runId = newId("run");
    const payload = { sessionId: input.sessionId, projectId: input.projectId, adapterId: input.adapterId, contextPackageId: input.contextPackageId ?? null, launchInfo: input.launchInfo };
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO jobs (id, kind, status, resource_type, resource_id, payload_json, available_at, created_at, updated_at, revision) VALUES (?, 'CONTINUE_SESSION', 'CREATED', 'SESSION', ?, ?, ?, ?, ?, 1)")
        .run(jobId, input.sessionId, JSON.stringify(payload), now, now, now);
      this.db.prepare("INSERT INTO session_runs (id, session_id, job_id, status, adapter_version, created_at, updated_at, revision) VALUES (?, ?, ?, 'CREATED', ?, ?, ?, 1)")
        .run(runId, input.sessionId, jobId, input.adapterVersion, now, now);
      this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'SESSION', ?, 'CONTINUE_QUEUED', 'Queued agent continue session job', ?, ?)")
        .run(newId("act"), input.projectId, input.sessionId, JSON.stringify({ jobId, runId, adapterId: input.adapterId }), now);
      this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, after_json, created_at) VALUES (?, ?, 'SYSTEM', 'SESSION', ?, 'CONTINUE_QUEUED', ?, ?)")
        .run(newId("audit"), input.projectId, input.sessionId, JSON.stringify({ jobId, runId }), now);
      this.db.prepare("INSERT INTO outbox_events (id, topic, payload_json, status, next_attempt_at, created_at, updated_at) VALUES (?, 'session.continue.queued', ?, 'PENDING', ?, ?, ?)")
        .run(newId("outbox"), JSON.stringify({ projectId: input.projectId, sessionId: input.sessionId, jobId, runId, adapterId: input.adapterId }), now, now, now);
    })();
    return { job: this.getJob(jobId), run: this.getSessionRun(runId) };
  }

  markContinueRunning(input: { jobId: string; runId: string; pid: number }, now: number): { job: RuntimeJobDto; run: SessionRunDto } {
    this.db.transaction(() => {
      this.db.prepare("UPDATE jobs SET status = 'RUNNING', started_at = COALESCE(started_at, ?), attempts = attempts + 1, updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, now, input.jobId);
      this.db.prepare("UPDATE session_runs SET status = 'RUNNING', pid = ?, started_at = COALESCE(started_at, ?), updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(input.pid, now, now, input.runId);
      this.db.prepare("INSERT INTO job_attempts (id, job_id, status, started_at) VALUES (?, ?, 'STARTED', ?)")
        .run(newId("jattempt"), input.jobId, now);
      this.reconcileWorkItemAttempt(input.runId, "STARTED", now);
    })();
    return { job: this.getJob(input.jobId), run: this.getSessionRun(input.runId) };
  }

  markContinueSucceeded(input: { jobId: string; runId: string; exitCode: number | null }, now: number): { job: RuntimeJobDto; run: SessionRunDto } {
    this.db.transaction(() => {
      this.db.prepare("UPDATE jobs SET status = 'SUCCEEDED', ended_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'RUNNING'")
        .run(now, now, input.jobId);
      this.db.prepare("UPDATE session_runs SET status = 'SUCCEEDED', ended_at = ?, exit_code = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'RUNNING'")
        .run(now, input.exitCode, now, input.runId);
      this.db.prepare("UPDATE job_attempts SET status = 'SUCCEEDED', ended_at = ? WHERE job_id = ? AND status = 'STARTED'")
        .run(now, input.jobId);
      this.db.prepare("UPDATE sessions SET status = 'COMPLETED', completed_at = COALESCE(completed_at, ?), last_activity_at = ?, updated_at = ?, revision = revision + 1 WHERE id = (SELECT session_id FROM session_runs WHERE id = ?) AND status = 'RUNNING'")
        .run(now, now, now, input.runId);
      this.reconcileWorkItemAttempt(input.runId, "SUCCEEDED", now);
    })();
    return { job: this.getJob(input.jobId), run: this.getSessionRun(input.runId) };
  }

  markContinueExitedFailed(input: { jobId: string; runId: string; exitCode: number | null; signal: string | null; failureMessage: string }, now: number): { job: RuntimeJobDto; run: SessionRunDto } {
    const failureCode = input.signal ? "PROCESS_SIGNALED" : "PROCESS_EXITED";
    const resource = this.getRunSessionResource(input.runId);
    this.db.transaction(() => {
      this.db.prepare("UPDATE jobs SET status = 'FAILED', ended_at = ?, failure_code = ?, failure_message = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'RUNNING'")
        .run(now, failureCode, input.failureMessage, now, input.jobId);
      this.db.prepare("UPDATE session_runs SET status = 'FAILED', ended_at = ?, exit_code = ?, failure_code = ?, failure_message = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'RUNNING'")
        .run(now, input.exitCode, failureCode, input.failureMessage, now, input.runId);
      this.db.prepare("UPDATE job_attempts SET status = 'FAILED', ended_at = ?, failure_code = ?, failure_message = ? WHERE job_id = ? AND status = 'STARTED'")
        .run(now, failureCode, input.failureMessage, input.jobId);
      this.db.prepare("UPDATE sessions SET status = 'FAILED', completed_at = COALESCE(completed_at, ?), last_activity_at = ?, updated_at = ?, revision = revision + 1 WHERE id = (SELECT session_id FROM session_runs WHERE id = ?) AND status = 'RUNNING'")
        .run(now, now, now, input.runId);
      this.reconcileWorkItemAttempt(input.runId, "FAILED", now, input.failureMessage);
      const metadata = JSON.stringify({ jobId: input.jobId, runId: input.runId, failureCode, failureMessage: input.failureMessage });
      this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'SESSION', ?, 'CONTINUE_FAILED', ?, ?, ?)")
        .run(newId("act"), resource.projectId, resource.sessionId, input.failureMessage, metadata, now);
      this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, after_json, created_at) VALUES (?, ?, 'SYSTEM', 'SESSION', ?, 'CONTINUE_FAILED', ?, ?)")
        .run(newId("audit"), resource.projectId, resource.sessionId, metadata, now);
    })();
    return { job: this.getJob(input.jobId), run: this.getSessionRun(input.runId) };
  }

  markContinueFailed(input: { jobId: string; runId: string; failureCode: string; failureMessage: string }, now: number): { job: RuntimeJobDto; run: SessionRunDto } {
    const resource = this.getRunSessionResource(input.runId);
    this.db.transaction(() => {
      this.db.prepare("UPDATE jobs SET status = 'FAILED', ended_at = ?, failure_code = ?, failure_message = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, input.failureCode, input.failureMessage, now, input.jobId);
      this.db.prepare("UPDATE session_runs SET status = 'FAILED', ended_at = ?, failure_code = ?, failure_message = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, input.failureCode, input.failureMessage, now, input.runId);
      this.db.prepare("UPDATE sessions SET status = 'FAILED', completed_at = COALESCE(completed_at, ?), last_activity_at = ?, updated_at = ?, revision = revision + 1 WHERE id = (SELECT session_id FROM session_runs WHERE id = ?) AND status IN ('CREATED', 'RUNNING')")
        .run(now, now, now, input.runId);
      this.reconcileWorkItemAttempt(input.runId, "FAILED", now, input.failureMessage);
      this.db.prepare("INSERT INTO job_attempts (id, job_id, status, started_at, ended_at, failure_code, failure_message) VALUES (?, ?, 'FAILED', ?, ?, ?, ?)")
        .run(newId("jattempt"), input.jobId, now, now, input.failureCode, input.failureMessage);
      const metadata = JSON.stringify({ jobId: input.jobId, runId: input.runId, failureCode: input.failureCode, failureMessage: input.failureMessage });
      this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'SESSION', ?, 'CONTINUE_FAILED', ?, ?, ?)")
        .run(newId("act"), resource.projectId, resource.sessionId, input.failureMessage, metadata, now);
      this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, after_json, created_at) VALUES (?, ?, 'SYSTEM', 'SESSION', ?, 'CONTINUE_FAILED', ?, ?)")
        .run(newId("audit"), resource.projectId, resource.sessionId, metadata, now);
    })();
    return { job: this.getJob(input.jobId), run: this.getSessionRun(input.runId) };
  }

  getLatestSessionRun(sessionId: string): SessionRunDto | null {
    const row = this.db.prepare("SELECT * FROM session_runs WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(sessionId) as SessionRunRow | undefined;
    return row ? mapSessionRun(row) : null;
  }

  listSessionRuns(sessionId: string, limit = 50): SessionRunDto[] {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    return (this.db.prepare("SELECT * FROM session_runs WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(sessionId, safeLimit) as SessionRunRow[]).map(mapSessionRun);
  }

  isSessionRunRunning(runId: string): boolean {
    const row = this.db.prepare("SELECT status FROM session_runs WHERE id = ?").get(runId) as { status: string } | undefined;
    return row?.status === "RUNNING";
  }

  markContinueCanceled(input: { sessionId: string; expectedSessionRevision: number; jobId: string; runId: string }, now: number): { job: RuntimeJobDto; run: SessionRunDto } {
    const session = this.db.prepare("SELECT project_id, status, revision FROM sessions WHERE id = ?")
      .get(input.sessionId) as { project_id: string; status: string; revision: number } | undefined;
    if (!session) throw new ContextOsError("NOT_FOUND", "Session not found", { id: input.sessionId });
    this.db.transaction(() => {
      const updated = this.db.prepare("UPDATE sessions SET status = 'PAUSED', completed_at = NULL, last_activity_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND status = 'RUNNING'")
        .run(now, now, input.sessionId, input.expectedSessionRevision);
      if (updated.changes === 0) {
        throw new ContextOsError("CONFLICT", "Session revision or runtime status conflict", {
          id: input.sessionId,
          expectedRevision: input.expectedSessionRevision
        });
      }
      this.db.prepare("UPDATE jobs SET status = 'CANCELED', ended_at = ?, failure_code = 'INTERRUPTED', failure_message = 'Interrupted by user', updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'RUNNING'")
        .run(now, now, input.jobId);
      this.db.prepare("UPDATE session_runs SET status = 'CANCELED', ended_at = ?, failure_code = 'INTERRUPTED', failure_message = 'Interrupted by user', updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'RUNNING'")
        .run(now, now, input.runId);
      this.db.prepare("UPDATE job_attempts SET status = 'CANCELED', ended_at = ?, failure_code = 'INTERRUPTED', failure_message = 'Interrupted by user' WHERE job_id = ? AND status = 'STARTED'")
        .run(now, input.jobId);
      this.reconcileWorkItemAttempt(input.runId, "CANCELED", now, "Agent session interrupted by user");
      const metadata = JSON.stringify({ jobId: input.jobId, runId: input.runId, failureCode: "INTERRUPTED" });
      this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'SESSION', ?, 'CONTINUE_INTERRUPTED', 'Interrupted agent continue session', ?, ?)")
        .run(newId("act"), session.project_id, input.sessionId, metadata, now);
      this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, before_json, after_json, created_at) VALUES (?, ?, 'USER', 'SESSION', ?, 'CONTINUE_INTERRUPTED', ?, ?, ?)")
        .run(newId("audit"), session.project_id, input.sessionId, JSON.stringify({ status: session.status, revision: session.revision }), JSON.stringify({ status: "PAUSED", revision: session.revision + 1, jobId: input.jobId, runId: input.runId }), now);
    })();
    return { job: this.getJob(input.jobId), run: this.getSessionRun(input.runId) };
  }



  createContextPackageForSession(input: { projectId: string; sessionId: string; intent: string | null }, now: number): ContextPackageDto {
    const packageId = newId("pkg");
    const linkedWorkItem = this.db.prepare(`
      SELECT work_items.id, work_items.title, work_items.description, work_items.status, work_items.acceptance_json, work_items.execution_contract, work_items.revision
      FROM work_item_attempts JOIN work_items ON work_items.id = work_item_attempts.work_item_id
      WHERE work_item_attempts.session_id = ? ORDER BY work_item_attempts.created_at DESC LIMIT 1
    `).get(input.sessionId) as PackageWorkItemRow | undefined;
    const dependencies = linkedWorkItem ? this.db.prepare(`
      SELECT work_items.id, work_items.title, work_items.description, work_items.status, work_items.acceptance_json, work_items.execution_contract, work_items.revision
      FROM work_item_dependencies JOIN work_items ON work_items.id = work_item_dependencies.depends_on_id
      WHERE work_item_dependencies.work_item_id = ? ORDER BY work_item_dependencies.created_at, work_items.id LIMIT 10
    `).all(linkedWorkItem.id) as PackageWorkItemRow[] : [];
    const decisions = this.db.prepare(`
      SELECT decisions.id, decisions.title, versions.statement, versions.rationale, versions.content_hash, decisions.revision
      FROM decisions JOIN decision_versions versions ON versions.id = decisions.current_version_id
      WHERE decisions.project_id = ? AND decisions.status = 'ACCEPTED'
      ORDER BY decisions.updated_at DESC, decisions.id DESC LIMIT 10
    `).all(input.projectId) as PackageDecisionRow[];
    const contextItems = this.db.prepare("SELECT id, title, summary, source_snapshot_id, revision FROM context_items WHERE project_id = ? AND status = 'ACTIVE' ORDER BY updated_at DESC, id DESC LIMIT 20")
      .all(input.projectId) as PackageContextItemRow[];
    const evidenceIds = Array.from(new Set(contextItems.map((item) => item.source_snapshot_id).filter((id): id is string => Boolean(id))));
    const evidenceSnapshots = evidenceIds.length === 0
      ? []
      : this.db.prepare(`SELECT id, title, content_hash FROM evidence_snapshots WHERE project_id = ? AND id IN (${evidenceIds.map(() => "?").join(",")}) ORDER BY created_at DESC, id DESC`)
        .all(input.projectId, ...evidenceIds) as PackageEvidenceRow[];
    const rules = this.db.prepare(`
      SELECT rules.id, rules.title, rules.description, versions.enforcement_mode, versions.effect_json, versions.content_hash, rules.revision
      FROM rules JOIN rule_versions versions ON versions.id = rules.current_version_id
      WHERE rules.project_id = ? AND rules.status = 'ACTIVE'
      ORDER BY versions.precedence DESC, rules.updated_at DESC, rules.id DESC LIMIT 20
    `).all(input.projectId) as PackageRuleRow[];
    const workItemEntries = [linkedWorkItem, ...dependencies].filter((item): item is PackageWorkItemRow => Boolean(item)).map((item, index) => ({
      id: item.id, title: item.title, resourceType: "WORK_ITEM" as const,
      summary: formatWorkItemPackageSummary(item), contentHash: null, revision: item.revision,
      selectionReason: index === 0 ? "active-work-item-for-session" : "blocking-dependency-of-active-work-item"
    }));
    const decisionEntries = decisions.map((decision) => ({
      id: decision.id, title: decision.title, resourceType: "DECISION" as const,
      summary: clipPackageText(`${decision.statement}\nRationale: ${decision.rationale}`), contentHash: decision.content_hash, revision: decision.revision,
      selectionReason: "accepted-project-decision"
    }));
    const contextItemEntries = contextItems.map((item) => ({
      id: item.id, title: item.title, resourceType: "CONTEXT_ITEM" as const,
      summary: clipPackageText(item.summary), contentHash: null, revision: item.revision,
      selectionReason: item.source_snapshot_id ? "active-context-item-from-evidence" : "active-context-item"
    }));
    const evidenceEntries = evidenceSnapshots.map((snapshot) => ({
      id: snapshot.id, title: snapshot.title, resourceType: "EVIDENCE_SNAPSHOT" as const,
      summary: null, contentHash: snapshot.content_hash, revision: null,
      selectionReason: "source-evidence-for-selected-context"
    }));
    const ruleEntries = rules.map((rule) => ({
      id: rule.id, title: rule.title, resourceType: "RULE" as const,
      summary: clipPackageText(`${rule.enforcement_mode}: ${rule.description || JSON.stringify(JSON.parse(rule.effect_json))}`), contentHash: rule.content_hash, revision: rule.revision,
      selectionReason: "active-project-rule"
    }));
    const selectionManifest: StoredContextPackageManifest = {
      schemaVersion: "context-package.v2", generatedFor: "session-continue",
      workItems: workItemEntries, decisions: decisionEntries, contextItems: contextItemEntries,
      evidenceSnapshots: evidenceEntries, rules: ruleEntries
    };
    const name = "Session context package";
    const purpose = input.intent?.trim() || "Continue session";

    this.db.transaction(() => {
      this.db.prepare("INSERT INTO context_packages (id, project_id, name, purpose, context_item_ids_json, evidence_snapshot_ids_json, selection_manifest_json, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)")
        .run(packageId, input.projectId, name, purpose, JSON.stringify(contextItems.map((item) => item.id)), JSON.stringify(evidenceSnapshots.map((snapshot) => snapshot.id)), JSON.stringify(selectionManifest), now, now);
      this.db.prepare("UPDATE sessions SET context_package_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(packageId, now, input.sessionId);
    })();

    return this.getContextPackageForSession(input.sessionId);
  }

  getContextPackageForSession(sessionId: string): ContextPackageDto {
    const row = this.db.prepare("SELECT packages.* FROM sessions JOIN context_packages packages ON packages.id = sessions.context_package_id WHERE sessions.id = ?").get(sessionId) as ContextPackageRow | undefined;
    if (!row) throw new ContextOsError("NOT_FOUND", "Context Package not found", { sessionId });
    return this.mapContextPackage(sessionId, row);
  }


  createSessionRunEvidence(input: { id: string; projectId: string; sessionId: string; runId: string; title: string; contentHash: string; storageRef: string; sizeBytes: number; outputTruncated: boolean }, now: number): EvidenceSnapshotDto {
    const metadata = { sessionId: input.sessionId, runId: input.runId, stream: "process-output", outputTruncated: input.outputTruncated };
    this.db.prepare("INSERT INTO evidence_snapshots (id, project_id, source_id, evidence_type, title, uri, content_text, content_hash, storage_ref, size_bytes, metadata_json, captured_at, created_at) VALUES (?, ?, NULL, 'AGENT_OUTPUT', ?, NULL, NULL, ?, ?, ?, ?, ?, ?)")
      .run(input.id, input.projectId, input.title, input.contentHash, input.storageRef, input.sizeBytes, JSON.stringify(metadata), now, now);
    return mapEvidenceSnapshot(this.db.prepare("SELECT * FROM evidence_snapshots WHERE id = ?").get(input.id) as EvidenceSnapshotRow);
  }

  createSessionHandoffEvidence(input: { id: string; projectId: string; sessionId: string; contextPackageId: string; title: string; contentHash: string; storageRef: string; sizeBytes: number }, now: number): EvidenceSnapshotDto {
    const metadata = { sessionId: input.sessionId, contextPackageId: input.contextPackageId, stream: "contextos-handoff" };
    this.db.prepare("INSERT INTO evidence_snapshots (id, project_id, source_id, evidence_type, title, uri, content_text, content_hash, storage_ref, size_bytes, metadata_json, captured_at, created_at) VALUES (?, ?, NULL, 'AGENT_OUTPUT', ?, NULL, NULL, ?, ?, ?, ?, ?, ?)")
      .run(input.id, input.projectId, input.title, input.contentHash, input.storageRef, input.sizeBytes, JSON.stringify(metadata), now, now);
    return mapEvidenceSnapshot(this.db.prepare("SELECT * FROM evidence_snapshots WHERE id = ?").get(input.id) as EvidenceSnapshotRow);
  }

  importSessionTranscript(input: { id: string; projectId: string; sessionId: string; title: string; summary: string; contentHash: string; storageRef: string; sizeBytes: number; externalSessionId?: string; metadata?: Record<string, unknown> }, now: number): TranscriptImportResult {
    return this.db.transaction(() => {
      const row = this.getResumeSessionRow(input.sessionId);
      const state = JSON.parse(row.runtime_state) as { resumeCapsule?: ResumeCapsuleState };
      const current = mapResumeCapsule(row, state.resumeCapsule);
      const evidenceSnapshotIds = [...new Set([...current.evidenceSnapshotIds, input.id])];
      const importedAt = new Date(now).toISOString();
      if (row.external_session_id && input.externalSessionId && row.external_session_id !== input.externalSessionId) {
        throw new ContextOsError("CONFLICT", "Session is already bound to a different external agent session", { sessionId: input.sessionId });
      }
      const metadata = { ...input.metadata, sessionId: input.sessionId, stream: "imported-transcript", importedAt };

      this.db.prepare("INSERT INTO evidence_snapshots (id, project_id, source_id, evidence_type, title, uri, content_text, content_hash, storage_ref, size_bytes, metadata_json, captured_at, created_at) VALUES (?, ?, NULL, 'AGENT_OUTPUT', ?, NULL, NULL, ?, ?, ?, ?, ?, ?)")
        .run(input.id, input.projectId, input.title, input.contentHash, input.storageRef, input.sizeBytes, JSON.stringify(metadata), now, now);
      this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'SESSION', ?, 'TRANSCRIPT_IMPORTED', 'Imported transcript evidence', ?, ?)")
        .run(newId("act"), input.projectId, input.sessionId, JSON.stringify({ evidenceSnapshotId: input.id }), now);
      this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, after_json, created_at) VALUES (?, ?, 'USER', 'SESSION', ?, 'TRANSCRIPT_IMPORTED', ?, ?)")
        .run(newId("audit"), input.projectId, input.sessionId, JSON.stringify({ evidenceSnapshotId: input.id, storageRef: input.storageRef, contentHash: input.contentHash, sizeBytes: input.sizeBytes }), now);

      const next: ResumeCapsuleDto = {
        sessionId: input.sessionId,
        status: row.status,
        intent: row.intent,
        summary: input.summary,
        nextAction: current.nextAction,
        // An imported transcript is raw text, not a decoded batch, so it builds no continuity.
        contextText: current.contextText,
        lastRunId: current.lastRunId,
        evidenceSnapshotIds,
        updatedAt: importedAt
      };
      state.resumeCapsule = {
        summary: next.summary,
        nextAction: next.nextAction,
        contextText: next.contextText,
        lastRunId: next.lastRunId,
        evidenceSnapshotIds: next.evidenceSnapshotIds,
        updatedAt: next.updatedAt
      };
      this.db.prepare("UPDATE sessions SET runtime_state = ?, resume_capsule_id = ?, external_session_id = COALESCE(external_session_id, ?), last_activity_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(JSON.stringify(state), evidenceSnapshotIds[0] ?? null, input.externalSessionId ?? null, now, now, input.sessionId);

      const evidence = this.db.prepare("SELECT * FROM evidence_snapshots WHERE id = ?").get(input.id) as EvidenceSnapshotRow;
      return { evidence: mapEvidenceSnapshot(evidence), resumeCapsule: next };
    })();
  }

  findSessionTranscriptByHash(sessionId: string, contentHash: string): EvidenceSnapshotDto | null {
    const row = this.db.prepare("SELECT * FROM evidence_snapshots WHERE content_hash = ? AND json_extract(metadata_json, '$.sessionId') = ? AND json_extract(metadata_json, '$.stream') = 'imported-transcript' ORDER BY created_at DESC LIMIT 1")
      .get(contentHash, sessionId) as EvidenceSnapshotRow | undefined;
    return row ? mapEvidenceSnapshot(row) : null;
  }

  bindExternalSession(sessionId: string, externalSessionId: string, now: number): ResumeCapsuleDto {
    const row = this.getResumeSessionRow(sessionId);
    if (row.external_session_id && row.external_session_id !== externalSessionId) {
      throw new ContextOsError("CONFLICT", "Session is already bound to a different external agent session", { sessionId });
    }
    if (!row.external_session_id) {
      this.db.prepare("UPDATE sessions SET external_session_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND external_session_id IS NULL")
        .run(externalSessionId, now, sessionId);
    }
    return this.getResumeCapsule(sessionId);
  }

  recordTranscriptReconciliationFailed(input: { sessionId: string; projectId: string; runId: string; externalSessionId: string | null; message: string }, now: number): void {
    const metadata = JSON.stringify({
      runId: input.runId,
      externalSessionId: input.externalSessionId,
      failureMessage: input.message
    });
    this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'SESSION', ?, 'TRANSCRIPT_RECONCILE_FAILED', 'Failed to reconcile agent transcript after run exit', ?, ?)")
      .run(newId("act"), input.projectId, input.sessionId, metadata, now);
    this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, after_json, created_at) VALUES (?, ?, 'SYSTEM', 'SESSION', ?, 'TRANSCRIPT_RECONCILE_FAILED', ?, ?)")
      .run(newId("audit"), input.projectId, input.sessionId, metadata, now);
  }

  listSessionEvidence(sessionId: string): EvidenceSnapshotDto[] {
    const session = this.db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(sessionId) as { project_id: string } | undefined;
    if (!session) throw new ContextOsError("NOT_FOUND", "Session not found", { id: sessionId });
    const rows = this.db.prepare("SELECT * FROM evidence_snapshots WHERE project_id = ? AND evidence_type = 'AGENT_OUTPUT' ORDER BY created_at DESC, id DESC LIMIT 100")
      .all(session.project_id) as EvidenceSnapshotRow[];
    return rows.filter((row) => {
      const metadata = JSON.parse(row.metadata_json) as { sessionId?: string };
      return metadata.sessionId === sessionId;
    }).map(mapEvidenceSnapshot);
  }

  writeResumeCapsule(input: { sessionId: string; status: SessionStatus; summary: string; nextAction: string | null; lastRunId: string | null; evidenceSnapshotIds: string[] }, now: number): ResumeCapsuleDto {
    const row = this.getResumeSessionRow(input.sessionId);
    const state = JSON.parse(row.runtime_state) as Record<string, unknown>;
    state.resumeCapsule = {
      summary: input.summary,
      nextAction: input.nextAction,
      lastRunId: input.lastRunId,
      evidenceSnapshotIds: input.evidenceSnapshotIds,
      updatedAt: new Date(now).toISOString()
    };
    this.db.prepare("UPDATE sessions SET runtime_state = ?, resume_capsule_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
      .run(JSON.stringify(state), input.evidenceSnapshotIds[0] ?? null, now, input.sessionId);
    return this.getResumeCapsule(input.sessionId);
  }

  /**
   * Writes the deterministic continuity excerpt produced from captured transcript Evidence.
   *
   * Deliberately separate from `writeResumeCapsule`: that one is driven by a run finishing,
   * while this one is driven by a sync batch and must be callable inside the ingestion
   * transaction so Evidence, reader offset and continuity commit — or roll back — together.
   */
  writeSessionContinuity(input: {
    sessionId: string;
    summary: string;
    nextAction: string | null;
    contextText: string;
    evidenceSnapshotIds: string[];
  }, now: number): ResumeCapsuleDto {
    const row = this.getResumeSessionRow(input.sessionId);
    const state = JSON.parse(row.runtime_state) as Record<string, unknown>;
    const current = (state.resumeCapsule ?? {}) as ResumeCapsuleState;
    state.resumeCapsule = {
      summary: input.summary,
      nextAction: input.nextAction,
      contextText: input.contextText,
      lastRunId: current.lastRunId ?? null,
      evidenceSnapshotIds: input.evidenceSnapshotIds,
      updatedAt: new Date(now).toISOString()
    };
    this.db.prepare("UPDATE sessions SET runtime_state = ?, resume_capsule_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
      .run(JSON.stringify(state), input.evidenceSnapshotIds.at(-1) ?? null, now, input.sessionId);
    return this.getResumeCapsule(input.sessionId);
  }

  getResumeCapsule(sessionId: string): ResumeCapsuleDto {
    const row = this.getResumeSessionRow(sessionId);
    const state = JSON.parse(row.runtime_state) as { resumeCapsule?: ResumeCapsuleState };
    return mapResumeCapsule(row, state.resumeCapsule);
  }

  patchResumeCapsule(input: { sessionId: string; expectedRevision: number; summary?: string; nextAction?: string | null }, now: number): ResumeCapsuleDto {
    const row = this.getResumeSessionRow(input.sessionId);
    const session = this.db.prepare("SELECT revision FROM sessions WHERE id = ?").get(input.sessionId) as { revision: number } | undefined;
    if (!session) throw new ContextOsError("NOT_FOUND", "Session not found", { id: input.sessionId });
    if (session.revision !== input.expectedRevision) {
      throw new ContextOsError("CONFLICT", "Session revision conflict", { id: input.sessionId, expectedRevision: input.expectedRevision, currentRevision: session.revision });
    }
    const state = JSON.parse(row.runtime_state) as { resumeCapsule?: ResumeCapsuleState };
    const current = mapResumeCapsule(row, state.resumeCapsule);
    state.resumeCapsule = {
      summary: input.summary ?? current.summary,
      nextAction: input.nextAction === undefined ? current.nextAction : input.nextAction,
      // Continuity is derived from Evidence, so a manual edit must never drop or forge it.
      contextText: current.contextText,
      lastRunId: current.lastRunId,
      evidenceSnapshotIds: current.evidenceSnapshotIds,
      updatedAt: new Date(now).toISOString()
    };
    const result = this.db.prepare("UPDATE sessions SET runtime_state = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
      .run(JSON.stringify(state), now, input.sessionId, input.expectedRevision);
    if (result.changes !== 1) {
      throw new ContextOsError("CONFLICT", "Session revision conflict", { id: input.sessionId, expectedRevision: input.expectedRevision });
    }
    return this.getResumeCapsule(input.sessionId);
  }

  recoverOrphanRunningContinues(now: number): number {
    const rows = this.db.prepare("SELECT runs.id AS run_id, runs.job_id AS job_id, runs.session_id AS session_id, sessions.project_id AS project_id FROM session_runs runs JOIN sessions ON sessions.id = runs.session_id WHERE runs.status = 'RUNNING' AND runs.job_id IS NOT NULL").all() as Array<{ run_id: string; job_id: string; session_id: string; project_id: string }>;
    if (rows.length === 0) return 0;

    this.db.transaction(() => {
      for (const row of rows) {
        this.db.prepare("UPDATE jobs SET status = 'FAILED', ended_at = ?, failure_code = 'DAEMON_RESTARTED', failure_message = 'Daemon restarted before this run completed', updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'RUNNING'")
          .run(now, now, row.job_id);
        this.db.prepare("UPDATE session_runs SET status = 'FAILED', ended_at = ?, failure_code = 'DAEMON_RESTARTED', failure_message = 'Daemon restarted before this run completed', updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'RUNNING'")
          .run(now, now, row.run_id);
        this.db.prepare("UPDATE job_attempts SET status = 'FAILED', ended_at = ?, failure_code = 'DAEMON_RESTARTED', failure_message = 'Daemon restarted before this run completed' WHERE job_id = ? AND status = 'STARTED'")
          .run(now, row.job_id);
        this.db.prepare("UPDATE sessions SET status = 'FAILED', completed_at = COALESCE(completed_at, ?), last_activity_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'RUNNING'")
          .run(now, now, now, row.session_id);
        this.reconcileWorkItemAttempt(row.run_id, "FAILED", now, "Daemon restarted before this run completed");
        this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'SESSION', ?, 'CONTINUE_RECOVERED_FAILED', 'Marked orphaned continue run failed after daemon restart', ?, ?)")
          .run(newId("act"), row.project_id, row.session_id, JSON.stringify({ jobId: row.job_id, runId: row.run_id, failureCode: "DAEMON_RESTARTED" }), now);
        this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, after_json, created_at) VALUES (?, ?, 'SYSTEM', 'SESSION', ?, 'CONTINUE_RECOVERED_FAILED', ?, ?)")
          .run(newId("audit"), row.project_id, row.session_id, JSON.stringify({ jobId: row.job_id, runId: row.run_id, failureCode: "DAEMON_RESTARTED" }), now);
      }
    })();
    return rows.length;
  }

  cancelManagedRunningContinues(pids: number[], now: number): number {
    if (pids.length === 0) return 0;
    const placeholders = pids.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT runs.id AS run_id, runs.job_id AS job_id, runs.session_id AS session_id, sessions.project_id AS project_id FROM session_runs runs JOIN sessions ON sessions.id = runs.session_id WHERE runs.status = 'RUNNING' AND runs.job_id IS NOT NULL AND runs.pid IN (${placeholders})`)
      .all(...pids) as Array<{ run_id: string; job_id: string; session_id: string; project_id: string }>;
    if (rows.length === 0) return 0;

    this.db.transaction(() => {
      for (const row of rows) {
        this.db.prepare("UPDATE jobs SET status = 'CANCELED', ended_at = ?, failure_code = 'DAEMON_SHUTDOWN', failure_message = 'Daemon shut down while this run was active', updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'RUNNING'")
          .run(now, now, row.job_id);
        this.db.prepare("UPDATE session_runs SET status = 'CANCELED', ended_at = ?, failure_code = 'DAEMON_SHUTDOWN', failure_message = 'Daemon shut down while this run was active', updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'RUNNING'")
          .run(now, now, row.run_id);
        this.db.prepare("UPDATE job_attempts SET status = 'CANCELED', ended_at = ?, failure_code = 'DAEMON_SHUTDOWN', failure_message = 'Daemon shut down while this run was active' WHERE job_id = ? AND status = 'STARTED'")
          .run(now, row.job_id);
        this.db.prepare("UPDATE sessions SET status = 'PAUSED', completed_at = NULL, last_activity_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'RUNNING'")
          .run(now, now, row.session_id);
        this.reconcileWorkItemAttempt(row.run_id, "CANCELED", now, "Daemon shut down while this run was active");
        const metadata = JSON.stringify({ jobId: row.job_id, runId: row.run_id, failureCode: "DAEMON_SHUTDOWN" });
        this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'SESSION', ?, 'CONTINUE_CANCELED_ON_SHUTDOWN', 'Canceled active run during daemon shutdown', ?, ?)")
          .run(newId("act"), row.project_id, row.session_id, metadata, now);
        this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, after_json, created_at) VALUES (?, ?, 'SYSTEM', 'SESSION', ?, 'CONTINUE_CANCELED_ON_SHUTDOWN', ?, ?)")
          .run(newId("audit"), row.project_id, row.session_id, metadata, now);
      }
    })();
    return rows.length;
  }

  getProjectRoot(projectId: string): string {
    const row = this.db.prepare("SELECT root_path FROM projects WHERE id = ?").get(projectId) as { root_path: string } | undefined;
    if (!row) throw new ContextOsError("NOT_FOUND", "Project not found", { id: projectId });
    return row.root_path;
  }



  private getResumeSessionRow(sessionId: string): ResumeSessionRow {
    const row = this.db.prepare("SELECT id, project_id, intent, status, runtime_state, updated_at, external_session_id FROM sessions WHERE id = ?").get(sessionId) as ResumeSessionRow | undefined;
    if (!row) throw new ContextOsError("NOT_FOUND", "Session not found", { id: sessionId });
    return row;
  }

  private mapContextPackage(sessionId: string, row: ContextPackageRow): ContextPackageDto {
    const contextItemIds = JSON.parse(row.context_item_ids_json) as string[];
    const evidenceSnapshotIds = JSON.parse(row.evidence_snapshot_ids_json) as string[];
    const contextItems = contextItemIds.length === 0
      ? []
      : this.db.prepare(`SELECT id, title, summary, source_snapshot_id, revision FROM context_items WHERE id IN (${contextItemIds.map(() => "?").join(",")}) ORDER BY updated_at DESC, id DESC`)
        .all(...contextItemIds) as PackageContextItemRow[];
    const evidenceSnapshots = evidenceSnapshotIds.length === 0
      ? []
      : this.db.prepare(`SELECT id, title, content_hash FROM evidence_snapshots WHERE id IN (${evidenceSnapshotIds.map(() => "?").join(",")}) ORDER BY created_at DESC, id DESC`)
        .all(...evidenceSnapshotIds) as PackageEvidenceRow[];

    const stored = row.selection_manifest_json ? JSON.parse(row.selection_manifest_json) as StoredContextPackageManifest : null;
    return {
      id: row.id,
      projectId: row.project_id,
      sessionId,
      name: row.name,
      purpose: row.purpose,
      workItems: stored?.workItems ?? [],
      decisions: stored?.decisions ?? [],
      contextItems: stored?.contextItems ?? contextItems.map((item) => ({
        id: item.id,
        title: item.title,
        resourceType: "CONTEXT_ITEM",
        summary: item.summary,
        contentHash: null,
        revision: item.revision,
        selectionReason: item.source_snapshot_id ? "active-context-item-from-evidence" : "active-context-item"
      })),
      evidenceSnapshots: stored?.evidenceSnapshots ?? evidenceSnapshots.map((snapshot) => ({
        id: snapshot.id,
        title: snapshot.title,
        resourceType: "EVIDENCE_SNAPSHOT",
        summary: null,
        contentHash: snapshot.content_hash,
        revision: null,
        selectionReason: "source-evidence-for-selected-context"
      })),
      rules: stored?.rules ?? [],
      manifest: {
        schemaVersion: stored?.schemaVersion ?? "context-package.v1",
        contextItemIds,
        evidenceSnapshotIds,
        workItemIds: stored?.workItems.map((item) => item.id) ?? [],
        decisionIds: stored?.decisions.map((item) => item.id) ?? [],
        ruleIds: stored?.rules.map((item) => item.id) ?? [],
        generatedFor: stored?.generatedFor ?? "session-continue"
      },
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      revision: row.revision
    };
  }

  private getJob(id: string): RuntimeJobDto {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    if (!row) throw new ContextOsError("NOT_FOUND", "Job not found", { id });
    return mapJob(row);
  }

  private getSessionRun(id: string): SessionRunDto {
    const row = this.db.prepare("SELECT * FROM session_runs WHERE id = ?").get(id) as SessionRunRow | undefined;
    if (!row) throw new ContextOsError("NOT_FOUND", "Session run not found", { id });
    return mapSessionRun(row);
  }

  private getRunSessionResource(runId: string): { sessionId: string; projectId: string } {
    const row = this.db.prepare("SELECT runs.session_id AS sessionId, sessions.project_id AS projectId FROM session_runs runs JOIN sessions ON sessions.id = runs.session_id WHERE runs.id = ?")
      .get(runId) as { sessionId: string; projectId: string } | undefined;
    if (!row) throw new ContextOsError("NOT_FOUND", "Session run not found", { id: runId });
    return row;
  }

  private reconcileWorkItemAttempt(
    runId: string,
    status: "STARTED" | "SUCCEEDED" | "FAILED" | "CANCELED",
    now: number,
    detail?: string
  ): void {
    const attempts = this.db.prepare(`
      SELECT attempts.id AS attemptId, attempts.work_item_id AS workItemId,
             attempts.status AS previousStatus, work_items.project_id AS projectId
      FROM work_item_attempts attempts
      JOIN work_items ON work_items.id = attempts.work_item_id
      WHERE attempts.session_id = (SELECT session_id FROM session_runs WHERE id = ?)
        AND attempts.status != ?
    `).all(runId, status) as Array<{ attemptId: string; workItemId: string; previousStatus: string; projectId: string }>;
    if (attempts.length === 0) return;

    const endedAt = status === "STARTED" ? null : now;
    const eventType = `WORK_ITEM_ATTEMPT_${status}`;
    const summary = detail ?? (status === "STARTED" ? "Agent session attempt started" : `Agent session attempt ${status.toLowerCase()}`);
    const update = this.db.prepare("UPDATE work_item_attempts SET status = ?, result_ref = ?, ended_at = ? WHERE id = ?");
    const activity = this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'WORK_ITEM', ?, ?, ?, ?, ?)");
    const audit = this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, before_json, after_json, created_at) VALUES (?, ?, 'SYSTEM', 'WORK_ITEM', ?, ?, ?, ?, ?)");
    for (const attempt of attempts) {
      update.run(status, runId, endedAt, attempt.attemptId);
      const metadata = JSON.stringify({ attemptId: attempt.attemptId, runId, previousStatus: attempt.previousStatus, status, detail: detail ?? null });
      activity.run(newId("act"), attempt.projectId, attempt.workItemId, eventType, summary, metadata, now);
      audit.run(newId("audit"), attempt.projectId, attempt.workItemId, eventType, JSON.stringify({ attemptId: attempt.attemptId, status: attempt.previousStatus }), metadata, now);
    }
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
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    capturedAt: new Date(row.captured_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString()
  };
}

function mapResumeCapsule(row: ResumeSessionRow, capsule?: ResumeCapsuleState): ResumeCapsuleDto {
  if (!capsule) {
    return {
      sessionId: row.id,
      status: row.status,
      intent: row.intent,
      summary: row.intent ? `Session is ready to continue: ${row.intent}` : "Session is ready to continue.",
      nextAction: "Continue in Agent",
      contextText: null,
      lastRunId: null,
      evidenceSnapshotIds: [],
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }
  return {
    sessionId: row.id,
    status: row.status,
    intent: row.intent,
    summary: capsule.summary ?? "Session has a resume capsule.",
    nextAction: capsule.nextAction ?? null,
    contextText: capsule.contextText ?? null,
    lastRunId: capsule.lastRunId ?? null,
    evidenceSnapshotIds: capsule.evidenceSnapshotIds ?? [],
    updatedAt: capsule.updatedAt ?? new Date(row.updated_at).toISOString()
  };
}

function mapSettings(row: SettingsRow): SettingsDto {
  return {
    id: row.id,
    launchAtStartup: bool(row.launch_at_startup),
    startMinimized: bool(row.start_minimized),
    confirmDestructiveActions: bool(row.confirm_destructive_actions),
    localEndpoint: row.local_endpoint,
    defaultAdapterId: row.default_adapter_id,
    contextConfig: JSON.parse(row.context_config_json) as Record<string, unknown>,
    privacyConfig: JSON.parse(row.privacy_config_json) as Record<string, unknown>,
    dataDirectory: row.data_directory,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    revision: row.revision,
    requiresRestart: false
  };
}

function mapJob(row: JobRow): RuntimeJobDto {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    availableAt: new Date(row.available_at).toISOString(),
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    revision: row.revision
  };
}

function mapSessionRun(row: SessionRunRow): SessionRunDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    jobId: row.job_id,
    externalRunId: row.external_run_id,
    status: row.status,
    pid: row.pid,
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    exitCode: row.exit_code,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    adapterVersion: row.adapter_version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    revision: row.revision
  };
}

function statusRecord<T extends string>(statuses: T[], rows: Array<{ status: T; count: number }>): Record<T, number> {
  const output = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<T, number>;
  for (const row of rows) output[row.status] = row.count;
  return output;
}

function mapActivityEvent(row: ActivityEventRow): ResourceActivityEventDto {
  return {
    id: row.id,
    kind: "ACTIVITY",
    projectId: row.project_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    eventType: row.event_type,
    summary: row.summary,
    actorType: null,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: new Date(row.created_at).toISOString()
  };
}

function mapAuditEvent(row: AuditEventRow): ResourceActivityEventDto {
  return {
    id: row.id,
    kind: "AUDIT",
    projectId: row.project_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    eventType: row.action,
    summary: row.action,
    actorType: row.actor_type,
    metadata: row.after_json ? JSON.parse(row.after_json) as Record<string, unknown> : {},
    createdAt: new Date(row.created_at).toISOString()
  };
}



