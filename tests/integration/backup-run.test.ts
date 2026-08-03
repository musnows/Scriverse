import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

const MOCK_BUCKET = "novel-backups";
// 故意把页大小设为 1，强制 ListObjectsV2 走 continuation-token 翻页路径。
const LIST_PAGE_SIZE = 1;

const WEBP_HASH = "ab".repeat(32);
const PNG_HASH = "cd".repeat(32);
const WEBP_BYTES = Buffer.from("fake-webp-image-bytes-".repeat(20));
const PNG_BYTES = Buffer.from("fake-png-image-bytes-".repeat(20));

type MockS3 = ReturnType<typeof createMockS3>;

/** 内存版 S3 兼容存储：校验 SigV4 签名头存在，支持 PUT/GET(list)/DELETE 和故障、闸门注入。 */
function createMockS3() {
  const state = new Map<string, Buffer>();
  const putCount = new Map<string, number>();
  const deletedKeys: string[] = [];
  let failPut = false;
  let putGate: Promise<void> | null = null;

  const xmlError = (status: number, code: string, message: string): Response => new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
    { status, headers: { "Content-Type": "application/xml" } }
  );

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    if (!authorization.startsWith("AWS4-HMAC-SHA256 ")) {
      throw new Error(`S3 request is missing the SigV4 authorization header: ${method} ${url.pathname}`);
    }
    if (method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const matched = [...state.keys()].filter((key) => key.startsWith(prefix)).sort();
      const offset = Number(url.searchParams.get("continuation-token") ?? "0");
      const page = matched.slice(offset, offset + LIST_PAGE_SIZE);
      const truncated = offset + page.length < matched.length;
      const contents = page.map((key) => `<Contents><Key>${key}</Key><Size>${state.get(key)?.length ?? 0}</Size></Contents>`).join("");
      const xml = `<?xml version="1.0" encoding="UTF-8"?>`
        + `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${MOCK_BUCKET}</Name>`
        + `<Prefix>${prefix}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${LIST_PAGE_SIZE}</MaxKeys>`
        + `<IsTruncated>${truncated}</IsTruncated>`
        + (truncated ? `<NextContinuationToken>${offset + page.length}</NextContinuationToken>` : "")
        + `${contents}</ListBucketResult>`;
      return new Response(xml, { status: 200, headers: { "Content-Type": "application/xml" } });
    }
    const path = decodeURIComponent(url.pathname).replace(/^\/+/u, "");
    const bucketPrefix = `${MOCK_BUCKET}/`;
    if (!path.startsWith(bucketPrefix)) return xmlError(404, "NoSuchBucket", "The specified bucket does not exist");
    const key = path.slice(bucketPrefix.length);
    if (method === "PUT") {
      if (putGate) await putGate;
      if (failPut) {
        failPut = false;
        return xmlError(500, "InternalError", "mock s3 internal failure");
      }
      state.set(key, Buffer.from(init?.body as Uint8Array));
      putCount.set(key, (putCount.get(key) ?? 0) + 1);
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      state.delete(key);
      deletedKeys.push(key);
      return new Response(null, { status: 204 });
    }
    return xmlError(501, "NotImplemented", `Unsupported method ${method}`);
  };

  return {
    fetchImpl,
    state,
    putCount,
    deletedKeys,
    failNextPut: () => {
      failPut = true;
    },
    /** 卡住下一次 PUT，返回释放函数；用于验证队列去重。 */
    gateNextPut: (): (() => void) => {
      let release = (): void => undefined;
      putGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        putGate = null;
        release();
      };
    },
    keys: (prefix: string) => [...state.keys()].filter((key) => key.startsWith(prefix)).sort()
  };
}

function seedAttachments(root: string): void {
  mkdirSync(join(root, "ab"), { recursive: true });
  mkdirSync(join(root, "cd"), { recursive: true });
  writeFileSync(join(root, "ab", `${WEBP_HASH}.webp`), WEBP_BYTES);
  writeFileSync(join(root, "cd", `${PNG_HASH}.png`), PNG_BYTES);
  // 不符合命名规范的内容必须被备份流程跳过。
  writeFileSync(join(root, "ab", `${WEBP_HASH}.webp.tmp`), Buffer.from("temporary"));
  mkdirSync(join(root, ".tmp"), { recursive: true });
  writeFileSync(join(root, ".tmp", "leftover"), Buffer.from("temporary"));
}

function createBackupTestRuntime(mock: MockS3, attachmentDirectory: string, stagingDirectory: string): Runtime {
  const runtime = createRuntime({
    databasePath: ":memory:",
    masterSecret: "backup-run-test-master-secret-with-enough-length",
    disableUserAuth: true,
    serveUi: false,
    fetchImpl: mock.fetchImpl,
    attachmentDirectory,
    backupStagingDirectory: stagingDirectory
  });
  // 与 tests/helpers.ts 相同：复用本地监听端口，避免 Supertest 反复创建临时端口。
  const server = runtime.app.listen(0);
  server.unref();
  return {
    ...runtime,
    app: server as unknown as Runtime["app"],
    close: () => {
      server.closeAllConnections();
      server.close();
      runtime.close();
    }
  };
}

async function createConfig(runtime: Runtime, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response = await request(runtime.app)
    .post("/api/platform/backup-configs")
    .send({
      name: "每日备份",
      endpointUrl: "https://s3.mock.test",
      region: "us-east-1",
      bucket: MOCK_BUCKET,
      accessKeyId: "AKIATEST000000000001",
      secretAccessKey: "test-secret-key-0123456789abcdef",
      ...overrides
    })
    .expect(201);
  return response.body.data as Record<string, unknown>;
}

async function triggerRun(runtime: Runtime, configId: string): Promise<Record<string, unknown>> {
  const response = await request(runtime.app)
    .post(`/api/platform/backup-configs/${configId}/run`)
    .send({})
    .expect(202);
  return response.body.data as Record<string, unknown>;
}

async function waitForFinishedRun(runtime: Runtime, configId: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const started = Date.now();
  for (;;) {
    const response = await request(runtime.app)
      .get(`/api/platform/backup-runs?configId=${encodeURIComponent(configId)}`)
      .expect(200);
    const run = (response.body.data as Array<Record<string, unknown>>)[0];
    if (run && (run.status === "success" || run.status === "failed")) return run;
    if (Date.now() - started > timeoutMs) throw new Error("waitForFinishedRun timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("S3 备份执行", () => {
  const cleanups: Array<{ runtime: Runtime; directory: string }> = [];

  function setup(): { runtime: Runtime; mock: MockS3 } {
    const directory = mkdtempSync(join(tmpdir(), "scriverse-backup-run-test-"));
    const attachmentDirectory = join(directory, "attachments");
    seedAttachments(attachmentDirectory);
    const mock = createMockS3();
    const runtime = createBackupTestRuntime(mock, attachmentDirectory, join(directory, "staging"));
    cleanups.push({ runtime, directory });
    return { runtime, mock };
  }

  afterEach(() => {
    while (cleanups.length) {
      const entry = cleanups.pop();
      entry?.runtime.close();
      if (entry) rmSync(entry.directory, { recursive: true, force: true });
    }
  });

  it("手动触发备份：数据库快照与图片全部上传", async () => {
    const { runtime, mock } = setup();
    const config = await createConfig(runtime);

    const queued = await triggerRun(runtime, String(config.id));
    expect(["queued", "running"]).toContain(String(queued.status));
    expect(String(queued.trigger)).toBe("manual");

    const finished = await waitForFinishedRun(runtime, String(config.id));
    expect(finished).toMatchObject({
      status: "success",
      trigger: "manual",
      configName: "每日备份",
      imagesUploaded: 2,
      imagesSkipped: 0,
      error: null
    });

    const dbKeys = mock.keys("scriverse/db/");
    expect(dbKeys).toHaveLength(1);
    expect(String(dbKeys[0])).toMatch(/^scriverse\/db\/scriverse-\d{8}-\d{6}\.db$/u);
    expect(String(finished.dbKey)).toBe(String(dbKeys[0]));
    const snapshot = mock.state.get(String(dbKeys[0]));
    expect(snapshot).toBeDefined();
    expect(snapshot && snapshot.length > 0).toBe(true);
    // VACUUM INTO 产出必须是合法的 SQLite 数据库文件。
    expect(snapshot?.subarray(0, 16).equals(Buffer.from("SQLite format 3\0", "latin1"))).toBe(true);

    expect(mock.keys("scriverse/img/")).toEqual([
      `scriverse/img/ab/${WEBP_HASH}.webp`,
      `scriverse/img/cd/${PNG_HASH}.png`
    ]);
    expect(mock.state.get(`scriverse/img/ab/${WEBP_HASH}.webp`)?.equals(WEBP_BYTES)).toBe(true);
    expect(mock.state.get(`scriverse/img/cd/${PNG_HASH}.png`)?.equals(PNG_BYTES)).toBe(true);

    const detail = await request(runtime.app).get("/api/platform/backup-configs").expect(200);
    expect(detail.body.data[0].lastRunStatus).toBe("success");
    expect(detail.body.data[0].lastRunAt).toBeTruthy();
    expect(detail.body.data[0].lastError).toBeNull();
  });

  it("再次备份：远端已有图片跳过，数据库保留多份", async () => {
    const { runtime, mock } = setup();
    const config = await createConfig(runtime);

    await triggerRun(runtime, String(config.id));
    const first = await waitForFinishedRun(runtime, String(config.id));
    expect(first.status).toBe("success");

    // 数据库备份 key 精确到秒，错开一秒保证两次生成不同的 key。
    await sleep(1_100);
    await triggerRun(runtime, String(config.id));
    const second = await waitForFinishedRun(runtime, String(config.id));
    expect(second.status).toBe("success");
    expect(second.imagesUploaded).toBe(0);
    expect(second.imagesSkipped).toBe(2);

    expect(mock.keys("scriverse/db/")).toHaveLength(2);
    expect(mock.putCount.get(`scriverse/img/ab/${WEBP_HASH}.webp`)).toBe(1);
    expect(mock.putCount.get(`scriverse/img/cd/${PNG_HASH}.png`)).toBe(1);
  });

  it("留存清理只删除超出数量的旧数据库备份", async () => {
    const { runtime, mock } = setup();
    const config = await createConfig(runtime, { retentionCount: 1, includeImages: false });

    await triggerRun(runtime, String(config.id));
    expect((await waitForFinishedRun(runtime, String(config.id))).status).toBe("success");
    await sleep(1_100);
    await triggerRun(runtime, String(config.id));
    expect((await waitForFinishedRun(runtime, String(config.id))).status).toBe("success");

    const remaining = mock.keys("scriverse/db/");
    expect(remaining).toHaveLength(1);
    expect(mock.deletedKeys).toHaveLength(1);
    expect(String(mock.deletedKeys[0])).toMatch(/^scriverse\/db\/scriverse-\d{8}-\d{6}\.db$/u);
    expect(String(mock.deletedKeys[0])).not.toBe(String(remaining[0]));
  });

  it("关闭图片同步时不产生任何 img 上传", async () => {
    const { runtime, mock } = setup();
    const config = await createConfig(runtime, { includeImages: false });

    await triggerRun(runtime, String(config.id));
    const finished = await waitForFinishedRun(runtime, String(config.id));
    expect(finished.status).toBe("success");
    expect(finished.imagesUploaded).toBe(0);
    expect(finished.imagesSkipped).toBe(0);
    expect(mock.keys("scriverse/img/")).toHaveLength(0);
    expect(mock.keys("scriverse/db/")).toHaveLength(1);
  });

  it("S3 故障：执行标记失败，错误透传到 run 与配置", async () => {
    const { runtime, mock } = setup();
    const config = await createConfig(runtime);

    mock.failNextPut();
    await triggerRun(runtime, String(config.id));
    const finished = await waitForFinishedRun(runtime, String(config.id));
    expect(finished.status).toBe("failed");
    expect(String(finished.error)).toContain("mock s3 internal failure");

    const detail = await request(runtime.app).get("/api/platform/backup-configs").expect(200);
    expect(detail.body.data[0].lastRunStatus).toBe("failed");
    expect(String(detail.body.data[0].lastError)).toContain("mock s3 internal failure");

    const runs = await request(runtime.app).get("/api/platform/backup-runs?status=failed").expect(200);
    expect(runs.body.data).toHaveLength(1);
    expect(String(runs.body.data[0].error)).toContain("mock s3 internal failure");
  });

  it("同一配置已有执行时重复触发会去重到同一条 run", async () => {
    const { runtime, mock } = setup();
    const config = await createConfig(runtime);

    const release = mock.gateNextPut();
    let first: Record<string, unknown>;
    let second: Record<string, unknown>;
    try {
      first = await triggerRun(runtime, String(config.id));
      second = await triggerRun(runtime, String(config.id));
    } finally {
      release();
    }
    expect(String(second.id)).toBe(String(first.id));

    const finished = await waitForFinishedRun(runtime, String(config.id));
    expect(finished.status).toBe("success");
    const runs = await request(runtime.app)
      .get(`/api/platform/backup-runs?configId=${encodeURIComponent(String(config.id))}`)
      .expect(200);
    expect(runs.body.data).toHaveLength(1);
  });
});
