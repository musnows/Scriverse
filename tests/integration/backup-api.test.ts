import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

const setupToken = "backup-api-test-setup-token-with-32-characters";

type MockCall = { method: string; url: string; body?: Buffer };

function createMockS3(mode: "ok" | "fail"): { fetchImpl: typeof fetch; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const listingXml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>` +
    `<Contents><Key>sub/scriverse/db/novel-20260101T000000Z.db</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>` +
    `<Contents><Key>sub/scriverse/db/novel-20260201T000000Z.db</Key><LastModified>2026-02-01T00:00:00.000Z</LastModified></Contents>` +
    `<Contents><Key>sub/scriverse/db/novel-20260301T000000Z.db</Key><LastModified>2026-03-01T00:00:00.000Z</LastModified></Contents>` +
    `</ListBucketResult>`;
  const fetchImpl = (async (input: any, init?: any): Promise<Response> => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body as Buffer | undefined;
    calls.push({ method, url, body });
    if (method === "HEAD") return new Response(null, { status: url.includes("existing.png") ? 200 : 404 });
    if (method === "PUT") return new Response(null, { status: mode === "fail" ? 403 : 200 });
    if (method === "DELETE") return new Response(null, { status: 200 });
    if (method === "GET" && url.includes("list-type=2")) {
      return new Response(listingXml, { status: 200, headers: { "Content-Type": "application/xml" } });
    }
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function registerAdmin(runtime: Runtime): Promise<{ agent: ReturnType<typeof request.agent>; csrfToken: string }> {
  const agent = request.agent(runtime.app);
  const captcha = await agent.get("/api/auth/captcha").expect(200);
  const response = await agent.post("/api/auth/register").send({
    username: "backup-admin",
    password: "backup-password-123",
    passwordConfirmation: "backup-password-123",
    setupToken,
    captchaId: captcha.body.data.captchaId,
    captchaAnswer: captcha.body.data.answer
  }).expect(201);
  return { agent, csrfToken: response.body.data.csrfToken };
}

describe("S3 备份 API", () => {
  let runtime: Runtime;
  let attachmentDirectory: string;
  let mock: { fetchImpl: typeof fetch; calls: MockCall[] };

  beforeEach(() => {
    attachmentDirectory = mkdtempSync(join(tmpdir(), "scriverse-backup-attach-"));
    writeFileSync(join(attachmentDirectory, "img1.png"), Buffer.from("img1-bytes"));
    writeFileSync(join(attachmentDirectory, "existing.png"), Buffer.from("img2-bytes"));
    mock = createMockS3("ok");
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "backup-api-test-master-secret-32chars",
      serveUi: false,
      revealCaptchaAnswer: true,
      attachmentDirectory,
      fetchImpl: mock.fetchImpl,
      security: { allowRegistration: true, enforceSameOrigin: true, setupToken }
    });
  });

  afterEach(() => {
    runtime.close();
    rmSync(attachmentDirectory, { recursive: true, force: true });
  });

  it("未登录访问备份配置返回 401", async () => {
    await request(runtime.app).get("/api/backup/config").expect(401);
  });

  it("非管理员访问备份配置返回 403", async () => {
    const admin = await registerAdmin(runtime);
    const outsiderAgent = request.agent(runtime.app);
    const captcha = await outsiderAgent.get("/api/auth/captcha").expect(200);
    await outsiderAgent.post("/api/auth/register").send({
      username: "backup-user",
      password: "backup-password-123",
      passwordConfirmation: "backup-password-123",
      setupToken,
      captchaId: captcha.body.data.captchaId,
      captchaAnswer: captcha.body.data.answer
    }).expect(201);
    await outsiderAgent.get("/api/backup/config").expect(403);
    expect(admin.agent).toBeTruthy();
  });

  it("读取默认配置不含任何凭据", async () => {
    const admin = await registerAdmin(runtime);
    const response = await admin.agent.get("/api/backup/config").expect(200);
    expect(response.body.data.targets).toEqual([]);
    expect(response.body.data.retentionCount).toBe(10);
  });

  it("保存配置后凭据脱敏，且下次读取不泄露明文", async () => {
    const admin = await registerAdmin(runtime);
    const config = {
      targets: [{
        id: "target-1",
        name: "主备份",
        endpoint: "https://8.8.8.8",
        region: "us-east-1",
        bucket: "my-bucket",
        subdir: "sub",
        enabled: true,
        accessKeyId: "AKID-VALUE",
        secretAccessKey: "SECRET-VALUE",
        hasAccessKeyId: false,
        hasSecretAccessKey: false
      }],
      backupImages: true,
      scheduleTime: "03:00",
      retentionCount: 10
    };
    const saved = await admin.agent.put("/api/backup/config").set("X-CSRF-Token", admin.csrfToken).send(config).expect(200);
    expect(saved.body.data.targets[0].accessKeyId).toBe("");
    expect(saved.body.data.targets[0].secretAccessKey).toBe("");
    expect(saved.body.data.targets[0].hasAccessKeyId).toBe(true);
    const reloaded = await admin.agent.get("/api/backup/config").expect(200);
    expect(reloaded.body.data.targets[0].accessKeyId).toBe("");
  });

  it("使用私有地址的备份目标被 SSRF 拦截", async () => {
    const admin = await registerAdmin(runtime);
    const config = {
      targets: [{
        id: "target-2",
        name: "内网目标",
        endpoint: "http://127.0.0.1:9000",
        region: "us-east-1",
        bucket: "my-bucket",
        subdir: "",
        enabled: true,
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
        hasAccessKeyId: false,
        hasSecretAccessKey: false
      }],
      backupImages: true,
      scheduleTime: "03:00",
      retentionCount: 10
    };
    const response = await admin.agent.put("/api/backup/config").set("X-CSRF-Token", admin.csrfToken).send(config).expect(400);
    expect(response.body.error.code).toBe("UNSAFE_BACKUP_ENDPOINT");
  });

  it("立即备份会按顺序上传数据库与图片，并清理超出留存的旧备份", async () => {
    const admin = await registerAdmin(runtime);
    const config = {
      targets: [{
        id: "target-3",
        name: "主备份",
        endpoint: "https://8.8.8.8",
        region: "us-east-1",
        bucket: "my-bucket",
        subdir: "sub",
        enabled: true,
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
        hasAccessKeyId: false,
        hasSecretAccessKey: false
      }],
      backupImages: true,
      scheduleTime: "03:00",
      retentionCount: 2
    };
    await admin.agent.put("/api/backup/config").set("X-CSRF-Token", admin.csrfToken).send(config).expect(200);
    const trigger = await admin.agent.post("/api/backup/trigger").set("X-CSRF-Token", admin.csrfToken).expect(200);
    expect(trigger.body.data.targets).toHaveLength(1);
    expect(trigger.body.data.targets[0].ok).toBe(true);
    expect(trigger.body.data.targets[0].databaseFile).toMatch(/^novel-.*\.db$/);
    // 图片：existing.png 已存在被跳过，img1.png 被上传
    const putCalls = mock.calls.filter((call) => call.method === "PUT");
    const putUrls = putCalls.map((call) => call.url);
    expect(putUrls.some((url) => url.includes("/db/novel-") && url.endsWith(".db"))).toBe(true);
    expect(putUrls.some((url) => url.includes("sub/scriverse/img/img1.png"))).toBe(true);
    expect(putUrls.some((url) => url.includes("existing.png"))).toBe(false);
    // 留存清理：3 个旧备份 + retention 2 -> 删除最旧的 20260101
    expect(mock.calls.some((call) => call.method === "DELETE" && call.url.includes("novel-20260101T000000Z.db"))).toBe(true);
    // 状态接口反映上次成功
    const status = await admin.agent.get("/api/backup/status").expect(200);
    expect(status.body.data.running).toBe(false);
    expect(status.body.data.lastError).toBeNull();
    expect(status.body.data.lastFinishedAt).toBeTruthy();
  });

  it("S3 请求失败时返回 500 且不静默失败（含服务端正文）", async () => {
    const failMock = createMockS3("fail");
    const failRuntime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "backup-api-test-master-secret-32chars",
      serveUi: false,
      revealCaptchaAnswer: true,
      attachmentDirectory,
      fetchImpl: failMock.fetchImpl,
      security: { allowRegistration: true, enforceSameOrigin: true, setupToken }
    });
    const admin = await registerAdmin(failRuntime);
    await admin.agent.put("/api/backup/config").set("X-CSRF-Token", admin.csrfToken).send({
      targets: [{
        id: "target-fail",
        name: "失败目标",
        endpoint: "https://8.8.8.8",
        region: "us-east-1",
        bucket: "my-bucket",
        subdir: "sub",
        enabled: true,
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
        hasAccessKeyId: false,
        hasSecretAccessKey: false
      }],
      backupImages: false,
      scheduleTime: "03:00",
      retentionCount: 5
    }).expect(200);
    const trigger = await admin.agent.post("/api/backup/trigger").set("X-CSRF-Token", admin.csrfToken);
    expect(trigger.status).toBe(500);
    expect(trigger.body.error.code).toBe("BACKUP_FAILED");
    expect(trigger.body.error.message).toContain("HTTP 403");
    const status = await admin.agent.get("/api/backup/status").expect(200);
    expect(status.body.data.lastError).toBeTruthy();
    failRuntime.close();
  });
});
