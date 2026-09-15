import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { ContextOsError } from "../../../packages/shared/src/errors.js";
import { SqliteClient } from "../../../packages/infrastructure/src/sqlite/client.js";
import { getSchemaVersion, runMigrations } from "../../../packages/infrastructure/src/sqlite/migrations.js";

export type DaemonConfig = {
  host: string;
  port: number;
  dataDir: string;
  databaseFile: string;
};

export type CreateDaemonServerOptions = {
  config?: Partial<DaemonConfig>;
};

const packageVersion = "0.1.0";

export function loadDaemonConfig(input: Partial<DaemonConfig> = {}): DaemonConfig {
  const config: DaemonConfig = {
    host: input.host ?? process.env.CONTEXTOS_HOST ?? "127.0.0.1",
    port: input.port ?? Number(process.env.CONTEXTOS_PORT ?? 4721),
    dataDir: input.dataDir ?? process.env.CONTEXTOS_DATA_DIR ?? ".contextos",
    databaseFile:
      input.databaseFile ??
      process.env.CONTEXTOS_DATABASE_FILE ??
      ".contextos/contextos.sqlite"
  };

  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new ContextOsError("INVALID_CONFIG", "Port must be an integer between 0 and 65535");
  }

  if (!isLoopbackHost(config.host)) {
    throw new ContextOsError("INVALID_CONFIG", "ContextOS daemon only accepts loopback hosts", {
      host: config.host
    });
  }

  return config;
}

export async function createDaemonServer(
  options: CreateDaemonServerOptions = {}
): Promise<FastifyInstance> {
  const config = loadDaemonConfig(options.config ?? {});
  const sqlite = SqliteClient.open({ databaseFile: config.databaseFile });
  runMigrations(sqlite);
  const schemaVersion = getSchemaVersion(sqlite);

  const server = Fastify({
    logger: false,
    genReqId: (request) => request.headers["x-request-id"]?.toString() ?? randomUUID()
  });

  server.get("/api/health", async (request) => ({
    version: packageVersion,
    schemaVersion,
    processState: "ready",
    requestId: request.id
  }));

  server.addHook("onClose", async () => {
    sqlite.close();
  });

  return server;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
