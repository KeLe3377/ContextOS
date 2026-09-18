import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, test } from "vitest";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";

const originalCommand = process.env.CONTEXTOS_CODEX_COMMAND;
const originalArgs = process.env.CONTEXTOS_CODEX_ARGS;
const originalSessionsDir = process.env.CONTEXTOS_CODEX_SESSIONS_DIR;
const originalClaudeCommand = process.env.CONTEXTOS_CLAUDE_COMMAND;
const originalClaudeArgs = process.env.CONTEXTOS_CLAUDE_ARGS;
const originalClaudeProjectsDir = process.env.CONTEXTOS_CLAUDE_PROJECTS_DIR;
let cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0).reverse()) await cleanup();
  setEnv("CONTEXTOS_CODEX_COMMAND", originalCommand);
  setEnv("CONTEXTOS_CODEX_ARGS", originalArgs);
  setEnv("CONTEXTOS_CODEX_SESSIONS_DIR", originalSessionsDir);
  setEnv("CONTEXTOS_CLAUDE_COMMAND", originalClaudeCommand);
  setEnv("CONTEXTOS_CLAUDE_ARGS", originalClaudeArgs);
  setEnv("CONTEXTOS_CLAUDE_PROJECTS_DIR", originalClaudeProjectsDir);
});

describe("transcript import API", () => {
  test("imports transcript evidence into a completed session and preserves capsule history", async () => {
    const { server, tempDir } = await createTestServer();
    const { project, session } = await createSession(server);
    const continued = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: session.revision }
    });
    expect(continued.statusCode).toBe(200);
    await waitForSessionStatus(server, session.id, "COMPLETED");

    const priorCapsuleResponse = await server.inject({ method: "GET", url: `/api/sessions/${session.id}/resume-capsule` });
    const priorCapsule = priorCapsuleResponse.json();
    const contentText = "user: preserve this decision\nassistant: imported evidence is durable\n";
    const response = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/import-transcript`,
      payload: { contentText, title: "Imported conversation", summary: "Imported outcome" }
    });

    expect(response.statusCode).toBe(201);
    const result = response.json();
    expect(result.evidence).toMatchObject({
      projectId: project.id,
      evidenceType: "AGENT_OUTPUT",
      title: "Imported conversation",
      metadata: {
        sessionId: session.id,
        stream: "imported-transcript",
        importedAt: expect.any(String)
      }
    });
    expect(result.evidence.storageRef).toMatch(new RegExp(`^evidence/${project.id}/`));
    await expect(readFile(join(tempDir, result.evidence.storageRef), "utf8")).resolves.toBe(contentText);

    const verification = await server.inject({
      method: "POST",
      url: `/api/evidence-snapshots/${result.evidence.id}/verify`,
      payload: {}
    });
    expect(verification.statusCode).toBe(200);
    expect(verification.json()).toMatchObject({ exists: true, verified: true, failureCode: null });
    expect(result.resumeCapsule).toMatchObject({
      sessionId: session.id,
      status: "COMPLETED",
      summary: "Imported outcome",
      lastRunId: priorCapsule.lastRunId
    });
    expect(result.resumeCapsule.evidenceSnapshotIds).toEqual([
      ...priorCapsule.evidenceSnapshotIds,
      result.evidence.id
    ]);

    const refreshedSession = await server.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    expect(refreshedSession.json().status).toBe("COMPLETED");
    const db = new Database(join(tempDir, "contextos.sqlite"), { readonly: true });
    try {
      const activityCount = db.prepare("SELECT COUNT(*) AS count FROM activity_events WHERE resource_id = ? AND event_type = 'TRANSCRIPT_IMPORTED'").get(session.id) as { count: number };
      const auditCount = db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE resource_id = ? AND action = 'TRANSCRIPT_IMPORTED'").get(session.id) as { count: number };
      expect(activityCount.count).toBe(1);
      expect(auditCount.count).toBe(1);
    } finally {
      db.close();
    }
  });

  test("uses deterministic defaults and rejects blank transcript fields", async () => {
    const { server } = await createTestServer();
    const { session } = await createSession(server);
    const response = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/import-transcript`,
      payload: { contentText: "an imported transcript" }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      evidence: { title: "Imported transcript" },
      resumeCapsule: { status: "CREATED", summary: "Imported transcript captured." }
    });

    for (const payload of [
      { contentText: "   " },
      { contentText: "valid", summary: "   " },
      { contentText: "valid", title: "   " }
    ]) {
      const invalid = await server.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/import-transcript`,
        payload
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe("INVALID_ARGUMENT");
    }
  });

  test("patches resume capsule notes without dropping evidence history", async () => {
    const { server } = await createTestServer();
    const { session } = await createSession(server);
    const imported = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/import-transcript`,
      payload: {
        contentText: "user: current state\nassistant: ship sessions next\n",
        summary: "Imported summary",
        title: "Imported transcript"
      }
    });
    expect(imported.statusCode).toBe(201);

    const refreshed = await server.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    const revision = refreshed.json().revision;
    const patched = await server.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}/resume-capsule`,
      payload: {
        summary: "Manual session summary",
        nextAction: "Continue productizing Sessions",
        expectedRevision: revision
      }
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      sessionId: session.id,
      summary: "Manual session summary",
      nextAction: "Continue productizing Sessions"
    });
    expect(patched.json().evidenceSnapshotIds).toEqual(imported.json().resumeCapsule.evidenceSnapshotIds);

    const after = await server.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    expect(after.json().revision).toBe(revision + 1);

    const stale = await server.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}/resume-capsule`,
      payload: { summary: "Stale update", expectedRevision: revision }
    });
    expect(stale.statusCode).toBe(409);
  });

  test("replays transcript imports by idempotency key without duplicate evidence", async () => {
    const { server, tempDir } = await createTestServer();
    const { session } = await createSession(server);
    const request = {
      method: "POST" as const,
      url: `/api/sessions/${session.id}/import-transcript`,
      headers: { "idempotency-key": "transcript-import-0001" },
      payload: { contentText: "idempotent transcript" }
    };
    const first = await server.inject(request);
    const replay = await server.inject(request);

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["x-idempotent-replay"]).toBe("true");
    expect(replay.json().evidence.id).toBe(first.json().evidence.id);

    const db = new Database(join(tempDir, "contextos.sqlite"), { readonly: true });
    try {
      const row = db.prepare("SELECT COUNT(*) AS count FROM evidence_snapshots WHERE json_extract(metadata_json, '$.sessionId') = ? AND json_extract(metadata_json, '$.stream') = 'imported-transcript'").get(session.id) as { count: number };
      expect(row.count).toBe(1);
    } finally {
      db.close();
    }
  });

  test("auto-discovers, binds, and reuses a Codex transcript for the Project", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "contextos-auto-transcript-"));
    const projectRoot = join(tempDir, "workspace");
    const sessionsDir = join(tempDir, "codex-sessions", "2026", "09", "16");
    await Promise.all([mkdir(projectRoot), mkdir(sessionsDir, { recursive: true })]);
    const externalSessionId = "codex-auto-session";
    const transcriptPath = join(sessionsDir, `rollout-${externalSessionId}.jsonl`);
    const rows = [
      { type: "session_meta", payload: { id: externalSessionId, cwd: projectRoot } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "preserve the API decision" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "the decision is preserved" }] } }
    ];
    await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    process.env.CONTEXTOS_CODEX_COMMAND = process.execPath;
    process.env.CONTEXTOS_CODEX_ARGS = JSON.stringify(["--version"]);
    process.env.CONTEXTOS_CODEX_SESSIONS_DIR = join(tempDir, "codex-sessions");
    const server = await createDaemonServer({
      config: { host: "127.0.0.1", port: 0, dataDir: tempDir, databaseFile: join(tempDir, "contextos.sqlite") }
    });
    cleanupTasks.push(async () => {
      await server.close();
      await rm(tempDir, { recursive: true, force: true });
    });
    const projectResponse = await server.inject({ method: "POST", url: "/api/projects", payload: { name: "Auto transcript", rootPath: projectRoot } });
    const project = projectResponse.json();
    const sessionResponse = await server.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.id, agentAdapterId: "codex", title: "Auto import" }
    });
    const session = sessionResponse.json();

    const first = await server.inject({ method: "POST", url: `/api/sessions/${session.id}/import-transcript/auto`, payload: {} });
    expect(first.statusCode, first.body).toBe(201);
    const result = first.json();
    expect(result.adapter).toMatchObject({
      id: "codex",
      externalSessionId,
      parserVersion: "codex-jsonl.v2",
      eventCount: 2,
      eventCounts: { message: 2, toolCall: 0, toolResult: 0, summary: 0 },
      messageCount: 2,
      roleCounts: { user: 1, assistant: 1 },
      turnCount: 1,
      messageOrdinalStart: 1,
      messageOrdinalEnd: 2,
      truncated: false,
      reused: false
    });
    expect(result.evidence.metadata).toMatchObject({
      sessionId: session.id,
      stream: "imported-transcript",
      adapterId: "codex",
      externalSessionId,
      parserVersion: "codex-jsonl.v2",
      eventCount: 2,
      eventCounts: { message: 2, toolCall: 0, toolResult: 0, summary: 0 },
      messageCount: 2,
      roleCounts: { user: 1, assistant: 1 },
      turnCount: 1,
      messageOrdinalStart: 1,
      messageOrdinalEnd: 2
    });
    await expect(readFile(join(tempDir, result.evidence.storageRef), "utf8")).resolves.toBe(
      "USER:\npreserve the API decision\n\nASSISTANT:\nthe decision is preserved"
    );
    const refreshed = await server.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    expect(refreshed.json().externalSessionId).toBe(externalSessionId);

    const repeated = await server.inject({ method: "POST", url: `/api/sessions/${session.id}/import-transcript/auto`, payload: {} });
    expect(repeated.statusCode).toBe(201);
    expect(repeated.json().adapter.reused).toBe(true);
    expect(repeated.json().evidence.id).toBe(result.evidence.id);
    const mismatched = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/import-transcript/auto`,
      payload: { externalSessionId: "different-codex-session" }
    });
    expect(mismatched.statusCode).toBe(409);
    expect(mismatched.json().error.code).toBe("CONFLICT");
    const db = new Database(join(tempDir, "contextos.sqlite"), { readonly: true });
    try {
      const count = db.prepare("SELECT COUNT(*) AS count FROM evidence_snapshots WHERE json_extract(metadata_json, '$.sessionId') = ? AND json_extract(metadata_json, '$.externalSessionId') = ?").get(session.id, externalSessionId) as { count: number };
      expect(count.count).toBe(1);
    } finally {
      db.close();
    }
  });

  test("syncs updated bound Codex transcript as new evidence and reuses unchanged content", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "contextos-sync-transcript-"));
    const projectRoot = join(tempDir, "workspace");
    const sessionsDir = join(tempDir, "codex-sessions", "2026", "09", "17");
    await Promise.all([mkdir(projectRoot), mkdir(sessionsDir, { recursive: true })]);
    const externalSessionId = "codex-bound-sync";
    const transcriptPath = join(sessionsDir, `rollout-${externalSessionId}.jsonl`);
    const writeTranscript = async (messages: string[]) => {
      const rows = [
        { type: "session_meta", payload: { id: externalSessionId, cwd: projectRoot } },
        ...messages.flatMap((message, index) => [
          { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `user ${index + 1}: ${message}` }] } },
          { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `assistant ${index + 1}: ${message}` }] } }
        ])
      ];
      await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    };
    await writeTranscript(["initial"]);
    process.env.CONTEXTOS_CODEX_COMMAND = process.execPath;
    process.env.CONTEXTOS_CODEX_ARGS = JSON.stringify(["--version"]);
    process.env.CONTEXTOS_CODEX_SESSIONS_DIR = join(tempDir, "codex-sessions");
    const server = await createDaemonServer({
      config: { host: "127.0.0.1", port: 0, dataDir: tempDir, databaseFile: join(tempDir, "contextos.sqlite") }
    });
    cleanupTasks.push(async () => {
      await server.close();
      await rm(tempDir, { recursive: true, force: true });
    });
    const projectResponse = await server.inject({ method: "POST", url: "/api/projects", payload: { name: "Sync transcript", rootPath: projectRoot } });
    const project = projectResponse.json();
    const sessionResponse = await server.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.id, agentAdapterId: "codex", title: "Bound sync" }
    });
    const session = sessionResponse.json();

    const first = await server.inject({ method: "POST", url: `/api/sessions/${session.id}/import-transcript/auto`, payload: { externalSessionId } });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().adapter).toMatchObject({ externalSessionId, reused: false, messageCount: 2 });

    await writeTranscript(["initial", "new decision"]);
    const changed = await server.inject({ method: "POST", url: `/api/sessions/${session.id}/sync-transcript`, payload: {} });
    expect(changed.statusCode, changed.body).toBe(201);
    expect(changed.json().adapter).toMatchObject({ externalSessionId, reused: false, messageCount: 4, messageOrdinalEnd: 4 });
    expect(changed.json().evidence.id).not.toBe(first.json().evidence.id);

    const repeated = await server.inject({ method: "POST", url: `/api/sessions/${session.id}/sync-transcript`, payload: {} });
    expect(repeated.statusCode, repeated.body).toBe(201);
    expect(repeated.json().adapter.reused).toBe(true);
    expect(repeated.json().evidence.id).toBe(changed.json().evidence.id);

    const evidence = await server.inject({ method: "GET", url: `/api/sessions/${session.id}/evidence` });
    expect(evidence.json().items.filter((item: { metadata: { externalSessionId?: string } }) => item.metadata.externalSessionId === externalSessionId)).toHaveLength(2);
  });

  test("imports an explicit Codex transcript recorded from a parent workspace", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "contextos-parent-transcript-"));
    const workspaceRoot = join(tempDir, "workspace");
    const projectRoot = join(workspaceRoot, "ContextOS");
    const sessionsDir = join(tempDir, "codex-sessions", "2026", "09", "17");
    await Promise.all([mkdir(projectRoot, { recursive: true }), mkdir(sessionsDir, { recursive: true })]);
    const externalSessionId = "codex-parent-workspace-session";
    const transcriptPath = join(sessionsDir, `rollout-${externalSessionId}.jsonl`);
    const rows = [
      { type: "session_meta", payload: { id: externalSessionId, cwd: workspaceRoot } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "import this nested project conversation" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "nested project conversation imported" }] } }
    ];
    await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    process.env.CONTEXTOS_CODEX_COMMAND = process.execPath;
    process.env.CONTEXTOS_CODEX_ARGS = JSON.stringify(["--version"]);
    process.env.CONTEXTOS_CODEX_SESSIONS_DIR = join(tempDir, "codex-sessions");
    const server = await createDaemonServer({
      config: { host: "127.0.0.1", port: 0, dataDir: tempDir, databaseFile: join(tempDir, "contextos.sqlite") }
    });
    cleanupTasks.push(async () => {
      await server.close();
      await rm(tempDir, { recursive: true, force: true });
    });
    const projectResponse = await server.inject({ method: "POST", url: "/api/projects", payload: { name: "ContextOS", rootPath: projectRoot } });
    expect(projectResponse.statusCode).toBe(201);
    const sessionResponse = await server.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: projectResponse.json().id, agentAdapterId: "codex", title: "Explicit parent import" }
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = sessionResponse.json();

    const automatic = await server.inject({ method: "POST", url: `/api/sessions/${session.id}/import-transcript/auto`, payload: {} });
    expect(automatic.statusCode).toBe(404);

    const explicit = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/import-transcript/auto`,
      payload: { externalSessionId }
    });
    expect(explicit.statusCode, explicit.body).toBe(201);
    expect(explicit.json().adapter.externalSessionId).toBe(externalSessionId);
    expect(explicit.json().evidence.metadata).toMatchObject({ externalSessionId, adapterId: "codex" });
    const refreshed = await server.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    expect(refreshed.json().externalSessionId).toBe(externalSessionId);
  });

  test("auto-discovers and binds a Claude Code transcript for the Project", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "contextos-claude-auto-transcript-"));
    const projectRoot = join(tempDir, "workspace");
    const projectsDir = join(tempDir, "claude-projects");
    await Promise.all([mkdir(projectRoot), mkdir(projectsDir, { recursive: true })]);
    const externalSessionId = "claude-auto-session";
    const transcriptPath = join(projectsDir, `${externalSessionId}.jsonl`);
    const rows = [
      { sessionId: externalSessionId, cwd: projectRoot, type: "summary", summary: "Claude session summary" },
      { sessionId: externalSessionId, cwd: projectRoot, type: "user", message: { role: "user", content: "preserve the Claude decision" } },
      { sessionId: externalSessionId, cwd: projectRoot, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "the Claude decision is preserved" }, { type: "tool_use", id: "tool_read", name: "Read", input: { file: "AGENT.md" } }, { type: "tool_result", tool_use_id: "tool_read", content: "rules loaded" }] } }
    ];
    await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    process.env.CONTEXTOS_CODEX_COMMAND = process.execPath;
    process.env.CONTEXTOS_CODEX_ARGS = JSON.stringify(["--version"]);
    process.env.CONTEXTOS_CODEX_SESSIONS_DIR = join(tempDir, "codex-sessions");
    process.env.CONTEXTOS_CLAUDE_COMMAND = process.execPath;
    process.env.CONTEXTOS_CLAUDE_ARGS = JSON.stringify(["--version"]);
    process.env.CONTEXTOS_CLAUDE_PROJECTS_DIR = projectsDir;
    const server = await createDaemonServer({
      config: { host: "127.0.0.1", port: 0, dataDir: tempDir, databaseFile: join(tempDir, "contextos.sqlite") }
    });
    cleanupTasks.push(async () => {
      await server.close();
      await rm(tempDir, { recursive: true, force: true });
    });
    const projectResponse = await server.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Claude auto transcript", rootPath: projectRoot, agentAdapterIds: ["codex", "claude-code"] }
    });
    expect(projectResponse.statusCode).toBe(201);
    const sessionResponse = await server.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: projectResponse.json().id, agentAdapterId: "claude-code", title: "Claude auto import" }
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = sessionResponse.json();

    const imported = await server.inject({ method: "POST", url: `/api/sessions/${session.id}/import-transcript/auto`, payload: {} });
    expect(imported.statusCode, imported.body).toBe(201);
    expect(imported.json().adapter).toMatchObject({
      id: "claude-code",
      externalSessionId,
      parserVersion: "claude-code-jsonl.v2",
      eventCount: 5,
      eventCounts: { message: 2, toolCall: 1, toolResult: 1, summary: 1 },
      messageCount: 2,
      roleCounts: { user: 1, assistant: 1 },
      turnCount: 1,
      messageOrdinalStart: 1,
      messageOrdinalEnd: 2,
      truncated: false,
      reused: false
    });
    expect(imported.json().evidence).toMatchObject({
      title: "Imported Claude Code transcript",
      metadata: expect.objectContaining({
        adapterId: "claude-code",
        externalSessionId,
        parserVersion: "claude-code-jsonl.v2",
        eventCount: 5,
        eventCounts: { message: 2, toolCall: 1, toolResult: 1, summary: 1 }
      })
    });
    await expect(readFile(join(tempDir, imported.json().evidence.storageRef), "utf8")).resolves.toBe(
      "SUMMARY:\nClaude session summary\n\nUSER:\npreserve the Claude decision\n\nASSISTANT:\nthe Claude decision is preserved\n\nTOOL CALL Read (tool_read):\n{\"file\":\"AGENT.md\"}\n\nTOOL RESULT (tool_read):\nrules loaded"
    );
    const refreshed = await server.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    expect(refreshed.json().externalSessionId).toBe(externalSessionId);
  });
});

async function createTestServer(): Promise<{ server: FastifyInstance; tempDir: string }> {
  process.env.CONTEXTOS_CODEX_COMMAND = process.execPath;
  process.env.CONTEXTOS_CODEX_ARGS = JSON.stringify(["-e", "console.log('transcript-import-base')"]);
  const tempDir = await mkdtemp(join(tmpdir(), "contextos-transcript-import-"));
  const server = await createDaemonServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      dataDir: tempDir,
      databaseFile: join(tempDir, "contextos.sqlite")
    }
  });
  cleanupTasks.push(async () => {
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  });
  return { server, tempDir };
}

async function createSession(server: FastifyInstance): Promise<{ project: { id: string }; session: { id: string; revision: number } }> {
  const projectResponse = await server.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "Transcript import", rootPath: "D:/project/ContextOS" }
  });
  expect(projectResponse.statusCode).toBe(201);
  const project = projectResponse.json();
  const sessionResponse = await server.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { projectId: project.id, agentAdapterId: "codex", title: "Import target", intent: "Preserve imported context" }
  });
  expect(sessionResponse.statusCode).toBe(201);
  return { project, session: sessionResponse.json() };
}

async function waitForSessionStatus(server: FastifyInstance, sessionId: string, status: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const response = await server.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    if (response.json().status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Session did not reach ${status}`);
}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
