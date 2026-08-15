import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialVault } from "./credential-vault.js";
import { PLATFORM_AI_WORK_ID, type Row } from "./database.js";
import { AppError, notFound } from "./errors.js";
import { logger } from "./logger.js";
import { fetchSafeAiEndpoint } from "./security.js";
import type { Store } from "./store.js";
import { id, now } from "./utils.js";

/** S3 备份在桶内的固定根目录：同步到 {prefix}/scriverse 下。 */
export const SCRIVERSE_BACKUP_ROOT = "scriverse";
const maximumS3ErrorBodyLength = 16_000;
const maximumListedDbBackups = 10_000;
const maximumScheduleDelayMs = 2_147_483_000;

export type S3TargetInput = {
  name: string;
  endpointUrl: string;
  region?: string;
  bucket: string;
  prefix?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  pathStyle?: boolean;
  status?: "enabled" | "disabled";
  note?: string;
  sortOrder?: number;
};

export type S3BackupSettingsInput = {
  includeImages?: boolean;
  retentionCount?: number;
  scheduleEnabled?: boolean;
  scheduleTime?: string;
};

export type S3ClientConfig = {
  endpointUrl: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
};

export type OutboundUrlValidator = (url: string) => Promise<unknown>;

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** AWS 规范 URI 编码：仅保留未保留字符，斜杠按参数控制是否编码。 */
export function awsUriEncode(value: string, encodeSlash = true): string {
  let result = "";
  for (const char of value) {
    if (/[A-Za-z0-9\-_.~]/u.test(char)) {
      result += char;
      continue;
    }
    if (char === "/" && !encodeSlash) {
      result += char;
      continue;
    }
    for (const byte of Buffer.from(char, "utf8")) {
      result += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return result;
}

export function canonicalQueryString(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((key) => `${awsUriEncode(key)}=${awsUriEncode(query[key] ?? "")}`)
    .join("&");
}

export function canonicalHeaderBlock(headers: Record<string, string>): { canonical: string; signedNames: string } {
  const names = Object.keys(headers).sort();
  return {
    canonical: names.map((name) => `${name}:${String(headers[name]).trim()}\n`).join(""),
    signedNames: names.join(";")
  };
}

export function buildCanonicalRequest(
  method: string,
  canonicalUri: string,
  canonicalQuery: string,
  headers: Record<string, string>,
  payloadHash: string
): string {
  const { canonical, signedNames } = canonicalHeaderBlock(headers);
  return [method, canonicalUri, canonicalQuery, canonical, signedNames, payloadHash].join("\n");
}

export function buildStringToSign(amzDate: string, scope: string, canonicalRequest: string): string {
  return ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
}

export function computeSignature(secretAccessKey: string, dateStamp: string, region: string, stringToSign: string): string {
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, "s3");
  const kSigning = hmacSha256(kService, "aws4_request");
  return createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
}

/** 规范化用户配置的子目录：去掉首尾斜杠、折叠重复斜杠；返回空字符串表示桶根目录。 */
export function normalizeS3Prefix(prefix: string): string {
  const normalized = prefix.trim().replace(/\/+/gu, "/").replace(/^\/+|\/+$/gu, "");
  if (normalized.length > 500) throw new AppError(400, "S3_PREFIX_INVALID", "备份子目录不能超过 500 个字符");
  if (normalized && !/^[A-Za-z0-9\-_.\/\u4e00-\u9fff]+$/u.test(normalized)) {
    throw new AppError(400, "S3_PREFIX_INVALID", "备份子目录只能包含文字、数字、短横线、下划线、点、空格和斜杠");
  }
  return normalized;
}

/** 备份根键：{prefix}/scriverse，未配置子目录时为 scriverse。 */
export function backupRootKey(prefix: string): string {
  const normalized = normalizeS3Prefix(prefix);
  return normalized ? `${normalized}/${SCRIVERSE_BACKUP_ROOT}` : SCRIVERSE_BACKUP_ROOT;
}

/** 数据库快照文件名（毫秒精度，避免同秒重跑互相覆盖）。 */
export function dbSnapshotFileName(date = new Date()): string {
  const iso = date.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/gu, "")}T${iso.slice(11, 23).replace(/[:.]/gu, "")}Z`;
  return `scriverse-db-${stamp}.db`;
}

const dbBackupKeyPattern = /^scriverse-db-\d{8}T\d{9}Z\.db$/u;

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

export type S3RequestErrorDetail = {
  operation: string;
  httpStatus: number;
  responseBody: string;
  url: string;
};

export class S3RequestError extends Error {
  readonly operation: string;
  readonly httpStatus: number;
  readonly responseBody: string;
  readonly url: string;

  constructor(message: string, detail: S3RequestErrorDetail) {
    super(message);
    this.name = "S3RequestError";
    this.operation = detail.operation;
    this.httpStatus = detail.httpStatus;
    this.responseBody = detail.responseBody;
    this.url = detail.url;
  }
}

type ListObjectsPage = {
  keys: string[];
  truncated: boolean;
  nextToken: string | null;
};

/** 面向 S3 兼容服务的极简客户端：仅覆盖备份所需的 HEAD/PUT/LIST/DELETE 操作。 */
export class S3CompatibleClient {
  private readonly endpoint: URL;

  constructor(
    readonly config: S3ClientConfig,
    private readonly fetchImpl: typeof fetch,
    private readonly validateUrl?: OutboundUrlValidator
  ) {
    let endpoint: URL;
    try {
      endpoint = new URL(config.endpointUrl);
    } catch {
      throw new AppError(400, "S3_ENDPOINT_INVALID", "S3 接口地址不是有效的 URL");
    }
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new AppError(400, "S3_ENDPOINT_INVALID", "S3 接口地址必须是无内嵌凭据的 HTTP 或 HTTPS 地址");
    }
    this.endpoint = endpoint;
  }

  private objectPath(key: string | null): string {
    const segments = key === null ? [this.config.bucket] : [this.config.bucket, key];
    return `/${segments.filter((segment) => segment.length > 0).map((segment) => awsUriEncode(segment)).join("/")}`;
  }

  private buildUrl(path: string, query: Record<string, string>): string {
    const url = new URL(this.endpoint);
    if (!this.config.pathStyle) url.hostname = `${this.config.bucket}.${url.hostname}`;
    url.pathname = path;
    const search = canonicalQueryString(query);
    url.search = search ? `?${search}` : "";
    return url.toString();
  }

  private async request(
    operation: string,
    method: string,
    key: string | null,
    options: { query?: Record<string, string>; body?: Buffer; contentType?: string } = {}
  ): Promise<Response> {
    const query = options.query ?? {};
    const path = this.objectPath(key);
    const url = this.buildUrl(path, query);
    const amzDate = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = options.body ? sha256Hex(options.body) : sha256Hex("");
    const canonicalUri = this.config.pathStyle ? path : path;
    const host = this.config.pathStyle
      ? this.endpoint.host
      : `${this.config.bucket}.${this.endpoint.host}`;
    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...(options.contentType ? { "content-type": options.contentType } : {})
    };
    const canonicalRequest = buildCanonicalRequest(method, canonicalUri, canonicalQueryString(query), headers, payloadHash);
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const signature = computeSignature(
      this.config.secretAccessKey,
      dateStamp,
      this.config.region,
      buildStringToSign(amzDate, scope, canonicalRequest)
    );
    const response = await fetchSafeAiEndpoint(this.fetchImpl, url, {
      method,
      headers: {
        ...headers,
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${canonicalHeaderBlock(headers).signedNames}, Signature=${signature}`
      },
      ...(options.body ? { body: new Uint8Array(options.body) } : {})
    }, this.validateUrl as never);
    if (!response.ok) {
      const raw = method === "HEAD" ? "" : await response.text().catch(() => "");
      const responseBody = raw.slice(0, maximumS3ErrorBodyLength);
      throw new S3RequestError(
        `S3 请求失败：${operation} HTTP ${response.status}${responseBody ? `：${responseBody.slice(0, 500)}` : ""}`,
        { operation, httpStatus: response.status, responseBody, url: `${method} ${url}` }
      );
    }
    return response;
  }

  async headBucket(): Promise<void> {
    await this.request("HeadBucket", "HEAD", null);
  }

  async headObject(key: string): Promise<boolean> {
    try {
      await this.request("HeadObject", "HEAD", key);
      return true;
    } catch (error) {
      if (error instanceof S3RequestError && (error.httpStatus === 404 || error.httpStatus === 410)) return false;
      throw error;
    }
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.request("PutObject", "PUT", key, { body, contentType });
  }

  async deleteObject(key: string): Promise<void> {
    await this.request("DeleteObject", "DELETE", key);
  }

  private parseListPage(xml: string): ListObjectsPage {
    const keys: string[] = [];
    const keyPattern = /<Key>([\s\S]*?)<\/Key>/gu;
    let match: RegExpExecArray | null;
    while ((match = keyPattern.exec(xml)) !== null) keys.push(xmlUnescape((match[1] ?? "").trim()));
    const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/u.exec(xml);
    const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/iu.test(xml);
    return { keys, truncated, nextToken: truncated && token ? xmlUnescape((token[1] ?? "").trim()) : null };
  }

  async listObjectKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | null = null;
    do {
      const query: Record<string, string> = {
        "list-type": "2",
        "max-keys": "1000",
        prefix
      };
      if (token) query["continuation-token"] = token;
      const response = await this.request("ListObjectsV2", "GET", null, { query });
      const page = this.parseListPage(await response.text());
      keys.push(...page.keys);
      token = page.nextToken;
      if (keys.length > maximumListedDbBackups) {
        throw new AppError(500, "S3_LIST_TOO_LARGE", `备份目录下的对象数量超过 ${maximumListedDbBackups}，已停止遍历`);
      }
    } while (token);
    return keys;
  }
}

/** 计算下一次定时备份时间（服务器本地时区的 HH:MM，当天已过则顺延到明天）。 */
export function computeNextScheduledRun(from: Date, scheduleTime: string): Date {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(scheduleTime.trim());
  if (!match) throw new AppError(400, "S3_SCHEDULE_TIME_INVALID", "定时备份时间必须使用 HH:MM 二十四小时制");
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

export type BackupManagerOptions = {
  databasePath: string;
  attachmentRoot: string;
  validateEndpoint?: OutboundUrlValidator;
};

export type TargetFailureDetail = {
  message: string;
  operation: string;
  httpStatus: number;
  responseBody: string;
};

export type BackupRunTargetResult = {
  targetId: string;
  targetName: string;
  target: { name: string; endpointUrl: string; region: string; bucket: string; prefix: string; pathStyle: boolean };
  status: "success" | "failed";
  dbKey: string | null;
  dbBytes: number | null;
  uploadedImages: number;
  skippedImages: number;
  deletedDbKeys: string[];
  failure: TargetFailureDetail | null;
};

type TargetRow = Row & {
  id: string;
  name: string;
  endpoint_url: string;
  region: string;
  bucket: string;
  prefix: string;
  access_key_id: string;
  secret_encrypted: string;
  secret_iv: string;
  secret_tag: string;
  secret_hint: string;
  path_style: number;
  status: string;
  note: string;
  last_result: string | null;
  last_error: string | null;
  last_success_at: string | null;
  last_finished_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

function stringRow(row: Row, key: string): string {
  return row[key] === null || row[key] === undefined ? "" : String(row[key]);
}

function numberRow(row: Row, key: string): number {
  return Number(row[key] ?? 0);
}

function secretHint(secretAccessKey: string): string {
  if (secretAccessKey.length <= 6) return "******";
  return `${secretAccessKey.slice(0, 3)}***${secretAccessKey.slice(-3)}`;
}

function imageContentType(storageKey: string): string {
  if (storageKey.endsWith(".png")) return "image/png";
  if (storageKey.endsWith(".jpg") || storageKey.endsWith(".jpeg")) return "image/jpeg";
  if (storageKey.endsWith(".gif")) return "image/gif";
  return "image/webp";
}

export class BackupManager {
  private scheduleTimer: ReturnType<typeof setTimeout> | null = null;
  private executing = false;

  constructor(
    private readonly store: Store,
    private readonly vault: CredentialVault,
    private readonly fetchImpl: typeof fetch,
    private readonly options: BackupManagerOptions
  ) {
    // 服务重启导致中断的运行标记为失败，避免界面停留在 running。
    this.store.db.run(
      `UPDATE s3_backup_runs SET status = 'failed', results_json = ?, finished_at = ?
       WHERE status = 'running'`,
      JSON.stringify([{ targetId: null, targetName: null, target: null, status: "failed", dbKey: null, dbBytes: null, uploadedImages: 0, skippedImages: 0, deletedDbKeys: [], failure: { message: "服务重启导致备份中断", operation: "restart", httpStatus: 0, responseBody: "" } }]),
      now()
    );
    this.rescheduleTimer();
  }

  dispose(): void {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = null;
  }

  private getTargetRow(targetId: string): TargetRow {
    const row = this.store.db.get("SELECT * FROM s3_backup_targets WHERE id = ?", targetId) as TargetRow | undefined;
    if (!row) throw notFound("备份目标");
    return row;
  }

  private mapTarget(row: TargetRow): Record<string, unknown> {
    return {
      id: row.id,
      name: row.name,
      endpointUrl: row.endpoint_url,
      region: row.region,
      bucket: row.bucket,
      prefix: row.prefix,
      accessKeyId: row.access_key_id,
      secretHint: row.secret_hint,
      pathStyle: Number(row.path_style) === 1,
      status: row.status === "disabled" ? "disabled" : "enabled",
      note: row.note,
      lastResult: row.last_result,
      lastError: row.last_error,
      lastSuccessAt: row.last_success_at,
      lastFinishedAt: row.last_finished_at,
      sortOrder: numberRow(row, "sort_order"),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listTargets(): Record<string, unknown>[] {
    return this.store.db
      .all("SELECT * FROM s3_backup_targets ORDER BY sort_order, created_at")
      .map((row) => this.mapTarget(row as TargetRow));
  }

  getTarget(targetId: string): Record<string, unknown> {
    return this.mapTarget(this.getTargetRow(targetId));
  }

  createTarget(input: S3TargetInput): Record<string, unknown> {
    if (!input.accessKeyId || !input.secretAccessKey) {
      throw new AppError(400, "S3_CREDENTIAL_REQUIRED", "新建备份目标必须提供 AccessKeyId 和 SecretAccessKey");
    }
    const targetId = id("s3target");
    const timestamp = now();
    const encrypted = this.vault.encrypt(input.secretAccessKey);
    const prefix = normalizeS3Prefix(input.prefix ?? "");
    const sortOrder = input.sortOrder ?? this.store.db.get("SELECT COUNT(*) AS value FROM s3_backup_targets")?.value as number ?? 0;
    this.store.db.run(
      `INSERT INTO s3_backup_targets (id, name, endpoint_url, region, bucket, prefix, access_key_id, secret_encrypted, secret_iv, secret_tag,
       secret_hint, path_style, status, note, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      targetId,
      input.name,
      input.endpointUrl,
      input.region ?? "",
      input.bucket,
      prefix,
      input.accessKeyId,
      encrypted.encrypted,
      encrypted.iv,
      encrypted.tag,
      secretHint(input.secretAccessKey),
      input.pathStyle === false ? 0 : 1,
      input.status ?? "enabled",
      input.note ?? "",
      sortOrder,
      timestamp,
      timestamp
    );
    this.store.audit(PLATFORM_AI_WORK_ID, "s3-backup.target.created", "s3-backup-target", targetId, {
      name: input.name,
      endpointUrl: input.endpointUrl,
      bucket: input.bucket,
      prefix,
      status: input.status ?? "enabled"
    });
    return this.getTarget(targetId);
  }

  updateTarget(targetId: string, input: Partial<S3TargetInput>): Record<string, unknown> {
    const row = this.getTargetRow(targetId);
    let secretEncrypted = stringRow(row, "secret_encrypted");
    let secretIv = stringRow(row, "secret_iv");
    let secretTag = stringRow(row, "secret_tag");
    let secretHintValue = stringRow(row, "secret_hint");
    if (input.secretAccessKey) {
      const encrypted = this.vault.encrypt(input.secretAccessKey);
      secretEncrypted = encrypted.encrypted;
      secretIv = encrypted.iv;
      secretTag = encrypted.tag;
      secretHintValue = secretHint(input.secretAccessKey);
    }
    const prefix = input.prefix === undefined ? stringRow(row, "prefix") : normalizeS3Prefix(input.prefix);
    this.store.db.run(
      `UPDATE s3_backup_targets SET name = ?, endpoint_url = ?, region = ?, bucket = ?, prefix = ?, access_key_id = ?,
       secret_encrypted = ?, secret_iv = ?, secret_tag = ?, secret_hint = ?, path_style = ?, status = ?, note = ?, sort_order = ?, updated_at = ?
       WHERE id = ?`,
      input.name ?? stringRow(row, "name"),
      input.endpointUrl ?? stringRow(row, "endpoint_url"),
      input.region ?? stringRow(row, "region"),
      input.bucket ?? stringRow(row, "bucket"),
      prefix,
      input.accessKeyId ?? stringRow(row, "access_key_id"),
      secretEncrypted,
      secretIv,
      secretTag,
      secretHintValue,
      input.pathStyle === undefined ? Number(row.path_style) : input.pathStyle ? 1 : 0,
      input.status ?? stringRow(row, "status"),
      input.note ?? stringRow(row, "note"),
      input.sortOrder ?? numberRow(row, "sort_order"),
      now(),
      targetId
    );
    this.store.audit(PLATFORM_AI_WORK_ID, "s3-backup.target.updated", "s3-backup-target", targetId, {
      fields: Object.keys(input).filter((field) => field !== "secretAccessKey"),
      secretReplaced: Boolean(input.secretAccessKey)
    });
    return this.getTarget(targetId);
  }

  deleteTarget(targetId: string): void {
    const row = this.getTargetRow(targetId);
    this.store.db.run("DELETE FROM s3_backup_targets WHERE id = ?", targetId);
    this.store.audit(PLATFORM_AI_WORK_ID, "s3-backup.target.deleted", "s3-backup-target", targetId, {
      name: row.name,
      endpointUrl: row.endpoint_url,
      bucket: row.bucket
    });
  }

  getSettings(): Record<string, unknown> {
    const row = this.store.db.get("SELECT * FROM s3_backup_settings WHERE id = 1");
    return {
      includeImages: Number(row?.include_images ?? 1) === 1,
      retentionCount: Math.min(1000, Math.max(1, Number(row?.retention_count ?? 10))),
      scheduleEnabled: Number(row?.schedule_enabled ?? 0) === 1,
      scheduleTime: String(row?.schedule_time ?? "03:00"),
      lastRunAt: row?.last_run_at ?? null,
      nextRunAt: this.nextRunAtIso(),
      updatedAt: String(row?.updated_at ?? "")
    };
  }

  private nextRunAtIso(): string | null {
    const settings = this.store.db.get("SELECT schedule_enabled, schedule_time FROM s3_backup_settings WHERE id = 1");
    if (!settings || Number(settings.schedule_enabled) !== 1) return null;
    try {
      return computeNextScheduledRun(new Date(), String(settings.schedule_time)).toISOString();
    } catch {
      return null;
    }
  }

  updateSettings(input: S3BackupSettingsInput): Record<string, unknown> {
    const current = this.store.db.get("SELECT * FROM s3_backup_settings WHERE id = 1");
    if (input.scheduleTime && !/^([01]\d|2[0-3]):([0-5]\d)$/u.test(input.scheduleTime.trim())) {
      throw new AppError(400, "S3_SCHEDULE_TIME_INVALID", "定时备份时间必须使用 HH:MM 二十四小时制");
    }
    const includeImages = input.includeImages ?? Number(current?.include_images ?? 1) === 1;
    const retentionCount = input.retentionCount ?? Number(current?.retention_count ?? 10);
    const scheduleEnabled = input.scheduleEnabled ?? Number(current?.schedule_enabled ?? 0) === 1;
    const scheduleTime = (input.scheduleTime ?? String(current?.schedule_time ?? "03:00")).trim();
    this.store.db.transaction(() => {
      this.store.db.run(
        `INSERT INTO s3_backup_settings (id, include_images, retention_count, schedule_enabled, schedule_time, last_run_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET include_images = excluded.include_images, retention_count = excluded.retention_count,
           schedule_enabled = excluded.schedule_enabled, schedule_time = excluded.schedule_time, updated_at = excluded.updated_at`,
        includeImages ? 1 : 0,
        retentionCount,
        scheduleEnabled ? 1 : 0,
        scheduleTime,
        (current?.last_run_at ?? null) as string | null,
        now()
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "s3-backup.settings.updated", "s3-backup-settings", "s3-backup-settings", {
        includeImages,
        retentionCount,
        scheduleEnabled,
        scheduleTime
      });
    });
    this.rescheduleTimer();
    return this.getSettings();
  }

  async testTarget(targetId: string): Promise<Record<string, unknown>> {
    const row = this.getTargetRow(targetId);
    const client = this.clientForRow(row);
    const startedAt = process.hrtime.bigint();
    try {
      await client.headBucket();
      logger.info("s3_backup.target_test.succeeded", {
        targetId,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000
      });
      return { ok: true, message: "连接成功，已通过 HeadBucket 验证" };
    } catch (error) {
      // 测试连接失败同样完整记录配置（不含 ak/sk）和服务端返回，禁止静默失败。
      const failure = this.failureDetail(error);
      logger.error("s3_backup.target_test.failed", {
        targetId,
        target: this.targetLogConfig(row),
        httpStatus: failure.httpStatus,
        operation: failure.operation,
        responseBody: failure.responseBody,
        message: failure.message,
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error)
      });
      return { ok: false, message: failure.message, httpStatus: failure.httpStatus, responseBody: failure.responseBody };
    }
  }

  private clientForRow(row: TargetRow): S3CompatibleClient {
    const secretAccessKey = this.vault.decrypt({
      encrypted: stringRow(row, "secret_encrypted"),
      iv: stringRow(row, "secret_iv"),
      tag: stringRow(row, "secret_tag")
    });
    return new S3CompatibleClient(
      {
        endpointUrl: stringRow(row, "endpoint_url"),
        region: stringRow(row, "region") || "us-east-1",
        bucket: stringRow(row, "bucket"),
        accessKeyId: stringRow(row, "access_key_id"),
        secretAccessKey,
        pathStyle: Number(row.path_style) === 1
      },
      this.fetchImpl,
      this.options.validateEndpoint
    );
  }

  /** 日志中的完整目标配置；AccessKeyId 与 SecretAccessKey 永不输出。 */
  private targetLogConfig(row: TargetRow): Record<string, unknown> {
    return {
      name: row.name,
      endpointUrl: row.endpoint_url,
      region: row.region,
      bucket: row.bucket,
      prefix: row.prefix,
      pathStyle: Number(row.path_style) === 1,
      status: row.status
    };
  }

  private failureDetail(error: unknown): TargetFailureDetail {
    if (error instanceof S3RequestError) {
      return {
        message: error.message,
        operation: error.operation,
        httpStatus: error.httpStatus,
        responseBody: error.responseBody
      };
    }
    if (error instanceof AppError) {
      return { message: error.message, operation: "request", httpStatus: error.status, responseBody: "" };
    }
    return {
      message: error instanceof Error ? error.message : "S3 请求失败",
      operation: "request",
      httpStatus: 0,
      responseBody: ""
    };
  }

  private mapRun(row: Row): Record<string, unknown> {
    let results: unknown = [];
    try {
      results = JSON.parse(String(row.results_json ?? "[]"));
    } catch {
      results = [];
    }
    return {
      id: row.id,
      trigger: row.run_trigger,
      status: row.status,
      includeImages: Number(row.include_images) === 1,
      results,
      startedAt: row.started_at,
      finishedAt: row.finished_at
    };
  }

  listRuns(limit = 20): Record<string, unknown>[] {
    const bounded = Math.min(100, Math.max(1, Math.floor(limit)));
    return this.store.db
      .all("SELECT * FROM s3_backup_runs ORDER BY started_at DESC LIMIT ?", bounded)
      .map((row) => this.mapRun(row));
  }

  getRun(runId: string): Record<string, unknown> {
    const row = this.store.db.get("SELECT * FROM s3_backup_runs WHERE id = ?", runId);
    if (!row) throw notFound("备份运行记录");
    return this.mapRun(row);
  }

  /**
   * 启动一次备份。返回 running 状态的运行记录，实际执行在后台完成；
   * 前端通过 GET /runs 轮询结果，避免大量图片同步时阻塞请求。
   */
  startRun(trigger: "manual" | "scheduled", includeImagesOverride?: boolean): Record<string, unknown> {
    if (this.executing) throw new AppError(409, "S3_BACKUP_ALREADY_RUNNING", "已有备份正在进行，请等待完成后再试");
    const settings = this.getSettings();
    const includeImages = includeImagesOverride ?? Boolean(settings.includeImages);
    const runId = id("s3run");
    this.store.db.run(
      "INSERT INTO s3_backup_runs (id, run_trigger, status, include_images, results_json, started_at) VALUES (?, ?, 'running', ?, '[]', ?)",
      runId,
      trigger,
      includeImages ? 1 : 0,
      now()
    );
    this.store.db.run("UPDATE s3_backup_settings SET last_run_at = ? WHERE id = 1", now());
    this.executing = true;
    void this.executeRun(runId, includeImages).catch((error: unknown) => {
      // 后台执行的兜底日志：正常情况下 executeRun 内部已按目标落盘失败详情。
      logger.error("s3_backup.run.crashed", {
        runId,
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error)
      });
      try {
        this.store.db.run(
          "UPDATE s3_backup_runs SET status = 'failed', finished_at = ? WHERE id = ? AND status = 'running'",
          now(),
          runId
        );
      } catch {
        // 数据库已关闭等极端场景下不再重试
      }
    }).finally(() => {
      this.executing = false;
    });
    return this.getRun(runId);
  }

  private async createDatabaseSnapshot(): Promise<{ path: string; bytes: number; directory: string; fileName: string }> {
    const directory = mkdtempSync(join(tmpdir(), "scriverse-s3-backup-"));
    const fileName = dbSnapshotFileName();
    const path = join(directory, fileName);
    // VACUUM INTO 生成一致的快照文件；路径由本模块生成，仅做引号转义防止意外。
    this.store.db.raw.exec(`VACUUM INTO '${path.replace(/'/gu, "''")}'`);
    const bytes = (await stat(path)).size;
    return { path, bytes, directory, fileName };
  }

  private async listAttachmentStorageKeys(): Promise<Array<{ storageKey: string; path: string; bytes: number }>> {
    const entries = await readdir(this.options.attachmentRoot, { withFileTypes: true }).catch(() => []);
    const files: Array<{ storageKey: string; path: string; bytes: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f]{2}$/u.test(entry.name)) continue;
      const children = await readdir(join(this.options.attachmentRoot, entry.name), { withFileTypes: true }).catch(() => []);
      for (const child of children) {
        if (!child.isFile() || !/^[0-9a-f]{64}\.(?:webp|png|jpe?g|gif)$/u.test(child.name)) continue;
        const path = join(this.options.attachmentRoot, entry.name, child.name);
        files.push({ storageKey: `${entry.name}/${child.name}`, path, bytes: (await stat(path)).size });
      }
    }
    files.sort((left, right) => left.storageKey.localeCompare(right.storageKey));
    return files;
  }

  private async runForTarget(
    row: TargetRow,
    snapshot: { path: string; bytes: number; fileName: string },
    includeImages: boolean,
    retentionCount: number,
    runId: string
  ): Promise<BackupRunTargetResult> {
    const client = this.clientForRow(row);
    const root = backupRootKey(stringRow(row, "prefix"));
    const targetSummary = {
      targetId: row.id,
      targetName: row.name,
      target: {
        name: row.name,
        endpointUrl: row.endpoint_url,
        region: row.region,
        bucket: row.bucket,
        prefix: row.prefix,
        pathStyle: Number(row.path_style) === 1
      },
      status: "success" as const,
      dbKey: null as string | null,
      dbBytes: null as number | null,
      uploadedImages: 0,
      skippedImages: 0,
      deletedDbKeys: [] as string[],
      failure: null as TargetFailureDetail | null
    };
    const fail = (error: unknown): BackupRunTargetResult => {
      const failure = this.failureDetail(error);
      // 完整记录失败配置（不含 ak/sk）与 S3 服务端返回结果，禁止静默失败。
      logger.error("s3_backup.target.failed", {
        runId,
        targetId: row.id,
        target: this.targetLogConfig(row),
        operation: failure.operation,
        httpStatus: failure.httpStatus,
        responseBody: failure.responseBody,
        message: failure.message
      });
      return { ...targetSummary, status: "failed", failure };
    };
    try {
      // 数据库快照带时间戳上传到 {root}/db，不做覆盖，用作快照回滚。
      const dbKey = `${root}/db/${snapshot.fileName}`;
      const dbBody = await readFile(snapshot.path);
      await client.putObject(dbKey, dbBody, "application/octet-stream");
      targetSummary.dbKey = dbKey;
      targetSummary.dbBytes = snapshot.bytes;

      if (includeImages) {
        const images = await this.listAttachmentStorageKeys();
        for (const image of images) {
          const objectKey = `${root}/img/${image.storageKey}`;
          if (await client.headObject(objectKey)) {
            targetSummary.skippedImages += 1;
            continue;
          }
          await client.putObject(objectKey, await readFile(image.path), imageContentType(image.storageKey));
          targetSummary.uploadedImages += 1;
        }
      }

      // 超出留存数量时删除最老的数据库备份；图片不做清理。
      const dbPrefix = `${root}/db/`;
      const backups = (await client.listObjectKeys(dbPrefix)).filter((key) => dbBackupKeyPattern.test(key.slice(dbPrefix.length)));
      backups.sort();
      const excess = backups.length - retentionCount;
      if (excess > 0) {
        const doomed = backups.slice(0, excess);
        for (const key of doomed) await client.deleteObject(key);
        targetSummary.deletedDbKeys = doomed;
      }
      logger.info("s3_backup.target.completed", {
        runId,
        targetId: row.id,
        dbKey,
        uploadedImages: targetSummary.uploadedImages,
        skippedImages: targetSummary.skippedImages,
        deletedDbKeys: targetSummary.deletedDbKeys.length
      });
      return { ...targetSummary };
    } catch (error) {
      return fail(error);
    }
  }

  private async executeRun(runId: string, includeImages: boolean): Promise<void> {
    const startedAt = process.hrtime.bigint();
    const settings = this.getSettings();
    const retentionCount = Number(settings.retentionCount);
    const targets = this.store.db
      .all("SELECT * FROM s3_backup_targets WHERE status = 'enabled' ORDER BY sort_order, created_at") as TargetRow[];
    let results: BackupRunTargetResult[] = [];
    if (targets.length === 0) {
      this.store.db.run(
        "UPDATE s3_backup_runs SET status = 'skipped', results_json = ?, finished_at = ? WHERE id = ?",
        JSON.stringify([]),
        now(),
        runId
      );
      logger.warn("s3_backup.run.skipped", { runId, reason: "no_enabled_targets" });
      return;
    }
    let snapshot: { path: string; bytes: number; fileName: string; directory: string } | null = null;
    try {
      snapshot = await this.createDatabaseSnapshot();
      for (const row of targets) {
        const result = await this.runForTarget(row, snapshot, includeImages, retentionCount, runId);
        results = [...results, result];
        const timestamp = now();
        if (result.status === "success") {
          this.store.db.run(
            "UPDATE s3_backup_targets SET last_result = 'success', last_error = NULL, last_success_at = ?, last_finished_at = ?, updated_at = ? WHERE id = ?",
            timestamp,
            timestamp,
            timestamp,
            row.id
          );
        } else {
          const failureText = result.failure
            ? `${result.failure.message}${result.failure.responseBody ? `；服务端返回：${result.failure.responseBody.slice(0, 500)}` : ""}`
            : "S3 请求失败";
          this.store.db.run(
            "UPDATE s3_backup_targets SET last_result = 'failed', last_error = ?, last_finished_at = ?, updated_at = ? WHERE id = ?",
            failureText,
            timestamp,
            timestamp,
            row.id
          );
        }
      }
    } finally {
      if (snapshot) rmSync(snapshot.directory, { recursive: true, force: true });
    }
    const failed = results.filter((result) => result.status === "failed").length;
    const status = failed === 0 ? "completed" : failed === results.length ? "failed" : "completed_with_failures";
    this.store.db.run(
      "UPDATE s3_backup_runs SET status = ?, results_json = ?, finished_at = ? WHERE id = ?",
      status,
      JSON.stringify(results),
      now(),
      runId
    );
    this.store.audit(PLATFORM_AI_WORK_ID, "s3-backup.run.finished", "s3-backup-run", runId, {
      trigger: this.store.db.get("SELECT run_trigger AS value FROM s3_backup_runs WHERE id = ?", runId)?.value,
      status,
      targetCount: results.length,
      failedCount: failed,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000
    });
    logger.info("s3_backup.run.finished", {
      runId,
      status,
      targetCount: results.length,
      failedCount: failed,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000
    });
  }

  private rescheduleTimer(): void {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = null;
    const settings = this.store.db.get("SELECT schedule_enabled, schedule_time FROM s3_backup_settings WHERE id = 1");
    if (!settings || Number(settings.schedule_enabled) !== 1) return;
    let delay: number;
    try {
      delay = computeNextScheduledRun(new Date(), String(settings.schedule_time)).getTime() - Date.now();
    } catch (error) {
      logger.warn("s3_backup.schedule.invalid_time", {
        scheduleTime: settings.schedule_time,
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    // setTimeout 上限约 24.8 天；定时时间异常时按上限分段重试。
    const boundedDelay = Math.min(delay, maximumScheduleDelayMs);
    const timer = setTimeout(() => {
      this.scheduleTimer = null;
      void this.runScheduledBackup();
    }, Math.max(0, boundedDelay));
    timer.unref?.();
    this.scheduleTimer = timer;
  }

  private async runScheduledBackup(): Promise<void> {
    if (this.executing) {
      // 手动备份正在执行时跳过本轮定时，等待下一个触发时间。
      logger.warn("s3_backup.schedule.skipped_busy", {});
      this.rescheduleTimer();
      return;
    }
    try {
      const run = this.startRun("scheduled");
      await this.waitForRun(String(run.id));
    } catch (error) {
      logger.error("s3_backup.schedule.failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.rescheduleTimer();
    }
  }

  private async waitForRun(runId: string): Promise<void> {
    for (let attempt = 0; attempt < 24 * 60; attempt += 1) {
      const row = this.store.db.get("SELECT status FROM s3_backup_runs WHERE id = ?", runId);
      if (!row || String(row.status) !== "running") return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
