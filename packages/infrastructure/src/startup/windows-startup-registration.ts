import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { StartupRegistration } from "../../../application/src/ports/startup-registration.js";
import { ContextOsError } from "../../../shared/src/errors.js";

export type WindowsStartupRegistrationOptions = {
  platform: NodeJS.Platform;
  startupDirectory?: string;
  appDataDirectory?: string;
  startupScript: string;
  host: string;
  port: number;
  dataDirectory: string;
};

export class WindowsStartupRegistration implements StartupRegistration {
  private readonly startupFile: string | null;

  constructor(private readonly options: WindowsStartupRegistrationOptions) {
    const startupDirectory = options.startupDirectory
      ?? (options.appDataDirectory ? join(options.appDataDirectory, "Microsoft", "Windows", "Start Menu", "Programs", "Startup") : null);
    this.startupFile = startupDirectory ? join(startupDirectory, "ContextOS.cmd") : null;
  }

  sync(enabled: boolean): void {
    if (this.options.platform !== "win32") {
      if (enabled) throw new ContextOsError("INVALID_CONFIG", "Launch at startup is only supported on Windows");
      return;
    }
    if (!this.startupFile) {
      if (enabled) throw new ContextOsError("INVALID_CONFIG", "Windows Startup directory is unavailable");
      return;
    }
    if (!enabled) {
      rmSync(this.startupFile, { force: true });
      return;
    }

    mkdirSync(dirname(this.startupFile), { recursive: true });
    writeFileSync(this.startupFile, this.renderCommand(), "utf8");
  }

  isRegistered(): boolean {
    return this.startupFile !== null && existsSync(this.startupFile);
  }

  private renderCommand(): string {
    const script = batchQuoted(resolve(this.options.startupScript));
    const dataDirectory = batchQuoted(resolve(this.options.dataDirectory));
    const host = batchQuoted(this.options.host);
    return [
      "@echo off",
      `start "" /min powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${script}" -Port ${this.options.port} -HostName "${host}" -DataDir "${dataDirectory}" -NoBrowser`,
      ""
    ].join("\r\n");
  }
}

function batchQuoted(value: string): string {
  if (/[\r\n"]/u.test(value)) throw new ContextOsError("INVALID_CONFIG", "Startup path contains unsupported characters");
  return value.replaceAll("%", "%%");
}
