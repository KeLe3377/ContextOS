import { spawn } from "node:child_process";

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
  onExit?: (exit: ProcessExitInfo) => void;
};

export type LaunchProcessResult = {
  pid: number;
};

export class ProcessSupervisor {
  launch(input: LaunchProcessInput): LaunchProcessResult {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      detached: true,
      stdio: input.captureOutput ? ["ignore", "pipe", "pipe"] : "ignore",
      shell: false,
      windowsHide: false
    });
    const captured = new BoundedOutput(maxCapturedBytes);
    if (input.captureOutput) {
      child.stdout?.on("data", (chunk: Buffer) => captured.pushStdout(chunk));
      child.stderr?.on("data", (chunk: Buffer) => captured.pushStderr(chunk));
    }
    child.once("exit", (code, signal) => {
      input.onExit?.({ code, signal, ...captured.toResult() });
    });
    if (!child.pid) throw new Error("Process did not expose a pid");
    child.unref();
    return { pid: child.pid };
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

