import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter } from "../../packages/infrastructure/src/adapters/claude-code-adapter.js";
import { runAgentAdapterContract } from "../contracts/agent-adapter-contract.js";

runAgentAdapterContract("ClaudeCodeAdapter", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "contextos-claude-adapter-contract-"));
  const projectsDir = join(tempDir, "projects");
  const projectRoot = join(tempDir, "project");
  await Promise.all([mkdir(projectsDir, { recursive: true }), mkdir(projectRoot, { recursive: true })]);
  const externalSessionId = "contract-claude-session";
  const rows = [
    { sessionId: externalSessionId, cwd: projectRoot, type: "summary", summary: "ignored" },
    { sessionId: externalSessionId, cwd: projectRoot, type: "user", message: { role: "user", content: "contract question" } },
    { sessionId: externalSessionId, cwd: projectRoot, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "contract answer" }] } }
  ];
  await writeFile(join(projectsDir, "contract.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  const unavailableCommand = join(tempDir, "missing-claude-command.exe");
  return {
    adapter: new ClaudeCodeAdapter(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--"], process.platform, projectsDir),
    completedAdapter: new ClaudeCodeAdapter(process.execPath, ["-e", "console.log('contract-stdout'); console.error('contract-stderr')", "--"], process.platform, projectsDir),
    unavailableAdapter: new ClaudeCodeAdapter(unavailableCommand, [], process.platform, projectsDir),
    capabilities: ["discover", "launch", "resume", "inspectStatus", "interrupt", "importTranscript"],
    expectedResumeArgs: ["--resume", externalSessionId, "continue"],
    cwd: projectRoot,
    externalSessionId,
    cleanup: () => rm(tempDir, { recursive: true, force: true })
  };
});
