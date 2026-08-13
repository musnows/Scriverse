// S3 兼容存储备份模块。
// 职责：备份目标与调度配置管理、数据库快照生成、数据库与图片附件上传、
// 数据库快照留存清理、定时触发调度与前端状态查询。
// 请求失败时通过 logger.error("backup.target_failed") 完整记录目标配置
// （不含访问密钥）与服务端返回，禁止静默失败。

import { createHash, createHmac } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { Agent } from "undici";
import type { CredentialVault } from "./credential-vault.js";
import { PLATFORM_AI_WORK_ID, type Database, type Row } from "./database.js";
import { AppError, notFound } from "./errors.js";
import { logger, sanitizeError } from "./logger.js";
import { assertSafeAiEndpoint, pinnedAiAgent, rememberPinnedAiAddresses } from "./security.js";
import { id, now } from "./utils.js";

export type BackupSettingsInput = {
  scheduleEnabled?: boolean;
  scheduleTime?: string;
  backupImages?: boolean;
  retentionCount?: number;
};

export type BackupTargetInput = {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  enabled: boolean;
};

export type BackupTargetResult = {
  targetId: string;
  name: string;
  status: "success" | "failed";
  databaseKey: string | null;
  databaseBytes: number;
  imagesUploaded: number;
  imagesSkipped: number;
  imagesFailed: number;
  retainedDeleted: number;
  errorMessage: string | null;
};

export type BackupAudit = (
  workId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  detail?: unknown
) => void;

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maximumS3Redirects = 5;
const databaseSnapshotName = /^novel-\d{8}-\d{6}\.db$/u;
const schedulerTickMs = 30_000;

/** S3 对象键按路径段编码，保留 / 分隔符。 */
function encodeKeyPath(key: string): string {
  return key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

/** 合并 S3 键路径段，忽略空段与首尾斜杠。 */
function joinKey(...segments: string[]): string {
  return segments.map((segment) => segment.trim().replace(/^\/+|\/+$/gu, "")).filter(Boolean).join("/");
}

/** 规范化用户输入的子目录前缀（去掉首尾斜杠与空白）。 */
export function normalizeBackupPrefix(value: string): string {
  return value.trim().replace(/^\/+|\/+$/gu, "");
}

/** 规范化备份目标 endpoint：无协议时默认 HTTPS，去掉尾部斜杠。 */
export function normalizeBackupEndpoint(value: string): string {
  let candidate = value.trim();
  if (!candidate) return "";
  if (!/^https?:\/\//iu.test(candidate)) candidate = `https://${candidate}`;
  return candidate.replace(/\/+$/u, "");
}

/** 本地时间格式化的备份时间戳，形如 20260813-030000。 */
export function formatBackupTimestamp(value: Date): string {
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}-${pad(value.getHours())}${pad(value.getMinutes())}${pad(value.getSeconds())}`;
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function parseS3ErrorBody(bodyText: string): { code: string | null; message: string } {
  const code = /<Code>\s*([^<]+?)\s*<\/Code>/iu.exec(bodyText)?.[1]?.trim() ?? null;
  const message = /<Message>\s*([^<]+?)\s*<\/Message>/iu.exec(bodyText)?.[1]?.trim() ?? bodyText.slice(0, 500);
  return { code, message };
}

/** S3 服务端返回错误时抛出，携带完整服务端返回用于日志记录。 */
export class S3RequestError extends Error {
  readonly s3Message: string;

  constructor(
    readonly statusCode: number,
    readonly code: string | null,
    message: string,
    readonly responseBody: string,
    readonly method: string,
    readonly key: string
  ) {
    super(`${method} ${key} 请求失败（HTTP ${statusCode}${code ? `，${code}` : ""}）：${message}`);
    this.name = "S3RequestError";
    this.s3Message = message;
  }
}

function s3ErrorFromResponse(response: Response, bodyText: string, method: string, key: string): S3RequestError {
  const { code, message } = parseS3ErrorBody(bodyText);
  return new S3RequestError(response.status, code, message, bodyText, method, key);
}

/** 对备份目标 endpoint 做 SSRF 校验：允许私网（本地 MinIO 等场景），禁止链路本地与保留地址。 */
async function validateBackupEndpoint(endpoint: string): Promise<void> {
  try {
    await assertSafeAiEndpoint(endpoint, true);
  } catch (error) {
    if (error instanceof AppError && error.code === "UNSAFE_PROVIDER_ENDPOINT") {
      throw new AppError(400, "UNSAFE_BACKUP_ENDPOINT", "备份存储地址无效：必须是无内嵌凭据、可解析的 HTTP 或 HTTPS 地址，且不得指向链路本地或保留网络");
    }
    if (error instanceof AppError && error.code === "INSECURE_PROVIDER_ENDPOINT") {
      throw new AppError(400, "INSECURE_BACKUP_ENDPOINT", "公网备份存储地址必须使用 HTTPS");
    }
    throw error;
  }
}

/** 递归列出目录下所有文件，跳过 .tmp 临时目录。 */
async function walkFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return results;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === ".tmp") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkFiles(path)));
    } else {
      results.push(path);
    }
  }
  return results;
}

function contentTypeForKey(key: string): string {
  const extension = key.slice(key.lastIndexOf(".") + 1).toLocaleLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return "application/octet-stream";
}

function maskCredential(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return `${value.slice(0, 1)}****`;
  return `${value.slice(0, 4)}****${value.slice(-3)}`;
}

/** 计算 AWS Signature V4 的 Authorization 头（S3 服务，host/x-amz-content-sha256/x-amz-date/content-type 参与签名）。 */
export function createAwsV4Authorization(input: {
  method: string;
  url: URL;
  payloadHash: string;
  contentType?: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  timestamp: string;
}): string {
  const headers: Array<[string, string]> = [
    ["host", input.url.host],
    ["x-amz-content-sha256", input.payloadHash],
    ["x-amz-date", input.timestamp],
    ...(input.contentType === undefined ? [] : [["content-type", input.contentType]] as Array<[string, string]>)
  ];
  const signedHeaders = headers.map(([name]) => name).join(";");
  const canonicalHeaders = headers.map(([name, value]) => `${name}:${value.trim().replace(/\s+/gu, " ")}\n`).join("");
  const canonicalRequest = [input.method, input.url.pathname, input.url.search.slice(1), canonicalHeaders, signedHeaders, input.payloadHash].join("\n");
  const date = input.timestamp.slice(0, 8);
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.timestamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmacSha256(
    hmacSha256(hmacSha256(hmacSha256(`AWS4${input.secretAccessKey}`, date), input.region), "s3"),
    "aws4_request"
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** 判断当前时刻是否应触发定时备份（同一天内只触发一次）。 */
export function shouldTriggerScheduledBackup(settings: { scheduleEnabled?: unknown; scheduleTime?: unknown }, current: Date, lastScheduledDateKey: string): boolean {
  if (settings.scheduleEnabled !== true) return false;
  const pad = (part: number): string => String(part).padStart(2, "0");
  const currentTime = `${pad(current.getHours())}:${pad(current.getMinutes())}`;
  const dateKey = `${current.getFullYear()}-${current.getMonth() + 1}-${current.getDate()}`;
  return currentTime === String(settings.scheduleTime ?? "") && lastScheduledDateKey !== dateKey;
}

/**
 * S3 兼容存储客户端。
 * 仅实现备份所需的 PUT / DELETE / ListObjectsV2 三个操作，使用 AWS Signature V4 签名。
 * AWS 官方域名使用虚拟主机风格，其余 S3 兼容服务默认路径风格。
 */
export class S3Client {
  private readonly endpointUrl: URL;
  private readonly virtualHosted: boolean;

  constructor(
    private readonly target: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
    },
    private readonly fetchImpl: typeof fetch
  ) {
    this.endpointUrl = new URL(target.endpoint);
    this.virtualHosted = this.endpointUrl.hostname.endsWith(".amazonaws.com") || this.endpointUrl.hostname === "amazonaws.com";
  }

  private buildUrl(key: string, query?: Record<string, string>): URL {
    const encodedKey = encodeKeyPath(key);
    const host = this.virtualHosted ? `${this.target.bucket}.${this.endpointUrl.host}` : this.endpointUrl.host;
    const path = this.virtualHosted ? `/${encodedKey}` : `/${encodeURIComponent(this.target.bucket)}/${encodedKey}`;
    const url = new URL(`${this.endpointUrl.protocol}//${host}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    url.searchParams.sort();
    return url;
  }

  private authorization(method: string, url: URL, payloadHash: string, contentType?: string): { value: string; timestamp: string } {
    const timestamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
    return {
      value: createAwsV4Authorization({
        method,
        url,
        payloadHash,
        contentType,
        accessKeyId: this.target.accessKeyId,
        secretAccessKey: this.target.secretAccessKey,
        region: this.target.region,
        timestamp
      }),
      timestamp
    };
  }

  /**
   * 发出 S3 请求。每次跳转前重新做 SSRF 校验并 pin 解析地址，仅允许同源跳转，
   * 每跳重新签名，防止凭据与请求体泄露到其他目标。
   */
  private async request(method: string, key: string, options: { body?: Buffer; contentType?: string; query?: Record<string, string> } = {}): Promise<Response> {
    let currentUrl = this.buildUrl(key, options.query);
    let currentMethod = method;
    let currentBody = options.body;
    for (let hop = 0; hop <= maximumS3Redirects; hop += 1) {
      const validatedAddresses = await assertSafeAiEndpoint(currentUrl.toString(), true);
      if (validatedAddresses.length) rememberPinnedAiAddresses(currentUrl.hostname, validatedAddresses);
      const payloadHash = currentBody ? sha256Hex(currentBody) : "UNSIGNED-PAYLOAD";
      const { value: authorization, timestamp } = this.authorization(currentMethod, currentUrl, payloadHash, options.contentType);
      const headers: Record<string, string> = {
        host: currentUrl.host,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": timestamp,
        authorization,
        ...(options.contentType === undefined ? {} : { "content-type": options.contentType })
      };
      const requestInit: RequestInit & { dispatcher?: Agent } = {
        method: currentMethod,
        headers,
        redirect: "manual",
        ...(currentBody ? { body: new Uint8Array(currentBody) } : {}),
        ...(validatedAddresses.length ? { dispatcher: pinnedAiAgent } : {})
      };
      const response = await this.fetchImpl(currentUrl.toString(), requestInit);
      if (!redirectStatuses.has(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) throw new AppError(502, "BACKUP_S3_REDIRECT_INVALID", "备份存储服务返回了无效的重定向响应");
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw new AppError(502, "BACKUP_S3_REDIRECT_INVALID", "备份存储服务返回了无效的重定向地址");
      }
      if (nextUrl.origin !== currentUrl.origin) {
        throw new AppError(502, "BACKUP_S3_REDIRECT_CROSS_ORIGIN", "备份存储服务返回了不安全的跨域重定向");
      }
      if (response.status === 303) {
        currentMethod = "GET";
        currentBody = undefined;
      }
      currentUrl = nextUrl;
    }
    throw new AppError(502, "BACKUP_S3_REDIRECT_LIMIT", "备份存储服务重定向次数过多");
  }

  async putObject(key: string, body: Buffer, contentType?: string): Promise<void> {
    const response = await this.request("PUT", key, { body, contentType });
    if (response.ok) return;
    throw s3ErrorFromResponse(response, await response.text(), "PUT", key);
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.request("DELETE", key, {});
    if (response.ok || response.status === 404) return;
    throw s3ErrorFromResponse(response, await response.text(), "DELETE", key);
  }

  async listObjectKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const query: Record<string, string> = {
        "list-type": "2",
        prefix,
        ...(continuationToken ? { "continuation-token": continuationToken } : {})
      };
      const response = await this.request("GET", "", { query });
      const text = await response.text();
      if (!response.ok) throw s3ErrorFromResponse(response, text, "GET", prefix);
      keys.push(
        ...[...text.matchAll(/<Key>\s*([^<]+?)\s*<\/Key>/giu)].map((match) => decodeXmlEntities(match[1]?.trim() ?? "")).filter(Boolean)
      );
      const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/iu.test(text);
      continuationToken = /<NextContinuationToken>\s*([^<]+?)\s*<\/NextContinuationToken>/iu.exec(text)?.[1]?.trim();
      if (truncated && !continuationToken) {
        throw new AppError(502, "BACKUP_S3_LIST_INVALID", "备份存储服务返回了不完整的分页结果");
      }
    } while (continuationToken);
    return keys;
  }
}

/** 系统级 S3 备份服务：配置管理、快照备份、图片同步、留存清理与定时调度。 */
export class BackupService {
  private schedulerInterval: NodeJS.Timeout | null = null;
  private lastScheduledDateKey = "";
  private running = false;

  constructor(private readonly options: {
    database: Database;
    databasePath: string;
    attachmentDirectory: string;
    vault: CredentialVault;
    fetchImpl: typeof fetch;
    audit: BackupAudit;
  }) {}

  private audit(action: string, entityType: string, entityId: string | null, detail?: unknown): void {
    this.options.audit(PLATFORM_AI_WORK_ID, action, entityType, entityId, detail);
  }

  // ---------- 备份设置 ----------

  getSettings(): Record<string, unknown> {
    const row = this.options.database.get("SELECT * FROM backup_settings WHERE id = 1");
    return {
      scheduleEnabled: Number(row?.schedule_enabled) === 1,
      scheduleTime: String(row?.schedule_time ?? "03:00"),
      backupImages: Number(row?.backup_images ?? 1) === 1,
      retentionCount: Number(row?.retention_count ?? 14),
      updatedAt: String(row?.updated_at ?? "")
    };
  }

  updateSettings(input: BackupSettingsInput): Record<string, unknown> {
    const current = this.getSettings();
    const next = {
      scheduleEnabled: input.scheduleEnabled ?? current.scheduleEnabled === true,
      scheduleTime: input.scheduleTime ?? String(current.scheduleTime),
      backupImages: input.backupImages ?? current.backupImages === true,
      retentionCount: input.retentionCount ?? Number(current.retentionCount)
    };
    const timestamp = now();
    this.options.database.transaction(() => {
      this.options.database.run(
        `INSERT INTO backup_settings (id, schedule_enabled, schedule_time, backup_images, retention_count, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET schedule_enabled = excluded.schedule_enabled, schedule_time = excluded.schedule_time,
           backup_images = excluded.backup_images, retention_count = excluded.retention_count, updated_at = excluded.updated_at`,
        next.scheduleEnabled ? 1 : 0,
        next.scheduleTime,
        next.backupImages ? 1 : 0,
        next.retentionCount,
        timestamp
      );
      this.audit("platform.backup-settings.updated", "backup-settings", "backup-settings", next);
    });
    return this.getSettings();
  }

  // ---------- 备份目标 ----------

  listTargets(): Record<string, unknown>[] {
    return this.options.database
      .all("SELECT * FROM backup_targets ORDER BY created_at")
      .map((row) => this.mapTarget(row));
  }

  getTarget(targetId: string): Record<string, unknown> {
    const row = this.options.database.get("SELECT * FROM backup_targets WHERE id = ?", targetId);
    if (!row) throw notFound("备份目标");
    return this.mapTarget(row);
  }

  private mapTarget(row: Row): Record<string, unknown> {
    return {
      id: String(row.id),
      name: String(row.name),
      endpoint: String(row.endpoint),
      region: String(row.region),
      bucket: String(row.bucket),
      prefix: String(row.prefix ?? ""),
      accessKeyId: maskCredential(String(row.access_key_id)),
      enabled: Number(row.enabled) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  async createTarget(input: BackupTargetInput): Promise<Record<string, unknown>> {
    const endpoint = normalizeBackupEndpoint(input.endpoint);
    await validateBackupEndpoint(endpoint);
    const targetId = id("backup");
    const encrypted = this.options.vault.encrypt(input.secretAccessKey);
    const timestamp = now();
    const prefix = normalizeBackupPrefix(input.prefix);
    this.options.database.transaction(() => {
      this.options.database.run(
        `INSERT INTO backup_targets
           (id, name, endpoint, region, bucket, prefix, access_key_id, encrypted_secret_key, secret_key_iv, secret_key_tag, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        targetId,
        input.name,
        endpoint,
        input.region,
        input.bucket,
        prefix,
        input.accessKeyId,
        encrypted.encrypted,
        encrypted.iv,
        encrypted.tag,
        input.enabled ? 1 : 0,
        timestamp,
        timestamp
      );
      this.audit("platform.backup-target.created", "backup-target", targetId, { name: input.name, endpoint, bucket: input.bucket });
    });
    return this.getTarget(targetId);
  }

  async updateTarget(targetId: string, input: Omit<BackupTargetInput, "secretAccessKey"> & { secretAccessKey?: string }): Promise<Record<string, unknown>> {
    const existing = this.options.database.get("SELECT * FROM backup_targets WHERE id = ?", targetId);
    if (!existing) throw notFound("备份目标");
    const endpoint = normalizeBackupEndpoint(input.endpoint);
    await validateBackupEndpoint(endpoint);
    const timestamp = now();
    const prefix = normalizeBackupPrefix(input.prefix);
    this.options.database.transaction(() => {
      if (input.secretAccessKey) {
        const encrypted = this.options.vault.encrypt(input.secretAccessKey);
        this.options.database.run(
          `UPDATE backup_targets
           SET name = ?, endpoint = ?, region = ?, bucket = ?, prefix = ?, access_key_id = ?,
             encrypted_secret_key = ?, secret_key_iv = ?, secret_key_tag = ?, enabled = ?, updated_at = ?
           WHERE id = ?`,
          input.name, endpoint, input.region, input.bucket, prefix, input.accessKeyId,
          encrypted.encrypted, encrypted.iv, encrypted.tag, input.enabled ? 1 : 0, timestamp, targetId
        );
      } else {
        this.options.database.run(
          `UPDATE backup_targets
           SET name = ?, endpoint = ?, region = ?, bucket = ?, prefix = ?, access_key_id = ?, enabled = ?, updated_at = ?
           WHERE id = ?`,
          input.name, endpoint, input.region, input.bucket, prefix, input.accessKeyId, input.enabled ? 1 : 0, timestamp, targetId
        );
      }
      this.audit("platform.backup-target.updated", "backup-target", targetId, { name: input.name, endpoint, bucket: input.bucket });
    });
    return this.getTarget(targetId);
  }

  deleteTarget(targetId: string): void {
    const existing = this.options.database.get("SELECT * FROM backup_targets WHERE id = ?", targetId);
    if (!existing) throw notFound("备份目标");
    this.options.database.transaction(() => {
      this.options.database.run("DELETE FROM backup_targets WHERE id = ?", targetId);
      this.audit("platform.backup-target.deleted", "backup-target", targetId, { name: String(existing.name) });
    });
  }

  // ---------- 备份执行与状态 ----------

  getStatus(): Record<string, unknown> {
    const runningRow = this.options.database.get("SELECT * FROM backup_runs WHERE status = 'running' ORDER BY created_at DESC LIMIT 1");
    const lastRow = this.options.database.get("SELECT * FROM backup_runs WHERE status != 'running' ORDER BY created_at DESC LIMIT 1");
    return {
      running: Boolean(runningRow),
      lastRun: lastRow ? this.mapRun(lastRow) : null
    };
  }

  private mapRun(row: Row): Record<string, unknown> {
    let results: BackupTargetResult[] = [];
    try {
      const parsed = JSON.parse(String(row.results_json ?? "[]")) as unknown;
      results = Array.isArray(parsed) ? (parsed as BackupTargetResult[]) : [];
    } catch {
      results = [];
    }
    return {
      id: String(row.id),
      trigger: String(row.trigger),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
      status: String(row.status),
      results
    };
  }

  /** 触发一次备份（手动或定时），后台执行，立即返回运行记录。 */
  triggerBackup(trigger: "manual" | "scheduled"): Record<string, unknown> {
    if (this.running) throw new AppError(409, "BACKUP_ALREADY_RUNNING", "已有备份任务正在执行，请稍后重试");
    const targets = this.options.database.all("SELECT * FROM backup_targets WHERE enabled = 1 ORDER BY created_at");
    if (targets.length === 0) throw new AppError(400, "BACKUP_TARGET_REQUIRED", "请先添加并启用至少一个备份目标");
    const runId = id("backup");
    const timestamp = now();
    this.options.database.run(
      "INSERT INTO backup_runs (id, trigger, started_at, finished_at, status, results_json, created_at) VALUES (?, ?, ?, NULL, 'running', '[]', ?)",
      runId,
      trigger,
      timestamp,
      timestamp
    );
    this.running = true;
    void this.executeRun(runId, trigger).finally(() => {
      this.running = false;
    });
    return this.mapRun({ id: runId, trigger, started_at: timestamp, finished_at: null, status: "running", results_json: "[]" });
  }

  private async executeRun(runId: string, trigger: "manual" | "scheduled"): Promise<void> {
    const settings = this.getSettings();
    const targets = this.options.database.all("SELECT * FROM backup_targets WHERE enabled = 1 ORDER BY created_at");
    const results: BackupTargetResult[] = [];
    let snapshot: { path: string; fileName: string } | null = null;
    try {
      snapshot = await this.createDatabaseSnapshot();
      logger.info("backup.run_started", {
        runId,
        trigger,
        targetCount: targets.length,
        backupImages: settings.backupImages === true,
        snapshotFileName: snapshot.fileName
      });
      for (const target of targets) {
        results.push(await this.backupTarget(target, snapshot, settings));
      }
    } catch (error) {
      logger.error("backup.run_aborted", { runId, trigger, error: sanitizeError(error) });
      results.push({
        targetId: "",
        name: "备份任务",
        status: "failed",
        databaseKey: null,
        databaseBytes: 0,
        imagesUploaded: 0,
        imagesSkipped: 0,
        imagesFailed: 0,
        retainedDeleted: 0,
        errorMessage: error instanceof AppError ? error.message : "备份任务执行失败，请检查服务日志"
      });
    } finally {
      if (snapshot) await rm(snapshot.path, { force: true }).catch(() => {});
    }
    const finishedAt = now();
    const failed = results.some((result) => result.status === "failed");
    const status = results.length > 0 && !failed ? "success" : "failed";
    this.options.database.run(
      "UPDATE backup_runs SET status = ?, finished_at = ?, results_json = ? WHERE id = ?",
      status,
      finishedAt,
      JSON.stringify(results),
      runId
    );
    logger.info("backup.run_finished", {
      runId,
      trigger,
      status,
      results: results.map((result) => ({
        targetId: result.targetId,
        name: result.name,
        status: result.status,
        databaseKey: result.databaseKey,
        imagesUploaded: result.imagesUploaded,
        imagesSkipped: result.imagesSkipped,
        imagesFailed: result.imagesFailed,
        retainedDeleted: result.retainedDeleted,
        errorMessage: result.errorMessage
      }))
    });
  }

  /** 使用 VACUUM INTO 生成一致性数据库快照到临时目录。 */
  private async createDatabaseSnapshot(): Promise<{ path: string; fileName: string }> {
    if (this.options.databasePath === ":memory:") {
      throw new AppError(500, "BACKUP_DATABASE_UNAVAILABLE", "当前数据库为内存实例，无法生成备份快照");
    }
    const directory = join(dirname(this.options.databasePath), "backup-tmp");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const fileName = `novel-${formatBackupTimestamp(new Date())}.db`;
    const path = join(directory, fileName);
    await rm(path, { force: true });
    this.options.database.raw.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    return { path, fileName };
  }

  private async backupTarget(target: Row, snapshot: { path: string; fileName: string }, settings: Record<string, unknown>): Promise<BackupTargetResult> {
    const targetId = String(target.id);
    const name = String(target.name);
    try {
      const secretAccessKey = this.options.vault.decrypt({
        encrypted: String(target.encrypted_secret_key),
        iv: String(target.secret_key_iv),
        tag: String(target.secret_key_tag)
      });
      const client = new S3Client({
        endpoint: String(target.endpoint),
        region: String(target.region),
        bucket: String(target.bucket),
        accessKeyId: String(target.access_key_id),
        secretAccessKey
      }, this.options.fetchImpl);
      const prefix = normalizeBackupPrefix(String(target.prefix ?? ""));
      const dbDirectoryKey = joinKey(prefix, "scriverse/db");
      const dbKey = `${dbDirectoryKey}/${snapshot.fileName}`;
      const body = await readFile(snapshot.path);
      await client.putObject(dbKey, body, "application/x-sqlite3");
      const retainedDeleted = await this.applyRetention(client, dbDirectoryKey, Number(settings.retentionCount));
      let images = { uploaded: 0, skipped: 0, failed: 0 };
      if (settings.backupImages === true) {
        images = await this.syncImages(client, joinKey(prefix, "scriverse/img"), targetId, name);
      }
      return {
        targetId,
        name,
        status: images.failed > 0 ? "failed" : "success",
        databaseKey: dbKey,
        databaseBytes: body.byteLength,
        imagesUploaded: images.uploaded,
        imagesSkipped: images.skipped,
        imagesFailed: images.failed,
        retainedDeleted,
        errorMessage: images.failed > 0 ? `数据库备份成功，但 ${images.failed} 张图片上传失败` : null
      };
    } catch (error) {
      this.logTargetFailure(target, error);
      return {
        targetId,
        name,
        status: "failed",
        databaseKey: null,
        databaseBytes: 0,
        imagesUploaded: 0,
        imagesSkipped: 0,
        imagesFailed: 0,
        retainedDeleted: 0,
        errorMessage: error instanceof AppError || error instanceof S3RequestError ? error.message : "备份目标请求失败，请检查服务日志"
      };
    }
  }

  /** 完整记录失败目标的配置（不含访问密钥）与 S3 服务端返回，禁止静默失败。 */
  private logTargetFailure(target: Row, error: unknown): void {
    const fields: Record<string, unknown> = {
      targetId: String(target.id),
      name: String(target.name),
      endpoint: String(target.endpoint),
      region: String(target.region),
      bucket: String(target.bucket),
      prefix: String(target.prefix ?? ""),
      enabled: Number(target.enabled) === 1
    };
    if (error instanceof S3RequestError) {
      fields.requestMethod = error.method;
      fields.requestKey = error.key;
      fields.statusCode = error.statusCode;
      fields.s3Code = error.code;
      fields.s3Message = error.s3Message;
      fields.s3ResponseBody = error.responseBody;
    }
    logger.error("backup.target_failed", { ...fields, error: sanitizeError(error) });
  }

  /** 删除超出留存个数的最老数据库快照（只按时间戳文件名匹配，不触碰其他对象）。 */
  private async applyRetention(client: S3Client, dbDirectoryKey: string, retentionCount: number): Promise<number> {
    if (!Number.isInteger(retentionCount) || retentionCount < 1) return 0;
    const keys = await client.listObjectKeys(`${dbDirectoryKey}/`);
    const snapshotKeys = keys
      .filter((key) => databaseSnapshotName.test(key.slice(key.lastIndexOf("/") + 1)))
      .sort();
    const excess = snapshotKeys.length - retentionCount;
    if (excess <= 0) return 0;
    let deleted = 0;
    for (const key of snapshotKeys.slice(0, excess)) {
      await client.deleteObject(key);
      deleted += 1;
    }
    logger.info("backup.retention_cleanup", { deleted, directoryKey: dbDirectoryKey, retentionCount });
    return deleted;
  }

  /** 列出远端已有图片，只上传缺失的文件（已存在则跳过）。 */
  private async syncImages(client: S3Client, imgDirectoryKey: string, targetId: string, targetName: string): Promise<{ uploaded: number; skipped: number; failed: number }> {
    const existing = new Set(await client.listObjectKeys(`${imgDirectoryKey}/`));
    const files = await walkFiles(this.options.attachmentDirectory);
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;
    for (const file of files) {
      const relativeKey = relative(this.options.attachmentDirectory, file).split(sep).join("/");
      const key = `${imgDirectoryKey}/${relativeKey}`;
      if (existing.has(key)) {
        skipped += 1;
        continue;
      }
      try {
        const fileStats = await stat(file);
        if (!fileStats.isFile()) continue;
        await client.putObject(key, await readFile(file), contentTypeForKey(file));
        uploaded += 1;
      } catch (error) {
        failed += 1;
        logger.warn("backup.image_upload_failed", { targetId, targetName, key, error: sanitizeError(error) });
      }
    }
    return { uploaded, skipped, failed };
  }

  // ---------- 定时调度 ----------

  startScheduler(): void {
    if (this.schedulerInterval) return;
    this.schedulerInterval = setInterval(() => {
      void this.schedulerTick();
    }, schedulerTickMs);
    this.schedulerInterval.unref();
    logger.info("backup.scheduler.started", { intervalMs: schedulerTickMs });
  }

  private async schedulerTick(): Promise<void> {
    if (this.running) return;
    const settings = this.getSettings();
    const current = new Date();
    if (!shouldTriggerScheduledBackup(settings, current, this.lastScheduledDateKey)) return;
    this.lastScheduledDateKey = `${current.getFullYear()}-${current.getMonth() + 1}-${current.getDate()}`;
    try {
      this.triggerBackup("scheduled");
      logger.info("backup.scheduled_triggered", { time: String(settings.scheduleTime) });
    } catch (error) {
      logger.warn("backup.scheduled_skipped", { reason: error instanceof Error ? error.message : "scheduler failure" });
    }
  }

  dispose(): void {
    if (this.schedulerInterval) clearInterval(this.schedulerInterval);
    this.schedulerInterval = null;
  }
}
