import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// 先注入日志级别再加载源码模块，确保 logger 输出可被断言（测试环境默认 silent）。
vi.stubEnv("LOG_LEVEL", "info");
const { createRuntime } = await import("../../src/app.js");
type Runtime = import("../../src/app.js").Runtime;

type SessionCredentials = {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  user: { userId: string; role: "admin" | "user" };
};

const setupToken = "s3-backup-test-setup-token-with-at-least-32-characters";

let directory: string;
let runtime: Runtime;
let server: Server;
let admin: SessionCredentials;
let member: SessionCredentials;

async function solveCaptcha(app: Runtime["app"]): Promise<{ captchaId: string; captchaAnswer: string }> {
  const response = await request(app).get("/api/auth/captcha").expect(200);
  return { captchaId: response.body.data.captchaId, captchaAnswer: response.body.data.answer };
}

async function register(app: Runtime["app"], username: string): Promise<SessionCredentials> {
  const agent = request.agent(app);
  const captcha = await solveCaptcha(app);
  const response = await agent.post("/api/auth/register").send({
    username,
    password: "secure-password-123",
    passwordConfirmation: "secure-password-123",
    setupToken,
    ...captcha
  }).expect(201);
  return { agent, csrfToken: response.body.data.csrfToken, user: response.body.data.user };
}

/** 内存版 S3 兼容服务模拟：维护对象 Map，记录请求调用。 */
function createS3Mock() {
  const objects = new Map<string, Buffer>();
  const calls: Array<{ method: string; key: string }> = [];
  const putHandlers: Array<(key: string) => Response | null> = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET");
    const key = decodeURIComponent(url.pathname.replace(/^\/[^/]+\//u, ""));
    calls.push({ method, key });
    if (method === "PUT") {
      for (const handler of putHandlers) {
        const override = handler(key);
        if (override) return override;
      }
      const body = Buffer.from((init?.body ?? new Uint8Array()) as Uint8Array);
      objects.set(key, body);
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (method === "GET") {
      const prefix = String(url.searchParams.get("prefix") ?? "");
      const contents = [...objects.keys()]
        .filter((candidate) => candidate.startsWith(prefix))
        .map((candidate) => `<Contents><Key>${candidate}</Key></Contents>`)
        .join("");
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        { status: 200 }
      );
    }
    return new Response("", { status: 405 });
  });
  return { objects, calls, putHandlers, fetchMock };
}

const s3 = createS3Mock();

function attachmentPath(root: string, key: string): string {
  return join(root, key);
}

function createTarget(agent: SessionCredentials, overrides: Record<string, unknown> = {}) {
  return agent.agent.post("/api/platform/backup/targets")
    .set("x-csrf-token", agent.csrfToken)
    .send({
      name: "测试备份目标",
      endpoint: "http://127.0.0.1:19000",
      region: "us-east-1",
      bucket: "backup-bucket",
      prefix: "novel-backup",
      accessKeyId: "AKIATESTKEY123456",
      secretAccessKey: "test-secret-key-value-0123456789",
      enabled: true,
      ...overrides
    });
}

async function waitForBackupFinish(app: Runtime["app"], agent: SessionCredentials): Promise<Record<string, unknown>> {
  let lastRun: Record<string, unknown> | null = null;
  await vi.waitFor(async () => {
    const status = await agent.agent.get("/api/platform/backup/status").expect(200);
    expect(status.body.data.running).toBe(false);
    lastRun = status.body.data.lastRun as Record<string, unknown>;
    expect(lastRun).not.toBeNull();
  }, { timeout: 10_000, interval: 50 });
  return lastRun as unknown as Record<string, unknown>;
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "scriverse-s3-backup-test-"));
  mkdirSync(join(directory, "attachments"), { recursive: true });
  runtime = createRuntime({
    databasePath: join(directory, "novel.db"),
    attachmentDirectory: join(directory, "attachments"),
    masterSecret: "s3-backup-test-master-secret-with-enough-length",
    serveUi: false,
    revealCaptchaAnswer: true,
    fetchImpl: s3.fetchMock,
    security: { allowRegistration: true, enforceSameOrigin: true, setupToken }
  });
  server = runtime.app.listen(0);
  server.unref();
  admin = await register(runtime.app, "backup-admin");
  expect(admin.user.role).toBe("admin");
  member = await register(runtime.app, "backup-member");
  expect(member.user.role).toBe("user");
});

afterEach(async () => {
  // 等待进行中的备份结束，避免 running 状态泄漏到下一个用例。
  await vi.waitFor(async () => {
    const status = await admin.agent.get("/api/platform/backup/status").expect(200);
    expect(status.body.data.running).toBe(false);
  }, { timeout: 15_000, interval: 50 });
  s3.objects.clear();
  s3.calls.length = 0;
  s3.putHandlers.length = 0;
  runtime.database.run("DELETE FROM backup_targets");
  runtime.database.run("DELETE FROM backup_runs");
  runtime.database.run(
    "UPDATE backup_settings SET schedule_enabled = 0, schedule_time = '03:00', backup_images = 1, retention_count = 14, updated_at = ? WHERE id = 1",
    new Date().toISOString()
  );
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
  runtime.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("S3 备份 API 权限", () => {
  it("未登录访问备份设置返回 401", async () => {
    const response = await request(runtime.app).get("/api/platform/backup/settings").expect(401);
    expect(response.body.error.code).toBe("AUTH_REQUIRED");
  });

  it("普通用户访问备份设置返回 403", async () => {
    const response = await member.agent.get("/api/platform/backup/settings").expect(403);
    expect(response.body.error.code).toBe("ADMIN_REQUIRED");
  });

  it("普通用户不能创建备份目标", async () => {
    await createTarget(member).expect(403);
  });

  it("管理员读取默认备份设置", async () => {
    const response = await admin.agent.get("/api/platform/backup/settings").expect(200);
    expect(response.body.data).toEqual({
      scheduleEnabled: false,
      scheduleTime: "03:00",
      backupImages: true,
      retentionCount: 14,
      updatedAt: expect.any(String)
    });
  });
});

describe("S3 备份设置更新", () => {
  it("管理员更新备份设置", async () => {
    const response = await admin.agent.patch("/api/platform/backup/settings")
      .set("x-csrf-token", admin.csrfToken)
      .send({ scheduleEnabled: true, scheduleTime: "04:30", backupImages: false, retentionCount: 7 })
      .expect(200);
    expect(response.body.data.scheduleEnabled).toBe(true);
    expect(response.body.data.scheduleTime).toBe("04:30");
    expect(response.body.data.backupImages).toBe(false);
    expect(response.body.data.retentionCount).toBe(7);
  });

  it("拒绝非法定时时间与留存个数", async () => {
    await admin.agent.patch("/api/platform/backup/settings")
      .set("x-csrf-token", admin.csrfToken)
      .send({ scheduleTime: "25:00" })
      .expect(400);
    await admin.agent.patch("/api/platform/backup/settings")
      .set("x-csrf-token", admin.csrfToken)
      .send({ retentionCount: 0 })
      .expect(400);
    await admin.agent.patch("/api/platform/backup/settings")
      .set("x-csrf-token", admin.csrfToken)
      .send({ retentionCount: 400 })
      .expect(400);
  });
});

describe("S3 备份目标管理", () => {
  it("创建目标后列表返回掩码后的访问密钥", async () => {
    const created = await createTarget(admin).expect(201);
    expect(created.body.data.id).toBeTruthy();
    expect(created.body.data.accessKeyId).toBe("AKIA****456");
    expect(created.body.data.secretAccessKey).toBeUndefined();
    const list = await admin.agent.get("/api/platform/backup/targets").expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].endpoint).toBe("http://127.0.0.1:19000");
    expect(list.body.data[0].prefix).toBe("novel-backup");
  });

  it("更新目标时密钥留空保持不变", async () => {
    const created = await createTarget(admin).expect(201);
    const targetId = created.body.data.id as string;
    await admin.agent.patch(`/api/platform/backup/targets/${targetId}`)
      .set("x-csrf-token", admin.csrfToken)
      .send({
        name: "改名后的目标",
        endpoint: "http://127.0.0.1:19000",
        region: "us-east-1",
        bucket: "backup-bucket",
        prefix: "other-prefix",
        accessKeyId: "AKIATESTKEY123456",
        enabled: false
      })
      .expect(200);
    const list = await admin.agent.get("/api/platform/backup/targets").expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].name).toBe("改名后的目标");
    expect(list.body.data[0].prefix).toBe("other-prefix");
    expect(list.body.data[0].enabled).toBe(false);
  });

  it("删除目标", async () => {
    const created = await createTarget(admin).expect(201);
    await admin.agent.delete(`/api/platform/backup/targets/${String(created.body.data.id)}`)
      .set("x-csrf-token", admin.csrfToken)
      .expect(204);
    const list = await admin.agent.get("/api/platform/backup/targets").expect(200);
    expect(list.body.data).toHaveLength(0);
  });

  it("拒绝内嵌凭据与链路本地 endpoint", async () => {
    const withCredentials = await createTarget(admin, { endpoint: "http://user:pass@127.0.0.1:19000" });
    expect(withCredentials.status).toBe(400);
    expect(withCredentials.body.error.code).toBe("UNSAFE_BACKUP_ENDPOINT");
    const linkLocal = await createTarget(admin, { endpoint: "http://169.254.169.254" });
    expect(linkLocal.status).toBe(400);
    expect(linkLocal.body.error.code).toBe("UNSAFE_BACKUP_ENDPOINT");
  });
});

describe("S3 备份执行", () => {
  it("无启用目标时拒绝执行", async () => {
    const response = await admin.agent.post("/api/platform/backup/run")
      .set("x-csrf-token", admin.csrfToken)
      .send({})
      .expect(400);
    expect(response.body.error.code).toBe("BACKUP_TARGET_REQUIRED");
  });

  it("备份数据库与缺失图片，跳过已存在图片并清理超留存的旧快照", async () => {
    await admin.agent.patch("/api/platform/backup/settings")
      .set("x-csrf-token", admin.csrfToken)
      .send({ backupImages: true, retentionCount: 2 })
      .expect(200);
    await createTarget(admin).expect(201);
    // 远端已存在两个旧快照与一张图片
    s3.objects.set("novel-backup/scriverse/db/novel-20260810-030000.db", Buffer.from("old-1"));
    s3.objects.set("novel-backup/scriverse/db/novel-20260811-030000.db", Buffer.from("old-2"));
    s3.objects.set("novel-backup/scriverse/img/ab/existing.webp", Buffer.from("existing-image"));
    // 本地附件：一张已存在于远端，一张缺失
    mkdirSync(attachmentPath(directory, "attachments/ab"), { recursive: true });
    writeFileSync(attachmentPath(directory, "attachments/ab/existing.webp"), "local-existing");
    writeFileSync(attachmentPath(directory, "attachments/ab/missing.webp"), "local-missing");

    const triggered = await admin.agent.post("/api/platform/backup/run")
      .set("x-csrf-token", admin.csrfToken)
      .send({})
      .expect(202);
    expect(triggered.body.data.status).toBe("running");
    const lastRun = await waitForBackupFinish(runtime.app, admin);
    expect(lastRun.status).toBe("success");
    expect(lastRun.trigger).toBe("manual");
    const results = lastRun.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("success");
    expect(results[0]?.databaseKey).toMatch(/^novel-backup\/scriverse\/db\/novel-\d{8}-\d{6}\.db$/u);
    expect(results[0]?.imagesUploaded).toBe(1);
    expect(results[0]?.imagesSkipped).toBe(1);
    expect(results[0]?.imagesFailed).toBe(0);
    expect(results[0]?.retainedDeleted).toBe(1);
    // 上传了新的数据库快照与缺失图片，未重复上传已存在图片
    const dbPuts = s3.calls.filter((call) => call.method === "PUT" && call.key.startsWith("novel-backup/scriverse/db/"));
    expect(dbPuts).toHaveLength(1);
    const imgPuts = s3.calls.filter((call) => call.method === "PUT" && call.key.startsWith("novel-backup/scriverse/img/"));
    expect(imgPuts.map((call) => call.key)).toEqual(["novel-backup/scriverse/img/ab/missing.webp"]);
    // 删除了最老的快照，保留 2 个
    const deletions = s3.calls.filter((call) => call.method === "DELETE").map((call) => call.key);
    expect(deletions).toEqual(["novel-backup/scriverse/db/novel-20260810-030000.db"]);
    expect(s3.objects.has("novel-backup/scriverse/db/novel-20260811-030000.db")).toBe(true);
  });

  it("关闭图片备份时只上传数据库", async () => {
    await admin.agent.patch("/api/platform/backup/settings")
      .set("x-csrf-token", admin.csrfToken)
      .send({ backupImages: false, retentionCount: 14 })
      .expect(200);
    await createTarget(admin).expect(201);
    const lastRun = await (async () => {
      await admin.agent.post("/api/platform/backup/run")
        .set("x-csrf-token", admin.csrfToken)
        .send({})
        .expect(202);
      return waitForBackupFinish(runtime.app, admin);
    })();
    expect(lastRun.status).toBe("success");
    expect(s3.calls.some((call) => call.method === "PUT" && call.key.startsWith("novel-backup/scriverse/db/"))).toBe(true);
    expect(s3.calls.some((call) => call.key.startsWith("novel-backup/scriverse/img/"))).toBe(false);
  });

  it("S3 服务失败时记录失败结果与完整日志，不泄露访问密钥", async () => {
    await admin.agent.patch("/api/platform/backup/settings")
      .set("x-csrf-token", admin.csrfToken)
      .send({ backupImages: true })
      .expect(200);
    await createTarget(admin).expect(201);
    const errorBody = "<?xml version=\"1.0\"?><Error><Code>AccessDenied</Code><Message>Access Denied for bucket backup-bucket</Message></Error>";
    s3.putHandlers.push((key) => key.startsWith("novel-backup/scriverse/db/") ? new Response(errorBody, { status: 403 }) : null);
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await admin.agent.post("/api/platform/backup/run")
        .set("x-csrf-token", admin.csrfToken)
        .send({})
        .expect(202);
      const lastRun = await waitForBackupFinish(runtime.app, admin);
      expect(lastRun.status).toBe("failed");
      const results = lastRun.results as Array<Record<string, unknown>>;
      expect(results[0]?.status).toBe("failed");
      expect(String(results[0]?.errorMessage)).toContain("HTTP 403");
      const failureLogs = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("backup.target_failed"));
      expect(failureLogs.length).toBeGreaterThan(0);
      const failureLog = failureLogs[0] ?? "";
      expect(failureLog).toContain("Access Denied for bucket backup-bucket");
      expect(failureLog).toContain("http://127.0.0.1:19000");
      expect(failureLog).toContain("backup-bucket");
      expect(failureLog).not.toContain("AKIATESTKEY123456");
      expect(failureLog).not.toContain("test-secret-key-value-0123456789");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("备份执行期间重复触发返回 409", async () => {
    await createTarget(admin).expect(201);
    let releasePut: (() => void) | null = null;
    let blockedDbPut = false;
    s3.putHandlers.push((key) => {
      if (!key.startsWith("novel-backup/scriverse/db/") || blockedDbPut) return null;
      blockedDbPut = true;
      return new Promise<Response>((resolvePut) => {
        releasePut = () => resolvePut(new Response(null, { status: 200 }));
      }) as unknown as Response;
    });
    await admin.agent.post("/api/platform/backup/run")
      .set("x-csrf-token", admin.csrfToken)
      .send({})
      .expect(202);
    const duplicate = await admin.agent.post("/api/platform/backup/run")
      .set("x-csrf-token", admin.csrfToken)
      .send({})
      .expect(409);
    expect(duplicate.body.error.code).toBe("BACKUP_ALREADY_RUNNING");
    // 等待备份线程真正进入数据库上传阶段再放行，验证挂起期间 running 状态保持。
    await vi.waitFor(() => {
      expect(releasePut).not.toBeNull();
    }, { timeout: 5_000, interval: 20 });
    releasePut?.();
    await waitForBackupFinish(runtime.app, admin);
  }, 15_000);
});
