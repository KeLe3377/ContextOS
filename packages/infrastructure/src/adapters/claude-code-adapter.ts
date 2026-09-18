import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentAdapter, AgentLaunchInput, AgentLaunchResult, AgentResumeInput, AgentTranscriptEvent, AgentTranscriptImportResult } from "../../../application/src/ports/agent-adapter.js";
import type { AgentAdapterStatusDto, AgentLaunchInfoDto } from "../../../contracts/src/runtime.js";
import { ContextOsError } from "../../../shared/src/errors.js";
import type { ProcessExitInfo, ProcessSupervisor, SupervisedProcessStatus } from "../process-supervisor.js";
import { resolveProcessCommand } from "./codex-adapter.js";

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code";
  readonly displayName = "Claude Code";
  private readonly command: string;
  private readonly launchArgs: string[];
  private readonly platform: NodeJS.Platform;
  private readonly projectsDir: string;

  constructor(
    command = process.env.CONTEXTOS_CLAUDE_COMMAND ?? defaultClaudeCommand(),
    launchArgs = parseArgs(process.env.CONTEXTOS_CLAUDE_ARGS),
    platform = process.platform,
    projectsDir = defaultClaudeProjectsDir()
  ) {
    this.command = command;
    this.launchArgs = launchArgs;
    this.platform = platform;
    this.projectsDir = projectsDir;
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
      args: input.prompt ? [...this.launchArgs, input.prompt] : this.launchArgs,
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
      args: [...this.launchArgs, "--resume", input.externalSessionId, input.prompt],
      cwd: input.cwd,
      mode: "queued-job",
      operation: "resume",
      externalSessionId: input.externalSessionId
    };
  }

  launch(input: AgentLaunchInput): AgentLaunchResult {
    const launch = this.buildLaunchInfo(input);
    return this.start(launch, input.supervisor, input.onExit);
  }

  resume(input: AgentResumeInput): AgentLaunchResult {
    this.assertResumeTarget(input.cwd, input.externalSessionId);
    const launch = this.buildResumeInfo(input);
    return this.start(launch, input.supervisor, input.onExit);
  }

  inspectStatus(input: { pid: number; supervisor: ProcessSupervisor }): SupervisedProcessStatus {
    return input.supervisor.inspect(input.pid);
  }

  interrupt(input: { pid: number; supervisor: ProcessSupervisor }): boolean {
    return input.supervisor.interrupt(input.pid, this.platform);
  }

  importTranscript(input: { cwd: string; externalSessionId?: string; correlationText?: string }): AgentTranscriptImportResult {
    const candidates = listJsonlFiles(this.projectsDir)
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    const matches: AgentTranscriptImportResult[] = [];
    for (const path of candidates) {
      const metadata = readTranscriptMetadata(path);
      if (!metadata || !isPathWithin(input.cwd, metadata.cwd)) continue;
      if (input.externalSessionId && metadata.id !== input.externalSessionId) continue;
      const transcript = parseClaudeTranscript(path, metadata.id);
      if (input.correlationText && !transcript.contentText.includes(input.correlationText)) continue;
      if (!input.correlationText) return transcript;
      matches.push(transcript);
    }
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new ContextOsError("CONFLICT", "Multiple Claude Code transcripts matched the launch correlation marker", {
        correlationText: input.correlationText
      });
    }
    throw new ContextOsError("NOT_FOUND", input.externalSessionId
      ? "Claude Code transcript was not found for this Project and external session"
      : "No Claude Code transcript was found for this Project");
  }

  private start(launch: AgentLaunchInfoDto, supervisor: ProcessSupervisor, onExit?: (exit: ProcessExitInfo) => void): AgentLaunchResult {
    const processCommand = resolveProcessCommand(launch.command, launch.args, this.platform);
    const process = supervisor.launch({ command: processCommand.command, args: processCommand.args, cwd: launch.cwd, captureOutput: true, onExit });
    return { pid: process.pid, launch };
  }

  private assertResumeTarget(cwd: string, externalSessionId: string): void {
    const matches = listJsonlFiles(this.projectsDir)
      .map((path) => readTranscriptMetadata(path))
      .filter((metadata): metadata is ClaudeTranscriptMetadata => metadata?.id === externalSessionId);
    if (matches.length === 0) {
      throw new ContextOsError("NOT_FOUND", "Claude Code session to resume was not found", { externalSessionId });
    }
    if (!matches.some((metadata) => isPathWithin(cwd, metadata.cwd))) {
      throw new ContextOsError("CONFLICT", "Claude Code session to resume belongs to a different Project", { externalSessionId });
    }
  }
}

export function defaultClaudeCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "claude.cmd" : "claude";
}

export function defaultClaudeProjectsDir(): string {
  if (process.env.CONTEXTOS_CLAUDE_PROJECTS_DIR) return process.env.CONTEXTOS_CLAUDE_PROJECTS_DIR;
  const claudeHome = process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
  return join(claudeHome, "projects");
}

type ClaudeTranscriptMetadata = { id: string; cwd: string };
type ClaudeTranscriptMessage = AgentTranscriptEvent & { kind: "message"; role: "user" | "assistant"; text: string };

function readTranscriptMetadata(path: string): ClaudeTranscriptMetadata | null {
  for (const line of readInitialLines(path, 64)) {
    try {
      const row = JSON.parse(line) as ClaudeJsonRow;
      const id = readSessionId(row);
      const cwd = typeof row.cwd === "string" ? row.cwd : undefined;
      if (id && cwd) return { id, cwd };
    } catch {
      // Ignore partial or non-JSON records.
    }
  }
  return null;
}

function parseClaudeTranscript(path: string, externalSessionId: string): AgentTranscriptImportResult {
  const file = statSync(path);
  if (file.size > 50 * 1024 * 1024) {
    throw new ContextOsError("INVALID_ARGUMENT", "Claude Code transcript exceeds the 50 MB import limit", { externalSessionId });
  }
  const events: AgentTranscriptEvent[] = [];
  let ordinal = 0;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as ClaudeJsonRow;
      const nextEvents = readClaudeEvents(row, ordinal);
      if (!nextEvents.length) continue;
      events.push(...nextEvents);
      ordinal += nextEvents.length;
    } catch {
      // A crash can leave one partial JSONL record; valid records remain importable.
    }
  }
  const messages = events.filter((event): event is ClaudeTranscriptMessage => event.kind === "message" && (event.role === "user" || event.role === "assistant") && Boolean(event.text));
  if (messages.length === 0) {
    throw new ContextOsError("INVALID_ARGUMENT", "Claude Code transcript contains no user or assistant messages", { externalSessionId });
  }

  const selected = selectEvents(events);
  const selectedEvents = selected.truncatedOversized ? [events.at(-1)!] : events.slice(events.length - selected.formatted.length);
  const selectedMessages = selectedEvents.filter((event): event is ClaudeTranscriptMessage => event.kind === "message" && (event.role === "user" || event.role === "assistant") && Boolean(event.text));
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
    contentText: selected.formatted.join("\n\n"),
    sourceUpdatedAt: file.mtime.toISOString(),
    parserVersion: "claude-code-jsonl.v3",
    eventCount: selectedEvents.length,
    eventCounts,
    events: selectedEvents,
    messageCount: selectedMessages.length,
    roleCounts,
    turnCount: roleCounts.user,
    messageOrdinalStart,
    messageOrdinalEnd,
    truncated: selected.truncatedOversized || selectedEvents.length < events.length
  };
}

type ClaudeJsonRow = {
  sessionId?: string;
  session_id?: string;
  cwd?: string;
  type?: string;
  role?: string;
  toolUseId?: string;
  tool_use_id?: string;
  name?: string;
  summary?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string; content?: string; id?: string; tool_use_id?: string; name?: string; input?: unknown }>;
  };
  content?: string | Array<{ type?: string; text?: string; content?: string; id?: string; tool_use_id?: string; name?: string; input?: unknown }>;
};

function readSessionId(row: ClaudeJsonRow): string | undefined {
  return row.sessionId ?? row.session_id;
}

function readClaudeEvents(row: ClaudeJsonRow, previousOrdinal: number): AgentTranscriptEvent[] {
  if (row.type === "summary" && row.summary?.trim()) return [{ ordinal: previousOrdinal + 1, kind: "summary", text: row.summary.trim() }];
  const role = row.message?.role ?? row.role ?? row.type;
  if (role !== "user" && role !== "assistant") return [];
  const content = row.message?.content ?? row.content;
  const events: AgentTranscriptEvent[] = [];
  const text = messageText(content).trim();
  if (text) events.push({ ordinal: previousOrdinal + events.length + 1, kind: "message", role, text });
  for (const item of Array.isArray(content) ? content : []) {
    if (item.type === "tool_use") {
      events.push({
        ordinal: previousOrdinal + events.length + 1,
        kind: "tool_call",
        name: item.name ?? "tool",
        callId: item.id,
        ...truncateToolText(stringifyToolPayload(item.input ?? item.content ?? item.text))
      });
    }
    if (item.type === "tool_result") {
      events.push({
        ordinal: previousOrdinal + events.length + 1,
        kind: "tool_result",
        callId: item.tool_use_id,
        ...truncateToolText(stringifyToolPayload(item.content ?? item.text))
      });
    }
  }
  return events;
}

function messageText(content: ClaudeJsonRow["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => !item.type || item.type === "text")
    .map((item) => item.text ?? item.content ?? "")
    .join("\n");
}

function stringifyToolPayload(value: unknown): string {
  if (typeof value === "string") return value;
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

function selectEvents(events: AgentTranscriptEvent[]): { formatted: string[]; truncatedOversized: boolean } {
  const formatted: string[] = [];
  let length = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    const text = formatTranscriptEvent(event);
    const addedLength = text.length + (formatted.length ? 2 : 0);
    if (length + addedLength > 1_000_000) break;
    formatted.unshift(text);
    length += addedLength;
  }
  if (formatted.length > 0) return { formatted, truncatedOversized: false };
  const latest = events.at(-1)!;
  return {
    formatted: [formatTranscriptEvent({ ...latest, text: latest.text?.slice(-1_000_000) })],
    truncatedOversized: true
  };
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

function readInitialLines(path: string, limit: number): string[] {
  const firstChunk = readFirstChunk(path);
  return firstChunk.split(/\r?\n/).filter(Boolean).slice(0, limit);
}

function readFirstChunk(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return bytesRead > 0 ? buffer.subarray(0, bytesRead).toString("utf8") : "";
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
