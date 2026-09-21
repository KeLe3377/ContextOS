#!/usr/bin/env node
/**
 * 测试专用 Codex app-server 协议 stub。
 *
 * 只替代“外部 Codex 进程”这一个边界：通过 stdin/stdout 使用逐行 JSON-RPC 2.0，
 * 与真实 `codex app-server` 协议一致。ContextOS 内部链路（适配器、发现作业、
 * 会话绑定、tail、Evidence、Resume Capsule 连续性、Continue）全部走真实实现。
 *
 * 配置来自环境变量（由 e2e server 设置）：
 *   CODEX_STUB_THREADS  JSON 数组，每项 { id, cwd, path }。每个 fixture scope 一项，
 *                       使 desktop 与 mobile 各自拥有独立的 thread / rollout。
 *
 * 兼容旧配置：未提供 CODEX_STUB_THREADS 时回退到单个
 * CODEX_STUB_THREAD_ID / CODEX_STUB_CWD / CODEX_STUB_PATH。
 *
 * 约定：
 * - stdout 只输出 JSON-RPC；调试信息一律写 stderr；
 * - `thread/list` 按请求里的 cwd 精确过滤，避免一个 scope 的线程被另一个 scope 的
 *   Project 发现（查询父目录时返回空，而不是串味）；
 * - 未识别的 request 返回明确 JSON-RPC error，不静默成功。
 */

const threads = parseThreads();

function parseThreads() {
  const raw = process.env.CODEX_STUB_THREADS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((entry) => entry && typeof entry.id === "string" && typeof entry.cwd === "string")
          .map((entry) => ({ id: entry.id, cwd: entry.cwd, path: typeof entry.path === "string" ? entry.path : "" }));
      }
    } catch (error) {
      process.stderr.write(`stub: CODEX_STUB_THREADS is not valid JSON: ${error}\n`);
    }
  }
  return [{
    id: process.env.CODEX_STUB_THREAD_ID || "e2e-thread",
    cwd: process.env.CODEX_STUB_CWD || process.cwd(),
    path: process.env.CODEX_STUB_PATH || ""
  }];
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function thread(entry) {
  return {
    id: entry.id,
    sessionId: entry.id,
    cwd: entry.cwd,
    path: entry.path,
    name: "端到端受控线程",
    preview: "请说明当前工作进展。",
    updatedAt: Math.floor(Date.now() / 1000),
    status: "idle",
    source: "cli",
    turns: 2
  };
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write(`stub: ignoring malformed line: ${line}\n`);
      continue;
    }
    if (!message || typeof message !== "object") continue;

    // 通知（无 id）不需要响应。
    if (message.id === undefined) {
      process.stderr.write(`stub: notification ${message.method}\n`);
      continue;
    }

    process.stderr.write(`stub: request ${message.method} (id=${message.id})\n`);
    switch (message.method) {
      case "initialize":
        send({ jsonrpc: "2.0", id: message.id, result: { userAgent: "contextos-e2e-stub/0.1.0" } });
        break;
      case "thread/list": {
        const cwd = message.params && typeof message.params.cwd === "string" ? message.params.cwd : null;
        const matched = cwd ? threads.filter((entry) => entry.cwd === cwd) : threads;
        send({ jsonrpc: "2.0", id: message.id, result: { data: matched.map(thread) } });
        break;
      }
      default:
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `method not found: ${message.method}` }
        });
        break;
    }
  }
});

process.stdin.on("end", () => {
  process.stderr.write("stub: stdin closed, exiting\n");
  process.exit(0);
});
