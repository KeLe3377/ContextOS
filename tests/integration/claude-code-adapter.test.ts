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
        contentText: "SUMMARY:\nSummary for claude-latest\n\nUSER:\nnew question\n\nASSISTANT:\nnew answer\n\nTOOL CALL shell (tool_shell):\n{\"command\":\"npm test\"}\n\nTOOL RESULT (tool_shell):\ntool output",
        parserVersion: "claude-code-jsonl.v4",
        eventCount: 5,
        eventCounts: { message: 2, toolCall: 1, toolResult: 1, summary: 1 },
        messageCount: 2,
        roleCounts: { user: 1, assistant: 1 },
        turnCount: 1,
        messageOrdinalStart: 1,
        messageOrdinalEnd: 2,
        truncated: false
      });
      expect(latest.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "summary", text: "Summary for claude-latest" }),
        expect.objectContaining({ kind: "tool_call", name: "shell", callId: "tool_shell", timestamp: "2026-09-18T06:00:02.000Z" }),
        expect.objectContaining({ kind: "tool_result", callId: "tool_shell", text: "tool output" })
      ]));

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

  test("bounds oversized Claude tool output while preserving both ends", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "contextos-claude-tool-output-"));
    try {
      const projectsDir = join(tempDir, "projects");
      const projectRoot = join(tempDir, "project");
      await Promise.all([mkdir(projectsDir, { recursive: true }), mkdir(projectRoot)]);
      const output = `${"A".repeat(12_500)}${"Z".repeat(12_500)}`;
      const rows = [
        { sessionId: "claude-tool-output", cwd: projectRoot, type: "user", message: { role: "user", content: "inspect output" } },
        { sessionId: "claude-tool-output", cwd: projectRoot, type: "assistant", message: { role: "assistant", content: [{ type: "tool_result", tool_use_id: "tool_large", content: output }, { type: "text", text: "inspection complete" }] } }
      ];
      await writeFile(join(projectsDir, "tool-output.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

      const transcript = new ClaudeCodeAdapter(process.execPath, ["--version"], process.platform, projectsDir).importTranscript({ cwd: projectRoot });
      const toolResult = transcript.events?.find((event) => event.kind === "tool_result");
      expect(toolResult).toMatchObject({ callId: "tool_large", truncated: true });
      expect(toolResult?.text).toMatch(/\.\.\.\[truncated \d+ characters\]\.\.\./);
      expect(toolResult?.text).toHaveLength(20_000);
      expect(toolResult?.text?.startsWith("A".repeat(100))).toBe(true);
      expect(toolResult?.text?.endsWith("Z".repeat(100))).toBe(true);
      expect(transcript.contentText).toContain("ASSISTANT:\ninspection complete");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function writeClaudeTranscript(path: string, id: string, cwd: string, userText: string, assistantText: string): Promise<void> {
  const rows = [
    { sessionId: id, cwd, type: "summary", summary: `Summary for ${id}` },
    { sessionId: id, cwd, type: "user", message: { role: "user", content: userText } },
    { sessionId: id, cwd, type: "assistant", timestamp: "2026-09-18T14:00:02+08:00", message: { role: "assistant", content: [{ type: "text", text: assistantText }, { type: "tool_use", id: "tool_shell", name: "shell", input: { command: "npm test" } }, { type: "tool_result", tool_use_id: "tool_shell", content: "tool output" }] } }
  ];
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}
