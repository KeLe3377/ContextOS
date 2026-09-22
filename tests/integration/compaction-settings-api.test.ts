import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDaemonServer } from "../../apps/daemon/src/bootstrap.js";

const JEV_KEY = "apikey_test_jev_ABCD1234";
const LLM_KEY = "vck_test_llm_WXYZ9876";

let server: FastifyInstance | undefined;
let tempDir: string | undefined;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-compaction-settings-"));
  // The settings service resolves keys from the environment by name; clear them so the test is
  // deterministic regardless of the developer's shell.
  for (const name of ["TYPESAFE_API_KEY", "TEXT_MODEL_API_KEY"]) {
    originalEnv[name] = process.env[name];
    delete process.env[name];
  }
  server = await createDaemonServer({
    config: { host: "127.0.0.1", port: 0, dataDir: tempDir, databaseFile: join(tempDir, "contextos.sqlite") }
  });
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
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function getSettings() {
  const response = await server!.inject({ method: "GET", url: "/api/settings" });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function patchSettings(payload: Record<string, unknown>) {
  const current = await getSettings();
  return server!.inject({
    method: "PATCH",
    url: "/api/settings",
    payload: { ...payload, expectedRevision: current.revision }
  });
}

describe("semantic compaction settings", () => {
  test("默认返回非密钥配置视图（Jev endpoint/model 默认值，未配置密钥）", async () => {
    const settings = await getSettings();
    expect(settings.compactionConfig.apiCompactionEnabled).toBe(false);
    expect(settings.compactionConfig.jev.endpoint).toBe("https://api.typesafe.ai/v1/systemone");
    expect(settings.compactionConfig.jev.model).toBe("jev-latest");
    expect(settings.compactionConfig.jev.keyConfigured).toBe(false);
    expect(settings.compactionConfig.llm.keyConfigured).toBe(false);
  });

  test("提交密钥后只回显掩码，响应体不含完整密钥", async () => {
    const response = await patchSettings({
      compactionConfig: {
        apiCompactionEnabled: true,
        jev: { enabled: true, apiKey: JEV_KEY },
        llm: { enabled: true, apiKey: LLM_KEY }
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).not.toContain(JEV_KEY);
    expect(body).not.toContain(LLM_KEY);
    const config = response.json().compactionConfig;
    expect(config.apiCompactionEnabled).toBe(true);
    expect(config.jev.keyConfigured).toBe(true);
    expect(config.jev.keyHint).toBe("1234");
    expect(config.llm.keyConfigured).toBe(true);
    expect(config.llm.keyHint).toBe("9876");

    // GET must never echo the key either.
    const settings = await getSettings();
    expect(JSON.stringify(settings)).not.toContain(JEV_KEY);
    expect(JSON.stringify(settings)).not.toContain(LLM_KEY);
    expect(settings.compactionConfig.jev.keyHint).toBe("1234");
  });

  test("密钥写入本地 gitignored 文件，绝不进入数据库", async () => {
    await patchSettings({ compactionConfig: { jev: { apiKey: JEV_KEY }, llm: { apiKey: LLM_KEY } } });
    const secretFile = join(tempDir!, "compaction-secrets.json");
    expect(existsSync(secretFile)).toBe(true);
    expect(await readFile(secretFile, "utf8")).toContain(JEV_KEY);

    // The settings row lives in the SQLite file; the key must not appear anywhere in it.
    const db = await readFile(join(tempDir!, "contextos.sqlite"));
    expect(db.includes(Buffer.from(JEV_KEY))).toBe(false);
    expect(db.includes(Buffer.from(LLM_KEY))).toBe(false);
  });

  test("endpoint/model/预算等非密钥配置可持久化", async () => {
    await patchSettings({
      compactionConfig: { jev: { endpoint: "https://example.test/jev", model: "jev-x" }, keepThreshold: 0.7, outputTokenBudget: 2_000 }
    });
    const settings = await getSettings();
    expect(settings.compactionConfig.jev.endpoint).toBe("https://example.test/jev");
    expect(settings.compactionConfig.jev.model).toBe("jev-x");
    expect(settings.compactionConfig.keepThreshold).toBe(0.7);
    expect(settings.compactionConfig.outputTokenBudget).toBe(2_000);
  });

  test("apiKey: null 清除密钥且掩码归零", async () => {
    await patchSettings({ compactionConfig: { jev: { apiKey: JEV_KEY } } });
    expect((await getSettings()).compactionConfig.jev.keyConfigured).toBe(true);

    const cleared = await patchSettings({ compactionConfig: { jev: { apiKey: null } } });
    expect(cleared.json().compactionConfig.jev.keyConfigured).toBe(false);
    expect(cleared.json().compactionConfig.jev.keyHint).toBe(null);
    expect(cleared.body).not.toContain(JEV_KEY);
  });

  test("非法补丁被拒绝（未知字段/越界阈值）", async () => {
    const bad = await patchSettings({ compactionConfig: { keepThreshold: 5 } });
    expect(bad.statusCode).toBe(400);
  });
});
