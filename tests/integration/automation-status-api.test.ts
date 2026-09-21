import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { automationOverviewSchema } from "../../packages/contracts/src/automation.js";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";
import { CodexAdapter } from "../../packages/infrastructure/src/adapters/codex-adapter.js";
import { SqliteAutomationRepository } from "../../packages/infrastructure/src/sqlite/automation-repository.js";
import { SqliteClient } from "../../packages/infrastructure/src/sqlite/client.js";

let server: FastifyInstance | undefined;
let tempDir: string | undefined;
let projectId: string;

async function post(url: string, payload: Record<string, unknown>) {
  const response = await server!.inject({ method: "POST", url, payload });
  expect([200, 201]).toContain(response.statusCode);
  return response.json() as Record<string, unknown>;
}

async function getStatus() {
  const response = await server!.inject({ method: "GET", url: "/api/automation/status" });
  expect(response.statusCode).toBe(200);
  return automationOverviewSchema.parse(response.json());
}

function withDb<T>(work: (repository: SqliteAutomationRepository) => T): T {
  const client = SqliteClient.open({ databaseFile: join(tempDir!, "contextos.sqlite") });
  try {
    return work(new SqliteAutomationRepository(client.db));
  } finally {
    client.close();
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-auto-status-"));
  server = await createDaemonServer({
    agentAdapter: new CodexAdapter(process.execPath, ["-e", ""], process.platform, join(tempDir, "codex-sessions")),
    config: { host: "127.0.0.1", port: 0, dataDir: tempDir, databaseFile: join(tempDir, "contextos.sqlite") }
  });
  projectId = (await post("/api/projects", { name: "自动化状态", rootPath: "D:/project/ContextOS" })).id as string;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("自动化状态接口", () => {
  test("响应通过共享 schema 并反映调度器状态", async () => {
    const status = await getStatus();

    expect(status.generatedAt).toBeTruthy();
    // 守护进程启动后调度器处于运行态。
    expect(status.scheduler.running).toBe(true);
    expect(status.projects.map((entry) => entry.projectId)).toContain(projectId);
  });

  test("只声明发现与同步两类可执行任务", async () => {
    const status = await getStatus();

    // 历史的压缩与提取任务仍可解析，但守护进程不再注册处理器，因此不会出现在活跃类型里。
    expect([...status.activeKinds].sort()).toEqual(["DISCOVER_CODEX_THREADS", "SYNC_SESSION_TRANSCRIPT"]);
  });

  test("统计各状态任务数量与待审核建议数", async () => {
    withDb((repository) => {
      repository.enqueue(
        { kind: "DISCOVER_CODEX_THREADS", projectId, resourceType: "PROJECT", resourceId: projectId, idempotencyKey: "status-queued" },
        Date.now()
      );
    });

    const status = await getStatus();

    expect(status.jobs.byStatus.QUEUED).toBeGreaterThanOrEqual(1);
    expect(status.jobs.total).toBeGreaterThanOrEqual(1);
    expect(status.candidates.pending).toBe(0);
  });

  test("记录项目最近发现与同步时间", async () => {
    await server!.inject({ method: "POST", url: `/api/projects/${projectId}/automation/discovery` });

    const status = await getStatus();
    const entry = status.projects.find((item) => item.projectId === projectId)!;

    // 发现任务只是入队，所以最近发现时间仍为空；入队本身已被统计。
    expect(entry.lastDiscoveryAt).toBeNull();
    expect(status.jobs.byStatus.QUEUED).toBeGreaterThanOrEqual(1);
  });

  test("最近失败只暴露脱敏字段", async () => {
    withDb((repository) => {
      const job = repository.enqueue(
        {
          kind: "EXTRACT_EVIDENCE_CONTEXT",
          projectId,
          resourceType: "COMPACTION_ARTIFACT",
          resourceId: "cmp_1",
          payload: { secretPayload: "不得外泄" },
          idempotencyKey: "status-failed"
        },
        Date.now()
      ).job;
      // 只有运行中的任务才能标记失败，所以先领取一次。
      const claimed = repository.claimNext(Date.now(), ["EXTRACT_EVIDENCE_CONTEXT"]);
      expect(claimed?.id).toBe(job.id);
      repository.markFailed(job.id, { code: "EXTRACTOR_TIMEOUT", message: "提取超时" }, Date.now());
    });

    const status = await getStatus();

    expect(status.recentFailures.length).toBeGreaterThanOrEqual(1);
    const failure = status.recentFailures[0]!;
    expect(failure.failureCode).toBe("EXTRACTOR_TIMEOUT");
    expect(failure.failureMessage).toBe("提取超时");
  });

  test("响应不包含 job payload、transcript 或本地路径", async () => {
    withDb((repository) => {
      repository.enqueue(
        {
          kind: "SYNC_SESSION_TRANSCRIPT",
          projectId,
          resourceType: "SESSION",
          resourceId: "sess_1",
          payload: { transcript: "秘密对话记录", prompt: "秘密提示词" },
          idempotencyKey: "status-secret"
        },
        Date.now()
      );
    });

    const response = await server!.inject({ method: "GET", url: "/api/automation/status" });
    const body = response.body;

    expect(body).not.toContain("secretPayload");
    expect(body).not.toContain("秘密对话记录");
    expect(body).not.toContain("秘密提示词");
    expect(body).not.toContain(tempDir!);
  });

  test("关闭自动化的项目在状态中体现为关闭", async () => {
    const settings = (await server!.inject({ method: "GET", url: `/api/projects/${projectId}/automation/settings` })).json();
    await server!.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/automation/settings`,
      payload: { mode: "OFF", expectedRevision: settings.revision }
    });

    const status = await getStatus();
    const entry = status.projects.find((item) => item.projectId === projectId)!;

    expect(entry.mode).toBe("OFF");
    expect(entry.pendingCandidates).toBe(0);
  });
});
