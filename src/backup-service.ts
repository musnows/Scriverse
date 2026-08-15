import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { CredentialVault } from "./credential-vault.js";
import { PLATFORM_AI_WORK_ID, type Row } from "./database.js";
import { AppError, notFound } from "./errors.js";
import { logger, sanitizeError } from "./logger.js";
import type { Store } from "./store.js";
import { id, maskSecret, now } from "./utils.js";

export type BackupTargetInput = {
  name: string;
  endpoint: string;
  region?: string;
  bucket: string;
  prefix?: string;
  accessKeyId: string;
  secretAccessKey?: string;
  backupImages?: boolean;
  enabled?: boolean;
};

export type BackupTargetPublic = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKeyHint: string;
  backupImages: boolean;
  enabled: boolean;
  lastStatus: string;
  lastError: string | null;
  lastSuccessAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BackupRunResult = {
  targetId: string;
  name: string;
  ok: boolean;
  uploadedDatabase: string | null;
  uploadedImages: number;
  skippedImages: number;
  deletedBackups: number;
  error?: string;
};

type BackupTargetRow = Row & {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  access_key_id: string;
  encrypted_secret_key: string;
  key_iv: string;
  key_tag: string;
  key_hint: string;
  backup_images: number;
  enabled: number;
  last_status: string;
  last_error: string | null;
  last_success_at: string | null;
  created_at: string;
  updated_at: string;
};

function stringValue(row: Row, key: string): string {
  return String(row[key] ?? "");
}

function numberValue(row: Row, key: string): number {
  return Number(row[key] ?? 0);
}

function booleanValue(row: Row, key: string): boolean {
  return Number(row[key] ?? 0) === 1;
}

function maskSecretKey(value: string): string {
  return maskSecret(value);
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function normalizePrefix(value: string | undefined): string {
  const prefix = (value ?? "").trim().replace(/^\/+|\/+$/gu, "");
  return prefix ? `${prefix}/scriverse` : "scriverse";
}

function normalizeStoredPrefix(value: string | undefined): string {
  return (value ?? "").trim().replace(/^\/+|\/+$/gu, "");
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: string | Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function parseS3ListKeys(xml: string): string[] {
  const keys: string[] = [];
  const pattern = /<Key>([\s\S]*?)<\/Key>/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const key = decodeXmlEntities(match[1] ?? "");
    if (key) keys.push(key);
  }
  return keys;
}

function mimeTypeForFile(filename: string): string {
  const lower = filename.toLocaleLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

class S3Client {
  constructor(
    private readonly config: {
      endpoint: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      bucket: string;
      fetchImpl: typeof fetch;
    }
  ) {}

  private urlFor(key: string | null, query?: URLSearchParams): URL {
    const url = new URL(this.config.endpoint);
    const basePath = url.pathname.replace(/\/+$/u, "");
    const encodedBucket = encodeURIComponent(this.config.bucket);
    const objectPath = key === null
      ? `${basePath}/${encodedBucket}`
      : `${basePath}/${encodedBucket}/${key.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
    url.pathname = objectPath;
    if (query) url.search = query.toString();
    return url;
  }

  private async signedHeaders(method: string, url: URL, body?: Buffer, extraHeaders: Record<string, string> = {}): Promise<Headers> {
    const nowDate = new Date();
    const amzDate = nowDate.toISOString().replace(/[:-]/gu, "").replace(/\.\d{3}/u, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = body ? sha256Hex(body) : sha256Hex("");
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...extraHeaders
    };
    const canonicalQuery = [...url.searchParams.entries()]
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&");
    url.search = canonicalQuery;
    const sortedHeaderNames = Object.keys(headers).sort((left, right) => left.localeCompare(right));
    const canonicalHeaders = sortedHeaderNames
      .map((name) => `${name.toLocaleLowerCase()}:${String(headers[name]).trim()}\n`)
      .join("");
    const signedHeaders = sortedHeaderNames.map((name) => name.toLocaleLowerCase()).join(";");
    const canonicalRequest = [
      method,
      url.pathname,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join("\n");
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256Hex(canonicalRequest)
    ].join("\n");
    const dateKey = hmac(`AWS4${this.config.secretAccessKey}`, dateStamp);
    const regionKey = hmac(dateKey, this.config.region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = hmacHex(signingKey, stringToSign);
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return new Headers(headers);
  }

  private async s3Error(operation: string, key: string, response: Response): Promise<Error> {
    const body = await response.text();
    const message = `S3 ${operation} 失败（${response.status} ${response.statusText}）：${body.slice(0, 2000)}`;
    const error = new Error(message);
    (error as Error & { s3Status?: number; s3Body?: string }).s3Status = response.status;
    (error as Error & { s3Status?: number; s3Body?: string }).s3Body = body;
    return error;
  }

  async headObject(key: string): Promise<boolean> {
    const url = this.urlFor(key);
    const headers = await this.signedHeaders("HEAD", url, undefined, {});
    const response = await this.config.fetchImpl(url, { method: "HEAD", headers });
    if (response.status === 404) return false;
    if (!response.ok) throw await this.s3Error("HEAD", key, response);
    return true;
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    const url = this.urlFor(key);
    const headers = await this.signedHeaders("PUT", url, body, { "content-type": contentType });
    const requestBody = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    const response = await this.config.fetchImpl(url, { method: "PUT", headers, body: requestBody });
    if (!response.ok) throw await this.s3Error("PUT", key, response);
  }

  async deleteObject(key: string): Promise<void> {
    const url = this.urlFor(key);
    const headers = await this.signedHeaders("DELETE", url, undefined, {});
    const response = await this.config.fetchImpl(url, { method: "DELETE", headers });
    if (!response.ok && response.status !== 404) throw await this.s3Error("DELETE", key, response);
  }

  async listObjectKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const query = new URLSearchParams({
        "list-type": "2",
        prefix,
        "max-keys": "1000"
      });
      if (continuationToken) query.set("continuation-token", continuationToken);
      const url = this.urlFor(null, query);
      const headers = await this.signedHeaders("GET", url, undefined, {});
      const response = await this.config.fetchImpl(url, { method: "GET", headers });
      if (!response.ok) throw await this.s3Error("LIST", prefix, response);
      const xml = await response.text();
      keys.push(...parseS3ListKeys(xml));
      const truncated = /<IsTruncated>true<\/IsTruncated>/iu.test(xml);
      const nextTokenMatch = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/iu.exec(xml);
      continuationToken = truncated && nextTokenMatch?.[1] ? decodeXmlEntities(nextTokenMatch[1]) : undefined;
    } while (continuationToken);
    return keys;
  }
}

export class BackupService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly vault: CredentialVault,
    private readonly options: {
      databasePath: string;
      attachmentDirectory: string;
      fetchImpl?: typeof fetch;
      developmentServer?: boolean;
    }
  ) {}

  start(): void {
    if (this.options.databasePath === ":memory:") return;
    this.reschedule();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getSettings(): Record<string, unknown> {
    const row = this.store.db.get("SELECT * FROM platform_backup_settings WHERE id = 1");
    return {
      scheduleHour: Math.min(23, Math.max(0, numberValue(row ?? {}, "schedule_hour"))),
      scheduleMinute: Math.min(59, Math.max(0, numberValue(row ?? {}, "schedule_minute"))),
      backupRetention: Math.min(100, Math.max(1, numberValue(row ?? {}, "backup_retention"))),
      updatedAt: stringValue(row ?? {}, "updated_at")
    };
  }

  updateSettings(input: { scheduleHour?: number; scheduleMinute?: number; backupRetention?: number }): Record<string, unknown> {
    const current = this.getSettings();
    const scheduleHour = input.scheduleHour ?? Number(current.scheduleHour);
    const scheduleMinute = input.scheduleMinute ?? Number(current.scheduleMinute);
    const backupRetention = input.backupRetention ?? Number(current.backupRetention);
    if (!Number.isInteger(scheduleHour) || scheduleHour < 0 || scheduleHour > 23) {
      throw new AppError(400, "BACKUP_SCHEDULE_INVALID", "备份小时必须是 0-23 的整数");
    }
    if (!Number.isInteger(scheduleMinute) || scheduleMinute < 0 || scheduleMinute > 59) {
      throw new AppError(400, "BACKUP_SCHEDULE_INVALID", "备份分钟必须是 0-59 的整数");
    }
    if (!Number.isInteger(backupRetention) || backupRetention < 1 || backupRetention > 100) {
      throw new AppError(400, "BACKUP_RETENTION_INVALID", "备份留存个数必须是 1-100 的整数");
    }
    const timestamp = now();
    this.store.db.run(
      `INSERT INTO platform_backup_settings (id, schedule_hour, schedule_minute, backup_retention, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET schedule_hour = excluded.schedule_hour,
         schedule_minute = excluded.schedule_minute,
         backup_retention = excluded.backup_retention,
         updated_at = excluded.updated_at`,
      scheduleHour,
      scheduleMinute,
      backupRetention,
      timestamp
    );
    this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup-settings.updated", "platform-backup-settings", "platform-backup-settings", {
      scheduleHour,
      scheduleMinute,
      backupRetention
    });
    this.reschedule();
    return this.getSettings();
  }

  listTargets(): BackupTargetPublic[] {
    return this.store.db.all("SELECT * FROM platform_backup_targets ORDER BY created_at, id").map((row) => this.mapTarget(row));
  }

  getTarget(targetId: string): BackupTargetPublic {
    return this.mapTarget(this.getTargetRow(targetId));
  }

  createTarget(input: BackupTargetInput): BackupTargetPublic {
    if (!input.secretAccessKey) throw new AppError(400, "BACKUP_SECRET_REQUIRED", "请填写 S3 Secret Access Key");
    const targetId = id("backup");
    const encrypted = this.vault.encrypt(input.secretAccessKey);
    const timestamp = now();
    this.store.db.run(
      `INSERT INTO platform_backup_targets (
        id, name, endpoint, region, bucket, prefix, access_key_id, encrypted_secret_key,
        key_iv, key_tag, key_hint, backup_images, enabled, last_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'never', ?, ?)`,
      targetId,
      input.name.trim(),
      normalizeEndpoint(input.endpoint),
      (input.region ?? "us-east-1").trim(),
      input.bucket.trim(),
      normalizeStoredPrefix(input.prefix),
      input.accessKeyId.trim(),
      encrypted.encrypted,
      encrypted.iv,
      encrypted.tag,
      maskSecretKey(input.secretAccessKey),
      input.backupImages === false ? 0 : 1,
      input.enabled === false ? 0 : 1,
      timestamp,
      timestamp
    );
    this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup-target.created", "platform-backup-target", targetId, {
      name: input.name.trim(),
      endpoint: normalizeEndpoint(input.endpoint),
      bucket: input.bucket.trim(),
      prefix: normalizeStoredPrefix(input.prefix),
      backupImages: input.backupImages !== false,
      enabled: input.enabled !== false
    });
    return this.getTarget(targetId);
  }

  updateTarget(targetId: string, input: Partial<BackupTargetInput>): BackupTargetPublic {
    const row = this.getTargetRow(targetId);
    const nextName = input.name?.trim() ?? stringValue(row, "name");
    const nextEndpoint = input.endpoint ? normalizeEndpoint(input.endpoint) : stringValue(row, "endpoint");
    const nextRegion = (input.region ?? stringValue(row, "region")).trim();
    const nextBucket = (input.bucket ?? stringValue(row, "bucket")).trim();
    const nextPrefix = (input.prefix === undefined ? stringValue(row, "prefix") : normalizeStoredPrefix(input.prefix));
    const nextAccessKeyId = (input.accessKeyId ?? stringValue(row, "access_key_id")).trim();
    let encryptedSecret = stringValue(row, "encrypted_secret_key");
    let keyIv = stringValue(row, "key_iv");
    let keyTag = stringValue(row, "key_tag");
    let keyHint = stringValue(row, "key_hint");
    if (input.secretAccessKey) {
      const encrypted = this.vault.encrypt(input.secretAccessKey);
      encryptedSecret = encrypted.encrypted;
      keyIv = encrypted.iv;
      keyTag = encrypted.tag;
      keyHint = maskSecretKey(input.secretAccessKey);
    }
    const backupImages = input.backupImages === undefined ? booleanValue(row, "backup_images") : input.backupImages;
    const enabled = input.enabled === undefined ? booleanValue(row, "enabled") : input.enabled;
    const timestamp = now();
    this.store.db.run(
      `UPDATE platform_backup_targets SET
        name = ?, endpoint = ?, region = ?, bucket = ?, prefix = ?, access_key_id = ?,
        encrypted_secret_key = ?, key_iv = ?, key_tag = ?, key_hint = ?,
        backup_images = ?, enabled = ?, updated_at = ?
       WHERE id = ?`,
      nextName,
      nextEndpoint,
      nextRegion,
      nextBucket,
      nextPrefix,
      nextAccessKeyId,
      encryptedSecret,
      keyIv,
      keyTag,
      keyHint,
      backupImages ? 1 : 0,
      enabled ? 1 : 0,
      timestamp,
      targetId
    );
    this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup-target.updated", "platform-backup-target", targetId, {
      fields: Object.keys(input).filter((key) => key !== "secretAccessKey"),
      secretReplaced: Boolean(input.secretAccessKey)
    });
    return this.getTarget(targetId);
  }

  deleteTarget(targetId: string): void {
    this.getTargetRow(targetId);
    this.store.db.run("DELETE FROM platform_backup_targets WHERE id = ?", targetId);
    this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup-target.deleted", "platform-backup-target", targetId, {});
  }

  async runNow(): Promise<BackupRunResult[]> {
    if (this.running) throw new AppError(409, "BACKUP_ALREADY_RUNNING", "备份任务正在执行中，请稍后再试");
    this.running = true;
    const rows = this.store.db.all<BackupTargetRow>(
      "SELECT * FROM platform_backup_targets WHERE enabled = 1 ORDER BY created_at, id"
    );
    const results: BackupRunResult[] = [];
    try {
      for (const row of rows) {
        try {
          results.push(await this.runTarget(row));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.markTargetResult(stringValue(row, "id"), "failed", message);
          logger.error("backup.target.failed", {
            target: this.targetLogSafe(row),
            error: sanitizeError(error)
          });
          results.push({
            targetId: stringValue(row, "id"),
            name: stringValue(row, "name"),
            ok: false,
            uploadedDatabase: null,
            uploadedImages: 0,
            skippedImages: 0,
            deletedBackups: 0,
            error: message
          });
        }
      }
      return results;
    } finally {
      this.running = false;
    }
  }

  private async runTarget(row: BackupTargetRow): Promise<BackupRunResult> {
    const secret = this.decryptSecret(row);
    const s3 = new S3Client({
      endpoint: stringValue(row, "endpoint"),
      region: stringValue(row, "region"),
      accessKeyId: stringValue(row, "access_key_id"),
      secretAccessKey: secret,
      bucket: stringValue(row, "bucket"),
      fetchImpl: this.options.fetchImpl ?? fetch
    });
    const prefix = normalizePrefix(stringValue(row, "prefix"));
    const dbPrefix = `${prefix}/db`;
    const timestamp = new Date().toISOString().replace(/:/gu, "-").replace(/\.\d{3}Z$/u, "Z");
    const dbName = `database-${timestamp}.db`;
    const dbKey = `${dbPrefix}/${dbName}`;
    const tempDirectory = mkdtempSync(join(tmpdir(), "scriverse-backup-"));
    let uploadedImages = 0;
    let skippedImages = 0;
    try {
      const snapshotPath = join(tempDirectory, dbName);
      this.snapshotDatabase(snapshotPath);
      await s3.putObject(dbKey, await readFile(snapshotPath), "application/octet-stream");

      if (booleanValue(row, "backup_images")) {
        for (const filePath of this.listAttachmentFiles()) {
          const storageKey = relative(this.options.attachmentDirectory, filePath).split(sep).join("/");
          const imageKey = `${prefix}/img/${storageKey}`;
          if (await s3.headObject(imageKey)) {
            skippedImages += 1;
            continue;
          }
          await s3.putObject(imageKey, await readFile(filePath), mimeTypeForFile(filePath));
          uploadedImages += 1;
        }
      }

      const deletedBackups = await this.cleanupOldDatabaseBackups(s3, dbPrefix, row);
      this.markTargetResult(stringValue(row, "id"), "success", null, now());
      logger.info("backup.target.completed", {
        target: this.targetLogSafe(row),
        uploadedDatabase: dbKey,
        uploadedImages,
        skippedImages,
        deletedBackups
      });
      return {
        targetId: stringValue(row, "id"),
        name: stringValue(row, "name"),
        ok: true,
        uploadedDatabase: dbKey,
        uploadedImages,
        skippedImages,
        deletedBackups
      };
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  }

  private snapshotDatabase(snapshotPath: string): void {
    const escaped = snapshotPath.replace(/'/gu, "''");
    this.store.db.raw.exec(`VACUUM INTO '${escaped}'`);
  }

  private *listAttachmentFiles(): Generator<string> {
    if (!existsSync(this.options.attachmentDirectory)) return;
    const stack = [resolve(this.options.attachmentDirectory)];
    while (stack.length > 0) {
      const directory = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name === ".tmp") continue;
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile()) {
          yield fullPath;
        }
      }
    }
  }

  private async cleanupOldDatabaseBackups(s3: S3Client, dbPrefix: string, row: BackupTargetRow): Promise<number> {
    const retention = Number(this.getSettings().backupRetention);
    const keys = (await s3.listObjectKeys(`${dbPrefix}/`))
      .filter((key) => key.startsWith(`${dbPrefix}/`) && key.endsWith(".db"))
      .sort((left, right) => left.localeCompare(right));
    const removeCount = Math.max(0, keys.length - retention);
    for (const key of keys.slice(0, removeCount)) {
      await s3.deleteObject(key);
    }
    if (removeCount > 0) {
      logger.info("backup.target.cleanup", {
        target: this.targetLogSafe(row),
        removed: removeCount,
        remaining: keys.length - removeCount
      });
    }
    return removeCount;
  }

  private getTargetRow(targetId: string): BackupTargetRow {
    const row = this.store.db.get<BackupTargetRow>("SELECT * FROM platform_backup_targets WHERE id = ?", targetId);
    if (!row) throw notFound("S3 备份目标");
    return row;
  }

  private decryptSecret(row: BackupTargetRow): string {
    try {
      return this.vault.decrypt({
        encrypted: stringValue(row, "encrypted_secret_key"),
        iv: stringValue(row, "key_iv"),
        tag: stringValue(row, "key_tag")
      });
    } catch {
      throw new AppError(500, "BACKUP_CREDENTIAL_DECRYPT_FAILED", "S3 备份目标凭据无法解密，请重新填写 Secret Access Key");
    }
  }

  private mapTarget(row: Row): BackupTargetPublic {
    return {
      id: stringValue(row, "id"),
      name: stringValue(row, "name"),
      endpoint: stringValue(row, "endpoint"),
      region: stringValue(row, "region"),
      bucket: stringValue(row, "bucket"),
      prefix: stringValue(row, "prefix"),
      accessKeyId: stringValue(row, "access_key_id"),
      secretAccessKeyHint: stringValue(row, "key_hint"),
      backupImages: booleanValue(row, "backup_images"),
      enabled: booleanValue(row, "enabled"),
      lastStatus: stringValue(row, "last_status"),
      lastError: row.last_error === null || row.last_error === undefined ? null : stringValue(row, "last_error"),
      lastSuccessAt: row.last_success_at === null || row.last_success_at === undefined ? null : stringValue(row, "last_success_at"),
      createdAt: stringValue(row, "created_at"),
      updatedAt: stringValue(row, "updated_at")
    };
  }

  private markTargetResult(targetId: string, status: "success" | "failed", error: string | null, successAt: string | null = null): void {
    this.store.db.run(
      `UPDATE platform_backup_targets SET last_status = ?, last_error = ?, last_success_at = ?, updated_at = ? WHERE id = ?`,
      status,
      error,
      successAt,
      now(),
      targetId
    );
  }

  private targetLogSafe(row: BackupTargetRow): Record<string, unknown> {
    return {
      id: stringValue(row, "id"),
      name: stringValue(row, "name"),
      endpoint: stringValue(row, "endpoint"),
      region: stringValue(row, "region"),
      bucket: stringValue(row, "bucket"),
      prefix: stringValue(row, "prefix"),
      backupImages: booleanValue(row, "backup_images"),
      enabled: booleanValue(row, "enabled")
    };
  }

  private reschedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.options.databasePath === ":memory:") return;
    const settings = this.getSettings();
    const next = new Date();
    next.setHours(Number(settings.scheduleHour), Number(settings.scheduleMinute), 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    const delay = Math.max(1, next.getTime() - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runScheduled();
    }, delay);
    this.timer.unref?.();
  }

  private async runScheduled(): Promise<void> {
    try {
      await this.runNow();
    } catch (error) {
      logger.error("backup.scheduled.failed", { error: sanitizeError(error) });
    } finally {
      this.reschedule();
    }
  }
}
