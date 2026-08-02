import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { extname, join } from "node:path";
import { CredentialVault } from "./credential-vault.js";
import type { SQLInputValue } from "node:sqlite";
import { Database } from "./database.js";
import { AppError } from "./errors.js";
import { logger, sanitizeError } from "./logger.js";

// --- 类型定义 ---

export type S3BackupConfig = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  subdirectory: string;
  accessKeyId: string;
  includeImages: boolean;
  scheduleEnabled: boolean;
  scheduleHour: number;
  scheduleMinute: number;
  retentionCount: number;
  enabled: boolean;
  lastBackupAt: string | null;
  lastBackupStatus: string | null;
  lastBackupError: string | null;
  createdAt: string;
  updatedAt: string;
};

type StoredS3BackupConfig = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  subdirectory: string;
  access_key_id: string;
  encrypted_secret_key: string;
  secret_key_iv: string;
  secret_key_tag: string;
  secret_key_hint: string;
  include_images: number;
  schedule_enabled: number;
  schedule_hour: number;
  schedule_minute: number;
  retention_count: number;
  enabled: number;
  last_backup_at: string | null;
  last_backup_status: string | null;
  last_backup_error: string | null;
  created_at: string;
  updated_at: string;
};

export type S3BackupConfigInput = {
  name: string;
  endpoint: string;
  region?: string;
  bucket: string;
  subdirectory?: string;
  accessKeyId: string;
  secretAccessKey: string;
  includeImages?: boolean;
  scheduleEnabled?: boolean;
  scheduleHour?: number;
  scheduleMinute?: number;
  retentionCount?: number;
  enabled?: boolean;
};

export type S3BackupConfigUpdate = Partial<S3BackupConfigInput>;

// --- S3 Key 计算 ---

/** 根据子目录配置和相对路径计算完整的 S3 key */
export function computeS3Key(subdirectory: string, relativePath: string): string {
  const normalized = subdirectory.replace(/^\/+|\/+$/gu, "");
  const parts = [normalized, "scriverse", relativePath].filter(Boolean);
  return parts.join("/").replace(/\/{2,}/gu, "/");
}

// --- AWS Signature V4 签名工具 ---

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function amzTimestamp(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/gu, "");
}

function amzDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/gu, "");
}

// --- S3 客户端 ---

type S3ClientOptions = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  subdirectory: string;
};

class S3Client {
  private readonly endpoint: string;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly bucket: string;
  readonly subdirectory: string;
  private readonly endpointHost: string;
  private readonly usePathStyle: boolean;

  constructor(options: S3ClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/u, "");
    this.region = options.region;
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.bucket = options.bucket;
    this.subdirectory = options.subdirectory.replace(/^\/+|\/+$/gu, "");
    this.usePathStyle = !this.endpoint.includes("amazonaws.com");
    try {
      this.endpointHost = new URL(this.endpoint).host;
    } catch {
      this.endpointHost = this.endpoint;
    }
  }

  /** 构造请求 URL */
  private requestUrl(key: string, queryParams?: Record<string, string>): string {
    const encodedKey = encodeURIComponent(key).replace(/%2F/gu, "/");
    const query = queryParams ? `?${new URLSearchParams(queryParams).toString()}` : "";
    if (this.usePathStyle) {
      return `${this.endpoint}/${this.bucket}/${encodedKey}${query}`;
    }
    const proto = this.endpoint.split("://")[0];
    return `${proto}://${this.bucket}.${this.endpointHost}/${encodedKey}${query}`;
  }

  /** 计算 AWS Signature V4 Authorization 头 */
  private signRequest(
    method: string,
    key: string,
    queryParams: Record<string, string> | undefined,
    headers: Record<string, string>,
    payloadHash: string
  ): string {
    const date = new Date();
    const timestamp = amzTimestamp(date);
    const dateOnly = amzDateOnly(date);
    const encodedKey = encodeURIComponent(key).replace(/%2F/gu, "/");
    const canonicalUri = `/${encodedKey}`;
    const canonicalQuery = queryParams
      ? new URLSearchParams(queryParams).toString()
      : "";
    const signedHeaders = Object.keys(headers).sort().map((k) => k.toLocaleLowerCase()).join(";");
    const canonicalHeaders = Object.entries(headers)
      .sort(([a], [b]) => a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase()))
      .map(([k, v]) => `${k.toLocaleLowerCase()}:${v.trim()}`)
      .join("\n");

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      `${canonicalHeaders}\n`,
      signedHeaders,
      payloadHash
    ].join("\n");

    const credentialScope = `${dateOnly}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      timestamp,
      credentialScope,
      sha256Hex(canonicalRequest)
    ].join("\n");

    const kDate = hmacSha256(`AWS4${this.secretAccessKey}`, dateOnly);
    const kRegion = hmacSha256(kDate, this.region);
    const kService = hmacSha256(kRegion, "s3");
    const kSigning = hmacSha256(kService, "aws4_request");
    const signature = hmacSha256(kSigning, stringToSign).toString("hex");

    return `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  }

  /** 发送 S3 请求 */
  private async request(
    method: string,
    s3KeyPath: string,
    options?: {
      body?: Buffer;
      contentType?: string;
      queryParams?: Record<string, string>;
    }
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const payload = options?.body ?? Buffer.alloc(0);
    const payloadHash = sha256Hex(payload);
    const date = new Date();
    const timestamp = amzTimestamp(date);
    const host = this.usePathStyle
      ? this.endpointHost
      : `${this.bucket}.${this.endpointHost}`;

    const headers: Record<string, string> = {
      Host: host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": timestamp,
      ...(options?.contentType ? { "Content-Type": options.contentType } : {})
    };

    const url = this.requestUrl(s3KeyPath, options?.queryParams);
    headers["Authorization"] = this.signRequest(
      method, s3KeyPath, options?.queryParams, headers, payloadHash
    );

    const response = await fetch(url, {
      method,
      headers,
      body: payload.length > 0 ? new Uint8Array(payload) : undefined
    });

    const responseBody = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return { status: response.status, headers: responseHeaders, body: responseBody };
  }

  /** 上传对象 */
  async putObject(key: string, body: Buffer, contentType = "application/octet-stream"): Promise<void> {
    const response = await this.request("PUT", key, { body, contentType });
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`S3 upload failed (HTTP ${response.status}): ${response.body}`);
    }
  }

  /** 检查对象是否存在 */
  async objectExists(key: string): Promise<boolean> {
    const response = await this.request("HEAD", key);
    return response.status === 200;
  }

  /** 列出指定前缀的对象 */
  async listObjects(prefix: string, maxKeys = 1000): Promise<Array<{ key: string; lastModified: string }>> {
    const response = await this.request("GET", "", {
      queryParams: { "list-type": "2", prefix, "max-keys": String(maxKeys) }
    });
    if (response.status !== 200) {
      throw new Error(`S3 list failed (HTTP ${response.status}): ${response.body}`);
    }
    try {
      const contents = response.body.match(/<Contents>[\s\S]*?<\/Contents>/gu) ?? [];
      return contents.map((item) => {
        const keyMatch = item.match(/<Key>(.*?)<\/Key>/u);
        const dateMatch = item.match(/<LastModified>(.*?)<\/LastModified>/u);
        return { key: keyMatch?.[1] ?? "", lastModified: dateMatch?.[1] ?? "" };
      });
    } catch {
      return [];
    }
  }

  /** 删除对象 */
  async deleteObject(key: string): Promise<void> {
    const response = await this.request("DELETE", key);
    if (response.status !== 204 && response.status !== 200) {
      throw new Error(`S3 delete failed (HTTP ${response.status}): ${response.body}`);
    }
  }
}

// --- S3 备份管理器 ---

export class S3BackupManager {
  private readonly database: Database;
  private readonly vault: CredentialVault;
  private readonly databasePath: string;
  private readonly attachmentDirectory: string;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    database: Database,
    vault: CredentialVault,
    databasePath: string,
    attachmentDirectory: string
  ) {
    this.database = database;
    this.vault = vault;
    this.databasePath = databasePath;
    this.attachmentDirectory = attachmentDirectory;
  }

  // --- 配置 CRUD ---

  /** 列出所有备份配置（不含密钥） */
  listConfigs(): S3BackupConfig[] {
    const rows = this.database.all<StoredS3BackupConfig>(
      "SELECT * FROM s3_backup_configs ORDER BY created_at"
    );
    return rows.map((row) => this.toPublicConfig(row));
  }

  /** 获取单个配置 */
  getConfig(id: string): S3BackupConfig | undefined {
    const row = this.database.get<StoredS3BackupConfig>(
      "SELECT * FROM s3_backup_configs WHERE id = ?", id
    );
    return row ? this.toPublicConfig(row) : undefined;
  }

  /** 获取解密后的 secretAccessKey（仅用于备份执行） */
  private decryptSecretKey(row: StoredS3BackupConfig): string {
    try {
      return this.vault.decrypt({
        encrypted: row.encrypted_secret_key,
        iv: row.secret_key_iv,
        tag: row.secret_key_tag
      });
    } catch {
      return "";
    }
  }

  private toPublicConfig(row: StoredS3BackupConfig): S3BackupConfig {
    return {
      id: row.id,
      name: row.name,
      endpoint: row.endpoint,
      region: row.region,
      bucket: row.bucket,
      subdirectory: row.subdirectory ?? "",
      accessKeyId: row.access_key_id,
      includeImages: Boolean(row.include_images),
      scheduleEnabled: Boolean(row.schedule_enabled),
      scheduleHour: Number(row.schedule_hour),
      scheduleMinute: Number(row.schedule_minute),
      retentionCount: Number(row.retention_count),
      enabled: Boolean(row.enabled),
      lastBackupAt: row.last_backup_at,
      lastBackupStatus: row.last_backup_status,
      lastBackupError: row.last_backup_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /** 创建备份配置 */
  createConfig(input: S3BackupConfigInput): S3BackupConfig {
    const id = randomUUID();
    const now = new Date().toISOString();
    const encrypted = this.vault.encrypt(input.secretAccessKey);

    this.database.run(
      `INSERT INTO s3_backup_configs (id, name, endpoint, region, bucket, subdirectory, access_key_id, encrypted_secret_key, secret_key_iv, secret_key_tag, secret_key_hint, include_images, schedule_enabled, schedule_hour, schedule_minute, retention_count, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.endpoint,
      input.region ?? "us-east-1",
      input.bucket,
      input.subdirectory ?? "",
      input.accessKeyId,
      encrypted.encrypted,
      encrypted.iv,
      encrypted.tag,
      input.accessKeyId.slice(0, 6),
      input.includeImages !== false ? 1 : 0,
      input.scheduleEnabled === true ? 1 : 0,
      input.scheduleHour ?? 3,
      input.scheduleMinute ?? 0,
      input.retentionCount ?? 7,
      input.enabled !== false ? 1 : 0,
      now,
      now
    );

    logger.info("s3_backup.config_created", { configId: id, name: input.name });
    return this.getConfig(id)!;
  }

  /** 更新备份配置 */
  updateConfig(id: string, input: S3BackupConfigUpdate): S3BackupConfig {
    const existing = this.getConfig(id);
    if (!existing) throw new AppError(404, "S3_BACKUP_CONFIG_NOT_FOUND", "备份配置不存在");

    const now = new Date().toISOString();
    const clauses: string[] = ["updated_at = ?"];
    const params: SQLInputValue[] = [now];

    if (input.name !== undefined) { clauses.push("name = ?"); params.push(input.name); }
    if (input.endpoint !== undefined) { clauses.push("endpoint = ?"); params.push(input.endpoint); }
    if (input.region !== undefined) { clauses.push("region = ?"); params.push(input.region); }
    if (input.bucket !== undefined) { clauses.push("bucket = ?"); params.push(input.bucket); }
    if (input.subdirectory !== undefined) { clauses.push("subdirectory = ?"); params.push(input.subdirectory); }
    if (input.accessKeyId !== undefined) { clauses.push("access_key_id = ?"); params.push(input.accessKeyId); }
    if (input.secretAccessKey !== undefined) {
      const encrypted = this.vault.encrypt(input.secretAccessKey);
      clauses.push("encrypted_secret_key = ?"); params.push(encrypted.encrypted);
      clauses.push("secret_key_iv = ?"); params.push(encrypted.iv);
      clauses.push("secret_key_tag = ?"); params.push(encrypted.tag);
    }
    if (input.includeImages !== undefined) { clauses.push("include_images = ?"); params.push(input.includeImages ? 1 : 0); }
    if (input.scheduleEnabled !== undefined) { clauses.push("schedule_enabled = ?"); params.push(input.scheduleEnabled ? 1 : 0); }
    if (input.scheduleHour !== undefined) { clauses.push("schedule_hour = ?"); params.push(input.scheduleHour); }
    if (input.scheduleMinute !== undefined) { clauses.push("schedule_minute = ?"); params.push(input.scheduleMinute); }
    if (input.retentionCount !== undefined) { clauses.push("retention_count = ?"); params.push(input.retentionCount); }
    if (input.enabled !== undefined) { clauses.push("enabled = ?"); params.push(input.enabled ? 1 : 0); }

    params.push(id);
    this.database.run(
      `UPDATE s3_backup_configs SET ${clauses.join(", ")} WHERE id = ?`,
      ...params
    );

    logger.info("s3_backup.config_updated", { configId: id });
    return this.getConfig(id)!;
  }

  /** 删除备份配置 */
  deleteConfig(id: string): void {
    const existing = this.getConfig(id);
    if (!existing) throw new AppError(404, "S3_BACKUP_CONFIG_NOT_FOUND", "备份配置不存在");
    this.database.run("DELETE FROM s3_backup_configs WHERE id = ?", id);
    logger.info("s3_backup.config_deleted", { configId: id });
  }

  // --- 备份执行 ---

  /** 执行单个配置的备份 */
  async executeBackup(configId: string): Promise<{ success: boolean; error?: string }> {
    const row = this.database.get<StoredS3BackupConfig>(
      "SELECT * FROM s3_backup_configs WHERE id = ?", configId
    );
    if (!row) return { success: false, error: "备份配置不存在" };
    if (!row.enabled) return { success: false, error: "备份配置已禁用" };

    const config = this.toPublicConfig(row);
    const secretAccessKey = this.decryptSecretKey(row);

    this.database.run(
      "UPDATE s3_backup_configs SET last_backup_status = ?, updated_at = ? WHERE id = ?",
      "running", new Date().toISOString(), configId
    );

    try {
      const client = new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        accessKeyId: config.accessKeyId,
        secretAccessKey,
        bucket: config.bucket,
        subdirectory: config.subdirectory
      });

      // 备份数据库
      logger.info("s3_backup.db_backup_started", { configId, name: config.name });
      await this.backupDatabase(client, config.subdirectory);

      // 备份图片
      if (config.includeImages) {
        logger.info("s3_backup.image_backup_started", { configId, name: config.name });
        await this.backupImages(client);
      }

      // 清理旧备份
      if (config.retentionCount > 0) {
        await this.cleanupOldBackups(client, config.subdirectory, config.retentionCount);
      }

      const now = new Date().toISOString();
      this.database.run(
        "UPDATE s3_backup_configs SET last_backup_status = ?, last_backup_at = ?, last_backup_error = NULL, updated_at = ? WHERE id = ?",
        "success", now, now, configId
      );

      logger.info("s3_backup.completed", { configId, name: config.name });
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const now = new Date().toISOString();
      this.database.run(
        "UPDATE s3_backup_configs SET last_backup_status = ?, last_backup_error = ?, updated_at = ? WHERE id = ?",
        "failed", errorMessage, now, configId
      );
      // 完整打印 S3 配置（ak 和 sk 脱敏）和错误
      logger.error("s3_backup.failed", {
        configId: config.id,
        name: config.name,
        endpoint: config.endpoint,
        region: config.region,
        bucket: config.bucket,
        subdirectory: config.subdirectory,
        accessKeyId: "[REDACTED]",
        error: sanitizeError(error)
      });
      return { success: false, error: errorMessage };
    }
  }

  /** 备份数据库到 /scriverse/db/ */
  private async backupDatabase(client: S3Client, subdirectory: string): Promise<void> {
    // WAL checkpoint 确保数据持久化到主数据库文件
    try {
      this.database.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // 内存数据库等场景忽略
    }

    if (this.databasePath === ":memory:" || !existsSync(this.databasePath)) {
      throw new Error("数据库文件不存在或为内存数据库，无法备份");
    }

    const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const dbFileName = `scriverse-db-${timestamp}.db`;

    // 使用 VACUUM INTO 创建事务一致性副本
    const tempPath = join(
      this.attachmentDirectory,
      "..",
      `.s3-backup-${randomUUID()}.db`
    );

    try {
      this.database.raw.exec(`VACUUM INTO '${tempPath.replace(/'/gu, "''")}'`);
    } catch (vacuumError) {
      logger.warn("s3_backup.vacuum_into_failed", { error: sanitizeError(vacuumError) });
      throw new Error(`Database VACUUM INTO failed: ${sanitizeError(vacuumError).message ?? "unknown error"}`);
    }

    try {
      const dbBuffer = readFileSync(tempPath);
      const key = computeS3Key(subdirectory, `db/${dbFileName}`);
      await client.putObject(key, dbBuffer, "application/octet-stream");
      logger.info("s3_backup.db_uploaded", { key, byteLength: dbBuffer.length });
    } finally {
      try { unlinkSync(tempPath); } catch { /* ignore */ }
    }
  }

  /** 备份图片到 /scriverse/img/ */
  private async backupImages(client: S3Client): Promise<void> {
    if (!existsSync(this.attachmentDirectory)) {
      logger.info("s3_backup.no_attachment_directory", { directory: this.attachmentDirectory });
      return;
    }

    const allFiles = this.enumerateFiles(this.attachmentDirectory);
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;

    for (const filePath of allFiles) {
      const relativePath = filePath.slice(this.attachmentDirectory.length).replace(/^\//u, "");
      const key = computeS3Key(client.subdirectory, `img/${relativePath}`);

      try {
        const exists = await client.objectExists(key);
        if (exists) { skipped++; continue; }

        const fileBuffer = readFileSync(filePath);
        const ext = extname(filePath).toLocaleLowerCase();
        const contentType =
          ext === ".png" ? "image/png" :
          ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
          ext === ".webp" ? "image/webp" :
          ext === ".gif" ? "image/gif" :
          "application/octet-stream";

        await client.putObject(key, fileBuffer, contentType);
        uploaded++;
      } catch (error) {
        failed++;
        logger.warn("s3_backup.image_upload_failed", {
          file: relativePath, error: sanitizeError(error)
        });
      }
    }

    logger.info("s3_backup.images_completed", { uploaded, skipped, failed, total: allFiles.length });

    if (failed > 0 && uploaded === 0 && allFiles.length > 0) {
      throw new Error(`All ${allFiles.length} image uploads failed`);
    }
  }

  /** 递归枚举目录下所有文件 */
  private enumerateFiles(dir: string): string[] {
    const results: string[] = [];
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === ".tmp") continue;
          results.push(...this.enumerateFiles(fullPath));
        } else if (entry.isFile()) {
          results.push(fullPath);
        }
      }
    } catch { /* ignore */ }
    return results;
  }

  /** 清理超过保留数量的旧数据库备份 */
  private async cleanupOldBackups(
    client: S3Client,
    subdirectory: string,
    retentionCount: number
  ): Promise<void> {
    try {
      const prefix = computeS3Key(subdirectory, "db/scriverse-db-");
      const objects = await client.listObjects(prefix, 1000);
      const dbBackups = objects
        .filter((obj) => obj.key.endsWith(".db"))
        .sort((a, b) => a.key.localeCompare(b.key));

      if (dbBackups.length <= retentionCount) return;

      const toDelete = dbBackups.slice(0, dbBackups.length - retentionCount);
      for (const obj of toDelete) {
        try {
          await client.deleteObject(obj.key);
          logger.info("s3_backup.old_db_deleted", { key: obj.key });
        } catch (error) {
          logger.warn("s3_backup.old_db_delete_failed", { key: obj.key, error: sanitizeError(error) });
        }
      }
    } catch (error) {
      logger.warn("s3_backup.cleanup_failed", { error: sanitizeError(error) });
    }
  }

  // --- 调度器 ---

  /** 启动定时备份调度器（每 30 秒检查） */
  startScheduler(): void {
    if (this.schedulerTimer) return;
    logger.info("s3_backup.scheduler_started");
    this.schedulerTimer = setInterval(() => {
      if (this.running) return;
      void this.runScheduledBackups();
    }, 30_000);
    void this.runScheduledBackups();
  }

  /** 停止定时备份调度器 */
  stopScheduler(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
      logger.info("s3_backup.scheduler_stopped");
    }
  }

  /** 检查并执行定时备份 */
  private async runScheduledBackups(): Promise<void> {
    this.running = true;
    try {
      const configs = this.listConfigs().filter((c) => c.enabled && c.scheduleEnabled);
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();

      for (const config of configs) {
        const scheduledMinutes = config.scheduleHour * 60 + config.scheduleMinute;
        if (Math.abs(currentMinutes - scheduledMinutes) > 1) continue;
        if (config.lastBackupAt) {
          const minutesSince = (now.getTime() - new Date(config.lastBackupAt).getTime()) / 60_000;
          if (minutesSince < 5) continue;
        }
        logger.info("s3_backup.scheduled_run", { configId: config.id, name: config.name });
        await this.executeBackup(config.id);
      }
    } catch (error) {
      logger.error("s3_backup.scheduler_error", { error: sanitizeError(error) });
    } finally {
      this.running = false;
    }
  }
}
