import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * 自动化 fixture 路由的集成测试。
 *
 * fixture 路由只允许存在于 `scripts/start-e2e-server.ts` 且仅在显式开启时出现；
 * 未开启时必须 404，绝不进入生产路由。这里通过真实启动 e2e server 验证这一点。
 */

type ServerHandle = { process: ChildProcess; baseUrl: string };

async function startE2eServer(env: Record<string, string>, port = 4722): Promise<ServerHandle> {
  // Windows 上 npx 是 npx.cmd，直接 spawn("npx") 会 ENOENT。
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  // Windows 上 .cmd 启动器需要 shell；这里只是启动测试用服务器，不参与产品行为。
  const child = spawn(npx, ["tsx", "scripts/start-e2e-server.ts"], {
    env: { ...process.env, ...env, CONTEXTOS_E2E_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  child.stderr?.on("data", () => undefined);
  child.stdout?.on("data", () => undefined);

  const deadline = Date.now() + 60_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return { process: child, baseUrl: `http://127.0.0.1:${port}` };
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  child.kill();
  throw new Error(`e2e server did not become healthy: ${String(lastError)}`);
}

async function stop(handle: ServerHandle): Promise<void> {
  handle.process.kill("SIGTERM");
  // 必须等端口真正释放，否则下一个 server 会连到旧实例上（fixture 路由仍然存在）。
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${handle.baseUrl}/api/health`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    } catch {
      return;
    }
  }
  handle.process.kill("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function post(baseUrl: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const text = await response.text();
  return { status: response.status, text, json: safeJson(text) };
}

function safeJson(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe("自动化 fixture 路由（已启用）", () => {
  let handle: ServerHandle | undefined;

  beforeAll(async () => {
    handle = await startE2eServer({ CONTEXTOS_E2E_AUTOMATION_FIXTURE: "1" }, 4724);
  });

  // 停止服务器需要等端口释放，默认 10s 钩子超时不够。
  afterAll(async () => {
    if (handle) await stop(handle);
  }, 60_000);

  test("prepare 返回项目根目录与外部会话 id", async () => {
    const response = await post(handle!.baseUrl, "/__e2e/automation-fixture/prepare");
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ ready: true, externalSessionId: expect.any(String) });
    expect(String(response.json?.projectRoot)).toContain("fixture-project");
  });

  test("append 两次内容不同且文件只追加不覆盖", async () => {
    await post(handle!.baseUrl, "/__e2e/automation-fixture/prepare");
    const first = await post(handle!.baseUrl, "/__e2e/automation-fixture/append");
    const second = await post(handle!.baseUrl, "/__e2e/automation-fixture/append");

    expect(first.json).toMatchObject({ batch: expect.any(Number), events: 2 });
    expect(second.json).toMatchObject({ batch: expect.any(Number), events: 2 });
    // 批次号递增，文件大小单调增长 —— 证明是追加而不是覆盖。
    expect(Number(second.json?.batch)).toBeGreaterThan(Number(first.json?.batch));
    expect(Number(second.json?.sizeBytes)).toBeGreaterThan(Number(first.json?.sizeBytes));
  });

  test("响应不泄露 rollout 路径或正文", async () => {
    const response = await post(handle!.baseUrl, "/__e2e/automation-fixture/append");
    const body = response.text;
    expect(body).not.toContain("rollout");
    expect(body).not.toContain("第 ");
    expect(body).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(Object.keys(response.json ?? {})).toEqual(["batch", "events", "sizeBytes"]);
  });
});

describe("自动化 fixture 路由（未启用）", () => {
  let handle: ServerHandle | undefined;

  beforeAll(async () => {
    handle = await startE2eServer({ CONTEXTOS_E2E_AUTOMATION_FIXTURE: "0" }, 4725);
  });

  // 停止服务器需要等端口释放，默认 10s 钩子超时不够。
  afterAll(async () => {
    if (handle) await stop(handle);
  }, 60_000);

  test("未开启 fixture 时路由不存在", async () => {
    const prepare = await post(handle!.baseUrl, "/__e2e/automation-fixture/prepare");
    const append = await post(handle!.baseUrl, "/__e2e/automation-fixture/append");
    expect(prepare.status).toBe(404);
    expect(append.status).toBe(404);
  });

  test("生产路由仍然正常工作", async () => {
    const response = await fetch(`${handle!.baseUrl}/api/automation/status`);
    expect(response.status).toBe(200);
  });
});
