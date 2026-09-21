/// <reference lib="dom" />
import { expect, test } from "@playwright/test";

/**
 * 自动化流程的确定性端到端测试。
 *
 * 复用正式配置与守护进程（`playwright.config.ts` + `scripts/start-e2e-server.ts`），
 * 只覆盖真实服务与真实 API 路径；不修改教学录制相关文件。
 */

const API_BASE = "http://127.0.0.1:4722";

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test("自动化设置与运行发现在界面上可用", async ({ page, request }, testInfo) => {
  await page.addInitScript((base) => localStorage.setItem("contextos.apiBase", base), API_BASE);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "概览" })).toBeVisible();

  // 1. 通过界面创建项目。
  const projectName = `自动化 E2E ${testInfo.project.name}-${Date.now()}`;
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await expect(page.getByRole("heading", { name: "项目" })).toBeVisible();
  await page.getByRole("button", { name: "添加项目" }).click();
  await page.getByLabel("项目名称").fill(projectName);
  await page.getByLabel("根路径").fill(process.cwd());
  await page.getByRole("button", { name: "创建项目" }).click();
  await expect(page.getByText(projectName).first()).toBeVisible();

  // 2. 自动化设置：切到“仅生成建议”，保存后刷新仍然存在。
  await page.getByRole("button", { name: "保存设置" }).waitFor();
  await page.locator("select").filter({ hasText: "关闭" }).first().selectOption("SUGGEST_ONLY");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("自动化设置已保存。")).toBeVisible();

  const projectId = await request.get(`${API_BASE}/api/projects`).then(async (response) => {
    const body = (await response.json()) as Array<{ id: string; name: string }> | { items?: Array<{ id: string; name: string }> };
    const projects = Array.isArray(body) ? body : body.items || [];
    return projects.find((item) => item.name === projectName)!.id;
  });

  await expect
    .poll(async () => (await (await request.get(`${API_BASE}/api/projects/${projectId}/automation/settings`)).json()).mode)
    .toBe("SUGGEST_ONLY");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await expect(page.getByRole("heading", { name: "项目" })).toBeVisible();
  await page.getByRole("button", { name: "保存设置" }).waitFor();
  await expect(page.locator("select").filter({ hasText: "仅生成建议" }).first()).toBeVisible();

  // 3. 运行发现：返回 202，界面显示“已入队”，不能显示成已完成。
  await page.getByRole("button", { name: "概览", exact: true }).click();
  await expect(page.getByRole("heading", { name: "概览" })).toBeVisible();
  // 用自动化面板独有的文案定位：项目名里也可能包含“自动化”。
  const automationPanel = page.locator("section.panel").filter({ hasText: "待审核提取建议" }).first();
  await expect(automationPanel).toBeVisible();
  // 等待自动化状态加载完成（加载中只显示占位文案）。
  await expect.poll(async () => (await automationPanel.innerText()).includes("待审核提取建议")).toBe(true);
  await expect(automationPanel.getByText(/调度(运行中|已停止)/)).toBeVisible();

  await automationPanel.getByRole("button", { name: "运行发现" }).click();
  await expect(automationPanel.getByText("发现任务已入队，等待调度执行。")).toBeVisible();
  // 入队后不得出现“已完成”之类的误导文案。
  await expect(automationPanel.getByText(/已完成发现|发现已完成/)).toHaveCount(0);

  // 4. 界面不直接显示英文内部枚举。
  const panelText = (await automationPanel.innerText()) ?? "";
  expect(panelText).not.toContain("AUTO_ACCEPT_HIGH_CONFIDENCE");
  expect(panelText).not.toContain("SUGGEST_ONLY");
  expect(panelText).not.toContain("EXTRACTION_CANDIDATE");

  // 5. 精确视口截图与布局检查：桌面 1440×900。
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("automation-desktop.png"), fullPage: true });

  // 6. 窄屏 390×844。
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("automation-mobile.png"), fullPage: true });
});
