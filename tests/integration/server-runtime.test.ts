import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isDevelopmentAuthBypassEnabled, resolveRuntimeSecurity } from "../../src/security.js";
import {
  isDevelopmentServer,
  isLoopbackHost,
  PRE_MIGRATION_BACKUP_RETENTION_ENV,
  STARTUP_RETRY_LIMIT_ENV,
  STARTUP_RETRY_STATE_FILENAME,
  resolvePreMigrationBackupRetention,
  resolveStartupRetryLimit,
  startLocalServer,
  type RunningLocalServer
} from "../../src/server-runtime.js";
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
  it("仅在 APP_ALLOW_REGISTRATION 明确开启时开放注册", () => {
    const setupToken = "server-runtime-setup-token-with-at-least-32-characters";
    expect(resolveRuntimeSecurity({}).allowRegistration).toBe(false);
    expect(resolveRuntimeSecurity({ APP_ALLOW_REGISTRATION: "false" }).allowRegistration).toBe(false);
    expect(resolveRuntimeSecurity({ APP_ALLOW_REGISTRATION: "0" }).allowRegistration).toBe(false);
    expect(resolveRuntimeSecurity({ APP_ALLOW_REGISTRATION: "2" }).allowRegistration).toBe(false);
    expect(resolveRuntimeSecurity({ APP_ALLOW_REGISTRATION: "TRUE" }).allowRegistration).toBe(false);
    expect(() => resolveRuntimeSecurity({ APP_ALLOW_REGISTRATION: "true" })).toThrow("APP_SETUP_TOKEN");
    expect(() => resolveRuntimeSecurity({ APP_ALLOW_REGISTRATION: "1" })).toThrow("APP_SETUP_TOKEN");
    expect(resolveRuntimeSecurity({
      APP_ALLOW_REGISTRATION: "true",
      APP_SETUP_TOKEN: setupToken
    }).allowRegistration).toBe(true);
    expect(resolveRuntimeSecurity({ APP_ALLOW_REGISTRATION: "1", APP_SETUP_TOKEN: setupToken }).allowRegistration).toBe(true);
  });

  it("允许布尔环境变量使用 0 和 1", () => {
    expect(resolveRuntimeSecurity({ NODE_ENV: "production", APP_ALLOW_PRIVATE_AI_ENDPOINTS: "true" }).allowPrivateAiEndpoints).toBe(true);
    expect(resolveRuntimeSecurity({ NODE_ENV: "production", APP_ALLOW_PRIVATE_AI_ENDPOINTS: "1" }).allowPrivateAiEndpoints).toBe(true);
    expect(resolveRuntimeSecurity({ NODE_ENV: "production", APP_ALLOW_PRIVATE_AI_ENDPOINTS: "false" }).allowPrivateAiEndpoints).toBe(false);
    expect(resolveRuntimeSecurity({ NODE_ENV: "production", APP_ALLOW_PRIVATE_AI_ENDPOINTS: "0" }).allowPrivateAiEndpoints).toBe(false);
    expect(resolveRuntimeSecurity({ NODE_ENV: "production", APP_ALLOW_PRIVATE_AI_ENDPOINTS: "2" }).allowPrivateAiEndpoints).toBe(false);
    expect(resolveRuntimeSecurity({ NODE_ENV: "development", APP_ALLOW_PRIVATE_AI_ENDPOINTS: "false" }).allowPrivateAiEndpoints).toBe(false);
    expect(resolveRuntimeSecurity({ NODE_ENV: "development", APP_ALLOW_PRIVATE_AI_ENDPOINTS: "0" }).allowPrivateAiEndpoints).toBe(false);
    expect(resolveRuntimeSecurity({ NODE_ENV: "development", APP_ALLOW_PRIVATE_AI_ENDPOINTS: "2" }).allowPrivateAiEndpoints).toBe(true);
    expect(resolveRuntimeSecurity({ APP_TRUST_PROXY: "2" }).trustProxy).toBe(2);
  });

  it("仅在非生产环境显式开启时允许开发免登录", () => {
    expect(isDevelopmentAuthBypassEnabled({ NODE_ENV: "development", APP_DEV_SKIP_AUTH: "true" }, false)).toBe(true);
    expect(isDevelopmentAuthBypassEnabled({ NODE_ENV: "development", APP_DEV_SKIP_AUTH: "1" }, false)).toBe(true);
    expect(isDevelopmentAuthBypassEnabled({ NODE_ENV: "production", APP_DEV_SKIP_AUTH: "true" }, false)).toBe(false);
    expect(isDevelopmentAuthBypassEnabled({ NODE_ENV: "development", APP_DEV_SKIP_AUTH: "false" }, false)).toBe(false);
    expect(isDevelopmentAuthBypassEnabled({ NODE_ENV: "development", APP_DEV_SKIP_AUTH: "0" }, false)).toBe(false);
    expect(isDevelopmentAuthBypassEnabled({ NODE_ENV: "development", APP_DEV_SKIP_AUTH: "2" }, false)).toBe(false);
    expect(isDevelopmentAuthBypassEnabled({ NODE_ENV: "development", APP_DEV_SKIP_AUTH: "true" }, true)).toBe(false);
    expect(isDevelopmentAuthBypassEnabled({ NODE_ENV: "development", APP_DEV_SKIP_AUTH: "true", SCRIVERSE_RUNTIME: "container" })).toBe(false);
  });

  it("识别开发服务启动方式", () => {
    expect(isDevelopmentServer({})).toBe(false);
    expect(isDevelopmentServer({ NODE_ENV: "production", npm_lifecycle_event: "start" })).toBe(false);
    expect(isDevelopmentServer({ NODE_ENV: "development" })).toBe(true);
    expect(isDevelopmentServer({ npm_lifecycle_event: "dev" })).toBe(true);
  });

  it("解析迁移备份保留数量并限制最低值", () => {
    expect(resolvePreMigrationBackupRetention({})).toBe(5);
    expect(resolvePreMigrationBackupRetention({ [PRE_MIGRATION_BACKUP_RETENTION_ENV]: "1" })).toBe(2);
    expect(resolvePreMigrationBackupRetention({ [PRE_MIGRATION_BACKUP_RETENTION_ENV]: "2.9" })).toBe(2);
    expect(resolvePreMigrationBackupRetention({ [PRE_MIGRATION_BACKUP_RETENTION_ENV]: "8.9" })).toBe(8);
    expect(resolvePreMigrationBackupRetention({ [PRE_MIGRATION_BACKUP_RETENTION_ENV]: "invalid" })).toBe(5);
  });

  it("解析启动失败重试上限", () => {
    expect(resolveStartupRetryLimit({})).toBe(2);
    expect(resolveStartupRetryLimit({ [STARTUP_RETRY_LIMIT_ENV]: "1" })).toBe(1);
    expect(resolveStartupRetryLimit({ [STARTUP_RETRY_LIMIT_ENV]: "2.9" })).toBe(2);
    expect(resolveStartupRetryLimit({ [STARTUP_RETRY_LIMIT_ENV]: "0" })).toBe(2);
    expect(resolveStartupRetryLimit({ [STARTUP_RETRY_LIMIT_ENV]: "invalid" })).toBe(2);
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

  it("连续启动失败达到上限后阻断后续重试", async () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-startup-retry-limit-"));
    roots.push(root);
    const options = {
      host: "0.0.0.0",
      port: 0,
      dataDirectory: root,
      databasePath: join(root, "novel.db"),
      env: { NODE_ENV: "development", APP_DEV_SKIP_AUTH: "true", [STARTUP_RETRY_LIMIT_ENV]: "2" }
    } as const;

    await expect(startLocalServer(options)).rejects.toThrow("APP_DEV_SKIP_AUTH 仅允许绑定本机回环地址");
    await expect(startLocalServer(options)).rejects.toThrow("APP_DEV_SKIP_AUTH 仅允许绑定本机回环地址");
    await expect(startLocalServer(options)).rejects.toThrow("Startup retry limit reached");

    expect(JSON.parse(readFileSync(join(root, STARTUP_RETRY_STATE_FILENAME), "utf8"))).toMatchObject({ attempts: 2 });
  });

  it("启动异常重试不会重复生成超过上限的迁移备份", async () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-startup-retry-backup-"));
    roots.push(root);
    const databasePath = join(root, "novel.db");
    const legacy = new Database(databasePath);
    legacy.raw.exec("DROP TABLE attachment_cleanup_queue; DROP TABLE attachment_access_modules; DELETE FROM schema_migrations WHERE version >= 58");
    legacy.close();

    const options = {
      host: "0.0.0.0",
      port: 0,
      dataDirectory: root,
      databasePath,
      env: { NODE_ENV: "development", APP_DEV_SKIP_AUTH: "true", [STARTUP_RETRY_LIMIT_ENV]: "2" }
    } as const;
    const expectedFailure = "APP_DEV_SKIP_AUTH 仅允许绑定本机回环地址";

    await expect(startLocalServer(options)).rejects.toThrow(expectedFailure);
    await expect(startLocalServer(options)).rejects.toThrow(expectedFailure);
    const backupsDirectory = join(root, "backups");
    const backupNamesAfterFailures = readdirSync(backupsDirectory).filter((name) => name.startsWith("pre-migration-v"));
    expect(backupNamesAfterFailures).toHaveLength(2);
    expect(backupNamesAfterFailures.every((name) => existsSync(join(backupsDirectory, name, "backup.json")))).toBe(true);

    await expect(startLocalServer(options)).rejects.toThrow("Startup retry limit reached");
    const backupNamesAfterBlock = readdirSync(backupsDirectory).filter((name) => name.startsWith("pre-migration-v"));
    expect(backupNamesAfterBlock).toEqual(backupNamesAfterFailures);
    expect(JSON.parse(readFileSync(join(root, STARTUP_RETRY_STATE_FILENAME), "utf8"))).toMatchObject({ attempts: 2 });
  });

  it("服务器正常监听后清理启动失败重试次数", async () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-startup-retry-reset-"));
    roots.push(root);
    const failedOptions = {
      host: "0.0.0.0",
      port: 0,
      dataDirectory: root,
      databasePath: join(root, "novel.db"),
      env: { NODE_ENV: "development", APP_DEV_SKIP_AUTH: "true", [STARTUP_RETRY_LIMIT_ENV]: "2" }
    } as const;
    await expect(startLocalServer(failedOptions)).rejects.toThrow("APP_DEV_SKIP_AUTH 仅允许绑定本机回环地址");
    expect(existsSync(join(root, STARTUP_RETRY_STATE_FILENAME))).toBe(true);

    const running = await startLocalServer({
      host: "127.0.0.1",
      port: 0,
      dataDirectory: root,
      databasePath: join(root, "novel.db"),
      env: { NODE_ENV: "test", [STARTUP_RETRY_LIMIT_ENV]: "2" }
    });
    runningServers.push(running);
    expect(existsSync(join(root, STARTUP_RETRY_STATE_FILENAME))).toBe(false);
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
    const snapshot = running.runtime.database.createSnapshotBuffer();
    expect(snapshot.subarray(0, 16).toString("utf8")).toBe("SQLite format 3\u0000");
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

    const backupNames = readdirSync(join(root, "backups"));
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

  it("启动时清理超出配置数量的最旧迁移备份", async () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-migration-backup-retention-"));
    roots.push(root);
    const databasePath = join(root, "novel.db");
    const legacy = new Database(databasePath);
    legacy.raw.exec("DROP TABLE attachment_cleanup_queue; DROP TABLE attachment_access_modules; DELETE FROM schema_migrations WHERE version >= 58");
    legacy.close();

    const backupsDirectory = join(root, "backups");
    const baseTime = Date.parse("2026-01-01T00:00:00.000Z");
    const backupNames = Array.from({ length: 4 }, (_, index) => `pre-migration-v57-to-v${DATABASE_SCHEMA_VERSION}-2026-01-01T00-00-0${index}.000Z`);
    for (const [index, backupName] of backupNames.entries()) {
      const backupDirectory = join(backupsDirectory, backupName);
      mkdirSync(backupDirectory, { recursive: true });
      writeFileSync(join(backupDirectory, "backup.json"), JSON.stringify({ fromSchemaVersion: 57 }));
      const modifiedAt = new Date(baseTime + index * 1000);
      utimesSync(backupDirectory, modifiedAt, modifiedAt);
    }

    const running = await startLocalServer({
      host: "127.0.0.1",
      port: 0,
      dataDirectory: root,
      databasePath,
      env: { NODE_ENV: "test", [PRE_MIGRATION_BACKUP_RETENTION_ENV]: "3" }
    });
    runningServers.push(running);

    const retainedNames = readdirSync(backupsDirectory).filter((name) => name.startsWith("pre-migration-v"));
    expect(retainedNames).toHaveLength(3);
    expect(retainedNames).not.toContain(backupNames[0]);
    expect(retainedNames).not.toContain(backupNames[1]);
    expect(retainedNames).toEqual(expect.arrayContaining([backupNames[2], backupNames[3]]));
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
