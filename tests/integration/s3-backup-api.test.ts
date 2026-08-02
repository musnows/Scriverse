import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRuntime } from "../helpers.js";
import type { Runtime } from "../../src/app.js";

describe("S3 备份配置与设置 API", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = createTestRuntime();
  });

  afterEach(() => runtime.close());

  const sampleConfig = {
    name: "测试 MinIO",
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    bucket: "test-bucket",
    prefix: "mysubdir",
    forcePathStyle: true,
    accessKeyId: "test-access-key-1234567890",
    secretAccessKey: "test-secret-key-1234567890"
  };

  it("默认返回空的配置列表和默认设置", async () => {
    const configsResponse = await request(runtime.app).get("/api/platform/s3-backup/configs").expect(200);
    expect(configsResponse.body.data).toEqual([]);

    const settingsResponse = await request(runtime.app).get("/api/platform/s3-backup/settings").expect(200);
    expect(settingsResponse.body.data).toMatchObject({
      scheduleHour: 3,
      includeImages: true,
      retentionCount: 10
    });
  });

  it("创建 S3 备份配置时加密存储 AK/SK，列表只返回脱敏 AK", async () => {
    const response = await request(runtime.app).post("/api/platform/s3-backup/configs").send(sampleConfig).expect(201);
    expect(response.body.data).toMatchObject({
      name: "测试 MinIO",
      endpoint: "http://127.0.0.1:9000",
      bucket: "test-bucket",
      prefix: "mysubdir",
      forcePathStyle: true,
      enabled: true
    });
    expect(response.body.data.accessKeyIdMasked).toContain("****");
    expect(response.body.data.accessKeyIdMasked).not.toContain("test-access-key");
    expect(response.body.data).not.toHaveProperty("accessKeyId");
    expect(response.body.data.id).toBeTruthy();

    const configsResponse = await request(runtime.app).get("/api/platform/s3-backup/configs").expect(200);
    expect(configsResponse.body.data).toHaveLength(1);
  });

  it("拒绝非法前缀（包含 .. 或反斜杠）", async () => {
    await request(runtime.app).post("/api/platform/s3-backup/configs")
      .send({ ...sampleConfig, prefix: "../etc" })
      .expect(400);
    await request(runtime.app).post("/api/platform/s3-backup/configs")
      .send({ ...sampleConfig, name: "bad-slash", prefix: "a\\b" })
      .expect(400);
  });

  it("校验必填字段", async () => {
    await request(runtime.app).post("/api/platform/s3-backup/configs").send({}).expect(400);
    await request(runtime.app).post("/api/platform/s3-backup/configs")
      .send({ ...sampleConfig, endpoint: "not-a-url" })
      .expect(400);
    await request(runtime.app).post("/api/platform/s3-backup/configs")
      .send({ ...sampleConfig, name: "", endpoint: "http://x" })
      .expect(400);
  });

  it("拒绝未知字段", async () => {
    await request(runtime.app).post("/api/platform/s3-backup/configs")
      .send({ ...sampleConfig, extraField: "hacker" })
      .expect(400);
  });

  it("更新配置时不传 AK/SK 保持原有凭证", async () => {
    const created = await request(runtime.app).post("/api/platform/s3-backup/configs").send(sampleConfig).expect(201);
    const configId = String(created.body.data.id);

    const updateResponse = await request(runtime.app).patch(`/api/platform/s3-backup/configs/${configId}`)
      .send({ name: "更新名称", enabled: false })
      .expect(200);
    expect(updateResponse.body.data).toMatchObject({
      name: "更新名称",
      enabled: false,
      accessKeyIdMasked: created.body.data.accessKeyIdMasked
    });

    const stored = runtime.store.getS3BackupConfigWithCredentials(configId);
    expect(stored?.accessKeyId).toBe(sampleConfig.accessKeyId);
    expect(stored?.secretAccessKey).toBe(sampleConfig.secretAccessKey);
  });

  it("更新时传入新 AK/SK 后应能正确解密", async () => {
    const created = await request(runtime.app).post("/api/platform/s3-backup/configs").send(sampleConfig).expect(201);
    const configId = String(created.body.data.id);

    await request(runtime.app).patch(`/api/platform/s3-backup/configs/${configId}`)
      .send({ accessKeyId: "new-access-key-1234567890", secretAccessKey: "new-secret-key-1234567890" })
      .expect(200);

    const stored = runtime.store.getS3BackupConfigWithCredentials(configId);
    expect(stored?.accessKeyId).toBe("new-access-key-1234567890");
    expect(stored?.secretAccessKey).toBe("new-secret-key-1234567890");
  });

  it("删除不存在的配置返回 404", async () => {
    await request(runtime.app).delete("/api/platform/s3-backup/configs/nonexistent").expect(404);
  });

  it("删除存在的配置", async () => {
    const created = await request(runtime.app).post("/api/platform/s3-backup/configs").send(sampleConfig).expect(201);
    const configId = String(created.body.data.id);

    await request(runtime.app).delete(`/api/platform/s3-backup/configs/${configId}`).expect(204);

    const configsResponse = await request(runtime.app).get("/api/platform/s3-backup/configs").expect(200);
    expect(configsResponse.body.data).toHaveLength(0);
  });

  it("更新备份设置并校验范围", async () => {
    await request(runtime.app).patch("/api/platform/s3-backup/settings")
      .send({ scheduleHour: 5 })
      .expect(200);

    await request(runtime.app).patch("/api/platform/s3-backup/settings")
      .send({ scheduleHour: 25 })
      .expect(400);

    await request(runtime.app).patch("/api/platform/s3-backup/settings")
      .send({ retentionCount: 0 })
      .expect(400);

    await request(runtime.app).patch("/api/platform/s3-backup/settings")
      .send({ retentionCount: 1000 })
      .expect(400);

    await request(runtime.app).patch("/api/platform/s3-backup/settings")
      .send({ includeImages: false })
      .expect(200);

    const settingsResponse = await request(runtime.app).get("/api/platform/s3-backup/settings").expect(200);
    expect(settingsResponse.body.data).toMatchObject({
      scheduleHour: 5,
      includeImages: false,
      retentionCount: 10
    });
  });

  it("拒绝空白的设置更新请求", async () => {
    await request(runtime.app).patch("/api/platform/s3-backup/settings").send({}).expect(400);
  });

  it("支持多配置同时存在", async () => {
    await request(runtime.app).post("/api/platform/s3-backup/configs").send(sampleConfig).expect(201);
    await request(runtime.app).post("/api/platform/s3-backup/configs")
      .send({ ...sampleConfig, name: "第二目标", endpoint: "https://s3.aws.com", bucket: "bucket2" })
      .expect(201);

    const configsResponse = await request(runtime.app).get("/api/platform/s3-backup/configs").expect(200);
    expect(configsResponse.body.data).toHaveLength(2);
    const names = configsResponse.body.data.map((c: { name: string }) => c.name);
    expect(names).toEqual(["测试 MinIO", "第二目标"]);
  });

  it("前缀去除首尾斜杠并压缩重复斜杠", async () => {
    const response = await request(runtime.app).post("/api/platform/s3-backup/configs")
      .send({ ...sampleConfig, prefix: "//a/b//c/" })
      .expect(201);
    expect(response.body.data.prefix).toBe("a/b/c");
  });
});
