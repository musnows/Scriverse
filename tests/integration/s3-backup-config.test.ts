import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

const setupToken = "s3-backup-test-setup-token-with-at-least-32-characters";

async function register(runtime: Runtime, username: string): Promise<{
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  role: "admin" | "user";
}> {
  const agent = request.agent(runtime.app);
  const challenge = await request(runtime.app).get("/api/auth/captcha").expect(200);
  const response = await agent.post("/api/auth/register").send({
    username,
    password: "secure-password-123",
    passwordConfirmation: "secure-password-123",
    setupToken,
    captchaId: challenge.body.data.captchaId,
    captchaAnswer: challenge.body.data.answer
  }).expect(201);
  return { agent, csrfToken: response.body.data.csrfToken, role: response.body.data.user.role };
}

describe("S3 备份目标配置 API", () => {
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.close();
  });

  it("保存多个目标并加密凭据、规范化目录及保留未更新的凭据", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const first = await request(runtime.app).post("/api/platform/backups/targets").send({
      name: "异地 MinIO",
      endpoint: "https://s3.example.com/storage/",
      region: "cn-test-1",
      bucket: "scriverse-backups",
      basePath: "/authors//mothra/",
      accessKeyId: "s3-access-private",
      secretAccessKey: "s3-secret-private",
      enabled: true,
      backupImages: false,
      scheduleTime: "02:30",
      retentionCount: 12
    }).expect(201);

    expect(first.body.data).toMatchObject({
      name: "异地 MinIO",
      endpoint: "https://s3.example.com/storage",
      region: "cn-test-1",
      bucket: "scriverse-backups",
      basePath: "authors/mothra",
      rootPrefix: "authors/mothra/scriverse",
      forcePathStyle: true,
      enabled: true,
      backupImages: false,
      scheduleTime: "02:30",
      retentionCount: 12,
      credentialsConfigured: true
    });
    expect(first.body.data).not.toHaveProperty("accessKeyId");
    expect(first.body.data).not.toHaveProperty("secretAccessKey");

    const targetId = String(first.body.data.id);
    const encryptedBefore = runtime.database.get<Record<string, unknown>>(
      "SELECT access_key_encrypted, secret_key_encrypted FROM s3_backup_targets WHERE id = ?",
      targetId
    );
    expect(JSON.stringify(encryptedBefore)).not.toContain("s3-access-private");
    expect(JSON.stringify(encryptedBefore)).not.toContain("s3-secret-private");

    await request(runtime.app).post("/api/platform/backups/targets").send({
      name: "AWS 归档",
      endpoint: "https://s3.amazonaws.com",
      bucket: "archive-bucket",
      accessKeyId: "aws-access-private",
      secretAccessKey: "aws-secret-private"
    }).expect(201);

    const updated = await request(runtime.app).patch(`/api/platform/backups/targets/${targetId}`).send({
      backupImages: true,
      basePath: "",
      retentionCount: 30
    }).expect(200);
    expect(updated.body.data).toMatchObject({ backupImages: true, basePath: "", rootPrefix: "scriverse", retentionCount: 30 });
    expect(runtime.database.get(
      "SELECT access_key_encrypted, secret_key_encrypted FROM s3_backup_targets WHERE id = ?",
      targetId
    )).toEqual(encryptedBefore);

    const listed = await request(runtime.app).get("/api/platform/backups/targets").expect(200);
    expect(listed.body.data.map((target: { name: string }) => target.name)).toEqual(["异地 MinIO", "AWS 归档"]);
    expect(JSON.stringify(listed.body.data)).not.toContain("private");

    await request(runtime.app).delete(`/api/platform/backups/targets/${targetId}`).expect(204);
    await request(runtime.app).get(`/api/platform/backups/targets/${targetId}`).expect(404);
    expect(runtime.database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("拒绝未知字段、危险目录和无效调度边界", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const valid = {
      name: "安全目标",
      endpoint: "https://s3.example.com",
      bucket: "backup-bucket",
      accessKeyId: "access",
      secretAccessKey: "secret"
    };
    await request(runtime.app).post("/api/platform/backups/targets").send({ ...valid, unknown: true }).expect(400);
    await request(runtime.app).post("/api/platform/backups/targets").send({ ...valid, endpoint: "not-a-url" }).expect(400);
    await request(runtime.app).post("/api/platform/backups/targets").send({ ...valid, basePath: "safe/../escape" }).expect(400);
    await request(runtime.app).post("/api/platform/backups/targets").send({ ...valid, endpoint: "file:///tmp/storage" }).expect(400);
    await request(runtime.app).post("/api/platform/backups/targets").send({ ...valid, endpoint: "https://user:password@s3.example.com" }).expect(400);
    await request(runtime.app).post("/api/platform/backups/targets").send({ ...valid, scheduleTime: "24:00" }).expect(400);
    await request(runtime.app).post("/api/platform/backups/targets").send({ ...valid, retentionCount: 0 }).expect(400);
  });

  it("只在首次开启时返回 KEK，并在关闭后保留密钥与审计记录", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);

    const initial = await request(runtime.app).get("/api/platform/backups/encryption").expect(200);
    expect(initial.body.data).toEqual({ enabled: false, keyConfiguredAt: null });

    const enabled = await request(runtime.app).post("/api/platform/backups/encryption").send({ enabled: true }).expect(200);
    expect(enabled.body.data).toMatchObject({ enabled: true, key: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u) });
    expect(enabled.body.data.keyConfiguredAt).toEqual(expect.any(String));
    const key = String(enabled.body.data.key);
    const stored = runtime.database.get("SELECT * FROM s3_backup_encryption WHERE id = 1");
    expect(JSON.stringify(stored)).not.toContain(key);
    expect(stored).toMatchObject({ enabled: 1 });

    const listed = await request(runtime.app).get("/api/platform/backups/encryption").expect(200);
    expect(listed.body.data).toEqual({ enabled: true, keyConfiguredAt: enabled.body.data.keyConfiguredAt });
    expect(JSON.stringify(listed.body.data)).not.toContain(key);

    const repeated = await request(runtime.app).post("/api/platform/backups/encryption").send({ enabled: true }).expect(200);
    expect(repeated.body.data).toEqual({ enabled: true, keyConfiguredAt: enabled.body.data.keyConfiguredAt });

    const disabled = await request(runtime.app).post("/api/platform/backups/encryption").send({ enabled: false }).expect(200);
    expect(disabled.body.data).toEqual({ enabled: false, keyConfiguredAt: enabled.body.data.keyConfiguredAt });
    const reenabled = await request(runtime.app).post("/api/platform/backups/encryption").send({ enabled: true }).expect(200);
    expect(reenabled.body.data).toEqual({ enabled: true, keyConfiguredAt: enabled.body.data.keyConfiguredAt });

    const auditRows = runtime.database.all<{ action: string; detail_json: string }>(
      "SELECT action, detail_json FROM audit_logs WHERE entity_type = 's3-backup-encryption' ORDER BY rowid"
    );
    expect(auditRows.map((row) => row.action)).toEqual([
      "platform.backup-encryption.enabled",
      "platform.backup-encryption.disabled",
      "platform.backup-encryption.enabled"
    ]);
    expect(JSON.stringify(auditRows)).not.toContain(key);

    await request(runtime.app).post("/api/platform/backups/encryption").send({ enabled: "yes" }).expect(400);
    await request(runtime.app).post("/api/platform/backups/encryption").send({ enabled: true, key: "forbidden" }).expect(400);
    await request(runtime.app).post("/api/platform/backups/encryption").send({}).expect(400);
    expect(runtime.database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("仅允许带有效 CSRF 的系统管理员管理备份目标", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "s3-backup-auth-test-master-secret-with-enough-length",
      serveUi: false,
      revealCaptchaAnswer: true,
      security: { allowRegistration: true, enforceSameOrigin: true, setupToken }
    });
    runtimes.push(runtime);
    const admin = await register(runtime, "backup_admin");
    const writer = await register(runtime, "backup_writer");
    expect(admin.role).toBe("admin");
    expect(writer.role).toBe("user");

    const body = {
      name: "管理员目标",
      endpoint: "https://s3.example.com",
      bucket: "backup-bucket",
      accessKeyId: "access",
      secretAccessKey: "secret"
    };
    await request(runtime.app).get("/api/platform/backups/targets").expect(401);
    await request(runtime.app).get("/api/platform/backups/encryption").expect(401);
    await writer.agent.get("/api/platform/backups/targets").expect(403);
    await writer.agent.get("/api/platform/backups/runs").expect(403);
    await writer.agent.get("/api/platform/backups/encryption").expect(403);
    await writer.agent.post("/api/platform/backups/targets").set("X-CSRF-Token", writer.csrfToken).send(body).expect(403);
    await writer.agent.post("/api/platform/backups/encryption").set("X-CSRF-Token", writer.csrfToken).send({ enabled: true }).expect(403);
    await writer.agent.post("/api/platform/backups/run").set("X-CSRF-Token", writer.csrfToken).send({}).expect(403);
    await admin.agent.post("/api/platform/backups/targets").send(body).expect(403);
    await admin.agent.post("/api/platform/backups/encryption").send({ enabled: true }).expect(403);
    await admin.agent.post("/api/platform/backups/run").send({}).expect(403);
    await admin.agent.post("/api/platform/backups/targets").set("X-CSRF-Token", admin.csrfToken).send(body).expect(201);
    const encryption = await admin.agent.post("/api/platform/backups/encryption")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({ enabled: true })
      .expect(200);
    expect(encryption.body.data.key).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });
});
