import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createRuntime, type Runtime } from "./app.js";
import { loadMasterSecret } from "./credential-vault.js";
import { resolveRuntimeSecurity, type RuntimeSecurityOptions } from "./security.js";

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

export async function startLocalServer(options: LocalServerOptions): Promise<RunningLocalServer> {
  const security = resolveRuntimeSecurity(options.env);
  const runtime = createRuntime({
    databasePath: options.databasePath,
    masterSecret: loadMasterSecret(join(options.dataDirectory, "master.key"), options.env.AI_NOVEL_MASTER_KEY),
    publicPath,
    security
  });

  return await new Promise<RunningLocalServer>((resolveStart, rejectStart) => {
    const server = runtime.app.listen(options.port, options.host);
    const handleStartupError = (error: Error): void => {
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
        server.closeAllConnections();
        try {
          await new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => error ? rejectClose(error) : resolveClose());
          });
        } finally {
          runtime.close();
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
    console.log(`Received ${signal}, shutting down`);
    void running.close().then(
      () => { process.exitCode = 0; },
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : "Failed to stop Scriverse server");
        process.exitCode = 1;
      }
    );
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
