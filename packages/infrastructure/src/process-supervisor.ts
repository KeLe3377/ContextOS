import { spawn } from "node:child_process";

export type LaunchProcessInput = {
  command: string;
  args: string[];
  cwd: string;
};

export type LaunchProcessResult = {
  pid: number;
};

export class ProcessSupervisor {
  launch(input: LaunchProcessInput): LaunchProcessResult {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: false
    });
    if (!child.pid) throw new Error("Process did not expose a pid");
    child.unref();
    return { pid: child.pid };
  }
}
