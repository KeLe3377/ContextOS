import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../../packages/infrastructure/src/adapters/codex-adapter.js";
import { runAgentAdapterContract } from "../contracts/agent-adapter-contract.js";

runAgentAdapterContract("CodexAdapter", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "contextos-adapter-contract-"));
  const sessionsDir = join(tempDir, "sessions");
  const projectRoot = join(tempDir, "project");
  await Promise.all([mkdir(sessionsDir, { recursive: true }), mkdir(projectRoot, { recursive: true })]);
  const externalSessionId = "contract-codex-session";
  const rows = [
    { type: "session_meta", payload: { id: externalSessionId, cwd: projectRoot } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "contract question" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "contract answer" }] } }
  ];
  await writeFile(join(sessionsDir, "rollout-contract.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  const unavailableCommand = join(tempDir, "missing-codex-command.exe");
  return {
    adapter: new CodexAdapter(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.platform, sessionsDir),
    completedAdapter: new CodexAdapter(process.execPath, ["-e", "console.log('contract-stdout'); console.error('contract-stderr')"], process.platform, sessionsDir),
    unavailableAdapter: new CodexAdapter(unavailableCommand, [], process.platform, sessionsDir),
    capabilities: ["discover", "launch", "inspectStatus", "interrupt", "importTranscript"],
    cwd: projectRoot,
    externalSessionId,
    cleanup: () => rm(tempDir, { recursive: true, force: true })
  };
});
