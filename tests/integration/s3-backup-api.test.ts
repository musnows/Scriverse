import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestRuntime } from "../helpers.js";
import { createRuntime, type Runtime } from "../../src/app.js";

type StoredObject = { body: string; contentType: string | null };
type RecordedRequest = { method: string; url: string; authorization: string | null };

function createFakeS3() {
  const objects = new Map<string, StoredObject>();
  const requests: RecordedRequest[] = [];
  let failure: { status: number; body: string } | null = null;
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    requests.push({ method, url: url.href, authorization: headers.get("authorization") });
    if (failure) return new Response(failure.body, { status: failure.status, headers: { "content-type": "application/xml" } });
    // 虚拟主机风格时对象键就是路径；路径风格时首个路径段为桶名。
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (url.host.startsWith("novel-bucket.") === false && segments[0] === "novel-bucket") segments.shift();
    const key = segments.join("/");
    if (method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((stored) => stored.startsWith(prefix)).sort((a, b) => a.localeCompare(b, "en"));
      const xml = `<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((stored) => `<Contents><Key>${stored}</Key></Contents>`).join("")}</ListBucketResult>`;
      return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
    }
    if (method === "PUT") {
      objects.set(key, { body: String(init?.body ?? ""), contentType: headers.get("content-type") });
      return new Response("", { status: 200 });
    }
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response("<Error><Code>NotImplemented</Code><Message>unsupported</Message></Error>", { status: 400 });
  }) as typeof fetch;
  return {
    fetchImpl,
    objects,
    requests,
    failWith(status: number, body: string): void { failure = { status, body }; },
    recover(): void { failure = null; }
  };
}

const targetInput = {
  name: "主备份桶",
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "novel-bucket",
  prefix: "",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "test-secret-access-key-value",
  pathStyle: false
};

describe("平台 S3 备份 API", () => {
  let runtime: Runtime;
  let s3: ReturnType<typeof createFakeS3>;

  beforeEach(() => {
    runtime?.close();
    s3 = createFakeS3();
    runtime = createTestRuntime(s3.fetchImpl);
  });

  afterAll(() => {
    runtime?.close();
  });

  function seedAttachment(storageKey: string): void {
    const path = join(runtime.attachmentStorage.rootDirectory, storageKey);
    mkdirSync(join(runtime.attachmentStorage.rootDirectory, storageKey.slice(0, 2)), { recursive: true });
    writeFileSync(path, `content-${storageKey}`);
  }

  async function addTarget(patch: Partial<typeof targetInput> = {}) {
    const response = await request(runtime.app).post("/api/platform/backup/targets").send({ ...targetInput, ...patch }).expect(201);
    return response.body.data;
  }

  it("返回默认备份设置", async () => {
    const response = await request(runtime.app).get("/api/platform/backup/settings").expect(200);
    expect(response.body.data.settings).toMatchObject({
      enabled: false,
      includeImages: true,
      scheduleTime: "03:00",
      retentionCount: 7,
      lastRunAt: null
    });
    expect(response.body.data.targets).toEqual([]);
  });

  it("更新备份设置并拒绝非法输入", async () => {
    const response = await request(runtime.app).patch("/api/platform/backup/settings").send({
      enabled: true,
      includeImages: false,
      scheduleTime: "9:05",
      retentionCount: 3
    }).expect(200);
    expect(response.body.data.settings).toMatchObject({ enabled: true, includeImages: false, scheduleTime: "09:05", retentionCount: 3 });
    await request(runtime.app).patch("/api/platform/backup/settings").send({ scheduleTime: "25:99" }).expect(400);
    await request(runtime.app).patch("/api/platform/backup/settings").send({ retentionCount: 0 }).expect(400);
    await request(runtime.app).patch("/api/platform/backup/settings").send({ unknownField: true }).expect(400);
    await request(runtime.app).patch("/api/platform/backup/settings").send({}).expect(400);
  });

  it("创建目标时规范化子目录并拒绝危险前缀", async () => {
    const created = await addTarget({ prefix: "/my-dir/sub//" });
    expect(created.prefix).toBe("my-dir/sub");
    expect(created.accessKeyIdMasked).toBe("****MPLE");
    expect(JSON.stringify(created)).not.toContain(targetInput.secretAccessKey);
    await request(runtime.app).post("/api/platform/backup/targets").send({ ...targetInput, prefix: "../evil" }).expect(400);
    await request(runtime.app).post("/api/platform/backup/targets").send({ ...targetInput, endpoint: "not-a-url" }).expect(400);
    const missingSecret = { ...targetInput };
    delete (missingSecret as Partial<typeof targetInput>).secretAccessKey;
    await request(runtime.app).post("/api/platform/backup/targets").send(missingSecret).expect(400);
  });

  it("编辑目标时可保留已有密钥", async () => {
    const created = await addTarget();
    const response = await request(runtime.app).patch(`/api/platform/backup/targets/${created.id}`).send({ name: "改名后的目标" }).expect(200);
    expect(response.body.data.name).toBe("改名后的目标");
    await request(runtime.app).patch(`/api/platform/backup/targets/${created.id}`).send({}).expect(400);
    await request(runtime.app).patch("/api/platform/backup/targets/missing-id").send({ name: "不存在" }).expect(404);
  });

  it("依次向多个目标同步数据库与图片，已存在图片跳过", async () => {
    seedAttachment("ab/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp");
    await addTarget();
    await addTarget({ name: "路径风格目标", endpoint: "http://127.0.0.1:9000", prefix: "team", pathStyle: true });

    const first = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    expect(first.body.data.status).toBe("success");
    expect(first.body.data.targets).toHaveLength(2);
    for (const target of first.body.data.targets) {
      expect(target.uploadedImages).toBe(1);
      expect(target.uploadedDatabase).toBe(true);
    }
    const dbKeys = [...s3.objects.keys()].filter((key) => key.includes("scriverse/db/"));
    expect(dbKeys).toHaveLength(2);
    for (const key of dbKeys) {
      expect(key).toMatch(/scriverse\/db\/scriverse-\d{8}-\d{6}-[0-9a-f]{8}\.db$/u);
    }
    expect([...s3.objects.keys()]).toContain("scriverse/img/ab/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp");
    expect([...s3.objects.keys()]).toContain("team/scriverse/img/ab/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp");
    expect(s3.requests.some((record) => record.url.startsWith("http://127.0.0.1:9000/novel-bucket"))).toBe(true);
    expect(s3.requests.every((record) => record.authorization?.startsWith("AWS4-HMAC-SHA256 "))).toBe(true);

    const second = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    for (const target of second.body.data.targets) {
      expect(target.uploadedImages).toBe(0);
      expect(target.skippedImages).toBe(1);
    }
    // 数据库快照不会被覆盖，两次运行共产生四份快照
    expect([...s3.objects.keys()].filter((key) => key.includes("scriverse/db/"))).toHaveLength(4);
  });

  it("关闭图片备份后仅上传数据库快照", async () => {
    seedAttachment("cd/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png");
    await addTarget();
    await request(runtime.app).patch("/api/platform/backup/settings").send({ includeImages: false }).expect(200);
    const response = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    expect(response.body.data.targets[0].uploadedImages).toBe(0);
    expect([...s3.objects.keys()].some((key) => key.includes("/img/"))).toBe(false);
    expect([...s3.objects.keys()].some((key) => key.includes("scriverse/db/"))).toBe(true);
  });

  it("超出留存个数时删除最老的数据库备份且不清理图片", async () => {
    seedAttachment("ef/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.webp");
    await addTarget();
    await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    await request(runtime.app).patch("/api/platform/backup/settings").send({ retentionCount: 1 }).expect(200);
    const response = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    expect(response.body.data.targets[0].removedBackups).toBe(2);
    expect([...s3.objects.keys()].filter((key) => key.includes("scriverse/db/"))).toHaveLength(1);
    expect([...s3.objects.keys()].filter((key) => key.includes("/img/"))).toHaveLength(1);
  });

  it("S3 请求失败时返回错误明细并记录最近一次失败", async () => {
    await addTarget();
    s3.failWith(403, "<?xml version=\"1.0\"?><Error><Code>AccessDenied</Code><Message>Forbidden by policy</Message></Error>");
    const response = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(502);
    expect(response.body.error.code).toBe("S3_BACKUP_FAILED");
    expect(response.body.error.message).toContain("主备份桶");
    expect(response.body.error.message).toContain("AccessDenied");
    expect(response.body.error.message).toContain("Forbidden by policy");

    const settings = await request(runtime.app).get("/api/platform/backup/settings").expect(200);
    expect(settings.body.data.settings.lastRunStatus).toBe("failed");
    expect(settings.body.data.settings.lastRunError).toContain("AccessDenied");

    s3.recover();
    const recovered = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    expect(recovered.body.data.status).toBe("success");
  });

  it("没有备份目标时拒绝执行", async () => {
    const response = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(400);
    expect(response.body.error.code).toBe("BACKUP_TARGET_REQUIRED");
  });

  it("支持删除备份目标", async () => {
    const created = await addTarget();
    await request(runtime.app).delete(`/api/platform/backup/targets/${created.id}`).expect(204);
    await request(runtime.app).delete(`/api/platform/backup/targets/${created.id}`).expect(404);
    const settings = await request(runtime.app).get("/api/platform/backup/settings").expect(200);
    expect(settings.body.data.targets).toEqual([]);
  });
});

describe("备份接口的管理员权限边界", () => {
  const setupToken = "backup-auth-setup-token-with-at-least-32-characters";
  let runtime: Runtime;

  async function registerUser(agent: ReturnType<typeof request.agent>, username: string) {
    const captcha = await request(runtime.app).get("/api/auth/captcha").expect(200);
    const response = await agent.post("/api/auth/register").send({
      username,
      password: "secure-password-123",
      passwordConfirmation: "secure-password-123",
      setupToken,
      captchaId: captcha.body.data.captchaId,
      captchaAnswer: captcha.body.data.answer
    }).expect(201);
    return response.body.data;
  }

  beforeEach(() => {
    runtime?.close();
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "backup-auth-test-master-secret-with-enough-length",
      serveUi: false,
      revealCaptchaAnswer: true,
      security: { allowRegistration: true, enforceSameOrigin: true, setupToken }
    });
  });

  afterAll(() => {
    runtime?.close();
  });

  it("仅管理员可访问备份设置，未登录请求被拒绝", async () => {
    await request(runtime.app).get("/api/platform/backup/settings").expect(401);
    const adminAgent = request.agent(runtime.app);
    await registerUser(adminAgent, "backup-admin");
    const writerAgent = request.agent(runtime.app);
    await registerUser(writerAgent, "backup-writer");

    await adminAgent.get("/api/platform/backup/settings").expect(200);
    await writerAgent.get("/api/platform/backup/settings").expect(403);
    await writerAgent.post("/api/platform/backup/run").send({}).expect(403);
  });
});
