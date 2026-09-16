import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentAdapterService, SettingsService } from "../../../../../packages/application/src/core/runtime-services.js";
import { settingsPatchSchema } from "../../../../../packages/contracts/src/runtime.js";

const adapterParamsSchema = z.object({ id: z.string().min(1) });

export async function registerRuntimeRoutes(
  server: FastifyInstance,
  services: { settings: SettingsService; agentAdapters: AgentAdapterService }
): Promise<void> {
  server.get("/api/settings", async () => services.settings.get());
  server.patch("/api/settings", async (request) => services.settings.patch(settingsPatchSchema.parse(request.body)));

  server.get("/api/agent-adapters", async () => ({
    items: services.agentAdapters.list(),
    page: { nextCursor: null, hasMore: false }
  }));
  server.get("/api/agent-adapters/:id", async (request) => {
    const { id } = adapterParamsSchema.parse(request.params);
    return services.agentAdapters.get(id);
  });
}
