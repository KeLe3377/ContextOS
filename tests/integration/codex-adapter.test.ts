import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CodexAdapter, defaultCodexCommand, defaultCodexLaunchArgs, resolveProcessCommand, shouldLaunchWithShell } from "../../packages/infrastructure/src/adapters/codex-adapter.js";
import { ProcessSupervisor } from "../../packages/infrastructure/src/process-supervisor.js";

describe("CodexAdapter command resolution", () => {
  test("uses the Windows command shim by default", () => {
    expect(defaultCodexCommand("win32")).toBe("codex.cmd");
  });

  test("keeps the plain executable name on non-Windows platforms", () => {
    expect(defaultCodexCommand("linux")).toBe("codex");
    expect(defaultCodexCommand("darwin")).toBe("codex");
  });

  test("uses the non-interactive exec entrypoint by default", () => {
    expect(defaultCodexLaunchArgs(undefined)).toEqual(["exec"]);
    expect(defaultCodexLaunchArgs(JSON.stringify(["--help"]))).toEqual(["--help"]);

    const adapter = new CodexAdapter("codex", undefined, "linux", "sessions");
    expect(adapter.buildLaunchInfo({ cwd: "D:/project/ContextOS", prompt: "start" }).args).toEqual(["exec", "-"]);
    expect(adapter.buildResumeInfo({ cwd: "D:/project/ContextOS", externalSessionId: "codex-session", prompt: "continue" }).args)
      .toEqual(["exec", "resume", "codex-session", "-"]);
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

  test("passes multiline launch prompts through stdin instead of argv", async () => {
    const adapter = new CodexAdapter(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], process.platform, "sessions");
    const supervisor = new ProcessSupervisor();
    const prompt = "line one\nSession ID: sess_stdin\nline three";
    const exit = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      adapter.launch({
        cwd: process.cwd(),
        prompt,
        supervisor,
        onExit: (result) => resolve({ code: result.code, stdout: result.stdout })
      });
    });

    expect(adapter.buildLaunchInfo({ cwd: process.cwd(), prompt }).args.at(-1)).toBe("-");
    expect(exit).toEqual({ code: 0, stdout: prompt });
  });

  test("discovers and normalizes the latest Codex transcript inside the Project root", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "contextos-codex-adapter-"));
    try {
      const sessionsDir = join(tempDir, "sessions");
      const projectRoot = join(tempDir, "project");
      const outsideRoot = join(tempDir, "outside");
      await Promise.all([mkdir(join(sessionsDir, "2026", "09", "16"), { recursive: true }), mkdir(projectRoot), mkdir(outsideRoot)]);
      const oldPath = join(sessionsDir, "2026", "09", "16", "rollout-old.jsonl");
      const latestPath = join(sessionsDir, "2026", "09", "16", "rollout-latest.jsonl");
      const outsidePath = join(sessionsDir, "2026", "09", "16", "rollout-outside.jsonl");
      await writeCodexTranscript(oldPath, "codex-old", projectRoot, "old question", "old answer");
      await writeCodexTranscript(latestPath, "codex-latest", projectRoot, "new question", "new answer");
      await writeCodexTranscript(outsidePath, "codex-outside", outsideRoot, "private question", "private answer");
      const baseTime = Date.now() / 1000;
      await utimes(oldPath, baseTime - 30, baseTime - 30);
      await utimes(latestPath, baseTime - 20, baseTime - 20);
      await utimes(outsidePath, baseTime - 10, baseTime - 10);

      const adapter = new CodexAdapter(process.execPath, ["--version"], process.platform, sessionsDir);
      const latest = adapter.importTranscript({ cwd: projectRoot });
      expect(latest).toMatchObject({
        externalSessionId: "codex-latest",
        contentText: "USER:\nnew question\n\nASSISTANT:\nnew answer",
        parserVersion: "codex-jsonl.v1",
        messageCount: 2,
        roleCounts: { user: 1, assistant: 1 },
        turnCount: 1,
        messageOrdinalStart: 1,
        messageOrdinalEnd: 2,
        truncated: false
      });
      expect(latest.contentText).not.toContain("developer instructions");
      expect(latest.contentText).not.toContain("tool output");

      const explicit = adapter.importTranscript({ cwd: projectRoot, externalSessionId: "codex-old" });
      expect(explicit.externalSessionId).toBe("codex-old");
      expect(explicit.contentText).toContain("old question");
      const correlated = adapter.importTranscript({ cwd: projectRoot, correlationText: "old question" });
      expect(correlated.externalSessionId).toBe("codex-old");
      expect(() => adapter.importTranscript({ cwd: projectRoot, correlationText: "missing marker" })).toThrow("No Codex transcript was found");
      expect(() => adapter.importTranscript({ cwd: projectRoot, externalSessionId: "codex-outside" })).toThrow("Codex transcript was not found");
      const supervisor = new ProcessSupervisor();
      expect(() => adapter.resume({ cwd: projectRoot, externalSessionId: "missing", prompt: "continue", supervisor })).toThrow("was not found");
      expect(() => adapter.resume({ cwd: outsideRoot, externalSessionId: "codex-latest", prompt: "continue", supervisor })).toThrow("different Project");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function writeCodexTranscript(path: string, id: string, cwd: string, userText: string, assistantText: string): Promise<void> {
  const rows = [
    { type: "session_meta", payload: { id, cwd } },
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "developer instructions" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: userText }] } },
    { type: "response_item", payload: { type: "function_call", name: "shell", arguments: "tool output" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: assistantText }] } }
  ];
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}
