import type { FastifyInstance } from "fastify";
import type { ContextItemService, ContextSourceService, EvidenceSnapshotService } from "../../../../../packages/application/src/core/context-services.js";
import type { DecisionService, ReviewItemService, SessionService, WorkItemService } from "../../../../../packages/application/src/core/core-services.js";
import type { RuleService } from "../../../../../packages/application/src/core/rule-service.js";
import type { ProjectService } from "../../../../../packages/application/src/project/project-service.js";
import type { WorkspaceOverviewDto } from "../../../../../packages/contracts/src/workspace.js";

export async function registerWorkspaceRoutes(
  server: FastifyInstance,
  services: {
    projects: ProjectService;
    sessions: SessionService;
    decisions: DecisionService;
    workItems: WorkItemService;
    reviewItems: ReviewItemService;
    contextSources: ContextSourceService;
    evidenceSnapshots: EvidenceSnapshotService;
    contextItems: ContextItemService;
    rules: RuleService;
  }
): Promise<void> {
  server.get("/api/workspace/overview", async (): Promise<WorkspaceOverviewDto> => {
    const project = services.projects.list({ status: "ACTIVE", limit: 1 })[0] ?? null;
    if (!project) {
      return {
        project: null,
        kpis: { sessions: 0, pendingReviews: 0, readyWorkItems: 0, activeContextItems: 0, activeRules: 0 },
        lastSession: null,
        nextWorkItems: [],
        pendingReviews: [],
        contextHealth: { activeSources: 0, pausedSources: 0, evidenceSnapshots: 0, activeContextItems: 0, staleContextItems: 0 },
        latestContextPackage: null
      };
    }

    const sessions = services.sessions.list({ projectId: project.id, limit: 50 });
    const reviews = services.reviewItems.list({ projectId: project.id, limit: 50 });
    const workItems = services.workItems.list({ projectId: project.id, limit: 50 });
    const sources = services.contextSources.list({ projectId: project.id, limit: 100 });
    const evidenceSnapshots = services.evidenceSnapshots.list({ projectId: project.id, limit: 100 });
    const contextItems = services.contextItems.list({ projectId: project.id, limit: 100 });
    const rules = services.rules.list({ projectId: project.id, limit: 100 });
    const lastSession = sessions[0] ?? null;
    const latestContextPackage = lastSession ? tryOrNull(() => services.sessions.getContextPackage(lastSession.id)) : null;
    const pendingReviews = reviews.filter((item) => ["OPEN", "IN_PROGRESS"].includes(item.status));
    const nextWorkItems = workItems.filter((item) => ["READY", "IN_PROGRESS", "BLOCKED"].includes(item.status));

    return {
      project,
      kpis: {
        sessions: sessions.length,
        pendingReviews: pendingReviews.length,
        readyWorkItems: workItems.filter((item) => item.status === "READY").length,
        activeContextItems: contextItems.filter((item) => item.status === "ACTIVE").length,
        activeRules: rules.filter((item) => item.status === "ACTIVE").length
      },
      lastSession: lastSession ? { id: lastSession.id, title: lastSession.title || lastSession.id, status: lastSession.status, subtitle: lastSession.intent, updatedAt: lastSession.updatedAt } : null,
      nextWorkItems: nextWorkItems.slice(0, 5).map((item) => ({ id: item.id, title: item.title, status: item.status, subtitle: item.description, updatedAt: item.updatedAt })),
      pendingReviews: pendingReviews.slice(0, 5).map((item) => ({ id: item.id, title: item.summary, status: item.status, subtitle: item.proposedResolution || item.triggerType, updatedAt: item.updatedAt })),
      contextHealth: {
        activeSources: sources.filter((item) => item.status === "ACTIVE").length,
        pausedSources: sources.filter((item) => item.status === "PAUSED").length,
        evidenceSnapshots: evidenceSnapshots.length,
        activeContextItems: contextItems.filter((item) => item.status === "ACTIVE").length,
        staleContextItems: contextItems.filter((item) => item.status === "STALE").length
      },
      latestContextPackage
    };
  });
}

function tryOrNull<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
