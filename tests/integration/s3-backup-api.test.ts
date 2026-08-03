import { createHash } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime, createWork } from "../helpers.js";

describe("S3 备份 API", () => {
  const runtimes: Array<ReturnType<typeof createTestRuntime>> = [];

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.close();
  });

  it("保存多个目标时加密凭据，并按配置上传数据库快照和清理旧备份", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const method = String(init?.method ?? "GET");
      const url = String(input);
      requests.push({ method, url });
      if (method === "PUT" || method === "DELETE") return new Response(null, { status: 200 });
      if (method === "GET") {
        return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>
          <Contents><Key>archive/scriverse/db/old-1.db</Key><LastModified>2025-01-01T00:00:00.000Z</LastModified></Contents>
          <Contents><Key>archive/scriverse/db/old-2.db</Key><LastModified>2025-01-02T00:00:00.000Z</LastModified></Contents>
          <Contents><Key>archive/scriverse/db/old-3.db</Key><LastModified>2025-01-03T00:00:00.000Z</LastModified></Contents>
        </ListBucketResult>`, { status: 200, headers: { "content-type": "application/xml" } });
      }
      return new Response(null, { status: 404 });
    });
    const runtime = createTestRuntime(fetchMock);
    runtimes.push(runtime);

    await request(runtime.app).patch("/api/platform/backup/settings")
      .send({ backupImages: false, scheduleTime: "04:15", retentionCount: 2 })
      .expect(200);
    await request(runtime.app).post("/api/platform/backup/targets")
      .send({
        name: "主 S3",
        endpoint: "https://s3.example.com",
        bucket: "test-bucket",
        region: "us-east-1",
        prefix: "archive",
        accessKeyId: "AKIA_TEST_ACCESS_KEY",
        secretAccessKey: "test-secret-access-key",
        enabled: true,
        forcePathStyle: true
      })
      .expect(201);

    const settings = await request(runtime.app).get("/api/platform/backup/settings").expect(200);
    expect(settings.body.data).toMatchObject({
      backupImages: false,
      scheduleTime: "04:15",
      retentionCount: 2,
      targets: [{ name: "主 S3", prefix: "archive", accessKeyIdConfigured: true, secretAccessKeyConfigured: true }]
    });
    const serializedSettings = JSON.stringify(settings.body.data);
    expect(serializedSettings).not.toContain("AKIA_TEST_ACCESS_KEY");
    expect(serializedSettings).not.toContain("test-secret-access-key");
    expect(runtime.database.get("SELECT access_key_encrypted, secret_key_encrypted FROM s3_backup_targets")).not.toMatchObject({
      access_key_encrypted: "AKIA_TEST_ACCESS_KEY",
      secret_key_encrypted: "test-secret-access-key"
    });

    const run = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    expect(run.body.data.success).toBe(true);
    expect(run.body.data.targets[0]).toMatchObject({
      status: "success",
      imagesUploaded: 0,
      imagesSkipped: 0,
      deletedDatabaseBackups: 1
    });
    expect(requests.filter((item) => item.method === "PUT")).toHaveLength(1);
    expect(requests.filter((item) => item.method === "DELETE")).toHaveLength(1);
    expect(requests.find((item) => item.method === "PUT")?.url).toContain("/test-bucket/archive/scriverse/db/snapshot-");
  });

  it("图片备份会先 HEAD，已存在时跳过，不存在时上传", async () => {
    const imageExists = { value: true };
    const requests: Array<{ method: string; url: string }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const method = String(init?.method ?? "GET");
      const url = String(input);
      requests.push({ method, url });
      if (method === "HEAD") return new Response(null, { status: imageExists.value ? 200 : 404 });
      if (method === "PUT") return new Response(null, { status: 200 });
      if (method === "GET") return new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>", { status: 200 });
      return new Response(null, { status: 204 });
    });
    const runtime = createTestRuntime(fetchMock);
    runtimes.push(runtime);
    const work = await createWork(runtime, "带封面作品");
    const content = Buffer.from("test-cover");
    runtime.database.run(
      `INSERT INTO work_covers (work_id, mime_type, content, byte_length, sha256, updated_at)
       VALUES (?, 'image/png', ?, ?, ?, ?)`,
      String(work.id),
      content,
      content.byteLength,
      createHash("sha256").update(content).digest("hex"),
      new Date().toISOString()
    );
    await request(runtime.app).post("/api/platform/backup/targets").send({
      name: "图片目标",
      endpoint: "https://s3.example.com",
      bucket: "test-bucket",
      region: "us-east-1",
      accessKeyId: "AKIA_TEST_ACCESS_KEY",
      secretAccessKey: "test-secret-access-key"
    }).expect(201);

    await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    expect(requests.filter((item) => item.method === "HEAD" && item.url.includes("/scriverse/img/")).length).toBe(1);
    expect(requests.filter((item) => item.method === "PUT" && item.url.includes("/scriverse/img/")).length).toBe(0);

    imageExists.value = false;
    const secondRun = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    expect(secondRun.body.data.targets[0]).toMatchObject({ imagesUploaded: 1, imagesSkipped: 0 });
    expect(requests.filter((item) => item.method === "PUT" && item.url.includes("/scriverse/img/")).length).toBe(1);
  });

  it("目标返回错误时接口明确失败并保留失败状态", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (String(init?.method ?? "GET") === "PUT") {
        return new Response("<Error><Code>AccessDenied</Code><Message>denied</Message></Error>", { status: 403 });
      }
      return new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>", { status: 200 });
    });
    const runtime = createTestRuntime(fetchMock);
    runtimes.push(runtime);
    await request(runtime.app).post("/api/platform/backup/targets").send({
      name: "失败目标",
      endpoint: "https://s3.example.com",
      bucket: "test-bucket",
      region: "us-east-1",
      accessKeyId: "AKIA_TEST_ACCESS_KEY",
      secretAccessKey: "test-secret-access-key"
    }).expect(201);

    const response = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(502);
    expect(response.body.error).toMatchObject({ code: "S3_BACKUP_FAILED" });
    const settings = await request(runtime.app).get("/api/platform/backup/settings").expect(200);
    expect(settings.body.data.lastRun).toMatchObject({ success: false, targets: [{ status: "failed", statusCode: 403 }] });
  });
});
