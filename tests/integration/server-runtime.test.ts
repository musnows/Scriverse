import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isDevelopmentAuthBypassEnabled, resolveRuntimeSecurity } from "../../src/security.js";
import { isDevelopmentServer, startLocalServer, type RunningLocalServer } from "../../src/server-runtime.js";
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

  it("仅在非生产环境显式开启时允许开发免登录", () => {
    expect(isDevelopmentAuthBypassEnabled({ NODE_ENV: "development", APP_DEV_SKIP_AUTH: "true" }, false)).toBe(true);
    expect(isDevelopmentAuthBypassEnabled({ NODE_ENV: "production", APP_DEV_SKIP_AUTH: "true" }, false)).toBe(false);
    expect(isDevelopmentAuthBypassEnabled({ NODE_ENV: "development", APP_DEV_SKIP_AUTH: "false" }, false)).toBe(false);
    expect(isDevelopmentAuthBypassEnabled({ NODE_ENV: "development", APP_DEV_SKIP_AUTH: "true" }, true)).toBe(false);
    expect(isDevelopmentAuthBypassEnabled({ NODE_ENV: "development", APP_DEV_SKIP_AUTH: "true", SCRIVERSE_RUNTIME: "container" })).toBe(false);
  });

  it("识别开发服务启动方式", () => {
    expect(isDevelopmentServer({})).toBe(false);
    expect(isDevelopmentServer({ NODE_ENV: "production", npm_lifecycle_event: "start" })).toBe(false);
    expect(isDevelopmentServer({ NODE_ENV: "development" })).toBe(true);
    expect(isDevelopmentServer({ npm_lifecycle_event: "dev" })).toBe(true);
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

    const health = await fetch(`${running.url}/api/health`).then((response) => response.json()) as { data: { status: string; version: string; development: boolean } };
    const page = await fetch(running.url).then((response) => response.text());

    expect(health.data).toMatchObject({ status: "ok", version: APP_VERSION, development: false });
    expect(page).toContain("叙界");
    expect(existsSync(databasePath)).toBe(true);
    expect(existsSync(join(root, "master.key"))).toBe(true);
  });

  it("开发免登录使用已有账户进入工作台", async () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-dev-auth-"));
    roots.push(root);
    const running = await startLocalServer({
      host: "127.0.0.1",
      port: 0,
      dataDirectory: root,
      databasePath: join(root, "novel.db"),
      env: { NODE_ENV: "development", APP_DEV_SKIP_AUTH: "true" }
    });
    runningServers.push(running);
    running.runtime.auth.register({ username: "dev-bypass", password: "DevBypass123!" });

    const session = await fetch(`${running.url}/api/auth/session`).then((response) => response.json()) as {
      data: { authenticated: boolean; user: { username: string } | null; csrfToken: string | null };
    };
    const health = await fetch(`${running.url}/api/health`).then((response) => response.json()) as { data: { development: boolean } };
    expect(session.data).toMatchObject({ authenticated: true, user: { username: "dev-bypass" }, csrfToken: null });
    expect(health.data.development).toBe(true);
  });
});
