import { spawnSync } from "node:child_process";
import type { AgentAdapterStatusDto, AgentLaunchInfoDto } from "../../../contracts/src/runtime.js";
import type { ProcessSupervisor } from "../process-supervisor.js";

export class CodexAdapter {
  readonly id = "codex";
  readonly displayName = "Codex";
  private readonly command: string;
  private readonly launchArgs: string[];

  constructor(
    command = process.env.CONTEXTOS_CODEX_COMMAND ?? "codex",
    launchArgs = parseArgs(process.env.CONTEXTOS_CODEX_ARGS)
  ) {
    this.command = command;
    this.launchArgs = launchArgs;
  }

  discover(): AgentAdapterStatusDto {
    const result = spawnSync(this.command, ["--version"], {
      encoding: "utf8",
      shell: false,
      timeout: 1500,
      windowsHide: true
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    return {
      id: this.id,
      displayName: this.displayName,
      available: !result.error && result.status === 0,
      command: this.command,
      version: !result.error && result.status === 0 ? output || null : null,
      error: result.error ? result.error.message : result.status === 0 ? null : output || `Exited with status ${result.status}`,
      capabilities: ["discover", "launch", "resume"]
    };
  }

  buildLaunchInfo(input: { cwd: string }): AgentLaunchInfoDto {
    return {
      adapterId: this.id,
      command: this.command,
      args: this.launchArgs,
      cwd: input.cwd,
      mode: "queued-job"
    };
  }

  launch(input: { cwd: string; supervisor: ProcessSupervisor }): { pid: number; launch: AgentLaunchInfoDto } {
    const launch = this.buildLaunchInfo(input);
    const process = input.supervisor.launch({ command: launch.command, args: launch.args, cwd: launch.cwd });
    return { pid: process.pid, launch };
  }
}

function parseArgs(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // Fall through to whitespace splitting for local developer convenience.
  }
  return value.split(" ").map((part) => part.trim()).filter(Boolean);
}
