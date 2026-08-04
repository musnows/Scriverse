import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../src/logger.js";
import { createTestRuntime, createWork } from "../helpers.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2z94AAAAASUVORK5CYII=",
  "base64"
);

type S3Call = {
  method: string;
  bucket: string;
  key: string;
  authorization: string | null;
};

function createS3Fetch(options: { failDatabaseUpload?: boolean } = {}) {
  const objects = new Set<string>();
  const calls: S3Call[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/gu, "");
    const [bucket = "", ...keyParts] = path.split("/");
    const key = keyParts.join("/");
    const method = String(init?.method ?? "GET").toUpperCase();
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push({ method, bucket, key, authorization });
    const identifier = `${bucket}/${key}`;
    if (method === "HEAD") return new Response(null, { status: objects.has(identifier) ? 200 : 404 });
    if (method === "PUT") {
      if (options.failDatabaseUpload && key.startsWith("scriverse/db/")) {
        return new Response("<Error><Code>InternalError</Code><Message>同步目标不可用</Message></Error>", {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "content-type": "application/xml" }
        });
      }
      objects.add(identifier);
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      objects.delete(identifier);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const entries = [...objects]
        .filter((item) => item.startsWith(`${bucket}/${prefix}`))
        .map((item) => `<Contents><Key>${item.slice(bucket.length + 1)}</Key></Contents>`)
        .join("");
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${entries}</ListBucketResult>`, { status: 200 });
    }
    return new Response("未预期的 S3 请求", { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, objects, calls };
}

function targetInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "主同步目标",
    enabled: true,
    endpoint: "https://s3.example.test",
    region: "us-east-1",
    bucket: "backup-bucket",
    subdirectory: "",
    backupImages: true,
    scheduleTime: "03:30",
    retentionCount: 1,
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    ...overrides
  };
}

function localTime(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

describe("S3 系统备份 API", () => {
  let runtime: ReturnType<typeof createTestRuntime> | null = null;

  afterEach(() => {
    runtime?.close();
    runtime = null;
    vi.restoreAllMocks();
  });

  it("加密保存配置，跳过已存在图片并按留存数清理旧数据库快照", async () => {
    const s3 = createS3Fetch();
    runtime = createTestRuntime(s3.fetchImpl);
    const work = await createWork(runtime, "S3 图片备份");
    const attachment = await request(runtime.app)
      .post(`/api/works/${String(work.id)}/attachments?module=characters`)
      .attach("file", onePixelPng, { filename: "备份图片.png", contentType: "image/png" })
      .expect(201);
    const storageKey = String(attachment.body.data.storageKey);

    const created = await request(runtime.app).post("/api/platform/backups").send(targetInput()).expect(201);
    expect(created.body.data).toMatchObject({
      name: "主同步目标",
      endpoint: "https://s3.example.test",
      subdirectory: "",
      backupImages: true,
      retentionCount: 1,
      hasCredentials: true
    });
    expect(JSON.stringify(created.body.data)).not.toContain("test-access-key");
    expect(JSON.stringify(created.body.data)).not.toContain("test-secret-key");
    const stored = runtime.database.get("SELECT encrypted_access_key, encrypted_secret_access_key FROM s3_backup_targets");
    expect(String(stored?.encrypted_access_key)).not.toContain("test-access-key");
    expect(String(stored?.encrypted_secret_access_key)).not.toContain("test-secret-key");

    const first = await request(runtime.app).post("/api/platform/backups/run").send({}).expect(200);
    expect(first.body.data.results).toEqual([expect.objectContaining({ status: "success", imageCount: 1, skippedImageCount: 0, deletedDatabaseCount: 0 })]);
    const second = await request(runtime.app).post("/api/platform/backups/run").send({}).expect(200);
    expect(second.body.data.results).toEqual([expect.objectContaining({ status: "success", imageCount: 0, skippedImageCount: 1, deletedDatabaseCount: 1 })]);

    expect(s3.objects).toContain(`backup-bucket/scriverse/img/${storageKey}`);
    expect([...s3.objects].filter((item) => item.startsWith("backup-bucket/scriverse/db/"))).toHaveLength(1);
    expect(s3.calls.filter((call) => call.method === "HEAD" && call.key.endsWith(storageKey))).toHaveLength(2);
    expect(s3.calls.filter((call) => call.method === "PUT" && call.key.endsWith(storageKey))).toHaveLength(1);
    expect(s3.calls.filter((call) => call.method === "DELETE" && call.key.startsWith("scriverse/db/"))).toHaveLength(1);
    expect(s3.calls.find((call) => call.method === "PUT")?.authorization).toContain("AWS4-HMAC-SHA256 Credential=test-access-key/");
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("在同一触发分钟依次同步多个启用目标且不会重复执行", async () => {
    const s3 = createS3Fetch();
    runtime = createTestRuntime(s3.fetchImpl);
    await request(runtime.app).post("/api/platform/backups").send(targetInput({ name: "目标 A", bucket: "backup-target-a", backupImages: false, scheduleTime: localTime() })).expect(201);
    await request(runtime.app).post("/api/platform/backups").send(targetInput({ name: "目标 B", bucket: "backup-target-b", backupImages: false, scheduleTime: localTime() })).expect(201);

    await runtime.s3Backups.runDueBackups();
    await runtime.s3Backups.runDueBackups();

    expect(s3.calls.filter((call) => call.method === "PUT" && call.key.startsWith("scriverse/db/")).map((call) => call.bucket))
      .toEqual(["backup-target-a", "backup-target-b"]);
  });

  it("请求失败时保存失败状态、返回错误并输出脱敏的服务端响应日志", async () => {
    const s3 = createS3Fetch({ failDatabaseUpload: true });
    runtime = createTestRuntime(s3.fetchImpl);
    const errorSpy = vi.spyOn(logger, "error");
    await request(runtime.app).post("/api/platform/backups").send(targetInput({ backupImages: false })).expect(201);

    const failed = await request(runtime.app).post("/api/platform/backups/run").send({}).expect(502);
    expect(failed.body.error).toMatchObject({ code: "S3_BACKUP_FAILED", message: "S3 备份失败，请查看服务日志" });
    const target = (await request(runtime.app).get("/api/platform/backups").expect(200)).body.data[0];
    expect(target).toMatchObject({ lastStatus: "failed", lastError: "S3 请求失败（HTTP 503）" });
    const failure = errorSpy.mock.calls.find(([event]) => event === "s3_backup.target.failed");
    expect(failure?.[1]).toMatchObject({
      target: {
        name: "主同步目标",
        endpoint: "https://s3.example.test",
        bucket: "backup-bucket",
        backupImages: false
      },
      s3Status: 503,
      s3ServerResponseBody: "<Error><Code>InternalError</Code><Message>同步目标不可用</Message></Error>"
    });
    expect(JSON.stringify(failure?.[1] ?? {})).not.toContain("test-access-key");
    expect(JSON.stringify(failure?.[1] ?? {})).not.toContain("test-secret-key");
  });
});
