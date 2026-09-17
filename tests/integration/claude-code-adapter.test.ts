import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ClaudeCodeAdapter, defaultClaudeCommand } from "../../packages/infrastructure/src/adapters/claude-code-adapter.js";
import { ProcessSupervisor } from "../../packages/infrastructure/src/process-supervisor.js";

describe("ClaudeCodeAdapter", () => {
  test("uses the Windows command shim by default", () => {
    expect(defaultClaudeCommand("win32")).toBe("claude.cmd");
  });

  test("keeps the plain executable name on non-Windows platforms", () => {
    expect(defaultClaudeCommand("linux")).toBe("claude");
    expect(defaultClaudeCommand("darwin")).toBe("claude");
  });

  test("discovers and normalizes Claude Code transcripts inside the Project root", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "contextos-claude-adapter-"));
    try {
      const projectsDir = join(tempDir, "projects");
      const projectRoot = join(tempDir, "project");
      const outsideRoot = join(tempDir, "outside");
      await Promise.all([mkdir(projectsDir, { recursive: true }), mkdir(projectRoot), mkdir(outsideRoot)]);
      const oldPath = join(projectsDir, "old.jsonl");
      const latestPath = join(projectsDir, "latest.jsonl");
      const outsidePath = join(projectsDir, "outside.jsonl");
      await writeClaudeTranscript(oldPath, "claude-old", projectRoot, "old question", "old answer");
      await writeClaudeTranscript(latestPath, "claude-latest", projectRoot, "new question", "new answer");
      await writeClaudeTranscript(outsidePath, "claude-outside", outsideRoot, "private question", "private answer");
      const baseTime = Date.now() / 1000;
      await utimes(oldPath, baseTime - 30, baseTime - 30);
      await utimes(latestPath, baseTime - 20, baseTime - 20);
      await utimes(outsidePath, baseTime - 10, baseTime - 10);

      const adapter = new ClaudeCodeAdapter(process.execPath, ["--version"], process.platform, projectsDir);
      const latest = adapter.importTranscript({ cwd: projectRoot });
      expect(latest).toMatchObject({
        externalSessionId: "claude-latest",
        contentText: "USER:\nnew question\n\nASSISTANT:\nnew answer",
        parserVersion: "claude-code-jsonl.v1",
        messageCount: 2,
        roleCounts: { user: 1, assistant: 1 },
        turnCount: 1,
        messageOrdinalStart: 1,
        messageOrdinalEnd: 2,
        truncated: false
      });

      const explicit = adapter.importTranscript({ cwd: projectRoot, externalSessionId: "claude-old" });
      expect(explicit.externalSessionId).toBe("claude-old");
      expect(explicit.contentText).toContain("old question");
      const correlated = adapter.importTranscript({ cwd: projectRoot, correlationText: "old question" });
      expect(correlated.externalSessionId).toBe("claude-old");
      expect(() => adapter.importTranscript({ cwd: projectRoot, correlationText: "missing marker" })).toThrow("No Claude Code transcript was found");
      expect(() => adapter.importTranscript({ cwd: projectRoot, externalSessionId: "claude-outside" })).toThrow("Claude Code transcript was not found");
      const supervisor = new ProcessSupervisor();
      expect(() => adapter.resume({ cwd: projectRoot, externalSessionId: "missing", prompt: "continue", supervisor })).toThrow("was not found");
      expect(() => adapter.resume({ cwd: outsideRoot, externalSessionId: "claude-latest", prompt: "continue", supervisor })).toThrow("different Project");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function writeClaudeTranscript(path: string, id: string, cwd: string, userText: string, assistantText: string): Promise<void> {
  const rows = [
    { sessionId: id, cwd, type: "summary", summary: "ignored" },
    { sessionId: id, cwd, type: "user", message: { role: "user", content: userText } },
    { sessionId: id, cwd, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", text: "tool output" }, { type: "text", text: assistantText }] } }
  ];
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}
