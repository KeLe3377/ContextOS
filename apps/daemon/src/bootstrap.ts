import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { ZodError } from "zod";
import { ContextItemService, ContextSourceService, EvidenceSnapshotService } from "../../../packages/application/src/core/context-services.js";
import { DecisionService, ReviewItemService, SessionService, WorkItemService } from "../../../packages/application/src/core/core-services.js";
import { RuleService } from "../../../packages/application/src/core/rule-service.js";
import { AgentAdapterService, ContinueSessionService, SettingsService } from "../../../packages/application/src/core/runtime-services.js";
import { DesktopSyncService } from "../../../packages/application/src/core/desktop-sync-service.js";
import {
  AutomationScheduler,
  type AutomationSetTimer
} from "../../../packages/application/src/core/automation-scheduler.js";
import { AutomationJobRouter } from "../../../packages/application/src/core/automation-job-router.js";
import { AutomationService } from "../../../packages/application/src/core/automation-service.js";
import { CompactionService } from "../../../packages/application/src/core/compaction-service.js";
import { ContextOsCompactionAdapter } from "../../../packages/application/src/core/compaction-adapter.js";
import { PrefixTranscriptSanitizer } from "../../../packages/application/src/core/transcript-sanitizer.js";
import type { CompactionOptions, TranscriptCompactionProvider } from "../../../packages/application/src/ports/transcript-compaction.js";
import { DeterministicCompactionProvider, defaultCompactionOptions } from "../../../packages/infrastructure/src/compaction/deterministic-compaction-provider.js";
import { SqliteCompactionArtifactRepository } from "../../../packages/infrastructure/src/sqlite/compaction-artifact-repository.js";
import type { AgentAdapter } from "../../../packages/application/src/ports/agent-adapter.js";
import type { StartupRegistration } from "../../../packages/application/src/ports/startup-registration.js";
import { ProjectService } from "../../../packages/application/src/project/project-service.js";
import { ClaudeCodeAdapter } from "../../../packages/infrastructure/src/adapters/claude-code-adapter.js";
import { CodexAdapter } from "../../../packages/infrastructure/src/adapters/codex-adapter.js";
import { AgentAdapterRegistry } from "../../../packages/infrastructure/src/adapters/registry.js";
import { FileEvidenceStore } from "../../../packages/infrastructure/src/evidence/evidence-store.js";
import { ProcessSupervisor } from "../../../packages/infrastructure/src/process-supervisor.js";
import { WindowsStartupRegistration } from "../../../packages/infrastructure/src/startup/windows-startup-registration.js";
import { SqliteAutomationRepository } from "../../../packages/infrastructure/src/sqlite/automation-repository.js";
import {
  SqliteDecisionRepository,
  SqliteReviewItemRepository,
  SqliteSessionRepository,
  SqliteWorkItemRepository
} from "../../../packages/infrastructure/src/sqlite/core-repositories.js";
import {
  SqliteContextItemRepository,
  SqliteContextSourceRepository,
  SqliteEvidenceSnapshotRepository
} from "../../../packages/infrastructure/src/sqlite/context-repositories.js";
import { SqliteProjectRepository } from "../../../packages/infrastructure/src/sqlite/project-repository.js";
import { SqliteRuleRepository } from "../../../packages/infrastructure/src/sqlite/rule-repository.js";
import { SqliteRuntimeRepository } from "../../../packages/infrastructure/src/sqlite/runtime-repository.js";
import { SqliteSessionSyncRepository } from "../../../packages/infrastructure/src/sqlite/session-sync-repository.js";
import { CodexTranscriptTailer } from "../../../packages/infrastructure/src/adapters/codex-transcript-tailer.js";
import { SqliteClient } from "../../../packages/infrastructure/src/sqlite/client.js";
import { getSchemaVersion, runMigrations } from "../../../packages/infrastructure/src/sqlite/migrations.js";
import { ContextOsError } from "../../../packages/shared/src/errors.js";
import { nowMs } from "../../../packages/shared/src/clock.js";
import { acquireRuntimeLock } from "./runtime-lock.js";
import { registerContextResourceRoutes } from "./http/routes/context-resources.js";
import { registerCoreResourceRoutes } from "./http/routes/core-resources.js";
import { registerIdempotencyHooks } from "./http/idempotency.js";
import { registerProjectRoutes } from "./http/routes/projects.js";
import { registerRuleRoutes } from "./http/routes/rules.js";
import { registerRuntimeRoutes } from "./http/routes/runtime.js";
import { registerWorkspaceRoutes } from "./http/routes/workspace.js";

export type DaemonConfig = {
  host: string;
  port: number;
  dataDir: string;
  databaseFile: string;
};

export type CreateDaemonServerOptions = {
  config?: Partial<DaemonConfig>;
  agentAdapter?: AgentAdapter;
  agentAdapters?: AgentAdapter[];
  startupRegistration?: StartupRegistration;
  /** Test seam: replaces the scheduler's real setTimeout with a controllable timer. */
  automationSetTimer?: AutomationSetTimer;
  automationTickIntervalMs?: number;
  /** Test seams for the compaction stage. */
  compactionProvider?: TranscriptCompactionProvider;
  compactionOptions?: CompactionOptions;
};

const packageVersion = "0.1.3";

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
  const runtimeLock = acquireRuntimeLock(config.dataDir);
  let sqlite: SqliteClient | undefined;
  try {
    sqlite = SqliteClient.open({ databaseFile: config.databaseFile });
    runMigrations(sqlite);
    const schemaVersion = getSchemaVersion(sqlite);
    const evidenceStore = new FileEvidenceStore(config.dataDir);
    const evidenceSnapshotRepository = new SqliteEvidenceSnapshotRepository(sqlite.db);
    const evidenceFilesRecovery = evidenceStore.recover(
      evidenceSnapshotRepository.listStoredForRecovery().flatMap((snapshot) => snapshot.storageRef ? [snapshot.storageRef] : [])
    );
    const reviewItemRepository = new SqliteReviewItemRepository(sqlite.db);
    const evidenceSnapshotService = new EvidenceSnapshotService(evidenceSnapshotRepository, evidenceStore, reviewItemRepository);
    const evidenceIntegrityRecovery = evidenceSnapshotService.recoverStoredEvidence();
    const runtimeRepository = new SqliteRuntimeRepository(sqlite.db);
    const orphanContinuesRecovered = runtimeRepository.recoverOrphanRunningContinues(nowMs());
    const agentAdapters = options.agentAdapters ?? (options.agentAdapter ? [options.agentAdapter] : [new CodexAdapter(), new ClaudeCodeAdapter()]);
    const adapterRegistry = new AgentAdapterRegistry(agentAdapters);
    const continueSessionService = new ContinueSessionService(runtimeRepository, adapterRegistry, new ProcessSupervisor(), evidenceStore);

    const projectRepository = new SqliteProjectRepository(sqlite.db);
    const ruleService = new RuleService(new SqliteRuleRepository(sqlite.db), reviewItemRepository, projectRepository);
    const projectService = new ProjectService(projectRepository);
    const sessionService = new SessionService(new SqliteSessionRepository(sqlite.db), continueSessionService, projectRepository, ruleService);
    const decisionService = new DecisionService(new SqliteDecisionRepository(sqlite.db));
    const workItemService = new WorkItemService(new SqliteWorkItemRepository(sqlite.db), new SqliteSessionRepository(sqlite.db), projectRepository);
    const reviewItemService = new ReviewItemService(reviewItemRepository);
    const contextSourceRepository = new SqliteContextSourceRepository(sqlite.db);
    const contextSourceService = new ContextSourceService(contextSourceRepository, evidenceSnapshotRepository, projectRepository, evidenceStore);
    const contextItemService = new ContextItemService(new SqliteContextItemRepository(sqlite.db));
    const startupRegistration = options.startupRegistration ?? new WindowsStartupRegistration({
      platform: process.platform,
      startupDirectory: process.env.CONTEXTOS_STARTUP_DIR,
      appDataDirectory: process.env.APPDATA,
      startupScript: resolveStartupScript(),
      host: config.host,
      port: config.port,
      dataDirectory: config.dataDir
    });
    const settingsService = new SettingsService(runtimeRepository, startupRegistration);
    const sessionSyncRepository = new SqliteSessionSyncRepository(sqlite.db);
    const desktopSync = new DesktopSyncService({
      sessions: new SqliteSessionRepository(sqlite.db),
      sync: sessionSyncRepository,
      adapters: adapterRegistry,
      tailer: new CodexTranscriptTailer(),
      bindExternalSession: ({ sessionId, externalSessionId }) => {
        runtimeRepository.bindExternalSession(sessionId, externalSessionId, nowMs());
      },
      resolveProjectRoot: (projectId) => projectRepository.getById(projectId)?.rootPath ?? null
    });
    const agentAdapterService = new AgentAdapterService(adapterRegistry);

    // Automation runs inside the daemon, so background discovery, sync and extraction keep
    // working while the browser is closed. The scheduler owns only job lifecycle; the router
    // maps a claimed job kind onto AutomationService, which holds every domain decision.
    const automationRepository = new SqliteAutomationRepository(sqlite.db);
    const automationService = new AutomationService({
      projects: projectRepository,
      sessions: new SqliteSessionRepository(sqlite.db),
      sync: sessionSyncRepository,
      reviewItems: reviewItemRepository,
      automation: automationRepository,
      evidence: evidenceSnapshotService,
      adapters: adapterRegistry,
      desktopSync
    });
    const compactionService = new CompactionService({
      evidence: evidenceSnapshotRepository,
      artifacts: new SqliteCompactionArtifactRepository(sqlite.db),
      automation: automationRepository,
      sanitizer: new PrefixTranscriptSanitizer(),
      adapter: new ContextOsCompactionAdapter(),
      provider: options.compactionProvider ?? new DeterministicCompactionProvider(),
      options: options.compactionOptions ?? defaultCompactionOptions
    });
    const automationJobRouter = new AutomationJobRouter()
      .register("DISCOVER_CODEX_THREADS", (job) => automationService.handleDiscoveryJob(job))
      .register("SYNC_SESSION_TRANSCRIPT", (job) => automationService.handleSyncJob(job))
      .register("COMPACT_EVIDENCE", (job) => compactionService.handleCompactionJob(job));
    const automationScheduler = new AutomationScheduler({
      repository: automationRepository,
      dispatcher: automationJobRouter,
      setTimer: options.automationSetTimer,
      tickIntervalMs: options.automationTickIntervalMs
    });

    const server = Fastify({
      logger: false,
      genReqId: (request) => request.headers["x-request-id"]?.toString() ?? randomUUID()
    });

    await server.register(cors, {
    origin: (origin, callback) => {
      if (!origin || origin === "null") {
        callback(null, true);
        return;
      }
      try {
        const url = new URL(origin);
        callback(null, ["localhost", "127.0.0.1", "::1"].includes(url.hostname));
      } catch {
        callback(null, false);
      }
    },
    methods: ["GET", "POST", "PATCH", "OPTIONS"]
  });
    registerIdempotencyHooks(server, sqlite.db);
    server.get("/api/health", async (request) => ({
    version: packageVersion,
    schemaVersion,
    processState: "ready",
    recovery: {
      orphanContinuesRecovered,
      automationJobsRecovered: automationScheduler.getRecoveredJobCount(),
      evidence: {
        ...evidenceFilesRecovery,
        ...evidenceIntegrityRecovery
      }
    },
    requestId: request.id
  }));

    await registerProjectRoutes(server, projectService);
    await registerCoreResourceRoutes(server, {
    sessions: sessionService,
    decisions: decisionService,
    workItems: workItemService,
    reviewItems: reviewItemService,
    desktopSync
  });
    await registerContextResourceRoutes(server, {
    contextSources: contextSourceService,
    evidenceSnapshots: evidenceSnapshotService,
    contextItems: contextItemService
  });
    await registerRuleRoutes(server, ruleService);
    await registerWorkspaceRoutes(server, {
    projects: projectService,
    sessions: sessionService,
    decisions: decisionService,
    workItems: workItemService,
    reviewItems: reviewItemService,
    contextSources: contextSourceService,
    evidenceSnapshots: evidenceSnapshotService,
    contextItems: contextItemService,
    rules: ruleService
  });
    await registerRuntimeRoutes(server, {
    settings: settingsService,
    agentAdapters: agentAdapterService
  });
    registerFrontendRoutes(server);

    server.setErrorHandler((error, request, reply) => {
    if (error instanceof ContextOsError) {
      const statusCode = error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : 400;
      reply.status(statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id
        }
      });
      return;
    }

    if (error instanceof ZodError) {
      reply.status(400).send({
        error: {
          code: "INVALID_ARGUMENT",
          message: "Invalid request",
          requestId: request.id
        }
      });
      return;
    }

    reply.status(500).send({
      error: {
        code: "INTERNAL",
        message: "Internal error",
        requestId: request.id
      }
    });
  });

    server.addHook("onReady", async () => {
      automationScheduler.start();
    });

    server.addHook("onClose", async () => {
      // Stop automation before SQLite closes, otherwise an in-flight dispatch would
      // fail against a closed database connection.
      await automationScheduler.stop();
      continueSessionService.shutdown();
      if (sqlite) sqlite.close();
      runtimeLock.release();
    });

    return server;
  } catch (error) {
    sqlite?.close();
    runtimeLock.release();
    throw error;
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function resolveStartupScript(): string {
  return process.env.CONTEXTOS_STARTUP_SCRIPT
    ? resolve(process.env.CONTEXTOS_STARTUP_SCRIPT)
    : resolve(process.cwd(), "scripts", "start-contextos.ps1");
}

function resolveFrontendRoot(): string {
  return process.env.CONTEXTOS_FRONTEND_DIR
    ? resolve(process.env.CONTEXTOS_FRONTEND_DIR)
    : resolve(process.cwd(), "frontend", "dist");
}

function registerFrontendRoutes(server: FastifyInstance): void {
  const frontendRoot = resolveFrontendRoot();
  server.get("/", async (_request, reply) => sendFrontendFile(reply, frontendRoot, "index.html"));
  server.get("/assets/*", async (request, reply) => {
    const params = request.params as { "*": string };
    return sendFrontendFile(reply, frontendRoot, "assets", params["*"]);
  });
}

async function sendFrontendFile(reply: FastifyReply, root: string, ...segments: string[]): Promise<FastifyReply> {
  const path = resolve(root, ...segments);
  if (!isPathWithin(root, path)) {
    return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Frontend asset not found" } });
  }
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("Not a file");
    return reply.type(contentType(path)).send(createReadStream(path));
  } catch {
    return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Frontend asset not found" } });
  }
}

function isPathWithin(root: string, path: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(normalizedRoot);
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".json": return "application/json; charset=utf-8";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".ico": return "image/x-icon";
    default: return "application/octet-stream";
  }
}




