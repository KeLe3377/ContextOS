import type { ContextPackageDto, EvidenceSnapshotDto } from "../../../contracts/src/context.js";
import type { AgentAdapterStatusDto, AgentLaunchInfoDto, RuntimeJobDto, SessionRunDto, SettingsDto, SettingsPatch } from "../../../contracts/src/runtime.js";
import type { ResumeCapsuleDto, SessionDto, SessionStatus } from "../../../contracts/src/sessions.js";
import type { CodexAdapter } from "../../../infrastructure/src/adapters/codex-adapter.js";
import type { FileEvidenceStore } from "../../../infrastructure/src/evidence/evidence-store.js";
import type { ProcessExitInfo, ProcessSupervisor } from "../../../infrastructure/src/process-supervisor.js";
import type { SqliteRuntimeRepository } from "../../../infrastructure/src/sqlite/runtime-repository.js";
import { nowMs } from "../../../shared/src/clock.js";
import { newId } from "../../../shared/src/id.js";

export type SessionContinueRuntime = {
  run: SessionRunDto;
  job: RuntimeJobDto;
  adapter: AgentAdapterStatusDto;
  launch: AgentLaunchInfoDto;
};

export class SettingsService {
  constructor(private readonly runtime: SqliteRuntimeRepository) {}

  get(): SettingsDto {
    return this.runtime.getSettings();
  }

  patch(input: SettingsPatch): SettingsDto {
    return this.runtime.patchSettings(input, nowMs());
  }
}

export class AgentAdapterService {
  constructor(private readonly codex: CodexAdapter) {}

  list(): AgentAdapterStatusDto[] {
    return [this.codex.discover()];
  }

  getCodex(): AgentAdapterStatusDto {
    return this.codex.discover();
  }
}

export class ContinueSessionService {
  constructor(
    private readonly runtime: SqliteRuntimeRepository,
    private readonly codex: CodexAdapter,
    private readonly supervisor: ProcessSupervisor,
    private readonly evidenceStore?: FileEvidenceStore
  ) {}

  continue(session: SessionDto): SessionContinueRuntime {
    const rootPath = this.runtime.getProjectRoot(session.projectId);
    const contextPackage = this.runtime.createContextPackageForSession({ projectId: session.projectId, sessionId: session.id, intent: session.intent }, nowMs());
    const adapter = this.codex.discover();
    const launch = this.codex.buildLaunchInfo({ cwd: rootPath });
    const created = this.runtime.createContinueSessionJob({
      sessionId: session.id,
      projectId: session.projectId,
      adapterId: adapter.id,
      adapterVersion: adapter.version ?? "unknown",
      contextPackageId: contextPackage.id,
      launchInfo: launch
    }, nowMs());

    if (!adapter.available) {
      const failed = this.runtime.markContinueFailed({
        jobId: created.job.id,
        runId: created.run.id,
        failureCode: "ADAPTER_UNAVAILABLE",
        failureMessage: adapter.error ?? "Codex adapter is unavailable"
      }, nowMs());
      return { ...failed, adapter, launch };
    }

    try {
      const launched = this.codex.launch({
        cwd: rootPath,
        supervisor: this.supervisor,
        onExit: (exit) => this.markProcessExit({ session, jobId: created.job.id, runId: created.run.id, exit })
      });
      const running = this.runtime.markContinueRunning({ jobId: created.job.id, runId: created.run.id, pid: launched.pid }, nowMs());
      return { ...running, adapter, launch: launched.launch };
    } catch (error) {
      const failed = this.runtime.markContinueFailed({
        jobId: created.job.id,
        runId: created.run.id,
        failureCode: "LAUNCH_FAILED",
        failureMessage: error instanceof Error ? error.message : "Codex launch failed"
      }, nowMs());
      return { ...failed, adapter, launch };
    }
  }

  getContextPackage(sessionId: string): ContextPackageDto {
    return this.runtime.getContextPackageForSession(sessionId);
  }

  listEvidence(sessionId: string): EvidenceSnapshotDto[] {
    return this.runtime.listSessionEvidence(sessionId);
  }

  getResumeCapsule(sessionId: string): ResumeCapsuleDto {
    return this.runtime.getResumeCapsule(sessionId);
  }

  private markProcessExit(input: { session: SessionDto; jobId: string; runId: string; exit: ProcessExitInfo }): void {
    const evidenceIds = this.recordProcessOutputEvidence(input);
    const status: SessionStatus = input.exit.code === 0 ? "COMPLETED" : "FAILED";
    try {
      if (input.exit.code === 0) {
        this.runtime.markContinueSucceeded({ jobId: input.jobId, runId: input.runId, exitCode: input.exit.code }, nowMs());
        this.writeResumeCapsule(input.session, input.runId, status, evidenceIds, "Codex run completed.", null);
        return;
      }
      const failureMessage = input.exit.signal
        ? `Codex process terminated with signal ${input.exit.signal}`
        : `Codex process exited with code ${input.exit.code ?? "unknown"}`;
      this.runtime.markContinueExitedFailed({ jobId: input.jobId, runId: input.runId, exitCode: input.exit.code, signal: input.exit.signal, failureMessage }, nowMs());
      this.writeResumeCapsule(input.session, input.runId, status, evidenceIds, failureMessage, "Review failed run evidence");
    } catch {
      // Phase A keeps lifecycle observation best-effort; Phase B startup recovery reconciles missed exits.
    }
  }

  private recordProcessOutputEvidence(input: { session: SessionDto; runId: string; exit: ProcessExitInfo }): string[] {
    if (!this.evidenceStore) return [];
    const output = formatProcessOutput(input.exit);
    if (!output.trim()) return [];
    try {
      const evidenceId = newId("ev");
      const stored = this.evidenceStore.writeText({ snapshotId: evidenceId, contentText: output });
      const snapshot = this.runtime.createSessionRunEvidence({
        id: evidenceId,
        projectId: input.session.projectId,
        sessionId: input.session.id,
        runId: input.runId,
        title: "Codex process output",
        contentHash: stored.contentHash,
        storageRef: stored.storageRef,
        sizeBytes: stored.sizeBytes,
        outputTruncated: input.exit.outputTruncated
      }, nowMs());
      return [snapshot.id];
    } catch {
      return [];
    }
  }

  private writeResumeCapsule(session: SessionDto, runId: string, status: SessionStatus, evidenceSnapshotIds: string[], summary: string, nextAction: string | null): void {
    try {
      this.runtime.writeResumeCapsule({
        sessionId: session.id,
        status,
        summary,
        nextAction,
        lastRunId: runId,
        evidenceSnapshotIds
      }, nowMs());
    } catch {
      // Resume capsule is useful but should not mask run lifecycle updates.
    }
  }
}

function formatProcessOutput(exit: ProcessExitInfo): string {
  const parts = [
    `exitCode: ${exit.code ?? "null"}`,
    `signal: ${exit.signal ?? "null"}`,
    `outputTruncated: ${exit.outputTruncated}`
  ];
  if (exit.stdout.trim()) parts.push(`\nstdout:\n${exit.stdout}`);
  if (exit.stderr.trim()) parts.push(`\nstderr:\n${exit.stderr}`);
  return `${parts.join("\n")}\n`;
}
