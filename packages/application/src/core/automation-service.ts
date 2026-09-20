import { dirname } from "node:path";
import { automationSettingsDefaults } from "../../../contracts/src/automation.js";
import type { SessionSyncStatus } from "../../../contracts/src/sessions.js";
import type { AutomationJobRecord, SqliteAutomationRepository } from "../../../infrastructure/src/sqlite/automation-repository.js";
import type { SqliteReviewItemRepository, SqliteSessionRepository } from "../../../infrastructure/src/sqlite/core-repositories.js";
import type { SqliteProjectRepository } from "../../../infrastructure/src/sqlite/project-repository.js";
import type { SqliteSessionSyncRepository } from "../../../infrastructure/src/sqlite/session-sync-repository.js";
import type { AgentAdapterRegistry } from "../../../infrastructure/src/adapters/registry.js";
import type { ProjectDto } from "../../../contracts/src/projects.js";
import type { AgentAdapter, ExternalSessionCandidate } from "../ports/agent-adapter.js";
import { nowMs } from "../../../shared/src/clock.js";
import type { EvidenceSnapshotService } from "./context-services.js";
import type { DesktopSyncBatch, DesktopSyncRead, DesktopSyncService } from "./desktop-sync-service.js";
import { AutomationDispatchError } from "./automation-scheduler.js";
import { matchThreadToProject, threadTitle, type ThreadMatchProject } from "./project-thread-matcher.js";

/**
 * Application-level automation behaviour: discovery, ingestion, extraction and candidate
 * actions. The scheduler only owns job lifecycle, so every domain decision lives here and is
 * reached through AutomationJobRouter.
 *
 * Design: docs/superpowers/specs/2026-09-20-contextos-zero-input-automation-design.md
 */

/** Identity recorded on extraction jobs so a retry reuses the same idempotency key. */
export type AutomationExtractorIdentity = { id: string; version: string };

export const defaultAutomationExtractor: AutomationExtractorIdentity = { id: "codex-cli", version: "codex-cli.v1" };

export type AutomationServiceOptions = {
  projects: SqliteProjectRepository;
  sessions: SqliteSessionRepository;
  sync: SqliteSessionSyncRepository;
  reviewItems: SqliteReviewItemRepository;
  automation: SqliteAutomationRepository;
  evidence: EvidenceSnapshotService;
  adapters: AgentAdapterRegistry;
  desktopSync: DesktopSyncService;
  extractor?: AutomationExtractorIdentity;
  clock?: () => number;
};

export type AutomationDiscoverySummary = {
  projectsScanned: number;
  threadsSeen: number;
  sessionsCreated: number;
  alreadyBound: number;
  needsReview: number;
  ignored: number;
  syncJobsEnqueued: number;
};

const discoveryThreadLimit = 100;

/** Adapter id used for discovery when the Project does not name one explicitly. */
const defaultDiscoveryAdapterId = "codex";

/** Evidence stream for batches captured by the daemon-owned transcript poller. */
const desktopSyncEvidenceStream = "desktop-sync";

export type AutomationSyncSummary = {
  sessionId: string;
  status: SessionSyncStatus;
  newEvents: number;
  startOrdinal: number | null;
  endOrdinal: number | null;
  startByteOffset: number | null;
  endByteOffset: number | null;
  partialLine: boolean;
  resetReason: "offset_beyond_eof" | null;
  /** Evidence Snapshot that captured this batch, if any. */
  evidenceId: string | null;
  /** True when identical content had already been captured for this Project. */
  evidenceReused: boolean;
  nextPollScheduled: boolean;
};

export type AutomationDueSyncSummary = {
  projectsScanned: number;
  dueSessions: number;
  jobsEnqueued: number;
};

export class AutomationService {
  constructor(private readonly options: AutomationServiceOptions) {}

  /**
   * Finds agent threads that belong to a Project and turns the unambiguous ones into bound
   * ContextOS Sessions. Ambiguous ownership produces a deduplicated Review Item instead of a
   * guess, and archived Projects are never auto-bound.
   */
  async discoverCodexThreads(input: { projectId?: string } = {}): Promise<AutomationDiscoverySummary> {
    const now = this.now();
    const summary: AutomationDiscoverySummary = {
      projectsScanned: 0,
      threadsSeen: 0,
      sessionsCreated: 0,
      alreadyBound: 0,
      needsReview: 0,
      ignored: 0,
      syncJobsEnqueued: 0
    };

    const allProjects = this.options.projects.list({ limit: 200 });
    const matchProjects: ThreadMatchProject[] = allProjects.map((project) => ({
      id: project.id,
      rootPath: project.rootPath,
      status: project.status
    }));

    for (const project of this.targets(input.projectId)) {
      // OFF means "do not discover, sync or extract"; the manual workflow is unaffected.
      if (this.options.automation.getSettings(project.id, now).mode === "OFF") continue;
      const resolved = this.resolveDiscoveryAdapter(project);
      if (!resolved) continue;
      summary.projectsScanned += 1;

      const threads = await this.listThreads(resolved.adapter, project.rootPath);
      const boundElsewhere = new Set(this.options.sessions.listBoundExternalSessionIds(resolved.id));

      for (const thread of threads) {
        summary.threadsSeen += 1;
        if (boundElsewhere.has(thread.externalSessionId)) {
          summary.alreadyBound += 1;
          continue;
        }

        const match = matchThreadToProject({ cwd: thread.cwd, projects: matchProjects });
        if (match.kind === "IGNORE") {
          summary.ignored += 1;
          continue;
        }
        if (match.kind === "REVIEW") {
          this.recordAmbiguousThread({ projectId: project.id, thread, projectIds: match.projectIds, reason: match.reason, now });
          summary.needsReview += 1;
          continue;
        }

        const created = this.options.sessions.createDiscovered(
          {
            projectId: match.projectId,
            agentAdapterId: resolved.id,
            externalSessionId: thread.externalSessionId,
            title: threadTitle(thread)
          },
          now
        );
        if (!created.created) {
          // Another writer bound this thread between the read and the write.
          summary.alreadyBound += 1;
          continue;
        }
        summary.sessionsCreated += 1;

        const job = this.options.automation.enqueue(
          {
            kind: "SYNC_SESSION_TRANSCRIPT",
            projectId: match.projectId,
            sessionId: created.session.id,
            resourceType: "SESSION",
            resourceId: created.session.id,
            payload: { adapterId: resolved.id, externalSessionId: thread.externalSessionId },
            idempotencyKey: `SYNC_SESSION_TRANSCRIPT:${created.session.id}:discovery`
          },
          now
        );
        if (job.created) summary.syncJobsEnqueued += 1;
      }

      this.options.automation.markProjectActivity(project.id, "DISCOVERY", now);
    }

    return summary;
  }

  /** Dispatcher entry point for DISCOVER_CODEX_THREADS jobs. */
  async handleDiscoveryJob(job: AutomationJobRecord): Promise<void> {
    await this.discoverCodexThreads(job.projectId ? { projectId: job.projectId } : {});
    // Discovery doubles as the periodic entry point that re-arms poll chains which died
    // (daemon restart, exhausted retries) without the browser being open.
    await this.enqueueDueSyncJobs(job.projectId ? { projectId: job.projectId } : {});
  }

  /** Dispatcher entry point for SYNC_SESSION_TRANSCRIPT jobs. */
  async handleSyncJob(job: AutomationJobRecord): Promise<void> {
    if (!job.sessionId) {
      throw new AutomationDispatchError("SYNC_JOB_MISSING_SESSION", "SYNC_SESSION_TRANSCRIPT requires a sessionId");
    }
    await this.syncSessionTranscript({ sessionId: job.sessionId });
  }

  /**
   * Reads new transcript events for one bound Session and keeps the poll chain alive.
   *
   * Everything happens in the daemon: no browser request is involved, and a Session that was
   * bound by discovery is bound from the end of the file first so enabling automation does not
   * replay the whole history.
   */
  async syncSessionTranscript(input: { sessionId: string }): Promise<AutomationSyncSummary> {
    const now = this.now();
    const session = this.options.sessions.getByIdOrThrow(input.sessionId);
    const settings = this.options.automation.getSettings(session.projectId, now);

    if (settings.mode === "OFF") {
      // OFF stops automatic syncing outright: no read, and no follow-up job.
      return {
        ...emptySyncSummary(session.id),
        status: this.options.desktopSync.status(session.id).status
      };
    }

    if (this.options.desktopSync.status(session.id).status === "UNBOUND") {
      // Binding without `fromBeginning` starts at the current end of the rollout.
      this.options.desktopSync.bind(session.id);
    }

    // Read first, commit second: nothing is persisted until the batch is captured as Evidence.
    const read = this.options.desktopSync.read(session.id);
    const persisted = this.commitRead({ projectId: session.projectId, read, now });

    this.options.automation.markProjectActivity(session.projectId, "SYNC", now);
    const nextPollScheduled = this.scheduleNextSync(session.id, now, now + settings.pollIntervalMs);

    return {
      sessionId: session.id,
      status: this.options.desktopSync.status(session.id).status,
      newEvents: read.events.length,
      startOrdinal: read.batch?.startOrdinal ?? null,
      endOrdinal: read.batch?.endOrdinal ?? null,
      startByteOffset: read.batch?.startByteOffset ?? null,
      endByteOffset: read.batch?.endByteOffset ?? null,
      partialLine: read.partialLine,
      resetReason: read.resetReason,
      evidenceId: persisted?.evidenceId ?? null,
      evidenceReused: persisted?.reused ?? false,
      nextPollScheduled
    };
  }

  /**
   * Persists one read as a single unit of work.
   *
   * The Evidence Snapshot row, the advanced reader offset and the derived extraction job commit
   * together, so the reader can never end up past events that were never captured. A read that
   * produced no events only moves the offset, which is already a single atomic statement.
   *
   * The Evidence blob is written to disk before the transaction opens — it is the one step that
   * cannot take part in a SQLite transaction — and is deleted again if the transaction fails.
   */
  private commitRead(input: {
    projectId: string;
    read: DesktopSyncRead;
    now: number;
  }): { evidenceId: string; reused: boolean } | null {
    const { projectId, read, now } = input;
    if (!read.batch) {
      this.options.sync.upsert(read.nextState);
      return null;
    }

    const batch = read.batch;
    const prepared = this.options.evidence.prepareAgentOutput({
      projectId,
      sessionId: batch.sessionId,
      stream: desktopSyncEvidenceStream,
      title: `Transcript events ${batch.startOrdinal}-${batch.endOrdinal}`,
      contentText: canonicalBatchText(projectId, batch),
      // Identifiers, counters and byte ranges only: never the transcript body itself.
      metadata: {
        sessionId: batch.sessionId,
        adapterId: batch.adapterId,
        externalSessionId: batch.externalSessionId,
        parserVersion: batch.parserVersion,
        startOrdinal: batch.startOrdinal,
        endOrdinal: batch.endOrdinal,
        startByteOffset: batch.startByteOffset,
        endByteOffset: batch.endByteOffset,
        partialLine: batch.partialLine,
        resetReason: batch.resetReason
      }
    });

    let evidenceId: string | null = prepared.existing?.id ?? null;
    try {
      this.options.sync.runIngestionTransaction(() => {
        evidenceId = this.options.evidence.commitPreparedAgentOutput(prepared).id;
        this.options.sync.upsert(read.nextState);
        // Only a newly captured batch needs extraction; a reused one was queued already.
        if (!prepared.existing) this.enqueueExtraction({ projectId, batch, evidenceId: evidenceId!, now });
      });
    } catch (error) {
      this.options.evidence.discardPreparedAgentOutput(prepared);
      throw error;
    }

    return { evidenceId: evidenceId!, reused: Boolean(prepared.existing) };
  }

  /** Queues structured extraction for an Evidence Snapshot that was just committed. */
  private enqueueExtraction(input: { projectId: string; batch: DesktopSyncBatch; evidenceId: string; now: number }): void {
    const extractor = this.options.extractor ?? defaultAutomationExtractor;
    this.options.automation.enqueue(
      {
        kind: "EXTRACT_EVIDENCE_CONTEXT",
        projectId: input.projectId,
        sessionId: input.batch.sessionId,
        resourceType: "EVIDENCE_SNAPSHOT",
        resourceId: input.evidenceId,
        payload: { evidenceId: input.evidenceId, sessionId: input.batch.sessionId, extractorId: extractor.id },
        idempotencyKey: `EXTRACT_EVIDENCE_CONTEXT:${input.evidenceId}:${extractor.version}`
      },
      input.now
    );
  }

  /**
   * Recovery sweep: enqueues a sync for every WATCHING Session whose last successful sync is
   * older than its Project cadence. The cadence lives in project automation settings, so
   * switching a Project to OFF stops the sweep for it too.
   */
  async enqueueDueSyncJobs(input: { projectId?: string } = {}): Promise<AutomationDueSyncSummary> {
    const now = this.now();
    const due = this.options.sync.listDueForSync({
      now,
      defaultPollIntervalMs: automationSettingsDefaults.pollIntervalMs,
      limit: 200
    });

    const summary: AutomationDueSyncSummary = { projectsScanned: 0, dueSessions: 0, jobsEnqueued: 0 };
    const touchedProjects = new Set<string>();
    for (const state of due) {
      const session = this.options.sessions.getById(state.session_id);
      if (!session) continue;
      if (input.projectId && session.projectId !== input.projectId) continue;
      summary.dueSessions += 1;
      if (this.scheduleNextSync(session.id, now, now)) summary.jobsEnqueued += 1;
      touchedProjects.add(session.projectId);
    }
    summary.projectsScanned = touchedProjects.size;
    return summary;
  }

  private now(): number {
    return this.options.clock?.() ?? nowMs();
  }

  /**
   * Enqueues the next poll for a Session using a time-bucketed idempotency key, so repeated
   * terminal attempts inside the same poll window collapse into a single job. Returns whether
   * a new job was actually created.
   */
  private scheduleNextSync(sessionId: string, now: number, availableAt: number): boolean {
    const session = this.options.sessions.getById(sessionId);
    if (!session) return false;
    const settings = this.options.automation.getSettings(session.projectId, now);
    if (settings.mode === "OFF") return false;

    const bucket = Math.floor(availableAt / settings.pollIntervalMs);
    const job = this.options.automation.enqueue(
      {
        kind: "SYNC_SESSION_TRANSCRIPT",
        projectId: session.projectId,
        sessionId,
        resourceType: "SESSION",
        resourceId: sessionId,
        payload: { adapterId: session.agentAdapterId, externalSessionId: session.externalSessionId },
        idempotencyKey: `SYNC_SESSION_TRANSCRIPT:${sessionId}:poll:${bucket}`,
        availableAt
      },
      now
    );
    return job.created;
  }

  private targets(projectId?: string): ProjectDto[] {
    if (projectId) return [this.options.projects.getByIdOrThrow(projectId)];
    return this.options.projects.list({ limit: 200 });
  }

  private resolveDiscoveryAdapter(project: ProjectDto): { id: string; adapter: AgentAdapter } | null {
    const preferred = project.agentAdapterIds.length > 0 ? project.agentAdapterIds : [defaultDiscoveryAdapterId];
    for (const adapterId of preferred) {
      const adapter = this.options.adapters.get(adapterId);
      if (adapter?.listExternalSessions) return { id: adapterId, adapter };
    }
    return null;
  }

  /**
   * Threads are queried against the Project root and its parent, then merged by external id.
   * Codex records a thread against the directory it was opened in, which for a repository
   * opened from a parent folder is one level up.
   */
  private async listThreads(adapter: AgentAdapter, projectRoot: string): Promise<ExternalSessionCandidate[]> {
    const roots = threadQueryRoots(projectRoot);
    const merged = new Map<string, ExternalSessionCandidate>();
    for (const root of roots) {
      const found = await adapter.listExternalSessions!({ cwd: root, limit: discoveryThreadLimit });
      for (const item of found) {
        if (!merged.has(item.externalSessionId)) merged.set(item.externalSessionId, item);
      }
    }
    return [...merged.values()];
  }

  private recordAmbiguousThread(input: {
    projectId: string;
    thread: ExternalSessionCandidate;
    projectIds: string[];
    reason: string;
    now: number;
  }): void {
    this.options.reviewItems.findOrCreateOpen(
      {
        projectId: input.projectId,
        sourceType: "CODEX_THREAD",
        sourceId: input.thread.externalSessionId,
        triggerType: input.reason,
        priority: "MEDIUM",
        summary: `Discovered Codex thread needs an owning Project (${input.reason})`,
        // Concise decision context only: no transcript text is copied into the Review Item.
        proposedResolution: [
          `Thread cwd: ${input.thread.cwd ?? "unknown"}`,
          `Candidate projects: ${input.projectIds.join(", ") || "none"}`,
          "Bind the thread to a Project manually, or adjust the Project root so the match is unambiguous."
        ].join("\n")
      },
      input.now
    );
  }
}

function threadQueryRoots(projectRoot: string): string[] {
  const parent = dirname(projectRoot);
  return parent && parent !== projectRoot ? [projectRoot, parent] : [projectRoot];
}

function emptySyncSummary(sessionId: string): AutomationSyncSummary {
  return {
    sessionId,
    status: "UNBOUND",
    newEvents: 0,
    startOrdinal: null,
    endOrdinal: null,
    startByteOffset: null,
    endByteOffset: null,
    partialLine: false,
    resetReason: null,
    evidenceId: null,
    evidenceReused: false,
    nextPollScheduled: false
  };
}

/**
 * Canonical, content-addressed identity of a synced batch.
 *
 * The header pins everything that makes two batches different batches — stream, Project,
 * Session, external thread and parser version — so an upgrade of the parser, or the same text
 * arriving under a different Session, produces its own Evidence instead of silently reusing an
 * unrelated snapshot.
 *
 * Ordinals and byte offsets are deliberately excluded: an offset reset re-reads the same rows
 * at different positions, and including them would give identical content a different hash and
 * defeat Evidence deduplication.
 */
function canonicalBatchText(projectId: string, batch: DesktopSyncBatch): string {
  const events = batch.events.map((event) => JSON.stringify({
    timestamp: event.timestamp ?? null,
    kind: event.kind,
    role: event.role ?? null,
    name: event.name ?? null,
    callId: event.callId ?? null,
    truncated: event.truncated ?? false,
    text: event.text ?? null
  }));
  return [
    `stream:${desktopSyncEvidenceStream}`,
    `project:${projectId}`,
    `session:${batch.sessionId}`,
    `external:${batch.externalSessionId ?? ""}`,
    `parser:${batch.parserVersion ?? ""}`,
    ...events
  ].join("\n");
}
