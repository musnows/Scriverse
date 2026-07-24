import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createRuntime, type Runtime } from "./app.js";
import { loadMasterSecret } from "./credential-vault.js";
import { isDevelopmentAuthBypassEnabled, resolveRuntimeSecurity, type RuntimeSecurityOptions } from "./security.js";
import { logger, sanitizeError } from "./logger.js";

export type LocalServerOptions = {
  host: string;
  port: number;
  dataDirectory: string;
  databasePath: string;
  env: NodeJS.ProcessEnv;
};

export type RunningLocalServer = {
  server: Server;
  runtime: Runtime;
  url: string;
  host: string;
  port: number;
  dataDirectory: string;
  databasePath: string;
  security: RuntimeSecurityOptions;
  close: () => Promise<void>;
};

const publicPath = fileURLToPath(new URL("./public/", import.meta.url));

export function isDevelopmentServer(environment: NodeJS.ProcessEnv): boolean {
  return environment.NODE_ENV === "development" || environment.npm_lifecycle_event === "dev";
}

export async function startLocalServer(options: LocalServerOptions): Promise<RunningLocalServer> {
  logger.info("server.starting", { host: options.host, port: options.port, dataDirectory: options.dataDirectory, databasePath: options.databasePath });
  let security: RuntimeSecurityOptions;
  let runtime: Runtime;
  try {
    security = resolveRuntimeSecurity(options.env);
    const devAuthBypass = isDevelopmentAuthBypassEnabled(options.env);
    runtime = createRuntime({
      databasePath: options.databasePath,
      attachmentDirectory: join(options.dataDirectory, "attachments"),
      masterSecret: loadMasterSecret(join(options.dataDirectory, "master.key"), options.env.AI_NOVEL_MASTER_KEY),
      publicPath,
      security,
      disableUserAuth: devAuthBypass,
      devAuthBypass,
      developmentServer: isDevelopmentServer(options.env)
    });
  } catch (error) {
    logger.error("server.initialization_failed", { host: options.host, port: options.port, error: sanitizeError(error) });
    throw error;
  }

  return await new Promise<RunningLocalServer>((resolveStart, rejectStart) => {
    const server = runtime.app.listen(options.port, options.host);
    const handleStartupError = (error: Error): void => {
      logger.error("server.start_failed", { host: options.host, port: options.port, error: sanitizeError(error) });
      runtime.close();
      rejectStart(error);
    };
    server.once("error", handleStartupError);
    server.once("listening", () => {
      server.off("error", handleStartupError);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        runtime.close();
        rejectStart(new Error("Scriverse server did not expose a TCP port"));
        return;
      }
      const port = address.port;
      const displayHost = options.host.includes(":") ? `[${options.host}]` : options.host;
      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        logger.info("server.stopping", { host: options.host, port });
        server.closeAllConnections();
        try {
          await new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => error ? rejectClose(error) : resolveClose());
          });
        } finally {
          runtime.close();
          logger.info("server.stopped", { host: options.host, port });
        }
      };
      resolveStart({
        server,
        runtime,
        url: `http://${displayHost}:${port}`,
        host: options.host,
        port,
        dataDirectory: options.dataDirectory,
        databasePath: options.databasePath,
        security,
        close
      });
    });
  });
}

export function installServerShutdownHandlers(running: RunningLocalServer): void {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("server.shutdown_signal_received", { signal });
    void running.close().then(
      () => { process.exitCode = 0; },
      (error: unknown) => {
        logger.error("server.stop_failed", { signal, error: sanitizeError(error) });
        process.exitCode = 1;
      }
    );
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
