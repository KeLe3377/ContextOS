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

test("work item agent attempt reconciles a failed linked session", async ({ page, request }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("contextos.apiBase", "http://127.0.0.1:4722"));
  const suffix = `work-${testInfo.project.name}-${Date.now()}`;
  const projectName = `E2E ${suffix}`;
  const workTitle = `Execute ${suffix}`;

  await page.goto("/#projects");
  await page.getByRole("button", { name: "Add Project" }).click();
  await page.getByLabel("Project name").fill(projectName);
  await page.getByLabel("Root path").fill(process.cwd());
  await page.getByRole("button", { name: "Create Project" }).click();
  await expect(page.getByText(projectName, { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Work Items", exact: true }).click();
  await page.getByRole("button", { name: "Create Item" }).last().click();
  await page.getByLabel("Project").selectOption({ label: `${projectName} · ${process.cwd()}` });
  await page.getByLabel("Title").fill(workTitle);
  await page.getByLabel("Description").fill("Exercise the linked agent execution loop");
  await page.getByLabel("Acceptance").fill("Attempt is visible\nFailure is reconciled");
  await page.getByRole("button", { name: "Create Item" }).last().click();
  await expect(page.getByText(workTitle, { exact: true }).first()).toBeVisible();
  const workItemRow = page.getByRole("row").filter({ hasText: workTitle });
  await workItemRow.getByTitle("View work detail").click();

  const readyButton = page.getByRole("button", { name: "Ready", exact: true });
  await expect(readyButton).toBeEnabled();
  await readyButton.click();
  await expect(page.getByText("Work item marked ready", { exact: true })).toBeVisible();
  const startSessionButton = page.getByRole("button", { name: "Start Session", exact: true });
  await expect(startSessionButton).toBeEnabled();
  await startSessionButton.click();
  await expect(page.getByText("Work item session started", { exact: true })).toBeVisible();
  await expect(page.getByText("Work:", { exact: false }).first()).toBeVisible();
  await page.getByTitle("Open linked session").first().click();

  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const sessionTitle = `Work: ${workTitle}`;
  const linkedSession = await waitForListItem(request, `/api/sessions?q=${encodeURIComponent(sessionTitle)}`);
  await expect.poll(async () => (await request.get(`/api/sessions/${linkedSession.id}`)).json()).toMatchObject({ status: "FAILED" });

  await page.getByRole("button", { name: "Work Items", exact: true }).click();
  await page.getByTitle("Refresh").click();
  await expect(page.getByRole("heading", { name: "Work Items" })).toBeVisible();
  await expect(page.getByText(workTitle, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Agent Attempts", { exact: true })).toBeVisible();
  await expect(page.getByText("PROCESS_EXITED", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("FAILED", { exact: true }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("work-item-attempt.png"), fullPage: true });
});

async function waitForListItem(request: import("@playwright/test").APIRequestContext, path: string): Promise<Record<string, any>> {
  await expect.poll(async () => {
    const response = await request.get(path);
    return (await response.json()).items[0] ?? null;
  }).not.toBeNull();
  const response = await request.get(path);
  return (await response.json()).items[0];
}

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page): Promise<void> {
  await expect.poll(() => page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")).toBe(true);
}
