import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ContextItemService, ContextSourceService, EvidenceSnapshotService } from "../../../../../packages/application/src/core/context-services.js";
import { expectedRevisionSchema, listQuerySchema } from "../../../../../packages/contracts/src/common.js";
import {
  contextItemInputSchema,
  contextItemPatchSchema,
  contextItemVersionRestoreInputSchema,
  contextSourceInputSchema,
  contextSourcePatchSchema,
  contextSourceSyncInputSchema,
  evidenceSnapshotCompareInputSchema,
  evidenceSnapshotInputSchema
} from "../../../../../packages/contracts/src/context.js";

const paramsWithIdSchema = z.object({ id: z.string().min(1) });
const contextItemVersionParamsSchema = paramsWithIdSchema.extend({ versionNumber: z.coerce.number().int().positive() });
const listWithProjectSchema = listQuerySchema.extend({
  projectId: z.string().optional(),
  sourceId: z.string().optional()
});

export async function registerContextResourceRoutes(
  server: FastifyInstance,
  services: {
    contextSources: ContextSourceService;
    evidenceSnapshots: EvidenceSnapshotService;
    contextItems: ContextItemService;
  }
): Promise<void> {
  server.get("/api/context-sources", async (request) => {
    const query = listWithProjectSchema.parse(request.query);
    const items = services.contextSources.list({ projectId: query.projectId, status: query.status, q: query.q, limit: query.limit });
    return { items, page: { nextCursor: null, hasMore: false } };
  });
  server.post("/api/context-sources", async (request, reply) => {
    reply.code(201);
    return services.contextSources.create(contextSourceInputSchema.parse(request.body));
  });
  server.get("/api/context-sources/:id", async (request) => services.contextSources.get(paramsWithIdSchema.parse(request.params).id));
  server.patch("/api/context-sources/:id", async (request) => services.contextSources.patch(paramsWithIdSchema.parse(request.params).id, contextSourcePatchSchema.parse(request.body)));
  for (const action of ["resume", "pause", "archive"] as const) {
    server.post(`/api/context-sources/:id/${action}`, async (request) => {
      const { id } = paramsWithIdSchema.parse(request.params);
      const { expectedRevision } = expectedRevisionSchema.parse(request.body);
      return services.contextSources.transition(id, action, expectedRevision);
    });
  }
  server.post("/api/context-sources/:id/sync", async (request) => {
    const { id } = paramsWithIdSchema.parse(request.params);
    const { expectedRevision } = contextSourceSyncInputSchema.parse(request.body);
    return services.contextSources.sync(id, expectedRevision);
  });

  server.get("/api/evidence-snapshots", async (request) => {
    const query = listWithProjectSchema.parse(request.query);
    const items = services.evidenceSnapshots.list({ projectId: query.projectId, sourceId: query.sourceId, q: query.q, limit: query.limit });
    return { items, page: { nextCursor: null, hasMore: false } };
  });
  server.post("/api/evidence-snapshots", async (request, reply) => {
    reply.code(201);
    return services.evidenceSnapshots.create(evidenceSnapshotInputSchema.parse(request.body));
  });
  server.get("/api/evidence-snapshots/:id", async (request) => services.evidenceSnapshots.get(paramsWithIdSchema.parse(request.params).id));
  server.post("/api/evidence-snapshots/:id/verify", async (request) => services.evidenceSnapshots.verify(paramsWithIdSchema.parse(request.params).id));
  server.post("/api/evidence-snapshots/:id/compare", async (request) => {
    const { id } = paramsWithIdSchema.parse(request.params);
    const { otherSnapshotId } = evidenceSnapshotCompareInputSchema.parse(request.body);
    return services.evidenceSnapshots.compare(id, otherSnapshotId);
  });

  server.get("/api/context-items", async (request) => {
    const query = listWithProjectSchema.parse(request.query);
    const items = services.contextItems.list({ projectId: query.projectId, status: query.status, q: query.q, limit: query.limit });
    return { items, page: { nextCursor: null, hasMore: false } };
  });
  server.post("/api/context-items", async (request, reply) => {
    reply.code(201);
    return services.contextItems.create(contextItemInputSchema.parse(request.body));
  });
  server.get("/api/context-items/:id", async (request) => services.contextItems.get(paramsWithIdSchema.parse(request.params).id));
  server.get("/api/context-items/:id/versions", async (request) => ({
    items: services.contextItems.versions(paramsWithIdSchema.parse(request.params).id)
  }));
  server.post("/api/context-items/:id/versions/:versionNumber/restore", async (request) => {
    const { id, versionNumber } = contextItemVersionParamsSchema.parse(request.params);
    const { expectedRevision } = contextItemVersionRestoreInputSchema.parse(request.body);
    return services.contextItems.restoreVersion(id, versionNumber, expectedRevision);
  });
  server.patch("/api/context-items/:id", async (request) => services.contextItems.patch(paramsWithIdSchema.parse(request.params).id, contextItemPatchSchema.parse(request.body)));
  for (const action of ["activate", "mark-stale", "archive"] as const) {
    server.post(`/api/context-items/:id/${action}`, async (request) => {
      const { id } = paramsWithIdSchema.parse(request.params);
      const { expectedRevision } = expectedRevisionSchema.parse(request.body);
      return services.contextItems.transition(id, action, expectedRevision);
    });
  }
}

