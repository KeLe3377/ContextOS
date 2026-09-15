import { spawnSync } from "node:child_process";
import type { AgentAdapterStatusDto, AgentLaunchInfoDto } from "../../../contracts/src/runtime.js";

export class CodexAdapter {
  readonly id = "codex";
  readonly displayName = "Codex";
  private readonly command: string;

  constructor(command = process.env.CONTEXTOS_CODEX_COMMAND ?? "codex") {
    this.command = command;
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
      args: [],
      cwd: input.cwd,
      mode: "queued-job"
    };
  }
}
