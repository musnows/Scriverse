import { join } from "node:path";
import { installServerShutdownHandlers, startLocalServer } from "./server-runtime.js";

const port = Number(process.env.PORT ?? 13210);
const host = process.env.HOST ?? "127.0.0.1";
const dataDirectory = process.env.DATA_DIR ?? join(process.cwd(), ".data");
const running = await startLocalServer({
  port,
  host,
  dataDirectory,
  databasePath: process.env.DATABASE_PATH ?? join(dataDirectory, "novel.db"),
  env: process.env
});

console.log(`Scriverse listening on ${running.url} (user authentication enabled${running.security.auth ? ", deployment gateway enabled" : ""})`);
installServerShutdownHandlers(running);
