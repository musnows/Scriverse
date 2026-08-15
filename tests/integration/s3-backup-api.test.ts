import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

type MockS3State = {
  dbKeys: string[];
  images: Set<string>;
  deleted: string[];
  authorizations: string[];
  paths: string[];
};

function createMockS3Fetch() {
  const state: MockS3State = { dbKeys: [], images: new Set(), deleted: [], authorizations: [], paths: [] };
  const fetchImpl = async (input: unknown, init?: { method?: string; headers?: Headers | Record<string, string> }) => {
    const url = new URL(typeof input === "string" ? input : (input as { url: string }).url);
    const method = String(init?.method ?? "GET").toUpperCase();
    const headers = init?.headers;
    const authorization = typeof headers?.get === "function"
      ? headers.get("Authorization") ?? ""
      : (headers as Record<string, string> | undefined)?.Authorization ?? (headers as Record<string, string> | undefined)?.authorization ?? "";
    state.authorizations.push(authorization);
    state.paths.push(`${method} ${decodeURIComponent(url.pathname)}`);
    const path = decodeURIComponent(url.pathname);
    if (path.startsWith("/denied-bucket")) {
      return new Response(
        '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
        { status: 403, headers: { "content-type": "application/xml" } }
      );
    }
    if (!path.startsWith("/backup-bucket")) return new Response(null, { status: 404 });
    const key = path.replace(/^\/backup-bucket\/?/u, "");
    if (method === "HEAD" && !key) return new Response(null, { status: 200 });
    if (method === "GET" && !key) {
      const items = [...state.dbKeys.map((item) => `<Key>${item}</Key>`), ...[...state.images].map((item) => `<Key>${item}</Key>`)].join("");
      return new Response(
        `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`,
        { status: 200, headers: { "content-type": "application/xml" } }
      );
    }
    if (method === "PUT") {
      if (key.includes("/db/")) state.dbKeys.push(key);
      else state.images.add(key);
      return new Response(null, { status: 200 });
    }
    if (method === "HEAD") return new Response(null, { status: state.images.has(key) ? 200 : 404 });
    if (method === "DELETE") {
      state.dbKeys = state.dbKeys.filter((item) => item !== key);
      state.images.delete(key);
      state.deleted.push(key);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 400 });
  };
  return { state, fetchImpl };
}

const { state: s3State, fetchImpl: mockFetch } = createMockS3Fetch();
const runtime = createRuntime({
  databasePath: ":memory:",
  masterSecret: "s3-backup-integration-test-secret-with-32-chars",
  fetchImpl: mockFetch as unknown as typeof fetch,
  disableUserAuth: true,
  serveUi: false
});

let targetId = "";
const imageHash = `${"0".repeat(62)}ab`;

async function waitForRunDone(runId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = runtime.backup.getRun(runId);
    if (String(run.status) !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("备份运行超时未完成");
}

async function startRunAndAwait(body: Record<string, unknown> = {}): Promise<{ run: Record<string, unknown>; results: Array<Record<string, unknown>> }> {
  const response = await request(runtime.app).post("/api/platform/backup/s3/run").send(body).expect(202);
  const run = await waitForRunDone(String(response.body.data.id));
  return { run, results: (run.results as Array<Record<string, unknown>>) ?? [] };
}

beforeAll(() => {
  mkdirSync(join(runtime.attachmentStorage.rootDirectory, "ab"), { recursive: true });
  writeFileSync(join(runtime.attachmentStorage.rootDirectory, "ab", `${imageHash}.webp`), "fake-webp-content");
});

afterAll(() => runtime.close());

describe("S3 备份目标配置 API", () => {
  it("创建目标后返回脱敏视图，不包含 SecretAccessKey", async () => {
    const response = await request(runtime.app).post("/api/platform/backup/s3/targets").send({
      name: "主备份",
      endpointUrl: "https://s3.example.com",
      region: "us-east-1",
      bucket: "backup-bucket",
      prefix: "/backups/novel/",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "top-secret-key-123456",
      pathStyle: true
    }).expect(201);
    targetId = String(response.body.data.id);
    expect(response.body.data.prefix).toBe("backups/novel");
    expect(response.body.data.secretHint).toBe("top***456");
    expect(JSON.stringify(response.body.data)).not.toContain("top-secret-key-123456");
    expect(JSON.stringify(response.body.data)).not.toContain("secretAccessKey");
  });

  it("缺少密钥或非法字段时拒绝创建与更新", async () => {
    await request(runtime.app).post("/api/platform/backup/s3/targets").send({
      name: "缺少密钥",
      endpointUrl: "https://s3.example.com",
      bucket: "backup-bucket",
      accessKeyId: "AKIDEXAMPLE"
    }).expect(400);
    await request(runtime.app).patch(`/api/platform/backup/s3/targets/${targetId}`).send({ prefix: "bad$prefix" }).expect(400);
  });

  it("更新目标名称并保留原密钥", async () => {
    const response = await request(runtime.app).patch(`/api/platform/backup/s3/targets/${targetId}`).send({ name: "主备份-改" }).expect(200);
    expect(response.body.data.name).toBe("主备份-改");
    expect(response.body.data.secretHint).toBe("top***456");
  });

  it("设置校验时间格式并计算下次定时时间", async () => {
    await request(runtime.app).patch("/api/platform/backup/s3/settings").send({ scheduleTime: "25:00" }).expect(400);
    const response = await request(runtime.app).patch("/api/platform/backup/s3/settings").send({
      includeImages: true,
      retentionCount: 10,
      scheduleEnabled: true,
      scheduleTime: "03:00"
    }).expect(200);
    expect(response.body.data.scheduleEnabled).toBe(true);
    expect(response.body.data.nextRunAt).toEqual(expect.any(String));
    await request(runtime.app).patch("/api/platform/backup/s3/settings").send({ scheduleEnabled: false }).expect(200);
  });
});

describe("S3 备份执行", () => {
  it("第一次备份上传数据库快照与图片，请求携带 SigV4 签名", async () => {
    const { run, results } = await startRunAndAwait({ includeImages: true });
    expect(run.status).toBe("completed");
    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(String(result.dbKey)).toMatch(/^backups\/novel\/scriverse\/db\/scriverse-db-\d{8}T\d{9}Z\.db$/u);
    expect(result.uploadedImages).toBe(1);
    expect(result.skippedImages).toBe(0);
    expect(s3State.dbKeys).toHaveLength(1);
    expect(s3State.images).toEqual(new Set([`backups/novel/scriverse/img/ab/${imageHash}.webp`]));
    expect(s3State.authorizations.every((value) => value.startsWith("AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/"))).toBe(true);
  });

  it("第二次备份跳过已存在图片，数据库快照不覆盖历史", async () => {
    const { run, results } = await startRunAndAwait({ includeImages: true });
    expect(run.status).toBe("completed");
    expect(results[0]!.skippedImages).toBe(1);
    expect(results[0]!.uploadedImages).toBe(0);
    expect(s3State.dbKeys).toHaveLength(2);
    expect(s3State.deleted).toHaveLength(0);
  });

  it("不勾选图片时仅备份数据库", async () => {
    const { results } = await startRunAndAwait({ includeImages: false });
    expect(results[0]!.uploadedImages).toBe(0);
    expect(results[0]!.skippedImages).toBe(0);
    expect(s3State.images.size).toBe(1);
  });

  it("超出留存个数后删除最老的数据库备份，不清理图片", async () => {
    await request(runtime.app).patch("/api/platform/backup/s3/settings").send({ retentionCount: 1 }).expect(200);
    const { results } = await startRunAndAwait({ includeImages: true });
    expect(results[0]!.deletedDbKeys).toHaveLength(3);
    expect(s3State.dbKeys).toHaveLength(1);
    expect(s3State.deleted.every((key) => key.includes("/db/"))).toBe(true);
    expect(s3State.images.size).toBe(1);
  });

  it("S3 请求失败时记录完整配置与服务端返回，禁止静默失败", async () => {
    const denied = await request(runtime.app).post("/api/platform/backup/s3/targets").send({
      name: "拒绝访问",
      endpointUrl: "https://s3.example.com",
      bucket: "denied-bucket",
      accessKeyId: "AKIADENIED",
      secretAccessKey: "denied-secret-key-9876543210"
    }).expect(201);
    const deniedId = String(denied.body.data.id);
    const { run, results } = await startRunAndAwait({ includeImages: false });
    expect(run.status).toBe("completed_with_failures");
    const failure = results.find((item) => item.status === "failed");
    expect(failure).toBeDefined();
    expect(failure!.targetName).toBe("拒绝访问");
    expect(failure!.failure).toMatchObject({ httpStatus: 403 });
    expect(String((failure!.failure as Record<string, unknown>).responseBody)).toContain("AccessDenied");
    // 运行结果中保留完整配置（不含 ak/sk），便于前端展示与排查。
    expect(failure!.target).toMatchObject({ name: "拒绝访问", bucket: "denied-bucket", endpointUrl: "https://s3.example.com" });
    expect(JSON.stringify(failure)).not.toContain("denied-secret-key");
    expect(JSON.stringify(failure)).not.toContain("AKIADENIED");
    const list = await request(runtime.app).get("/api/platform/backup/s3").expect(200);
    const deniedTarget = (list.body.data.targets as Array<Record<string, unknown>>).find((item) => item.id === deniedId);
    expect(String(deniedTarget!.lastResult)).toBe("failed");
    expect(String(deniedTarget!.lastError)).toContain("AccessDenied");
    await request(runtime.app).delete(`/api/platform/backup/s3/targets/${deniedId}`).expect(204);
  });

  it("没有启用中的目标时跳过执行", async () => {
    await request(runtime.app).patch(`/api/platform/backup/s3/targets/${targetId}`).send({ status: "disabled" }).expect(200);
    const { run } = await startRunAndAwait({ includeImages: false });
    expect(run.status).toBe("skipped");
    await request(runtime.app).patch(`/api/platform/backup/s3/targets/${targetId}`).send({ status: "enabled" }).expect(200);
  });
});

describe("S3 备份权限", () => {
  const setupToken = "s3-backup-permission-test-setup-token-32-chars";
  let permissionRuntime: Runtime;
  let adminCookie = "";
  let adminCsrf = "";
  let userCookie = "";

  beforeAll(async () => {
    permissionRuntime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "s3-backup-permission-test-secret-32-characters",
      serveUi: false,
      revealCaptchaAnswer: true,
      security: { allowRegistration: true, enforceSameOrigin: true, setupToken }
    });
    const register = async (username: string) => {
      const captcha = await request(permissionRuntime.app).get("/api/auth/captcha").expect(200);
      const response = await request(permissionRuntime.app).post("/api/auth/register").send({
        username,
        password: "secure-password-123",
        passwordConfirmation: "secure-password-123",
        setupToken,
        captchaId: captcha.body.data.captchaId,
        captchaAnswer: captcha.body.data.answer
      }).expect(201);
      return { cookie: response.headers["set-cookie"]?.[0]?.split(";", 1)[0] ?? "", csrfToken: response.body.data.csrfToken };
    };
    const admin = await register("s3_admin");
    const normal = await register("s3_user");
    adminCookie = admin.cookie;
    adminCsrf = admin.csrfToken;
    userCookie = normal.cookie;
  });

  afterAll(() => permissionRuntime.close());

  it("普通用户访问备份配置被拒绝，管理员可以访问", async () => {
    await request(permissionRuntime.app).get("/api/platform/backup/s3").set("Cookie", userCookie).expect(403);
    await request(permissionRuntime.app).post("/api/platform/backup/s3/run").set("Cookie", userCookie).send({}).expect(403);
    const adminView = await request(permissionRuntime.app).get("/api/platform/backup/s3").set("Cookie", adminCookie).expect(200);
    expect(adminView.body.data.settings.retentionCount).toEqual(expect.any(Number));
    await request(permissionRuntime.app).post("/api/platform/backup/s3/targets").set("Cookie", adminCookie).set("X-CSRF-Token", adminCsrf).send({
      name: "权限目标",
      endpointUrl: "https://s3.example.com",
      bucket: "backup-bucket",
      accessKeyId: "AKIAPERMISSION",
      secretAccessKey: "permission-secret-key-123456"
    }).expect(201);
  });

  it("未登录访问备份配置被拒绝", async () => {
    await request(permissionRuntime.app).get("/api/platform/backup/s3").expect(401);
  });
});
