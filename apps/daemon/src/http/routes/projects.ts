import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ProjectService } from "../../../../../packages/application/src/project/project-service.js";
import { expectedRevisionSchema, listQuerySchema } from "../../../../../packages/contracts/src/common.js";
import { projectInputSchema } from "../../../../../packages/contracts/src/projects.js";

const paramsWithIdSchema = z.object({ id: z.string().min(1) });

export async function registerProjectRoutes(server: FastifyInstance, service: ProjectService): Promise<void> {
  server.get("/api/projects", async (request) => {
    const query = listQuerySchema.parse(request.query);
    const items = service.list({ status: query.status, q: query.q, limit: query.limit });
    return { items, page: { nextCursor: null, hasMore: false } };
  });

  server.post("/api/projects", async (request, reply) => {
    const input = projectInputSchema.parse(request.body);
    reply.code(201);
    return service.create(input);
  });

  server.get("/api/projects/:id", async (request) => {
    const { id } = paramsWithIdSchema.parse(request.params);
    return service.get(id);
  });

  for (const action of ["activate", "pause", "archive", "restore"] as const) {
    server.post(`/api/projects/:id/${action}`, async (request) => {
      const { id } = paramsWithIdSchema.parse(request.params);
      const body = expectedRevisionSchema.parse(request.body);
      return service.transition(id, action, body.expectedRevision);
    });
  }
}


