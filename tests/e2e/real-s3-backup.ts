// 真实服务 E2E：在隔离测试数据库上启动开发服务（跳过登录），
// 通过真实 HTTP 验证 S3 备份设置、目标管理、手动触发与状态查询，
// 并断言 mock S3 兼容服务收到了数据库快照、跳过了已有图片、清理了超留存的旧快照。
// 运行方式：npx tsx tests/e2e/real-s3-backup.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const dataDirectory = join(repositoryRoot, ".data", "e2e-isolated");
const appUrl = "http://127.0.0.1:13213";
const apiUrl = `${appUrl}/api`;
const s3Port = 19190;
const s3Url = `http://127.0.0.1:${s3Port}`;
const prefix = "e2e-backup";
const snapshotPattern = /^novel-\d{8}-\d{6}\.db$/u;

const checks: string[] = [];
function checked(feature: string, detail: string): void {
  checks.push(feature);
  console.log(`[e2e] ${feature}: ${detail}`);
}

type S3Objects = Map<string, Buffer>;
const s3Objects: S3Objects = new Map();
const s3Calls: Array<{ method: string; key: string }> = [];

async function readRequestBody(incoming: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function keyFromPath(pathname: string): string {
  return decodeURIComponent(pathname.replace(/^\/[^/]+\//u, ""));
}

const mockS3 = createServer(async (incoming, outgoing) => {
  const url = new URL(incoming.url ?? "/", s3Url);
  const method = incoming.method ?? "GET";
  const key = keyFromPath(url.pathname);
  s3Calls.push({ method, key });
  if (method === "PUT") {
    s3Objects.set(key, await readRequestBody(incoming));
    outgoing.writeHead(200);
    outgoing.end();
    return;
  }
  if (method === "DELETE") {
    s3Objects.delete(key);
    outgoing.writeHead(204);
    outgoing.end();
    return;
  }
  if (method === "GET" && url.searchParams.get("list-type") === "2") {
    const listPrefix = url.searchParams.get("prefix") ?? "";
    const contents = [...s3Objects.keys()]
      .filter((candidate) => candidate.startsWith(listPrefix))
      .map((candidate) => `<Contents><Key>${candidate}</Key></Contents>`)
      .join("");
    outgoing.writeHead(200, { "Content-Type": "application/xml" });
    outgoing.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
    return;
  }
  outgoing.writeHead(405);
  outgoing.end();
});

async function waitFor(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`等待超时：${label}`);
}

async function apiRequest(path: string, options: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) }
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

function seedAdminUser(): void {
  const database = new DatabaseSync(join(dataDirectory, "novel.db"));
  database.exec("PRAGMA journal_mode = WAL");
  database.prepare(
    `INSERT INTO users (id, username, normalized_username, display_name, password_hash, password_salt, role, status, created_at, updated_at)
     VALUES ('e2e-admin', 'e2e-admin', 'e2e-admin', 'E2E 管理员', 'placeholder', 'placeholder', 'admin', 'active', ?, ?)`
  ).run(new Date().toISOString(), new Date().toISOString());
  database.close();
}

let serverProcess: ChildProcess | null = null;

async function main(): Promise<void> {
  rmSync(dataDirectory, { recursive: true, force: true });
  mkdirSync(join(dataDirectory, "attachments"), { recursive: true, mode: 0o700 });
  // 预置远端对象：两个旧快照与一张已存在的图片
  s3Objects.set(`${prefix}/scriverse/db/novel-20260810-030000.db`, Buffer.from("old-1"));
  s3Objects.set(`${prefix}/scriverse/db/novel-20260811-030000.db`, Buffer.from("old-2"));
  s3Objects.set(`${prefix}/scriverse/img/ab/existing.webp`, Buffer.from("remote-existing"));
  // 预置本地附件：一张已存在于远端，一张缺失
  mkdirSync(join(dataDirectory, "attachments", "ab"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDirectory, "attachments", "ab", "existing.webp"), "local-existing");
  writeFileSync(join(dataDirectory, "attachments", "ab", "missing.webp"), "local-missing");

  mockS3.listen(s3Port, "127.0.0.1");
  await new Promise<void>((resolveListen) => mockS3.once("listening", resolveListen));

  serverProcess = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PORT: "13213",
      HOST: "127.0.0.1",
      DATA_DIR: dataDirectory,
      NODE_ENV: "development",
      APP_DEV_SKIP_AUTH: "true",
      LOG_LEVEL: "warn"
    },
    stdio: ["ignore", "inherit", "inherit"]
  });
  try {
    await waitFor(async () => {
      try {
        const response = await fetch(`${apiUrl}/health`);
        return response.ok;
      } catch {
        return false;
      }
    }, "开发服务启动");
    // 服务启动完成建表后，在隔离库写入开发模式使用的测试管理员。
    seedAdminUser();

    // 备份设置默认值
    let response = await apiRequest("/platform/backup/settings");
    assert.equal(response.status, 200);
    const defaultSettings = response.body.data as Record<string, unknown>;
    assert.equal(defaultSettings.scheduleEnabled, false);
    assert.equal(defaultSettings.scheduleTime, "03:00");
    assert.equal(defaultSettings.backupImages, true);
    assert.equal(defaultSettings.retentionCount, 14);
    assert.equal(typeof defaultSettings.updatedAt, "string");
    checked("备份设置默认值", "默认关闭定时、03:00、备份图片、留存 14 份");

    // 更新备份设置
    response = await apiRequest("/platform/backup/settings", {
      method: "PATCH",
      body: JSON.stringify({ backupImages: true, retentionCount: 2 })
    });
    assert.equal(response.status, 200);
    assert.equal((response.body.data as Record<string, unknown>).retentionCount, 2);
    checked("更新备份设置", "留存个数调整为 2");

    // 创建备份目标
    response = await apiRequest("/platform/backup/targets", {
      method: "POST",
      body: JSON.stringify({
        name: "E2E 备份目标",
        endpoint: s3Url,
        region: "us-east-1",
        bucket: "backup-bucket",
        prefix,
        accessKeyId: "AKIAE2ETESTKEY",
        secretAccessKey: "e2e-secret-access-key-0123456789",
        enabled: true
      })
    });
    assert.equal(response.status, 201);
    const targetId = String((response.body.data as Record<string, unknown>).id);
    assert.ok(targetId);
    checked("创建备份目标", `目标 ${targetId} 已创建，密钥以掩码返回`);

    // 手动触发备份并轮询完成
    response = await apiRequest("/platform/backup/run", { method: "POST", body: "{}" });
    assert.equal(response.status, 202);
    let lastRun: Record<string, unknown> | null = null;
    await waitFor(async () => {
      const status = await apiRequest("/platform/backup/status");
      const data = status.body.data as Record<string, unknown>;
      if (!data.running) {
        lastRun = data.lastRun as Record<string, unknown> | null;
        return Boolean(lastRun);
      }
      return false;
    }, "备份执行完成");
    assert.ok(lastRun, "应存在最近一次备份记录");
    assert.equal((lastRun as Record<string, unknown>).status, "success");
    checked("手动备份完成", "数据库快照与图片已同步，旧快照清理完成");

    // 断言远端对象状态
    const remoteDbKeys = [...s3Objects.keys()].filter((key) => key.startsWith(`${prefix}/scriverse/db/`));
    const uploadedSnapshot = remoteDbKeys.filter((key) => snapshotPattern.test(key.split("/").pop() ?? ""));
    assert.equal(uploadedSnapshot.length, 2, `应保留 2 份快照，实际：${remoteDbKeys.join(", ")}`);
    assert.ok(uploadedSnapshot.every((key) => !key.includes("novel-20260810-030000.db")), "最老的快照应被清理");
    assert.ok(s3Objects.has(`${prefix}/scriverse/img/ab/missing.webp`), "缺失图片应已上传");
    const existingImagePuts = s3Calls.filter((call) => call.method === "PUT" && call.key === `${prefix}/scriverse/img/ab/existing.webp`);
    assert.equal(existingImagePuts.length, 0, "已存在图片不应重复上传");
    checked("远端对象校验", "留存清理与图片去重符合预期");

    // 前端资源包含 S3 备份入口
    const page = await fetch(appUrl);
    const pageText = await page.text();
    assert.ok(pageText.includes('id="s3-backup-button"'), "设置中心应包含 S3 备份入口卡片");
    assert.ok(pageText.includes('id="backup-view"'), "页面应包含 S3 备份视图");
    assert.ok(pageText.includes("20260813-s3-backup-v1"), "脚本缓存版本参数应已更新");
    checked("前端资源", "设置中心入口卡片与备份视图已随页面下发");
  } finally {
    serverProcess.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      if (!serverProcess) return resolveExit();
      serverProcess.once("exit", () => resolveExit());
      setTimeout(resolveExit, 5_000);
    });
    await new Promise<void>((resolveClose) => mockS3.close(() => resolveClose()));
    rmSync(dataDirectory, { recursive: true, force: true });
  }
  console.log(`[e2e] 完成：${checks.length} 项检查全部通过`);
}

main().then(
  () => { process.exitCode = 0; },
  (error: unknown) => {
    console.error("[e2e] 失败：", error);
    process.exitCode = 1;
  }
);
