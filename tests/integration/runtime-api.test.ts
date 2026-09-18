import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";
import { ClaudeCodeAdapter } from "../../packages/infrastructure/src/adapters/claude-code-adapter.js";
import { CodexAdapter } from "../../packages/infrastructure/src/adapters/codex-adapter.js";

let cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0).reverse()) await cleanup();
});

describe("runtime APIs", () => {
  test("returns settings and codex adapter status", async () => {
    const { server } = await createTestServer(["-e", ""]);

    const settings = await server.inject({ method: "GET", url: "/api/settings" });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().id).toBe("singleton");
    expect(settings.json().confirmDestructiveActions).toBe(true);

    const adapters = await server.inject({ method: "GET", url: "/api/agent-adapters" });
    expect(adapters.statusCode).toBe(200);
    expect(adapters.json().items[0].id).toBe("codex");
    expect(adapters.json().items[0].available).toBe(true);
    expect(adapters.json().items[0].capabilities).toContain("launch");
    expect(adapters.json().items[0].capabilities).toContain("resume");
    expect(adapters.json().items[0].capabilities).toContain("importTranscript");

    const unsupported = await server.inject({ method: "GET", url: "/api/agent-adapters/claude-code" });
    expect(unsupported.statusCode).toBe(200);
    expect(unsupported.json()).toMatchObject({
      id: "claude-code",
      available: false,
      error: "Unsupported adapter"
    });
  });

  test("lists Codex and Claude Code adapters when both are registered", async () => {
    const { server, tempDir } = await createTestServerWithAdapters((tempDir) => {
      const codexSessionsDir = join(tempDir, "codex-sessions");
      const claudeProjectsDir = join(tempDir, "claude-projects");
      return [
        new CodexAdapter(process.execPath, ["-e", ""], process.platform, codexSessionsDir),
        new ClaudeCodeAdapter(process.execPath, ["-e", ""], process.platform, claudeProjectsDir)
      ];
    });

    const adapters = await server.inject({ method: "GET", url: "/api/agent-adapters" });
    expect(adapters.statusCode).toBe(200);
    expect(adapters.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "codex", available: true }),
      expect.objectContaining({ id: "claude-code", available: true, capabilities: expect.arrayContaining(["launch", "resume", "importTranscript"]) })
    ]));

    const claude = await server.inject({ method: "GET", url: "/api/agent-adapters/claude-code" });
    expect(claude.statusCode).toBe(200);
    expect(claude.json()).toMatchObject({ id: "claude-code", available: true });
    expect(tempDir).toBeTruthy();
  });

  test("uses the selected adapter name in runtime evidence and resume summaries", async () => {
    const { server, tempDir } = await createTestServerWithAdapters((tempDir) => [
      new CodexAdapter(process.execPath, ["-e", ""], process.platform, join(tempDir, "codex-sessions")),
      new ClaudeCodeAdapter(process.execPath, ["-e", "console.log('claude-output')", "--"], process.platform, join(tempDir, "claude-projects"))
    ]);
    const projectResponse = await server.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Runtime Claude", rootPath: "D:/project/ContextOS", agentAdapterIds: ["codex", "claude-code"] }
    });
    expect(projectResponse.statusCode).toBe(201);
    const sessionResponse = await server.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: projectResponse.json().id, agentAdapterId: "claude-code", title: "Claude runtime", intent: "Exercise Claude lifecycle" }
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = sessionResponse.json();

    const continued = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: session.revision }
    });
    expect(continued.statusCode).toBe(200);
    expect(continued.json().adapter.id).toBe("claude-code");

    await waitForSessionStatus(server, session.id, "COMPLETED");
    const evidence = await server.inject({ method: "GET", url: `/api/sessions/${session.id}/evidence` });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceType: "AGENT_OUTPUT", title: "Claude Code process output" })
    ]));
    const resume = await server.inject({ method: "GET", url: `/api/sessions/${session.id}/resume-capsule` });
    expect(resume.statusCode).toBe(200);
    expect(resume.json()).toMatchObject({ status: "COMPLETED", summary: "Claude Code run completed." });
    expect(tempDir).toBeTruthy();
  });

  test("marks a short continue run completed after the process exits successfully", async () => {
    const { server } = await createTestServer(["-e", "console.log('phase-e-output')"]);
    const session = await createSession(server);

    const continued = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: session.revision }
    });
    expect(continued.statusCode).toBe(200);
    expect(continued.json().status).toBe("RUNNING");
    expect(continued.json().run.status).toBe("RUNNING");

    const completed = await waitForSessionStatus(server, session.id, "COMPLETED");
    expect(completed.status).toBe("COMPLETED");
    expect(completed.completedAt).toBeTruthy();

    const evidence = await server.inject({ method: "GET", url: `/api/sessions/${session.id}/evidence` });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceType: "AGENT_OUTPUT", title: "ContextOS handoff prompt" }),
      expect.objectContaining({ evidenceType: "AGENT_OUTPUT", title: "Codex process output" })
    ]));

    const resume = await server.inject({ method: "GET", url: `/api/sessions/${session.id}/resume-capsule` });
    expect(resume.statusCode).toBe(200);
    expect(resume.json()).toMatchObject({
      sessionId: session.id,
      status: "COMPLETED",
      summary: "Codex run completed.",
      nextAction: null,
      evidenceSnapshotIds: [evidence.json().items.find((item: { title: string }) => item.title === "Codex process output").id]
    });
  });

  test("marks a short continue run failed after the process exits non-zero", async () => {
    const { server } = await createTestServer(["-e", "process.exit(7)"]);
    const session = await createSession(server);

    const continued = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: session.revision }
    });
    expect(continued.statusCode).toBe(200);
    expect(continued.json().status).toBe("RUNNING");
    expect(continued.json().run.status).toBe("RUNNING");

    const failed = await waitForSessionStatus(server, session.id, "FAILED");
    expect(failed.status).toBe("FAILED");
    expect(failed.completedAt).toBeTruthy();

    const health = await server.inject({ method: "GET", url: "/api/runtime/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      jobs: {
        byStatus: expect.objectContaining({ FAILED: 1 }),
        latestFailed: [expect.objectContaining({ status: "FAILED", failureCode: "PROCESS_EXITED" })]
      },
      sessionRuns: {
        failed: 1,
        latestFailed: [expect.objectContaining({ sessionId: session.id, status: "FAILED", failureCode: "PROCESS_EXITED" })]
      }
    });

    const activity = await server.inject({ method: "GET", url: `/api/sessions/${session.id}/activity` });
    expect(activity.statusCode).toBe(200);
    expect(activity.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "ACTIVITY", eventType: "CONTINUE_FAILED", metadata: expect.objectContaining({ failureCode: "PROCESS_EXITED" }) }),
      expect.objectContaining({ kind: "AUDIT", eventType: "CONTINUE_FAILED", actorType: "SYSTEM" }),
      expect.objectContaining({ kind: "ACTIVITY", eventType: "CONTINUE_QUEUED" }),
      expect.objectContaining({ kind: "AUDIT", eventType: "CONTINUE_QUEUED", actorType: "SYSTEM" })
    ]));
  });

  test("automatically binds the Codex session created by the first launch", async () => {
    const externalSessionId = "codex-first-launch-bound";
    const { server, tempDir } = await createTestServer((tempDir) => {
      const sessionsDir = join(tempDir, "codex-sessions");
      const transcriptPath = join(sessionsDir, "rollout-first-launch-bound.jsonl");
      const script = [
        "const fs = require('node:fs')",
        "const path = require('node:path')",
        `const sessionsDir = ${JSON.stringify(sessionsDir)}`,
        `const transcriptPath = ${JSON.stringify(transcriptPath)}`,
        `const externalSessionId = ${JSON.stringify(externalSessionId)}`,
        "const prompt = fs.readFileSync(0, 'utf8')",
        "fs.mkdirSync(sessionsDir, { recursive: true })",
        "const rows = [",
        "  { type: 'session_meta', payload: { id: externalSessionId, cwd: 'D:/project/ContextOS' } },",
        "  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },",
        "  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'bound from first launch' }] } }",
        "]",
        "fs.writeFileSync(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\\n')}\\n`, 'utf8')",
        "console.log('first-launch-bound')"
      ].join("\n");
      return ["-e", script];
    });
    const session = await createSession(server);

    const continued = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: session.revision }
    });
    expect(continued.statusCode).toBe(200);
    expect(continued.json()).toMatchObject({
      launch: { operation: "launch", externalSessionId: null }
    });
    expect(continued.json().launch.args.at(-1)).toBe("-");
    await waitForSessionStatus(server, session.id, "COMPLETED");

    const refreshed = await server.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    expect(refreshed.json().externalSessionId).toBe(externalSessionId);

    const evidence = await server.inject({ method: "GET", url: `/api/sessions/${session.id}/evidence` });
    const importedTranscripts = evidence.json().items.filter((item: { metadata: { stream?: string } }) => item.metadata.stream === "imported-transcript");
    expect(importedTranscripts).toHaveLength(1);
    expect(importedTranscripts[0]).toMatchObject({
      title: "Codex transcript after launch",
      metadata: expect.objectContaining({
        externalSessionId,
        roleCounts: { user: 1, assistant: 1 },
        turnCount: 1,
        messageOrdinalStart: 1,
        messageOrdinalEnd: 2
      })
    });

    const completed = await server.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    const resumed = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: completed.json().revision }
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({
      launch: { operation: "resume", externalSessionId }
    });

    const db = new Database(join(tempDir, "contextos.sqlite"), { readonly: true });
    try {
      const failures = db.prepare("SELECT COUNT(*) AS count FROM activity_events WHERE resource_id = ? AND event_type = 'TRANSCRIPT_RECONCILE_FAILED'")
        .get(session.id) as { count: number };
      expect(failures.count).toBe(0);
    } finally {
      db.close();
    }
  });

  test("imports Codex transcript evidence while the managed run is still running", async () => {
    const externalSessionId = "codex-live-bridge";
    const { server } = await createTestServer((tempDir) => {
      const sessionsDir = join(tempDir, "codex-sessions");
      const transcriptPath = join(sessionsDir, "rollout-live-bridge.jsonl");
      const script = [
        "const fs = require('node:fs')",
        `const sessionsDir = ${JSON.stringify(sessionsDir)}`,
        `const transcriptPath = ${JSON.stringify(transcriptPath)}`,
        `const externalSessionId = ${JSON.stringify(externalSessionId)}`,
        "const prompt = fs.readFileSync(0, 'utf8')",
        "fs.mkdirSync(sessionsDir, { recursive: true })",
        "const rows = [",
        "  { type: 'session_meta', payload: { id: externalSessionId, cwd: 'D:/project/ContextOS' } },",
        "  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },",
        "  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'live bridge captured' }] } }",
        "]",
        "fs.writeFileSync(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\\n')}\\n`, 'utf8')",
        "setTimeout(() => process.exit(0), 1500)"
      ].join("\n");
      return ["-e", script];
    });
    const session = await createSession(server);

    const continued = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: session.revision }
    });
    expect(continued.statusCode).toBe(200);
    expect(continued.json().status).toBe("RUNNING");

    const liveEvidence = await waitForImportedTranscriptCount(server, session.id, 1);
    expect(liveEvidence[0]).toMatchObject({
      title: "Codex transcript during run",
      metadata: expect.objectContaining({
        externalSessionId,
        roleCounts: { user: 1, assistant: 1 }
      })
    });
    const liveSession = await server.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    expect(liveSession.json()).toMatchObject({
      status: "RUNNING",
      externalSessionId
    });

    await waitForSessionStatus(server, session.id, "COMPLETED");
    const finalEvidence = await getImportedTranscripts(server, session.id);
    expect(finalEvidence).toHaveLength(1);
  });

  test("resumes the bound Codex session with an incremental context prompt", async () => {
    const externalSessionId = "codex-resume-session";
    const projectRoot = "D:/project/ContextOS";
    const { server, tempDir } = await createTestServer(
      ["-e", "console.log(JSON.stringify(process.argv.slice(1)))"],
      async (tempDir) => {
        const sessionsDir = join(tempDir, "codex-sessions");
        await mkdir(sessionsDir, { recursive: true });
        const rows = [
          { type: "session_meta", payload: { id: externalSessionId, cwd: projectRoot } },
          { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "resume me" }] } },
          { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ready" }] } }
        ];
        await writeFile(join(sessionsDir, "rollout-resume.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
      }
    );
    const session = await createSession(server);
    const imported = await server.inject({ method: "POST", url: `/api/sessions/${session.id}/import-transcript/auto`, payload: {} });
    expect(imported.statusCode).toBe(201);

    const refreshed = await server.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    expect(refreshed.json().externalSessionId).toBe(externalSessionId);
    const continued = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: refreshed.json().revision }
    });
    expect(continued.statusCode).toBe(200);
    expect(continued.json()).toMatchObject({
      launch: { operation: "resume", externalSessionId },
      job: { payload: { launchInfo: { operation: "resume", externalSessionId } } }
    });
    expect(continued.json().launch.args).toEqual(expect.arrayContaining(["resume", externalSessionId]));
    expect(continued.json().launch.args.at(-1)).toBe("-");
    await waitForSessionStatus(server, session.id, "COMPLETED");
    const completed = await server.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    const resumedAgain = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: completed.json().revision }
    });
    expect(resumedAgain.statusCode).toBe(200);
    expect(resumedAgain.json()).toMatchObject({
      launch: { operation: "resume", externalSessionId },
      run: { sessionId: session.id }
    });
    expect(resumedAgain.json().run.id).not.toBe(continued.json().run.id);
    await waitForSessionStatus(server, session.id, "COMPLETED");

    const db = new Database(join(tempDir, "contextos.sqlite"), { readonly: true });
    try {
      const runs = db.prepare("SELECT id FROM session_runs WHERE session_id = ? ORDER BY created_at, id").all(session.id) as Array<{ id: string }>;
      expect(runs.map((run) => run.id)).toEqual(expect.arrayContaining([continued.json().run.id, resumedAgain.json().run.id]));
      expect(runs).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("automatically imports a changed bound Codex transcript after resume exits", async () => {
    const externalSessionId = "codex-post-run-changed";
    const projectRoot = "D:/project/ContextOS";
    let transcriptPath = "";
    const { server, tempDir } = await createTestServer(
      ["-e", "console.log('resume-finished')"],
      async (tempDir) => {
        const sessionsDir = join(tempDir, "codex-sessions");
        await mkdir(sessionsDir, { recursive: true });
        transcriptPath = join(sessionsDir, "rollout-post-run-changed.jsonl");
        await writeCodexTranscript(transcriptPath, externalSessionId, projectRoot, ["before resume"]);
      }
    );
    const session = await createSession(server);
    const imported = await server.inject({ method: "POST", url: `/api/sessions/${session.id}/import-transcript/auto`, payload: {} });
    expect(imported.statusCode).toBe(201);
    await appendCodexMessage(transcriptPath, "assistant", "after resume");

    const refreshed = await server.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    const continued = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: refreshed.json().revision }
    });
    expect(continued.statusCode).toBe(200);
    await waitForSessionStatus(server, session.id, "COMPLETED");

    const evidence = await server.inject({ method: "GET", url: `/api/sessions/${session.id}/evidence` });
    const importedTranscripts = evidence.json().items.filter((item: { metadata: { stream?: string } }) => item.metadata.stream === "imported-transcript");
    expect(importedTranscripts).toHaveLength(2);
    expect(importedTranscripts).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Codex transcript after run" })
    ]));

    const resume = await server.inject({ method: "GET", url: `/api/sessions/${session.id}/resume-capsule` });
    expect(resume.json()).toMatchObject({
      status: "COMPLETED",
      summary: "Codex run completed.",
      lastRunId: continued.json().run.id
    });
    expect(resume.json().evidenceSnapshotIds).toEqual(expect.arrayContaining(importedTranscripts.map((item: { id: string }) => item.id)));

    const db = new Database(join(tempDir, "contextos.sqlite"), { readonly: true });
    try {
      const activityCount = db.prepare("SELECT COUNT(*) AS count FROM activity_events WHERE resource_id = ? AND event_type = 'TRANSCRIPT_IMPORTED'")
        .get(session.id) as { count: number };
      expect(activityCount.count).toBe(2);
    } finally {
      db.close();
    }
  });

  test("reuses unchanged bound Codex transcript evidence after resume exits", async () => {
    const externalSessionId = "codex-post-run-unchanged";
    const projectRoot = "D:/project/ContextOS";
    const { server } = await createTestServer(
      ["-e", "console.log('resume-unchanged')"],
      async (tempDir) => {
        const sessionsDir = join(tempDir, "codex-sessions");
        await mkdir(sessionsDir, { recursive: true });
        await writeCodexTranscript(join(sessionsDir, "rollout-post-run-unchanged.jsonl"), externalSessionId, projectRoot, ["same transcript"]);
      }
    );
    const session = await createSession(server);
    const imported = await server.inject({ method: "POST", url: `/api/sessions/${session.id}/import-transcript/auto`, payload: {} });
    expect(imported.statusCode).toBe(201);

    const refreshed = await server.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    const continued = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: refreshed.json().revision }
    });
    expect(continued.statusCode).toBe(200);
    await waitForSessionStatus(server, session.id, "COMPLETED");

    const evidence = await server.inject({ method: "GET", url: `/api/sessions/${session.id}/evidence` });
    const importedTranscripts = evidence.json().items.filter((item: { metadata: { stream?: string } }) => item.metadata.stream === "imported-transcript");
    expect(importedTranscripts).toHaveLength(1);

    const resume = await server.inject({ method: "GET", url: `/api/sessions/${session.id}/resume-capsule` });
    expect(resume.json().evidenceSnapshotIds).toContain(imported.json().evidence.id);
    expect(resume.json()).toMatchObject({
      status: "COMPLETED",
      lastRunId: continued.json().run.id,
      summary: "Codex run completed."
    });
  });

  test("keeps completed lifecycle status when post-run transcript import fails", async () => {
    const externalSessionId = "codex-post-run-import-fails";
    const projectRoot = "D:/project/ContextOS";
    let transcriptPath = "";
    const { server, tempDir } = await createTestServer(
      ["-e", "console.log('resume-import-fails')"],
      async (tempDir) => {
        const sessionsDir = join(tempDir, "codex-sessions");
        await mkdir(sessionsDir, { recursive: true });
        transcriptPath = join(sessionsDir, "rollout-post-run-import-fails.jsonl");
        await writeCodexTranscript(transcriptPath, externalSessionId, projectRoot, ["initial transcript"]);
      }
    );
    const session = await createSession(server);
    const imported = await server.inject({ method: "POST", url: `/api/sessions/${session.id}/import-transcript/auto`, payload: {} });
    expect(imported.statusCode).toBe(201);
    await writeFile(transcriptPath, `${JSON.stringify({ type: "session_meta", payload: { id: externalSessionId, cwd: projectRoot } })}\n`, "utf8");

    const refreshed = await server.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    const continued = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: refreshed.json().revision }
    });
    expect(continued.statusCode).toBe(200);
    const completed = await waitForSessionStatus(server, session.id, "COMPLETED");
    expect(completed.status).toBe("COMPLETED");

    const latestStatus = await server.inject({ method: "GET", url: `/api/sessions/${session.id}/runtime-status` });
    expect(latestStatus.json()).toMatchObject({
      run: { id: continued.json().run.id, status: "SUCCEEDED" }
    });

    const db = new Database(join(tempDir, "contextos.sqlite"), { readonly: true });
    try {
      const activityCount = db.prepare("SELECT COUNT(*) AS count FROM activity_events WHERE resource_id = ? AND event_type = 'TRANSCRIPT_RECONCILE_FAILED'")
        .get(session.id) as { count: number };
      expect(activityCount.count).toBe(1);
    } finally {
      db.close();
    }
  });

  test("fails resume without launching a new session when the bound Codex session is missing", async () => {
    const externalSessionId = "codex-missing-resume-session";
    const projectRoot = "D:/project/ContextOS";
    let transcriptPath = "";
    const { server } = await createTestServer(
      ["-e", "process.exit(0)"],
      async (tempDir) => {
        const sessionsDir = join(tempDir, "codex-sessions");
        await mkdir(sessionsDir, { recursive: true });
        transcriptPath = join(sessionsDir, "rollout-missing-resume.jsonl");
        const rows = [
          { type: "session_meta", payload: { id: externalSessionId, cwd: projectRoot } },
          { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "bind me" }] } }
        ];
        await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
      }
    );
    const session = await createSession(server);
    const imported = await server.inject({ method: "POST", url: `/api/sessions/${session.id}/import-transcript/auto`, payload: {} });
    expect(imported.statusCode).toBe(201);
    await rm(transcriptPath, { force: true });

    const refreshed = await server.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    const continued = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: refreshed.json().revision }
    });
    expect(continued.statusCode).toBe(200);
    expect(continued.json()).toMatchObject({
      status: "FAILED",
      launch: { operation: "resume", externalSessionId },
      job: { status: "FAILED" },
      run: { status: "FAILED", failureCode: "RESUME_SESSION_NOT_FOUND" }
    });
    expect((continued.json().run as { pid: number | null }).pid).toBeNull();
  });

  test("inspects and interrupts a managed continue run without exit callback rollback", async () => {
    const { server, tempDir } = await createTestServer(["-e", "setInterval(() => {}, 1000)"]);
    const session = await createSession(server);

    const continued = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: session.revision }
    });
    expect(continued.statusCode).toBe(200);

    const refreshed = await server.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().status).toBe("RUNNING");

    const status = await server.inject({ method: "GET", url: `/api/sessions/${session.id}/runtime-status` });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      sessionId: session.id,
      adapterId: "codex",
      run: { status: "RUNNING" },
      process: { managed: true, running: true }
    });

    const interrupted = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/interrupt`,
      payload: { expectedRevision: refreshed.json().revision }
    });
    expect(interrupted.statusCode).toBe(200);
    expect(interrupted.json()).toMatchObject({
      status: "PAUSED",
      job: { status: "CANCELED" },
      run: { status: "CANCELED", failureCode: "INTERRUPTED" },
      process: { managed: true, running: false }
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterExit = await server.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    expect(afterExit.json().status).toBe("PAUSED");
    const stopped = await server.inject({ method: "GET", url: `/api/sessions/${session.id}/runtime-status` });
    expect(stopped.json()).toMatchObject({
      run: { status: "CANCELED", failureCode: "INTERRUPTED" },
      process: { running: false }
    });

    const repeated = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/interrupt`,
      payload: { expectedRevision: afterExit.json().revision }
    });
    expect(repeated.statusCode).toBe(409);

    const db = new Database(join(tempDir, "contextos.sqlite"), { readonly: true });
    try {
      const attempt = db.prepare("SELECT status, failure_code AS failureCode FROM job_attempts WHERE job_id = ? ORDER BY started_at DESC LIMIT 1")
        .get(interrupted.json().job.id);
      const activity = db.prepare("SELECT COUNT(*) AS count FROM activity_events WHERE resource_id = ? AND event_type = 'CONTINUE_INTERRUPTED'")
        .get(session.id) as { count: number };
      const audit = db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE resource_id = ? AND action = 'CONTINUE_INTERRUPTED'")
        .get(session.id) as { count: number };
      expect(attempt).toEqual({ status: "CANCELED", failureCode: "INTERRUPTED" });
      expect(activity.count).toBe(1);
      expect(audit.count).toBe(1);
    } finally {
      db.close();
    }
  });

  test("creates a context package when continuing a session", async () => {
    const { server, tempDir } = await createTestServer(["-e", ""]);
    const projectResponse = await server.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Runtime Context", rootPath: "D:/project/ContextOS" }
    });
    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.json();

    const snapshotResponse = await server.inject({
      method: "POST",
      url: "/api/evidence-snapshots",
      payload: {
        projectId: project.id,
        evidenceType: "TEXT",
        title: "Runtime evidence",
        contentText: "Context packages should preserve selected evidence."
      }
    });
    expect(snapshotResponse.statusCode).toBe(201);
    const snapshot = snapshotResponse.json();

    const itemResponse = await server.inject({
      method: "POST",
      url: "/api/context-items",
      payload: {
        projectId: project.id,
        sourceSnapshotId: snapshot.id,
        itemType: "SUMMARY",
        title: "Context package rule",
        summary: "Continue should record selected context.",
        confidence: "HIGH"
      }
    });
    expect(itemResponse.statusCode).toBe(201);
    const item = itemResponse.json();

    const activated = await server.inject({
      method: "POST",
      url: `/api/context-items/${item.id}/activate`,
      payload: { expectedRevision: item.revision }
    });
    expect(activated.statusCode).toBe(200);

    const sessionResponse = await server.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.id, agentAdapterId: "codex", title: "Runtime context", intent: "Use selected context" }
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = sessionResponse.json();

    const continued = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: { expectedRevision: session.revision }
    });
    expect(continued.statusCode).toBe(200);

    const db = new Database(join(tempDir, "contextos.sqlite"), { readonly: true });
    try {
      const outbox = db.prepare("SELECT topic, status, payload_json AS payloadJson FROM outbox_events ORDER BY created_at, id").all() as Array<{ topic: string; status: string; payloadJson: string }>;
      expect(outbox).toEqual([
        expect.objectContaining({ topic: "session.continue.queued", status: "PENDING" })
      ]);
      expect(JSON.parse(outbox[0].payloadJson)).toMatchObject({
        projectId: project.id,
        sessionId: session.id,
        adapterId: "codex"
      });
    } finally {
      db.close();
    }

    const contextPack = await server.inject({ method: "GET", url: `/api/sessions/${session.id}/context-pack` });
    expect(contextPack.statusCode).toBe(200);
    expect(contextPack.json().sessionId).toBe(session.id);
    expect(contextPack.json().purpose).toBe("Use selected context");
    expect(contextPack.json().contextItems).toEqual([
      expect.objectContaining({ id: item.id, title: "Context package rule", revision: activated.json().revision })
    ]);
    expect(contextPack.json().evidenceSnapshots).toEqual([
      expect.objectContaining({ id: snapshot.id, title: "Runtime evidence", contentHash: snapshot.contentHash })
    ]);
    expect(contextPack.json().manifest).toMatchObject({
      schemaVersion: "context-package.v1",
      generatedFor: "session-continue"
    });

    const evidence = await server.inject({ method: "GET", url: `/api/sessions/${session.id}/evidence` });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "ContextOS handoff prompt",
        metadata: expect.objectContaining({
          sessionId: session.id,
          contextPackageId: contextPack.json().id,
          stream: "contextos-handoff"
        })
      })
    ]));
  });
});

async function createTestServer(args: string[] | ((tempDir: string) => string[]), configure?: (tempDir: string) => Promise<void>): Promise<{ server: FastifyInstance; tempDir: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), "contextos-runtime-"));
  await configure?.(tempDir);
  const sessionsDir = join(tempDir, "codex-sessions");
  const launchArgs = Array.isArray(args) ? args : args(tempDir);
  const server = await createDaemonServer({
    agentAdapter: new CodexAdapter(process.execPath, launchArgs, process.platform, sessionsDir),
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

async function createTestServerWithAdapters(createAdapters: (tempDir: string) => [CodexAdapter, ClaudeCodeAdapter]): Promise<{ server: FastifyInstance; tempDir: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), "contextos-runtime-adapters-"));
  const server = await createDaemonServer({
    agentAdapters: createAdapters(tempDir),
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

async function createSession(server: FastifyInstance): Promise<{ id: string; revision: number }> {
  const projectResponse = await server.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "Runtime", rootPath: "D:/project/ContextOS" }
  });
  expect(projectResponse.statusCode).toBe(201);
  const project = projectResponse.json();

  const sessionResponse = await server.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { projectId: project.id, agentAdapterId: "codex", title: "Runtime continue", intent: "Exercise lifecycle" }
  });
  expect(sessionResponse.statusCode).toBe(201);
  return sessionResponse.json();
}

async function writeCodexTranscript(path: string, externalSessionId: string, cwd: string, messages: string[]): Promise<void> {
  const rows = [
    { type: "session_meta", payload: { id: externalSessionId, cwd } },
    ...messages.map((text, index) => ({
      type: "response_item",
      payload: {
        type: "message",
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: index % 2 === 0 ? "input_text" : "output_text", text }]
      }
    }))
  ];
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

async function appendCodexMessage(path: string, role: "user" | "assistant", text: string): Promise<void> {
  await appendFile(path, `${JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }]
    }
  })}\n`, "utf8");
}

async function waitForSessionStatus(server: FastifyInstance, sessionId: string, status: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2000;
  let latest: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const response = await server.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    expect(response.statusCode).toBe(200);
    latest = response.json() as Record<string, unknown>;
    if (latest.status === status) return latest;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Session did not reach ${status}; latest=${JSON.stringify(latest)}`);
}

async function waitForImportedTranscriptCount(server: FastifyInstance, sessionId: string, count: number): Promise<Array<{ id: string; title: string; metadata: Record<string, unknown> }>> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const imported = await getImportedTranscripts(server, sessionId);
    if (imported.length >= count) return imported;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Session did not import ${count} transcript evidence item(s)`);
}

async function getImportedTranscripts(server: FastifyInstance, sessionId: string): Promise<Array<{ id: string; title: string; metadata: Record<string, unknown> }>> {
  const evidence = await server.inject({ method: "GET", url: `/api/sessions/${sessionId}/evidence` });
  expect(evidence.statusCode).toBe(200);
  return evidence.json().items.filter((item: { metadata: { stream?: string } }) => item.metadata.stream === "imported-transcript");
}





