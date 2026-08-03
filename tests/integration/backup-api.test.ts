import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

type StoredObject = { body: Buffer; contentType: string };

function createMockS3Fetch() {
  const objects = new Map<string, StoredObject>();
  const listLog: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const method = String(init?.method ?? "GET").toUpperCase();
    const query: Array<[string, string]> = [];
    parsed.searchParams.forEach((value, key) => query.push([key, value]));
    query.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    // 路径风格：/{bucket}/{key}；虚拟主机：/{key}
    const segments = parsed.pathname.split("/").filter(Boolean);
    let key: string;
    if (segments.length > 1 && (query.length === 0)) key = segments.slice(1).join("/");
    else if (segments.length === 1 && query.length === 0) key = "";
    else key = segments.join("/");
    const objectKey = query.length > 0 ? "" : key;
    if (method === "HEAD") {
      if (objects.has(objectKey)) return new Response("", { status: 200 });
      return new Response("", { status: 404 });
    }
    if (method === "PUT") {
      const body = init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
      objects.set(objectKey, { body, contentType: "application/octet-stream" });
      return new Response("", { status: 200 });
    }
    if (method === "DELETE") {
      objects.delete(objectKey);
      return new Response("", { status: 204 });
    }
    if (method === "GET" && query.some(([name]) => name === "list-type")) {
      const prefix = query.find(([name]) => name === "prefix")?.[1] ?? "";
      listLog.push(prefix);
      const matching = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const contents = matching.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.body.length}</Size><LastModified>2026-08-03T00:00:00Z</LastModified></Contents>`).join("");
      const truncated = "false";
      const xml = `<?xml version="1.0"?><ListBucketResult><Name>bucket</Name><Prefix>${prefix}</Prefix><IsTruncated>${truncated}</IsTruncated>${contents}</ListBucketResult>`;
      return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
    }
    return new Response("", { status: 400 });
  }) as unknown as typeof fetch;
  return { fetchImpl, objects, listLog };
}

describe("S3 备份 API", () => {
  let runtime: Runtime;
  let mockS3: ReturnType<typeof createMockS3Fetch>;

  beforeEach(() => {
    mockS3 = createMockS3Fetch();
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "backup-test-master-secret-with-enough-length-32",
      disableUserAuth: true,
      devAuthBypass: true,
      fetchImpl: mockS3.fetchImpl,
      serveUi: false
    });
    // 第一个注册用户成为管理员，devAuthBypass 会以该用户身份请求
    runtime.auth.register({ username: "admin", password: "secure-password-123" });
  });

  afterEach(() => runtime.close());

  it("未登录请求返回 401", async () => {
    const unauthRuntime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "backup-test-master-secret-with-enough-length-32",
      disableUserAuth: true,
      fetchImpl: mockS3.fetchImpl,
      serveUi: false
    });
    try {
      await request(unauthRuntime.app).get("/api/platform/backup/settings").expect(401);
      await request(unauthRuntime.app).post("/api/platform/backup/targets").send({ name: "t", endpoint: "https://s3.test", bucket: "b", accessKeyId: "a", secretAccessKey: "s" }).expect(401);
    } finally {
      unauthRuntime.close();
    }
  });

  it("读取默认备份设置", async () => {
    const res = await request(runtime.app).get("/api/platform/backup/settings").expect(200);
    expect(res.body.data.includeImages).toBe(false);
    expect(res.body.data.scheduleCron).toBe("");
    expect(res.body.data.retentionCount).toBe(0);
  });

  it("更新备份设置", async () => {
    const res = await request(runtime.app).patch("/api/platform/backup/settings").send({
      includeImages: true,
      scheduleCron: "30 3 * * *",
      retentionCount: 5
    }).expect(200);
    expect(res.body.data.includeImages).toBe(true);
    expect(res.body.data.scheduleCron).toBe("30 3 * * *");
    expect(res.body.data.retentionCount).toBe(5);
  });

  it("创建、更新、删除 S3 目标", async () => {
    const created = await request(runtime.app).post("/api/platform/backup/targets").send({
      name: "主备份",
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "scriverse-backup",
      subdirectory: "prod",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secret/example/key",
      forcePathStyle: true,
      enabled: true
    }).expect(201);
    expect(created.body.data.name).toBe("主备份");
    expect(created.body.data.accessKeyId).toMatch(/^AKIA\*+/u);
    expect(created.body.data.secretAccessKey).toBe("");
    const targetId = created.body.data.id;

    const list = await request(runtime.app).get("/api/platform/backup/targets").expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].name).toBe("主备份");

    const updated = await request(runtime.app).patch(`/api/platform/backup/targets/${targetId}`).send({
      name: "主备份-改",
      subdirectory: "prod2"
    }).expect(200);
    expect(updated.body.data.name).toBe("主备份-改");
    expect(updated.body.data.subdirectory).toBe("prod2");

    await request(runtime.app).delete(`/api/platform/backup/targets/${targetId}`).expect(204);
    const list2 = await request(runtime.app).get("/api/platform/backup/targets").expect(200);
    expect(list2.body.data).toHaveLength(0);
  });

  it("校验失败返回 400", async () => {
    await request(runtime.app).post("/api/platform/backup/targets").send({
      name: "缺桶",
      endpoint: "https://s3.example.com",
      accessKeyId: "a",
      secretAccessKey: "s"
    }).expect(400);
    await request(runtime.app).post("/api/platform/backup/targets").send({
      name: "错误端点",
      endpoint: "ftp://s3.example.com",
      bucket: "b",
      accessKeyId: "a",
      secretAccessKey: "s"
    }).expect(400);
  });

  it("执行备份上传数据库快照到所有启用目标", async () => {
    await request(runtime.app).post("/api/platform/backup/targets").send({
      name: "目标A",
      endpoint: "https://s3.a.example.com",
      bucket: "bucket-a",
      accessKeyId: "AKIA-A",
      secretAccessKey: "secret-a-key",
      forcePathStyle: true,
      enabled: true
    }).expect(201);
    await request(runtime.app).post("/api/platform/backup/targets").send({
      name: "目标B（停用）",
      endpoint: "https://s3.b.example.com",
      bucket: "bucket-b",
      accessKeyId: "AKIA-B",
      secretAccessKey: "secret-b-key",
      forcePathStyle: true,
      enabled: false
    }).expect(201);

    const result = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    expect(result.body.data.status).toBe("success");
    expect(result.body.data.targets).toHaveLength(1);
    const target = result.body.data.targets[0];
    expect(target.status).toBe("success");
    expect(target.databaseKey).toContain("scriverse/db/");
    expect(target.databaseKey).toMatch(/\.db$/u);
    // 验证 mock S3 收到了数据库快照
    const dbKeys = [...mockS3.objects.keys()].filter((k) => k.includes("scriverse/db/"));
    expect(dbKeys).toHaveLength(1);
    const firstDbKey = dbKeys[0] ?? "";
    expect(mockS3.objects.get(firstDbKey)!.body.length).toBeGreaterThan(0);
  });

  it("子目录前缀正确拼接到 scriverse 路径", async () => {
    await request(runtime.app).post("/api/platform/backup/targets").send({
      name: "带子目录",
      endpoint: "https://s3.example.com",
      bucket: "bucket",
      subdirectory: "my/sub",
      accessKeyId: "AKIA",
      secretAccessKey: "secret-key",
      forcePathStyle: true,
      enabled: true
    }).expect(201);
    await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    const dbKeys = [...mockS3.objects.keys()].filter((k) => k.includes("scriverse/db/"));
    expect(dbKeys[0] ?? "").toMatch(/^my\/sub\/scriverse\/db\//u);
  });

  it("开启图片备份时上传图片且已存在则跳过", async () => {
    // 直接在附件目录写入一张图片
    const attachmentRoot = (runtime.attachmentStorage as unknown as { rootDirectory: string }).rootDirectory;
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const sha = "abc123def456".repeat(6).slice(0, 64);
    const storageKey = `${sha.slice(0, 2)}/${sha}.webp`;
    const { dirname, join: joinPath } = await import("node:path");
    const imagePath = joinPath(attachmentRoot, storageKey);
    mkdirSync(dirname(imagePath), { recursive: true });
    writeFileSync(imagePath, Buffer.from("fake-webp-content"));

    await request(runtime.app).patch("/api/platform/backup/settings").send({ includeImages: true }).expect(200);
    await request(runtime.app).post("/api/platform/backup/targets").send({
      name: "图片目标",
      endpoint: "https://s3.example.com",
      bucket: "bucket",
      accessKeyId: "AKIA",
      secretAccessKey: "secret-key",
      forcePathStyle: true,
      enabled: true
    }).expect(201);

    const first = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    const imgTarget = first.body.data.targets[0];
    expect(imgTarget.imageUploaded).toBe(1);
    expect(imgTarget.imageSkipped).toBe(0);

    // 第二次备份，图片已存在应跳过
    const second = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    const imgTarget2 = second.body.data.targets[0];
    expect(imgTarget2.imageSkipped).toBe(1);
    expect(imgTarget2.imageUploaded).toBe(0);
  });

  it("S3 请求失败时返回失败状态且不静默", async () => {
    const failingFetch = (async () => new Response("<Error><Code>InternalError</Code></Error>", { status: 500 })) as unknown as typeof fetch;
    const failRuntime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "backup-test-master-secret-with-enough-length-32",
      disableUserAuth: true,
      devAuthBypass: true,
      fetchImpl: failingFetch,
      serveUi: false
    });
    failRuntime.auth.register({ username: "admin", password: "secure-password-123" });
    try {
      await request(failRuntime.app).post("/api/platform/backup/targets").send({
        name: "失败目标",
        endpoint: "https://s3.example.com",
        bucket: "bucket",
        accessKeyId: "AKIA",
        secretAccessKey: "secret-key",
        forcePathStyle: true,
        enabled: true
      }).expect(201);
      const result = await request(failRuntime.app).post("/api/platform/backup/run").send({}).expect(200);
      expect(result.body.data.status).toBe("failed");
      expect(result.body.data.targets[0].status).toBe("failed");
      expect(result.body.data.targets[0].error).toBeTruthy();
      // 验证设置中记录了失败状态
      const settings = await request(failRuntime.app).get("/api/platform/backup/settings").expect(200);
      expect(settings.body.data.lastBackupStatus).toBe("failed");
    } finally {
      failRuntime.close();
    }
  });
});
