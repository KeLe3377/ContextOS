import { expect, test } from "@playwright/test";

test("main workspace exposes failed session history across desktop and mobile", async ({ page, request }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("contextos.apiBase", "http://127.0.0.1:4722"));
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const projectResponse = await request.post("/api/projects", {
    data: { name: `E2E ${suffix}`, rootPath: process.cwd(), agentAdapterIds: ["codex"], defaultRuleIds: [] }
  });
  expect(projectResponse.ok()).toBeTruthy();
  const project = await projectResponse.json();

  const sessionResponse = await request.post("/api/sessions", {
    data: { projectId: project.id, agentAdapterId: "codex", title: `Failed run ${suffix}`, intent: "Verify runtime failure visibility" }
  });
  expect(sessionResponse.ok()).toBeTruthy();
  const session = await sessionResponse.json();
  const continueResponse = await request.post(`/api/sessions/${session.id}/continue`, { data: { expectedRevision: session.revision } });
  expect(continueResponse.ok()).toBeTruthy();

  await expect.poll(async () => (await request.get(`/api/sessions/${session.id}`)).json()).toMatchObject({ status: "FAILED" });
  await page.goto("/#sessions");
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  await expect(page.getByText(`Failed run ${suffix}`, { exact: true }).first()).toBeVisible();
  await page.getByTitle("View session details").first().click();
  await expect(page.getByText("Run History", { exact: true })).toBeVisible();
  await expect(page.getByText("PROCESS_EXITED", { exact: true }).first()).toBeVisible();

  await page.getByTitle("Settings").click();
  await expect(page.getByText("Runtime Health", { exact: true })).toBeVisible();
  await expect(page.getByTitle("Open owning session").first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("workspace.png"), fullPage: true });
});
