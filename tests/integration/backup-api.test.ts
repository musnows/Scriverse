import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { logger } from "../../src/logger.js";

const setupToken = "backup-api-test-setup-token-with-at-least-32-characters";

type SessionCredentials = {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  user: { role: "admin" | "user" };
};

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2z94AAAAASUVORK5CYII=",
  "base64"
);

/** 内存版 S3 兼容服务，支持注入失败模式。 */
class MockS3Server {
  readonly objects = new Map<string, Buffer>();
  failMode: { status: number; code: string; message: string } | null = null;
  putCallCount = 0;
  deleteCallCount = 0;
  listCallCount = 0;

  private xmlError(): Response {
    const { status, code, message } = this.failMode!;
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message><RequestId>mock-req-1</RequestId></Error>`,
      { status }
    );
  }

  fetchImpl = async (input: unknown, init: unknown): Promise<Response> => {
    const url = new URL(String(input));
    const method = String((init as { method?: string })?.method ?? "GET");
    if (this.failMode) return this.xmlError();
    const bucketPrefix = "/test-bucket/";
    if (!url.pathname.startsWith(bucketPrefix)) {
      return new Response(`<Error><Code>NoSuchBucket</Code><Message>missing bucket</Message></Error>`, { status: 404 });
    }
    const key = url.pathname.slice(bucketPrefix.length);
    if (method === "GET") {
      this.listCallCount += 1;
      const prefix = url.searchParams.get("prefix") ?? "";
      const items = [...this.objects.entries()]
        .filter(([objectKey]) => objectKey.startsWith(prefix))
        .map(([objectKey, content]) =>
          `<Contents><Key>${objectKey}</Key><Size>${content.length}</Size><LastModified>2026-08-01T00:00:00.000Z</LastModified></Contents>`
        )
        .join("");
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`,
        { status: 200 }
      );
    }
    if (method === "PUT") {
      this.putCallCount += 1;
      const body = (init as { body?: unknown }).body;
      const content: Buffer = body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(String(body ?? ""));
      this.objects.set(key, content);
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      this.deleteCallCount += 1;
      this.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  };
}

function makeTemporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "scriverse-backup-api-"));
}

describe("平台数据备份 API", () => {
  let runtime: Runtime;
  let dataDirectory: string;
  let attachmentDirectory: string;
  let mockS3: MockS3Server;
  let admin: SessionCredentials;
  let member: SessionCredentials;

  beforeEach(async () => {
    dataDirectory = makeTemporaryDirectory();
    attachmentDirectory = join(dataDirectory, "attachments");
    mkdirSync(attachmentDirectory, { recursive: true });
    writeFileSync(join(dataDirectory, "master.key"), "test-master-key-for-backup-integration-0123456789");
    mockS3 = new MockS3Server();
    runtime = createRuntime({
      databasePath: join(dataDirectory, "novel.db"),
      masterSecret: "backup-api-test-master-secret-with-enough-length",
      attachmentDirectory,
      serveUi: false,
      revealCaptchaAnswer: true,
      security: { allowRegistration: true, enforceSameOrigin: true, setupToken },
      fetchImpl: mockS3.fetchImpl as typeof fetch
    });
    admin = await registerUser(runtime, "backup_admin");
    member = await registerUser(runtime, "backup_member");
  });

  afterEach(() => {
    runtime.close();
    rmSync(dataDirectory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function registerUser(target: Runtime, username: string): Promise<SessionCredentials> {
    const agent = request.agent(target.app);
    const captchaResponse = await agent.get("/api/auth/captcha").expect(200);
    const captcha = {
      captchaId: captchaResponse.body.data.captchaId,
      captchaAnswer: captchaResponse.body.data.answer
    };
    const response = await agent.post("/api/auth/register").send({
      username,
      password: "secure-password-123",
      passwordConfirmation: "secure-password-123",
      setupToken,
      ...captcha
    }).expect(201);
    return {
      agent,
      csrfToken: response.body.data.csrfToken,
      user: response.body.data.user
    };
  }

  const targetInput = {
    name: "测试 MinIO",
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    bucket: "test-bucket",
    accessKeyId: "minioadmin",
    secretAccessKey: "minio-secret-123",
    prefix: "backups/novel-a",
    enabled: true
  };

  function post(credentials: SessionCredentials, path: string, body: object) {
    return credentials.agent.post(path).set("X-CSRF-Token", credentials.csrfToken).send(body);
  }

  function patch(credentials: SessionCredentials, path: string, body: object) {
    return credentials.agent.patch(path).set("X-CSRF-Token", credentials.csrfToken).send(body);
  }

  async function createDefaultTarget(overrides: Record<string, unknown> = {}): Promise<number> {
    const response = await post(admin, "/api/platform/backup/targets", { ...targetInput, ...overrides }).expect(201);
    return Number(response.body.data.id);
  }

  it("非管理员无法访问备份接口", async () => {
    await member.agent.get("/api/platform/backup/settings").expect(403);
    await post(member, "/api/platform/backup/targets", targetInput).expect(403);
    await post(member, "/api/platform/backup/run", {}).expect(403);
    await member.agent.get("/api/platform/backup/settings").set("X-CSRF-Token", member.csrfToken);
    await request(runtime.app).get("/api/platform/backup/settings").expect(401);
  });

  it("校验非法输入", async () => {
    await patch(admin, "/api/platform/backup/settings", {
      schedulerEnabled: true,
      scheduleCron: "not-a-cron",
      backupImages: true,
      retentionCount: 10
    }).expect(400);
    await patch(admin, "/api/platform/backup/settings", {
      schedulerEnabled: true,
      scheduleCron: "0 3 * * *",
      backupImages: true,
      retentionCount: 0
    }).expect(400);
    await patch(admin, "/api/platform/backup/settings", {
      schedulerEnabled: true,
      scheduleCron: "0 3 * * *",
      backupImages: true,
      retentionCount: 999
    }).expect(400);
    await post(admin, "/api/platform/backup/targets", { ...targetInput, endpoint: "ftp://x" }).expect(400);
    await post(admin, "/api/platform/backup/targets", { ...targetInput, endpoint: "https://user:pass@host" }).expect(400);
    await post(admin, "/api/platform/backup/targets", { ...targetInput, bucket: "Bad Bucket" }).expect(400);
    await post(admin, "/api/platform/backup/targets", { ...targetInput, prefix: "a/../b" }).expect(400);
    await post(admin, "/api/platform/backup/targets", { ...targetInput, name: "" }).expect(400);
    await post(admin, "/api/platform/backup/targets", { ...targetInput, extraField: "x" }).expect(400);
    await post(admin, "/api/platform/backup/targets", { ...targetInput, accessKeyId: "" }).expect(400);
  });

  it("设置与目标的增删改查，密钥不回显", async () => {
    const settingsResponse = await admin.agent.get("/api/platform/backup/settings").expect(200);
    expect(settingsResponse.body.data.settings).toEqual(expect.objectContaining({
      schedulerEnabled: false,
      scheduleCron: "0 3 * * *",
      backupImages: true,
      retentionCount: 10
    }));
    expect(settingsResponse.body.data.targets).toEqual([]);

    const updated = await patch(admin, "/api/platform/backup/settings", {
      schedulerEnabled: true,
      scheduleCron: "30 2 * * *",
      backupImages: false,
      retentionCount: 5
    }).expect(200);
    expect(updated.body.data).toEqual(expect.objectContaining({
      schedulerEnabled: true,
      scheduleCron: "30 2 * * *",
      backupImages: false,
      retentionCount: 5
    }));

    const targetId = await createDefaultTarget();
    const listResponse = await admin.agent.get("/api/platform/backup/settings").expect(200);
    const [created] = listResponse.body.data.targets;
    expect(created).toEqual(expect.objectContaining({
      id: targetId,
      name: "测试 MinIO",
      endpoint: "http://127.0.0.1:9000",
      region: "us-east-1",
      bucket: "test-bucket",
      accessKeyId: "minioadmin",
      prefix: "backups/novel-a",
      enabled: true,
      hasSecretKey: true
    }));
    // Access Key 允许回显，Secret Key 永不下发
    expect(JSON.stringify(listResponse.body.data.targets)).toContain("minioadmin");
    expect(JSON.stringify(listResponse.body.data.targets)).not.toContain("minio-secret-123");

    const updatedTarget = await patch(admin, `/api/platform/backup/targets/${targetId}`, {
      name: "改名目标",
      prefix: "/new-prefix/"
    }).expect(200);
    expect(updatedTarget.body.data.name).toBe("改名目标");
    expect(updatedTarget.body.data.prefix).toBe("new-prefix");

    const unchanged = await patch(admin, `/api/platform/backup/targets/${targetId}`, {
      enabled: false
    }).expect(200);
    expect(unchanged.body.data.enabled).toBe(false);
    expect(unchanged.body.data.hasSecretKey).toBe(true);

    await admin.agent.delete(`/api/platform/backup/targets/${targetId}`).set("X-CSRF-Token", admin.csrfToken).expect(204);
    const afterDelete = await admin.agent.get("/api/platform/backup/settings").expect(200);
    expect(afterDelete.body.data.targets).toEqual([]);
  });

  it("完整备份流程：数据库、图片增量与留存清理", async () => {
    // 预置附件图片与远端已有图片
    mkdirSync(join(attachmentDirectory, "ab"), { recursive: true });
    mkdirSync(join(attachmentDirectory, "cd"), { recursive: true });
    writeFileSync(join(attachmentDirectory, "ab", "a".repeat(64) + ".webp"), "new-image");
    writeFileSync(join(attachmentDirectory, "cd", "b".repeat(64) + ".png"), onePixelPng);
    const existingKey = "backups/novel-a/scriverse/img/cd/" + "b".repeat(64) + ".png";
    mockS3.objects.set(existingKey, onePixelPng);
    // 预置 3 份远端数据库备份，留存 2 份应删除最老 1 份
    mockS3.objects.set("backups/novel-a/scriverse/db/novel-2026-07-01T00-00-00-000Z.db", Buffer.from("old-db-1"));
    mockS3.objects.set("backups/novel-a/scriverse/db/master-2026-07-01T00-00-00-000Z.key", Buffer.from("old-key-1"));
    mockS3.objects.set("backups/novel-a/scriverse/db/novel-2026-07-02T00-00-00-000Z.db", Buffer.from("old-db-2"));
    mockS3.objects.set("backups/novel-a/scriverse/db/novel-2026-07-03T00-00-00-000Z.db", Buffer.from("old-db-3"));

    const targetId = await createDefaultTarget();
    await patch(admin, "/api/platform/backup/settings", {
      schedulerEnabled: true,
      scheduleCron: "0 3 * * *",
      backupImages: true,
      retentionCount: 2
    }).expect(200);

    const runResponse = await post(admin, "/api/platform/backup/run", {}).expect(200);
    const [result] = runResponse.body.data.results;
    expect(result.ok).toBe(true);
    expect(result.uploadedDbFileCount).toBeGreaterThanOrEqual(1);
    expect(result.uploadedImageCount).toBe(1);
    expect(result.skippedImageCount).toBe(1);
    // 清理了最老 2 份备份（07-01 的 db 与 key、07-02 的 db），共 3 个文件
    expect(result.prunedBackupCount).toBe(3);

    // 数据库快照与图片已上传
    const dbKeys = [...mockS3.objects.keys()].filter((key) => key.includes("/scriverse/db/"));
    expect(dbKeys.some((key) => /novel-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/u.test(key))).toBe(true);
    expect(mockS3.objects.has(existingKey)).toBe(true);
    expect([...mockS3.objects.keys()].some((key) => key === "backups/novel-a/scriverse/img/ab/" + "a".repeat(64) + ".webp")).toBe(true);
    // master.key 已一并备份
    expect(dbKeys.some((key) => /master-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.key$/u.test(key))).toBe(true);
    // 最老 2 份备份（07-01 的 db+key 与 07-02 的 db）被清理，最新 07-03 保留
    expect(mockS3.objects.has("backups/novel-a/scriverse/db/novel-2026-07-01T00-00-00-000Z.db")).toBe(false);
    expect(mockS3.objects.has("backups/novel-a/scriverse/db/master-2026-07-01T00-00-00-000Z.key")).toBe(false);
    expect(mockS3.objects.has("backups/novel-a/scriverse/db/novel-2026-07-02T00-00-00-000Z.db")).toBe(false);
    expect(mockS3.objects.has("backups/novel-a/scriverse/db/novel-2026-07-03T00-00-00-000Z.db")).toBe(true);

    // 目标状态更新
    const snapshot = await admin.agent.get("/api/platform/backup/settings").expect(200);
    const [targetView] = snapshot.body.data.targets;
    expect(targetView.lastStatus).toBe("success");
    expect(targetView.lastBackupAt).toBeTruthy();
    expect(targetView.lastError).toBe("");

    // 第二次运行：图片全部跳过
    const secondRun = await post(admin, "/api/platform/backup/run", {}).expect(200);
    const [secondResult] = secondRun.body.data.results;
    expect(secondResult.ok).toBe(true);
    expect(secondResult.uploadedImageCount).toBe(0);
    expect(secondResult.skippedImageCount).toBeGreaterThanOrEqual(1);
  });

  it("不勾选备份图片时只备份数据库", async () => {
    mkdirSync(join(attachmentDirectory, "ab"), { recursive: true });
    writeFileSync(join(attachmentDirectory, "ab", "a".repeat(64) + ".webp"), "image-data");
    const targetId = await createDefaultTarget();
    await patch(admin, "/api/platform/backup/settings", {
      schedulerEnabled: true,
      scheduleCron: "0 3 * * *",
      backupImages: false,
      retentionCount: 10
    }).expect(200);
    const runResponse = await post(admin, "/api/platform/backup/run", {}).expect(200);
    const [result] = runResponse.body.data.results;
    expect(result.ok).toBe(true);
    expect(result.uploadedImageCount).toBe(0);
    expect([...mockS3.objects.keys()].some((key) => key.includes("/scriverse/img/"))).toBe(false);
    expect([...mockS3.objects.keys()].some((key) => key.includes("/scriverse/db/"))).toBe(true);
  });

  it("S3 服务失败时返回错误摘要并完整记录目标配置（不含密钥）", async () => {
    const errorSpy = vi.spyOn(logger, "error");
    const targetId = await createDefaultTarget();
    mockS3.failMode = { status: 403, code: "AccessDenied", message: "Invalid access key" };

    const runResponse = await post(admin, "/api/platform/backup/run", {}).expect(200);
    const [result] = runResponse.body.data.results;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("AccessDenied");
    expect(result.error).toContain("Invalid access key");

    // 日志必须完整打印配置项与 S3 返回，但不含 AK/SK
    const failedLog = errorSpy.mock.calls.find((call) => call[0] === "backup.target.failed");
    expect(failedLog).toBeTruthy();
    const fields = JSON.stringify(failedLog?.[1]);
    expect(fields).toContain("测试 MinIO");
    expect(fields).toContain("http://127.0.0.1:9000");
    expect(fields).toContain("us-east-1");
    expect(fields).toContain("test-bucket");
    expect(fields).toContain("backups/novel-a");
    expect(fields).toContain("AccessDenied");
    expect(fields).toContain("mock-req-1");
    expect(fields).not.toContain("minioadmin");
    expect(fields).not.toContain("minio-secret-123");
    expect(fields).not.toContain("test-master-key");

    // 目标状态记录失败
    const snapshot = await admin.agent.get("/api/platform/backup/settings").expect(200);
    const [targetView] = snapshot.body.data.targets;
    expect(targetView.lastStatus).toBe("failed");
    expect(targetView.lastError).toContain("AccessDenied");
  });

  it("多目标依次备份，单目标失败不影响其他目标", async () => {
    const goodTarget = await createDefaultTarget({ name: "正常目标", bucket: "test-bucket" });
    await post(admin, "/api/platform/backup/targets", {
      ...targetInput,
      name: "失败目标",
      bucket: "missing-bucket",
      endpoint: "http://127.0.0.1:9100"
    }).expect(201);
    mockS3.objects.set(`test-bucket-object`, Buffer.from("x"));
    const runResponse = await post(admin, "/api/platform/backup/run", {}).expect(200);
    expect(runResponse.body.data.results).toHaveLength(2);
    const good = runResponse.body.data.results.find((item: { name: string }) => item.name === "正常目标");
    const bad = runResponse.body.data.results.find((item: { name: string }) => item.name === "失败目标");
    expect(good.ok).toBe(true);
    expect(bad.ok).toBe(false);
    // 不存在的桶同样走 mock 返回 404
    expect(bad.error).toContain("NoSuchBucket");
  });

  it("更新目标时不传 Secret Key 保持原密钥", async () => {
    const targetId = await createDefaultTarget();
    await patch(admin, `/api/platform/backup/targets/${targetId}`, { name: "保持密钥" }).expect(200);
    const runResponse = await post(admin, "/api/platform/backup/run", {}).expect(200);
    expect(runResponse.body.data.results[0].ok).toBe(true);
  });

  it("调度关闭时定时触发不执行，开启后执行", async () => {
    const targetId = await createDefaultTarget();
    const scheduledOff = await runtime.backup.runNow("schedule");
    expect(scheduledOff).toEqual({ results: [] });

    await patch(admin, "/api/platform/backup/settings", {
      schedulerEnabled: true,
      scheduleCron: "0 3 * * *",
      backupImages: false,
      retentionCount: 10
    }).expect(200);
    const scheduledOn = await runtime.backup.runNow("schedule");
    expect(scheduledOn).toEqual(expect.objectContaining({
      results: expect.arrayContaining([expect.objectContaining({ targetId, ok: true })])
    }));
  });

  it("备份执行期间再次触发返回 busy", async () => {
    const targetId = await createDefaultTarget();
    const firstRun = runtime.backup.runNow("manual");
    const secondRun = await runtime.backup.runNow("manual");
    expect(secondRun).toEqual({ busy: true });
    await firstRun;
  });

  it("停用目标不参与备份", async () => {
    const targetId = await createDefaultTarget({ enabled: false });
    const runResponse = await post(admin, "/api/platform/backup/run", {}).expect(200);
    expect(runResponse.body.data.results).toEqual([]);
  });
});
