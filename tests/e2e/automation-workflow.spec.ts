/// <reference lib="dom" />
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * 会话连续性闭环的端到端验收。
 *
 * 走的是唯一一条正式产品路径：
 *
 *   受控 fixture 准备（每个 Playwright project 独立 scope）
 *   -> UI 创建 Project
 *   -> 正式 settings API 打开自动化并把轮询间隔设为 5000ms
 *   -> UI 运行发现（正式 discovery 入口）
 *   -> Sessions API 等到 Session 被绑定
 *   -> 绑定之后才向 rollout 追加新事件
 *   -> 正式调度在下一个合法轮询周期捕获
 *   -> Session Evidence API 等到新批次
 *   -> Resume Capsule API 等到引用该批次
 *   -> 正式 Continue API
 *   -> 受控适配器断言 resume、相同 externalSessionId 与连续性文本
 *
 * 约束：不读 SQLite、不 seed 业务表、不调用内部 handler、不断言 job kind / Artifact / Candidate、
 * 不用延长 timeout 掩盖失败，desktop 与 mobile 不共享任何 fixture 状态。
 */

const API_BASE = "http://127.0.0.1:4722";

/** 自动化状态面板的定位锚点：只有概览页的自动化面板包含这句文案。 */
const automationPanelAnchor = "监听中的会话";

type SessionSummary = { id: string; projectId: string; externalSessionId: string | null; revision: number };
type SessionSyncState = { status: string; byteOffset: number; eventsIngested: number };
type EvidenceItem = { id: string };
type ResumeCapsule = { contextText: string | null; nextAction: string | null; evidenceSnapshotIds: string[] };
type AdapterCall = { operation: "launch" | "resume"; externalSessionId: string | null; prompt: string };

async function findProjectId(request: APIRequestContext, name: string): Promise<string> {
  const body = (await (await request.get(`${API_BASE}/api/projects`)).json()) as
    | Array<{ id: string; name: string }>
    | { items?: Array<{ id: string; name: string }> };
  const projects = Array.isArray(body) ? body : body.items ?? [];
  const match = projects.find((item) => item.name === name);
  expect(match, `Project ${name} was not created through the UI`).toBeTruthy();
  return match!.id;
}

async function listSessions(request: APIRequestContext): Promise<SessionSummary[]> {
  const body = (await (await request.get(`${API_BASE}/api/sessions`)).json()) as { items?: SessionSummary[] } | SessionSummary[];
  return Array.isArray(body) ? body : body.items ?? [];
}

async function readSyncState(request: APIRequestContext, sessionId: string): Promise<SessionSyncState> {
  return (await (await request.get(`${API_BASE}/api/sessions/${sessionId}/desktop-sync`)).json()) as SessionSyncState;
}

async function listSessionEvidence(request: APIRequestContext, sessionId: string): Promise<EvidenceItem[]> {
  const body = (await (await request.get(`${API_BASE}/api/sessions/${sessionId}/evidence`)).json()) as { items?: EvidenceItem[] };
  return body.items ?? [];
}

async function readResumeCapsule(request: APIRequestContext, sessionId: string): Promise<ResumeCapsule> {
  return (await (await request.get(`${API_BASE}/api/sessions/${sessionId}/resume-capsule`)).json()) as ResumeCapsule;
}

async function readAdapterCalls(request: APIRequestContext): Promise<AdapterCall[]> {
  const body = (await (await request.get(`${API_BASE}/__e2e/automation-fixture/adapter-calls`)).json()) as { calls?: AdapterCall[] };
  return body.calls ?? [];
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test("自动发现并从 EOF 绑定 Codex 会话，Continue 带回捕获的连续性", async ({ page, request }, testInfo) => {
  // 每次执行都拿到独立 scope：独立的 Project root、rollout、external session id 与批次计数。
  // 这样 desktop / mobile 之间、以及同一 project 的重复执行之间都不共享任何可变 fixture 状态。
  const scope = `${testInfo.project.name}-r${testInfo.repeatEachIndex}-${testInfo.retry}-${Date.now()}`;
  await page.addInitScript((base) => localStorage.setItem("contextos.apiBase", base), API_BASE);

  // 1. 受控 fixture：只准备 Project root 与最小 rollout，不触碰任何业务表。
  const prepareResponse = await request.post(`${API_BASE}/__e2e/automation-fixture/prepare`, { data: { scope } });
  expect(prepareResponse.status()).toBe(200);
  const fixture = (await prepareResponse.json()) as { scope: string; projectRoot: string; externalSessionId: string; ready: boolean };
  expect(fixture.ready).toBe(true);
  expect(fixture.scope).not.toBe(testInfo.project.name);

  // 2. 通过界面创建 Project，root 指向 fixture 的受控目录。
  const projectName = `会话连续性 ${scope}-${Date.now()}`;
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await expect(page.getByRole("heading", { name: "项目" })).toBeVisible();
  await page.getByRole("button", { name: "添加项目" }).click();
  await page.getByLabel("项目名称").fill(projectName);
  await page.getByLabel("根路径").fill(fixture.projectRoot);
  await page.getByRole("button", { name: "创建项目" }).click();
  const projectId = await findProjectId(request, projectName);

  // 3. 正式 settings API：启用自动化，并把轮询间隔设成合法最小值 5000ms。
  const settingsResponse = await request.get(`${API_BASE}/api/projects/${projectId}/automation/settings`);
  expect(settingsResponse.status()).toBe(200);
  const settings = (await settingsResponse.json()) as { revision: number };
  const patched = await request.patch(`${API_BASE}/api/projects/${projectId}/automation/settings`, {
    data: { mode: "SUGGEST_ONLY", pollIntervalMs: 5_000, expectedRevision: settings.revision }
  });
  expect(patched.status()).toBe(200);
  expect(await patched.json()).toMatchObject({ mode: "SUGGEST_ONLY", pollIntervalMs: 5_000 });

  // 4. 正式 discovery：只入队，调度器随后执行。界面上的“运行发现”调用的是同一个接口，
  //    这里直接按 projectId 调用，避免多项目时依赖面板只作用于第一个项目的取舍。
  const discoveryResponse = await request.post(`${API_BASE}/api/projects/${projectId}/automation/discovery`, { data: {} });
  expect(discoveryResponse.status()).toBe(202);
  expect(await discoveryResponse.json()).toMatchObject({ projectId, created: true });

  // 概览面板同时可用于观察调度器状态。
  await page.getByRole("button", { name: "概览", exact: true }).click();
  await expect(page.getByRole("heading", { name: "概览" })).toBeVisible();
  const automationPanel = page.locator("section.panel").filter({ hasText: automationPanelAnchor });
  await expect(automationPanel).toBeVisible();
  await expect(automationPanel.getByText(/调度(运行中|已停止)/)).toBeVisible();

  // 5. Sessions API 等到受控线程被绑定。
  await expect
    .poll(
      async () => (await listSessions(request)).some((item) => item.externalSessionId === fixture.externalSessionId),
      { message: "发现未绑定受控线程：检查 DISCOVER_CODEX_THREADS handler 或 Codex 协议 stub", timeout: 30_000, intervals: [250, 500, 1_000] }
    )
    .toBe(true);
  const boundSession = (await listSessions(request)).find((item) => item.externalSessionId === fixture.externalSessionId)!;
  expect(boundSession.projectId).toBe(projectId);

  // 等到正式同步把该会话绑定到 rollout 末尾：状态进入 WATCHING，offset 落在文件末尾，
  // 且绑定前的事件一个都没有被摄入。
  await expect
    .poll(
      async () => (await readSyncState(request, boundSession.id)).status,
      { message: "会话未绑定到 rollout：检查 SYNC_SESSION_TRANSCRIPT 的首次绑定语义", timeout: 30_000, intervals: [250, 500, 1_000] }
    )
    .toBe("WATCHING");
  const boundState = await readSyncState(request, boundSession.id);
  expect(boundState.byteOffset).toBeGreaterThan(0);
  expect(boundState.eventsIngested).toBe(0);

  // 绑定发生在 rollout 末尾，所以此刻还没有任何 Evidence，Capsule 也没有连续性。
  expect(await listSessionEvidence(request, boundSession.id)).toHaveLength(0);
  expect((await readResumeCapsule(request, boundSession.id)).contextText).toBeNull();

  // 6. 绑定之后才追加新事件：绑定前的历史不允许被自动摄入。
  const appendResponse = await request.post(`${API_BASE}/__e2e/automation-fixture/append`, { data: { scope } });
  expect(appendResponse.status()).toBe(200);
  const appended = (await appendResponse.json()) as { batch: number; events: number; marker: string };
  expect(appended.batch).toBe(1);
  expect(appended.events).toBe(2);

  // 7. 等待正式调度在下一个合法轮询周期捕获该批次。
  await expect
    .poll(
      async () => (await listSessionEvidence(request, boundSession.id)).length,
      { message: "正式 scheduled sync 未捕获追加事件：检查 SYNC_SESSION_TRANSCRIPT 与 rollout tail", timeout: 30_000, intervals: [1_000] }
    )
    .toBeGreaterThan(0);
  const evidence = await listSessionEvidence(request, boundSession.id);
  const batchEvidenceId = evidence[0]!.id;

  // 8. Resume Capsule 必须引用刚捕获的 Evidence，并包含刚捕获的上下文。
  await expect
    .poll(
      async () => (await readResumeCapsule(request, boundSession.id)).evidenceSnapshotIds.includes(batchEvidenceId),
      { message: "Resume Capsule 未引用新捕获的 Evidence：检查同步事务内的连续性写入", timeout: 20_000, intervals: [500] }
    )
    .toBe(true);
  const capsule = await readResumeCapsule(request, boundSession.id);
  expect(capsule.contextText).toContain(appended.marker);
  expect(capsule.nextAction).toContain(appended.marker);

  // 9. 正式 Continue：必须 resume 回同一个外部会话。
  const refreshed = (await (await request.get(`${API_BASE}/api/sessions/${boundSession.id}`)).json()) as SessionSummary;
  const continueResponse = await request.post(`${API_BASE}/api/sessions/${boundSession.id}/continue`, {
    data: { expectedRevision: refreshed.revision }
  });
  expect(continueResponse.status()).toBe(200);
  const continued = (await continueResponse.json()) as { launch: { operation: string; externalSessionId: string | null }; run: { sessionId: string } };
  expect(continued.launch.operation).toBe("resume");
  expect(continued.launch.externalSessionId).toBe(fixture.externalSessionId);

  // 10. 受控适配器：resume 到同一 external session，且 prompt 带上了刚捕获的连续性。
  const resumeCall = (await readAdapterCalls(request))
    .find((call) => call.operation === "resume" && call.externalSessionId === fixture.externalSessionId);
  expect(resumeCall, "Continue 没有走到 resume：检查 externalSessionId 绑定").toBeTruthy();
  expect(resumeCall!.externalSessionId).toBe(fixture.externalSessionId);
  expect(resumeCall!.prompt).toContain("Recent captured continuity");
  expect(resumeCall!.prompt).toContain(appended.marker);
  // prompt 只带内容，不带内部管道：没有 Evidence 路径、job payload、storage ref 或幂等键。
  expect(resumeCall!.prompt).not.toContain(batchEvidenceId);
  expect(resumeCall!.prompt).not.toContain("storageRef");
  expect(resumeCall!.prompt).not.toContain("idempotencyKey");
  expect(resumeCall!.prompt).not.toContain(fixture.projectRoot);
  expect(resumeCall!.prompt).not.toContain("rollout-");

  // 11. 界面只暴露会话连续性相关的状态，且不显示英文内部枚举。
  await expect
    .poll(async () => (await automationPanel.innerText()).includes(automationPanelAnchor), {
      message: "概览未显示自动化状态",
      timeout: 15_000,
      intervals: [500]
    })
    .toBe(true);
  const panelText = (await automationPanel.innerText()) ?? "";
  expect(panelText).not.toContain("AUTO_ACCEPT_HIGH_CONFIDENCE");
  expect(panelText).not.toContain("SUGGEST_ONLY");
  expect(panelText).not.toContain("待审核提取建议");

  // 12. 布局：桌面与窄屏都不出现横向溢出。
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath(`continuity-${scope}-desktop.png`), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath(`continuity-${scope}-mobile.png`), fullPage: true });
});
