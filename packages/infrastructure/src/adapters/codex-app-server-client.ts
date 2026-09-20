import { spawn, type ChildProcess } from "node:child_process";

/**
 * Minimal read-only client for `codex app-server`.
 *
 * Everything here is read-only on purpose. `thread/list` and `thread/read`
 * never touch the single-writer lock, so this can run while Codex Desktop
 * holds a thread. Anything that loads a thread (`thread/resume`,
 * `thread/start`) would contend for that lock and is deliberately absent.
 *
 * Protocol: stdio, newline-delimited JSON-RPC 2.0. Handshake is
 * `initialize` followed by an `initialized` notification.
 */

export const DEFAULT_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "unknown"] as const;

export type CodexThreadStatus = "notLoaded" | "idle" | "active" | "systemError" | "unknown";

export type CodexAppServerThread = {
  id: string;
  sessionId: string | null;
  cwd: string | null;
  transcriptPath: string | null;
  preview: string | null;
  /** ISO 8601. Derived from the protocol's Unix *seconds* value. */
  updatedAt: string | null;
  updatedAtEpochSeconds: number | null;
  status: CodexThreadStatus;
  /**
   * Normalized source kind. The protocol returns either a bare string
   * ("vscode", "cli") or an object such as
   * `{"subAgent":{"other":"guardian"}}`; this is always the top-level kind.
   */
  source: string | null;
  turnCount: number | null;
};

export type CodexAppServerClientOptions = {
  command?: string;
  args?: string[];
  requestTimeoutMs?: number;
  /** Injectable for tests: same signature as child_process.spawn. */
  spawnFn?: (command: string, args: string[], options: { shell: boolean }) => ChildProcess;
};

/**
 * The protocol hands back two different shapes for the transcript path:
 * `C:\...` from `thread/list` and `\\?\C:\...` (Win32 extended-length
 * prefix) from `thread/read`. Without normalizing, the same file would be
 * recorded as two different transcripts.
 */
export function normalizeTranscriptPath(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value) return null;
  let path = value;
  if (path.startsWith("\\\\?\\UNC\\")) path = "\\\\" + path.slice(8);
  else if (path.startsWith("\\\\?\\")) path = path.slice(4);
  return path.replace(/[\\/]+$/, "") || path;
}

function normalizeStatus(value: unknown): CodexThreadStatus {
  if (typeof value === "string") {
    return value === "notLoaded" || value === "idle" || value === "active" || value === "systemError" ? value : "unknown";
  }
  if (value && typeof value === "object" && "type" in value) {
    const type = (value as { type?: unknown }).type;
    if (type === "notLoaded" || type === "idle" || type === "active" || type === "systemError") return type;
  }
  return "unknown";
}

function normalizeSource(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys[0] ?? null;
  }
  return null;
}

function toIso(epochSeconds: unknown): { iso: string | null; epoch: number | null } {
  if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds)) return { iso: null, epoch: null };
  return { iso: new Date(epochSeconds * 1000).toISOString(), epoch: epochSeconds };
}

export class CodexAppServerClient {
  private readonly command: string;
  private readonly args: string[];
  private readonly requestTimeoutMs: number;
  private readonly spawnFn: NonNullable<CodexAppServerClientOptions["spawnFn"]>;

  constructor(options: CodexAppServerClientOptions = {}) {
    this.command = options.command ?? "codex";
    this.args = options.args ?? ["app-server"];
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.spawnFn = options.spawnFn ?? ((command, args, opts) => spawn(command, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] }));
  }

  /**
   * Discover recent agent threads.
   *
   * `sourceKinds` must be passed explicitly: when omitted the protocol
   * defaults to interactive sources only, which silently hides most threads
   * (observed: 60 returned by default vs 80 with an explicit filter).
   */
  async listThreads(input: { cwd?: string; limit?: number; sourceKinds?: readonly string[] } = {}): Promise<CodexAppServerThread[]> {
    const params: Record<string, unknown> = {
      limit: Math.max(1, Math.min(input.limit ?? 50, 200)),
      sourceKinds: [...(input.sourceKinds ?? DEFAULT_SOURCE_KINDS)]
    };
    if (input.cwd) params.cwd = input.cwd;

    const response = await this.withSession((request) => request("thread/list", params));
    const items = (response as { data?: unknown[] } | null)?.data;
    if (!Array.isArray(items)) return [];

    return items.map((item) => toThread(item)).filter((thread): thread is CodexAppServerThread => thread !== null);
  }

  private async withSession<T>(run: (request: (method: string, params?: unknown) => Promise<unknown>) => Promise<T>): Promise<T> {
    const child = this.spawnFn(this.command, [...this.args], { shell: true });
    let buffer = "";
    let nextId = 1;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      for (const entry of pending.values()) entry.reject(new Error("codex app-server session closed"));
      pending.clear();
      try { child.stdin?.end(); } catch { /* already gone */ }
      try { child.kill(); } catch { /* already gone */ }
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line) continue;
        let message: { id?: number; result?: unknown; error?: unknown };
        try { message = JSON.parse(line) as typeof message; } catch { continue; }
        if (typeof message.id === "number" && pending.has(message.id)) {
          const entry = pending.get(message.id)!;
          pending.delete(message.id);
          if (message.error) entry.reject(new Error(`codex app-server error: ${JSON.stringify(message.error)}`));
          else entry.resolve(message.result);
        }
      }
    });

    const request = (method: string, params?: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`codex app-server timed out waiting for ${method}`));
        }, this.requestTimeoutMs);
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); }
        });
        try {
          child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error("failed to write to codex app-server"));
        }
      });

    try {
      await request("initialize", { clientInfo: { name: "contextos", version: "0.1.0" } });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
      const result = await run(request);
      return result;
    } finally {
      cleanup();
    }
  }
}

/**
 * `thread/list` returns `turns` as an empty array for threads that are not
 * loaded, which reads as "zero turns" but really means "unknown". Reporting
 * null here avoids showing a misleading 0 in the UI; a real count needs
 * `thread/read`.
 */
function readTurnCount(turns: unknown, status: CodexThreadStatus): number | null {
  if (typeof turns === "number") return turns;
  if (Array.isArray(turns)) return status === "notLoaded" ? null : turns.length;
  return null;
}

function toThread(value: unknown): CodexAppServerThread | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : null;
  if (!id) return null;

  const { iso, epoch } = toIso(row.updatedAt);
  return {
    id,
    sessionId: typeof row.sessionId === "string" ? row.sessionId : null,
    cwd: typeof row.cwd === "string" ? row.cwd : null,
    transcriptPath: normalizeTranscriptPath(typeof row.path === "string" ? row.path : null),
    preview: typeof row.preview === "string" ? row.preview : null,
    updatedAt: iso,
    updatedAtEpochSeconds: epoch,
    status: normalizeStatus(row.status),
    source: normalizeSource(row.source),
    turnCount: readTurnCount(row.turns, normalizeStatus(row.status))
  };
}
