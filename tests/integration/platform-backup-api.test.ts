import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

type MockObject = {
  body: Buffer;
  contentType: string;
};

function createMockS3Fetch(store: Map<string, MockObject>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    const path = decodeURIComponent(url.pathname.replace(/^\/+/u, ""));
    const [, ...rest] = path.split("/");
    const key = rest.join("/");

    if (method === "HEAD") {
      return store.has(key)
        ? new Response(null, { status: 200 })
        : new Response(null, { status: 404 });
    }
    if (method === "PUT") {
      const raw = init?.body;
      let body: Buffer;
      if (Buffer.isBuffer(raw)) body = raw;
      else if (raw instanceof Uint8Array) body = Buffer.from(raw);
      else if (typeof raw === "string") body = Buffer.from(raw, "utf8");
      else body = Buffer.alloc(0);
      store.set(key, {
        body,
        contentType: String((init?.headers as Record<string, string> | undefined)?.["content-type"] ?? "application/octet-stream")
      });
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      store.delete(key);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...store.keys()].filter((item) => item.startsWith(prefix)).sort();
      const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((item) => `<Contents><Key>${item}</Key><LastModified>2026-08-05T00:00:00.000Z</LastModified><Size>${store.get(item)?.body.byteLength ?? 0}</Size></Contents>`).join("")}</ListBucketResult>`;
      return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
    }
    return new Response(`unexpected ${method} ${url}`, { status: 500 });
  };
}

function createBackupTestRuntime(fetchImpl: typeof fetch): Runtime {
  const attachmentDirectory = mkdtempSync(join(tmpdir(), "scriverse-backup-attach-"));
  const runtime = createRuntime({
    databasePath: ":memory:",
    masterSecret: "test-master-secret-with-at-least-32-characters",
    disableUserAuth: true,
    attachmentDirectory,
    fetchImpl,
    serveUi: false
  });
  const server = runtime.app.listen(0);
  server.unref();
  return {
    ...runtime,
    app: server as unknown as Runtime["app"],
    close: () => {
      server.closeAllConnections();
      server.close();
      runtime.close();
      rmSync(attachmentDirectory, { recursive: true, force: true });
    }
  };
}

describe("platform S3 backup API", () => {
  let runtime: Runtime | undefined;

  afterEach(() => {
    runtime?.close();
    runtime = undefined;
  });

  it("backs up database and images to multiple targets sequentially and skips existing images", async () => {
    const firstStore = new Map<string, MockObject>();
    const secondStore = new Map<string, MockObject>();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.host.includes("one.example")) return createMockS3Fetch(firstStore)(input, init);
      if (url.host.includes("two.example")) return createMockS3Fetch(secondStore)(input, init);
      return new Response("unknown host", { status: 500 });
    }) as typeof fetch;

    runtime = createBackupTestRuntime(fetchImpl);
    const storageKey = `ab/${"a".repeat(64)}.webp`;
    mkdirSync(join(runtime.attachmentStorage.rootDirectory, "ab"), { recursive: true });
    writeFileSync(join(runtime.attachmentStorage.rootDirectory, storageKey), Buffer.from("fake-image-bytes"));

    await request(runtime.app).post("/api/platform/backup/targets").send({
      name: "目标一",
      endpoint: "https://one.example",
      region: "us-east-1",
      bucket: "bucket-one",
      prefix: "prod",
      accessKeyId: "AKIAONE",
      secretAccessKey: "secret-one-value",
      enabled: true
    }).expect(201);

    await request(runtime.app).post("/api/platform/backup/targets").send({
      name: "目标二",
      endpoint: "https://two.example",
      region: "us-east-1",
      bucket: "bucket-two",
      accessKeyId: "AKIATWO",
      secretAccessKey: "secret-two-value",
      enabled: true
    }).expect(201);

    await request(runtime.app).patch("/api/platform/backup/settings").send({
      enabled: false,
      includeImages: true,
      scheduleTime: "03:00",
      retentionCount: 2
    }).expect(200);

    const firstRun = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    expect(firstRun.body.data.status).toBe("succeeded");
    expect(firstRun.body.data.targets).toHaveLength(2);
    expect([...firstStore.keys()]).toEqual(expect.arrayContaining([
      `prod/scriverse/img/${storageKey}`,
      expect.stringMatching(/^prod\/scriverse\/db\/novel-.*\.db$/u)
    ]));
    expect([...secondStore.keys()]).toEqual(expect.arrayContaining([
      `scriverse/img/${storageKey}`,
      expect.stringMatching(/^scriverse\/db\/novel-.*\.db$/u)
    ]));

    const settings = await request(runtime.app).get("/api/platform/backup/settings").expect(200);
    expect(settings.body.data.targets[0].accessKeyHint).toContain("*");
    expect(JSON.stringify(settings.body.data)).not.toContain("secret-one-value");

    const secondRun = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    expect(secondRun.body.data.targets.every((target: { imagesSkipped: number }) => target.imagesSkipped >= 1)).toBe(true);

    await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    const dbKeys = [...firstStore.keys()].filter((key) => key.includes("/db/") && key.endsWith(".db")).sort();
    expect(dbKeys).toHaveLength(2);
  });

  it("surfaces s3 failures without silent success", async () => {
    const fetchImpl = (async () => new Response("<Error><Code>AccessDenied</Code><Message>denied</Message></Error>", {
      status: 403,
      headers: { "content-type": "application/xml" }
    })) as typeof fetch;
    runtime = createBackupTestRuntime(fetchImpl);
    await request(runtime.app).post("/api/platform/backup/targets").send({
      name: "坏目标",
      endpoint: "https://bad.example",
      bucket: "bad-bucket",
      accessKeyId: "AKIABAD",
      secretAccessKey: "secret-bad-value",
      enabled: true
    }).expect(201);
    await request(runtime.app).patch("/api/platform/backup/settings").send({ includeImages: false }).expect(200);
    const failed = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(502);
    expect(failed.body.error.code).toBe("BACKUP_FAILED");
    expect(failed.body.error.message).toMatch(/坏目标/u);
    const status = await request(runtime.app).get("/api/platform/backup/status").expect(200);
    expect(status.body.data.lastRunStatus).toBe("failed");
    expect(status.body.data.lastRunError).toMatch(/坏目标/u);
  });

  it("rejects non-admin access when authentication is enabled", async () => {
    const setupToken = "backup-auth-setup-token-with-at-least-32-chars";
    const authRuntime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "test-master-secret-with-at-least-32-characters",
      serveUi: false,
      revealCaptchaAnswer: true,
      security: { allowRegistration: true, enforceSameOrigin: true, setupToken }
    });
    const server = authRuntime.app.listen(0);
    server.unref();
    try {
      const adminAgent = request.agent(server);
      const captcha = await request(server).get("/api/auth/captcha").expect(200);
      await adminAgent.post("/api/auth/register").send({
        username: "backup-admin",
        password: "secure-password-123",
        passwordConfirmation: "secure-password-123",
        setupToken,
        captchaId: captcha.body.data.captchaId,
        captchaAnswer: captcha.body.data.answer
      }).expect(201);

      const userAgent = request.agent(server);
      const userCaptcha = await request(server).get("/api/auth/captcha").expect(200);
      const user = await userAgent.post("/api/auth/register").send({
        username: "backup-user",
        password: "secure-password-123",
        passwordConfirmation: "secure-password-123",
        captchaId: userCaptcha.body.data.captchaId,
        captchaAnswer: userCaptcha.body.data.answer
      }).expect(201);

      await userAgent.get("/api/platform/backup/settings").expect(403);
      await userAgent.patch("/api/platform/backup/settings")
        .set("X-CSRF-Token", user.body.data.csrfToken)
        .send({ enabled: true })
        .expect(403);
      await adminAgent.get("/api/platform/backup/settings").expect(200);
    } finally {
      server.closeAllConnections();
      server.close();
      authRuntime.close();
    }
  });

  it("rejects private s3 endpoints when SSRF validation is enabled", async () => {
    const setupToken = "backup-ssrf-setup-token-with-at-least-32-chars";
    const authRuntime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "test-master-secret-with-at-least-32-characters",
      serveUi: false,
      revealCaptchaAnswer: true,
      security: {
        allowRegistration: true,
        enforceSameOrigin: true,
        setupToken,
        allowPrivateAiEndpoints: false
      }
    });
    const server = authRuntime.app.listen(0);
    server.unref();
    try {
      const adminAgent = request.agent(server);
      const captcha = await request(server).get("/api/auth/captcha").expect(200);
      const admin = await adminAgent.post("/api/auth/register").send({
        username: "backup-ssrf-admin",
        password: "secure-password-123",
        passwordConfirmation: "secure-password-123",
        setupToken,
        captchaId: captcha.body.data.captchaId,
        captchaAnswer: captcha.body.data.answer
      }).expect(201);

      const blocked = await adminAgent.post("/api/platform/backup/targets")
        .set("X-CSRF-Token", admin.body.data.csrfToken)
        .send({
          name: "内网 MinIO",
          endpoint: "http://127.0.0.1:9000",
          bucket: "local-bucket",
          accessKeyId: "minioadmin",
          secretAccessKey: "minioadmin-secret"
        })
        .expect(400);
      expect(blocked.body.error.code).toBe("UNSAFE_BACKUP_ENDPOINT");
    } finally {
      server.closeAllConnections();
      server.close();
      authRuntime.close();
    }
  });
});
