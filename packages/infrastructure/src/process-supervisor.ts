import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const maxCapturedBytes = 64 * 1024;

export type ProcessExitInfo = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
};

export type LaunchProcessInput = {
  command: string;
  args: string[];
  cwd: string;
  captureOutput?: boolean;
  stdinText?: string;
  onExit?: (exit: ProcessExitInfo) => void;
};

export type LaunchProcessResult = {
  pid: number;
};

export type SupervisedProcessStatus = {
  pid: number;
  managed: boolean;
  running: boolean;
};

export class ProcessSupervisor {
  private readonly processes = new Map<number, ChildProcess>();

  launch(input: LaunchProcessInput): LaunchProcessResult {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      // Windows: a detached child under `cmd.exe /c` never receives the piped
      // stdin EOF, so the launched agent hangs forever (rollout frozen). Keep
      // the child in the daemon's process group on Windows; only detach on
      // POSIX where it is required for process-group signalling.
      detached: process.platform !== "win32",
      stdio: input.captureOutput || input.stdinText !== undefined ? ["pipe", "pipe", "pipe"] : "ignore",
      shell: false,
      windowsHide: true
    });
    const captured = new BoundedOutput(maxCapturedBytes);
    if (input.captureOutput) {
      child.stdout?.on("data", (chunk: Buffer) => captured.pushStdout(chunk));
      child.stderr?.on("data", (chunk: Buffer) => captured.pushStderr(chunk));
    }
    if (input.stdinText !== undefined) {
      child.stdin?.end(input.stdinText);
    } else {
      child.stdin?.end();
    }
    child.once("exit", (code, signal) => {
      try {
        input.onExit?.({ code, signal, ...captured.toResult() });
      } finally {
        if (child.pid) this.processes.delete(child.pid);
      }
    });
    if (!child.pid) throw new Error("Process did not expose a pid");
    this.processes.set(child.pid, child);
    child.unref();
    return { pid: child.pid };
  }

  inspect(pid: number): SupervisedProcessStatus {
    const child = this.processes.get(pid);
    return { pid, managed: Boolean(child), running: Boolean(child && child.exitCode === null && child.signalCode === null) };
  }

  interrupt(pid: number, platform: NodeJS.Platform = process.platform): boolean {
    const child = this.processes.get(pid);
    if (!child || child.exitCode !== null || child.signalCode !== null) return false;
    if (platform === "win32") {
      const result = spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, shell: false });
      return result.status === 0;
    }
    try {
      process.kill(-pid, "SIGTERM");
      return true;
    } catch {
      return child.kill("SIGTERM");
    }
  }

  runningPids(): number[] {
    return [...this.processes.entries()]
      .filter(([, child]) => child.exitCode === null && child.signalCode === null)
      .map(([pid]) => pid);
  }

  interruptAll(): number[] {
    const interrupted: number[] = [];
    for (const pid of this.runningPids()) {
      if (this.interrupt(pid)) interrupted.push(pid);
    }
    return interrupted;
  }
}

class BoundedOutput {
  private stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  pushStdout(chunk: Buffer): void {
    this.stdout = this.append(this.stdout, chunk);
  }

  pushStderr(chunk: Buffer): void {
    this.stderr = this.append(this.stderr, chunk);
  }

  toResult(): { stdout: string; stderr: string; outputTruncated: boolean } {
    return {
      stdout: this.stdout.toString("utf8"),
      stderr: this.stderr.toString("utf8"),
      outputTruncated: this.truncated
    };
  }

  private append(current: Buffer<ArrayBufferLike>, chunk: Buffer): Buffer<ArrayBufferLike> {
    const remaining = this.maxBytes - current.byteLength;
    if (remaining <= 0) {
      this.truncated = true;
      return current;
    }
    if (chunk.byteLength > remaining) {
      this.truncated = true;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    }
    return Buffer.concat([current, chunk]);
  }
}

