import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDaemonServer } from "../apps/daemon/src/bootstrap.js";
import { CodexAdapter } from "../packages/infrastructure/src/adapters/codex-adapter.js";
import { CodexAppServerClient } from "../packages/infrastructure/src/adapters/codex-app-server-client.js";
import type { AgentAdapter, AgentLaunchInput, AgentResumeInput } from "../packages/application/src/ports/agent-adapter.js";

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
 * Evidence Store 与数据库记录、Resume Capsule 连续性摘录、Context Package、Continue。
 * 不直接向 SQLite 插入任何 Session / Evidence / Artifact / Candidate / Review Item。
 *
 * fixture 状态按 scope（Playwright project 名）隔离：每个 scope 有自己的 Project root、
 * rollout 文件、external session id 与批次计数，因此 desktop 与 mobile 不共享任何可变状态。
 */
const automationFixtureEnabled = process.env.CONTEXTOS_E2E_AUTOMATION_FIXTURE === "1";
/** 测试可覆盖端口，便于同一台机器串行启动多个 e2e server；默认保持 4722 不变。 */
const e2ePort = Number(process.env.CONTEXTOS_E2E_PORT ?? 4722);

const fixtureSessionsDir = join(dataDir, "codex-sessions");

type FixtureScope = {
  scope: string;
  projectRoot: string;
  threadId: string;
  rolloutPath: string;
  batch: number;
};

const fixtureScopes = new Map<string, FixtureScope>();

/** scope 名只用于文件名与线程 id，先归一化，避免路径穿越。 */
function scopeKey(scope: string | undefined): string {
  const normalized = String(scope ?? "default").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
  return normalized || "default";
}

function scopeOf(rawScope: string | undefined): FixtureScope {
  const scope = scopeKey(rawScope);
  const existing = fixtureScopes.get(scope);
  if (existing) return existing;

  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const created: FixtureScope = {
    scope,
    projectRoot: join(dataDir, `fixture-project-${scope}`),
    threadId: `e2e-thread-${scope}`,
    rolloutPath: join(
      fixtureSessionsDir,
      String(now.getUTCFullYear()),
      pad(now.getUTCMonth() + 1),
      pad(now.getUTCDate()),
      `rollout-e2e-${scope}.jsonl`
    ),
    batch: 0
  };
  fixtureScopes.set(scope, created);
  publishStubThreads();
  return created;
}

/**
 * 把当前所有 scope 的线程告诉协议 stub。
 *
 * stub 在每次 `thread/list` 时被重新拉起，因此这里更新环境变量就足够；按 cwd 精确过滤，
 * 保证一个 scope 的 Project 只能发现自己的线程。
 */
function publishStubThreads(): void {
  process.env.CODEX_STUB_THREADS = JSON.stringify(
    [...fixtureScopes.values()].map((entry) => ({ id: entry.threadId, cwd: entry.projectRoot, path: entry.rolloutPath }))
  );
}

/**
 * 写入最小、真实格式的 rollout，并准备 Project root。一切都在临时 dataDir 内。
 *
 * `prepare` 只在文件不存在时写入 session_meta；`append` 一律追加，绝不覆盖已有内容。
 */
async function ensureRolloutFile(fixture: FixtureScope): Promise<void> {
  await mkdir(fixture.projectRoot, { recursive: true });
  await mkdir(dirname(fixture.rolloutPath), { recursive: true });
  if (!existsSync(fixture.rolloutPath)) {
    await writeFile(
      fixture.rolloutPath,
      `${JSON.stringify({
        timestamp: new Date(0).toISOString(),
        type: "session_meta",
        payload: { id: fixture.threadId, cwd: fixture.projectRoot, source: "cli" }
      })}\n`,
      "utf8"
    );
  }
}

/**
 * 追加一个确定性批次。
 *
 * 只写文件，不调用任何 repository / handler / service，也不写 SQLite —— 后续的
 * Evidence 与 Resume Capsule 连续性全部由正式调度链路在读到新内容后自行产生。
 * 每批内容不同，避免内容 hash 相同被去重。
 */
async function appendRolloutBatch(fixture: FixtureScope): Promise<{ batch: number; events: number; sizeBytes: number; marker: string }> {
  await ensureRolloutFile(fixture);
  fixture.batch += 1;
  const base = Date.UTC(2026, 0, 1) + fixture.batch * 60_000;
  const marker = `${fixture.scope} 第 ${fixture.batch} 批`;
  const lines = [
    JSON.stringify({
      timestamp: new Date(base).toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `${marker}：请继续推进当前工作。` }]
      }
    }),
    JSON.stringify({
      timestamp: new Date(base + 1000).toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "input_text", text: `${marker}：已记录进展，等待同步。` }]
      }
    })
  ];
  await appendFile(fixture.rolloutPath, `${lines.join("\n")}\n`, "utf8");
  return { batch: fixture.batch, events: lines.length, sizeBytes: statSync(fixture.rolloutPath).size, marker };
}

/** 受控适配器记录的一次调用；E2E 用它验证 Continue 真的走了 resume 并带上了连续性。 */
type AdapterCall = { operation: "launch" | "resume"; externalSessionId: string | null; prompt: string };
const adapterCalls: AdapterCall[] = [];

/**
 * 受控适配器：完整委托给真实 CodexAdapter，只额外记录 launch/resume 的入参。
 *
 * 这样 Continue 仍然走真实的生命周期（进程启动、状态转移、transcript bridge），
 * 而 E2E 可以断言 adapter operation、external session id 与 resume prompt 内容。
 */
function recordingAdapter(inner: CodexAdapter, calls: AdapterCall[]): AgentAdapter {
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "resume") {
        return (input: AgentResumeInput) => {
          calls.push({ operation: "resume", externalSessionId: input.externalSessionId, prompt: input.prompt });
          return target.resume(input);
        };
      }
      if (property === "launch") {
        return (input: AgentLaunchInput) => {
          calls.push({ operation: "launch", externalSessionId: null, prompt: input.prompt ?? "" });
          return target.launch(input);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  });
}

let fixtureAdapter: AgentAdapter | null = null;
if (automationFixtureEnabled) {
  // 只在显式 fixture 模式下把 Codex 外部进程换成协议 stub；未开启时上面的
  // CONTEXTOS_CODEX_COMMAND / CONTEXTOS_CODEX_ARGS 保持不变，既有 workspace-smoke 行为不受影响。
  const stubScript = join(process.cwd(), "scripts", "e2e", "codex-app-server-stub.mjs");
  process.env.CONTEXTOS_CODEX_COMMAND = process.execPath;
  process.env.CONTEXTOS_CODEX_SESSIONS_DIR = fixtureSessionsDir;
  publishStubThreads();
  fixtureAdapter = recordingAdapter(
    new CodexAdapter(
      process.execPath,
      ["-e", ""],
      process.platform,
      fixtureSessionsDir,
      new CodexAppServerClient({ command: process.execPath, args: [stubScript] })
    ),
    adapterCalls
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
  server.post("/__e2e/automation-fixture/prepare", async (request) => {
    const body = (request.body ?? {}) as { scope?: string };
    const fixture = scopeOf(body.scope);
    await ensureRolloutFile(fixture);
    return { scope: fixture.scope, projectRoot: fixture.projectRoot, externalSessionId: fixture.threadId, ready: true };
  });
  // 只回批号、事件数、标记与文件大小，不暴露 rollout 路径。
  server.post("/__e2e/automation-fixture/append", async (request) => {
    const body = (request.body ?? {}) as { scope?: string };
    return appendRolloutBatch(scopeOf(body.scope));
  });
  // 受控适配器观察到的调用；只回操作名、external session id 与 prompt。
  server.get("/__e2e/automation-fixture/adapter-calls", async () => ({ calls: adapterCalls }));
  console.log("automation e2e fixture enabled: codex protocol stub + recording adapter installed");
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
