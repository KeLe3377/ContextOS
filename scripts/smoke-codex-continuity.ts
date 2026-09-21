import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonServer } from "../apps/daemon/src/bootstrap.js";
import { CodexAdapter } from "../packages/infrastructure/src/adapters/codex-adapter.js";

/**
 * 真实 Codex 会话连续性 smoke。
 *
 * 用真实 Codex CLI（`codex exec` / `codex app-server`）走完整验收链：
 *   一次性 Codex 会话 -> 正式 discovery 绑定到 rollout EOF -> 绑定后继续该会话产生新事件
 *   -> 正式调度捕获成 Evidence -> Resume Capsule 得到连续性 -> 正式 Continue resume 同一会话
 *   -> 真实 Codex rollout 中出现刚捕获的连续性摘录。
 *
 * 隔离：临时 Project 目录 + 临时 dataDir + 一次性 Codex 会话，不接触用户正常数据库。
 * 输出只包含 ID、时间、计数、hash 与布尔结论；不输出 transcript 正文、凭据或私人路径。
 *
 * 用法：npx tsx scripts/smoke-codex-continuity.ts
 * 结论：PASS / FAIL_PRODUCT / BLOCKED_EXTERNAL（登录、网络、额度问题属于 BLOCKED_EXTERNAL）。
 */

const pollIntervalMs = 5_000;
const codexTimeoutMs = 240_000;

type Outcome = "PASS" | "FAIL_PRODUCT" | "BLOCKED_EXTERNAL";

type Checkpoint = { name: string; ok: boolean; detail: string };

const checkpoints: Checkpoint[] = [];
const facts: Record<string, unknown> = {};

function record(name: string, ok: boolean, detail: string): void {
  checkpoints.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name} — ${detail}`);
}

function fail(code: string): never {
  throw new Error(code);
}

class BlockedExternal extends Error {}
class ProductFailure extends Error {}

/** 登录、网络、额度问题必须区分出来，不能记成 PASS，也不能记成产品缺陷。 */
function classifyCodexFailure(output: string): string | null {
  const text = output.toLowerCase();
  if (/(not logged in|login required|please run `?codex login|unauthorized|401)/.test(text)) return "CODEX_AUTH_REQUIRED";
  if (/(quota|rate limit|429|insufficient|usage limit)/.test(text)) return "CODEX_QUOTA_EXHAUSTED";
  if (/(enotfound|econnrefused|etimedout|network|tls|proxy|socket hang up)/.test(text)) return "CODEX_NETWORK_ERROR";
  return null;
}

function runCodex(args: string[], cwd: string, prompt: string): { status: number; output: string } {
  const result = spawnSync("codex", args, {
    cwd,
    input: prompt,
    encoding: "utf8",
    timeout: codexTimeoutMs,
    shell: process.platform === "win32",
    windowsHide: true
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const blocked = classifyCodexFailure(output);
  if (blocked) throw new BlockedExternal(blocked);
  if (result.error) throw new BlockedExternal(`CODEX_SPAWN_FAILED:${result.error.message.slice(0, 120)}`);
  return { status: result.status ?? -1, output };
}

async function poll<T>(label: string, work: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await work();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new ProductFailure(`TIMEOUT_${label}`);
}

const baseDir = await mkdtemp(join(tmpdir(), "contextos-codex-smoke-"));
const projectDir = join(baseDir, "project");
const dataDir = join(baseDir, "data");
const runToken = `smoke-${Date.now()}`;
let server: Awaited<ReturnType<typeof createDaemonServer>> | null = null;
let outcome: Outcome = "FAIL_PRODUCT";
let blockedReason: string | null = null;

const startedAt = new Date().toISOString();

try {
  // 真实 Project 目录：ContextOS 的 Project 就是一个仓库。
  await mkdir(projectDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: projectDir, stdio: "ignore" });

  // 1. 一次性真实 Codex 会话（非交互），产生一条真实 rollout。
  //    参数与生产一致：`codex exec -`，prompt 走 stdin。
  const first = runCodex(
    ["exec", "-"],
    projectDir,
    `只回复 ok。不要修改任何文件。（${runToken} 首次会话）`
  );
  record("codex-session-created", first.status === 0, `exit=${first.status} outputChars=${first.output.length}`);
  if (first.status !== 0) fail("FIRST_CODEX_RUN_FAILED");

  // 2. 临时 dataDir 上启动守护进程，全部走正式 HTTP 入口。
  server = await createDaemonServer({
    agentAdapter: new CodexAdapter(),
    config: { host: "127.0.0.1", port: 0, dataDir, databaseFile: join(dataDir, "contextos.sqlite") }
  });
  await server.ready();

  const post = async (url: string, payload: unknown) => server!.inject({ method: "POST", url, payload });
  const get = async (url: string) => server!.inject({ method: "GET", url });

  const projectResponse = await post("/api/projects", { name: `Codex smoke ${runToken}`, rootPath: projectDir });
  if (projectResponse.statusCode !== 201) fail("PROJECT_CREATE_FAILED");
  const projectId = (projectResponse.json() as { id: string }).id;
  facts.projectId = projectId;

  const settings = (await get(`/api/projects/${projectId}/automation/settings`)).json() as { revision: number };
  const patched = await server.inject({
    method: "PATCH",
    url: `/api/projects/${projectId}/automation/settings`,
    payload: { mode: "SUGGEST_ONLY", pollIntervalMs, expectedRevision: settings.revision }
  });
  record("automation-enabled", patched.statusCode === 200, `status=${patched.statusCode} pollIntervalMs=${pollIntervalMs}`);

  const discovery = await post(`/api/projects/${projectId}/automation/discovery`, {});
  record("discovery-enqueued", discovery.statusCode === 202, `status=${discovery.statusCode}`);

  // 3. 正式发现把真实线程绑定成 ContextOS Session。
  const session = await poll("SESSION_BIND", async () => {
    const items = ((await get("/api/sessions")).json() as { items?: Array<Record<string, unknown>> }).items ?? [];
    return items.find((item) => item.projectId === projectId && typeof item.externalSessionId === "string") ?? null;
  }, 90_000);
  const sessionId = String(session.id);
  const externalSessionId = String(session.externalSessionId);
  facts.sessionId = sessionId;
  facts.externalSessionIdHash = hashId(externalSessionId);
  record("session-bound", true, `session=${sessionId}`);

  const boundState = await poll("SYNC_BIND", async () => {
    const state = (await get(`/api/sessions/${sessionId}/desktop-sync`)).json() as { status: string; byteOffset: number; eventsIngested: number };
    return state.status === "WATCHING" ? state : null;
  }, 60_000);
  facts.bindByteOffset = boundState.byteOffset;
  facts.eventsIngestedAtBind = boundState.eventsIngested;
  record("bound-at-rollout-eof", boundState.byteOffset > 0 && boundState.eventsIngested === 0,
    `byteOffset=${boundState.byteOffset} eventsIngested=${boundState.eventsIngested}`);

  const evidenceBefore = ((await get(`/api/sessions/${sessionId}/evidence`)).json() as { items?: unknown[] }).items ?? [];
  const capsuleBefore = (await get(`/api/sessions/${sessionId}/resume-capsule`)).json() as { contextText: string | null };
  record("no-pre-bind-history", evidenceBefore.length === 0 && capsuleBefore.contextText === null,
    `evidence=${evidenceBefore.length} capsuleContext=${capsuleBefore.contextText === null ? "null" : "set"}`);

  // 4. 绑定之后继续同一个真实 Codex 会话：新事件写进同一个 rollout。
  //    参数与 CodexAdapter.buildResumeInfo 完全一致：`codex exec resume <id> -`。
  const marker = `连续性标记 ${runToken}`;
  const second = runCodex(
    ["exec", "resume", externalSessionId, "-"],
    projectDir,
    `只回复 ok。不要修改任何文件。请记录这条标记：${marker}`
  );
  record("codex-session-continued", second.status === 0, `exit=${second.status} outputChars=${second.output.length}`);
  if (second.status !== 0) fail("SECOND_CODEX_RUN_FAILED");

  // 5. 正式调度在下一个合法轮询周期捕获新批次。
  const capturedEvidence = await poll("EVIDENCE_CAPTURE", async () => {
    const items = ((await get(`/api/sessions/${sessionId}/evidence`)).json() as { items?: Array<{ id: string }> }).items ?? [];
    return items.length > evidenceBefore.length ? items[0]! : null;
  }, 90_000);
  facts.evidenceCount = (((await get(`/api/sessions/${sessionId}/evidence`)).json() as { items?: unknown[] }).items ?? []).length;
  record("evidence-captured", true, `evidenceId=${capturedEvidence.id} total=${facts.evidenceCount}`);

  const capsule = await poll("CAPSULE_CONTINUITY", async () => {
    const value = (await get(`/api/sessions/${sessionId}/resume-capsule`)).json() as { contextText: string | null; evidenceSnapshotIds: string[] };
    return value.contextText && value.evidenceSnapshotIds.includes(capturedEvidence.id) ? value : null;
  }, 30_000);
  const capsuleHasMarker = (capsule.contextText ?? "").includes(marker);
  facts.capsuleChars = (capsule.contextText ?? "").length;
  facts.capsuleContextHash = hashText(capsule.contextText ?? "");
  record("capsule-references-evidence", capsule.evidenceSnapshotIds.includes(capturedEvidence.id), `evidenceIds=${capsule.evidenceSnapshotIds.length}`);
  record("capsule-has-captured-marker", capsuleHasMarker, `contextChars=${facts.capsuleChars}`);

  // 6. 正式 Continue：必须 resume 回同一个真实 Codex 会话。
  const refreshed = (await get(`/api/sessions/${sessionId}`)).json() as { revision: number };
  const continued = await post(`/api/sessions/${sessionId}/continue`, { expectedRevision: refreshed.revision });
  const continuedBody = continued.json() as { launch?: { operation?: string; externalSessionId?: string | null }; run?: { id?: string } };
  facts.continueStatus = continued.statusCode;
  record("continue-resumes-same-session",
    continuedBody.launch?.operation === "resume" && continuedBody.launch?.externalSessionId === externalSessionId,
    `operation=${continuedBody.launch?.operation ?? "none"} sameExternalSession=${continuedBody.launch?.externalSessionId === externalSessionId}`);

  // 7. 真实 Codex 侧证据：resume prompt（含连续性摘录）必须真的进入同一个 rollout。
  //    先确认投递，再看进程是否正常收尾——投递才是产品结论，进程快慢不是。
  const rolloutPath = new CodexAdapter().resolveTranscriptPath({ externalSessionId });
  if (!rolloutPath) fail("ROLLOUT_NOT_FOUND");
  const probes: Array<Record<string, unknown>> = [];
  const lookForPrompt = async (): Promise<string | null> => {
    const rollout = await readFile(rolloutPath, "utf8");
    const runtime = (await get(`/api/sessions/${sessionId}/runtime-status`)).json() as Record<string, unknown>;
    probes.push({
      atMs: Date.now(),
      rolloutBytes: rollout.length,
      sessionStatus: runtime.status ?? null,
      process: runtime.process ?? null
    });
    facts.resumeDeliveryProbes = probes.slice(-6);
    return rollout.includes("Recent captured continuity") && rollout.includes(marker) ? rollout : null;
  };

  let delivered = await poll("RESUME_PROMPT_DELIVERY", lookForPrompt, 90_000).catch(() => null);
  const deliveredByProduct = delivered !== null;

  if (!delivered) {
    // 诊断用：用完全相同的命令行同步跑一次，判断是“命令本身不可用”还是“守护进程的启动方式有问题”。
    // 这一步的成功绝不能算作产品 PASS。
    // 探针 prompt 与产品 resume prompt 形状一致，便于用同一条 rollout 断言判断“命令本身是否可用”。
    const probePrompt = [
      "Continue this ContextOS session using the existing Codex conversation.",
      "",
      "## Recent captured continuity",
      marker,
      "（诊断探针，不是产品路径）"
    ].join("\n");
    const probe = spawnSync("cmd.exe", ["/d", "/s", "/c", `codex.cmd exec resume ${externalSessionId} -`], {
      cwd: projectDir,
      input: probePrompt,
      encoding: "utf8",
      timeout: 180_000,
      shell: false,
      windowsHide: true
    });
    const probeOutput = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
    facts.resumeProbe = {
      exit: probe.status,
      signal: probe.signal,
      error: probe.error ? probe.error.message.slice(0, 120) : null,
      outputChars: probeOutput.length,
      blockedHint: classifyCodexFailure(probeOutput)
    };
    facts.resumeProbeDelivered = (await readFile(rolloutPath, "utf8")).includes("诊断探针");

    // 诊断二：完全照搬 ProcessSupervisor 的 spawn 选项（detached + windowsHide:false），
    // 用来判断“产品启动方式”与“命令本身”哪个是瓶颈。
    const detachedStartedAt = Date.now();
    const detached = spawnSync("cmd.exe", ["/d", "/s", "/c", `codex.cmd exec resume ${externalSessionId} -`], {
      cwd: projectDir,
      input: `${probePrompt}\n（detached 诊断）`,
      encoding: "utf8",
      timeout: 60_000,
      detached: true,
      shell: false,
      windowsHide: false
    });
    facts.resumeProbeDetached = {
      exit: detached.status,
      signal: detached.signal,
      elapsedMs: Date.now() - detachedStartedAt,
      outputChars: `${detached.stdout ?? ""}${detached.stderr ?? ""}`.length
    };
    facts.resumeProbeDetachedDelivered = (await readFile(rolloutPath, "utf8")).includes("detached 诊断");
    delivered = await poll("RESUME_PROMPT_DELIVERY_AFTER_PROBE", lookForPrompt, 30_000).catch(() => null);
    facts.resumeDeliveryAttributedTo = delivered ? "diagnostic-probe" : "none";
  } else {
    facts.resumeDeliveryAttributedTo = "product-continue";
  }

  facts.rolloutBytes = (delivered ?? "").length;
  record("resume-prompt-reached-real-codex", deliveredByProduct,
    `deliveredByProduct=${deliveredByProduct} attributedTo=${String(facts.resumeDeliveryAttributedTo)}`);

  const terminal = await poll("CONTINUE_RUN_TERMINAL", async () => {
    const value = (await get(`/api/sessions/${sessionId}`)).json() as { status: string };
    return ["COMPLETED", "FAILED"].includes(value.status) ? value : null;
  }, 300_000).catch(async () => {
    const value = (await get(`/api/sessions/${sessionId}`)).json() as { status: string };
    const runtime = (await get(`/api/sessions/${sessionId}/runtime-status`)).json() as Record<string, unknown>;
    facts.continueStatusWhenTimedOut = value.status;
    facts.continueProcessWhenTimedOut = runtime.process ?? null;
    return null;
  });
  const finalStatus = terminal ? terminal.status : String(facts.continueStatusWhenTimedOut);
  facts.continueFinalStatus = finalStatus;
  record("continue-run-terminal", finalStatus === "COMPLETED", `status=${finalStatus}`);

  outcome = checkpoints.every((entry) => entry.ok) ? "PASS" : "FAIL_PRODUCT";
} catch (error) {
  if (error instanceof BlockedExternal) {
    outcome = "BLOCKED_EXTERNAL";
    blockedReason = error.message;
  } else {
    outcome = "FAIL_PRODUCT";
    blockedReason = error instanceof Error ? error.message : String(error);
  }
  record("smoke-aborted", false, `reason=${blockedReason}`);
} finally {
  try {
    await server?.close();
  } catch {
    // The daemon may already be closed; cleanup must still proceed.
  }
  await rm(baseDir, { recursive: true, force: true });
}

const report = {
  outcome,
  blockedReason,
  startedAt,
  finishedAt: new Date().toISOString(),
  checkpoints,
  facts
};

console.log("");
console.log("SMOKE_RESULT");
console.log(JSON.stringify(report, null, 2));

function hashId(value: string): string {
  return hashText(value).slice(0, 16);
}

function hashText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
