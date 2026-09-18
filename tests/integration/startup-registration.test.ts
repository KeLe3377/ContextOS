import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { WindowsStartupRegistration } from "../../packages/infrastructure/src/startup/windows-startup-registration.js";

const cleanup: string[] = [];

afterEach(async () => {
  for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Windows startup registration", () => {
  test("creates and removes the ContextOS startup command", async () => {
    const root = await mkdtemp(join(tmpdir(), "contextos-startup-"));
    cleanup.push(root);
    const startupDirectory = join(root, "Startup");
    const registration = new WindowsStartupRegistration({
      platform: "win32",
      startupDirectory,
      startupScript: join(root, "scripts", "start-contextos.ps1"),
      host: "127.0.0.1",
      port: 4721,
      dataDirectory: join(root, ".contextos")
    });

    registration.sync(true);
    const command = await readFile(join(startupDirectory, "ContextOS.cmd"), "utf8");
    expect(command).toContain("-WindowStyle Hidden");
    expect(command).toContain("start-contextos.ps1");
    expect(command).toContain("-Port 4721");
    expect(command).toContain("-NoBrowser");
    expect(registration.isRegistered()).toBe(true);

    registration.sync(false);
    expect(registration.isRegistered()).toBe(false);
  });

  test("rejects enabling startup outside Windows", () => {
    const registration = new WindowsStartupRegistration({
      platform: "linux",
      startupDirectory: "/tmp/startup",
      startupScript: "/app/start-contextos.ps1",
      host: "127.0.0.1",
      port: 4721,
      dataDirectory: "/app/.contextos"
    });
    expect(() => registration.sync(true)).toThrow("only supported on Windows");
  });
});
