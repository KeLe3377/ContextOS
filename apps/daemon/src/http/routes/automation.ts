import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  automationSettingsPatchSchema,
  extractionCandidateAcceptSchema,
  extractionCandidateListQuerySchema,
  extractionCandidateRejectSchema,
  extractionCandidateRetrySchema
} from "../../../../../packages/contracts/src/automation.js";
import { reviewResolveSchema } from "../../../../../packages/contracts/src/review-items.js";
import { CandidateApplicationError, type CandidateApplicationService } from "../../../../../packages/application/src/core/candidate-application-service.js";
import type { ExtractionService } from "../../../../../packages/application/src/core/extraction-service.js";
import type { SqliteAutomationRepository } from "../../../../../packages/infrastructure/src/sqlite/automation-repository.js";
import { ContextOsError } from "../../../../../packages/shared/src/errors.js";

/**
 * Automation surface: project status, settings, discovery and the candidate queue.
 *
 * Everything mutating goes through a service rather than a repository write, and candidate
 * acceptance is served by CandidateApplicationService so a candidate can never be marked accepted
 * without the governed object it produces.
 */

const projectIdParamsSchema = z.object({ projectId: z.string().min(1) });
const candidateIdParamsSchema = z.object({ id: z.string().min(1) });
const reviewIdParamsSchema = z.object({ id: z.string().min(1) });

/**
 * Maps pipeline and application failures onto the daemon's HTTP codes: a revision conflict answers
 * 409, a missing artifact 404, and every other domain failure 400, instead of leaking as a 500.
 * The stable `failureCode` travels in the error details so the UI can act on it.
 */
function toHttpError(error: unknown): unknown {
  const code = typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : null;
  if (!code) return error;

  const contextCode =
    code === "CANDIDATE_REVISION_CONFLICT" || code === "COMPACTION_ARTIFACT_INVALID" ? "CONFLICT"
      : code === "CANDIDATE_NOT_FOUND" || code === "COMPACTION_ARTIFACT_NOT_FOUND" ? "NOT_FOUND"
        : code.startsWith("CANDIDATE_") || code.startsWith("EXTRACTION_") || code.startsWith("COMPACTION_") ? "INVALID_ARGUMENT"
          : null;
  if (!contextCode) return error;

  return new ContextOsError(contextCode, error instanceof Error ? error.message : "Automation request failed", { failureCode: code });
}

function guard<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw toHttpError(error);
  }
}

/** Async counterpart of `guard`: the extraction call returns a promise, so its rejection has to be awaited to be mapped. */
async function guardAsync<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toHttpError(error);
  }
}

export async function registerAutomationRoutes(
  server: FastifyInstance,
  services: {
    automation: SqliteAutomationRepository;
    application: CandidateApplicationService;
    extraction: ExtractionService;
  }
): Promise<void> {
  server.get("/api/automation/status", async () => ({ projects: services.automation.listProjectStatuses() }));

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
    const { projectId } = projectIdParamsSchema.parse(request.params);
    const query = extractionCandidateListQuerySchema.parse(request.query);
    return { candidates: services.automation.listCandidates({ ...query, projectId }) };
  });

  server.get("/api/automation/candidates/:id", async (request) => {
    const { id } = candidateIdParamsSchema.parse(request.params);
    const candidate = services.automation.getCandidate(id);
    if (!candidate) throw new ContextOsError("NOT_FOUND", "Extraction candidate not found", { id });
    return candidate;
  });

  server.post("/api/automation/candidates/:id/accept", async (request) => {
    const { id } = candidateIdParamsSchema.parse(request.params);
    const body = extractionCandidateAcceptSchema.parse(request.body);
    return guard(() => services.application.apply({ candidateId: id, expectedRevision: body.expectedRevision }));
  });

  server.post("/api/automation/candidates/:id/reject", async (request) => {
    const { id } = candidateIdParamsSchema.parse(request.params);
    const body = extractionCandidateRejectSchema.parse(request.body);
    return guard(() => services.application.reject({ candidateId: id, expectedRevision: body.expectedRevision }));
  });

  server.post("/api/automation/candidates/:id/retry", async (request) => {
    const { id } = candidateIdParamsSchema.parse(request.params);
    const body = extractionCandidateRetrySchema.parse(request.body);
    const candidate = services.automation.getCandidate(id);
    if (!candidate) throw new ContextOsError("NOT_FOUND", "Extraction candidate not found", { id });

    const artifactId = candidate.provenance.sourceArtifactId;
    if (!artifactId) throw new ContextOsError("CONFLICT", "Candidate has no source artifact to replay", { id });

    return guardAsync(() => services.extraction.extractArtifact({
      projectId: candidate.projectId,
      artifactId,
      sourceEvidenceId: candidate.sourceEvidenceId ?? ""
    }));
  });

  server.post("/api/automation/review-items/:id/resolve", async (request) => {
    const { id } = reviewIdParamsSchema.parse(request.params);
    const input = reviewResolveSchema.parse(request.body);
    return guard(() => services.application.resolveReviewItem({ reviewItemId: id, ...input }));
  });
}
