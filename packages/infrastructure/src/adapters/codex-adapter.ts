import { spawnSync } from "node:child_process";
import type { AgentAdapterStatusDto, AgentLaunchInfoDto } from "../../../contracts/src/runtime.js";
import type { ProcessExitInfo, ProcessSupervisor } from "../process-supervisor.js";

export class CodexAdapter {
  readonly id = "codex";
  readonly displayName = "Codex";
  private readonly command: string;
  private readonly launchArgs: string[];
  private readonly platform: NodeJS.Platform;

  constructor(
    command = process.env.CONTEXTOS_CODEX_COMMAND ?? defaultCodexCommand(),
    launchArgs = parseArgs(process.env.CONTEXTOS_CODEX_ARGS),
    platform = process.platform
  ) {
    this.command = command;
    this.launchArgs = launchArgs;
    this.platform = platform;
  }

  discover(): AgentAdapterStatusDto {
    const processCommand = resolveProcessCommand(this.command, ["--version"], this.platform);
    const result = spawnSync(processCommand.command, processCommand.args, {
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

  launch(input: { cwd: string; supervisor: ProcessSupervisor; onExit?: (exit: ProcessExitInfo) => void }): { pid: number; launch: AgentLaunchInfoDto } {
    const launch = this.buildLaunchInfo(input);
    const processCommand = resolveProcessCommand(launch.command, launch.args, this.platform);
    const process = input.supervisor.launch({ command: processCommand.command, args: processCommand.args, cwd: launch.cwd, captureOutput: true, onExit: input.onExit });
    return { pid: process.pid, launch };
  }
}

export function defaultCodexCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "codex.cmd" : "codex";
}

export function shouldLaunchWithShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

export function resolveProcessCommand(command: string, args: string[], platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (!shouldLaunchWithShell(command, platform)) return { command, args };
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", [command, ...args].map(quoteWindowsCmdArg).join(" ")]
  };
}

function quoteWindowsCmdArg(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/.test(value)) return value;
  return `"${value.replace(/(["^&|<>])/g, "^$1")}"`;
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

