import type { AgentAdapterStatusDto, AgentLaunchInfoDto } from "../../../contracts/src/runtime.js";
import type { ProcessExitInfo, ProcessSupervisor } from "../../../infrastructure/src/process-supervisor.js";

export type AgentCapability =
  | "discover"
  | "launch"
  | "resume"
  | "inspectStatus"
  | "interrupt"
  | "importTranscript";

export type AgentLaunchInput = {
  cwd: string;
  supervisor: ProcessSupervisor;
  onExit?: (exit: ProcessExitInfo) => void;
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
  messageCount: number;
  truncated: boolean;
};

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  discover(): AgentAdapterStatusDto;
  buildLaunchInfo(input: { cwd: string }): AgentLaunchInfoDto;
  launch(input: AgentLaunchInput): AgentLaunchResult;
  importTranscript(input: { cwd: string; externalSessionId?: string }): AgentTranscriptImportResult;
}
