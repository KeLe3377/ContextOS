import { describe, expect, test } from "vitest";
import { defaultCodexCommand, resolveProcessCommand, shouldLaunchWithShell } from "../../packages/infrastructure/src/adapters/codex-adapter.js";

describe("CodexAdapter command resolution", () => {
  test("uses the Windows command shim by default", () => {
    expect(defaultCodexCommand("win32")).toBe("codex.cmd");
  });

  test("keeps the plain executable name on non-Windows platforms", () => {
    expect(defaultCodexCommand("linux")).toBe("codex");
    expect(defaultCodexCommand("darwin")).toBe("codex");
  });

  test("detects Windows cmd and bat shims", () => {
    expect(shouldLaunchWithShell("codex.cmd", "win32")).toBe(true);
    expect(shouldLaunchWithShell("agent.bat", "win32")).toBe(true);
    expect(shouldLaunchWithShell("codex", "win32")).toBe(false);
    expect(shouldLaunchWithShell("codex.cmd", "linux")).toBe(false);
  });

  test("wraps Windows shims with cmd.exe without enabling child_process shell mode", () => {
    expect(resolveProcessCommand("codex.cmd", ["--version"], "win32")).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "codex.cmd --version"]
    });
    expect(resolveProcessCommand("codex", ["--version"], "linux")).toEqual({
      command: "codex",
      args: ["--version"]
    });
  });
});
