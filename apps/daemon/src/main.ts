import { createDaemonServer, loadDaemonConfig } from "./bootstrap.js";

const config = loadDaemonConfig();
const server = await createDaemonServer({ config });
let closing = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (closing) return;
  closing = true;
  server.log.info({ signal }, "ContextOS daemon shutting down");
  try {
    await server.close();
    process.exitCode = 0;
  } catch (error) {
    server.log.error({ error }, "ContextOS daemon failed to shut down cleanly");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await server.listen({ host: config.host, port: config.port });
  const address = server.server.address();
  server.log.info({ address }, "ContextOS daemon listening");
} catch (error) {
  server.log.error({ error }, "ContextOS daemon failed to start");
  await server.close();
  process.exitCode = 1;
}
