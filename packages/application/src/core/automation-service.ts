import { dirname } from "node:path";
import type { AutomationJobRecord, SqliteAutomationRepository } from "../../../infrastructure/src/sqlite/automation-repository.js";
import type { SqliteReviewItemRepository, SqliteSessionRepository } from "../../../infrastructure/src/sqlite/core-repositories.js";
import type { SqliteProjectRepository } from "../../../infrastructure/src/sqlite/project-repository.js";
import type { AgentAdapterRegistry } from "../../../infrastructure/src/adapters/registry.js";
import type { ProjectDto } from "../../../contracts/src/projects.js";
import type { AgentAdapter, ExternalSessionCandidate } from "../ports/agent-adapter.js";
import { nowMs } from "../../../shared/src/clock.js";
import { matchThreadToProject, threadTitle, type ThreadMatchProject } from "./project-thread-matcher.js";

/**
 * Application-level automation behaviour: discovery, ingestion, extraction and candidate
 * actions. The scheduler only owns job lifecycle, so every domain decision lives here and is
 * reached through AutomationJobRouter.
 *
 * Design: docs/superpowers/specs/2026-09-20-contextos-zero-input-automation-design.md
 */

export type AutomationServiceOptions = {
  projects: SqliteProjectRepository;
  sessions: SqliteSessionRepository;
  reviewItems: SqliteReviewItemRepository;
  automation: SqliteAutomationRepository;
  adapters: AgentAdapterRegistry;
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
  }

  private now(): number {
    return this.options.clock?.() ?? nowMs();
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
