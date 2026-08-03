import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { AppError } from "./errors.js";
import { logger, sanitizeError } from "./logger.js";
import type { CredentialVault } from "./credential-vault.js";
import { PLATFORM_AI_WORK_ID, type Database } from "./database.js";

// 备份目标对外展示的公开字段（不包含任何密钥材料）。
export type BackupTargetPublic = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyIdMasked: string;
  pathStyle: boolean;
  sortOrder: number;
  updatedAt: string;
};

export type BackupTargetInput = {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
};

export type BackupSettings = {
  enabled: boolean;
  includeImages: boolean;
  scheduleTime: string;
  retentionCount: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string;
  updatedAt: string;
};

export type BackupTargetResult = {
  targetId: string;
  name: string;
  status: "ok" | "failed";
  uploadedImages: number;
  skippedImages: number;
  uploadedDatabase: boolean;
  removedBackups: number;
  error: string;
};

export type BackupRunResult = {
  startedAt: string;
  finishedAt: string;
  trigger: "manual" | "schedule";
  status: "success" | "failed";
  targets: BackupTargetResult[];
  error: string;
};

type ResolvedTarget = BackupTargetInput & { id: string };

const DEFAULT_SETTINGS = {
  enabled: false,
  includeImages: true,
  scheduleTime: "03:00",
  retentionCount: 7
};

export class S3RequestError extends Error {
  readonly httpStatus: number | null;
  readonly s3Code: string;
  readonly s3Message: string;
  readonly responseBody: string;

  constructor(message: string, options: { httpStatus?: number | null; s3Code?: string; s3Message?: string; responseBody?: string }) {
    super(message);
    this.name = "S3RequestError";
    this.httpStatus = options.httpStatus ?? null;
    this.s3Code = options.s3Code ?? "";
    this.s3Message = options.s3Message ?? "";
    this.responseBody = options.responseBody ?? "";
  }
}

// 以下纯函数均不依赖网络与数据库，便于单元测试覆盖。

export function normalizeScheduleTime(value: string): string {
  const match = /^([01]?\d|2[0-3]):([0-5]?\d)$/u.exec(value.trim());
  if (!match) throw new AppError(400, "BACKUP_SCHEDULE_INVALID", "定时时间必须为 HH:mm 格式");
  return `${String(match[1] ?? "").padStart(2, "0")}:${String(match[2] ?? "").padStart(2, "0")}`;
}

export function nextScheduleDelayMs(scheduleTime: string, now: Date = new Date()): number {
  const [hours = 0, minutes = 0] = normalizeScheduleTime(scheduleTime).split(":").map(Number);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

// 子目录前缀：去除首尾斜杠，折叠重复斜杠，拒绝路径穿越。
export function normalizeBackupPrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/\/{2,}/gu, "/").replace(/^\/+|\/+$/gu, "");
  if (!trimmed) return "";
  if (trimmed.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
    throw new AppError(400, "BACKUP_PREFIX_INVALID", "子目录前缀无效，不能包含 . 或 .. 路径片段");
  }
  if (trimmed.length > 500) throw new AppError(400, "BACKUP_PREFIX_INVALID", "子目录前缀过长");
  return trimmed;
}

export function backupBasePath(prefix: string): string {
  return prefix ? `${prefix}/scriverse` : "scriverse";
}

export function encodeS3Key(key: string): string {
  return key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export function buildS3Url(options: {
  endpoint: string;
  bucket: string;
  key?: string;
  pathStyle: boolean;
  query?: Record<string, string>;
}): URL {
  let base: URL;
  try {
    base = new URL(options.endpoint.trim());
  } catch {
    throw new AppError(400, "BACKUP_ENDPOINT_INVALID", "S3 服务地址不是有效的 URL");
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new AppError(400, "BACKUP_ENDPOINT_INVALID", "S3 服务地址必须使用 HTTP 或 HTTPS 协议");
  }
  let url: URL;
  if (options.pathStyle) {
    url = new URL(`${base.origin}/${options.bucket}${options.key ? `/${encodeS3Key(options.key)}` : ""}`);
  } else {
    url = new URL(`${base.protocol}//${options.bucket}.${base.host}${options.key ? `/${encodeS3Key(options.key)}` : ""}`);
  }
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) url.searchParams.set(key, value);
  }
  return url;
}

export function maskAccessKey(accessKeyId: string): string {
  if (accessKeyId.length <= 4) return "****";
  return `****${accessKeyId.slice(-4)}`;
}

// 按名称升序排列数据库备份对象键，返回超出留存数量、应被删除的最老备份。
export function selectExpiredBackupKeys(keys: string[], retentionCount: number): string[] {
  if (retentionCount <= 0 || keys.length <= retentionCount) return [];
  return [...keys].sort((a, b) => a.localeCompare(b, "en")).slice(0, keys.length - retentionCount);
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_match, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&amp;/gu, "&");
}

export function parseS3ErrorBody(body: string): { code: string; message: string } {
  const code = /<Code>([\s\S]*?)<\/Code>/u.exec(body)?.[1] ?? "";
  const message = /<Message>([\s\S]*?)<\/Message>/u.exec(body)?.[1] ?? "";
  return { code: decodeXmlEntities(code.trim()), message: decodeXmlEntities(message.trim()) };
}

export function parseListObjectsKeys(xml: string): { keys: string[]; truncated: boolean; nextToken: string | null } {
  const keys: string[] = [];
  for (const contents of xml.matchAll(/<Contents>[\s\S]*?<\/Contents>/gu)) {
    const key = /<Key>([\s\S]*?)<\/Key>/u.exec(contents[0])?.[1];
    if (key !== undefined) keys.push(decodeXmlEntities(key));
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/iu.test(xml);
  const nextToken = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/u.exec(xml)?.[1] ?? null;
  return { keys, truncated, nextToken: nextToken ? decodeXmlEntities(nextToken) : null };
}

export function timestampForBackupFile(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function contentTypeForStorageKey(storageKey: string): string {
  if (storageKey.endsWith(".webp")) return "image/webp";
  if (storageKey.endsWith(".png")) return "image/png";
  if (storageKey.endsWith(".jpg") || storageKey.endsWith(".jpeg")) return "image/jpeg";
  if (storageKey.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

// AWS Signature V4 签名，覆盖 host、x-amz-content-sha256、x-amz-date 三个必选头。
export function createAwsV4Authorization(options: {
  method: string;
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  payloadHash: string;
  date: Date;
}): Record<string, string> {
  const amzDate = options.date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/gu, "");
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = options.url.pathname || "/";
  const canonicalQuery = [...options.url.searchParams.entries()]
    .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)] as const)
    .sort(([aKey, aValue], [bKey, bValue]) => (aKey === bKey ? aValue.localeCompare(bValue, "en") : aKey.localeCompare(bKey, "en")))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const headers: Record<string, string> = {
    host: options.url.host,
    "x-amz-content-sha256": options.payloadHash,
    "x-amz-date": amzDate
  };
  const sortedHeaderNames = Object.keys(headers).sort((a, b) => a.localeCompare(b, "en"));
  const canonicalHeaders = sortedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = sortedHeaderNames.join(";");
  const canonicalRequest = [options.method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, options.payloadHash].join("\n");
  const scope = `${dateStamp}/${options.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const hmac = (key: Buffer | string, value: string): Buffer => createHmac("sha256", key).update(value).digest();
  const signature = hmac(hmac(hmac(hmac(hmac(`AWS4${options.secretAccessKey}`, dateStamp), options.region), "s3"), "aws4_request"), stringToSign).toString("hex");
  headers["authorization"] = `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

// 备份管理器：配置存取、S3 同步、定时调度与留存清理。
export class BackupManager {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly database: Database,
    private readonly vault: CredentialVault,
    private readonly attachmentRoot: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  // 定时任务与运行时关闭时调用。
  start(): void {
    this.reschedule();
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  reschedule(): void {
    this.dispose();
    let settings: BackupSettings;
    try {
      settings = this.getSettings();
    } catch (error) {
      logger.warn("backup.schedule.load_failed", { error: sanitizeError(error) });
      return;
    }
    if (!settings.enabled) return;
    const delayMs = nextScheduleDelayMs(settings.scheduleTime);
    this.timer = setTimeout(() => void this.runScheduledBackup(), delayMs);
    this.timer.unref?.();
    logger.info("backup.schedule.armed", { scheduleTime: settings.scheduleTime, delayMs });
  }

  private async runScheduledBackup(): Promise<void> {
    try {
      await this.runBackup("schedule");
    } catch (error) {
      logger.error("backup.schedule.failed", { error: sanitizeError(error) });
    } finally {
      this.reschedule();
    }
  }

  getSettings(): BackupSettings {
    const row = this.database.get("SELECT * FROM platform_backup_settings WHERE id = 1");
    if (!row) {
      return { ...DEFAULT_SETTINGS, lastRunAt: null, lastRunStatus: null, lastRunError: "", updatedAt: "" };
    }
    return {
      enabled: Number(row.enabled) === 1,
      includeImages: Number(row.include_images) === 1,
      scheduleTime: String(row.schedule_time),
      retentionCount: Number(row.retention_count),
      lastRunAt: row.last_run_at === null ? null : String(row.last_run_at),
      lastRunStatus: row.last_run_status === null ? null : String(row.last_run_status),
      lastRunError: String(row.last_run_error ?? ""),
      updatedAt: String(row.updated_at)
    };
  }

  updateSettings(input: {
    enabled?: boolean;
    includeImages?: boolean;
    scheduleTime?: string;
    retentionCount?: number;
  }): BackupSettings {
    const current = this.getSettings();
    const enabled = input.enabled ?? current.enabled;
    const includeImages = input.includeImages ?? current.includeImages;
    const scheduleTime = input.scheduleTime !== undefined ? normalizeScheduleTime(input.scheduleTime) : current.scheduleTime;
    const retentionCount = input.retentionCount ?? current.retentionCount;
    if (!Number.isInteger(retentionCount) || retentionCount < 1 || retentionCount > 365) {
      throw new AppError(400, "BACKUP_RETENTION_INVALID", "备份留存个数必须在 1 到 365 之间");
    }
    const timestamp = new Date().toISOString();
    this.database.run(
      `INSERT INTO platform_backup_settings (id, enabled, include_images, schedule_time, retention_count, last_run_at, last_run_status, last_run_error, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, include_images = excluded.include_images,
         schedule_time = excluded.schedule_time, retention_count = excluded.retention_count, updated_at = excluded.updated_at`,
      enabled ? 1 : 0,
      includeImages ? 1 : 0,
      scheduleTime,
      retentionCount,
      current.lastRunAt,
      current.lastRunStatus,
      current.lastRunError,
      timestamp
    );
    this.reschedule();
    return this.getSettings();
  }

  listTargets(): BackupTargetPublic[] {
    const rows = this.database.all("SELECT * FROM platform_backup_targets ORDER BY sort_order ASC, created_at ASC");
    return rows.map((row) => this.publicTarget(row));
  }

  private publicTarget(row: Record<string, unknown>): BackupTargetPublic {
    return {
      id: String(row.id),
      name: String(row.name),
      endpoint: String(row.endpoint),
      region: String(row.region),
      bucket: String(row.bucket),
      prefix: String(row.prefix),
      accessKeyIdMasked: maskAccessKey(String(row.access_key_id)),
      pathStyle: Number(row.path_style) === 1,
      sortOrder: Number(row.sort_order),
      updatedAt: String(row.updated_at)
    };
  }

  createTarget(input: BackupTargetInput): BackupTargetPublic {
    const timestamp = new Date().toISOString();
    const id = randomUUID();
    const encrypted = this.vault.encrypt(input.secretAccessKey);
    const sortOrder = Number(this.database.get<{ next: number }>(
      "SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM platform_backup_targets"
    )?.next ?? 1);
    this.database.run(
      `INSERT INTO platform_backup_targets (id, name, endpoint, region, bucket, prefix, access_key_id, secret_encrypted, secret_iv, secret_tag, path_style, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.endpoint,
      input.region,
      input.bucket,
      input.prefix,
      input.accessKeyId,
      encrypted.encrypted,
      encrypted.iv,
      encrypted.tag,
      input.pathStyle ? 1 : 0,
      sortOrder,
      timestamp,
      timestamp
    );
    logger.info("backup.target.created", { targetId: id, name: input.name, endpoint: input.endpoint, bucket: input.bucket });
    return this.publicTarget(this.database.get("SELECT * FROM platform_backup_targets WHERE id = ?", id)!);
  }

  updateTarget(targetId: string, input: Partial<BackupTargetInput>): BackupTargetPublic {
    const row = this.database.get("SELECT * FROM platform_backup_targets WHERE id = ?", targetId);
    if (!row) throw new AppError(404, "BACKUP_TARGET_NOT_FOUND", "备份目标不存在");
    const timestamp = new Date().toISOString();
    let secretEncrypted = String(row.secret_encrypted);
    let secretIv = String(row.secret_iv);
    let secretTag = String(row.secret_tag);
    if (input.secretAccessKey) {
      const encrypted = this.vault.encrypt(input.secretAccessKey);
      secretEncrypted = encrypted.encrypted;
      secretIv = encrypted.iv;
      secretTag = encrypted.tag;
    }
    this.database.run(
      `UPDATE platform_backup_targets SET name = ?, endpoint = ?, region = ?, bucket = ?, prefix = ?, access_key_id = ?,
         secret_encrypted = ?, secret_iv = ?, secret_tag = ?, path_style = ?, updated_at = ? WHERE id = ?`,
      input.name ?? String(row.name),
      input.endpoint ?? String(row.endpoint),
      input.region ?? String(row.region),
      input.bucket ?? String(row.bucket),
      input.prefix ?? String(row.prefix),
      input.accessKeyId ?? String(row.access_key_id),
      secretEncrypted,
      secretIv,
      secretTag,
      input.pathStyle === undefined ? Number(row.path_style) : input.pathStyle ? 1 : 0,
      timestamp,
      targetId
    );
    logger.info("backup.target.updated", { targetId, name: input.name ?? String(row.name) });
    return this.publicTarget(this.database.get("SELECT * FROM platform_backup_targets WHERE id = ?", targetId)!);
  }

  deleteTarget(targetId: string): void {
    const result = this.database.run("DELETE FROM platform_backup_targets WHERE id = ?", targetId);
    if (result.changes === 0) throw new AppError(404, "BACKUP_TARGET_NOT_FOUND", "备份目标不存在");
    logger.info("backup.target.deleted", { targetId });
  }

  private resolvedTargets(): ResolvedTarget[] {
    return this.database.all("SELECT * FROM platform_backup_targets ORDER BY sort_order ASC, created_at ASC").map((row) => ({
      id: String(row.id),
      name: String(row.name),
      endpoint: String(row.endpoint),
      region: String(row.region),
      bucket: String(row.bucket),
      prefix: String(row.prefix),
      accessKeyId: String(row.access_key_id),
      secretAccessKey: this.vault.decrypt({
        encrypted: String(row.secret_encrypted),
        iv: String(row.secret_iv),
        tag: String(row.secret_tag)
      }),
      pathStyle: Number(row.path_style) === 1
    }));
  }

  private targetLogReference(target: ResolvedTarget): Record<string, unknown> {
    // 完整打印失败目标配置以便排查，但 AK 仅保留末四位，SK 永不进入日志。
    return {
      id: target.id,
      name: target.name,
      endpoint: target.endpoint,
      region: target.region,
      bucket: target.bucket,
      prefix: target.prefix,
      accessKeyId: maskAccessKey(target.accessKeyId),
      pathStyle: target.pathStyle
    };
  }

  private async s3Request(target: ResolvedTarget, options: {
    method: "GET" | "PUT" | "DELETE" | "HEAD";
    key?: string;
    query?: Record<string, string>;
    body?: Buffer;
    contentType?: string;
  }): Promise<{ status: number; body: string }> {
    const url = buildS3Url({ endpoint: target.endpoint, bucket: target.bucket, key: options.key, pathStyle: target.pathStyle, query: options.query });
    const body = options.body ?? Buffer.alloc(0);
    const payloadHash = createHash("sha256").update(body).digest("hex");
    const authorization = createAwsV4Authorization({
      method: options.method,
      url,
      region: target.region || "us-east-1",
      accessKeyId: target.accessKeyId,
      secretAccessKey: target.secretAccessKey,
      payloadHash,
      date: new Date()
    });
    const headers: Record<string, string> = { ...authorization };
    if (options.contentType) headers["content-type"] = options.contentType;
    const requestBody: BodyInit | undefined = options.method === "GET" || options.method === "HEAD" ? undefined : Uint8Array.from(body);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: options.method,
        headers,
        body: requestBody
      });
    } catch (error) {
      throw new S3RequestError(
        `S3 服务网络请求失败：${error instanceof Error ? error.message : String(error)}`,
        { responseBody: "" }
      );
    }
    const text = await response.text();
    if (!response.ok) {
      const parsed = parseS3ErrorBody(text);
      throw new S3RequestError(
        `S3 服务返回 ${response.status}${parsed.code ? `（${parsed.code}）` : ""}${parsed.message ? `：${parsed.message}` : ""}`,
        { httpStatus: response.status, s3Code: parsed.code, s3Message: parsed.message, responseBody: text.slice(0, 8_000) }
      );
    }
    return { status: response.status, body: text };
  }

  private async listAllKeys(target: ResolvedTarget, prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | null = null;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix };
      if (continuationToken) query["continuation-token"] = continuationToken;
      const { body } = await this.s3Request(target, { method: "GET", query });
      const parsed = parseListObjectsKeys(body);
      keys.push(...parsed.keys);
      continuationToken = parsed.truncated ? parsed.nextToken : null;
    } while (continuationToken);
    return keys;
  }

  private async listLocalAttachmentKeys(): Promise<string[]> {
    try {
      const keys: string[] = [];
      // 附件目录结构固定为两级（两位十六进制前缀/文件名），直接逐层遍历即可。
      const topLevel = await readdir(this.attachmentRoot, { withFileTypes: true });
      for (const directory of topLevel) {
        if (!directory.isDirectory() || directory.name.startsWith(".")) continue;
        const files = await readdir(join(this.attachmentRoot, directory.name), { withFileTypes: true });
        for (const file of files) {
          if (file.isFile()) keys.push(`${directory.name}/${file.name}`);
        }
      }
      return keys.sort((a, b) => a.localeCompare(b, "en"));
    } catch {
      return [];
    }
  }

  private async createDatabaseSnapshot(): Promise<string> {
    const snapshotDirectory = join(tmpdir(), "scriverse-s3-backup");
    await mkdir(snapshotDirectory, { recursive: true });
    const snapshotPath = join(snapshotDirectory, `scriverse-${timestampForBackupFile(new Date())}-${randomUUID().slice(0, 8)}.db`);
    // VACUUM INTO 会生成一份一致的完整快照，无需停机，也避免直接复制 WAL 文件。
    this.database.run("VACUUM INTO ?", snapshotPath);
    return snapshotPath;
  }

  private async syncTarget(
    target: ResolvedTarget,
    snapshotPath: string,
    attachmentKeys: string[] | null,
    retentionCount: number
  ): Promise<BackupTargetResult> {
    const base = backupBasePath(normalizeBackupPrefix(target.prefix));
    let uploadedImages = 0;
    let skippedImages = 0;
    if (attachmentKeys) {
      const imgPrefix = `${base}/img/`;
      const existing = new Set(await this.listAllKeys(target, imgPrefix));
      for (const storageKey of attachmentKeys) {
        const s3Key = `${imgPrefix}${storageKey}`;
        if (existing.has(s3Key)) {
          skippedImages += 1;
          continue;
        }
        const content = await readFile(join(this.attachmentRoot, storageKey));
        await this.s3Request(target, { method: "PUT", key: s3Key, body: content, contentType: contentTypeForStorageKey(storageKey) });
        uploadedImages += 1;
      }
    }
    const dbPrefix = `${base}/db/`;
    const snapshot = await readFile(snapshotPath);
    await this.s3Request(target, { method: "PUT", key: `${dbPrefix}${basename(snapshotPath)}`, body: snapshot, contentType: "application/octet-stream" });
    const dbKeys = await this.listAllKeys(target, dbPrefix);
    let removedBackups = 0;
    for (const expired of selectExpiredBackupKeys(dbKeys, retentionCount)) {
      await this.s3Request(target, { method: "DELETE", key: expired });
      removedBackups += 1;
    }
    return {
      targetId: target.id,
      name: target.name,
      status: "ok",
      uploadedImages,
      skippedImages,
      uploadedDatabase: true,
      removedBackups,
      error: ""
    };
  }

  async runBackup(trigger: "manual" | "schedule"): Promise<BackupRunResult> {
    if (this.running) throw new AppError(409, "BACKUP_ALREADY_RUNNING", "备份任务正在执行，请稍后再试");
    const targets = this.resolvedTargets();
    if (targets.length === 0) throw new AppError(400, "BACKUP_TARGET_REQUIRED", "请先添加至少一个 S3 备份目标");
    const settings = this.getSettings();
    this.running = true;
    const startedAt = new Date();
    let snapshotPath: string | null = null;
    const targetResults: BackupTargetResult[] = [];
    try {
      snapshotPath = await this.createDatabaseSnapshot();
      const attachmentKeys = settings.includeImages ? await this.listLocalAttachmentKeys() : null;
      logger.info("backup.run.started", {
        trigger,
        targetCount: targets.length,
        includeImages: settings.includeImages,
        attachmentCount: attachmentKeys?.length ?? 0
      });
      // 多个备份目标依次同步，单个目标失败不阻断其余目标。
      for (const target of targets) {
        try {
          targetResults.push(await this.syncTarget(target, snapshotPath, attachmentKeys, settings.retentionCount));
        } catch (error) {
          const failure = error instanceof S3RequestError ? error : null;
          logger.error("backup.s3.request_failed", {
            trigger,
            target: this.targetLogReference(target),
            httpStatus: failure?.httpStatus ?? null,
            s3Code: failure?.s3Code ?? "",
            s3Message: failure?.s3Message ?? "",
            s3ResponseBody: failure?.responseBody.slice(0, 4_000) ?? "",
            error: sanitizeError(error)
          });
          targetResults.push({
            targetId: target.id,
            name: target.name,
            status: "failed",
            uploadedImages: 0,
            skippedImages: 0,
            uploadedDatabase: false,
            removedBackups: 0,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } finally {
      this.running = false;
      if (snapshotPath) await rm(snapshotPath, { force: true });
    }
    const finishedAt = new Date();
    const failures = targetResults.filter((item) => item.status === "failed");
    const status = failures.length === 0 ? "success" : "failed";
    const errorSummary = failures.map((item) => `${item.name}：${item.error}`).join("；");
    this.database.run(
      `INSERT INTO platform_backup_settings (id, enabled, include_images, schedule_time, retention_count, last_run_at, last_run_status, last_run_error, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_run_at = excluded.last_run_at, last_run_status = excluded.last_run_status,
         last_run_error = excluded.last_run_error`,
      settings.enabled ? 1 : 0,
      settings.includeImages ? 1 : 0,
      settings.scheduleTime,
      settings.retentionCount,
      finishedAt.toISOString(),
      status,
      errorSummary.slice(0, 4_000),
      finishedAt.toISOString()
    );
    if (status === "failed") {
      logger.error("backup.run.failed", { trigger, failedTargets: failures.length, totalTargets: targets.length, error: errorSummary });
    } else {
      logger.info("backup.run.completed", {
        trigger,
        totalTargets: targets.length,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        uploadedImages: targetResults.reduce((sum, item) => sum + item.uploadedImages, 0),
        removedBackups: targetResults.reduce((sum, item) => sum + item.removedBackups, 0)
      });
    }
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      trigger,
      status,
      targets: targetResults,
      error: errorSummary
    };
  }
}

export const BACKUP_PLATFORM_AUDIT_ENTITY_ID = "platform-backup-settings";
export const BACKUP_PLATFORM_WORK_ID = PLATFORM_AI_WORK_ID;
