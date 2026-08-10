import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { decryptObject, isEncryptedEnvelope } from "../../src/backup-encryption.js";
import { createLogger, type LogRecord } from "../../src/logger.js";
import type { S3BackupConnection, S3ListedObject, S3ObjectClient } from "../../src/s3-backup.js";

type StoredObject = {
  body: Buffer;
  contentType: string;
  metadata?: Record<string, string>;
  lastModified: Date;
};

class FakeS3Client implements S3ObjectClient {
  readonly objects = new Map<string, StoredObject>();
  readonly events: string[] = [];
  readonly deletedKeys: string[] = [];
  closed = false;
  failure: Error | null = null;

  async objectExists(_bucket: string, key: string): Promise<boolean> {
    this.events.push(`head:${key}`);
    return this.objects.has(key);
  }

  async putObject(input: { bucket: string; key: string; body: Buffer; contentType: string; metadata?: Record<string, string> }): Promise<void> {
    this.events.push(`put:${input.key}`);
    if (this.failure) throw this.failure;
    this.objects.set(input.key, {
      body: Buffer.from(input.body),
      contentType: input.contentType,
      metadata: input.metadata,
      lastModified: new Date("2026-08-04T03:04:05.678Z")
    });
  }

  async listObjects(_bucket: string, prefix: string): Promise<S3ListedObject[]> {
    this.events.push(`list:${prefix}`);
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, lastModified: value.lastModified }));
  }

  async deleteObjects(_bucket: string, keys: string[]): Promise<void> {
    this.events.push(`delete:${keys.join(",")}`);
    for (const key of keys) {
      this.deletedKeys.push(key);
      this.objects.delete(key);
    }
  }

  close(): void {
    this.closed = true;
  }
}

function testRuntime(options: {
  clientFactory: (connection: S3BackupConnection) => S3ObjectClient;
  loggerRecords?: LogRecord[];
  requestTimeoutMs?: number;
}): Runtime {
  return createRuntime({
    databasePath: ":memory:",
    masterSecret: "s3-execution-test-master-secret-with-enough-length",
    disableUserAuth: true,
    serveUi: false,
    backupOptions: {
      clientFactory: options.clientFactory,
      snapshotDatabase: () => Buffer.from("consistent-database-snapshot"),
      requestTimeoutMs: options.requestTimeoutMs,
      now: () => new Date("2026-08-04T03:04:05.678Z"),
      logger: createLogger({
        level: "debug",
        now: () => new Date("2026-08-04T03:04:05.678Z"),
        write: (_level, record) => options.loggerRecords?.push(record)
      })
    }
  });
}

describe("S3 数据库与图片备份执行", () => {
  const runtimes: Runtime[] = [];

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.close();
  });

  it("上传时间戳数据库、跳过已有图片并只清理最老数据库", async () => {
    const client = new FakeS3Client();
    const runtime = testRuntime({ clientFactory: () => client });
    runtimes.push(runtime);
    const work = runtime.store.createWork({ title: "备份测试作品" });
    const cover = Buffer.from("cover-image-content");
    runtime.store.setWorkCover(String(work.id), "image/png", cover);

    const attachment = Buffer.from("attachment-image-content");
    const attachmentHash = createHash("sha256").update(attachment).digest("hex");
    const storageKey = `${attachmentHash.slice(0, 2)}/${attachmentHash}.png`;
    runtime.database.run(
      `INSERT INTO attachments (
        id, work_id, original_name, original_mime_type, stored_mime_type, original_byte_length, stored_byte_length,
        original_sha256, stored_sha256, storage_key, width, height, page_count, animated, created_at, created_by_user_id
      ) VALUES ('attachment-backup', ?, 'image.png', 'image/png', 'image/png', ?, ?, ?, ?, ?, 1, 1, 1, 0, ?, NULL)`,
      String(work.id),
      attachment.byteLength,
      attachment.byteLength,
      attachmentHash,
      attachmentHash,
      storageKey,
      "2026-08-04T00:00:00.000Z"
    );
    runtime.attachmentStorage.read = async (key) => {
      expect(key).toBe(storageKey);
      return attachment;
    };

    const rootPrefix = "nightly/scriverse";
    const attachmentObjectKey = `${rootPrefix}/img/${storageKey}`;
    client.objects.set(attachmentObjectKey, {
      body: attachment,
      contentType: "image/png",
      lastModified: new Date("2026-08-01T00:00:00.000Z")
    });
    client.objects.set(`${rootPrefix}/db/scriverse-20260801T000000000Z-a0d00001.db`, {
      body: Buffer.from("old-1"), contentType: "application/vnd.sqlite3", lastModified: new Date("2026-08-01T00:00:00.000Z")
    });
    client.objects.set(`${rootPrefix}/db/scriverse-20260802T000000000Z-a0d00002.db`, {
      body: Buffer.from("old-2"), contentType: "application/vnd.sqlite3", lastModified: new Date("2026-08-02T00:00:00.000Z")
    });
    client.objects.set(`${rootPrefix}/db/manual.db`, {
      body: Buffer.from("manual"), contentType: "application/vnd.sqlite3", lastModified: new Date("2026-08-01T00:00:00.000Z")
    });
    client.objects.set(`${rootPrefix}/db/archive/scriverse-20260801T000000000Z-a0d00003.db`, {
      body: Buffer.from("nested"), contentType: "application/vnd.sqlite3", lastModified: new Date("2026-08-01T00:00:00.000Z")
    });

    const target = runtime.backups.createTarget({
      name: "夜间归档",
      endpoint: "https://s3.example.com",
      bucket: "backup-bucket",
      basePath: "nightly",
      accessKeyId: "access-private",
      secretAccessKey: "secret-private",
      enabled: true,
      backupImages: true,
      retentionCount: 2
    });
    const run = await runtime.backups.runTarget(target.id, "manual");

    expect(run).toMatchObject({
      status: "succeeded",
      imagesUploaded: 1,
      imagesSkipped: 1,
      databasesDeleted: 1,
      errorMessage: null
    });
    expect(run.databaseKey).toMatch(/^nightly\/scriverse\/db\/scriverse-20260804T030405678Z-[a-f0-9]{8}\.db$/u);
    expect(client.objects.get(String(run.databaseKey))).toMatchObject({
      body: Buffer.from("consistent-database-snapshot"),
      contentType: "application/vnd.sqlite3"
    });
    expect(client.objects.get(`${rootPrefix}/master.key`)?.body.toString()).toBe("s3-execution-test-master-secret-with-enough-length");
    const coverHash = createHash("sha256").update(cover).digest("hex");
    expect(client.objects.get(`${rootPrefix}/img/${coverHash.slice(0, 2)}/${coverHash}.png`)?.body).toEqual(cover);
    expect(client.deletedKeys).toEqual([`${rootPrefix}/db/scriverse-20260801T000000000Z-a0d00001.db`]);
    expect(client.objects.has(`${rootPrefix}/db/manual.db`)).toBe(true);
    expect(client.objects.has(`${rootPrefix}/db/archive/scriverse-20260801T000000000Z-a0d00003.db`)).toBe(true);
    expect(client.deletedKeys.every((key) => !key.includes("/img/"))).toBe(true);
    expect(client.closed).toBe(true);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("图片开关关闭时只上传数据库", async () => {
    const client = new FakeS3Client();
    const runtime = testRuntime({ clientFactory: () => client });
    runtimes.push(runtime);
    const target = runtime.backups.createTarget({
      name: "仅数据库",
      endpoint: "https://s3.example.com",
      bucket: "backup-bucket",
      accessKeyId: "access-private",
      secretAccessKey: "secret-private",
      enabled: true,
      backupImages: false
    });

    const run = await runtime.backups.runTarget(target.id, "scheduled");

    expect(run).toMatchObject({ status: "succeeded", imagesUploaded: 0, imagesSkipped: 0 });
    expect(client.events.some((event) => event.startsWith("head:"))).toBe(false);
    expect([...client.objects.keys()]).toEqual([`${target.rootPrefix}/master.key`, run.databaseKey]);
  });

  it("开启后加密数据库、恢复密钥与图片，关闭后恢复明文且保留 KEK", async () => {
    const client = new FakeS3Client();
    const runtime = testRuntime({ clientFactory: () => client });
    runtimes.push(runtime);
    const work = runtime.store.createWork({ title: "加密备份测试作品" });
    const encryptedCover = Buffer.from("encrypted-cover-content");
    runtime.store.setWorkCover(String(work.id), "image/png", encryptedCover);
    const enabled = runtime.backups.setEncryptionEnabled(true);
    expect(enabled.key).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const key = String(enabled.key);
    const target = runtime.backups.createTarget({
      name: "加密目标",
      endpoint: "https://encrypted.example.com",
      bucket: "backup-bucket",
      accessKeyId: "access-private",
      secretAccessKey: "secret-private",
      enabled: true,
      backupImages: true
    });

    const encryptedRun = await runtime.backups.runTarget(target.id, "manual");
    expect(encryptedRun.status).toBe("succeeded");
    const databaseObject = client.objects.get(String(encryptedRun.databaseKey));
    const masterKeyObject = client.objects.get(`${target.rootPrefix}/master.key`);
    const encryptedCoverHash = createHash("sha256").update(encryptedCover).digest("hex");
    const coverObject = client.objects.get(`${target.rootPrefix}/img/${encryptedCoverHash.slice(0, 2)}/${encryptedCoverHash}.png`);
    for (const object of [databaseObject, masterKeyObject, coverObject]) {
      expect(object?.contentType).toBe("application/octet-stream");
      expect(isEncryptedEnvelope(object?.body ?? Buffer.alloc(0))).toBe(true);
    }
    expect(decryptObject(databaseObject!.body, key)).toEqual(Buffer.from("consistent-database-snapshot"));
    expect(decryptObject(masterKeyObject!.body, key).toString()).toBe("s3-execution-test-master-secret-with-enough-length");
    expect(decryptObject(coverObject!.body, key)).toEqual(encryptedCover);
    expect(coverObject?.metadata).toEqual({ sha256: encryptedCoverHash });

    const disabled = runtime.backups.setEncryptionEnabled(false);
    expect(disabled).toEqual({ enabled: false, keyConfiguredAt: enabled.keyConfiguredAt });
    const plaintextCover = Buffer.from("plaintext-cover-content");
    runtime.store.setWorkCover(String(work.id), "image/png", plaintextCover);
    const plaintextRun = await runtime.backups.runTarget(target.id, "manual");
    const plaintextDatabaseObject = client.objects.get(String(plaintextRun.databaseKey));
    const plaintextCoverHash = createHash("sha256").update(plaintextCover).digest("hex");
    const plaintextCoverObject = client.objects.get(`${target.rootPrefix}/img/${plaintextCoverHash.slice(0, 2)}/${plaintextCoverHash}.png`);
    expect(plaintextDatabaseObject).toMatchObject({
      body: Buffer.from("consistent-database-snapshot"),
      contentType: "application/vnd.sqlite3"
    });
    expect(client.objects.get(`${target.rootPrefix}/master.key`)?.body.toString()).toBe("s3-execution-test-master-secret-with-enough-length");
    expect(plaintextCoverObject).toMatchObject({ body: plaintextCover, contentType: "image/png" });
    expect(runtime.backups.setEncryptionEnabled(true)).toEqual({ enabled: true, keyConfiguredAt: enabled.keyConfiguredAt });
  });

  it("单个目标失败后继续顺序执行其他目标，并完整记录脱敏配置及服务端结果", async () => {
    const records: LogRecord[] = [];
    const executionOrder: string[] = [];
    const clients = new Map<string, FakeS3Client>();
    const runtime = testRuntime({
      loggerRecords: records,
      clientFactory: (connection) => {
        executionOrder.push(connection.endpoint);
        const client = new FakeS3Client();
        if (connection.endpoint.includes("failed")) {
          const failure = new Error(`Access denied for ${connection.accessKeyId} and ${connection.secretAccessKey}`) as Error & Record<string, unknown>;
          failure.name = "AccessDenied";
          failure.Code = "AccessDenied";
          failure.RequestId = "request-123";
          failure.$metadata = { httpStatusCode: 403, requestId: "request-123", attempts: 3 };
          failure.$response = {
            statusCode: 403,
            statusMessage: "Forbidden",
            headers: { "x-amz-request-id": "request-123", authorization: "must-not-log" }
          };
          client.failure = failure;
        }
        clients.set(connection.endpoint, client);
        return client;
      }
    });
    runtimes.push(runtime);
    const encryptionKey = String(runtime.backups.setEncryptionEnabled(true).key);
    for (const [name, endpoint] of [
      ["第一个", "https://first.example.com"],
      ["失败目标", "https://failed.example.com"],
      ["第三个", "https://third.example.com"]
    ] as const) {
      runtime.backups.createTarget({
        name,
        endpoint,
        region: "test-region-1",
        bucket: "backup-bucket",
        basePath: "cluster-a",
        accessKeyId: `access-${name}`,
        secretAccessKey: `secret-${name}`,
        enabled: true,
        backupImages: false,
        scheduleTime: "03:04",
        retentionCount: 9
      });
    }

    const runs = await runtime.backups.runEnabledTargets("scheduled");

    expect(executionOrder).toEqual([
      "https://first.example.com",
      "https://failed.example.com",
      "https://third.example.com"
    ]);
    expect(runs.map((run) => run.status)).toEqual(["succeeded", "failed", "succeeded"]);
    expect(runs[1]?.serverResponse).toMatchObject({
      name: "AccessDenied",
      Code: "AccessDenied",
      RequestId: "request-123",
      $metadata: { httpStatusCode: 403, requestId: "request-123", attempts: 3 },
      httpResponse: { statusCode: 403, statusMessage: "Forbidden", headers: { "x-amz-request-id": "request-123", authorization: "[REDACTED]" } }
    });
    const failureLog = records.find((record) => record.event === "backup.s3_target.failed");
    expect(failureLog).toMatchObject({
      target: {
        name: "失败目标",
        endpoint: "https://failed.example.com",
        region: "test-region-1",
        bucket: "backup-bucket",
        basePath: "cluster-a",
        rootPrefix: "cluster-a/scriverse",
        backupImages: false,
        scheduleTime: "03:04",
        retentionCount: 9
      },
      serverResponse: {
        Code: "AccessDenied",
        RequestId: "request-123",
        httpResponse: { statusCode: 403 }
      }
    });
    const serialized = JSON.stringify({ runs, records });
    for (const secret of ["access-失败目标", "secret-失败目标", "must-not-log", encryptionKey]) {
      expect(serialized).not.toContain(secret);
    }
    expect(clients.get("https://failed.example.com")?.closed).toBe(true);
  });

  it("S3 请求超时后结束当前目标并关闭客户端", async () => {
    let closed = false;
    const hangingClient: S3ObjectClient = {
      objectExists: async () => false,
      putObject: async () => new Promise<void>(() => undefined),
      listObjects: async () => [],
      deleteObjects: async () => undefined,
      close: () => {
        closed = true;
      }
    };
    const runtime = testRuntime({ clientFactory: () => hangingClient, requestTimeoutMs: 10 });
    runtimes.push(runtime);
    const target = runtime.backups.createTarget({
      name: "超时目标",
      endpoint: "https://timeout.example.com",
      bucket: "backup-bucket",
      accessKeyId: "access-timeout",
      secretAccessKey: "secret-timeout",
      enabled: true,
      backupImages: false
    });

    const run = await runtime.backups.runTarget(target.id, "manual");

    expect(run.status).toBe("failed");
    expect(run.errorMessage).toContain("上传 CredentialVault 恢复密钥超时");
    expect(closed).toBe(true);
  });
});
