import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DecisionService, ReviewItemService, SessionService, WorkItemService } from "../../../../../packages/application/src/core/core-services.js";
import { expectedRevisionSchema, listQuerySchema } from "../../../../../packages/contracts/src/common.js";
import { decisionInputSchema, decisionPatchSchema } from "../../../../../packages/contracts/src/decisions.js";
import { reviewAssignSchema, reviewItemInputSchema, reviewResolveSchema } from "../../../../../packages/contracts/src/review-items.js";
import { sessionInputSchema, sessionPatchSchema } from "../../../../../packages/contracts/src/sessions.js";
import { workItemInputSchema, workItemPatchSchema } from "../../../../../packages/contracts/src/work-items.js";

const paramsWithIdSchema = z.object({ id: z.string().min(1) });
const listWithProjectSchema = listQuerySchema.extend({ projectId: z.string().optional() });

export async function registerCoreResourceRoutes(
  server: FastifyInstance,
  services: {
    sessions: SessionService;
    decisions: DecisionService;
    workItems: WorkItemService;
    reviewItems: ReviewItemService;
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
  server.patch("/api/sessions/:id", async (request) => services.sessions.patch(paramsWithIdSchema.parse(request.params).id, sessionPatchSchema.parse(request.body)));
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
  server.patch("/api/work-items/:id", async (request) => services.workItems.patch(paramsWithIdSchema.parse(request.params).id, workItemPatchSchema.parse(request.body)));
  for (const action of ["mark-ready", "start", "block", "resolve-blocker", "send-to-review", "complete", "reopen", "cancel"] as const) {
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
    const { expectedRevision } = expectedRevisionSchema.parse(request.body);
    return services.reviewItems.dismiss(id, expectedRevision);
  });
}
