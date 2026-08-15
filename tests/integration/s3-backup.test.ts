import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

type CapturedRequest = {
  method: string;
  path: string;
  body: Buffer;
};

describe("S3 备份集成", () => {
  let runtime: Runtime;
  let server: Server;
  let baseUrl: string;
  let objects: Map<string, Buffer>;
  let requests: CapturedRequest[];
  let root: string;

  const imageStorageKey = "ab/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.webp";
  const imageContent = Buffer.from("fake-webp-content");

  beforeAll(async () => {
    objects = new Map();
    requests = [];
    server = createServer((incoming, outgoing) => {
      const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
      const path = decodeURIComponent(url.pathname);
      const bucketPrefix = "/backups/";
      const key = path.startsWith(bucketPrefix) ? path.slice(bucketPrefix.length) : path.slice(1);
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on("end", () => {
        const body = Buffer.concat(chunks);
        requests.push({ method: incoming.method ?? "GET", path: url.pathname, body });
        if (url.pathname.startsWith("/fail/")) {
          if (incoming.method === "HEAD") {
            outgoing.writeHead(404).end();
            return;
          }
          outgoing.writeHead(500, { "Content-Type": "application/xml" })
            .end("<Error><Code>SlowDown</Code><Message>slow down</Message></Error>");
          return;
        }
        if (incoming.method === "HEAD") {
          if (objects.has(key)) {
            outgoing.writeHead(200, { "Content-Length": String(objects.get(key)?.byteLength ?? 0) }).end();
          } else {
            outgoing.writeHead(404).end();
          }
          return;
        }
        if (incoming.method === "PUT") {
          objects.set(key, body);
          outgoing.writeHead(200).end();
          return;
        }
        if (incoming.method === "GET" && url.searchParams.get("list-type") === "2") {
          const prefix = url.searchParams.get("prefix") ?? "";
          const contents = [...objects.keys()].filter((objectKey) => objectKey.startsWith(prefix))
            .sort()
            .map((objectKey) => ({ Key: objectKey, Size: objects.get(objectKey)?.byteLength ?? 0 }));
          outgoing.writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify({ IsTruncated: false, Contents: contents }));
          return;
        }
        if (incoming.method === "DELETE") {
          objects.delete(key);
          outgoing.writeHead(204).end();
          return;
        }
        outgoing.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      const rejectStart = (error: Error) => reject(error);
      server.once("error", rejectStart);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", rejectStart);
        server.unref();
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试 S3 服务未监听");
    baseUrl = `http://127.0.0.1:${address.port}`;
    root = mkdtempSync(join(tmpdir(), "scriverse-s3-backup-test-"));
    const attachmentDirectory = join(root, "attachments");
    mkdirSync(join(attachmentDirectory, "ab"), { recursive: true });
    writeFileSync(join(attachmentDirectory, imageStorageKey), imageContent);
    runtime = createRuntime({
      databasePath: join(root, "novel.db"),
      attachmentDirectory,
      masterSecret: "s3-backup-test-master-secret-with-32-characters",
      disableUserAuth: true,
      serveUi: false
    });
  });

  afterAll(() => {
    runtime?.close();
    server?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("支持同时启用多个目标并同步到给定子目录或桶根目录", async () => {
    const firstTarget = await request(runtime.app)
      .post("/api/platform/s3-backup/targets")
      .send({
        name: "主目标",
        endpoint: baseUrl,
        region: "us-east-1",
        bucket: "backups",
        prefix: "tenant",
        enabled: true,
        accessKey: "AKIA1234567890ABCDEF",
        secretKey: "secret-key-for-s3-backup-integration-test"
      })
      .expect(201);
    expect(firstTarget.body.data).toMatchObject({
      name: "主目标",
      endpoint: baseUrl,
      bucket: "backups",
      prefix: "tenant",
      enabled: true,
      accessKeyMasked: "AKIA****CDEF",
      secretKeySet: true
    });
    expect(JSON.stringify(firstTarget.body.data)).not.toContain("secret-key-for-s3-backup-integration-test");
    expect(JSON.stringify(firstTarget.body.data)).not.toContain("encrypted_access_key");

    const secondTarget = await request(runtime.app)
      .post("/api/platform/s3-backup/targets")
      .send({
        name: "根目录目标",
        endpoint: baseUrl,
        region: "auto",
        bucket: "backups",
        enabled: true,
        accessKey: "AKIA1234567890ABCDEF",
        secretKey: "secret-key-for-s3-backup-integration-test"
      })
      .expect(201);
    expect(secondTarget.body.data.prefix).toBe("");

    const config = await request(runtime.app).get("/api/platform/s3-backup").expect(200);
    expect(config.body.data.targets).toHaveLength(2);
    expect(config.body.data.settings).toMatchObject({
      enabled: true,
      backupImages: true,
      scheduleTime: "03:00",
      retentionCount: 30
    });

    await request(runtime.app)
      .patch("/api/platform/s3-backup/settings")
      .send({ retentionCount: 1 })
      .expect(200);

    const firstRun = await runtime.s3Backup.runOnce("manual");
    expect(firstRun.status).toBe("success");
    expect(firstRun.summary).toContain("2 个备份目标");
    expect([...objects.keys()]).toEqual(expect.arrayContaining([
      `tenant/scriverse/img/${imageStorageKey}`,
      `scriverse/img/${imageStorageKey}`
    ]));
    expect([...objects.keys()].some((key) => /^tenant\/scriverse\/db\/novel-\d{8}T\d{6}\.\d{3}Z\.db$/u.test(key))).toBe(true);
    expect([...objects.keys()].some((key) => /^scriverse\/db\/novel-\d{8}T\d{6}\.\d{3}Z\.db$/u.test(key))).toBe(true);

    const firstImagePuts = requests.filter((item) => item.method === "PUT" && item.path.includes(`/scriverse/img/${imageStorageKey}`));
    expect(firstImagePuts).toHaveLength(2);

    const firstRunTargetIds = new Set(
      (firstRun.targetResults as Array<Record<string, unknown>>).map((item) => item.targetId)
    );
    expect(firstRunTargetIds.size).toBe(2);
    for (const item of firstRun.targetResults as Array<Record<string, unknown>>) {
      expect(item.status).toBe("success");
      expect(item.images).toMatchObject({ scanned: 1, skipped: 0, uploaded: 1 });
      expect(item.database as Record<string, unknown>).toMatchObject({ retentionDeleted: 0 });
    }
  });

  it("图片存在时跳过上传，并按留存个数删除最老数据库备份", async () => {
    const secondRun = await runtime.s3Backup.runOnce("manual");
    expect(secondRun.status).toBe("success");
    for (const item of secondRun.targetResults as Array<Record<string, unknown>>) {
      expect(item.status).toBe("success");
      expect(item.images).toMatchObject({ scanned: 1, skipped: 1, uploaded: 0 });
      expect(item.database as Record<string, unknown>).toMatchObject({ retentionDeleted: 1 });
    }
    const imagePuts = requests.filter((item) => item.method === "PUT" && item.path.includes("/scriverse/img/"));
    expect(imagePuts).toHaveLength(2);
    for (const prefix of ["tenant/scriverse/db", "scriverse/db"]) {
      const databaseKeys = [...objects.keys()].filter((key) => key.startsWith(`${prefix}/novel-`));
      expect(databaseKeys).toHaveLength(1);
    }
    const remainingDirs = new Set([...objects.keys()].map((key) => key.split("/").slice(0, 3).join("/")));
    expect([...remainingDirs]).not.toContain("tenant/scriverse/db/old");
  });

  it("S3 请求失败时保留失败目标与错误状态，等待前端 toast 确认", async () => {
    await runtime.s3Backup.updateSettings({ backupImages: false, retentionCount: 2 });
    await request(runtime.app)
      .post("/api/platform/s3-backup/targets")
      .send({
        name: "故障目标",
        endpoint: `${baseUrl}/fail`,
        region: "us-east-1",
        bucket: "backups",
        enabled: true,
        accessKey: "AKIA1234567890ABCDEF",
        secretKey: "secret-key-for-s3-backup-integration-test"
      })
      .expect(201);

    const run = await runtime.s3Backup.runOnce("manual");
    expect(run.status).toBe("partial");
    expect(run.summary).toContain("成功 2 个目标，失败 1 个目标");
    const failedTarget = (run.targetResults as Array<Record<string, unknown>>)
      .find((item) => item.targetName === "故障目标");
    expect(failedTarget?.status).toBe("failed");
    const failure = failedTarget?.error as Record<string, unknown>;
    expect(failure).toMatchObject({
      stage: "database",
      status: 500,
      code: "SlowDown"
    });
    expect(String(failure.message)).toContain("slow down");
    expect(run.failureNotified).toBe(false);

    const latest = runtime.s3Backup.getLatestRun();
    expect(latest?.status).toBe("partial");
    const acknowledged = await runtime.s3Backup.markFailureNotified(String(latest?.id));
    expect(acknowledged.failureNotified).toBe(true);
  });
});
