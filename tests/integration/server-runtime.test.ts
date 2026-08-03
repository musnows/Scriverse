import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isDevelopmentAuthBypassEnabled, resolveRuntimeSecurity } from "../../src/security.js";
import { isDevelopmentServer, isLoopbackHost, startLocalServer, type RunningLocalServer } from "../../src/server-runtime.js";
import { APP_VERSION } from "../../src/version.js";
import { loadMasterSecret } from "../../src/credential-vault.js";
import { DATABASE_SCHEMA_VERSION, Database, readDatabaseSchemaVersion } from "../../src/database.js";

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
    expect(() => resolveRuntimeSecurity({ APP_ALLOW_REGISTRATION: "true" })).toThrow("APP_SETUP_TOKEN");
    expect(resolveRuntimeSecurity({
      APP_ALLOW_REGISTRATION: "true",
      APP_SETUP_TOKEN: "server-runtime-setup-token-with-at-least-32-characters"
    }).allowRegistration).toBe(true);
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

  it("开发免登录仅允许绑定回环地址", async () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.2")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);

    const root = mkdtempSync(join(tmpdir(), "scriverse-dev-auth-host-"));
    roots.push(root);
    await expect(startLocalServer({
      host: "0.0.0.0",
      port: 0,
      dataDirectory: root,
      databasePath: join(root, "novel.db"),
      env: { NODE_ENV: "development", APP_DEV_SKIP_AUTH: "true" }
    })).rejects.toThrow("APP_DEV_SKIP_AUTH 仅允许绑定本机回环地址");
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
    const masterKeyPath = join(root, "master.key");
    expect(existsSync(masterKeyPath)).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    expect(statSync(masterKeyPath).mode & 0o777).toBe(0o600);
    for (const sqliteSidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
      if (existsSync(sqliteSidecar)) expect(statSync(sqliteSidecar).mode & 0o777).toBe(0o600);
    }

    chmodSync(masterKeyPath, 0o644);
    expect(loadMasterSecret(masterKeyPath)).toHaveLength(43);
    expect(statSync(masterKeyPath).mode & 0o777).toBe(0o600);
  });

  it("升级数据库前完整备份数据库、主密钥和附件", async () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-migration-backup-"));
    roots.push(root);
    const databasePath = join(root, "novel.db");
    const legacy = new Database(databasePath);
    legacy.raw.exec("DROP TABLE attachment_cleanup_queue; DROP TABLE attachment_access_modules; DELETE FROM schema_migrations WHERE version >= 58");
    legacy.close();
    const masterKey = loadMasterSecret(join(root, "master.key"));
    const attachmentsDirectory = join(root, "attachments", "fixture");
    mkdirSync(attachmentsDirectory, { recursive: true });
    writeFileSync(join(attachmentsDirectory, "image.bin"), "attachment-backup-fixture");

    const running = await startLocalServer({
      host: "127.0.0.1",
      port: 0,
      dataDirectory: root,
      databasePath,
      env: { NODE_ENV: "test" }
    });
    runningServers.push(running);

    // backups/ 下还会有 S3 备份的 s3-staging 目录，这里只断言迁移前备份本身。
    const backupNames = readdirSync(join(root, "backups")).filter((name) => name.startsWith("pre-migration-"));
    expect(backupNames).toHaveLength(1);
    expect(backupNames[0]).toContain(`pre-migration-v57-to-v${DATABASE_SCHEMA_VERSION}`);
    const backupDirectory = join(root, "backups", backupNames[0]!);
    expect(readDatabaseSchemaVersion(join(backupDirectory, "novel.db"))).toBe(57);
    expect(readFileSync(join(backupDirectory, "master.key"), "utf8").trim()).toBe(masterKey);
    expect(readFileSync(join(backupDirectory, "attachments", "fixture", "image.bin"), "utf8")).toBe("attachment-backup-fixture");
    expect(JSON.parse(readFileSync(join(backupDirectory, "backup.json"), "utf8"))).toMatchObject({
      fromSchemaVersion: 57,
      toSchemaVersion: DATABASE_SCHEMA_VERSION,
      databaseFile: "novel.db"
    });
    expect(running.runtime.database.get("SELECT MAX(version) AS version FROM schema_migrations")).toEqual({ version: DATABASE_SCHEMA_VERSION });
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

    const work = await fetch(`${running.url}/api/works`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "免登录协作作品", author: "dev", description: "" })
    }).then(async (response) => {
      expect(response.status).toBe(201);
      return response.json() as Promise<{ data: { id: string } }>;
    });
    const presence = await fetch(`${running.url}/api/works/${work.data.id}/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "54b43f7d-9778-4c8a-8b59-2ae64718cd59",
        page: { kind: "welcome" }
      })
    }).then(async (response) => {
      expect(response.status).toBe(200);
      return response.json() as Promise<{ data: { participants: Array<{ username: string }>; recentChanges: unknown[] } }>;
    });
    expect(presence.data).toEqual(expect.objectContaining({
      participants: expect.arrayContaining([
        expect.objectContaining({ username: "dev-bypass" })
      ]),
      recentChanges: expect.any(Array)
    }));
  });
});
