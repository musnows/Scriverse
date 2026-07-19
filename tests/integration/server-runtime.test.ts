import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRuntimeSecurity } from "../../src/security.js";
import { startLocalServer, type RunningLocalServer } from "../../src/server-runtime.js";
import { APP_VERSION } from "../../src/version.js";

const roots: string[] = [];
const runningServers: RunningLocalServer[] = [];

afterEach(async () => {
  for (const running of runningServers.splice(0)) await running.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("本地服务运行时", () => {
  it("仅在 APP_ALLOW_REGISTRATION 明确为 true 时开放注册", () => {
    expect(resolveRuntimeSecurity({}).allowRegistration).toBe(false);
    expect(resolveRuntimeSecurity({ APP_ALLOW_REGISTRATION: "false" }).allowRegistration).toBe(false);
    expect(resolveRuntimeSecurity({ APP_ALLOW_REGISTRATION: "TRUE" }).allowRegistration).toBe(false);
    expect(resolveRuntimeSecurity({ APP_ALLOW_REGISTRATION: "true" }).allowRegistration).toBe(true);
  });

  it("使用隔离数据目录启动 API 和完整网页", async () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-serve-"));
    roots.push(root);
    const databasePath = join(root, "novel.db");
    const running = await startLocalServer({
      host: "127.0.0.1",
      port: 0,
      dataDirectory: root,
      databasePath,
      env: { NODE_ENV: "test" }
    });
    runningServers.push(running);

    const health = await fetch(`${running.url}/api/health`).then((response) => response.json()) as { data: { status: string; version: string } };
    const page = await fetch(running.url).then((response) => response.text());

    expect(health.data).toMatchObject({ status: "ok", version: APP_VERSION });
    expect(page).toContain("叙界");
    expect(existsSync(databasePath)).toBe(true);
    expect(existsSync(join(root, "master.key"))).toBe(true);
  });
});
