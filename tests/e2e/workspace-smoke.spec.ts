import { expect, test } from "@playwright/test";

test("main workspace exposes failed session history across desktop and mobile", async ({ page, request }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("contextos.apiBase", "http://127.0.0.1:4722"));
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const projectName = `E2E ${suffix}`;
  const sessionTitle = `Failed run ${suffix}`;

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await page.getByRole("button", { name: "Add Project" }).click();
  await page.getByLabel("Project name").fill(projectName);
  await page.getByLabel("Root path").fill(process.cwd());
  await page.getByRole("button", { name: "Create Project" }).click();
  await expect(page.getByText("Project created", { exact: true })).toBeVisible();
  await expect(page.getByText(projectName, { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.getByRole("button", { name: "New Session" }).click();
  await page.getByLabel("Project").selectOption({ label: `${projectName} · ${process.cwd()}` });
  await page.getByLabel("Title").fill(sessionTitle);
  await page.getByLabel("Intent").fill("Verify runtime failure visibility");
  await page.getByRole("button", { name: "Create Session" }).click();
  await expect(page.getByText("Session created", { exact: true })).toBeVisible();

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
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  await expect(page.getByText(sessionTitle, { exact: true }).first()).toBeVisible();
  const sessionRow = page.getByRole("row").filter({ hasText: sessionTitle });
  await sessionRow.getByTitle("View session details").click();
  await expect(page.getByText("Run History", { exact: true })).toBeVisible();
  await expect(page.getByText("PROCESS_EXITED", { exact: true }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("sessions.png"), fullPage: true });

  await page.getByTitle("Settings").click();
  await expect(page.getByText("Runtime Health", { exact: true })).toBeVisible();
  await expect(page.getByTitle("Open owning session").first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("workspace.png"), fullPage: true });
});

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page): Promise<void> {
  await expect.poll(() => page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")).toBe(true);
}
