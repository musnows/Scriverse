import { createRuntime } from "../../src/app.js";

const databasePath = process.env.CLI_E2E_DATABASE_PATH;
if (!databasePath) throw new Error("CLI_E2E_DATABASE_PATH is required");

const runtime = createRuntime({
  databasePath,
  masterSecret: "cli-e2e-master-secret-with-at-least-32-characters",
  serveUi: false,
  revealCaptchaAnswer: true,
  security: {
    allowRegistration: true,
    setupToken: "cli-e2e-setup-token-with-at-least-32-characters"
  }
});
const server = runtime.app.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("CLI E2E server did not expose a TCP port");
  console.log(JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}` }));
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const serverClose = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  server.closeAllConnections();
  await serverClose;
  await runtime.close();
  process.exit(0);
}

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
