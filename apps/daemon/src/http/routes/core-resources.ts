import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DecisionService, ReviewItemService, SessionService, WorkItemService } from "../../../../../packages/application/src/core/core-services.js";
import type { DesktopSyncService } from "../../../../../packages/application/src/core/desktop-sync-service.js";
import { expectedRevisionSchema, listQuerySchema } from "../../../../../packages/contracts/src/common.js";
import { decisionInputSchema, decisionPatchSchema } from "../../../../../packages/contracts/src/decisions.js";
import { reviewAssignSchema, reviewDismissSchema, reviewItemInputSchema, reviewResolveSchema } from "../../../../../packages/contracts/src/review-items.js";
import { adapterTranscriptImportInputSchema, desktopSyncCandidatesQuerySchema, resumeCapsulePatchSchema, sessionInputSchema, sessionPatchSchema, sessionSyncBindSchema, transcriptImportInputSchema } from "../../../../../packages/contracts/src/sessions.js";
import { workItemBlockSchema, workItemInputSchema, workItemPatchSchema, workItemResolveBlockerSchema, workItemStartSessionSchema } from "../../../../../packages/contracts/src/work-items.js";

const paramsWithIdSchema = z.object({ id: z.string().min(1) });
const listWithProjectSchema = listQuerySchema.extend({ projectId: z.string().optional() });

export async function registerCoreResourceRoutes(
  server: FastifyInstance,
  services: {
    sessions: SessionService;
    decisions: DecisionService;
    workItems: WorkItemService;
    reviewItems: ReviewItemService;
    desktopSync?: DesktopSyncService;
  }
): Promise<void> {
  server.get("/api/sessions", async (request) => {
    const query = listWithProjectSchema.parse(request.query);
    const items = services.sessions.list({ projectId: query.projectId, status: query.status, q: query.q, limit: query.limit });
    return { items, page: { nextCursor: null, hasMore: false } };
  });
  server.post("/api/sessions", async (request, reply) => {
    reply.code(201);
    return services.sessions.create(sessionInputSchema.parse(request.body));
  });
  server.get("/api/sessions/:id", async (request) => services.sessions.get(paramsWithIdSchema.parse(request.params).id));
  server.get("/api/sessions/:id/context-pack", async (request) => services.sessions.getContextPackage(paramsWithIdSchema.parse(request.params).id));
  server.get("/api/sessions/:id/evidence", async (request) => ({ items: services.sessions.listEvidence(paramsWithIdSchema.parse(request.params).id), page: { nextCursor: null, hasMore: false } }));
  server.get("/api/sessions/:id/transcript-events", async (request) => services.sessions.transcriptEvents(paramsWithIdSchema.parse(request.params).id));
  server.get("/api/sessions/:id/resume-capsule", async (request) => services.sessions.getResumeCapsule(paramsWithIdSchema.parse(request.params).id));
  server.patch("/api/sessions/:id/resume-capsule", async (request) => services.sessions.patchResumeCapsule(paramsWithIdSchema.parse(request.params).id, resumeCapsulePatchSchema.parse(request.body)));
  server.get("/api/sessions/:id/runtime-status", async (request) => services.sessions.runtimeStatus(paramsWithIdSchema.parse(request.params).id));
  server.get("/api/sessions/:id/runs", async (request) => ({ items: services.sessions.runs(paramsWithIdSchema.parse(request.params).id) }));
  server.get("/api/sessions/:id/activity", async (request) => ({ items: services.sessions.activity(paramsWithIdSchema.parse(request.params).id), page: { nextCursor: null, hasMore: false } }));
  server.post("/api/sessions/:id/import-transcript", async (request, reply) => {
    const { id } = paramsWithIdSchema.parse(request.params);
    const result = services.sessions.importTranscript(id, transcriptImportInputSchema.parse(request.body));
    reply.code(201);
    return result;
  });
  server.post("/api/sessions/:id/import-transcript/auto", async (request, reply) => {
    const { id } = paramsWithIdSchema.parse(request.params);
    const result = services.sessions.importAdapterTranscript(id, adapterTranscriptImportInputSchema.parse(request.body ?? {}));
    reply.code(201);
    return result;
  });
  server.post("/api/sessions/:id/sync-transcript", async (request, reply) => {
    const { id } = paramsWithIdSchema.parse(request.params);
    const result = services.sessions.importAdapterTranscript(id, adapterTranscriptImportInputSchema.parse(request.body ?? {}));
    reply.code(201);
    return result;
  });
  server.get("/api/sessions/:id/desktop-sync", async (request) => {
    const { id } = paramsWithIdSchema.parse(request.params);
    return services.desktopSync!.status(id);
  });
  server.get("/api/sessions/:id/desktop-sync/candidates", async (request) => {
    const { id } = paramsWithIdSchema.parse(request.params);
    const query = desktopSyncCandidatesQuerySchema.parse(request.query ?? {});
    return { sessionId: id, candidates: await services.desktopSync!.listCandidates(id, query) };
  });
  server.post("/api/sessions/:id/desktop-sync/bind", async (request, reply) => {
    const { id } = paramsWithIdSchema.parse(request.params);
    const result = services.desktopSync!.bind(id, sessionSyncBindSchema.parse(request.body ?? {}));
    reply.code(201);
    return result;
  });
  server.post("/api/sessions/:id/desktop-sync/sync", async (request) => {
    const { id } = paramsWithIdSchema.parse(request.params);
    return services.desktopSync!.sync(id);
  });
  server.delete("/api/sessions/:id/desktop-sync", async (request) => {
    const { id } = paramsWithIdSchema.parse(request.params);
    services.desktopSync!.unbind(id);
    return { sessionId: id, unbound: true };
  });
  server.patch("/api/sessions/:id", async (request) => services.sessions.patch(paramsWithIdSchema.parse(request.params).id, sessionPatchSchema.parse(request.body)));
  server.post("/api/sessions/:id/interrupt", async (request) => {
    const { id } = paramsWithIdSchema.parse(request.params);
    const { expectedRevision } = expectedRevisionSchema.parse(request.body);
    return services.sessions.interrupt(id, expectedRevision);
  });
  for (const action of ["continue", "review", "archive"] as const) {
    server.post(`/api/sessions/:id/${action}`, async (request) => {
      const { id } = paramsWithIdSchema.parse(request.params);
      const { expectedRevision } = expectedRevisionSchema.parse(request.body);
      return services.sessions.transition(id, action, expectedRevision);
    });
  }

  server.get("/api/decisions", async (request) => {
    const query = listWithProjectSchema.parse(request.query);
    const items = services.decisions.list({ projectId: query.projectId, status: query.status, q: query.q, limit: query.limit });
    return { items, page: { nextCursor: null, hasMore: false } };
  });
  server.post("/api/decisions", async (request, reply) => {
    reply.code(201);
    return services.decisions.create(decisionInputSchema.parse(request.body));
  });
  server.get("/api/decisions/:id", async (request) => services.decisions.get(paramsWithIdSchema.parse(request.params).id));
  server.get("/api/decisions/:id/versions", async (request) => ({ items: services.decisions.versions(paramsWithIdSchema.parse(request.params).id) }));
  server.patch("/api/decisions/:id", async (request) => services.decisions.patch(paramsWithIdSchema.parse(request.params).id, decisionPatchSchema.parse(request.body)));
  for (const action of ["propose", "accept", "supersede", "reverse", "archive", "review"] as const) {
    server.post(`/api/decisions/:id/${action}`, async (request) => {
      const { id } = paramsWithIdSchema.parse(request.params);
      const { expectedRevision } = expectedRevisionSchema.parse(request.body);
      return services.decisions.transition(id, action, expectedRevision);
    });
  }

  server.get("/api/work-items", async (request) => {
    const query = listWithProjectSchema.parse(request.query);
    const items = services.workItems.list({ projectId: query.projectId, status: query.status, q: query.q, limit: query.limit });
    return { items, page: { nextCursor: null, hasMore: false } };
  });
  server.post("/api/work-items", async (request, reply) => {
    reply.code(201);
    return services.workItems.create(workItemInputSchema.parse(request.body));
  });
  server.get("/api/work-items/:id", async (request) => services.workItems.get(paramsWithIdSchema.parse(request.params).id));
  server.get("/api/work-items/:id/readiness", async (request) => services.workItems.readiness(paramsWithIdSchema.parse(request.params).id));
  server.get("/api/work-items/:id/dependencies", async (request) => ({ items: services.workItems.dependencies(paramsWithIdSchema.parse(request.params).id) }));
  server.get("/api/work-items/:id/children", async (request) => ({ items: services.workItems.children(paramsWithIdSchema.parse(request.params).id) }));
  server.get("/api/work-items/:id/attempts", async (request) => ({ items: services.workItems.attempts(paramsWithIdSchema.parse(request.params).id) }));
  server.get("/api/work-items/:id/activity", async (request) => ({ items: services.workItems.activity(paramsWithIdSchema.parse(request.params).id) }));
  server.patch("/api/work-items/:id", async (request) => services.workItems.patch(paramsWithIdSchema.parse(request.params).id, workItemPatchSchema.parse(request.body)));
  server.post("/api/work-items/:id/start-session", async (request, reply) => {
    const { id } = paramsWithIdSchema.parse(request.params);
    const result = services.workItems.startSession(id, workItemStartSessionSchema.parse(request.body));
    reply.code(201);
    return result;
  });
  server.post("/api/work-items/:id/block", async (request) => {
    const { id } = paramsWithIdSchema.parse(request.params);
    return services.workItems.block(id, workItemBlockSchema.parse(request.body));
  });
  server.post("/api/work-items/:id/resolve-blocker", async (request) => {
    const { id } = paramsWithIdSchema.parse(request.params);
    return services.workItems.resolveBlocker(id, workItemResolveBlockerSchema.parse(request.body));
  });
  for (const action of ["mark-ready", "start", "send-to-review", "complete", "reopen", "cancel"] as const) {
    server.post(`/api/work-items/:id/${action}`, async (request) => {
      const { id } = paramsWithIdSchema.parse(request.params);
      const { expectedRevision } = expectedRevisionSchema.parse(request.body);
      return services.workItems.transition(id, action, expectedRevision);
    });
  }

  server.get("/api/review-items", async (request) => {
    const query = listWithProjectSchema.parse(request.query);
    const items = services.reviewItems.list({ projectId: query.projectId, status: query.status, q: query.q, limit: query.limit });
    return { items, page: { nextCursor: null, hasMore: false } };
  });
  server.post("/api/review-items", async (request, reply) => {
    reply.code(201);
    return services.reviewItems.create(reviewItemInputSchema.parse(request.body));
  });
  server.get("/api/review-items/:id", async (request) => services.reviewItems.get(paramsWithIdSchema.parse(request.params).id));
  server.get("/api/review-items/:id/action-log", async (request) => ({ items: services.reviewItems.actionLog(paramsWithIdSchema.parse(request.params).id) }));
  server.post("/api/review-items/:id/assign", async (request) => {
    const { id } = paramsWithIdSchema.parse(request.params);
    const body = reviewAssignSchema.parse(request.body);
    return services.reviewItems.assign(id, body.reviewerId, body.expectedRevision);
  });
  server.post("/api/review-items/:id/start", async (request) => {
    const { id } = paramsWithIdSchema.parse(request.params);
    const { expectedRevision } = expectedRevisionSchema.parse(request.body);
    return services.reviewItems.start(id, expectedRevision);
  });
  server.post("/api/review-items/:id/resolve", async (request) => {
    const { id } = paramsWithIdSchema.parse(request.params);
    return services.reviewItems.resolve(id, reviewResolveSchema.parse(request.body));
  });
  server.post("/api/review-items/:id/dismiss", async (request) => {
    const { id } = paramsWithIdSchema.parse(request.params);
    return services.reviewItems.dismiss(id, reviewDismissSchema.parse(request.body));
  });
}
