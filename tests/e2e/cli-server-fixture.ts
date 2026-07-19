import { createRuntime } from "../../src/app.js";

const databasePath = process.env.CLI_E2E_DATABASE_PATH;
if (!databasePath) throw new Error("CLI_E2E_DATABASE_PATH is required");

const runtime = createRuntime({
  databasePath,
  masterSecret: "cli-e2e-master-secret-with-at-least-32-characters",
  serveUi: false,
  revealCaptchaAnswer: true,
  security: { allowRegistration: true }
});
const server = runtime.app.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("CLI E2E server did not expose a TCP port");
  console.log(JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}` }));
});

function shutdown(): void {
  server.closeAllConnections();
  server.close(() => {
    runtime.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
