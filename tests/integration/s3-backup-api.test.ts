import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

const setupToken = "s3-backup-test-setup-token-with-at-least-32-characters";

async function solveCaptcha(app: Runtime["app"]) {
  const response = await request(app).get("/api/auth/captcha").expect(200);
  return { captchaId: response.body.data.captchaId, captchaAnswer: response.body.data.answer };
}

async function registerAdmin(runtime: Runtime) {
  const agent = request.agent(runtime.app);
  const captcha = await solveCaptcha(runtime.app);
  const response = await agent.post("/api/auth/register").send({
    username: `admin-${Date.now()}`,
    password: "secure-password-123",
    passwordConfirmation: "secure-password-123",
    setupToken,
    ...captcha
  }).expect(201);
  return { agent, csrfToken: response.body.data.csrfToken as string };
}

describe("platform s3 backup settings API", () => {
  let runtime: Runtime;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "scriverse-s3-backup-"));
    runtime = createRuntime({
      databasePath: join(tempDir, "novel.db"),
      attachmentDirectory: join(tempDir, "attachments"),
      masterSecret: "s3-backup-test-master-secret-with-enough-length",
      serveUi: false,
      revealCaptchaAnswer: true,
      security: { allowRegistration: true, enforceSameOrigin: true, setupToken, allowPrivateAiEndpoints: true }
    });
  });

  afterEach(() => {
    runtime.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects unauthenticated and non-admin access", async () => {
    await request(runtime.app).get("/api/platform/backup/settings").expect(401);
    const admin = await registerAdmin(runtime);
    const writer = await registerAdmin(runtime);
    await writer.agent.get("/api/platform/backup/settings").expect(403);
    await writer.agent.patch("/api/platform/backup/settings")
      .set("X-CSRF-Token", writer.csrfToken)
      .send({ enabled: true })
      .expect(403);
    await admin.agent.get("/api/platform/backup/settings").expect(200);
  });

  it("stores and returns s3 backup settings without exposing secrets", async () => {
    const admin = await registerAdmin(runtime);
    const created = await admin.agent.patch("/api/platform/backup/settings")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({
        enabled: true,
        backupImages: false,
        scheduleTime: "03:15",
        retentionCount: 5,
        targets: [{
          name: "MinIO",
          enabled: true,
          endpoint: "http://127.0.0.1:9000",
          region: "us-east-1",
          bucket: "scriverse",
          prefix: "prod",
          accessKey: "test-access-key",
          secretKey: "test-secret-key"
        }]
      })
      .expect(200);

    expect(created.body.data).toMatchObject({
      enabled: true,
      backupImages: false,
      scheduleTime: "03:15",
      retentionCount: 5,
      targets: [{
        name: "MinIO",
        enabled: true,
        endpoint: "http://127.0.0.1:9000",
        region: "us-east-1",
        bucket: "scriverse",
        prefix: "prod",
        hasAccessKey: true,
        hasSecretKey: true,
        accessKeyHint: "****-key",
        secretKeyHint: "****-key"
      }]
    });
    expect(JSON.stringify(created.body.data)).not.toContain("test-access-key");
    expect(JSON.stringify(created.body.data)).not.toContain("test-secret-key");

    const fetched = await admin.agent.get("/api/platform/backup/settings").expect(200);
    expect(fetched.body.data.targets).toHaveLength(1);
    expect(fetched.body.data.targets[0].prefix).toBe("prod");

    const updated = await admin.agent.patch("/api/platform/backup/settings")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({
        targets: [{
          id: fetched.body.data.targets[0].id,
          name: "MinIO",
          enabled: true,
          endpoint: "http://127.0.0.1:9000",
          region: "us-east-1",
          bucket: "scriverse",
          prefix: "prod"
        }]
      })
      .expect(200);
    expect(updated.body.data.targets[0].hasAccessKey).toBe(true);
    expect(updated.body.data.targets[0].hasSecretKey).toBe(true);
  });

  it("validates schedule time and rejects unknown fields", async () => {
    const admin = await registerAdmin(runtime);
    await admin.agent.patch("/api/platform/backup/settings")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({ scheduleTime: "99:99" })
      .expect(400);
    await admin.agent.patch("/api/platform/backup/settings")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({ enabled: true, extra: true })
      .expect(400);
  });
});
