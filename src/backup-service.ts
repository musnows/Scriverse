import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "./database.js";
import { PLATFORM_AI_WORK_ID } from "./database.js";
import type { Store } from "./store.js";
import { CredentialVault } from "./credential-vault.js";
import { AppError } from "./errors.js";
import { logger, sanitizeError } from "./logger.js";
import { S3Client, S3RequestError } from "./s3-client.js";
import type {
  BackupConfigClient,
  BackupConfigStored,
  BackupStatus,
  BackupTargetClient,
  BackupTargetRunResult,
  BackupTargetStored,
  BackupRunResult
} from "./backup-types.js";

export type BackupServiceOptions = {
  database: Database;
  store: Store;
  vault: CredentialVault;
  fetchImpl: typeof fetch;
  attachmentDirectory: string;
  /** 校验备份目标地址安全性（SSRF），不安全时抛出 AppError。 */
  assertSafeEndpoint: (endpoint: string) => Promise<void>;
};

const DB_FILE_PREFIX = "novel-";

function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function guessContentType(filePath: string): string {
  const lower = filePath.toLocaleLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

async function collectFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

export class BackupService {
  private readonly database: Database;
  private readonly store: Store;
  private readonly vault: CredentialVault;
  private readonly fetchImpl: typeof fetch;
  private readonly attachmentDirectory: string;
  private readonly assertSafeEndpoint: (endpoint: string) => Promise<void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly status: BackupStatus = {
    running: false,
    lastRunAt: null,
    lastFinishedAt: null,
    lastError: null,
    lastResult: null,
    nextRunAt: null
  };

  constructor(options: BackupServiceOptions) {
    this.database = options.database;
    this.store = options.store;
    this.vault = options.vault;
    this.fetchImpl = options.fetchImpl;
    this.attachmentDirectory = options.attachmentDirectory;
    this.assertSafeEndpoint = options.assertSafeEndpoint;
  }

  start(): void {
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.status.nextRunAt = null;
  }

  getStatus(): BackupStatus {
    return { ...this.status };
  }

  /** 返回可下发给前端的脱敏配置（不含明文/密文凭据）。 */
  getClientConfig(): BackupConfigClient {
    const stored = this.store.getBackupSettingsRaw();
    return {
      targets: stored.targets.map((target) => this.toClientTarget(target)),
      backupImages: stored.backupImages,
      scheduleTime: stored.scheduleTime,
      retentionCount: stored.retentionCount
    };
  }

  private toClientTarget(target: BackupTargetStored): BackupTargetClient {
    return {
      id: target.id,
      name: target.name,
      endpoint: target.endpoint,
      region: target.region,
      bucket: target.bucket,
      subdir: target.subdir,
      enabled: target.enabled,
      accessKeyId: "",
      secretAccessKey: "",
      hasAccessKeyId: Boolean(target.accessKeyId),
      hasSecretAccessKey: Boolean(target.secretAccessKey)
    };
  }

  /** 保存前端提交配置：解析/加密凭据、校验、落库、审计并重新排程。 */
  async saveClientConfig(input: BackupConfigClient): Promise<BackupConfigClient> {
    const existing = this.store.getBackupSettingsRaw();
    const existingById = new Map(existing.targets.map((target) => [target.id, target]));
    const targets: BackupTargetStored[] = [];
    for (const clientTarget of input.targets) {
      const id = clientTarget.id || randomUUID();
      const previous = existingById.get(id);
      const accessKeyId = clientTarget.accessKeyId
        ? this.vault.encrypt(clientTarget.accessKeyId)
        : (previous?.accessKeyId ?? null);
      const secretAccessKey = clientTarget.secretAccessKey
        ? this.vault.encrypt(clientTarget.secretAccessKey)
        : (previous?.secretAccessKey ?? null);
      if (clientTarget.enabled && (!accessKeyId || !secretAccessKey)) {
        throw new AppError(400, "BACKUP_INVALID_TARGET", `备份目标「${clientTarget.name || id}」已启用但缺少 accessKeyId 或 secretAccessKey`);
      }
      if (clientTarget.enabled && clientTarget.endpoint) {
        await this.assertSafeEndpoint(clientTarget.endpoint);
      }
      targets.push({
        id,
        name: clientTarget.name,
        endpoint: clientTarget.endpoint,
        region: clientTarget.region,
        bucket: clientTarget.bucket,
        subdir: clientTarget.subdir,
        enabled: clientTarget.enabled,
        accessKeyId,
        secretAccessKey
      });
    }
    const stored: BackupConfigStored = {
      targets,
      backupImages: input.backupImages,
      scheduleTime: input.scheduleTime,
      retentionCount: input.retentionCount
    };
    this.store.updateBackupSettingsRaw(stored);
    this.store.audit(PLATFORM_AI_WORK_ID, "backup.config.updated", "backup-config", "backup-config", {
      targetCount: targets.length,
      enabledCount: targets.filter((target) => target.enabled).length,
      backupImages: stored.backupImages,
      scheduleTime: stored.scheduleTime,
      retentionCount: stored.retentionCount
    });
    this.scheduleNext();
    return this.getClientConfig();
  }

  /** 立即执行一次备份（手动触发）。 */
  async triggerNow(): Promise<BackupRunResult> {
    if (this.status.running) throw new AppError(409, "BACKUP_IN_PROGRESS", "已有备份任务正在执行，请稍后再试");
    const config = this.store.getBackupSettingsRaw();
    return this.executeRun(config);
  }

  private async executeRun(config: BackupConfigStored): Promise<BackupRunResult> {
    this.status.running = true;
    const startedAt = new Date().toISOString();
    const runResult: BackupRunResult = { startedAt, finishedAt: "", targets: [], error: null };
    try {
      await this.runBackup(config, runResult);
    } catch (error) {
      runResult.error = error instanceof Error ? error.message : String(error);
      logger.error("backup.run_failed", { error: sanitizeError(error) });
    } finally {
      this.status.running = false;
      this.status.lastFinishedAt = new Date().toISOString();
      this.status.lastRunAt = startedAt;
      this.status.lastResult = runResult;
      this.status.lastError = runResult.error;
      runResult.finishedAt = this.status.lastFinishedAt;
    }
    if (runResult.error) {
      throw new AppError(500, "BACKUP_FAILED", `备份任务执行失败：${runResult.error}`);
    }
    return runResult;
  }

  private async runBackup(config: BackupConfigStored, runResult: BackupRunResult): Promise<void> {
    const snapshotPath = join(tmpdir(), `scriverse-db-${Date.now()}-${randomUUID()}.db`);
    await mkdir(dirname(snapshotPath), { recursive: true });
    try {
      this.database.raw.exec(`VACUUM INTO ${quoteSqlLiteral(snapshotPath)}`);
    } catch (error) {
      throw new AppError(500, "BACKUP_DB_SNAPSHOT_FAILED", `生成本地数据库快照失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const dbTimestamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
    const dbFileName = `${DB_FILE_PREFIX}${dbTimestamp}.db`;
    const enabledTargets = config.targets.filter((target) => target.enabled);
    try {
      for (const target of enabledTargets) {
        const targetResult: BackupTargetRunResult = {
          name: target.name,
          ok: false,
          imagesUploaded: 0,
          imagesSkipped: 0,
          databaseFile: null,
          error: null
        };
        try {
          if (!target.accessKeyId || !target.secretAccessKey) {
            throw new AppError(400, "BACKUP_INVALID_TARGET", `备份目标「${target.name}」缺少 accessKeyId 或 secretAccessKey`);
          }
          await this.assertSafeEndpoint(target.endpoint);
          const client = new S3Client(
            {
              endpoint: target.endpoint,
              region: target.region,
              bucket: target.bucket,
              accessKeyId: this.vault.decrypt(target.accessKeyId),
              secretAccessKey: this.vault.decrypt(target.secretAccessKey)
            },
            this.fetchImpl
          );
          const prefix = target.subdir ? `${target.subdir}/scriverse` : "scriverse";
          if (config.backupImages) {
            const counts = await this.syncImages(client, prefix);
            targetResult.imagesUploaded = counts.uploaded;
            targetResult.imagesSkipped = counts.skipped;
          }
          const dbContent = await readFile(snapshotPath);
          await client.putObject(`${prefix}/db/${dbFileName}`, dbContent, "application/octet-stream");
          targetResult.databaseFile = dbFileName;
          await this.applyRetention(client, `${prefix}/db/`, config.retentionCount);
          targetResult.ok = true;
        } catch (error) {
          targetResult.error = error instanceof Error ? error.message : String(error);
          this.logTargetFailure(target, error);
        } finally {
          runResult.targets.push(targetResult);
        }
      }
    } finally {
      await rm(snapshotPath, { force: true });
    }
    const failed = runResult.targets.filter((target) => !target.ok);
    if (failed.length > 0) {
      runResult.error = failed.map((target) => `「${target.name}」${target.error ?? "未知错误"}`).join("；");
    }
  }

  private async syncImages(client: S3Client, prefix: string): Promise<{ uploaded: number; skipped: number }> {
    if (!existsSync(this.attachmentDirectory)) return { uploaded: 0, skipped: 0 };
    const files = await collectFiles(this.attachmentDirectory);
    let uploaded = 0;
    let skipped = 0;
    for (const file of files) {
      const relPath = relative(this.attachmentDirectory, file).split(sep).join("/");
      const key = `${prefix}/img/${relPath}`;
      const exists = await client.headObject(key);
      if (exists) {
        skipped += 1;
        continue;
      }
      const content = await readFile(file);
      await client.putObject(key, content, guessContentType(file));
      uploaded += 1;
    }
    return { uploaded, skipped };
  }

  private async applyRetention(client: S3Client, dbPrefix: string, retentionCount: number): Promise<void> {
    const objects = await client.listObjects(dbPrefix);
    const dbFiles = objects
      .filter((object) => /novel-.*\.db$/u.test(object.key))
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    const excess = dbFiles.length - retentionCount;
    if (excess > 0) {
      const toDelete = dbFiles.slice(0, excess);
      for (const file of toDelete) {
        await client.deleteObject(file.key);
      }
      logger.info("backup.retention_cleaned", { removed: excess, kept: dbFiles.length - excess });
    }
  }

  private logTargetFailure(target: BackupTargetStored, error: unknown): void {
    const isS3 = error instanceof S3RequestError;
    logger.error("backup.target_failed", {
      target: {
        name: target.name,
        endpoint: target.endpoint,
        region: target.region,
        bucket: target.bucket,
        subdir: target.subdir,
        enabled: target.enabled
      },
      s3Status: isS3 ? error.status : 0,
      s3Body: isS3 ? error.body : "",
      error: sanitizeError(error)
    });
  }

  private computeNextRunTime(scheduleTime: string): Date | null {
    const match = /^(\d{1,2}):(\d{2})$/u.exec(scheduleTime);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next;
  }

  private scheduleNext(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const config = this.store.getBackupSettingsRaw();
    const next = this.computeNextRunTime(config.scheduleTime);
    if (!next) {
      this.status.nextRunAt = null;
      return;
    }
    const delay = Math.max(0, next.getTime() - Date.now());
    this.status.nextRunAt = next.toISOString();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.executeRun(this.store.getBackupSettingsRaw()).catch(() => undefined);
      this.scheduleNext();
    }, delay);
    this.timer.unref?.();
  }
}
