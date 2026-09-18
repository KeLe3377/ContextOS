import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";

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

test("decision versions and review actions complete through the workspace", async ({ page, request }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("contextos.apiBase", "http://127.0.0.1:4722"));
  const suffix = `governance-${testInfo.project.name}-${Date.now()}`;
  const projectName = `E2E ${suffix}`;
  const decisionTitle = `Decision ${suffix}`;
  const projectRoot = testInfo.outputPath("governance-root");
  await mkdir(projectRoot, { recursive: true });

  await createProject(page, projectName, projectRoot);
  const project = await waitForListItem(request, `/api/projects?q=${encodeURIComponent(projectName)}`);

  await page.getByRole("button", { name: "Decisions", exact: true }).click();
  await page.getByRole("button", { name: "Record Decision" }).click();
  const decisionDialog = page.locator(".dialog-form");
  await decisionDialog.getByLabel("Project").selectOption({ label: `${projectName} · ${projectRoot}` });
  await decisionDialog.getByLabel("Title").fill(decisionTitle);
  await decisionDialog.getByLabel("Statement").fill("Use the first governed approach");
  await decisionDialog.getByLabel("Rationale").fill("It is observable and reversible");
  await decisionDialog.getByLabel("Alternatives").fill("Keep the current approach\nDelay the choice");
  await decisionDialog.getByRole("button", { name: "Record Decision" }).click();
  await expect(page.getByText("Decision recorded", { exact: true })).toBeVisible();

  const decisionRow = page.getByRole("row").filter({ hasText: decisionTitle });
  await decisionRow.getByTitle("View decision detail").click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editDialog = page.locator(".dialog-form");
  await editDialog.getByLabel("Statement").fill("Use the revised governed approach");
  await editDialog.getByLabel("Rationale").fill("It has clearer operational evidence");
  await editDialog.getByRole("button", { name: "Save Decision" }).click();
  await expect(page.getByText("Decision updated", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Compare Versions" }).click();
  const versionCompare = page.locator("#decision-version-compare");
  await expect(page.getByText("v1 to v2", { exact: true })).toBeVisible();
  await expect(versionCompare.getByText("Use the first governed approach", { exact: true })).toBeVisible();
  await expect(versionCompare.getByText("Use the revised governed approach", { exact: true })).toBeVisible();

  const decision = await waitForListItem(request, `/api/decisions?projectId=${project.id}&q=${encodeURIComponent(decisionTitle)}`);
  const reviewResponse = await request.post("/api/review-items", { data: { projectId: project.id, sourceType: "DECISION", sourceId: decision.id, triggerType: "MANUAL_REVIEW", summary: `Review ${decisionTitle}`, priority: "HIGH", proposedResolution: "Confirm the revised rationale" } });
  expect(reviewResponse.ok()).toBeTruthy();

  await page.getByRole("button", { name: /^Review Inbox/ }).click();
  await page.getByTitle("Refresh").click();
  const reviewRow = page.getByRole("row").filter({ hasText: `Review ${decisionTitle}` });
  await reviewRow.getByTitle("View review detail").click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByText("Review started", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await page.locator(".dialog-form").getByLabel("Reviewer ID").fill("e2e-reviewer");
  await page.locator(".dialog-form").getByRole("button", { name: "Assign", exact: true }).click();
  await expect(page.getByText("Review assigned", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  await page.locator(".dialog-form").getByLabel("Reason").fill("Decision history and rationale verified");
  await page.locator(".dialog-form").getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(page.getByText("Review resolved", { exact: true })).toBeVisible();
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

  await page.getByRole("button", { name: "Context", exact: true }).click();
  await page.getByRole("button", { name: "Add Source" }).click();
  const sourceDialog = page.locator(".dialog-form");
  await sourceDialog.getByLabel("Name").fill(sourceName);
  await sourceDialog.getByLabel("Locator").fill("context.txt");
  await sourceDialog.getByRole("button", { name: "Create Source" }).click();
  await expect(page.getByText("Context source created", { exact: true })).toBeVisible();
  const sourceRow = page.getByRole("row").filter({ hasText: sourceName });
  await sourceRow.getByTitle("View source detail").click();
  await page.getByRole("button", { name: "Sync", exact: true }).click();
  await expect(page.getByText("Context source synced", { exact: true })).toBeVisible();
  const evidenceRow = page.getByRole("row").filter({ hasText: sourceName }).last();
  await evidenceRow.getByTitle("Open evidence content").click();
  await expect(page.getByText("Evidence remains immutable.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await evidenceRow.getByTitle("Verify evidence").click();
  await expect(page.getByText("Evidence verified", { exact: true })).toBeVisible();
  await evidenceRow.getByTitle("Derive context item").click();
  const contextDialog = page.locator(".dialog-form");
  await contextDialog.getByRole("textbox", { name: "Summary", exact: true }).fill("Evidence files are immutable");
  await contextDialog.getByRole("button", { name: "Create Context Item" }).click();
  await expect(page.getByText("Context item created", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Rules", exact: true }).click();
  await page.getByRole("button", { name: "New Rule" }).click();
  const ruleDialog = page.locator(".dialog-form");
  await ruleDialog.getByLabel("Rule title").fill(ruleTitle);
  await ruleDialog.getByLabel("Description").fill("Protect source evidence");
  await ruleDialog.getByLabel("Enforcement").selectOption("WARNING");
  await ruleDialog.getByLabel("Reason").fill("Keep evidence auditable");
  await ruleDialog.getByRole("button", { name: "Create Rule" }).click();
  await expect(page.getByText("Rule draft created", { exact: true })).toBeVisible();
  const ruleRow = page.getByRole("row").filter({ hasText: ruleTitle });
  await ruleRow.getByTitle("View rule detail").click();
  await page.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(page.getByText("Rule validated", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Activate", exact: true }).click();
  await expect(page.getByText("Rule activated", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apply AGENTS.md" }).click();
  await expect(page.getByText("Project AGENTS.md updated", { exact: true })).toBeVisible();
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
  await page.getByRole("button", { name: "Add Project" }).click();
  await page.getByLabel("Project name").fill(projectName);
  await page.getByLabel("Root path").fill(projectRoot);
  await page.getByRole("button", { name: "Create Project" }).click();
  await expect(page.getByText("Project created", { exact: true })).toBeVisible();
  await expect(page.getByText(projectName, { exact: true }).first()).toBeVisible();
  await page.getByRole("row").filter({ hasText: projectName }).getByTitle("View project detail").click();
}

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page): Promise<void> {
  await expect.poll(() => page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")).toBe(true);
}
