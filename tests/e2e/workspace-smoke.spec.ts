import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";

test("main workspace exposes failed session history across desktop and mobile", async ({ page, request }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("contextos.apiBase", "http://127.0.0.1:4722"));
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const projectName = `E2E ${suffix}`;
  const sessionTitle = `Failed run ${suffix}`;

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "概览" })).toBeVisible();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await expect(page.getByRole("heading", { name: "项目" })).toBeVisible();
  await page.getByRole("button", { name: "添加项目" }).click();
  await page.getByLabel("项目名称").fill(projectName);
  await page.getByLabel("根路径").fill(process.cwd());
  await page.getByRole("button", { name: "创建项目" }).click();
  await expect(page.getByText("项目已创建", { exact: true })).toBeVisible();
  await expect(page.getByText(projectName, { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "会话", exact: true }).click();
  await page.getByRole("button", { name: "新建会话" }).click();
  await page.getByLabel("项目").selectOption({ label: `${projectName} · ${process.cwd()}` });
  await page.getByLabel("标题").fill(sessionTitle);
  await page.getByLabel("意图").fill("Verify runtime failure visibility");
  await page.getByRole("button", { name: "创建会话" }).click();
  await expect(page.getByText("会话已创建", { exact: true })).toBeVisible();

  const session = await expect.poll(async () => {
    const response = await request.get(`/api/sessions?q=${encodeURIComponent(sessionTitle)}`);
    return (await response.json()).items[0] ?? null;
  }).not.toBeNull().then(async () => {
    const response = await request.get(`/api/sessions?q=${encodeURIComponent(sessionTitle)}`);
    return (await response.json()).items[0];
  });
  const continueResponse = await request.post(`/api/sessions/${session.id}/continue`, { data: { expectedRevision: session.revision } });
  expect(continueResponse.ok()).toBeTruthy();

  await expect.poll(async () => (await request.get(`/api/sessions/${session.id}`)).json()).toMatchObject({ status: "FAILED" });
  await page.reload();
  await expect(page.getByRole("heading", { name: "会话" })).toBeVisible();
  await expect(page.getByText(sessionTitle, { exact: true }).first()).toBeVisible();
  const sessionRow = page.getByRole("row").filter({ hasText: sessionTitle });
  await sessionRow.getByTitle("查看会话详情").click();
  await expect(page.getByText("运行历史", { exact: true })).toBeVisible();
  await expect(page.getByText("PROCESS_EXITED", { exact: true }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("sessions.png"), fullPage: true });

  await page.getByTitle("设置").click();
  await expect(page.getByText("运行时健康", { exact: true })).toBeVisible();
  await expect(page.getByTitle("打开所属会话").first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("workspace.png"), fullPage: true });
});

test("work item agent attempt reconciles a failed linked session", async ({ page, request }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("contextos.apiBase", "http://127.0.0.1:4722"));
  const suffix = `work-${testInfo.project.name}-${Date.now()}`;
  const projectName = `E2E ${suffix}`;
  const workTitle = `Execute ${suffix}`;

  await page.goto("/#projects");
  await page.getByRole("button", { name: "添加项目" }).click();
  await page.getByLabel("项目名称").fill(projectName);
  await page.getByLabel("根路径").fill(process.cwd());
  await page.getByRole("button", { name: "创建项目" }).click();
  await expect(page.getByText(projectName, { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "工作项", exact: true }).click();
  await page.getByRole("button", { name: "创建工作项" }).last().click();
  await page.getByLabel("项目").selectOption({ label: `${projectName} · ${process.cwd()}` });
  await page.getByLabel("标题").fill(workTitle);
  await page.getByLabel("描述").fill("Exercise the linked agent execution loop");
  await page.getByLabel("验收条件").fill("Attempt is visible\nFailure is reconciled");
  await page.getByRole("button", { name: "创建工作项" }).last().click();
  await expect(page.getByText(workTitle, { exact: true }).first()).toBeVisible();
  const workItemRow = page.getByRole("row").filter({ hasText: workTitle });
  await workItemRow.getByTitle("查看工作项详情").click();

  const readyButton = page.getByRole("button", { name: "设为就绪", exact: true });
  await expect(readyButton).toBeEnabled();
  await readyButton.click();
  await expect(page.getByText("工作项已标记为就绪", { exact: true })).toBeVisible();
  const startSessionButton = page.getByRole("button", { name: "启动会话", exact: true });
  await expect(startSessionButton).toBeEnabled();
  await startSessionButton.click();
  await expect(page.getByText("工作项会话已启动", { exact: true })).toBeVisible();
  await expect(page.getByText("Work:", { exact: false }).first()).toBeVisible();
  await page.getByTitle("打开关联会话").first().click();

  await expect(page.getByRole("heading", { name: "会话" })).toBeVisible();
  await page.getByRole("button", { name: "继续", exact: true }).click();
  const sessionTitle = `Work: ${workTitle}`;
  const linkedSession = await waitForListItem(request, `/api/sessions?q=${encodeURIComponent(sessionTitle)}`);
  await expect.poll(async () => (await request.get(`/api/sessions/${linkedSession.id}`)).json()).toMatchObject({ status: "FAILED" });

  await page.getByRole("button", { name: "工作项", exact: true }).click();
  await page.getByTitle("刷新").click();
  await expect(page.getByRole("heading", { name: "工作项" })).toBeVisible();
  await expect(page.getByText(workTitle, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("智能体尝试", { exact: true })).toBeVisible();
  await expect(page.getByText("PROCESS_EXITED", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("FAILED", { exact: true }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("work-item-attempt.png"), fullPage: true });
});

test("decision versions and review actions complete through the workspace", async ({ page, request }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("contextos.apiBase", "http://127.0.0.1:4722"));
  const suffix = `governance-${testInfo.project.name}-${Date.now()}`;
  const projectName = `E2E ${suffix}`;
  const decisionTitle = `Decision ${suffix}`;
  const projectRoot = testInfo.outputPath("governance-root");
  await mkdir(projectRoot, { recursive: true });

  await createProject(page, projectName, projectRoot);
  const project = await waitForListItem(request, `/api/projects?q=${encodeURIComponent(projectName)}`);

  await page.getByRole("button", { name: "决策", exact: true }).click();
  await page.getByRole("button", { name: "记录决策" }).click();
  const decisionDialog = page.locator(".dialog-form");
  await decisionDialog.getByLabel("项目").selectOption({ label: `${projectName} · ${projectRoot}` });
  await decisionDialog.getByLabel("标题").fill(decisionTitle);
  await decisionDialog.getByLabel("决策内容").fill("Use the first governed approach");
  await decisionDialog.getByLabel("理由").fill("It is observable and reversible");
  await decisionDialog.getByLabel("备选方案").fill("Keep the current approach\nDelay the choice");
  await decisionDialog.getByRole("button", { name: "记录决策" }).click();
  await expect(page.getByText("决策已记录", { exact: true })).toBeVisible();

  const decisionRow = page.getByRole("row").filter({ hasText: decisionTitle });
  await decisionRow.getByTitle("查看决策详情").click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editDialog = page.locator(".dialog-form");
  await editDialog.getByLabel("决策内容").fill("Use the revised governed approach");
  await editDialog.getByLabel("理由").fill("It has clearer operational evidence");
  await editDialog.getByRole("button", { name: "保存决策" }).click();
  await expect(page.getByText("决策已更新", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "版本对比" }).click();
  const versionCompare = page.locator("#decision-version-compare");
  await expect(page.getByText("v1 to v2", { exact: true })).toBeVisible();
  await expect(versionCompare.getByText("Use the first governed approach", { exact: true })).toBeVisible();
  await expect(versionCompare.getByText("Use the revised governed approach", { exact: true })).toBeVisible();

  const decision = await waitForListItem(request, `/api/decisions?projectId=${project.id}&q=${encodeURIComponent(decisionTitle)}`);
  const reviewResponse = await request.post("/api/review-items", { data: { projectId: project.id, sourceType: "DECISION", sourceId: decision.id, triggerType: "MANUAL_REVIEW", summary: `Review ${decisionTitle}`, priority: "HIGH", proposedResolution: "Confirm the revised rationale" } });
  expect(reviewResponse.ok()).toBeTruthy();

  await page.getByRole("button", { name: /^审查收件箱/ }).click();
  await page.getByTitle("刷新").click();
  const reviewRow = page.getByRole("row").filter({ hasText: `Review ${decisionTitle}` });
  await reviewRow.getByTitle("查看审查详情").click();
  await page.getByRole("button", { name: "开始", exact: true }).click();
  await expect(page.getByText("审查已开始", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "指派", exact: true }).click();
  await page.locator(".dialog-form").getByLabel("审查人 ID").fill("e2e-reviewer");
  await page.locator(".dialog-form").getByRole("button", { name: "指派", exact: true }).click();
  await expect(page.getByText("审查已指派", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "解决", exact: true }).click();
  await page.locator(".dialog-form").getByLabel("原因").fill("Decision history and rationale verified");
  await page.locator(".dialog-form").getByRole("button", { name: "解决", exact: true }).click();
  await expect(page.getByText("审查已解决", { exact: true })).toBeVisible();
  await expect(page.getByText("Decision history and rationale verified", { exact: true }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("context evidence and rule instructions complete through the workspace", async ({ page, request }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("contextos.apiBase", "http://127.0.0.1:4722"));
  const suffix = `context-${testInfo.project.name}-${Date.now()}`;
  const projectName = `E2E ${suffix}`;
  const sourceName = `Source ${suffix}`;
  const ruleTitle = `Rule ${suffix}`;
  const projectRoot = testInfo.outputPath("context-root");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(`${projectRoot}/context.txt`, "Evidence remains immutable.\n", "utf8");

  await createProject(page, projectName, projectRoot);
  await waitForListItem(request, `/api/projects?q=${encodeURIComponent(projectName)}`);

  await page.getByRole("button", { name: "上下文", exact: true }).click();
  await page.getByRole("button", { name: "添加数据源" }).click();
  const sourceDialog = page.locator(".dialog-form");
  await sourceDialog.getByLabel("名称").fill(sourceName);
  await sourceDialog.getByLabel("定位符").fill("context.txt");
  await sourceDialog.getByRole("button", { name: "创建数据源" }).click();
  await expect(page.getByText("数据源已创建", { exact: true })).toBeVisible();
  const sourceRow = page.getByRole("row").filter({ hasText: sourceName });
  await sourceRow.getByTitle("查看数据源详情").click();
  await page.getByRole("button", { name: "同步", exact: true }).click();
  await expect(page.getByText("数据源已同步", { exact: true })).toBeVisible();
  const evidenceRow = page.getByRole("row").filter({ hasText: sourceName }).last();
  await evidenceRow.getByTitle("查看证据内容").click();
  await expect(page.getByText("Evidence remains immutable.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await evidenceRow.getByTitle("校验证据").click();
  await expect(page.getByText("证据已校验", { exact: true })).toBeVisible();
  await evidenceRow.getByTitle("派生上下文项").click();
  const contextDialog = page.locator(".dialog-form");
  await contextDialog.getByRole("textbox", { name: "摘要", exact: true }).fill("Evidence files are immutable");
  await contextDialog.getByRole("button", { name: "创建上下文项" }).click();
  await expect(page.getByText("上下文项已创建", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "规则", exact: true }).click();
  await page.getByRole("button", { name: "新建规则" }).click();
  const ruleDialog = page.locator(".dialog-form");
  await ruleDialog.getByLabel("规则标题").fill(ruleTitle);
  await ruleDialog.getByLabel("描述").fill("Protect source evidence");
  await ruleDialog.getByLabel("执行方式").selectOption("WARNING");
  await ruleDialog.getByLabel("原因").fill("Keep evidence auditable");
  await ruleDialog.getByRole("button", { name: "创建规则" }).click();
  await expect(page.getByText("规则草稿已创建", { exact: true })).toBeVisible();
  const ruleRow = page.getByRole("row").filter({ hasText: ruleTitle });
  await ruleRow.getByTitle("查看规则详情").click();
  await page.getByRole("button", { name: "校验", exact: true }).click();
  await expect(page.getByText("规则已校验", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "启用", exact: true }).click();
  await expect(page.getByText("规则已启用", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "应用 AGENTS.md" }).click();
  await expect(page.getByText("项目 AGENTS.md 已更新", { exact: true })).toBeVisible();
  await expect.poll(() => readFile(`${projectRoot}/AGENTS.md`, "utf8")).toContain(ruleTitle);
  await expectNoHorizontalOverflow(page);
});

async function waitForListItem(request: import("@playwright/test").APIRequestContext, path: string): Promise<Record<string, any>> {
  await expect.poll(async () => {
    const response = await request.get(path);
    return (await response.json()).items[0] ?? null;
  }).not.toBeNull();
  const response = await request.get(path);
  return (await response.json()).items[0];
}

async function createProject(page: import("@playwright/test").Page, projectName: string, projectRoot: string): Promise<void> {
  await page.goto("/#projects");
  await page.getByRole("button", { name: "添加项目" }).click();
  await page.getByLabel("项目名称").fill(projectName);
  await page.getByLabel("根路径").fill(projectRoot);
  await page.getByRole("button", { name: "创建项目" }).click();
  await expect(page.getByText("项目已创建", { exact: true })).toBeVisible();
  await expect(page.getByText(projectName, { exact: true }).first()).toBeVisible();
  await page.getByRole("row").filter({ hasText: projectName }).getByTitle("查看项目详情").click();
}

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page): Promise<void> {
  await expect.poll(() => page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")).toBe(true);
}
