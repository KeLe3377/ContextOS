import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonServer } from "../apps/daemon/src/bootstrap.js";

const dataDir = await mkdtemp(join(tmpdir(), "contextos-e2e-"));
process.env.CONTEXTOS_CODEX_COMMAND = process.execPath;
process.env.CONTEXTOS_CODEX_ARGS = JSON.stringify(["-e", "process.exit(2)"]);

const server = await createDaemonServer({
  config: {
    host: "127.0.0.1",
    port: 4722,
    dataDir,
    databaseFile: join(dataDir, "contextos.sqlite")
  }
});

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
await server.listen({ host: "127.0.0.1", port: 4722 });
