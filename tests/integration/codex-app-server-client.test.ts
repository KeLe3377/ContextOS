import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  CodexAppServerClient,
  normalizeTranscriptPath,
  type CodexAppServerThread
} from "../../packages/infrastructure/src/adapters/codex-app-server-client.js";

type RecordedRequest = { id: number; method: string; params?: unknown };

function fakeSpawn(handler: (method: string, params: unknown) => unknown) {
  const requests: RecordedRequest[] = [];
  const spawnFn = (): never => {
    throw new Error("unused");
  };
  const create = (): unknown => {
    const stdout = new EventEmitter();
    const stdin = {
      write: (chunk: string) => {
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line) as RecordedRequest & { method?: string };
          if (typeof parsed.id === "number" && parsed.method) {
            requests.push({ id: parsed.id, method: parsed.method, params: parsed.params });
            const result = handler(parsed.method, parsed.params);
            setImmediate(() => stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result })}\n`));
          }
        }
        return true;
      },
      end: () => undefined
    };
    return {
      stdin,
      stdout,
      kill: () => undefined,
      on: () => undefined,
      once: () => undefined
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { spawnFn: create as any, requests, unused: spawnFn };
}

function clientFor(handler: (method: string, params: unknown) => unknown) {
  const fake = fakeSpawn(handler);
  const client = new CodexAppServerClient({ spawnFn: fake.spawnFn, requestTimeoutMs: 2_000 });
  return { client, requests: fake.requests };
}

describe("normalizeTranscriptPath", () => {
  it("strips the Win32 extended-length prefix", () => {
    expect(normalizeTranscriptPath("\\\\?\\C:\\Users\\a\\rollout.jsonl")).toBe("C:\\Users\\a\\rollout.jsonl");
    expect(normalizeTranscriptPath("C:\\Users\\a\\rollout.jsonl")).toBe("C:\\Users\\a\\rollout.jsonl");
  });

  it("restores UNC paths from the \\\\?\\UNC\\ form", () => {
    expect(normalizeTranscriptPath("\\\\?\\UNC\\srv\\share\\r.jsonl")).toBe("\\\\srv\\share\\r.jsonl");
  });

  it("returns null for missing values", () => {
    expect(normalizeTranscriptPath(null)).toBeNull();
    expect(normalizeTranscriptPath(undefined)).toBeNull();
    expect(normalizeTranscriptPath("")).toBeNull();
  });
});

describe("CodexAppServerClient.listThreads", () => {
  it("sends an explicit sourceKinds filter so non-interactive threads are not hidden", async () => {
    const { client, requests } = clientFor((method) =>
      method === "initialize" ? { userAgent: "fake" } : { data: [] }
    );
    await client.listThreads({ cwd: "D:\\project", limit: 10 });

    const list = requests.find((entry) => entry.method === "thread/list");
    expect(list).toBeDefined();
    const params = list!.params as { cwd?: string; limit?: number; sourceKinds?: string[] };
    expect(params.cwd).toBe("D:\\project");
    expect(params.limit).toBe(10);
    // Default behaviour hides most threads; the filter must always be present.
    expect(Array.isArray(params.sourceKinds)).toBe(true);
    expect(params.sourceKinds!.length).toBeGreaterThan(0);
    expect(params.sourceKinds).not.toContain("subAgent");
  });

  it("normalizes path, status, source and timestamp shapes", async () => {
    const { client } = clientFor((method) => {
      if (method === "initialize") return { userAgent: "fake" };
      return {
        data: [
          {
            id: "01a0bc62",
            sessionId: "01a0bc62",
            cwd: "D:\\project",
            path: "\\\\?\\C:\\Users\\a\\rollout.jsonl",
            preview: "hello",
            updatedAt: 1_789_866_935,
            status: { type: "idle" },
            source: "vscode",
            turns: 4
          },
          {
            id: "01a0other",
            cwd: "D:\\project",
            path: "C:\\Users\\a\\other.jsonl",
            updatedAt: 1_789_866_000,
            status: "notLoaded",
            source: { subAgent: { other: "guardian" } },
            turns: []
          }
        ]
      };
    });

    const threads = await client.listThreads({});
    expect(threads).toHaveLength(2);

    const first = threads[0] as CodexAppServerThread;
    expect(first.transcriptPath).toBe("C:\\Users\\a\\rollout.jsonl");
    expect(first.status).toBe("idle");
    expect(first.source).toBe("vscode");
    expect(first.updatedAt).toBe(new Date(1_789_866_935 * 1000).toISOString());
    expect(first.updatedAtEpochSeconds).toBe(1_789_866_935);
    expect(first.turnCount).toBe(4);

    const second = threads[1] as CodexAppServerThread;
    expect(second.source).toBe("subAgent");
    expect(second.status).toBe("notLoaded");
    // An empty `turns` array on a notLoaded thread means "unknown", not zero.
    expect(second.turnCount).toBeNull();
  });

  it("reports a real turn count once a thread is loaded", async () => {
    const { client } = clientFor((method) =>
      method === "initialize"
        ? { userAgent: "fake" }
        : { data: [{ id: "loaded", status: { type: "idle" }, source: "vscode", turns: [1, 2, 3] }] }
    );
    const threads = await client.listThreads({});
    expect(threads[0]!.turnCount).toBe(3);
  });

  it("drops rows without an id", async () => {
    const { client } = clientFor((method) =>
      method === "initialize"
        ? { userAgent: "fake" }
        : { data: [{ cwd: "D:\\project" }, { id: "keep", path: "C:\\a.jsonl" }] }
    );
    const threads = await client.listThreads({});
    expect(threads).toHaveLength(1);
    expect(threads[0]!.id).toBe("keep");
  });

  it("returns an empty list when the payload has no data array", async () => {
    const { client } = clientFor((method) => (method === "initialize" ? { userAgent: "fake" } : {}));
    await expect(client.listThreads({})).resolves.toEqual([]);
  });

  it("rejects when the server returns an error instead of throwing later", async () => {
    const { client } = clientFor(() => {
      throw new Error("unused");
    });
    const stdout = new EventEmitter();
    const broken = new CodexAppServerClient({
      requestTimeoutMs: 500,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnFn: (() => ({ stdin: { write: () => true, end: () => undefined }, stdout, kill: () => undefined })) as any
    });
    setImmediate(() => stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "boom" } })}\n`));
    await expect(broken.listThreads({})).rejects.toThrow(/boom/);
    expect(client).toBeInstanceOf(CodexAppServerClient);
  });
});
