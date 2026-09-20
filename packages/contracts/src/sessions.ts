import { z } from "zod";
import type { EvidenceSnapshotDto } from "./context.js";
import { resourceMetaSchema } from "./common.js";

export const sessionStatusSchema = z.enum(["CREATED", "RUNNING", "PAUSED", "COMPLETED", "FAILED", "ARCHIVED"]);

export const sessionInputSchema = z.object({
  projectId: z.string().min(1),
  agentAdapterId: z.string().min(1),
  title: z.string().optional(),
  intent: z.string().optional()
});

export const sessionPatchSchema = z.object({
  title: z.string().optional(),
  intent: z.string().optional(),
  expectedRevision: z.number().int().positive()
});

export const resumeCapsulePatchSchema = z.object({
  summary: z.string().trim().min(1, "Summary must not be blank").optional(),
  nextAction: z.string().trim().min(1, "Next action must not be blank").nullable().optional(),
  expectedRevision: z.number().int().positive()
});

export const sessionDtoSchema = resourceMetaSchema.extend({
  projectId: z.string(),
  agentAdapterId: z.string(),
  externalSessionId: z.string().nullable(),
  title: z.string().nullable(),
  intent: z.string().nullable(),
  status: sessionStatusSchema,
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  archivedAt: z.string().nullable()
});

export const resumeCapsuleDtoSchema = z.object({
  sessionId: z.string(),
  status: sessionStatusSchema,
  intent: z.string().nullable(),
  summary: z.string(),
  nextAction: z.string().nullable(),
  lastRunId: z.string().nullable(),
  evidenceSnapshotIds: z.array(z.string()),
  updatedAt: z.string()
});

export const transcriptImportInputSchema = z.object({
  contentText: z.string().max(1_000_000).refine((value) => value.trim().length > 0, "Transcript text is required"),
  summary: z.string().refine((value) => value.trim().length > 0, "Summary must not be blank").optional(),
  title: z.string().refine((value) => value.trim().length > 0, "Title must not be blank").optional()
});

export const adapterTranscriptImportInputSchema = z.object({
  externalSessionId: z.string().trim().min(1).optional(),
  summary: z.string().refine((value) => value.trim().length > 0, "Summary must not be blank").optional(),
  title: z.string().refine((value) => value.trim().length > 0, "Title must not be blank").optional()
});

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SessionInput = z.infer<typeof sessionInputSchema>;
export type SessionPatch = z.infer<typeof sessionPatchSchema>;
export type ResumeCapsulePatch = z.infer<typeof resumeCapsulePatchSchema>;
export type SessionDto = z.infer<typeof sessionDtoSchema>;
export type ResumeCapsuleDto = z.infer<typeof resumeCapsuleDtoSchema>;
export type TranscriptImportInput = z.infer<typeof transcriptImportInputSchema>;
export type AdapterTranscriptImportInput = z.infer<typeof adapterTranscriptImportInputSchema>;
export type AgentTranscriptEventDto = {
  ordinal: number;
  timestamp?: string;
  kind: "message" | "tool_call" | "tool_result" | "summary";
  role?: "user" | "assistant" | "system";
  text?: string;
  name?: string;
  callId?: string;
  truncated?: boolean;
};

export type SessionTranscriptEventsDto = {
  sessionId: string;
  evidenceSnapshotId: string | null;
  adapterId: string | null;
  externalSessionId: string | null;
  parserVersion: string | null;
  sourceUpdatedAt: string | null;
  eventCount: number;
  returnedEventCount: number;
  eventsTruncated: boolean;
  transcriptTruncated: boolean;
  eventCounts: {
    message: number;
    toolCall: number;
    toolResult: number;
    summary: number;
  };
  events: AgentTranscriptEventDto[];
};

export const sessionSyncBindSchema = z.object({
  externalSessionId: z.string().trim().min(1).optional(),
  transcriptPath: z.string().trim().min(1).optional(),
  fromBeginning: z.boolean().optional()
});

export const desktopSyncThreadStatusSchema = z.enum(["notLoaded", "idle", "active", "systemError", "unknown"]);

/**
 * A discoverable external agent thread offered to the user at bind time.
 * `alreadyBound` marks threads another ContextOS Session already points at,
 * so the UI can grey them out instead of letting bind fail with CONFLICT.
 */
export const desktopSyncCandidateSchema = z.object({
  externalSessionId: z.string(),
  transcriptPath: z.string().nullable(),
  cwd: z.string().nullable(),
  /** Sidebar title from the Desktop app; null when the app never named it. */
  name: z.string().nullable(),
  /** Raw first user message. Fallback label when `name` is null. */
  preview: z.string().nullable(),
  updatedAt: z.string().nullable(),
  status: desktopSyncThreadStatusSchema.nullable(),
  source: z.string().nullable(),
  turnCount: z.number().nullable(),
  alreadyBound: z.boolean()
});

export const desktopSyncCandidatesQuerySchema = z.object({
  cwd: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});

export type SessionSyncBindInput = z.infer<typeof sessionSyncBindSchema>;
export type DesktopSyncCandidate = z.infer<typeof desktopSyncCandidateSchema>;
export type DesktopSyncThreadStatus = z.infer<typeof desktopSyncThreadStatusSchema>;
export type SessionSyncStatus = "UNBOUND" | "IDLE" | "WATCHING" | "ERROR";

export type SessionSyncCapabilities = {
  desktopReadSync: boolean;
  /** The adapter can list discoverable external threads for binding. */
  desktopThreadDiscovery: boolean;
  managedCliResume: boolean;
  desktopUiControl: boolean;
};

export type SessionSyncStateDto = {
  sessionId: string;
  adapterId: string | null;
  externalSessionId: string | null;
  transcriptPath: string | null;
  byteOffset: number;
  fileSize: number | null;
  eventsIngested: number;
  lastEventAt: string | null;
  lastSyncedAt: string | null;
  lagMs: number | null;
  status: SessionSyncStatus;
  lastError: string | null;
  capabilities: SessionSyncCapabilities;
  updatedAt: string | null;
};

export type SessionSyncResultDto = SessionSyncStateDto & {
  newEvents: number;
  newEventTimestamps: number;
  partialLine: boolean;
  resetReason: "offset_beyond_eof" | null;
  events: AgentTranscriptEventDto[];
};

export type TranscriptImportResult = {
  evidence: EvidenceSnapshotDto;
  resumeCapsule: ResumeCapsuleDto;
};
export type AdapterTranscriptImportResult = TranscriptImportResult & {
  adapter: {
    id: string;
    externalSessionId: string;
    parserVersion: string;
    sourceUpdatedAt: string;
    eventCount?: number;
    eventCounts?: {
      message: number;
      toolCall: number;
      toolResult: number;
      summary: number;
    };
    events?: AgentTranscriptEventDto[];
    messageCount: number;
    roleCounts: {
      user: number;
      assistant: number;
    };
    turnCount: number;
    messageOrdinalStart: number;
    messageOrdinalEnd: number;
    truncated: boolean;
    reused: boolean;
  };
};

