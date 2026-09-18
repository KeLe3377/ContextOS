import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";

let server: FastifyInstance | undefined;
let tempDir: string | undefined;
let projectId: string;
const originalCommand = process.env.CONTEXTOS_CODEX_COMMAND;
const originalArgs = process.env.CONTEXTOS_CODEX_ARGS;

beforeEach(async () => {
  process.env.CONTEXTOS_CODEX_COMMAND = process.execPath;
  process.env.CONTEXTOS_CODEX_ARGS = JSON.stringify(["-e", ""]);
  tempDir = await mkdtemp(join(tmpdir(), "contextos-rules-"));
  server = await createDaemonServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      dataDir: tempDir,
      databaseFile: join(tempDir, "contextos.sqlite")
    }
  });
  const projectResponse = await server.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "Rules", rootPath: process.cwd() }
  });
  projectId = projectResponse.json().id;
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  setEnv("CONTEXTOS_CODEX_COMMAND", originalCommand);
  setEnv("CONTEXTOS_CODEX_ARGS", originalArgs);
});

describe("rules API", () => {
  test("validates and activates a versioned rule", async () => {
    const create = await server!.inject({
      method: "POST",
      url: "/api/rules",
      payload: {
        projectId,
        title: "Read-only original transcripts",
        description: "Autonomous agents cannot modify raw evidence.",
        scope: { resourceTypes: ["evidence_snapshot"] },
        conditions: [{ field: "sourceType", operator: "exists" }],
        effect: { action: "BLOCK", reason: "Evidence snapshots are immutable" },
        enforcementMode: "BLOCK",
        precedence: 10
      }
    });
    expect(create.statusCode).toBe(201);
    const rule = create.json();
    expect(rule.status).toBe("DRAFT");

    const blockedActivation = await server!.inject({
      method: "POST",
      url: `/api/rules/${rule.id}/activate`,
      payload: { expectedRevision: rule.revision }
    });
    expect(blockedActivation.statusCode).toBe(400);

    const validation = await server!.inject({ method: "POST", url: `/api/rules/${rule.id}/validate` });
    expect(validation.statusCode).toBe(200);
    expect(validation.json().valid).toBe(true);
    expect(validation.json().version.validationState).toBe("VALID");

    const activated = await server!.inject({
      method: "POST",
      url: `/api/rules/${rule.id}/activate`,
      payload: { expectedRevision: rule.revision }
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().status).toBe("ACTIVE");

    const versions = await server!.inject({ method: "GET", url: `/api/rules/${rule.id}/versions` });
    expect(versions.statusCode).toBe(200);
    expect(versions.json().items).toHaveLength(1);
  });

  test("evaluates structured input deterministically and persists usage", async () => {
    const rule = await createRule({
      title: "Review Codex continues",
      scope: { eventTypes: ["session.continue"], resourceTypes: ["session"] },
      conditions: [{ field: "adapterId", operator: "equals", value: "codex" }],
      effect: { reason: "Review agent continuation" },
      enforcementMode: "REQUIRE_REVIEW"
    });
    const sample = {
      eventType: "session.continue",
      resourceType: "session",
      resourceId: "sess_sample",
      data: { adapterId: "codex", status: "CREATED" }
    };
    const first = await server!.inject({ method: "POST", url: `/api/rules/${rule.id}/test`, payload: sample });
    const second = await server!.inject({ method: "POST", url: `/api/rules/${rule.id}/test`, payload: sample });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ result: "MATCHED", evaluatorVersion: "contextos.rules.v1" });
    expect(second.json().inputHash).toBe(first.json().inputHash);

    const evaluations = await server!.inject({ method: "GET", url: `/api/rules/${rule.id}/evaluations` });
    expect(evaluations.json().items).toHaveLength(2);
    const usage = await server!.inject({ method: "GET", url: `/api/rules/${rule.id}/usage` });
    expect(usage.json()).toMatchObject({ evaluationCount: 2, matchedCount: 2 });
  });

  test("blocks session continue and creates review items from active rules", async () => {
    const blocking = await activateRule(await createRule({
      title: "Block created sessions",
      scope: { eventTypes: ["session.continue"], resourceTypes: ["session"] },
      conditions: [{ field: "status", operator: "equals", value: "CREATED" }],
      effect: { reason: "Continuation blocked by policy" },
      enforcementMode: "BLOCK"
    }));
    const session = await createSession();
    const blocked = await server!.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: session.revision }
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toBe("Continuation blocked by policy");

    const disabled = await server!.inject({
      method: "POST",
      url: `/api/rules/${blocking.id}/disable`,
      payload: { expectedRevision: blocking.revision }
    });
    expect(disabled.statusCode).toBe(200);

    await activateRule(await createRule({
      title: "Review continuation",
      scope: { eventTypes: ["session.continue"] },
      conditions: [{ field: "adapterId", operator: "equals", value: "codex" }],
      effect: { reason: "Human review required", action: "Inspect session" },
      enforcementMode: "REQUIRE_REVIEW"
    }));
    const continued = await server!.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: session.revision }
    });
    expect(continued.statusCode).toBe(200);

    const reviews = await server!.inject({ method: "GET", url: `/api/review-items?projectId=${projectId}` });
    expect(reviews.json().items).toEqual([
      expect.objectContaining({ sourceType: "RULE", triggerType: "SESSION_CONTINUE", summary: "Human review required" })
    ]);
  });

  test("renders and applies active rules to project agent instruction files", async () => {
    const renderRoot = await mkdtemp(join(tmpdir(), "contextos-rules-render-"));
    const renderProject = await server!.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Render Rules", rootPath: renderRoot }
    });
    const renderProjectId = renderProject.json().id;
    await activateRule(await createRule({
      projectId: renderProjectId,
      title: "Keep evidence immutable",
      description: "Never rewrite raw evidence files.",
      scope: { eventTypes: ["session.continue"] },
      conditions: [{ field: "adapterId", operator: "equals", value: "codex" }],
      effect: { reason: "Evidence must stay auditable", action: "Create derived context instead" },
      enforcementMode: "WARNING",
      precedence: 20
    }));
    const file = join(renderRoot, "AGENTS.md");
    await writeFile(file, "# Existing instructions\n\nKeep this line.\n", "utf8");

    const preview = await server!.inject({
      method: "POST",
      url: "/api/rules/render-instructions",
      payload: { projectId: renderProjectId, target: "PROJECT_AGENTS", apply: false }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ target: "PROJECT_AGENTS", activeRuleCount: 1, applied: false });
    expect(preview.json().content).toContain("Keep evidence immutable");
    expect(preview.json().nextContent).toContain("Keep this line.");

    const applied = await server!.inject({
      method: "POST",
      url: "/api/rules/render-instructions",
      payload: { projectId: renderProjectId, target: "PROJECT_AGENTS", apply: true }
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ applied: true });
    const written = await readFile(file, "utf8");
    expect(written).toContain("<!-- CONTEXTOS_RULES_START -->");
    expect(written).toContain("Keep evidence immutable");
    expect(written).toContain("Keep this line.");
    await rm(renderRoot, { recursive: true, force: true });
  });
});

async function createRule(input: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await server!.inject({
    method: "POST",
    url: "/api/rules",
    payload: { projectId, precedence: 10, ...input }
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function activateRule(rule: Record<string, any>): Promise<Record<string, any>> {
  const validation = await server!.inject({ method: "POST", url: `/api/rules/${rule.id}/validate` });
  expect(validation.statusCode).toBe(200);
  const activation = await server!.inject({
    method: "POST",
    url: `/api/rules/${rule.id}/activate`,
    payload: { expectedRevision: rule.revision }
  });
  expect(activation.statusCode).toBe(200);
  return activation.json();
}

async function createSession(): Promise<Record<string, any>> {
  const response = await server!.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { projectId, agentAdapterId: "codex", title: "Governed session" }
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
