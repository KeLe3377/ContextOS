import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentAdapter, AgentLaunchInput, AgentLaunchResult, AgentResumeInput, AgentTranscriptImportResult } from "../../../application/src/ports/agent-adapter.js";
import type { AgentAdapterStatusDto, AgentLaunchInfoDto } from "../../../contracts/src/runtime.js";
import { ContextOsError } from "../../../shared/src/errors.js";
import type { ProcessExitInfo, ProcessSupervisor, SupervisedProcessStatus } from "../process-supervisor.js";

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";
  readonly displayName = "Codex";
  private readonly command: string;
  private readonly launchArgs: string[];
  private readonly platform: NodeJS.Platform;
  private readonly sessionsDir: string;

  constructor(
    command = process.env.CONTEXTOS_CODEX_COMMAND ?? defaultCodexCommand(),
    launchArgs = defaultCodexLaunchArgs(),
    platform = process.platform,
    sessionsDir = defaultCodexSessionsDir()
  ) {
    this.command = command;
    this.launchArgs = launchArgs;
    this.platform = platform;
    this.sessionsDir = sessionsDir;
  }

  discover(): AgentAdapterStatusDto {
    const processCommand = resolveProcessCommand(this.command, ["--version"], this.platform);
    const result = spawnSync(processCommand.command, processCommand.args, {
      encoding: "utf8",
      shell: false,
      timeout: 1500,
      windowsHide: true
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    return {
      id: this.id,
      displayName: this.displayName,
      available: !result.error && result.status === 0,
      command: this.command,
      version: !result.error && result.status === 0 ? output || null : null,
      error: result.error ? result.error.message : result.status === 0 ? null : output || `Exited with status ${result.status}`,
      capabilities: ["discover", "launch", "resume", "inspectStatus", "interrupt", "importTranscript"]
    };
  }

  buildLaunchInfo(input: { cwd: string; prompt?: string }): AgentLaunchInfoDto {
    return {
      adapterId: this.id,
      command: this.command,
      args: input.prompt ? [...this.launchArgs, "-"] : this.launchArgs,
      cwd: input.cwd,
      mode: "queued-job",
      operation: "launch",
      externalSessionId: null
    };
  }

  buildResumeInfo(input: { cwd: string; externalSessionId: string; prompt: string }): AgentLaunchInfoDto {
    return {
      adapterId: this.id,
      command: this.command,
      args: [...this.launchArgs, "resume", input.externalSessionId, "-"],
      cwd: input.cwd,
      mode: "queued-job",
      operation: "resume",
      externalSessionId: input.externalSessionId
    };
  }

  launch(input: AgentLaunchInput): AgentLaunchResult {
    const launch = this.buildLaunchInfo(input);
    return this.start(launch, input.supervisor, input.onExit, input.prompt);
  }

  resume(input: AgentResumeInput): AgentLaunchResult {
    this.assertResumeTarget(input.cwd, input.externalSessionId);
    const launch = this.buildResumeInfo(input);
    return this.start(launch, input.supervisor, input.onExit, input.prompt);
  }

  private start(launch: AgentLaunchInfoDto, supervisor: ProcessSupervisor, onExit?: (exit: ProcessExitInfo) => void, stdinText?: string): AgentLaunchResult {
    const processCommand = resolveProcessCommand(launch.command, launch.args, this.platform);
    const process = supervisor.launch({ command: processCommand.command, args: processCommand.args, cwd: launch.cwd, captureOutput: true, stdinText, onExit });
    return { pid: process.pid, launch };
  }

  private assertResumeTarget(cwd: string, externalSessionId: string): void {
    const matches = listJsonlFiles(this.sessionsDir)
      .map((path) => readSessionMetadata(path))
      .filter((metadata): metadata is CodexSessionMetadata => metadata?.id === externalSessionId);
    if (matches.length === 0) {
      throw new ContextOsError("NOT_FOUND", "Codex session to resume was not found", { externalSessionId });
    }
    if (!matches.some((metadata) => isPathWithin(cwd, metadata.cwd))) {
      throw new ContextOsError("CONFLICT", "Codex session to resume belongs to a different Project", { externalSessionId });
    }
  }

  inspectStatus(input: { pid: number; supervisor: ProcessSupervisor }): SupervisedProcessStatus {
    return input.supervisor.inspect(input.pid);
  }

  interrupt(input: { pid: number; supervisor: ProcessSupervisor }): boolean {
    return input.supervisor.interrupt(input.pid, this.platform);
  }

  importTranscript(input: { cwd: string; externalSessionId?: string; correlationText?: string }): AgentTranscriptImportResult {
    const candidates = listJsonlFiles(this.sessionsDir)
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    const matches: AgentTranscriptImportResult[] = [];
    for (const path of candidates) {
      const metadata = readSessionMetadata(path);
      if (!metadata || !isPathWithin(input.cwd, metadata.cwd)) continue;
      if (input.externalSessionId && metadata.id !== input.externalSessionId) continue;
      const transcript = parseCodexTranscript(path, metadata.id);
      if (input.correlationText && !transcript.contentText.includes(input.correlationText)) continue;
      if (!input.correlationText) return transcript;
      matches.push(transcript);
    }
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new ContextOsError("CONFLICT", "Multiple Codex transcripts matched the launch correlation marker", {
        correlationText: input.correlationText
      });
    }
    throw new ContextOsError("NOT_FOUND", input.externalSessionId
      ? "Codex transcript was not found for this Project and external session"
      : "No Codex transcript was found for this Project");
  }
}

export function defaultCodexSessionsDir(): string {
  if (process.env.CONTEXTOS_CODEX_SESSIONS_DIR) return process.env.CONTEXTOS_CODEX_SESSIONS_DIR;
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(codexHome, "sessions");
}

type CodexSessionMetadata = { id: string; cwd: string };
type CodexTranscriptMessage = { role: "user" | "assistant"; text: string; ordinal: number };

function readSessionMetadata(path: string): CodexSessionMetadata | null {
  const line = readFirstLine(path);
  if (!line) return null;
  try {
    const row = JSON.parse(line) as { type?: string; payload?: { id?: string; session_id?: string; cwd?: string } };
    const id = row.payload?.id ?? row.payload?.session_id;
    return row.type === "session_meta" && id && row.payload?.cwd ? { id, cwd: row.payload.cwd } : null;
  } catch {
    return null;
  }
}

function parseCodexTranscript(path: string, externalSessionId: string): AgentTranscriptImportResult {
  const file = statSync(path);
  if (file.size > 50 * 1024 * 1024) {
    throw new ContextOsError("INVALID_ARGUMENT", "Codex transcript exceeds the 50 MB import limit", { externalSessionId });
  }
  const messages: CodexTranscriptMessage[] = [];
  let ordinal = 0;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as {
        type?: string;
        payload?: { type?: string; role?: string; content?: Array<{ type?: string; text?: string }> };
      };
      const payload = row.payload;
      if (row.type !== "response_item" || payload?.type !== "message" || !["user", "assistant"].includes(payload.role ?? "")) continue;
      ordinal += 1;
      const text = (payload.content ?? [])
        .filter((item) => item.type === "input_text" || item.type === "output_text")
        .map((item) => item.text ?? "")
        .join("\n")
        .trim();
      if (text) messages.push({ role: payload.role as "user" | "assistant", text, ordinal });
    } catch {
      // A crash can leave one partial JSONL record; valid records remain importable.
    }
  }
  if (messages.length === 0) {
    throw new ContextOsError("INVALID_ARGUMENT", "Codex transcript contains no user or assistant messages", { externalSessionId });
  }

  const separator = "\n\n";
  const selected: string[] = [];
  let length = 0;
  let oversizedMessageTruncated = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const formatted = formatTranscriptMessage(message);
    const addedLength = formatted.length + (selected.length ? separator.length : 0);
    if (length + addedLength > 1_000_000) break;
    selected.unshift(formatted);
    length += addedLength;
  }
  if (selected.length === 0) {
    const latest = messages.at(-1)!;
    selected.push(formatTranscriptMessage({ ...latest, text: latest.text.slice(-1_000_000) }));
    oversizedMessageTruncated = true;
  }
  const selectedMessages = oversizedMessageTruncated
    ? [messages.at(-1)!]
    : messages.slice(messages.length - selected.length);
  const roleCounts = selectedMessages.reduce((counts, message) => {
    counts[message.role] += 1;
    return counts;
  }, { user: 0, assistant: 0 });
  return {
    externalSessionId,
    contentText: selected.join(separator),
    sourceUpdatedAt: file.mtime.toISOString(),
    parserVersion: "codex-jsonl.v1",
    messageCount: selected.length,
    roleCounts,
    turnCount: roleCounts.user,
    messageOrdinalStart: selectedMessages[0]!.ordinal,
    messageOrdinalEnd: selectedMessages.at(-1)!.ordinal,
    truncated: oversizedMessageTruncated || selected.length < messages.length
  };
}

function formatTranscriptMessage(message: Pick<CodexTranscriptMessage, "role" | "text">): string {
  return `${message.role.toUpperCase()}:\n${message.text}`;
}

function listJsonlFiles(root: string): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return listJsonlFiles(path);
    return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
  });
}

function readFirstLine(path: string): string | null {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < 1024 * 1024) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, 1024 * 1024 - total));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(10);
      chunks.push(newline >= 0 ? chunk.subarray(0, newline) : chunk);
      total += newline >= 0 ? newline : bytesRead;
      if (newline >= 0) break;
    }
    return chunks.length ? Buffer.concat(chunks).toString("utf8").replace(/\r$/, "") : null;
  } finally {
    closeSync(fd);
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  try {
    const relativePath = relative(realpathSync(resolve(root)), realpathSync(resolve(candidate)));
    return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
  } catch {
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function defaultCodexCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "codex.cmd" : "codex";
}

export function defaultCodexLaunchArgs(value = process.env.CONTEXTOS_CODEX_ARGS): string[] {
  return value === undefined ? ["exec"] : parseArgs(value);
}

export function shouldLaunchWithShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

export function resolveProcessCommand(command: string, args: string[], platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (!shouldLaunchWithShell(command, platform)) return { command, args };
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", [command, ...args].map(quoteWindowsCmdArg).join(" ")]
  };
}

function quoteWindowsCmdArg(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/.test(value)) return value;
  return `"${value.replace(/(["^&|<>])/g, "^$1")}"`;
}

function parseArgs(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // Fall through to whitespace splitting for local developer convenience.
  }
  return value.split(" ").map((part) => part.trim()).filter(Boolean);
}

