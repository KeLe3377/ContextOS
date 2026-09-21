import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDaemonServer } from "../apps/daemon/src/bootstrap.js";
import { CodexAdapter } from "../packages/infrastructure/src/adapters/codex-adapter.js";
import { CodexAppServerClient } from "../packages/infrastructure/src/adapters/codex-app-server-client.js";

const dataDir = await mkdtemp(join(tmpdir(), "contextos-e2e-"));
process.env.CONTEXTOS_CODEX_COMMAND = process.execPath;
process.env.CONTEXTOS_CODEX_ARGS = JSON.stringify(["-e", "process.exit(2)"]);

/**
 * 受控自动化 fixture。
 *
 * 只有在显式设置了 CONTEXTOS_E2E_AUTOMATION_FIXTURE=1 时才会安装；未设置时生产行为完全不变。
 * 它只替换一个外部边界：
 *
 * 1. Codex 外部进程 → 协议级 stub（stdin/stdout 逐行 JSON-RPC，实现 initialize / initialized /
 *    thread/list），返回真实形状的 thread（id、cwd、path、updatedAt 为 Unix 秒）。
 *
 * 其余全部走真实实现：CodexAdapter、发现作业、会话创建与绑定、transcript tail/offset、
 * Evidence Store 与数据库记录、Resume Capsule 连续性摘录、Context Package。
 * 不直接向 SQLite 插入任何 Session / Evidence / Artifact / Candidate / Review Item。
 */
const automationFixtureEnabled = process.env.CONTEXTOS_E2E_AUTOMATION_FIXTURE === "1";
/** 测试可覆盖端口，便于同一台机器串行启动多个 e2e server；默认保持 4722 不变。 */
const e2ePort = Number(process.env.CONTEXTOS_E2E_PORT ?? 4722);

const fixtureProjectRoot = join(dataDir, "fixture-project");
const fixtureSessionsDir = join(dataDir, "codex-sessions");
const fixtureThreadId = "e2e-thread-automation";
const fixtureRolloutPath = (() => {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return join(
    fixtureSessionsDir,
    String(now.getUTCFullYear()),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    `rollout-e2e-${fixtureThreadId}.jsonl`
  );
})();

/**
 * 写入最小、真实格式的 rollout，并准备 Project root。一切都在临时 dataDir 内。
 *
 * `prepare` 只在文件不存在时写入 session_meta；`append` 一律追加，绝不覆盖已有内容。
 */
async function ensureRolloutFile(): Promise<void> {
  await mkdir(fixtureProjectRoot, { recursive: true });
  await mkdir(dirname(fixtureRolloutPath), { recursive: true });
  if (!existsSync(fixtureRolloutPath)) {
    await writeFile(
      fixtureRolloutPath,
      `${JSON.stringify({
        timestamp: new Date(0).toISOString(),
        type: "session_meta",
        payload: { id: fixtureThreadId, cwd: fixtureProjectRoot, source: "cli" }
      })}\n`,
      "utf8"
    );
  }
}

async function prepareRollout(): Promise<void> {
  await ensureRolloutFile();
}

/**
 * 追加一个确定性批次。
 *
 * 只写文件，不调用任何 repository / handler / service，也不写 SQLite —— 后续的
 * Evidence、压缩、提取与候选全部由正式调度链路在读到新内容后自行产生。
 * 每批内容不同，避免内容 hash 相同被去重。
 */
let fixtureBatch = 0;
async function appendRolloutBatch(): Promise<{ batch: number; events: number; sizeBytes: number }> {
  await ensureRolloutFile();
  fixtureBatch += 1;
  const base = Date.UTC(2026, 0, 1) + fixtureBatch * 60_000;
  const lines = [
    JSON.stringify({
      timestamp: new Date(base).toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `第 ${fixtureBatch} 批：请继续推进当前工作。` }]
      }
    }),
    JSON.stringify({
      timestamp: new Date(base + 1000).toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "input_text", text: `第 ${fixtureBatch} 批：已记录进展，等待同步。` }]
      }
    })
  ];
  await appendFile(fixtureRolloutPath, `${lines.join("\n")}\n`, "utf8");
  return { batch: fixtureBatch, events: lines.length, sizeBytes: statSync(fixtureRolloutPath).size };
}

let fixtureAdapter: CodexAdapter | null = null;
if (automationFixtureEnabled) {
  // 只在显式 fixture 模式下把 Codex 外部进程换成协议 stub；未开启时上面的
  // CONTEXTOS_CODEX_COMMAND / CONTEXTOS_CODEX_ARGS 保持不变，既有 workspace-smoke 行为不受影响。
  const stubScript = join(process.cwd(), "scripts", "e2e", "codex-app-server-stub.mjs");
  process.env.CONTEXTOS_CODEX_COMMAND = process.execPath;
  process.env.CONTEXTOS_CODEX_SESSIONS_DIR = fixtureSessionsDir;
  process.env.CODEX_STUB_THREAD_ID = fixtureThreadId;
  process.env.CODEX_STUB_CWD = fixtureProjectRoot;
  process.env.CODEX_STUB_PATH = fixtureRolloutPath;
  process.env.CODEX_STUB_UPDATED_AT = String(Math.floor(Date.now() / 1000));
  fixtureAdapter = new CodexAdapter(
    process.execPath,
    ["-e", ""],
    process.platform,
    fixtureSessionsDir,
    new CodexAppServerClient({ command: process.execPath, args: [stubScript] })
  );
}

const server = await createDaemonServer({
  ...(fixtureAdapter ? { agentAdapters: [fixtureAdapter] } : {}),
  config: {
    host: "127.0.0.1",
    port: e2ePort,
    dataDir,
    databaseFile: join(dataDir, "contextos.sqlite")
  }
});

if (automationFixtureEnabled) {
  // fixture 路由只注册在这里：不进入正式路由、bootstrap、生产契约或前端 API client。
  server.post("/__e2e/automation-fixture/prepare", async () => {
    await prepareRollout();
    return { projectRoot: fixtureProjectRoot, externalSessionId: fixtureThreadId, ready: true };
  });
  // 只回批号、事件数与文件大小，不暴露 rollout 路径或正文。
  server.post("/__e2e/automation-fixture/append", async () => appendRolloutBatch());
  console.log("automation e2e fixture enabled: deterministic extractor + codex protocol stub installed");
}

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
await server.listen({ host: "127.0.0.1", port: e2ePort });
