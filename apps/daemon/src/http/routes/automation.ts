import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  automationSettingsPatchSchema,
  type AutomationJobKind
} from "../../../../../packages/contracts/src/automation.js";
import type { SqliteAutomationRepository } from "../../../../../packages/infrastructure/src/sqlite/automation-repository.js";
import { ContextOsError } from "../../../../../packages/shared/src/errors.js";

/**
 * Automation surface: project status, settings and discovery.
 *
 * The active pipeline is discovery + transcript sync. The candidate/extraction surface that used
 * to sit here is deferred: its endpoints answer 410 with the stable `FEATURE_DEFERRED` code so a
 * caller can never mistake a retired capability for one that succeeded or did nothing.
 */

const projectIdParamsSchema = z.object({ projectId: z.string().min(1) });
const candidateIdParamsSchema = z.object({ id: z.string().min(1) });
const reviewIdParamsSchema = z.object({ id: z.string().min(1) });

/**
 * The retired extraction surface. 410 (not 404) is deliberate: the endpoint existed, the caller
 * may still hold a bookmark, and "gone" is the only honest answer that cannot be read as success.
 */
function deferred(): never {
  throw new ContextOsError("GONE", "Context extraction candidates are deferred", { failureCode: "FEATURE_DEFERRED" });
}

export async function registerAutomationRoutes(
  server: FastifyInstance,
  services: {
    automation: SqliteAutomationRepository;
    schedulerStatus: () => { running: boolean; startedAt: string | null; lastTickAt: string | null; activeJobs: number };
    /** Job kinds the running daemon has a handler for; the scheduler claims nothing else. */
    activeKinds: () => readonly AutomationJobKind[];
  }
): Promise<void> {
  server.get("/api/automation/status", async () => {
    const byStatus = services.automation.countJobsByStatus();
    return {
      generatedAt: new Date().toISOString(),
      scheduler: services.schedulerStatus(),
      activeKinds: [...services.activeKinds()],
      jobs: {
        total: Object.values(byStatus).reduce((total, count) => total + count, 0),
        byStatus
      },
      // Only the stable failure code and a short message; job payloads never leave the daemon.
      recentFailures: services.automation.listLatestFailures(5).map((job) => ({
        id: job.id,
        kind: job.kind,
        failureCode: job.failureCode,
        failureMessage: job.failureMessage
      })),
      projects: services.automation.listProjectStatuses()
    };
  });

  server.get("/api/projects/:projectId/automation/settings", async (request) => {
    const { projectId } = projectIdParamsSchema.parse(request.params);
    return services.automation.getSettings(projectId);
  });

  server.patch("/api/projects/:projectId/automation/settings", async (request) => {
    const { projectId } = projectIdParamsSchema.parse(request.params);
    return services.automation.patchSettings(projectId, automationSettingsPatchSchema.parse(request.body), Date.now());
  });

  // Discovery is enqueued, never run inside the request: scanning an external agent's session
  // store is slow and must be retriable, so the caller gets 202 and the scheduler does the work.
  server.post("/api/projects/:projectId/automation/discovery", async (request, reply) => {
    const { projectId } = projectIdParamsSchema.parse(request.params);
    const now = Date.now();
    const { job, created } = services.automation.enqueue(
      {
        kind: "DISCOVER_CODEX_THREADS",
        projectId,
        resourceType: "PROJECT",
        resourceId: projectId,
        payload: { projectId },
        idempotencyKey: `DISCOVER_CODEX_THREADS:${projectId}:manual`,
        availableAt: now
      },
      now
    );
    return reply.status(202).send({ projectId, jobId: job.id, created });
  });

  server.get("/api/projects/:projectId/automation/candidates", async (request) => {
    projectIdParamsSchema.parse(request.params);
    deferred();
  });

  server.get("/api/automation/candidates/:id", async (request) => {
    candidateIdParamsSchema.parse(request.params);
    deferred();
  });

  server.post("/api/automation/candidates/:id/accept", async (request) => {
    candidateIdParamsSchema.parse(request.params);
    deferred();
  });

  server.post("/api/automation/candidates/:id/reject", async (request) => {
    candidateIdParamsSchema.parse(request.params);
    deferred();
  });

  server.post("/api/automation/candidates/:id/retry", async (request) => {
    candidateIdParamsSchema.parse(request.params);
    deferred();
  });

  server.post("/api/automation/review-items/:id/resolve", async (request) => {
    reviewIdParamsSchema.parse(request.params);
    deferred();
  });
}
