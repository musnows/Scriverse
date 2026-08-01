import { S3Client, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CredentialVault, EncryptedSecret } from "./credential-vault.js";
import type { Database } from "./database.js";
import { AppError } from "./errors.js";
import { logger, sanitizeError } from "./logger.js";

export type S3BackupTarget = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type BackupSettings = {
  includeImages: boolean;
  scheduleHour: number;
  scheduleMinute: number;
  retentionCount: number;
  updatedAt: string;
};

export type BackupResult = {
  targetId: string;
  targetName: string;
  success: boolean;
  databaseUploaded: boolean;
  imagesUploaded: number;
  imagesSkipped: number;
  deletedOldBackups: number;
  error?: string;
};

type TargetRow = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  access_key_id_encrypted: string;
  access_key_iv: string;
  access_key_tag: string;
  secret_access_key_encrypted: string;
  secret_key_iv: string;
  secret_key_tag: string;
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

function rowToTarget(row: TargetRow): S3BackupTarget {
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    prefix: row.prefix,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function resolveBasePrefix(prefix: string): string {
  const cleaned = prefix.replace(/^\/+|\/+$/gu, "");
  return cleaned ? `${cleaned}/scriverse` : "scriverse";
}

export class S3BackupService {
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;
  private lastTriggeredDate: string | null = null;

  constructor(
    private readonly db: Database,
    private readonly vault: CredentialVault,
    private readonly databasePath: string,
    private readonly attachmentDirectory: string
  ) {}

  listTargets(): S3BackupTarget[] {
    const rows = this.db.all<TargetRow>("SELECT * FROM s3_backup_targets ORDER BY sort_order ASC, created_at ASC");
    return rows.map(rowToTarget);
  }

  getTarget(id: string): S3BackupTarget {
    const row = this.db.get<TargetRow>("SELECT * FROM s3_backup_targets WHERE id = ?", id);
    if (!row) throw new AppError(404, "BACKUP_TARGET_NOT_FOUND", "备份目标不存在");
    return rowToTarget(row);
  }

  createTarget(input: {
    name: string;
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    accessKeyId: string;
    secretAccessKey: string;
    enabled: boolean;
  }): S3BackupTarget {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const akEncrypted = this.vault.encrypt(input.accessKeyId);
    const skEncrypted = this.vault.encrypt(input.secretAccessKey);
    const maxOrder = this.db.get<{ max_order: number }>("SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM s3_backup_targets");
    const sortOrder = Number(maxOrder?.max_order ?? 0) + 1;
    this.db.run(
      `INSERT INTO s3_backup_targets (id, name, endpoint, region, bucket, prefix, access_key_id_encrypted, access_key_iv, access_key_tag, secret_access_key_encrypted, secret_key_iv, secret_key_tag, enabled, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.name, input.endpoint, input.region, input.bucket, input.prefix,
      akEncrypted.encrypted, akEncrypted.iv, akEncrypted.tag,
      skEncrypted.encrypted, skEncrypted.iv, skEncrypted.tag,
      input.enabled ? 1 : 0, sortOrder, timestamp, timestamp
    );
    return this.getTarget(id);
  }

  updateTarget(id: string, input: {
    name?: string;
    endpoint?: string;
    region?: string;
    bucket?: string;
    prefix?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    enabled?: boolean;
  }): S3BackupTarget {
    const existing = this.db.get<TargetRow>("SELECT * FROM s3_backup_targets WHERE id = ?", id);
    if (!existing) throw new AppError(404, "BACKUP_TARGET_NOT_FOUND", "备份目标不存在");
    const timestamp = new Date().toISOString();
    let akEncrypted: EncryptedSecret | null = null;
    let skEncrypted: EncryptedSecret | null = null;
    if (input.accessKeyId) akEncrypted = this.vault.encrypt(input.accessKeyId);
    if (input.secretAccessKey) skEncrypted = this.vault.encrypt(input.secretAccessKey);
    this.db.run(
      `UPDATE s3_backup_targets SET
        name = ?, endpoint = ?, region = ?, bucket = ?, prefix = ?,
        access_key_id_encrypted = ?, access_key_iv = ?, access_key_tag = ?,
        secret_access_key_encrypted = ?, secret_key_iv = ?, secret_key_tag = ?,
        enabled = ?, updated_at = ?
       WHERE id = ?`,
      input.name ?? existing.name,
      input.endpoint ?? existing.endpoint,
      input.region ?? existing.region,
      input.bucket ?? existing.bucket,
      input.prefix ?? existing.prefix,
      akEncrypted?.encrypted ?? existing.access_key_id_encrypted,
      akEncrypted?.iv ?? existing.access_key_iv,
      akEncrypted?.tag ?? existing.access_key_tag,
      skEncrypted?.encrypted ?? existing.secret_access_key_encrypted,
      skEncrypted?.iv ?? existing.secret_key_iv,
      skEncrypted?.tag ?? existing.secret_key_tag,
      input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled,
      timestamp,
      id
    );
    return this.getTarget(id);
  }

  deleteTarget(id: string): void {
    const result = this.db.run("DELETE FROM s3_backup_targets WHERE id = ?", id);
    if (result.changes === 0) throw new AppError(404, "BACKUP_TARGET_NOT_FOUND", "备份目标不存在");
  }

  getSettings(): BackupSettings {
    const row = this.db.get<{
      include_images: number;
      schedule_hour: number;
      schedule_minute: number;
      retention_count: number;
      updated_at: string;
    }>("SELECT * FROM platform_backup_settings WHERE id = 1");
    return {
      includeImages: row?.include_images !== 0,
      scheduleHour: Number(row?.schedule_hour ?? 3),
      scheduleMinute: Number(row?.schedule_minute ?? 0),
      retentionCount: Number(row?.retention_count ?? 5),
      updatedAt: String(row?.updated_at ?? "")
    };
  }

  updateSettings(input: {
    includeImages?: boolean;
    scheduleHour?: number;
    scheduleMinute?: number;
    retentionCount?: number;
  }): BackupSettings {
    const current = this.getSettings();
    const timestamp = new Date().toISOString();
    this.db.run(
      `UPDATE platform_backup_settings SET include_images = ?, schedule_hour = ?, schedule_minute = ?, retention_count = ?, updated_at = ? WHERE id = 1`,
      (input.includeImages ?? current.includeImages) ? 1 : 0,
      input.scheduleHour ?? current.scheduleHour,
      input.scheduleMinute ?? current.scheduleMinute,
      input.retentionCount ?? current.retentionCount,
      timestamp
    );
    return this.getSettings();
  }

  private createClient(row: TargetRow): S3Client {
    const accessKeyId = this.vault.decrypt({
      encrypted: row.access_key_id_encrypted,
      iv: row.access_key_iv,
      tag: row.access_key_tag
    });
    const secretAccessKey = this.vault.decrypt({
      encrypted: row.secret_access_key_encrypted,
      iv: row.secret_key_iv,
      tag: row.secret_key_tag
    });
    return new S3Client({
      endpoint: row.endpoint,
      region: row.region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true
    });
  }

  private targetLogInfo(row: TargetRow): Record<string, unknown> {
    return {
      targetId: row.id,
      targetName: row.name,
      endpoint: row.endpoint,
      region: row.region,
      bucket: row.bucket,
      prefix: row.prefix
    };
  }

  async runBackup(): Promise<BackupResult[]> {
    const settings = this.getSettings();
    const targets = this.db.all<TargetRow>("SELECT * FROM s3_backup_targets WHERE enabled = 1 ORDER BY sort_order ASC, created_at ASC");
    const results: BackupResult[] = [];

    for (const row of targets) {
      const result = await this.backupToTarget(row, settings);
      results.push(result);
    }

    if (targets.length === 0) {
      logger.info("s3_backup.no_enabled_targets");
    }
    return results;
  }

  private async backupToTarget(row: TargetRow, settings: BackupSettings): Promise<BackupResult> {
    const logInfo = this.targetLogInfo(row);
    const basePrefix = resolveBasePrefix(row.prefix);
    const result: BackupResult = {
      targetId: row.id,
      targetName: row.name,
      success: false,
      databaseUploaded: false,
      imagesUploaded: 0,
      imagesSkipped: 0,
      deletedOldBackups: 0
    };

    let client: S3Client | null = null;
    try {
      client = this.createClient(row);

      const dbKey = await this.uploadDatabaseBackup(client, row, basePrefix);
      result.databaseUploaded = true;
      logger.info("s3_backup.database_uploaded", { ...logInfo, key: dbKey });

      if (settings.includeImages) {
        const imageResult = await this.uploadImages(client, row, basePrefix);
        result.imagesUploaded = imageResult.uploaded;
        result.imagesSkipped = imageResult.skipped;
        logger.info("s3_backup.images_completed", { ...logInfo, ...imageResult });
      }

      result.deletedOldBackups = await this.cleanupOldBackups(client, row, basePrefix, settings.retentionCount);
      result.success = true;
      logger.info("s3_backup.target_completed", { ...logInfo, ...result });
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      logger.error("s3_backup.target_failed", {
        ...logInfo,
        error: sanitizeError(error),
        s3Response: extractS3ErrorDetails(error)
      });
    } finally {
      client?.destroy();
    }
    return result;
  }

  private async uploadDatabaseBackup(client: S3Client, row: TargetRow, basePrefix: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const dbFileName = `novel-${timestamp}.db`;
    const key = `${basePrefix}/db/${dbFileName}`;

    if (this.databasePath !== ":memory:" && existsSync(this.databasePath)) {
      try {
        this.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // checkpoint 失败不阻断备份
      }
    }

    const dbBuffer = readFileSync(this.databasePath);
    await client.send(new PutObjectCommand({
      Bucket: row.bucket,
      Key: key,
      Body: dbBuffer,
      ContentType: "application/octet-stream"
    }));
    return key;
  }

  private async uploadImages(client: S3Client, row: TargetRow, basePrefix: string): Promise<{ uploaded: number; skipped: number }> {
    let uploaded = 0;
    let skipped = 0;

    if (!existsSync(this.attachmentDirectory)) return { uploaded, skipped };

    const imageFiles = this.collectImageFiles(this.attachmentDirectory);
    for (const relativePath of imageFiles) {
      const key = `${basePrefix}/img/${relativePath}`;
      try {
        await client.send(new HeadObjectCommand({ Bucket: row.bucket, Key: key }));
        skipped++;
      } catch {
        const filePath = join(this.attachmentDirectory, relativePath);
        const fileBuffer = readFileSync(filePath);
        await client.send(new PutObjectCommand({
          Bucket: row.bucket,
          Key: key,
          Body: fileBuffer,
          ContentType: resolveImageContentType(relativePath)
        }));
        uploaded++;
      }
    }
    return { uploaded, skipped };
  }

  private collectImageFiles(directory: string): string[] {
    const results: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry === ".tmp") continue;
        const fullPath = join(dir, entry);
        const relativePath = prefix ? `${prefix}/${entry}` : entry;
        try {
          const stats = statSync(fullPath);
          if (stats.isDirectory()) {
            walk(fullPath, relativePath);
          } else if (/\.(?:webp|png|jpe?g|gif)$/iu.test(entry)) {
            results.push(relativePath);
          }
        } catch {
          // 跳过无法访问的文件
        }
      }
    };
    walk(directory, "");
    return results;
  }

  private async cleanupOldBackups(client: S3Client, row: TargetRow, basePrefix: string, retentionCount: number): Promise<number> {
    const dbPrefix = `${basePrefix}/db/`;
    const listed = await client.send(new ListObjectsV2Command({
      Bucket: row.bucket,
      Prefix: dbPrefix,
      MaxKeys: 1000
    }));

    const objects = (listed.Contents ?? [])
      .filter((obj) => obj.Key && obj.Key !== dbPrefix)
      .sort((a, b) => (a.LastModified?.getTime() ?? 0) - (b.LastModified?.getTime() ?? 0));

    let deleted = 0;
    const excess = objects.length - retentionCount;
    if (excess > 0) {
      const toDelete = objects.slice(0, excess);
      for (const obj of toDelete) {
        if (!obj.Key) continue;
        await client.send(new DeleteObjectCommand({ Bucket: row.bucket, Key: obj.Key }));
        deleted++;
      }
      logger.info("s3_backup.old_backups_deleted", {
        targetId: row.id,
        targetName: row.name,
        deletedCount: deleted,
        retentionCount
      });
    }
    return deleted;
  }

  startScheduler(): void {
    if (this.scheduleTimer) return;
    this.scheduleTimer = setInterval(() => {
      this.checkAndRun();
    }, 60_000);
    logger.info("s3_backup.scheduler_started");
  }

  stopScheduler(): void {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
      logger.info("s3_backup.scheduler_stopped");
    }
  }

  private checkAndRun(): void {
    const settings = this.getSettings();
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);

    if (now.getHours() === settings.scheduleHour && now.getMinutes() === settings.scheduleMinute) {
      const triggerKey = `${todayKey}-${settings.scheduleHour}:${settings.scheduleMinute}`;
      if (this.lastTriggeredDate === triggerKey) return;
      this.lastTriggeredDate = triggerKey;
      logger.info("s3_backup.scheduled_trigger", { hour: settings.scheduleHour, minute: settings.scheduleMinute });
      void this.runBackup().catch((error) => {
        logger.error("s3_backup.scheduled_run_failed", { error: sanitizeError(error) });
      });
    }
  }

  dispose(): void {
    this.stopScheduler();
  }
}

function extractS3ErrorDetails(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return {};
  const err = error as Record<string, unknown>;
  const details: Record<string, unknown> = {};
  if (err.name) details.name = String(err.name);
  if (err.message) details.message = String(err.message);
  if (err.Code) details.code = String(err.Code);
  if (err.code) details.statusCode = String(err.code);
  if (err.$metadata && typeof err.$metadata === "object") {
    const meta = err.$metadata as Record<string, unknown>;
    details.httpStatusCode = meta.httpStatusCode;
    details.requestId = meta.requestId;
  }
  if (err.$response && typeof err.$response === "object") {
    const resp = err.$response as Record<string, unknown>;
    details.statusCode = resp.statusCode;
  }
  return details;
}

function resolveImageContentType(filePath: string): string {
  if (filePath.endsWith(".webp")) return "image/webp";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}
