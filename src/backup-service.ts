import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.js";
import {
  formatErrorLog,
  S3Client,
  S3RequestError,
  type BackupFileResult,
  type S3Object,
  type UploadResult
} from "./s3-backup.js";
import { AttachmentStorage } from "./attachment-storage.js";
import type { Database } from "./database.js";
import { logger } from "./logger.js";

type BackupConfigWithSecrets = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  enabled: boolean;
};

type BackupSettings = {
  scheduleHour: number;
  includeImages: boolean;
  retentionCount: number;
};

type ConfigBackupResult = {
  configId: string;
  configName: string;
  success: boolean;
  databaseFile?: string;
  imageCount: number;
  skippedImages: number;
  deletedOldBackups: number;
  durationMs: number;
  error?: string;
};

export type BackupSummary = {
  triggerTime: string;
  totalConfigs: number;
  succeeded: number;
  failed: number;
  results: ConfigBackupResult[];
};

export class BackupService {
  constructor(
    private readonly attachmentStorage: AttachmentStorage,
    private readonly databasePath: string,
    private readonly store: Store
  ) {}

  async runBackup(): Promise<BackupSummary> {
    const startTime = Date.now();
    const configs = this.store.listS3BackupConfigs()
      .filter((config) => config.enabled)
      .map((config) => this.store.getS3BackupConfigWithCredentials(config.id))
      .filter((config): config is BackupConfigWithSecrets => config !== null);
    const settings = this.store.getS3BackupSettings();
    const triggerTime = new Date().toISOString();
    const results: ConfigBackupResult[] = [];
    for (const config of configs) {
      const result = await this.backupToConfig(config, settings);
      results.push(result);
    }
    const summary: BackupSummary = {
      triggerTime,
      totalConfigs: configs.length,
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results
    };
    logger.info("s3_backup.run.completed", {
      totalConfigs: summary.totalConfigs,
      succeeded: summary.succeeded,
      failed: summary.failed,
      durationMs: Date.now() - startTime
    });
    return summary;
  }

  async testConnection(configId: string): Promise<void> {
    const config = this.store.getS3BackupConfigWithCredentials(configId);
    if (!config) {
      throw new Error("配置不存在");
    }
    const client = new S3Client(config);
    try {
      await client.testConnection();
      this.store.updateS3BackupStatus(configId, "success", "连接测试成功");
    } catch (error) {
      const logPayload = formatErrorLog(error, config, "testConnection");
      logger.warn("s3_backup.connection_test.failed", logPayload);
      const message = error instanceof S3RequestError
        ? `连接失败 (${error.statusCode ?? "network"}): ${error.responseBody.slice(0, 500)}`
        : error instanceof Error ? error.message : String(error);
      this.store.updateS3BackupStatus(configId, "failed", message);
      throw error;
    }
  }

  private async backupToConfig(config: BackupConfigWithSecrets, settings: BackupSettings): Promise<ConfigBackupResult> {
    const startTime = Date.now();
    const result: ConfigBackupResult = {
      configId: config.id,
      configName: config.name,
      success: false,
      imageCount: 0,
      skippedImages: 0,
      deletedOldBackups: 0,
      durationMs: 0
    };
    const client = new S3Client(config);
    try {
      const dbResult = await this.uploadDatabase(client, config);
      result.databaseFile = dbResult.key;
      if (settings.includeImages) {
        const imageResult = await this.uploadImages(client, config);
        result.imageCount = imageResult.uploaded;
        result.skippedImages = imageResult.skipped;
      }
      const deleted = await this.cleanupOldBackups(client, config, settings.retentionCount);
      result.deletedOldBackups = deleted;
      result.success = true;
      this.store.updateS3BackupStatus(config.id, "success", `备份完成，数据库: ${dbResult.key}`);
    } catch (error) {
      const logPayload = formatErrorLog(error, config, "backup");
      logger.error("s3_backup.failed", logPayload);
      const message = error instanceof S3RequestError
        ? `备份失败 (${error.statusCode ?? "network"}): ${error.responseBody.slice(0, 500)}`
        : error instanceof Error ? error.message : String(error);
      this.store.updateS3BackupStatus(config.id, "failed", message);
      result.error = message;
    } finally {
      result.durationMs = Date.now() - startTime;
    }
    return result;
  }

  private async uploadDatabase(client: S3Client, config: BackupConfigWithSecrets): Promise<BackupFileResult> {
    const dbBuffer = readFileSync(this.databasePath);
    const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const fileName = `novel-${timestamp}.db`;
    const key = `${config.prefix ? `${config.prefix.replace(/^\/+|\/+$/gu, "")}/` : ""}scriverse/db/${fileName}`;
    await client.uploadObject(key, dbBuffer, "application/x-sqlite3");
    return { key, size: dbBuffer.byteLength };
  }

  private async uploadImages(client: S3Client, config: BackupConfigWithSecrets): Promise<{ uploaded: number; skipped: number }> {
    const attachmentDir = this.attachmentStorage.rootDirectory;
    let uploaded = 0;
    let skipped = 0;
    let files: string[] = [];
    try {
      files = readdirSync(attachmentDir);
    } catch {
      return { uploaded, skipped };
    }
    for (const fileName of files) {
      const filePath = join(attachmentDir, fileName);
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }
      const key = `${config.prefix ? `${config.prefix.replace(/^\/+|\/+$/gu, "")}/` : ""}scriverse/img/${fileName}`;
      const exists = await client.objectExists(key);
      if (exists) {
        skipped += 1;
        continue;
      }
      const content = readFileSync(filePath);
      await client.uploadObject(key, content, "application/octet-stream");
      uploaded += 1;
    }
    return { uploaded, skipped };
  }

  private async cleanupOldBackups(client: S3Client, config: BackupConfigWithSecrets, retentionCount: number): Promise<number> {
    const prefix = `${config.prefix ? `${config.prefix.replace(/^\/+|\/+$/gu, "")}/` : ""}scriverse/db/`;
    let objects: S3Object[] = [];
    try {
      objects = await client.listObjects(prefix);
    } catch (error) {
      logger.warn("s3_backup.cleanup.list_failed", formatErrorLog(error, config, "listObjects"));
      return 0;
    }
    const dbFiles = objects
      .filter((obj) => obj.key.startsWith(prefix))
      .sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
    if (dbFiles.length <= retentionCount) return 0;
    const toDelete = dbFiles.slice(retentionCount);
    let deleted = 0;
    for (const obj of toDelete) {
      try {
        await client.deleteObject(obj.key);
        deleted += 1;
      } catch (error) {
        logger.warn("s3_backup.cleanup.delete_failed", formatErrorLog(error, config, "deleteObject"));
      }
    }
    return deleted;
  }
}

export function formatBackupResults(summary: BackupSummary): Record<string, unknown> {
  return {
    triggerTime: summary.triggerTime,
    totalConfigs: summary.totalConfigs,
    succeeded: summary.succeeded,
    failed: summary.failed,
    results: summary.results.map((r) => ({
      configId: r.configId,
      configName: r.configName,
      success: r.success,
      databaseFile: r.databaseFile,
      imageCount: r.imageCount,
      skippedImages: r.skippedImages,
      deletedOldBackups: r.deletedOldBackups,
      durationMs: r.durationMs,
      error: r.error
    }))
  };
}
