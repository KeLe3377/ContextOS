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
import type { AutomationService } from "../../../../../packages/application/src/core/automation-service.js";
import type { CandidateApplicationService } from "../../../../../packages/application/src/core/candidate-application-service.js";
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

export async function registerAutomationRoutes(
  server: FastifyInstance,
  services: {
    automation: SqliteAutomationRepository;
    automationService: AutomationService;
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

  server.post("/api/projects/:projectId/automation/discovery", async (request) => {
    const { projectId } = projectIdParamsSchema.parse(request.params);
    return services.automationService.discoverCodexThreads({ projectId });
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
    return services.application.apply({ candidateId: id, expectedRevision: body.expectedRevision });
  });

  server.post("/api/automation/candidates/:id/reject", async (request) => {
    const { id } = candidateIdParamsSchema.parse(request.params);
    const body = extractionCandidateRejectSchema.parse(request.body);
    return services.application.reject({ candidateId: id, expectedRevision: body.expectedRevision });
  });

  server.post("/api/automation/candidates/:id/retry", async (request) => {
    const { id } = candidateIdParamsSchema.parse(request.params);
    const body = extractionCandidateRetrySchema.parse(request.body);
    const candidate = services.automation.getCandidate(id);
    if (!candidate) throw new ContextOsError("NOT_FOUND", "Extraction candidate not found", { id });

    const artifactId = candidate.provenance.sourceArtifactId;
    if (!artifactId) throw new ContextOsError("CONFLICT", "Candidate has no source artifact to replay", { id });

    return services.extraction.extractArtifact({
      projectId: candidate.projectId,
      artifactId,
      sourceEvidenceId: candidate.sourceEvidenceId ?? ""
    });
  });

  server.post("/api/automation/review-items/:id/resolve", async (request) => {
    const { id } = reviewIdParamsSchema.parse(request.params);
    return services.application.resolveReviewItem({ reviewItemId: id, ...reviewResolveSchema.parse(request.body) });
  });
}
