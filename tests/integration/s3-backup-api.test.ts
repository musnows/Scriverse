import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createTestRuntime } from "../helpers.js";
import type { Runtime } from "../../src/app.js";

type MockObjectStore = Map<string, Buffer>;

function createMockS3(options: { fail?: boolean; existing?: Record<string, string> } = {}): {
  server: Server;
  objects: MockObjectStore;
  requests: Array<{ method: string; path: string; authorization: string }>;
  listen: () => Promise<string>;
  close: () => Promise<void>;
} {
  const objects: MockObjectStore = new Map(
    Object.entries(options.existing ?? {}).map(([key, value]) => [key, Buffer.from(value)])
  );
  const requests: Array<{ method: string; path: string; authorization: string }> = [];
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "127.0.0.1"}`);
    const authorization = String(incoming.headers.authorization ?? "");
    requests.push({ method: incoming.method ?? "", path: `${url.pathname}${url.search}`, authorization });
    if (options.fail) {
      outgoing.writeHead(500, { "content-type": "application/xml" });
      outgoing.end("<Error><Code>InternalError</Code><Message>mock s3 exploded</Message></Error>");
      return;
    }
    const segments = url.pathname.replace(/^\/+/u, "").split("/").map((part) => decodeURIComponent(part));
    const key = segments.slice(1).join("/");
    if (incoming.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((item) => item.startsWith(prefix));
      outgoing.writeHead(200, { "content-type": "application/xml" });
      outgoing.end(`<?xml version="1.0"?><ListBucketResult>${keys.map((item) => `<Contents><Key>${item}</Key></Contents>`).join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`);
      return;
    }
    if (incoming.method === "HEAD") {
      outgoing.writeHead(objects.has(key) ? 200 : 404);
      outgoing.end();
      return;
    }
    if (incoming.method === "PUT") {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on("end", () => {
        objects.set(key, Buffer.concat(chunks));
        outgoing.writeHead(200);
        outgoing.end();
      });
      return;
    }
    if (incoming.method === "DELETE") {
      objects.delete(key);
      outgoing.writeHead(204);
      outgoing.end();
      return;
    }
    outgoing.writeHead(405);
    outgoing.end();
  });
  return {
    server,
    objects,
    requests,
    listen: () => new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${address.port}`);
      });
      server.once("error", reject);
    }),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function seedImage(runtime: Runtime, storageKey: string, content = "image-bytes"): Promise<void> {
  const path = join(runtime.attachmentStorage.rootDirectory, storageKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

describe("系统 S3 备份 API", () => {
  const runtimes: Runtime[] = [];
  const mocks: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) runtime.close();
    await Promise.all(mocks.splice(0).map((mock) => mock.close()));
  });

  it("拒绝未登录用户访问备份设置", async () => {
    const { createRuntime } = await import("../../src/app.js");
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "test-master-secret-with-at-least-32-characters",
      serveUi: false
    });
    runtimes.push(runtime);
    await request(runtime.app).get("/api/platform/s3-backup").expect(401);
  });

  it("保存多个目标并依次备份数据库，已存在图片跳过，超出留存后删除最旧数据库", async () => {
    const first = createMockS3({
      existing: {
        "scriverse/db/novel-20200101T000000Z.db": "old-a",
        "scriverse/db/novel-20200102T000000Z.db": "old-b",
        "scriverse/img/ab/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp": "keep"
      }
    });
    const second = createMockS3();
    mocks.push(first, second);
    const firstEndpoint = await first.listen();
    const secondEndpoint = await second.listen();
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const storageKey = "ab/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp";
    await seedImage(runtime, storageKey, "new-image");

    await request(runtime.app).patch("/api/platform/s3-backup").send({
      includeImages: true,
      scheduleEnabled: false,
      scheduleTime: "03:30",
      retentionCount: 2
    }).expect(200);

    const created = await request(runtime.app).post("/api/platform/s3-backup/targets").send({
      name: "主存储",
      endpoint: firstEndpoint,
      region: "us-east-1",
      bucket: "scriverse-backup",
      prefix: "",
      forcePathStyle: true,
      enabled: true,
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    }).expect(201);
    expect(created.body.data.accessKeyHint).not.toContain("AKIAEXAMPLE");
    expect(created.body.data.secretAccessKey).toBeUndefined();
    expect(created.body.data.accessKeyId).toBeUndefined();

    await request(runtime.app).post("/api/platform/s3-backup/targets").send({
      name: "副本存储",
      endpoint: secondEndpoint,
      region: "us-east-1",
      bucket: "scriverse-copy",
      prefix: "offsite",
      forcePathStyle: true,
      enabled: true,
      accessKeyId: "AKIASECOND",
      secretAccessKey: "second-secret-key-value"
    }).expect(201);

    const run = await request(runtime.app).post("/api/platform/s3-backup/run").send({}).expect(200);
    expect(run.body.data.status).toBe("success");
    expect(run.body.data.targets).toHaveLength(2);
    expect(run.body.data.targets[0].skippedImages).toBe(1);
    expect(run.body.data.targets[0].uploadedImages).toBe(0);
    expect(run.body.data.targets[1].uploadedImages).toBe(1);
    expect(run.body.data.targets[1].databaseKey).toContain("offsite/scriverse/db/novel-");

    const firstDbKeys = [...first.objects.keys()].filter((key) => key.startsWith("scriverse/db/"));
    expect(firstDbKeys.some((key) => key.startsWith("scriverse/db/novel-") && key.endsWith(".db"))).toBe(true);
    expect(first.objects.has("scriverse/db/novel-20200101T000000Z.db")).toBe(false);
    expect(first.objects.has("scriverse/db/novel-20200102T000000Z.db")).toBe(true);
    expect(first.objects.has(`scriverse/img/${storageKey}`)).toBe(true);
    expect([...second.objects.keys()].some((key) => key.startsWith("offsite/scriverse/db/"))).toBe(true);
    expect(first.requests.every((item) => item.authorization.startsWith("AWS4-HMAC-SHA256 "))).toBe(true);
    expect(JSON.stringify(run.body)).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(JSON.stringify(run.body)).not.toContain("second-secret-key-value");
  });

  it("不勾选图片时只上传数据库，并在 S3 失败时返回服务端响应且不泄露密钥", async () => {
    const mock = createMockS3({ fail: true });
    mocks.push(mock);
    const endpoint = await mock.listen();
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    await seedImage(runtime, "ab/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png");
    await request(runtime.app).patch("/api/platform/s3-backup").send({ includeImages: false, retentionCount: 3 }).expect(200);
    await request(runtime.app).post("/api/platform/s3-backup/targets").send({
      name: "故障存储",
      endpoint,
      region: "us-east-1",
      bucket: "broken-bucket",
      forcePathStyle: true,
      enabled: true,
      accessKeyId: "AKIAFAIL",
      secretAccessKey: "super-secret-s3-key"
    }).expect(201);

    const failed = await request(runtime.app).post("/api/platform/s3-backup/run").send({}).expect(502);
    expect(failed.body.error.code).toBe("S3_BACKUP_FAILED");
    expect(failed.body.error.message).toContain("mock s3 exploded");
    expect(failed.body.error.details.targets[0].endpoint).toBe(endpoint);
    expect(failed.body.error.details.targets[0].bucket).toBe("broken-bucket");
    expect(failed.body.error.details.targets[0].responseBody).toContain("InternalError");
    expect(JSON.stringify(failed.body)).not.toContain("super-secret-s3-key");
    expect(JSON.stringify(failed.body)).not.toContain("AKIAFAIL");
    expect(mock.requests.some((item) => item.method === "PUT" && item.path.includes("/scriverse/img/"))).toBe(false);
  });

  it("关闭图片备份后只上传数据库快照", async () => {
    const mock = createMockS3();
    mocks.push(mock);
    const endpoint = await mock.listen();
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    await seedImage(runtime, "ab/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.gif", "gif-bytes");
    await request(runtime.app).patch("/api/platform/s3-backup").send({ includeImages: false }).expect(200);
    await request(runtime.app).post("/api/platform/s3-backup/targets").send({
      name: "仅数据库",
      endpoint,
      region: "us-east-1",
      bucket: "db-only",
      forcePathStyle: true,
      enabled: true,
      accessKeyId: "AKIADBONLY",
      secretAccessKey: "db-only-secret"
    }).expect(201);
    const run = await request(runtime.app).post("/api/platform/s3-backup/run").send({}).expect(200);
    expect(run.body.data.includeImages).toBe(false);
    expect(run.body.data.targets[0].uploadedImages).toBe(0);
    expect([...mock.objects.keys()].every((key) => key.startsWith("scriverse/db/"))).toBe(true);
    expect(mock.requests.some((item) => item.path.includes("/scriverse/img/"))).toBe(false);
  });
});
