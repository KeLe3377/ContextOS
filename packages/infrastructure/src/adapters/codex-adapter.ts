import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentAdapter, AgentLaunchInput, AgentLaunchResult, AgentResumeInput, AgentTranscriptEvent, AgentTranscriptImportResult, ExternalSessionCandidate } from "../../../application/src/ports/agent-adapter.js";
import type { AgentAdapterStatusDto, AgentLaunchInfoDto } from "../../../contracts/src/runtime.js";
import { ContextOsError } from "../../../shared/src/errors.js";
import type { ProcessExitInfo, ProcessSupervisor, SupervisedProcessStatus } from "../process-supervisor.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";

const codexTranscriptParserVersion = "codex-jsonl.v5";

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";
  readonly displayName = "Codex";
  readonly transcriptParserVersion = codexTranscriptParserVersion;
  private readonly command: string;
  private readonly launchArgs: string[];
  private readonly platform: NodeJS.Platform;
  private readonly sessionsDir: string;
  private readonly appServer: CodexAppServerClient | null;

  constructor(
    command = process.env.CONTEXTOS_CODEX_COMMAND ?? defaultCodexCommand(),
    launchArgs = defaultCodexLaunchArgs(),
    platform = process.platform,
    sessionsDir = defaultCodexSessionsDir(),
    appServer: CodexAppServerClient | null = null
  ) {
    this.command = command;
    this.launchArgs = launchArgs;
    this.platform = platform;
    this.sessionsDir = sessionsDir;
    this.appServer = appServer;
  }

  /**
   * Level A discovery via `codex app-server` (read-only).
   *
   * Swallows failures on purpose: the protocol is marked experimental and
   * the app-server may be missing or broken. An empty list just means the
   * UI keeps its manual "paste the external session id" path.
   */
  async listExternalSessions(input: { cwd?: string; limit?: number } = {}): Promise<ExternalSessionCandidate[]> {
    const client = this.appServer ?? new CodexAppServerClient();
    try {
      const threads = await client.listThreads({ cwd: input.cwd, limit: input.limit });
      return threads
        // Guardian / review sub-agents are internal bookkeeping, not user work.
        .filter((thread) => thread.source !== "subAgent")
        .map<ExternalSessionCandidate>((thread) => ({
          externalSessionId: thread.id,
          transcriptPath: thread.transcriptPath,
          cwd: thread.cwd,
          name: thread.name,
          preview: thread.preview,
          updatedAt: thread.updatedAt,
          status: thread.status,
          source: thread.source,
          turnCount: thread.turnCount
        }));
    } catch {
      return [];
    }
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
    if (!matches.some((metadata) => pathsOverlap(cwd, metadata.cwd))) {
      throw new ContextOsError("CONFLICT", "Codex session to resume belongs to a different Project", { externalSessionId });
    }
  }

  resolveTranscriptPath(input: { externalSessionId: string }): string | null {
    const matches = listJsonlFiles(this.sessionsDir)
      .map((path) => ({ path, metadata: readSessionMetadata(path) }))
      .filter((entry): entry is { path: string; metadata: CodexSessionMetadata } => entry.metadata?.id === input.externalSessionId)
      .sort((left, right) => statSync(right.path).mtimeMs - statSync(left.path).mtimeMs);
    return matches[0]?.path ?? null;
  }

  parseTranscriptRows(input: { rows: string[]; startOrdinal: number }): AgentTranscriptEvent[] {
    const events: AgentTranscriptEvent[] = [];
    let ordinal = input.startOrdinal;
    for (const line of input.rows) {
      try {
        const event = readCodexEvent(JSON.parse(line) as CodexJsonRow, ordinal + 1);
        if (!event) continue;
        ordinal += 1;
        events.push(event);
      } catch {
        // A crash can leave one partial JSONL record; valid records remain importable.
      }
    }
    return events;
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
      if (!metadata) continue;
      if (input.externalSessionId && metadata.id !== input.externalSessionId) continue;
      const pathMatches = input.externalSessionId ? pathsOverlap(input.cwd, metadata.cwd) : isPathWithin(input.cwd, metadata.cwd);
      if (!pathMatches) continue;
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
type CodexTranscriptMessage = AgentTranscriptEvent & { kind: "message"; role: "user" | "assistant"; text: string };
type CodexJsonRow = {
  type?: string;
  timestamp?: unknown;
  payload?: {
    id?: string;
    call_id?: string;
    callId?: string;
    type?: string;
    role?: string;
    name?: string;
    arguments?: string;
    input?: unknown;
    output?: string;
    summary?: string | Array<{ text?: string }>;
    content?: string | Array<{ type?: string; text?: string; content?: string }>;
  };
};

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
  const events: AgentTranscriptEvent[] = [];
  let eventOrdinal = 0;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    try {
      const event = readCodexEvent(JSON.parse(line) as CodexJsonRow, eventOrdinal + 1);
      if (!event) continue;
      eventOrdinal += 1;
      events.push(event);
    } catch {
      // A crash can leave one partial JSONL record; valid records remain importable.
    }
  }
  const messages = events.filter((event): event is CodexTranscriptMessage => event.kind === "message" && (event.role === "user" || event.role === "assistant") && Boolean(event.text));
  if (messages.length === 0) {
    throw new ContextOsError("INVALID_ARGUMENT", "Codex transcript contains no user or assistant messages", { externalSessionId });
  }

  const separator = "\n\n";
  const selected: string[] = [];
  let length = 0;
  let oversizedMessageTruncated = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    const formatted = formatTranscriptEvent(event);
    const addedLength = formatted.length + (selected.length ? separator.length : 0);
    if (length + addedLength > 1_000_000) break;
    selected.unshift(formatted);
    length += addedLength;
  }
  if (selected.length === 0) {
    const latest = events.at(-1)!;
    selected.push(formatTranscriptEvent({ ...latest, text: latest.text?.slice(-1_000_000) }));
    oversizedMessageTruncated = true;
  }
  const selectedEvents = oversizedMessageTruncated
    ? [events.at(-1)!]
    : events.slice(events.length - selected.length);
  const selectedMessages = selectedEvents.filter((event): event is CodexTranscriptMessage => event.kind === "message" && (event.role === "user" || event.role === "assistant") && Boolean(event.text));
  const roleCounts = selectedMessages.reduce((counts, message) => {
    counts[message.role] += 1;
    return counts;
  }, { user: 0, assistant: 0 });
  const eventCounts = selectedEvents.reduce((counts, event) => {
    if (event.kind === "message") counts.message += 1;
    if (event.kind === "tool_call") counts.toolCall += 1;
    if (event.kind === "tool_result") counts.toolResult += 1;
    if (event.kind === "summary") counts.summary += 1;
    return counts;
  }, { message: 0, toolCall: 0, toolResult: 0, summary: 0 });
  const messageOrdinalStart = selectedMessages[0] ? messages.findIndex((message) => message === selectedMessages[0]) + 1 : 1;
  const messageOrdinalEnd = selectedMessages.at(-1) ? messages.findIndex((message) => message === selectedMessages.at(-1)) + 1 : messages.length;
  return {
    externalSessionId,
    contentText: selected.join(separator),
    sourceUpdatedAt: file.mtime.toISOString(),
    parserVersion: codexTranscriptParserVersion,
    eventCount: selectedEvents.length,
    eventCounts,
    events: selectedEvents,
    messageCount: selectedMessages.length,
    roleCounts,
    turnCount: roleCounts.user,
    messageOrdinalStart,
    messageOrdinalEnd,
    truncated: oversizedMessageTruncated || selectedEvents.length < events.length
  };
}

function readCodexEvent(row: CodexJsonRow, ordinal: number): AgentTranscriptEvent | null {
  const payload = row.payload;
  const timestamp = normalizeEventTimestamp(row.timestamp);
  const timing = timestamp ? { timestamp } : {};
  if (row.type === "summary" || payload?.type === "summary" || payload?.type === "reasoning") {
    const text = contentToText(payload?.summary ?? payload?.content);
    return text ? { ordinal, ...timing, kind: "summary", text } : null;
  }
  if (row.type !== "response_item" || !payload?.type) return null;
  if (payload.type === "message" && ["user", "assistant"].includes(payload.role ?? "")) {
    const text = contentToText(payload.content).trim();
    return text ? { ordinal, ...timing, kind: "message", role: payload.role as "user" | "assistant", text } : null;
  }
  if (["function_call", "tool_call", "custom_tool_call"].includes(payload.type)) {
    const text = stringifyToolPayload(payload.arguments ?? payload.input ?? payload.content);
    return { ordinal, ...timing, kind: "tool_call", name: payload.name ?? "tool", callId: payload.call_id ?? payload.callId, ...truncateToolText(text) };
  }
  if (["function_call_output", "tool_result", "custom_tool_call_output"].includes(payload.type)) {
    const text = stringifyToolPayload(payload.output ?? payload.content);
    return { ordinal, ...timing, kind: "tool_result", callId: payload.call_id ?? payload.callId, ...truncateToolText(text) };
  }
  return null;
}

function normalizeEventTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function stringifyToolPayload(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return contentToText(value as Array<{ type?: string; text?: string; content?: string }>);
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

const MAX_TOOL_EVENT_TEXT = 20_000;

function truncateToolText(text: string): Pick<AgentTranscriptEvent, "text" | "truncated"> {
  if (text.length <= MAX_TOOL_EVENT_TEXT) return { text };
  let omitted = text.length - MAX_TOOL_EVENT_TEXT;
  let marker = `\n...[truncated ${omitted} characters]...\n`;
  omitted = text.length - (MAX_TOOL_EVENT_TEXT - marker.length);
  marker = `\n...[truncated ${omitted} characters]...\n`;
  const retained = MAX_TOOL_EVENT_TEXT - marker.length;
  const head = Math.ceil(retained / 2);
  const tail = Math.floor(retained / 2);
  return {
    text: `${text.slice(0, head)}${marker}${text.slice(-tail)}`,
    truncated: true
  };
}

function contentToText(content: string | Array<{ type?: string; text?: string; content?: string }> | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => !item.type || ["input_text", "output_text", "summary_text", "text"].includes(item.type))
    .map((item) => item.text ?? item.content ?? "")
    .join("\n")
    .trim();
}

function formatTranscriptEvent(event: AgentTranscriptEvent): string {
  if (event.kind === "message") return `${event.role?.toUpperCase() ?? "MESSAGE"}:\n${event.text ?? ""}`;
  if (event.kind === "tool_call") return `TOOL CALL ${event.name ?? "tool"}${event.callId ? ` (${event.callId})` : ""}:\n${event.text ?? ""}`;
  if (event.kind === "tool_result") return `TOOL RESULT${event.callId ? ` (${event.callId})` : ""}:\n${event.text ?? ""}`;
  return `SUMMARY:\n${event.text ?? ""}`;
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

function pathsOverlap(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
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

