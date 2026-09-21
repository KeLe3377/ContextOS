#!/usr/bin/env node
/**
 * 测试专用 Codex app-server 协议 stub。
 *
 * 只替代“外部 Codex 进程”这一个边界：通过 stdin/stdout 使用逐行 JSON-RPC 2.0，
 * 与真实 `codex app-server` 协议一致。ContextOS 内部链路（适配器、发现作业、
 * 会话绑定、tail、Evidence、压缩、提取、候选、审核、应用）全部走真实实现。
 *
 * 配置来自环境变量（由 e2e server 设置）：
 *   CODEX_STUB_THREAD_ID   线程 id，也是 rollout 里的 session id
 *   CODEX_STUB_CWD         线程工作目录（等于 fixture Project root）
 *   CODEX_STUB_PATH        rollout JSONL 绝对路径
 *   CODEX_STUB_UPDATED_AT  Unix 秒
 *
 * 约定：
 * - stdout 只输出 JSON-RPC；调试信息一律写 stderr；
 * - 未识别的 request 返回明确 JSON-RPC error，不静默成功。
 */

const config = {
  id: process.env.CODEX_STUB_THREAD_ID || "e2e-thread",
  cwd: process.env.CODEX_STUB_CWD || process.cwd(),
  path: process.env.CODEX_STUB_PATH || "",
  updatedAt: Number(process.env.CODEX_STUB_UPDATED_AT || Math.floor(Date.now() / 1000))
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function thread() {
  return {
    id: config.id,
    sessionId: config.id,
    cwd: config.cwd,
    path: config.path,
    name: "端到端受控线程",
    preview: "请说明当前工作进展。",
    updatedAt: config.updatedAt,
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
      case "thread/list":
        send({ jsonrpc: "2.0", id: message.id, result: { data: [thread()] } });
        break;
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
