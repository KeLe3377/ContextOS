import type { Database } from "better-sqlite3";
import type { RuntimeJobDto, SessionRunDto, SettingsDto, SettingsPatch } from "../../../contracts/src/runtime.js";
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

  createContinueSessionJob(input: { sessionId: string; projectId: string; adapterId: string; adapterVersion: string; launchInfo: Record<string, unknown> }, now: number): { job: RuntimeJobDto; run: SessionRunDto } {
    const jobId = newId("job");
    const runId = newId("run");
    const payload = { sessionId: input.sessionId, projectId: input.projectId, adapterId: input.adapterId, launchInfo: input.launchInfo };
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO jobs (id, kind, status, resource_type, resource_id, payload_json, available_at, created_at, updated_at, revision) VALUES (?, 'CONTINUE_SESSION', 'CREATED', 'SESSION', ?, ?, ?, ?, ?, 1)")
        .run(jobId, input.sessionId, JSON.stringify(payload), now, now, now);
      this.db.prepare("INSERT INTO session_runs (id, session_id, job_id, status, adapter_version, created_at, updated_at, revision) VALUES (?, ?, ?, 'CREATED', ?, ?, ?, 1)")
        .run(runId, input.sessionId, jobId, input.adapterVersion, now, now);
      this.db.prepare("INSERT INTO activity_events (id, project_id, resource_type, resource_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'SESSION', ?, 'CONTINUE_QUEUED', 'Queued Codex continue session job', ?, ?)")
        .run(newId("act"), input.projectId, input.sessionId, JSON.stringify({ jobId, runId, adapterId: input.adapterId }), now);
      this.db.prepare("INSERT INTO audit_events (id, project_id, actor_type, resource_type, resource_id, action, after_json, created_at) VALUES (?, ?, 'SYSTEM', 'SESSION', ?, 'CONTINUE_QUEUED', ?, ?)")
        .run(newId("audit"), input.projectId, input.sessionId, JSON.stringify({ jobId, runId }), now);
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

  markContinueFailed(input: { jobId: string; runId: string; failureCode: string; failureMessage: string }, now: number): { job: RuntimeJobDto; run: SessionRunDto } {
    this.db.transaction(() => {
      this.db.prepare("UPDATE jobs SET status = 'FAILED', ended_at = ?, failure_code = ?, failure_message = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, input.failureCode, input.failureMessage, now, input.jobId);
      this.db.prepare("UPDATE session_runs SET status = 'FAILED', ended_at = ?, failure_code = ?, failure_message = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, input.failureCode, input.failureMessage, now, input.runId);
      this.db.prepare("INSERT INTO job_attempts (id, job_id, status, started_at, ended_at, failure_code, failure_message) VALUES (?, ?, 'FAILED', ?, ?, ?, ?)")
        .run(newId("jattempt"), input.jobId, now, now, input.failureCode, input.failureMessage);
    })();
    return { job: this.getJob(input.jobId), run: this.getSessionRun(input.runId) };
  }

  getProjectRoot(projectId: string): string {
    const row = this.db.prepare("SELECT root_path FROM projects WHERE id = ?").get(projectId) as { root_path: string } | undefined;
    if (!row) throw new ContextOsError("NOT_FOUND", "Project not found", { id: projectId });
    return row.root_path;
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

