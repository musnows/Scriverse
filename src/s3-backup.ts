import { createHash, createHmac, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { AttachmentStorage } from "./attachment-storage.js";
import { CredentialVault, type EncryptedSecret } from "./credential-vault.js";
import type { Database, Row } from "./database.js";
import { AppError } from "./errors.js";
import { logger, sanitizeError } from "./logger.js";
import { fetchSafeAiEndpoint, type SafeAiEndpointValidator } from "./security.js";
import type { Store } from "./store.js";
import { now } from "./utils.js";

const defaultScheduleTime = "03:00";
const defaultRetentionCount = 7;
const maximumTargets = 20;
const s3ServiceName = "s3";
const s3RequestTimeoutMs = 120_000;
const emptyPayloadHash = createHash("sha256").update("").digest("hex");

const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const imageExtensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
};

export type S3BackupTargetInput = {
  name?: string;
  endpoint?: string;
  bucket?: string;
  region?: string;
  prefix?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  enabled?: boolean;
  forcePathStyle?: boolean;
};

export type S3BackupSettingsInput = {
  backupImages?: boolean;
  scheduleTime?: string;
  retentionCount?: number;
};

export type S3BackupTargetPublic = {
  id: string;
  name: string;
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  enabled: boolean;
  forcePathStyle: boolean;
  accessKeyIdConfigured: boolean;
  secretAccessKeyConfigured: boolean;
  createdAt: string;
  updatedAt: string;
};

export type S3BackupTargetRunResult = {
  targetId: string;
  targetName: string;
  status: "success" | "failed";
  imagesUploaded: number;
  imagesSkipped: number;
  databaseObjectKey: string | null;
  deletedDatabaseBackups: number;
  statusCode?: number;
  error?: string;
};

export type S3BackupRunResult = {
  success: boolean;
  trigger: "manual" | "schedule";
  startedAt: string;
  completedAt: string;
  targets: S3BackupTargetRunResult[];
};

export type S3BackupSettingsPublic = {
  backupImages: boolean;
  scheduleTime: string;
  retentionCount: number;
  updatedAt: string;
  targets: S3BackupTargetPublic[];
  lastRun: S3BackupRunResult | null;
};

type StoredTarget = {
  id: string;
  name: string;
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  accessKeyEncrypted: string;
  accessKeyIv: string;
  accessKeyTag: string;
  secretKeyEncrypted: string;
  secretKeyIv: string;
  secretKeyTag: string;
  enabled: boolean;
  forcePathStyle: boolean;
  createdAt: string;
  updatedAt: string;
};

type DecryptedTarget = StoredTarget & {
  accessKeyId: string;
  secretAccessKey: string;
};

type ImageAsset = {
  key: string;
  contentType: string;
  read: () => Promise<Buffer>;
};

type ListedObject = {
  key: string;
  lastModified: string | null;
};

type S3RequestOptions = {
  method: "GET" | "HEAD" | "PUT" | "DELETE";
  target: DecryptedTarget;
  key?: string;
  query?: Record<string, string>;
  body?: Buffer;
  contentType?: string;
  allowStatuses?: readonly number[];
};

class S3RequestError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, responseBody: string) {
    super(`S3 服务返回 HTTP ${status}`);
    this.name = "S3RequestError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

function stringValue(row: Row | undefined, key: string, fallback = ""): string {
  const value = row?.[key];
  return typeof value === "string" ? value : value === undefined || value === null ? fallback : String(value);
}

function numberValue(row: Row | undefined, key: string, fallback: number): number {
  const value = Number(row?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function booleanValue(row: Row | undefined, key: string, fallback: boolean): boolean {
  const value = row?.[key];
  if (value === undefined || value === null) return fallback;
  return Number(value) === 1;
}

function normalizeEndpoint(value: string): string {
  const endpoint = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new AppError(400, "S3_ENDPOINT_INVALID", "S3 服务地址不是有效的 URL");
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AppError(400, "S3_ENDPOINT_INVALID", "S3 服务地址必须是无内嵌凭据和查询参数的 HTTP 或 HTTPS 地址");
  }
  if (!parsed.hostname || endpoint.length > 2_000) throw new AppError(400, "S3_ENDPOINT_INVALID", "S3 服务地址无效或过长");
  return parsed.toString().replace(/\/+$/u, "");
}

function normalizeBucket(value: string): string {
  const bucket = value.trim();
  if (bucket.length < 3 || bucket.length > 63 || !/^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/u.test(bucket) || bucket.includes("..") || bucket.includes(".-") || bucket.includes("-.")) {
    throw new AppError(400, "S3_BUCKET_INVALID", "S3 桶名称只能使用小写字母、数字、点和短横线");
  }
  return bucket;
}

function normalizeRegion(value: string): string {
  const region = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(region)) throw new AppError(400, "S3_REGION_INVALID", "S3 区域无效");
  return region;
}

export function normalizeS3Prefix(value: string | undefined): string {
  const prefix = (value ?? "").trim().replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (prefix.length > 500 || /[\u0000-\u001F\u007F]/u.test(prefix)) throw new AppError(400, "S3_PREFIX_INVALID", "S3 子目录无效或过长");
  const segments = prefix.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) throw new AppError(400, "S3_PREFIX_INVALID", "S3 子目录不能包含 . 或 .. 路径段");
  return segments.join("/");
}

function normalizeName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 100) throw new AppError(400, "S3_TARGET_NAME_INVALID", "S3 备份目标名称长度必须为 1-100 个字符");
  return name;
}

function normalizeCredential(value: string, field: string, maximumLength: number): string {
  const credential = value.trim();
  if (!credential || credential.length > maximumLength) throw new AppError(400, "S3_CREDENTIAL_INVALID", `${field}不能为空且不能过长`);
  return credential;
}

function validateScheduleTime(value: string): string {
  const scheduleTime = value.trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(scheduleTime)) throw new AppError(400, "S3_SCHEDULE_TIME_INVALID", "备份时间必须使用 HH:mm 格式");
  return scheduleTime;
}

function validateRetentionCount(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_000) throw new AppError(400, "S3_RETENTION_COUNT_INVALID", "备份留存个数必须为 1-1000 的整数");
  return value;
}

function encryptSecret(vault: CredentialVault, value: string): EncryptedSecret {
  return vault.encrypt(value);
}

function storedTarget(row: Row): StoredTarget {
  return {
    id: stringValue(row, "id"),
    name: stringValue(row, "name"),
    endpoint: stringValue(row, "endpoint"),
    bucket: stringValue(row, "bucket"),
    region: stringValue(row, "region", "us-east-1"),
    prefix: stringValue(row, "prefix"),
    accessKeyEncrypted: stringValue(row, "access_key_encrypted"),
    accessKeyIv: stringValue(row, "access_key_iv"),
    accessKeyTag: stringValue(row, "access_key_tag"),
    secretKeyEncrypted: stringValue(row, "secret_key_encrypted"),
    secretKeyIv: stringValue(row, "secret_key_iv"),
    secretKeyTag: stringValue(row, "secret_key_tag"),
    enabled: booleanValue(row, "enabled", true),
    forcePathStyle: booleanValue(row, "force_path_style", false),
    createdAt: stringValue(row, "created_at"),
    updatedAt: stringValue(row, "updated_at")
  };
}

function safeTarget(target: StoredTarget): Record<string, unknown> {
  return {
    id: target.id,
    name: target.name,
    endpoint: target.endpoint,
    bucket: target.bucket,
    region: target.region,
    prefix: target.prefix,
    enabled: target.enabled,
    forcePathStyle: target.forcePathStyle
  };
}

function publicTarget(target: StoredTarget): S3BackupTargetPublic {
  return {
    id: target.id,
    name: target.name,
    endpoint: target.endpoint,
    bucket: target.bucket,
    region: target.region,
    prefix: target.prefix,
    enabled: target.enabled,
    forcePathStyle: target.forcePathStyle,
    accessKeyIdConfigured: Boolean(target.accessKeyEncrypted && target.accessKeyIv && target.accessKeyTag),
    secretAccessKeyConfigured: Boolean(target.secretKeyEncrypted && target.secretKeyIv && target.secretKeyTag),
    createdAt: target.createdAt,
    updatedAt: target.updatedAt
  };
}

function decryptSecret(vault: CredentialVault, encrypted: string, iv: string, tag: string): string {
  try {
    return vault.decrypt({ encrypted, iv, tag });
  } catch {
    throw new AppError(500, "S3_CREDENTIAL_DECRYPT_FAILED", "S3 凭据无法解密，请重新保存该备份目标");
  }
}

function decryptTarget(vault: CredentialVault, target: StoredTarget): DecryptedTarget {
  return {
    ...target,
    accessKeyId: decryptSecret(vault, target.accessKeyEncrypted, target.accessKeyIv, target.accessKeyTag),
    secretAccessKey: decryptSecret(vault, target.secretKeyEncrypted, target.secretKeyIv, target.secretKeyTag)
  };
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`);
}

function encodedPath(value: string): string {
  return value.split("/").map((segment) => rfc3986(segment)).join("/");
}

function canonicalQuery(query: Record<string, string> | undefined): string {
  if (!query) return "";
  return Object.entries(query)
    .map(([key, value]) => [rfc3986(key), rfc3986(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function canonicalHeaders(headers: Record<string, string>): { value: string; signed: string } {
  const entries = Object.entries(headers)
    .map(([key, value]) => [key.toLocaleLowerCase("en-US"), value.trim().replace(/\s+/gu, " ")] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    value: `${entries.map(([key, value]) => `${key}:${value}`).join("\n")}\n`,
    signed: entries.map(([key]) => key).join(";")
  };
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function signingKey(secretAccessKey: string, date: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), s3ServiceName), "aws4_request");
}

function isoRequestDate(date: Date): { short: string; full: string } {
  const full = date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
  return { short: full.slice(0, 8), full };
}

function objectPrefix(target: StoredTarget, category: "img" | "db"): string {
  return `${[target.prefix, "scriverse", category].filter(Boolean).join("/")}/`;
}

function databaseObjectName(date: Date): string {
  return `snapshot-${date.toISOString().replace(/[:.]/gu, "-")}.db`;
}

function xmlDecode(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_match: string, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/giu, (_match: string, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

export function parseS3ListObjectsResponse(body: string): { objects: ListedObject[]; nextContinuationToken: string | null } {
  const objects: ListedObject[] = [];
  for (const match of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)) {
    const content = match[1] ?? "";
    const key = content.match(/<Key>([\s\S]*?)<\/Key>/u)?.[1];
    if (!key) continue;
    const lastModified = content.match(/<LastModified>([\s\S]*?)<\/LastModified>/u)?.[1] ?? null;
    objects.push({ key: xmlDecode(key), lastModified: lastModified ? xmlDecode(lastModified) : null });
  }
  const nextContinuationToken = body.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/u)?.[1];
  return {
    objects,
    nextContinuationToken: nextContinuationToken ? xmlDecode(nextContinuationToken) : null
  };
}

function responseBodyForLog(value: string): string {
  return value
    .replace(/(<(?:AccessKeyId|SecretAccessKey|SecretKey|Credential)[^>]*>)[\s\S]*?(<\/(?:AccessKeyId|SecretAccessKey|SecretKey|Credential)>)/giu, "$1[REDACTED]$2")
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, "[REDACTED_AWS_ACCESS_KEY]");
}

function imageExtension(mimeType: string): string {
  const extension = imageExtensions[mimeType];
  if (!extension) throw new AppError(500, "S3_IMAGE_MIME_INVALID", "发现不支持的图片类型");
  return extension;
}

export class S3BackupManager {
  private readonly fetchImpl: typeof fetch;
  private readonly scheduleValidator?: SafeAiEndpointValidator;
  private running: Promise<S3BackupRunResult> | null = null;
  private scheduleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private lastRun: S3BackupRunResult | null = null;

  constructor(
    private readonly database: Database,
    private readonly store: Store,
    private readonly databasePath: string,
    private readonly attachmentStorage: AttachmentStorage,
    private readonly vault: CredentialVault,
    fetchImpl?: typeof fetch,
    validateOutboundUrl?: SafeAiEndpointValidator
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.scheduleValidator = validateOutboundUrl;
    this.reschedule();
    logger.info("s3.backup.manager_ready");
  }

  getSettings(): S3BackupSettingsPublic {
    const settingsRow = this.database.get("SELECT * FROM s3_backup_settings WHERE id = 1");
    const targets = this.listStoredTargets();
    return {
      backupImages: booleanValue(settingsRow, "backup_images", true),
      scheduleTime: validateScheduleTime(stringValue(settingsRow, "schedule_time", defaultScheduleTime)),
      retentionCount: validateRetentionCount(numberValue(settingsRow, "retention_count", defaultRetentionCount)),
      updatedAt: stringValue(settingsRow, "updated_at"),
      targets: targets.map(publicTarget),
      lastRun: this.lastRun
    };
  }

  updateSettings(input: S3BackupSettingsInput): S3BackupSettingsPublic {
    const current = this.getSettings();
    const backupImages = input.backupImages ?? current.backupImages;
    const scheduleTime = validateScheduleTime(input.scheduleTime ?? current.scheduleTime);
    const retentionCount = validateRetentionCount(input.retentionCount ?? current.retentionCount);
    const timestamp = now();
    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO s3_backup_settings (id, backup_images, schedule_time, retention_count, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET backup_images = excluded.backup_images,
           schedule_time = excluded.schedule_time, retention_count = excluded.retention_count,
           updated_at = excluded.updated_at`,
        backupImages ? 1 : 0,
        scheduleTime,
        retentionCount,
        timestamp
      );
      this.store.audit(null, "platform.s3-backup-settings.updated", "s3-backup-settings", "s3-backup-settings", {
        backupImages,
        scheduleTime,
        retentionCount
      });
    });
    this.reschedule();
    return this.getSettings();
  }

  createTarget(input: S3BackupTargetInput): S3BackupTargetPublic {
    const normalized = this.normalizeTargetInput(input, undefined, true);
    const accessKey = encryptSecret(this.vault, normalized.accessKeyId!);
    const secretKey = encryptSecret(this.vault, normalized.secretAccessKey!);
    const targetId = `s3Target_${randomUUID().replaceAll("-", "")}`;
    const timestamp = now();
    this.database.transaction(() => {
      if (this.listStoredTargets().length >= maximumTargets) throw new AppError(400, "S3_TARGET_LIMIT", `最多只能配置 ${maximumTargets} 个 S3 备份目标`);
      this.database.run(
        `INSERT INTO s3_backup_targets (
          id, name, endpoint, bucket, region, prefix,
          access_key_encrypted, access_key_iv, access_key_tag,
          secret_key_encrypted, secret_key_iv, secret_key_tag,
          enabled, force_path_style, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        targetId,
        normalized.name,
        normalized.endpoint,
        normalized.bucket,
        normalized.region,
        normalized.prefix,
        accessKey.encrypted,
        accessKey.iv,
        accessKey.tag,
        secretKey.encrypted,
        secretKey.iv,
        secretKey.tag,
        normalized.enabled ? 1 : 0,
        normalized.forcePathStyle ? 1 : 0,
        timestamp,
        timestamp
      );
      this.store.audit(null, "platform.s3-backup-target.created", "s3-backup-target", targetId, safeTarget({
        ...normalized,
        id: targetId,
        accessKeyEncrypted: "",
        accessKeyIv: "",
        accessKeyTag: "",
        secretKeyEncrypted: "",
        secretKeyIv: "",
        secretKeyTag: "",
        createdAt: timestamp,
        updatedAt: timestamp
      }));
    });
    this.reschedule();
    return publicTarget(this.getStoredTarget(targetId));
  }

  updateTarget(targetId: string, input: S3BackupTargetInput): S3BackupTargetPublic {
    const current = this.getStoredTarget(targetId);
    const normalized = this.normalizeTargetInput(input, current, false);
    const hasAccessKey = input.accessKeyId !== undefined;
    const hasSecretKey = input.secretAccessKey !== undefined;
    const accessKey = hasAccessKey ? encryptSecret(this.vault, normalized.accessKeyId!) : {
      encrypted: current.accessKeyEncrypted,
      iv: current.accessKeyIv,
      tag: current.accessKeyTag
    };
    const secretKey = hasSecretKey ? encryptSecret(this.vault, normalized.secretAccessKey!) : {
      encrypted: current.secretKeyEncrypted,
      iv: current.secretKeyIv,
      tag: current.secretKeyTag
    };
    const timestamp = now();
    this.database.transaction(() => {
      this.database.run(
        `UPDATE s3_backup_targets SET name = ?, endpoint = ?, bucket = ?, region = ?, prefix = ?,
          access_key_encrypted = ?, access_key_iv = ?, access_key_tag = ?,
          secret_key_encrypted = ?, secret_key_iv = ?, secret_key_tag = ?,
          enabled = ?, force_path_style = ?, updated_at = ? WHERE id = ?`,
        normalized.name,
        normalized.endpoint,
        normalized.bucket,
        normalized.region,
        normalized.prefix,
        accessKey.encrypted,
        accessKey.iv,
        accessKey.tag,
        secretKey.encrypted,
        secretKey.iv,
        secretKey.tag,
        normalized.enabled ? 1 : 0,
        normalized.forcePathStyle ? 1 : 0,
        timestamp,
        targetId
      );
      this.store.audit(null, "platform.s3-backup-target.updated", "s3-backup-target", targetId, {
        ...safeTarget({ ...current, ...normalized, id: targetId, createdAt: current.createdAt, updatedAt: timestamp }),
        credentialsUpdated: hasAccessKey || hasSecretKey
      });
    });
    this.reschedule();
    return publicTarget(this.getStoredTarget(targetId));
  }

  deleteTarget(targetId: string): void {
    const current = this.getStoredTarget(targetId);
    this.database.transaction(() => {
      this.database.run("DELETE FROM s3_backup_targets WHERE id = ?", targetId);
      this.store.audit(null, "platform.s3-backup-target.deleted", "s3-backup-target", targetId, safeTarget(current));
    });
    this.reschedule();
  }

  async runNow(trigger: "manual" | "schedule" = "manual"): Promise<S3BackupRunResult> {
    if (this.running) return this.running;
    const operation = this.executeRun(trigger)
      .then((result) => {
        this.lastRun = result;
        if (!result.success) {
          throw new AppError(502, "S3_BACKUP_FAILED", "S3 备份未能同步到全部目标", {
            targets: result.targets.map((target) => ({
              targetId: target.targetId,
              targetName: target.targetName,
              status: target.status,
              statusCode: target.statusCode,
              error: target.error
            }))
          });
        }
        return result;
      })
      .catch((error: unknown) => {
        if (!(error instanceof AppError && error.code === "S3_BACKUP_FAILED")) {
          logger.error("s3.backup.failed", { trigger, error: sanitizeError(error) });
        }
        throw error;
      })
      .finally(() => {
        this.running = null;
        if (trigger === "schedule") this.reschedule();
      });
    this.running = operation;
    return operation;
  }

  dispose(): void {
    this.disposed = true;
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = null;
    logger.info("s3.backup.manager_disposed");
  }

  private listStoredTargets(): StoredTarget[] {
    return this.database.all("SELECT * FROM s3_backup_targets ORDER BY created_at, id").map(storedTarget);
  }

  private getStoredTarget(targetId: string): StoredTarget {
    const row = this.database.get("SELECT * FROM s3_backup_targets WHERE id = ?", targetId);
    if (!row) throw new AppError(404, "S3_TARGET_NOT_FOUND", "S3 备份目标不存在");
    return storedTarget(row);
  }

  private normalizeTargetInput(input: S3BackupTargetInput, current: StoredTarget | undefined, requireCredentials: boolean): {
    name: string;
    endpoint: string;
    bucket: string;
    region: string;
    prefix: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    enabled: boolean;
    forcePathStyle: boolean;
  } {
    const name = normalizeName(input.name ?? current?.name ?? "");
    const endpoint = normalizeEndpoint(input.endpoint ?? current?.endpoint ?? "");
    const bucket = normalizeBucket(input.bucket ?? current?.bucket ?? "");
    const region = normalizeRegion(input.region ?? current?.region ?? "us-east-1");
    const prefix = normalizeS3Prefix(input.prefix ?? current?.prefix);
    const enabled = input.enabled ?? current?.enabled ?? true;
    const forcePathStyle = input.forcePathStyle ?? current?.forcePathStyle ?? false;
    const hasAccessKey = input.accessKeyId !== undefined;
    const hasSecretKey = input.secretAccessKey !== undefined;
    if (requireCredentials && (!hasAccessKey || !hasSecretKey)) throw new AppError(400, "S3_CREDENTIALS_REQUIRED", "新建 S3 目标必须填写 AK 和 SK");
    if (hasAccessKey !== hasSecretKey) throw new AppError(400, "S3_CREDENTIALS_INCOMPLETE", "AK 和 SK 必须同时填写");
    return {
      name,
      endpoint,
      bucket,
      region,
      prefix,
      accessKeyId: hasAccessKey ? normalizeCredential(input.accessKeyId!, "AK", 300) : undefined,
      secretAccessKey: hasSecretKey ? normalizeCredential(input.secretAccessKey!, "SK", 500) : undefined,
      enabled: Boolean(enabled),
      forcePathStyle: Boolean(forcePathStyle)
    };
  }

  private async executeRun(trigger: "manual" | "schedule"): Promise<S3BackupRunResult> {
    const startedAt = now();
    const settings = this.getSettings();
    const enabledTargets = this.listStoredTargets().filter((target) => target.enabled);
    if (!enabledTargets.length) throw new AppError(409, "S3_NO_ENABLED_TARGET", "请先启用至少一个 S3 备份目标");
    const snapshotRoot = this.databasePath === ":memory:" ? tmpdir() : dirname(this.databasePath);
    const temporaryDirectory = await mkdtemp(join(snapshotRoot, ".scriverse-s3-backup-"));
    const snapshotPath = join(temporaryDirectory, "snapshot.db");
    const timestamp = new Date();
    try {
      this.database.createSnapshot(snapshotPath);
      await chmod(snapshotPath, 0o600);
      const databaseContent = await readFile(snapshotPath);
      const assets = settings.backupImages ? this.listImageAssets() : [];
      const targets: S3BackupTargetRunResult[] = [];
      for (const stored of enabledTargets) {
        try {
          const target = decryptTarget(this.vault, stored);
          targets.push(await this.backupTarget(target, databaseContent, assets, settings.retentionCount, timestamp));
        } catch (error) {
          const failure = error instanceof S3RequestError
            ? { statusCode: error.status, error: error.message }
            : { error: error instanceof Error ? error.message : "S3 目标同步失败" };
          logger.error("s3.backup.target_failed", {
            target: safeTarget(stored),
            ...(error instanceof S3RequestError ? { statusCode: error.status, response: responseBodyForLog(error.responseBody) } : {}),
            ...failure
          });
          targets.push({
            targetId: stored.id,
            targetName: stored.name,
            status: "failed",
            imagesUploaded: 0,
            imagesSkipped: 0,
            databaseObjectKey: null,
            deletedDatabaseBackups: 0,
            ...(error instanceof S3RequestError ? { statusCode: error.status } : {}),
            error: failure.error
          });
        }
      }
      const completedAt = now();
      const result: S3BackupRunResult = {
        success: targets.every((target) => target.status === "success"),
        trigger,
        startedAt,
        completedAt,
        targets
      };
      if (result.success) logger.info("s3.backup.completed", { trigger, targetCount: targets.length, completedAt });
      else logger.error("s3.backup.partial_failure", {
        trigger,
        targetCount: targets.length,
        failedTargetCount: targets.filter((target) => target.status === "failed").length,
        completedAt
      });
      return result;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private listImageAssets(): ImageAsset[] {
    const assets: ImageAsset[] = [];
    const keys = new Set<string>();
    const attachments = this.database.all("SELECT DISTINCT storage_key, stored_mime_type, stored_sha256 FROM attachments ORDER BY storage_key");
    for (const row of attachments) {
      const storageKey = stringValue(row, "storage_key");
      const contentType = stringValue(row, "stored_mime_type");
      const sha256 = stringValue(row, "stored_sha256");
      if (!imageMimeTypes.has(contentType) || !/^[a-f0-9]{64}$/u.test(sha256)) continue;
      const key = `attachments/${sha256}.${imageExtension(contentType)}`;
      if (keys.has(key)) continue;
      keys.add(key);
      assets.push({ key, contentType, read: () => this.attachmentStorage.read(storageKey) });
    }
    for (const row of this.database.all("SELECT work_id, mime_type, content, sha256 FROM work_covers ORDER BY work_id")) {
      const contentType = stringValue(row, "mime_type");
      const sha256 = stringValue(row, "sha256");
      if (!imageMimeTypes.has(contentType) || !/^[a-f0-9]{64}$/u.test(sha256)) continue;
      const key = `covers/${sha256}.${imageExtension(contentType)}`;
      if (keys.has(key)) continue;
      keys.add(key);
      const content = Buffer.from(row.content as Uint8Array);
      assets.push({ key, contentType, read: async () => content });
    }
    for (const row of this.database.all("SELECT user_id, mime_type, content, sha256 FROM user_avatars ORDER BY user_id")) {
      const contentType = stringValue(row, "mime_type");
      const sha256 = stringValue(row, "sha256");
      if (!imageMimeTypes.has(contentType) || !/^[a-f0-9]{64}$/u.test(sha256)) continue;
      const key = `avatars/${sha256}.${imageExtension(contentType)}`;
      if (keys.has(key)) continue;
      keys.add(key);
      const content = Buffer.from(row.content as Uint8Array);
      assets.push({ key, contentType, read: async () => content });
    }
    return assets;
  }

  private async backupTarget(
    target: DecryptedTarget,
    databaseContent: Buffer,
    assets: ImageAsset[],
    retentionCount: number,
    timestamp: Date
  ): Promise<S3BackupTargetRunResult> {
    let imagesUploaded = 0;
    let imagesSkipped = 0;
    if (assets.length > 0) {
      for (const asset of assets) {
        const key = `${objectPrefix(target, "img")}${asset.key}`;
        if (await this.headObject(target, key)) {
          imagesSkipped += 1;
          continue;
        }
        await this.putObject(target, key, await asset.read(), asset.contentType);
        imagesUploaded += 1;
      }
    }
    const databaseKey = `${objectPrefix(target, "db")}${databaseObjectName(timestamp)}`;
    await this.putObject(target, databaseKey, databaseContent, "application/vnd.sqlite3");
    const deletedDatabaseBackups = await this.cleanupDatabaseBackups(target, objectPrefix(target, "db"), retentionCount);
    return {
      targetId: target.id,
      targetName: target.name,
      status: "success",
      imagesUploaded,
      imagesSkipped,
      databaseObjectKey: databaseKey,
      deletedDatabaseBackups
    };
  }

  private async headObject(target: DecryptedTarget, key: string): Promise<boolean> {
    const response = await this.request({ method: "HEAD", target, key, allowStatuses: [404] });
    return response.status !== 404;
  }

  private async putObject(target: DecryptedTarget, key: string, body: Buffer, contentType: string): Promise<void> {
    await this.request({ method: "PUT", target, key, body, contentType });
  }

  private async listObjects(target: DecryptedTarget, prefix: string): Promise<ListedObject[]> {
    const objects: ListedObject[] = [];
    let continuationToken: string | null = null;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix };
      if (continuationToken) query["continuation-token"] = continuationToken;
      const response = await this.request({ method: "GET", target, query });
      const parsed = parseS3ListObjectsResponse(await response.text());
      objects.push(...parsed.objects);
      continuationToken = parsed.nextContinuationToken;
    } while (continuationToken);
    return objects;
  }

  private async cleanupDatabaseBackups(target: DecryptedTarget, prefix: string, retentionCount: number): Promise<number> {
    const backups = (await this.listObjects(target, prefix))
      .filter((object) => object.key.startsWith(prefix) && object.key.endsWith(".db"))
      .sort((left, right) => {
        const leftTime = left.lastModified ? Date.parse(left.lastModified) : Number.NaN;
        const rightTime = right.lastModified ? Date.parse(right.lastModified) : Number.NaN;
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime;
        return right.key.localeCompare(left.key);
      });
    const oldBackups = backups.slice(retentionCount);
    for (const backup of oldBackups) await this.request({ method: "DELETE", target, key: backup.key });
    return oldBackups.length;
  }

  private objectUrl(target: StoredTarget, key: string, query?: Record<string, string>): URL {
    const endpoint = new URL(target.endpoint);
    const endpointPath = endpoint.pathname.replace(/\/+$/u, "");
    const objectPath = encodedPath(key);
    if (target.forcePathStyle) {
      endpoint.pathname = `${endpointPath}/${rfc3986(target.bucket)}/${objectPath}`;
    } else {
      endpoint.hostname = `${target.bucket}.${endpoint.hostname}`;
      endpoint.pathname = `${endpointPath}/${objectPath}`;
    }
    endpoint.search = canonicalQuery(query);
    return endpoint;
  }

  private async request(options: S3RequestOptions): Promise<Response> {
    const date = new Date();
    const requestDate = isoRequestDate(date);
    const body = options.body ?? Buffer.alloc(0);
    const payloadHash = body.byteLength > 0 ? createHash("sha256").update(body).digest("hex") : emptyPayloadHash;
    const url = this.objectUrl(options.target, options.key ?? "", options.query);
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": requestDate.full
    };
    if (options.contentType) headers["content-type"] = options.contentType;
    const canonical = canonicalHeaders(headers);
    const canonicalRequest = [
      options.method,
      url.pathname || "/",
      url.search.slice(1),
      canonical.value,
      canonical.signed,
      payloadHash
    ].join("\n");
    const scope = `${requestDate.short}/${options.target.region}/${s3ServiceName}/aws4_request`;
    const signature = createHmac("sha256", signingKey(options.target.secretAccessKey, requestDate.short, options.target.region))
      .update(`AWS4-HMAC-SHA256\n${requestDate.full}\n${scope}\n${createHash("sha256").update(canonicalRequest).digest("hex")}`)
      .digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${options.target.accessKeyId}/${scope}, SignedHeaders=${canonical.signed}, Signature=${signature}`;
    const timeout = new AbortController();
    const timeoutHandle = setTimeout(() => timeout.abort(new Error("S3 request timed out")), s3RequestTimeoutMs);
    try {
      const response = await fetchSafeAiEndpoint(this.fetchImpl, url.toString(), {
        method: options.method,
        headers,
        body: body.byteLength > 0 ? body as unknown as BodyInit : undefined,
        signal: timeout.signal
      }, this.scheduleValidator, 0);
      const allowed = options.allowStatuses ?? [];
      if (response.ok || allowed.includes(response.status)) return response;
      const responseBody = responseBodyForLog(await response.text());
      logger.error("s3.request.failed", {
        target: safeTarget(options.target),
        method: options.method,
        url: url.toString(),
        status: response.status,
        response: responseBody
      });
      throw new S3RequestError(response.status, responseBody);
    } catch (error) {
      if (error instanceof S3RequestError) throw error;
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private reschedule(): void {
    if (this.disposed) return;
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = null;
    const settings = this.getSettings();
    if (!this.listStoredTargets().some((target) => target.enabled)) return;
    const [hour, minute] = settings.scheduleTime.split(":").map(Number);
    const next = new Date();
    next.setHours(hour ?? 3, minute ?? 0, 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    const delay = Math.max(1, next.getTime() - Date.now());
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = null;
      void this.runNow("schedule").catch((error: unknown) => {
        logger.error("s3.backup.scheduled_failed", { error: sanitizeError(error) });
      });
    }, Math.min(delay, 2_147_483_647));
    this.scheduleTimer.unref?.();
    logger.debug("s3.backup.scheduled", { scheduleTime: settings.scheduleTime, delayMs: delay });
  }
}
