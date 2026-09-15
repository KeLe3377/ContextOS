import { createDaemonServer, loadDaemonConfig } from "./bootstrap.js";

const config = loadDaemonConfig();
const server = await createDaemonServer({ config });

try {
  await server.listen({ host: config.host, port: config.port });
  const address = server.server.address();
  server.log.info({ address }, "ContextOS daemon listening");
} catch (error) {
  server.log.error({ error }, "ContextOS daemon failed to start");
  await server.close();
  process.exitCode = 1;
}
