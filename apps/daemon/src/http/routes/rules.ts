import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RuleService } from "../../../../../packages/application/src/core/rule-service.js";
import { expectedRevisionSchema, listQuerySchema } from "../../../../../packages/contracts/src/common.js";
import { ruleEvaluationInputSchema, ruleInputSchema, rulePatchSchema, ruleVersionInputSchema } from "../../../../../packages/contracts/src/rules.js";

const paramsWithIdSchema = z.object({ id: z.string().min(1) });
const listWithProjectSchema = listQuerySchema.extend({ projectId: z.string().optional() });

export async function registerRuleRoutes(server: FastifyInstance, rules: RuleService): Promise<void> {
  server.get("/api/rules", async (request) => {
    const query = listWithProjectSchema.parse(request.query);
    const items = rules.list({ projectId: query.projectId, status: query.status, q: query.q, limit: query.limit });
    return { items, page: { nextCursor: null, hasMore: false } };
  });

  server.post("/api/rules", async (request, reply) => {
    reply.code(201);
    return rules.create(ruleInputSchema.parse(request.body));
  });

  server.get("/api/rules/:id", async (request) => rules.get(paramsWithIdSchema.parse(request.params).id));
  server.patch("/api/rules/:id", async (request) => rules.patch(paramsWithIdSchema.parse(request.params).id, rulePatchSchema.parse(request.body)));
  server.post("/api/rules/:id/validate", async (request) => rules.validate(paramsWithIdSchema.parse(request.params).id));
  server.post("/api/rules/:id/test", async (request) => rules.test(paramsWithIdSchema.parse(request.params).id, ruleEvaluationInputSchema.parse(request.body)));
  server.post("/api/rules/:id/new-version", async (request) => rules.createVersion(paramsWithIdSchema.parse(request.params).id, ruleVersionInputSchema.parse(request.body)));
  server.get("/api/rules/:id/versions", async (request) => {
    const items = rules.listVersions(paramsWithIdSchema.parse(request.params).id);
    return { items, page: { nextCursor: null, hasMore: false } };
  });

  for (const action of ["activate", "disable", "archive", "restore"] as const) {
    server.post(`/api/rules/:id/${action}`, async (request) => {
      const { id } = paramsWithIdSchema.parse(request.params);
      const { expectedRevision } = expectedRevisionSchema.parse(request.body);
      return rules.transition(id, action, expectedRevision);
    });
  }

  server.get("/api/rules/:id/conflicts", async (request) => {
    paramsWithIdSchema.parse(request.params);
    return { items: [], page: { nextCursor: null, hasMore: false } };
  });
  server.get("/api/rules/:id/usage", async (request) => {
    return rules.getUsage(paramsWithIdSchema.parse(request.params).id);
  });
  server.get("/api/rules/:id/evaluations", async (request) => {
    const items = rules.listEvaluations(paramsWithIdSchema.parse(request.params).id);
    return { items, page: { nextCursor: null, hasMore: false } };
  });
}
