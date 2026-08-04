import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

const setupToken = "s3-backup-test-setup-token-with-at-least-32-characters";

type SessionCredentials = {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  user: { userId: string; username: string; role: "admin" | "user" };
};

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

async function solveCaptcha(app: Runtime["app"]): Promise<{ captchaId: string; captchaAnswer: string }> {
  const response = await request(app).get("/api/auth/captcha").expect(200);
  return { captchaId: response.body.data.captchaId, captchaAnswer: response.body.data.answer };
}

async function register(runtime: Runtime, username: string): Promise<SessionCredentials> {
  const agent = request.agent(runtime.app);
  const response = await agent.post("/api/auth/register").send({
    username,
    password: "secure-password-123",
    passwordConfirmation: "secure-password-123",
    setupToken,
    ...(await solveCaptcha(runtime.app))
  }).expect(201);
  return { agent, csrfToken: response.body.data.csrfToken, user: response.body.data.user };
}

function createFileRuntime(root: string, fetchImpl: typeof fetch): Runtime {
  return createRuntime({
    databasePath: join(root, "novel.db"),
    attachmentDirectory: join(root, "attachments"),
    masterSecret: "s3-backup-test-master-secret-with-enough-length",
    disableUserAuth: true,
    fetchImpl,
    serveUi: false
  });
}

function objectKeyFromPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  expect(segments[0]).toBe("novel-bucket");
  return segments.slice(1).join("/");
}

describe("S3 备份 API", () => {
  const roots: string[] = [];
  let runtime: Runtime | null = null;

  afterEach(() => {
    runtime?.close();
    runtime = null;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("上传数据库快照、跳过已存在图片并按留存清理最老数据库备份", async () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-s3-backup-"));
    roots.push(root);
    const objects = new Map<string, { body: Buffer; contentType: string; lastModified: string }>();
    const deletedKeys: string[] = [];
    objects.set("backups/scriverse/db/novel-20000101T000000000Z.db", {
      body: Buffer.from("old database"),
      contentType: "application/vnd.sqlite3",
      lastModified: "2000-01-01T00:00:00.000Z"
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const key = objectKeyFromPath(url.pathname);
      if (init?.method === "HEAD") {
        return new Response(null, { status: objects.has(key) ? 200 : 404 });
      }
      if (init?.method === "PUT") {
        const body = init.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.from(String(init?.body ?? ""));
        objects.set(key, {
          body,
          contentType: String((init.headers as Headers).get("content-type") ?? ""),
          lastModified: key.includes("20000101") ? "2000-01-01T00:00:00.000Z" : "2026-08-04T12:00:00.000Z"
        });
        return new Response("", { status: 200 });
      }
      if (init?.method === "DELETE") {
        deletedKeys.push(key);
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      if (init?.method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const contents = [...objects.entries()]
          .filter(([objectKey]) => objectKey.startsWith(prefix))
          .map(([objectKey, object]) => `<Contents><Key>${escapeXml(objectKey)}</Key><LastModified>${object.lastModified}</LastModified><Size>${object.body.byteLength}</Size></Contents>`)
          .join("");
        return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`, {
          status: 200,
          headers: { "Content-Type": "application/xml" }
        });
      }
      return new Response("unexpected request", { status: 500 });
    });
    runtime = createFileRuntime(root, fetchMock);
    runtime.database.raw.exec("CREATE TABLE backup_marker(value TEXT); INSERT INTO backup_marker(value) VALUES ('snapshot-ok')");
    const work = runtime.store.createWork({ title: "S3 图片作品" });
    const png = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 32, g: 96, b: 160 } }
    }).png().toBuffer();
    const upload = await request(runtime.app)
      .post(`/api/works/${String(work.id)}/attachments`)
      .attach("file", png, { filename: "备份图.png", contentType: "image/png" })
      .expect(201);
    const existingImageKey = `backups/scriverse/img/attachments/${String(upload.body.data.storageKey)}`;
    objects.set(existingImageKey, {
      body: Buffer.from("existing image"),
      contentType: String(upload.body.data.storedMimeType),
      lastModified: "2026-01-01T00:00:00.000Z"
    });

    const created = await request(runtime.app).post("/api/platform/backups").send({
      name: "兼容 S3",
      endpoint: "https://s3.mock.test",
      region: "us-east-1",
      bucket: "novel-bucket",
      subdirectory: "backups",
      accessKeyId: "AKIA-SENSITIVE-TEST",
      secretAccessKey: "secret-sensitive-test",
      enabled: true,
      backupImages: true,
      scheduleTime: "03:30",
      retentionCount: 1
    }).expect(201);
    expect(created.body.data).toMatchObject({
      name: "兼容 S3",
      subdirectory: "backups"
    });
    expect(created.body.data.accessKeyHint).toMatch(/^AKIA\*+TEST$/u);
    expect(created.body.data).not.toHaveProperty("accessKeyId");
    expect(created.body.data).not.toHaveProperty("secretAccessKey");
    const stored = runtime.database.get<Record<string, unknown>>("SELECT encrypted_access_key_id, encrypted_secret_access_key FROM s3_backup_targets WHERE id = ?", created.body.data.id);
    expect(String(stored?.encrypted_access_key_id)).not.toContain("AKIA-SENSITIVE-TEST");
    expect(String(stored?.encrypted_secret_access_key)).not.toContain("secret-sensitive-test");

    const run = await request(runtime.app).post("/api/platform/backups/run").send({}).expect(202);
    expect(run.body.data.results[0]).toMatchObject({
      targetId: created.body.data.id,
      uploadedDatabaseCount: 1,
      uploadedImageCount: 0,
      skippedImageCount: 1,
      deletedDatabaseBackupCount: 1
    });
    const databaseKeys = [...objects.keys()].filter((key) => key.startsWith("backups/scriverse/db/"));
    expect(databaseKeys).toHaveLength(1);
    const databaseKey = databaseKeys[0];
    expect(databaseKey).toBeTruthy();
    expect(databaseKey).toMatch(/^backups\/scriverse\/db\/novel-\d{8}T\d{9}Z\.db$/u);
    expect(objects.get(databaseKey!)?.body.subarray(0, 16).toString("utf8")).toBe("SQLite format 3\0");
    expect(objects.has(existingImageKey)).toBe(true);
    expect(deletedKeys).toEqual(["backups/scriverse/db/novel-20000101T000000000Z.db"]);
  });

  it("S3 服务失败时返回目标配置与服务端响应且不泄露 AK/SK", async () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-s3-backup-failed-"));
    roots.push(root);
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("<Error><Message>signature mismatch</Message></Error>", {
      status: 403,
      statusText: "Forbidden",
      headers: { "x-amz-request-id": "request-1" }
    }));
    runtime = createFileRuntime(root, fetchMock);
    const created = await request(runtime.app).post("/api/platform/backups").send({
      name: "失败目标",
      endpoint: "https://s3.failed.test",
      region: "us-west-2",
      bucket: "novel-bucket",
      accessKeyId: "AKIA-FAILED-TEST",
      secretAccessKey: "failed-secret-test",
      enabled: true,
      backupImages: false,
      scheduleTime: "04:00",
      retentionCount: 2
    }).expect(201);

    const failed = await request(runtime.app).post("/api/platform/backups/run").send({}).expect(502);
    expect(failed.body.error.code).toBe("S3_BACKUP_FAILED");
    expect(failed.body.error.details.failures[0]).toMatchObject({
      targetId: created.body.data.id,
      targetName: "失败目标",
      config: {
        endpoint: "https://s3.failed.test",
        region: "us-west-2",
        bucket: "novel-bucket"
      },
      serverResponse: {
        status: 403,
        statusText: "Forbidden",
        body: "<Error><Message>signature mismatch</Message></Error>"
      }
    });
    const serialized = JSON.stringify(failed.body.error.details);
    expect(serialized).not.toContain("AKIA-FAILED-TEST");
    expect(serialized).not.toContain("failed-secret-test");
    expect(runtime.database.get("SELECT last_status FROM s3_backup_targets WHERE id = ?", created.body.data.id)).toEqual({ last_status: "failed" });
  });

  it("启用运行时安全配置时拒绝受保护网络的 S3 Endpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-s3-backup-ssrf-"));
    roots.push(root);
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("", { status: 200 }));
    runtime = createRuntime({
      databasePath: join(root, "novel.db"),
      attachmentDirectory: join(root, "attachments"),
      masterSecret: "s3-backup-ssrf-test-master-secret-with-enough-length",
      disableUserAuth: true,
      fetchImpl: fetchMock,
      serveUi: false,
      security: { enforceSameOrigin: true }
    });
    await request(runtime.app).post("/api/platform/backups").send({
      name: "内网目标",
      endpoint: "http://127.0.0.1:13212",
      region: "us-east-1",
      bucket: "novel-bucket",
      accessKeyId: "AKIA-SSRF-TEST",
      secretAccessKey: "ssrf-secret-test",
      enabled: true,
      backupImages: false
    }).expect(201);

    const failed = await request(runtime.app).post("/api/platform/backups/run").send({}).expect(502);
    expect(failed.body.error.code).toBe("S3_BACKUP_FAILED");
    expect(failed.body.error.details.failures[0].message).toContain("受保护");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("平台备份配置要求登录、管理员权限和 CSRF", async () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "s3-backup-auth-test-master-secret-with-enough-length",
      serveUi: false,
      revealCaptchaAnswer: true,
      security: { allowRegistration: true, enforceSameOrigin: true, setupToken }
    });
    const admin = await register(runtime, "s3_backup_admin");
    const writer = await register(runtime, "s3_backup_writer");
    await request(runtime.app).get("/api/platform/backups").expect(401);
    await writer.agent.get("/api/platform/backups").expect(403);
    await admin.agent.post("/api/platform/backups").send({
      name: "无 CSRF",
      endpoint: "https://s3.auth.test",
      region: "us-east-1",
      bucket: "novel-bucket",
      accessKeyId: "AKIA-AUTH-TEST",
      secretAccessKey: "auth-secret-test"
    }).expect(403);
    await admin.agent.post("/api/platform/backups")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({
        name: "有效目标",
        endpoint: "https://access:secret@s3.auth.test",
        region: "us-east-1",
        bucket: "novel-bucket",
        accessKeyId: "AKIA-AUTH-TEST",
        secretAccessKey: "auth-secret-test"
      })
      .expect(400);
    await admin.agent.post("/api/platform/backups")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({
        name: "有效目标",
        endpoint: "https://s3.auth.test",
        region: "us-east-1",
        bucket: "novel-bucket",
        accessKeyId: "AKIA-AUTH-TEST",
        secretAccessKey: "auth-secret-test",
        unknown: true
      })
      .expect(400);
    await admin.agent.post("/api/platform/backups")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({
        name: "有效目标",
        endpoint: "https://s3.auth.test",
        region: "us-east-1",
        bucket: "novel-bucket",
        accessKeyId: "AKIA-AUTH-TEST",
        secretAccessKey: "auth-secret-test"
      })
      .expect(201);
  });
});
