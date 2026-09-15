import type { AgentAdapterStatusDto, AgentLaunchInfoDto, RuntimeJobDto, SessionRunDto, SettingsDto, SettingsPatch } from "../../../contracts/src/runtime.js";
import type { CodexAdapter } from "../../../infrastructure/src/adapters/codex-adapter.js";
import type { ProcessSupervisor } from "../../../infrastructure/src/process-supervisor.js";
import type { SqliteRuntimeRepository } from "../../../infrastructure/src/sqlite/runtime-repository.js";
import type { SessionDto } from "../../../contracts/src/sessions.js";
import { nowMs } from "../../../shared/src/clock.js";

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
    private readonly supervisor: ProcessSupervisor
  ) {}

  continue(session: SessionDto): SessionContinueRuntime {
    const rootPath = this.runtime.getProjectRoot(session.projectId);
    const adapter = this.codex.discover();
    const launch = this.codex.buildLaunchInfo({ cwd: rootPath });
    const created = this.runtime.createContinueSessionJob({
      sessionId: session.id,
      projectId: session.projectId,
      adapterId: adapter.id,
      adapterVersion: adapter.version ?? "unknown",
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
      const launched = this.codex.launch({ cwd: rootPath, supervisor: this.supervisor });
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
}
