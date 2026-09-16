import { z } from "zod";
import { resourceMetaSchema } from "./common.js";

export const settingsPatchSchema = z.object({
  launchAtStartup: z.boolean().optional(),
  startMinimized: z.boolean().optional(),
  confirmDestructiveActions: z.boolean().optional(),
  defaultAdapterId: z.string().min(1).nullable().optional(),
  expectedRevision: z.number().int().positive()
});

export const settingsDtoSchema = resourceMetaSchema.extend({
  launchAtStartup: z.boolean(),
  startMinimized: z.boolean(),
  confirmDestructiveActions: z.boolean(),
  localEndpoint: z.string(),
  defaultAdapterId: z.string().nullable(),
  contextConfig: z.record(z.unknown()),
  privacyConfig: z.record(z.unknown()),
  dataDirectory: z.string(),
  requiresRestart: z.boolean().default(false)
});

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
export type SettingsDto = z.infer<typeof settingsDtoSchema>;

export type RuntimeJobDto = {
  id: string;
  kind: string;
  status: "CREATED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED";
  resourceType: string;
  resourceId: string;
  payload: Record<string, unknown>;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type SessionRunDto = {
  id: string;
  sessionId: string;
  jobId: string | null;
  externalRunId: string | null;
  status: "CREATED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED";
  pid: number | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  failureCode: string | null;
  failureMessage: string | null;
  adapterVersion: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type AgentAdapterStatusDto = {
  id: string;
  displayName: string;
  available: boolean;
  command: string;
  version: string | null;
  error: string | null;
  capabilities: string[];
};

export type AgentLaunchInfoDto = {
  adapterId: string;
  command: string;
  args: string[];
  cwd: string;
  mode: "manual-launch" | "queued-job";
};

export type SessionRuntimeStatusDto = {
  sessionId: string;
  adapterId: string;
  run: SessionRunDto | null;
  process: { pid: number; managed: boolean; running: boolean } | null;
};

export type SessionInterruptRuntimeDto = {
  job: RuntimeJobDto;
  run: SessionRunDto;
  process: { pid: number; managed: boolean; running: boolean };
};
