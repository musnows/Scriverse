import { join } from "node:path";
import { installServerShutdownHandlers, startLocalServer } from "./server-runtime.js";
import { logger, resolveLogLevel } from "./logger.js";

const port = Number(process.env.PORT ?? 13210);
const host = process.env.HOST ?? "127.0.0.1";
const dataDirectory = process.env.DATA_DIR ?? join(process.cwd(), ".data");
process.on("uncaughtExceptionMonitor", (error, origin) => {
  logger.error("process.uncaught_exception", { origin, error });
});
const running = await startLocalServer({
  port,
  host,
  dataDirectory,
  databasePath: process.env.DATABASE_PATH ?? join(dataDirectory, "novel.db"),
  env: process.env
});

logger.info("server.listening", {
  url: running.url,
  host: running.host,
  port: running.port,
  logLevel: resolveLogLevel(process.env),
  userAuthenticationEnabled: true,
  deploymentGatewayEnabled: Boolean(running.security.auth)
});
installServerShutdownHandlers(running);
