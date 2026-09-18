import type { AgentAdapterStatusDto, AgentLaunchInfoDto } from "../../../contracts/src/runtime.js";
import type { ProcessExitInfo, ProcessSupervisor, SupervisedProcessStatus } from "../../../infrastructure/src/process-supervisor.js";

export type AgentLaunchInput = {
  cwd: string;
  prompt?: string;
  supervisor: ProcessSupervisor;
  onExit?: (exit: ProcessExitInfo) => void;
};

export type AgentResumeInput = AgentLaunchInput & {
  externalSessionId: string;
  prompt: string;
};

export type AgentLaunchResult = {
  pid: number;
  launch: AgentLaunchInfoDto;
};

export type AgentTranscriptImportResult = {
  externalSessionId: string;
  contentText: string;
  sourceUpdatedAt: string;
  parserVersion: string;
  eventCount?: number;
  eventCounts?: {
    message: number;
    toolCall: number;
    toolResult: number;
    summary: number;
  };
  events?: AgentTranscriptEvent[];
  messageCount: number;
  roleCounts: {
    user: number;
    assistant: number;
  };
  turnCount: number;
  messageOrdinalStart: number;
  messageOrdinalEnd: number;
  truncated: boolean;
};

export type AgentTranscriptEvent = {
  ordinal: number;
  kind: "message" | "tool_call" | "tool_result" | "summary";
  role?: "user" | "assistant" | "system";
  text?: string;
  name?: string;
  callId?: string;
  truncated?: boolean;
};

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  discover(): AgentAdapterStatusDto;
  buildLaunchInfo(input: { cwd: string; prompt?: string }): AgentLaunchInfoDto;
  buildResumeInfo(input: { cwd: string; externalSessionId: string; prompt: string }): AgentLaunchInfoDto;
  launch(input: AgentLaunchInput): AgentLaunchResult;
  resume(input: AgentResumeInput): AgentLaunchResult;
  inspectStatus(input: { pid: number; supervisor: ProcessSupervisor }): SupervisedProcessStatus;
  interrupt(input: { pid: number; supervisor: ProcessSupervisor }): boolean;
  importTranscript(input: { cwd: string; externalSessionId?: string; correlationText?: string }): AgentTranscriptImportResult;
}
