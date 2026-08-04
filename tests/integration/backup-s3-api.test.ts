import request from "supertest";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime, createWork } from "../helpers.js";
import { MockS3Service } from "../s3-mock.js";

const validTarget = {
  name: "主备份桶",
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "novel-backup",
  prefix: "team/alpha",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
};

async function uploadAttachment(runtime: Runtime, workId: string, seed: number): Promise<string> {
  const png = await sharp({
    create: { width: 32 + seed, height: 32 + seed, channels: 3, background: { r: seed * 7 % 255, g: 40, b: 90 } }
  }).png().toBuffer();
  const response = await request(runtime.app)
    .post(`/api/works/${workId}/attachments`)
    .attach("file", png, { filename: `插图-${seed}.png`, contentType: "image/png" });
  expect(response.status).toBe(201);
  return String(response.body.data.storageKey);
}

describe("S3 备份设置与目标 API", () => {
  let runtime: Runtime;
  let s3: MockS3Service;

  beforeEach(() => {
    s3 = new MockS3Service();
    runtime = createTestRuntime(s3.fetch);
  });
  afterEach(() => { runtime.close(); });

  it("默认关闭定时备份，并在启用后返回下一次执行时间", async () => {
    const initial = await request(runtime.app).get("/api/platform/backup/settings").expect(200);
    expect(initial.body.data).toMatchObject({
      scheduleEnabled: false,
      scheduleTime: "03:00",
      includeImages: false,
      retentionCount: 7,
      nextRunAt: null
    });

    const updated = await request(runtime.app)
      .patch("/api/platform/backup/settings")
      .send({ scheduleEnabled: true, scheduleTime: "23:30", includeImages: true, retentionCount: 3 })
      .expect(200);
    expect(updated.body.data).toMatchObject({
      scheduleEnabled: true,
      scheduleTime: "23:30",
      includeImages: true,
      retentionCount: 3
    });
    expect(Date.parse(String(updated.body.data.nextRunAt))).toBeGreaterThan(Date.now());
  });

  it("拒绝非法的备份时间、留存数量和未知字段", async () => {
    await request(runtime.app).patch("/api/platform/backup/settings").send({ scheduleTime: "24:00" }).expect(400);
    await request(runtime.app).patch("/api/platform/backup/settings").send({ scheduleTime: "3:00" }).expect(400);
    await request(runtime.app).patch("/api/platform/backup/settings").send({ retentionCount: 0 }).expect(400);
    await request(runtime.app).patch("/api/platform/backup/settings").send({ retentionCount: 400 }).expect(400);
    await request(runtime.app).patch("/api/platform/backup/settings").send({}).expect(400);
    await request(runtime.app).patch("/api/platform/backup/settings").send({ unknown: true }).expect(400);
  });

  it("创建目标时加密保存凭据，接口只返回掩码", async () => {
    const created = await request(runtime.app).post("/api/platform/backup/targets").send(validTarget).expect(201);
    expect(created.body.data).toMatchObject({
      name: "主备份桶",
      bucket: "novel-backup",
      prefix: "team/alpha",
      objectRoot: "team/alpha/scriverse",
      forcePathStyle: true,
      status: "enabled",
      connectionStatus: "unchecked"
    });
    const serialized = JSON.stringify(created.body.data);
    expect(serialized).not.toContain(validTarget.secretAccessKey);
    expect(serialized).not.toContain(validTarget.accessKeyId);
    expect(String(created.body.data.accessKeyId)).toContain("*");

    const row = runtime.database.get("SELECT * FROM backup_targets WHERE id = ?", String(created.body.data.id));
    expect(String(row?.encrypted_secret_key)).not.toContain(validTarget.secretAccessKey);
    expect(String(row?.encrypted_access_key_id)).not.toContain(validTarget.accessKeyId);
  });

  it("规范化子目录并拒绝路径穿越", async () => {
    const created = await request(runtime.app)
      .post("/api/platform/backup/targets")
      .send({ ...validTarget, prefix: "/nested/dir/" })
      .expect(201);
    expect(created.body.data).toMatchObject({ prefix: "nested/dir", objectRoot: "nested/dir/scriverse" });

    for (const prefix of ["../escape", "a/../../b", "a\\b", "bad\u0000dir"]) {
      const rejected = await request(runtime.app).post("/api/platform/backup/targets").send({ ...validTarget, prefix });
      expect(rejected.status).toBe(400);
      expect(String(rejected.body.error.code)).toBe("INVALID_BACKUP_PREFIX");
    }
  });

  it("未提供子目录时落在桶根目录的 scriverse 下", async () => {
    const created = await request(runtime.app)
      .post("/api/platform/backup/targets")
      .send({ ...validTarget, prefix: "" })
      .expect(201);
    expect(created.body.data).toMatchObject({ prefix: "", objectRoot: "scriverse" });
  });

  it("更新凭据后重置连接状态，留空则保留原凭据", async () => {
    const created = await request(runtime.app).post("/api/platform/backup/targets").send(validTarget).expect(201);
    const targetId = String(created.body.data.id);
    await request(runtime.app).post(`/api/platform/backup/targets/${targetId}/test`).send({}).expect(200);
    expect(runtime.backup.getTarget(targetId)).toMatchObject({ connectionStatus: "success" });

    const renamed = await request(runtime.app)
      .patch(`/api/platform/backup/targets/${targetId}`)
      .send({ name: "改名后的桶" })
      .expect(200);
    expect(renamed.body.data).toMatchObject({ name: "改名后的桶", connectionStatus: "success" });

    const rotated = await request(runtime.app)
      .patch(`/api/platform/backup/targets/${targetId}`)
      .send({ secretAccessKey: "another-secret-key-value" })
      .expect(200);
    expect(rotated.body.data).toMatchObject({ connectionStatus: "unchecked", lastError: null });
  });

  it("连通性测试失败时记录 S3 返回内容并保持非静默", async () => {
    const created = await request(runtime.app).post("/api/platform/backup/targets").send(validTarget).expect(201);
    s3.failure = { status: 403, body: "<Error><Code>SignatureDoesNotMatch</Code><Message>凭据不匹配</Message><RequestId>REQ-9</RequestId></Error>" };
    const result = await request(runtime.app)
      .post(`/api/platform/backup/targets/${String(created.body.data.id)}/test`)
      .send({})
      .expect(200);
    expect(result.body.data.ok).toBe(false);
    expect(result.body.data.error).toMatchObject({
      httpStatus: 403,
      s3Code: "SignatureDoesNotMatch",
      s3Message: "凭据不匹配",
      s3RequestId: "REQ-9"
    });
    expect(runtime.backup.getTarget(String(created.body.data.id))).toMatchObject({ connectionStatus: "failed" });
  });

  it("删除目标后不再参与备份", async () => {
    const created = await request(runtime.app).post("/api/platform/backup/targets").send(validTarget).expect(201);
    await request(runtime.app).delete(`/api/platform/backup/targets/${String(created.body.data.id)}`).expect(204);
    expect(await request(runtime.app).get("/api/platform/backup/targets").expect(200)).toMatchObject({ body: { data: [] } });
    await request(runtime.app).delete(`/api/platform/backup/targets/${String(created.body.data.id)}`).expect(404);
  });
});

describe("S3 备份执行", () => {
  let runtime: Runtime;
  let s3: MockS3Service;

  beforeEach(() => {
    s3 = new MockS3Service();
    runtime = createTestRuntime(s3.fetch);
  });
  afterEach(() => { runtime.close(); });

  async function createTarget(overrides: Record<string, unknown> = {}): Promise<string> {
    const created = await request(runtime.app)
      .post("/api/platform/backup/targets")
      .send({ ...validTarget, ...overrides })
      .expect(201);
    return String(created.body.data.id);
  }

  it("没有启用的目标时拒绝执行备份", async () => {
    const rejected = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(400);
    expect(rejected.body.error.code).toBe("NO_ENABLED_BACKUP_TARGET");

    await createTarget({ status: "disabled" });
    const stillRejected = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(400);
    expect(stillRejected.body.error.code).toBe("NO_ENABLED_BACKUP_TARGET");
  });

  it("把带时间戳的数据库快照上传到子目录下的 scriverse/db", async () => {
    await createTarget();
    const run = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(201);
    expect(run.body.data).toMatchObject({ status: "success", trigger: "manual", targetCount: 1, succeededTargetCount: 1 });
    expect(run.body.data.databaseByteLength).toBeGreaterThan(0);

    const uploaded = s3.keys("team/alpha/scriverse/db/");
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]).toMatch(/^team\/alpha\/scriverse\/db\/[A-Za-z0-9._-]+-\d{8}T\d{6}Z\.db$/u);
    const snapshot = s3.objects.get(String(uploaded[0]));
    expect(snapshot?.body.subarray(0, 15).toString("utf8")).toBe("SQLite format 3");
    expect(s3.keys("team/alpha/scriverse/img/")).toHaveLength(0);
  });

  it("不覆盖历史快照，每次备份都产生新的时间戳文件", async () => {
    await createTarget();
    await request(runtime.app).post("/api/platform/backup/run").send({}).expect(201);
    const firstKey = s3.keys("team/alpha/scriverse/db/")[0];
    s3.objects.delete(String(firstKey));
    s3.seedObject("team/alpha/scriverse/db/novel-20200101T000000Z.db", Buffer.from("older"), "2020-01-01T00:00:00.000Z");

    await request(runtime.app).post("/api/platform/backup/run").send({}).expect(201);
    expect(s3.keys("team/alpha/scriverse/db/")).toHaveLength(2);
    expect(s3.objects.get("team/alpha/scriverse/db/novel-20200101T000000Z.db")?.body.toString("utf8")).toBe("older");
  });

  it("依次同步到所有启用的目标，各自使用自己的子目录", async () => {
    await createTarget({ prefix: "team/alpha" });
    await createTarget({ name: "灾备桶", prefix: "", bucket: "novel-standby" });
    const run = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(201);
    expect(run.body.data).toMatchObject({ targetCount: 2, succeededTargetCount: 2, status: "success" });
    expect(s3.keys("team/alpha/scriverse/db/")).toHaveLength(1);
    expect(s3.keys("scriverse/db/")).toHaveLength(1);

    const buckets = s3.requests.filter((item) => item.method === "PUT").map((item) => item.bucket);
    expect(buckets).toEqual(["novel-backup", "novel-standby"]);
  });

  it("勾选备份图片后只上传缺失的图片并跳过已存在的", async () => {
    const work = await createWork(runtime);
    const firstKey = await uploadAttachment(runtime, String(work.id), 1);
    const secondKey = await uploadAttachment(runtime, String(work.id), 2);
    await request(runtime.app).patch("/api/platform/backup/settings").send({ includeImages: true }).expect(200);
    await createTarget();
    s3.seedObject(`team/alpha/scriverse/img/${firstKey}`, Buffer.from("already-there"));

    const run = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(201);
    expect(run.body.data.results[0]).toMatchObject({
      status: "success",
      uploadedImageCount: 1,
      skippedImageCount: 1,
      failedImageCount: 0
    });
    expect(s3.objects.get(`team/alpha/scriverse/img/${firstKey}`)?.body.toString("utf8")).toBe("already-there");
    expect(s3.objects.has(`team/alpha/scriverse/img/${secondKey}`)).toBe(true);
  });

  it("不勾选备份图片时只备份数据库", async () => {
    const work = await createWork(runtime);
    await uploadAttachment(runtime, String(work.id), 3);
    await createTarget();
    const run = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(201);
    expect(run.body.data.results[0]).toMatchObject({ uploadedImageCount: 0, skippedImageCount: 0 });
    expect(s3.keys("team/alpha/scriverse/img/")).toHaveLength(0);
  });

  it("超过留存数量后删除最旧的数据库备份且不清理图片", async () => {
    await request(runtime.app).patch("/api/platform/backup/settings").send({ retentionCount: 2 }).expect(200);
    await createTarget();
    s3.seedObject("team/alpha/scriverse/db/novel-20230101T000000Z.db", Buffer.from("ancient"), "2023-01-01T00:00:00.000Z");
    s3.seedObject("team/alpha/scriverse/db/novel-20240101T000000Z.db", Buffer.from("oldest"), "2024-01-01T00:00:00.000Z");
    s3.seedObject("team/alpha/scriverse/db/novel-20250101T000000Z.db", Buffer.from("newest-existing"), "2025-01-01T00:00:00.000Z");
    s3.seedObject("team/alpha/scriverse/img/ab/keep.webp", Buffer.from("image"), "2020-01-01T00:00:00.000Z");

    const run = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(201);
    expect(run.body.data.results[0]).toMatchObject({ status: "success", deletedBackupCount: 2 });
    expect(s3.keys("team/alpha/scriverse/db/")).toHaveLength(2);
    expect(s3.objects.has("team/alpha/scriverse/db/novel-20250101T000000Z.db")).toBe(true);
    expect(s3.objects.has("team/alpha/scriverse/db/novel-20240101T000000Z.db")).toBe(false);
    expect(s3.objects.has("team/alpha/scriverse/db/novel-20230101T000000Z.db")).toBe(false);
    expect(s3.objects.has("team/alpha/scriverse/img/ab/keep.webp")).toBe(true);
  });

  it("目标请求失败时标记失败、保留完整错误详情并记录历史", async () => {
    await createTarget();
    s3.failure = {
      status: 500,
      body: "<Error><Code>InternalError</Code><Message>存储服务异常</Message><RequestId>REQ-500</RequestId></Error>",
      match: (item) => item.method === "PUT"
    };
    const run = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(201);
    expect(run.body.data).toMatchObject({ status: "failed", succeededTargetCount: 0 });
    expect(run.body.data.results[0]).toMatchObject({
      status: "failed",
      databaseUploaded: false,
      error: { httpStatus: 500, s3Code: "InternalError", s3Message: "存储服务异常", s3RequestId: "REQ-500" }
    });
    expect(String(run.body.data.results[0].error.responseBody)).toContain("InternalError");

    const alerts = await request(runtime.app).get("/api/platform/backup/alerts").expect(200);
    expect(alerts.body.data).toHaveLength(1);
    expect(alerts.body.data[0].id).toBe(run.body.data.id);

    const acknowledged = await request(runtime.app)
      .post("/api/platform/backup/alerts/ack")
      .send({ runIds: [run.body.data.id] })
      .expect(200);
    expect(acknowledged.body.data).toMatchObject({ acknowledged: 1 });
    expect((await request(runtime.app).get("/api/platform/backup/alerts").expect(200)).body.data).toHaveLength(0);
  });

  it("部分目标失败时记为 partial 并保留成功目标的结果", async () => {
    await createTarget({ bucket: "novel-backup" });
    await createTarget({ name: "故障桶", bucket: "broken-bucket" });
    s3.failure = {
      status: 403,
      body: "<Error><Code>AccessDenied</Code><Message>拒绝访问</Message></Error>",
      match: (item) => item.bucket === "broken-bucket"
    };
    const run = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(201);
    expect(run.body.data).toMatchObject({ status: "partial", targetCount: 2, succeededTargetCount: 1 });
    expect(run.body.data.results.map((item: { status: string }) => item.status)).toEqual(["success", "failed"]);
    expect(s3.keys("team/alpha/scriverse/db/")).toHaveLength(1);
  });

  it("备份历史按时间倒序返回并保留每个目标的结果", async () => {
    await createTarget();
    await request(runtime.app).post("/api/platform/backup/run").send({}).expect(201);
    await request(runtime.app).post("/api/platform/backup/run").send({}).expect(201);
    const runs = await request(runtime.app).get("/api/platform/backup/runs?limit=5").expect(200);
    expect(runs.body.data).toHaveLength(2);
    expect(Date.parse(String(runs.body.data[0].startedAt))).toBeGreaterThanOrEqual(Date.parse(String(runs.body.data[1].startedAt)));
    expect(runs.body.data[0].results[0]).toMatchObject({ targetName: "主备份桶", status: "success" });
  });

  it("虚拟主机风格会把桶名放进域名", async () => {
    await createTarget({ forcePathStyle: false });
    await request(runtime.app).post("/api/platform/backup/run").send({}).expect(201);
    const put = s3.requests.find((item) => item.method === "PUT");
    expect(new URL(String(put?.url)).host).toBe("novel-backup.s3.example.com");
  });

  it("备份不上传 master.key，避免密钥与加密数据存放在同一处", async () => {
    await createTarget();
    await request(runtime.app).post("/api/platform/backup/run").send({}).expect(201);
    expect(s3.keys().some((key) => key.includes("master.key"))).toBe(false);
  });
});
