import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "./database.js";
import { AttachmentStorage } from "./attachment-storage.js";
import { S3Client, S3RequestError, sanitizeTargetForLog, type S3ListEntry, type S3TargetConfig } from "./s3-client.js";
import { BackupStore, type ResolvedTarget } from "./backup-store.js";
import { cronMatches, parseCron } from "./cron.js";
import { logger, sanitizeError } from "./logger.js";
import { now } from "./utils.js";

export type TargetBackupResult = {
  targetId: string;
  targetName: string;
  status: "success" | "failed";
  databaseKey: string | null;
  imageUploaded: number;
  imageSkipped: number;
  error: string | null;
};

export type BackupResult = {
  status: "success" | "partial" | "failed";
  startedAt: string;
  finishedAt: string;
  targets: TargetBackupResult[];
};

const STORAGE_KEY_PATTERN = /^[a-f0-9]{2}\/[a-f0-9]{64}\.(?:webp|png|jpe?g|gif)$/iu;

function buildPrefix(subdirectory: string): string {
  const cleaned = subdirectory.trim().replace(/^\/+|\/+$/gu, "");
  return cleaned ? `${cleaned}/scriverse` : "scriverse";
}

function buildTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function escapeSqlPath(path: string): string {
  return path.replace(/'/gu, "''");
}

export class BackupService {
  private readonly db: Database;
  private readonly store: BackupStore;
  private readonly attachmentStorage: AttachmentStorage;
  private readonly databasePath: string;
  private readonly s3Client: S3Client;
  private readonly nowFn: () => Date;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: {
    db: Database;
    store: BackupStore;
    attachmentStorage: AttachmentStorage;
    databasePath: string;
    s3Client: S3Client;
    now?: () => Date;
  }) {
    this.db = options.db;
    this.store = options.store;
    this.attachmentStorage = options.attachmentStorage;
    this.databasePath = options.databasePath;
    this.s3Client = options.s3Client;
    this.nowFn = options.now ?? (() => new Date());
  }

  // ---- 数据库快照 ----

  async testBackupTarget(targetId: string): Promise<Record<string, unknown>> {
    const row = this.store.getTargetRow(targetId);
    const target = this.store.resolveTarget(row);
    const config = this.toS3Config(target);
    try {
      await this.s3Client.listObjects(config, buildPrefix(target.subdirectory) + "/", null);
      this.store.recordTargetResult(targetId, true, null);
      return { ok: true, message: "连接成功" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "连接失败";
      this.store.recordTargetResult(targetId, false, message);
      this.logS3Failure(error, "test", null, config);
      return { ok: false, message };
    }
  }

  async createDatabaseSnapshot(): Promise<string> {
    const tempDir = mkdtempSync(join(tmpdir(), "scriverse-backup-"));
    const snapshotPath = join(tempDir, `scriverse-${buildTimestamp(this.nowFn())}.db`);
    // VACUUM INTO 生成一致快照，路径由服务端控制，转义单引号后拼接。
    this.db.raw.exec(`VACUUM INTO '${escapeSqlPath(snapshotPath)}'`);
    return snapshotPath;
  }

  // ---- 图片枚举 ----

  listAttachmentStorageKeys(): string[] {
    const root = this.attachmentStorage.rootDirectory;
    const keys: string[] = [];
    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry === ".tmp") continue;
        const full = join(dir, entry);
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
        if (isDir) {
          walk(full);
        } else {
          const relative = full.slice(root.length + 1).replace(/\\/gu, "/");
          if (STORAGE_KEY_PATTERN.test(relative)) keys.push(relative);
        }
      }
    };
    walk(root);
    return keys.sort();
  }

  // ---- 备份执行 ----

  async runBackup(): Promise<BackupResult> {
    if (this.running) {
      const ts = now();
      return { status: "failed", startedAt: ts, finishedAt: ts, targets: [{ targetId: "", targetName: "", status: "failed", databaseKey: null, imageUploaded: 0, imageSkipped: 0, error: "已有备份任务正在执行" }] };
    }
    this.running = true;
    const startedAt = this.nowFn().toISOString();
    const settings = this.store.getSettings();
    const includeImages = Boolean(settings.includeImages);
    const retentionCount = Number(settings.retentionCount ?? 0);
    const targetRows = this.store.listEnabledTargetRows();
    const results: TargetBackupResult[] = [];

    if (targetRows.length === 0) {
      this.running = false;
      const result: BackupResult = { status: "failed", startedAt, finishedAt: this.nowFn().toISOString(), targets: [{ targetId: "", targetName: "", status: "failed", databaseKey: null, imageUploaded: 0, imageSkipped: 0, error: "没有启用的备份目标" }] };
      this.store.recordBackupResult("failed", { result });
      return result;
    }

    let snapshotPath: string | null = null;
    let snapshotBuffer: Buffer | null = null;
    try {
      snapshotPath = await this.createDatabaseSnapshot();
      const { readFile } = await import("node:fs/promises");
      snapshotBuffer = await readFile(snapshotPath);
    } catch (error) {
      logger.error("backup.snapshot.failed", { error: sanitizeError(error) });
      for (const row of targetRows) {
        results.push({ targetId: String(row.id), targetName: String(row.name), status: "failed", databaseKey: null, imageUploaded: 0, imageSkipped: 0, error: "数据库快照创建失败" });
        this.store.recordTargetResult(String(row.id), false, "数据库快照创建失败");
      }
      this.cleanupSnapshot(snapshotPath);
      this.finalizeBackup(startedAt, results);
      this.running = false;
      return this.finalizeAndReturn(startedAt, results);
    }

    const imageKeys = includeImages ? this.listAttachmentStorageKeys() : [];

    for (const row of targetRows) {
      const result = await this.backupToTarget(row, snapshotBuffer!, imageKeys, includeImages, retentionCount);
      results.push(result);
      this.store.recordTargetResult(String(row.id), result.status === "success", result.error);
    }

    this.cleanupSnapshot(snapshotPath);
    this.finalizeBackup(startedAt, results);
    this.running = false;
    return this.finalizeAndReturn(startedAt, results);
  }

  private async backupToTarget(
    row: Record<string, unknown>,
    snapshotBuffer: Buffer,
    imageKeys: string[],
    includeImages: boolean,
    retentionCount: number
  ): Promise<TargetBackupResult> {
    const target = this.store.resolveTarget(row);
    const config = this.toS3Config(target);
    const prefix = buildPrefix(target.subdirectory);
    const dbKey = `${prefix}/db/${this.snapshotFileName(snapshotBuffer, target)}`;
    let imageUploaded = 0;
    let imageSkipped = 0;
    let error: string | null = null;
    let dbOk = false;

    try {
      await this.s3Client.putObject(config, dbKey, snapshotBuffer, "application/octet-stream");
      dbOk = true;
    } catch (err) {
      error = err instanceof Error ? err.message : "数据库上传失败";
      this.logS3Failure(err, "putObject", dbKey, config);
    }

    if (includeImages && dbOk) {
      const imgResult = await this.uploadImages(config, `${prefix}/img`, imageKeys);
      imageUploaded = imgResult.uploaded;
      imageSkipped = imgResult.skipped;
      if (imgResult.error) {
        error = error ?? imgResult.error;
        this.logS3Failure(imgResult.cause, "putObject-images", null, config);
      }
    }

    if (dbOk && retentionCount > 0) {
      try {
        await this.enforceRetention(config, `${prefix}/db/`, retentionCount);
      } catch (err) {
        // 留存清理失败不影响整体成功状态，但记录日志
        this.logS3Failure(err, "retention", null, config);
      }
    }

    return {
      targetId: target.id,
      targetName: target.name,
      status: dbOk ? "success" : "failed",
      databaseKey: dbOk ? dbKey : null,
      imageUploaded,
      imageSkipped,
      error
    };
  }

  private snapshotFileName(buffer: Buffer, target: ResolvedTarget): string {
    // 文件名已嵌入快照路径，从 buffer 无法取回，改用当前时间戳
    return `scriverse-${buildTimestamp(this.nowFn())}.db`;
  }

  private async uploadImages(config: S3TargetConfig, imgPrefix: string, imageKeys: string[]): Promise<{ uploaded: number; skipped: number; error: string | null; cause: unknown }> {
    let uploaded = 0;
    let skipped = 0;
    let error: string | null = null;
    let cause: unknown = null;
    const { readFile } = await import("node:fs/promises");
    for (const storageKey of imageKeys) {
      const objectKey = `${imgPrefix}/${storageKey}`;
      try {
        const exists = await this.s3Client.headObject(config, objectKey);
        if (exists) {
          skipped += 1;
          continue;
        }
        const localPath = this.attachmentStorage.path(storageKey);
        const body = await readFile(localPath);
        await this.s3Client.putObject(config, objectKey, body, "application/octet-stream");
        uploaded += 1;
      } catch (err) {
        error = err instanceof Error ? err.message : "图片上传失败";
        cause = err;
        this.logS3Failure(err, "putObject", objectKey, config);
        break;
      }
    }
    return { uploaded, skipped, error, cause };
  }

  private async enforceRetention(config: S3TargetConfig, dbPrefix: string, retentionCount: number): Promise<void> {
    const entries = await this.s3Client.listAllObjects(config, dbPrefix);
    const dbEntries = entries.filter((entry) => entry.key.startsWith(dbPrefix) && entry.key.endsWith(".db"));
    if (dbEntries.length <= retentionCount) return;
    // 按文件名（含时间戳）降序排序，保留最新的 retentionCount 个
    const sorted = [...dbEntries].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
    const toDelete = sorted.slice(retentionCount);
    for (const entry of toDelete) {
      try {
        await this.s3Client.deleteObject(config, entry.key);
      } catch (err) {
        this.logS3Failure(err, "deleteObject", entry.key, config);
      }
    }
  }

  private toS3Config(target: ResolvedTarget): S3TargetConfig {
    return {
      id: target.id,
      name: target.name,
      endpoint: target.endpoint,
      region: target.region,
      bucket: target.bucket,
      subdirectory: target.subdirectory,
      accessKeyId: target.accessKeyId,
      secretAccessKey: target.secretAccessKey,
      forcePathStyle: target.forcePathStyle
    };
  }

  private cleanupSnapshot(snapshotPath: string | null): void {
    if (!snapshotPath) return;
    try {
      rmSync(join(snapshotPath, ".."), { recursive: true, force: true });
    } catch {
      // 清理失败不影响主流程
    }
  }

  private finalizeBackup(startedAt: string, results: TargetBackupResult[]): void {
    const successCount = results.filter((r) => r.status === "success").length;
    const status = successCount === results.length ? "success" : successCount === 0 ? "failed" : "partial";
    this.store.recordBackupResult(status, { startedAt, finishedAt: now(), targets: results });
  }

  private finalizeAndReturn(startedAt: string, results: TargetBackupResult[]): BackupResult {
    const successCount = results.filter((r) => r.status === "success").length;
    const status = successCount === results.length ? "success" : successCount === 0 ? "failed" : "partial";
    return { status, startedAt, finishedAt: this.nowFn().toISOString(), targets: results };
  }

  private logS3Failure(error: unknown, operation: string, objectKey: string | null, config: S3TargetConfig): void {
    if (error instanceof S3RequestError) {
      logger.error("backup.s3.request_failed", {
        operation,
        objectKey,
        targetConfig: error.targetConfig,
        requestOperation: error.operation,
        status: error.status,
        responseHeaders: error.responseHeaders,
        responseBody: error.responseBody.slice(0, 8000)
      });
      return;
    }
    logger.error("backup.s3.error", {
      operation,
      objectKey,
      targetConfig: sanitizeTargetForLog(config),
      error: sanitizeError(error)
    });
  }

  // ---- 定时调度 ----

  startScheduler(): void {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => { void this.tick(); }, 60_000);
    logger.info("backup.scheduler.started");
  }

  stopScheduler(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
      logger.info("backup.scheduler.stopped");
    }
  }

  private async tick(): Promise<void> {
    try {
      const settings = this.store.getSettings();
      const cron = String(settings.scheduleCron ?? "").trim();
      if (!cron) return;
      let parsed;
      try {
        parsed = parseCron(cron);
      } catch (error) {
        logger.warn("backup.scheduler.invalid_cron", { cron, error: sanitizeError(error) });
        return;
      }
      if (cronMatches(parsed, this.nowFn())) {
        logger.info("backup.scheduler.triggered", { cron });
        const result = await this.runBackup();
        logger.info("backup.scheduler.completed", { status: result.status, targets: result.targets.length });
      }
    } catch (error) {
      logger.error("backup.scheduler.error", { error: sanitizeError(error) });
    }
  }
}
