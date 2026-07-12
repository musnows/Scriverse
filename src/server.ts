import { join } from "node:path";
import { createRuntime } from "./app.js";
import { loadMasterSecret } from "./credential-vault.js";

const port = Number(process.env.PORT ?? 13210);
const dataDirectory = process.env.DATA_DIR ?? join(process.cwd(), ".data");
const runtime = createRuntime({
  databasePath: process.env.DATABASE_PATH ?? join(dataDirectory, "novel.db"),
  masterSecret: loadMasterSecret(join(dataDirectory, "master.key"), process.env.AI_NOVEL_MASTER_KEY)
});

const server = runtime.app.listen(port, () => {
  console.log(`AI novel workbench listening on http://localhost:${port}`);
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down`);
  server.close(() => {
    runtime.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
