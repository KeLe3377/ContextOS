import type { Database } from "better-sqlite3";
import type { ContextPackageDto, EvidenceSnapshotDto } from "../../../contracts/src/context.js";
import type { RuntimeJobDto, SessionRunDto, SettingsDto, SettingsPatch } from "../../../contracts/src/runtime.js";
import type { ResumeCapsuleDto, SessionStatus } from "../../../contracts/src/sessions.js";
import { ContextOsError } from "../../../shared/src/errors.js";
import { newId } from "../../../shared/src/id.js";

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
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
  created_at: number;
  updated_at: number;
  revision: number;
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

type ContextPackageRow = {
  id: string;
  project_id: string;
  name: string;
  purpose: string;
  context_item_ids_json: string;
  evidence_snapshot_ids_json: string;
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
};

export class SqliteRuntimeRepository {
  constructor(private readonly db: Database) {}

  getSettings(): SettingsDto {
    const row = this.db.prepare("SELECT * FROM settings WHERE id = 'singleton'").get() as SettingsRow | undefined;
    if (!row) throw new ContextOsError("NOT_FOUND", "Settings not found");
    return mapSettings(row);
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
      this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'SESSION', ?, 'CONTINUE_QUEUED', 'Queued Codex continue session job', ?, ?)")
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
    })();
    return { job: this.getJob(input.jobId), run: this.getSessionRun(input.runId) };
  }

  markContinueExitedFailed(input: { jobId: string; runId: string; exitCode: number | null; signal: string | null; failureMessage: string }, now: number): { job: RuntimeJobDto; run: SessionRunDto } {
    const failureCode = input.signal ? "PROCESS_SIGNALED" : "PROCESS_EXITED";
    this.db.transaction(() => {
      this.db.prepare("UPDATE jobs SET status = 'FAILED', ended_at = ?, failure_code = ?, failure_message = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'RUNNING'")
        .run(now, failureCode, input.failureMessage, now, input.jobId);
      this.db.prepare("UPDATE session_runs SET status = 'FAILED', ended_at = ?, exit_code = ?, failure_code = ?, failure_message = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'RUNNING'")
        .run(now, input.exitCode, failureCode, input.failureMessage, now, input.runId);
      this.db.prepare("UPDATE job_attempts SET status = 'FAILED', ended_at = ?, failure_code = ?, failure_message = ? WHERE job_id = ? AND status = 'STARTED'")
        .run(now, failureCode, input.failureMessage, input.jobId);
      this.db.prepare("UPDATE sessions SET status = 'FAILED', completed_at = COALESCE(completed_at, ?), last_activity_at = ?, updated_at = ?, revision = revision + 1 WHERE id = (SELECT session_id FROM session_runs WHERE id = ?) AND status = 'RUNNING'")
        .run(now, now, now, input.runId);
    })();
    return { job: this.getJob(input.jobId), run: this.getSessionRun(input.runId) };
  }

  markContinueFailed(input: { jobId: string; runId: string; failureCode: string; failureMessage: string }, now: number): { job: RuntimeJobDto; run: SessionRunDto } {
    this.db.transaction(() => {
      this.db.prepare("UPDATE jobs SET status = 'FAILED', ended_at = ?, failure_code = ?, failure_message = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, input.failureCode, input.failureMessage, now, input.jobId);
      this.db.prepare("UPDATE session_runs SET status = 'FAILED', ended_at = ?, failure_code = ?, failure_message = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, input.failureCode, input.failureMessage, now, input.runId);
      this.db.prepare("UPDATE sessions SET status = 'FAILED', completed_at = COALESCE(completed_at, ?), last_activity_at = ?, updated_at = ?, revision = revision + 1 WHERE id = (SELECT session_id FROM session_runs WHERE id = ?) AND status IN ('CREATED', 'RUNNING')")
        .run(now, now, now, input.runId);
      this.db.prepare("INSERT INTO job_attempts (id, job_id, status, started_at, ended_at, failure_code, failure_message) VALUES (?, ?, 'FAILED', ?, ?, ?, ?)")
        .run(newId("jattempt"), input.jobId, now, now, input.failureCode, input.failureMessage);
    })();
    return { job: this.getJob(input.jobId), run: this.getSessionRun(input.runId) };
  }



  createContextPackageForSession(input: { projectId: string; sessionId: string; intent: string | null }, now: number): ContextPackageDto {
    const packageId = newId("pkg");
    const contextItems = this.db.prepare("SELECT id, title, summary, source_snapshot_id, revision FROM context_items WHERE project_id = ? AND status = 'ACTIVE' ORDER BY updated_at DESC, id DESC LIMIT 20")
      .all(input.projectId) as PackageContextItemRow[];
    const evidenceIds = Array.from(new Set(contextItems.map((item) => item.source_snapshot_id).filter((id): id is string => Boolean(id))));
    const evidenceSnapshots = evidenceIds.length === 0
      ? []
      : this.db.prepare(`SELECT id, title, content_hash FROM evidence_snapshots WHERE project_id = ? AND id IN (${evidenceIds.map(() => "?").join(",")}) ORDER BY created_at DESC, id DESC`)
        .all(input.projectId, ...evidenceIds) as PackageEvidenceRow[];
    const name = "Session context package";
    const purpose = input.intent?.trim() || "Continue session";

    this.db.transaction(() => {
      this.db.prepare("INSERT INTO context_packages (id, project_id, name, purpose, context_item_ids_json, evidence_snapshot_ids_json, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)")
        .run(packageId, input.projectId, name, purpose, JSON.stringify(contextItems.map((item) => item.id)), JSON.stringify(evidenceSnapshots.map((snapshot) => snapshot.id)), now, now);
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

  getResumeCapsule(sessionId: string): ResumeCapsuleDto {
    const row = this.getResumeSessionRow(sessionId);
    const state = JSON.parse(row.runtime_state) as { resumeCapsule?: { summary?: string; nextAction?: string | null; lastRunId?: string | null; evidenceSnapshotIds?: string[]; updatedAt?: string } };
    const capsule = state.resumeCapsule;
    if (!capsule) {
      return {
        sessionId,
        status: row.status,
        intent: row.intent,
        summary: row.intent ? `Session is ready to continue: ${row.intent}` : "Session is ready to continue.",
        nextAction: "Continue in Agent",
        lastRunId: null,
        evidenceSnapshotIds: [],
        updatedAt: new Date(row.updated_at).toISOString()
      };
    }
    return {
      sessionId,
      status: row.status,
      intent: row.intent,
      summary: capsule.summary ?? "Session has a resume capsule.",
      nextAction: capsule.nextAction ?? null,
      lastRunId: capsule.lastRunId ?? null,
      evidenceSnapshotIds: capsule.evidenceSnapshotIds ?? [],
      updatedAt: capsule.updatedAt ?? new Date(row.updated_at).toISOString()
    };
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
        this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'SESSION', ?, 'CONTINUE_RECOVERED_FAILED', 'Marked orphaned continue run failed after daemon restart', ?, ?)")
          .run(newId("act"), row.project_id, row.session_id, JSON.stringify({ jobId: row.job_id, runId: row.run_id, failureCode: "DAEMON_RESTARTED" }), now);
        this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, after_json, created_at) VALUES (?, ?, 'SYSTEM', 'SESSION', ?, 'CONTINUE_RECOVERED_FAILED', ?, ?)")
          .run(newId("audit"), row.project_id, row.session_id, JSON.stringify({ jobId: row.job_id, runId: row.run_id, failureCode: "DAEMON_RESTARTED" }), now);
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
    const row = this.db.prepare("SELECT id, project_id, intent, status, runtime_state, updated_at FROM sessions WHERE id = ?").get(sessionId) as ResumeSessionRow | undefined;
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

    return {
      id: row.id,
      projectId: row.project_id,
      sessionId,
      name: row.name,
      purpose: row.purpose,
      contextItems: contextItems.map((item) => ({
        id: item.id,
        title: item.title,
        contentHash: null,
        revision: item.revision,
        selectionReason: item.source_snapshot_id ? "active-context-item-from-evidence" : "active-context-item"
      })),
      evidenceSnapshots: evidenceSnapshots.map((snapshot) => ({
        id: snapshot.id,
        title: snapshot.title,
        contentHash: snapshot.content_hash,
        revision: null,
        selectionReason: "source-evidence-for-selected-context"
      })),
      manifest: {
        schemaVersion: "context-package.v1",
        contextItemIds,
        evidenceSnapshotIds,
        generatedFor: "session-continue"
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



