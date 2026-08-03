import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

const ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
const SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const setupToken = "backup-auth-test-setup-token-with-32-chars";

function validConfigPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "每日备份",
    endpointUrl: "https://s3.example.com",
    region: "us-east-1",
    bucket: "novel-backups",
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    ...overrides
  };
}

async function createConfig(runtime: Runtime, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response = await request(runtime.app)
    .post("/api/platform/backup-configs")
    .send(validConfigPayload(overrides))
    .expect(201);
  return response.body.data as Record<string, unknown>;
}

function createAuthTestRuntime(): Runtime {
  return createRuntime({
    databasePath: ":memory:",
    masterSecret: "backup-auth-test-master-secret-with-enough-length",
    serveUi: false,
    revealCaptchaAnswer: true,
    security: { allowRegistration: true, enforceSameOrigin: true, setupToken }
  });
}

async function register(runtime: Runtime, username: string): Promise<{ agent: ReturnType<typeof request.agent>; csrfToken: string }> {
  const agent = request.agent(runtime.app);
  const captcha = await request(runtime.app).get("/api/auth/captcha").expect(200);
  const response = await agent.post("/api/auth/register").send({
    username,
    password: "secure-password-123",
    passwordConfirmation: "secure-password-123",
    setupToken,
    captchaId: captcha.body.data.captchaId,
    captchaAnswer: captcha.body.data.answer
  }).expect(201);
  return { agent, csrfToken: response.body.data.csrfToken as string };
}

describe("S3 备份目标配置 API", () => {
  const runtimes: Runtime[] = [];

  afterEach(() => {
    while (runtimes.length) runtimes.pop()?.close();
  });

  it("创建、列表、更新、删除备份目标，且响应不泄露密钥", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);

    const created = await createConfig(runtime);
    expect(created).toMatchObject({
      name: "每日备份",
      endpointUrl: "https://s3.example.com",
      region: "us-east-1",
      bucket: "novel-backups",
      pathPrefix: "",
      forcePathStyle: true,
      includeImages: true,
      scheduleTime: "03:00",
      retentionCount: 7,
      enabled: true,
      lastRunAt: null,
      lastRunStatus: null,
      lastError: null
    });
    expect(String(created.id)).toBeTruthy();
    expect(String(created.accessKeyHint)).toContain("*");
    expect(String(created.secretKeyHint)).toContain("*");
    // 整个响应里绝不允许出现 ak/sk 明文。
    const createdJson = JSON.stringify(created);
    expect(createdJson).not.toContain(ACCESS_KEY);
    expect(createdJson).not.toContain(SECRET_KEY);

    const listed = await request(runtime.app).get("/api/platform/backup-configs").expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].id).toBe(created.id);
    expect(JSON.stringify(listed.body)).not.toContain(ACCESS_KEY);
    expect(JSON.stringify(listed.body)).not.toContain(SECRET_KEY);

    const updated = await request(runtime.app)
      .patch(`/api/platform/backup-configs/${created.id}`)
      .send({ name: "改名后的备份", enabled: false })
      .expect(200);
    expect(updated.body.data).toMatchObject({ name: "改名后的备份", enabled: false });

    const relisted = await request(runtime.app).get("/api/platform/backup-configs").expect(200);
    expect(relisted.body.data[0]).toMatchObject({ name: "改名后的备份", enabled: false });

    await request(runtime.app).delete(`/api/platform/backup-configs/${created.id}`).expect(204);
    const emptied = await request(runtime.app).get("/api/platform/backup-configs").expect(200);
    expect(emptied.body.data).toHaveLength(0);
  });

  it("更新不存在的目标返回 404", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const response = await request(runtime.app)
      .patch("/api/platform/backup-configs/backup_missing")
      .send({ name: "不存在" })
      .expect(404);
    expect(response.body.error.code).toBe("BACKUP_CONFIG_NOT_FOUND");
  });

  it("拒绝非法的调度时间、路径前缀、未知字段和缺失密钥", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);

    await request(runtime.app)
      .post("/api/platform/backup-configs")
      .send(validConfigPayload({ scheduleTime: "25:00" }))
      .expect(400);
    await request(runtime.app)
      .post("/api/platform/backup-configs")
      .send(validConfigPayload({ pathPrefix: "../escape" }))
      .expect(400);
    await request(runtime.app)
      .post("/api/platform/backup-configs")
      .send(validConfigPayload({ unknownField: true }))
      .expect(400);
    const missingSecret = validConfigPayload();
    delete missingSecret.secretAccessKey;
    await request(runtime.app)
      .post("/api/platform/backup-configs")
      .send(missingSecret)
      .expect(400);
    await request(runtime.app)
      .post("/api/platform/backup-configs")
      .send(validConfigPayload({ endpointUrl: "https://user:password@s3.example.com" }))
      .expect(400);

    const created = await createConfig(runtime);
    await request(runtime.app)
      .patch(`/api/platform/backup-configs/${created.id}`)
      .send({})
      .expect(400);
    await request(runtime.app)
      .patch(`/api/platform/backup-configs/${created.id}`)
      .send({ pathPrefix: "a//b" })
      .expect(400);
  });

  it("非管理员访问被拒，未登录返回 401", async () => {
    const runtime = createAuthTestRuntime();
    runtimes.push(runtime);
    const admin = await register(runtime, "backup_admin");
    const writer = await register(runtime, "backup_writer");

    await request(runtime.app).get("/api/platform/backup-configs").expect(401);

    const denied = await writer.agent.get("/api/platform/backup-configs").expect(403);
    expect(denied.body.error.code).toBe("ADMIN_REQUIRED");
    const deniedRuns = await writer.agent.get("/api/platform/backup-runs").expect(403);
    expect(deniedRuns.body.error.code).toBe("ADMIN_REQUIRED");

    const allowed = await admin.agent.get("/api/platform/backup-configs").expect(200);
    expect(allowed.body.data).toEqual([]);
  });
});
