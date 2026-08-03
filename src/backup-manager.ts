import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CredentialVault } from "./credential-vault.js";
import { AppError } from "./errors.js";
import { logger, sanitizeError } from "./logger.js";
import {
  buildScriverseObjectKey,
  formatBackupTimestamp,
  publicS3Config,
  s3DeleteObject,
  s3HeadObject,
  s3ListObjects,
  s3PutObject,
  s3TestConnection,
  type S3ClientConfig,
  type S3RequestFailureContext
} from "./s3-client.js";
import { assertSafeAiEndpoint } from "./security.js";
import type { Store } from "./store.js";
import { id, maskSecret, now } from "./utils.js";

export type BackupScheduleSettings = {
  enabled: boolean;
  scheduleTime: string;
  retentionCount: number;
  includeImages: boolean;
  lastRunAt: string | null;
  lastRunStatus: "idle" | "running" | "success" | "failed";
  lastRunError: string;
  lastRunSummary: Record<string, unknown> | null;
  updatedAt: string;
};

export type BackupTargetInput = {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey?: string;
  pathPrefix?: string;
  enabled?: boolean;
  forcePathStyle?: boolean;
  sortOrder?: number;
};

export type BackupTargetPublic = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKeyHint: string;
  pathPrefix: string;
  enabled: boolean;
  forcePathStyle: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type BackupRunResult = {
  startedAt: string;
  finishedAt: string;
  status: "success" | "failed";
  includeImages: boolean;
  targets: Array<Record<string, unknown>>;
  error?: string;
};

type BackupManagerOptions = {
  store: Store;
  vault: CredentialVault;
  databasePath: string;
  attachmentDirectory: string;
  dataDirectory: string;
  fetchImpl?: typeof fetch;
  allowPrivateEndpoints?: boolean;
  validateEndpoint?: (url: string) => Promise<unknown>;
};

function isScheduleTime(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/u.test(value);
}

function mimeFromStorageKey(storageKey: string): string {
  const extension = storageKey.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  return "image/webp";
}

function walkFiles(rootDirectory: string): string[] {
  if (!existsSync(rootDirectory)) return [];
  const files: string[] = [];
  const stack = [rootDirectory];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".tmp") continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  return files.sort();
}

export function nextScheduleDelayMs(scheduleTime: string, from = new Date()): number {
  if (!isScheduleTime(scheduleTime)) throw new AppError(400, "INVALID_BACKUP_SCHEDULE", "备份触发时间必须是 HH:MM 格式");
  const [hourText, minuteText] = scheduleTime.split(":");
  const target = new Date(from.getTime());
  target.setSeconds(0, 0);
  target.setHours(Number(hourText), Number(minuteText), 0, 0);
  if (target.getTime() <= from.getTime()) target.setDate(target.getDate() + 1);
  return Math.max(1_000, target.getTime() - from.getTime());
}

export class BackupManager {
  private readonly store: Store;
  private readonly vault: CredentialVault;
  private readonly databasePath: string;
  private readonly attachmentDirectory: string;
  private readonly dataDirectory: string;
  private readonly fetchImpl: typeof fetch;
  private readonly allowPrivateEndpoints: boolean;
  private readonly validateEndpoint?: (url: string) => Promise<unknown>;
  private scheduleTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<BackupRunResult> | null = null;
  private disposed = false;

  constructor(options: BackupManagerOptions) {
    this.store = options.store;
    this.vault = options.vault;
    this.databasePath = options.databasePath;
    this.attachmentDirectory = options.attachmentDirectory;
    this.dataDirectory = options.dataDirectory;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.allowPrivateEndpoints = options.allowPrivateEndpoints === true;
    this.validateEndpoint = options.validateEndpoint;
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = null;
      this.reschedule();
    }, 0);
  }

  dispose(): void {
    this.disposed = true;
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }

  getSettings(): BackupScheduleSettings {
    return this.store.getPlatformBackupSettings();
  }

  updateSettings(input: {
    enabled?: boolean;
    scheduleTime?: string;
    retentionCount?: number;
    includeImages?: boolean;
  }): BackupScheduleSettings {
    if (input.scheduleTime !== undefined && !isScheduleTime(input.scheduleTime)) {
      throw new AppError(400, "INVALID_BACKUP_SCHEDULE", "备份触发时间必须是 HH:MM 格式");
    }
    if (input.retentionCount !== undefined && (!Number.isInteger(input.retentionCount) || input.retentionCount < 1 || input.retentionCount > 100)) {
      throw new AppError(400, "INVALID_BACKUP_RETENTION", "备份留存个数必须是 1 到 100 之间的整数");
    }
    const updated = this.store.updatePlatformBackupSettings(input);
    this.reschedule();
    return updated;
  }

  listTargets(): BackupTargetPublic[] {
    return this.store.listPlatformBackupTargets().map((row) => this.mapTarget(row));
  }

  getTarget(targetId: string): BackupTargetPublic {
    return this.mapTarget(this.store.getPlatformBackupTargetRow(targetId));
  }

  async createTarget(input: BackupTargetInput): Promise<BackupTargetPublic> {
    if (!input.secretAccessKey?.trim()) {
      throw new AppError(400, "SECRET_ACCESS_KEY_REQUIRED", "创建备份目标时必须提供 Secret Access Key");
    }
    await this.assertEndpointSafe(input.endpoint);
    const encrypted = this.vault.encrypt(input.secretAccessKey);
    const targetId = id("backup-target");
    const timestamp = now();
    this.store.createPlatformBackupTarget({
      id: targetId,
      name: input.name.trim(),
      endpoint: this.normalizeEndpoint(input.endpoint),
      region: input.region.trim() || "us-east-1",
      bucket: input.bucket.trim(),
      accessKeyId: input.accessKeyId.trim(),
      encryptedSecretKey: encrypted.encrypted,
      secretKeyIv: encrypted.iv,
      secretKeyTag: encrypted.tag,
      secretKeyHint: maskSecret(input.secretAccessKey),
      pathPrefix: this.normalizePathPrefix(input.pathPrefix ?? ""),
      enabled: input.enabled !== false,
      forcePathStyle: input.forcePathStyle !== false,
      sortOrder: input.sortOrder ?? this.store.nextPlatformBackupTargetSortOrder(),
      createdAt: timestamp,
      updatedAt: timestamp
    });
    return this.getTarget(targetId);
  }

  async updateTarget(targetId: string, input: Partial<BackupTargetInput>): Promise<BackupTargetPublic> {
    const row = this.store.getPlatformBackupTargetRow(targetId);
    const endpoint = input.endpoint ? this.normalizeEndpoint(input.endpoint) : String(row.endpoint);
    if (input.endpoint) await this.assertEndpointSafe(endpoint);
    let encryptedSecretKey = String(row.encrypted_secret_key);
    let secretKeyIv = String(row.secret_key_iv);
    let secretKeyTag = String(row.secret_key_tag);
    let secretKeyHint = String(row.secret_key_hint);
    if (input.secretAccessKey?.trim()) {
      const encrypted = this.vault.encrypt(input.secretAccessKey);
      encryptedSecretKey = encrypted.encrypted;
      secretKeyIv = encrypted.iv;
      secretKeyTag = encrypted.tag;
      secretKeyHint = maskSecret(input.secretAccessKey);
    }
    this.store.updatePlatformBackupTarget(targetId, {
      name: input.name?.trim() ?? String(row.name),
      endpoint,
      region: input.region?.trim() || String(row.region),
      bucket: input.bucket?.trim() || String(row.bucket),
      accessKeyId: input.accessKeyId?.trim() || String(row.access_key_id),
      encryptedSecretKey,
      secretKeyIv,
      secretKeyTag,
      secretKeyHint,
      pathPrefix: input.pathPrefix !== undefined ? this.normalizePathPrefix(input.pathPrefix) : String(row.path_prefix),
      enabled: input.enabled ?? Number(row.enabled) === 1,
      forcePathStyle: input.forcePathStyle ?? Number(row.force_path_style) === 1,
      sortOrder: input.sortOrder ?? Number(row.sort_order),
      updatedAt: now()
    });
    return this.getTarget(targetId);
  }

  deleteTarget(targetId: string): void {
    this.store.deletePlatformBackupTarget(targetId);
  }

  async testTarget(targetId: string): Promise<{ ok: true }> {
    const credentials = this.resolveTargetCredentials(targetId);
    await this.assertEndpointSafe(credentials.config.endpoint);
    await s3TestConnection(this.fetchImpl, credentials.config, credentials.failureContext);
    return { ok: true };
  }

  runNow(): Promise<BackupRunResult> {
    if (this.running) {
      throw new AppError(409, "BACKUP_ALREADY_RUNNING", "已有备份任务正在执行，请稍后再试");
    }
    this.running = this.executeBackup("manual").finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private reschedule(): void {
    if (this.disposed) return;
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    const settings = this.getSettings();
    if (!settings.enabled) return;
    const delay = nextScheduleDelayMs(settings.scheduleTime);
    logger.info("backup.schedule.next", { scheduleTime: settings.scheduleTime, delayMs: delay });
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = null;
      if (this.disposed) return;
      void this.executeBackup("scheduled")
        .catch((error) => {
          logger.error("backup.schedule.run_failed", { error: sanitizeError(error) });
        })
        .finally(() => this.reschedule());
    }, delay);
  }

  private async executeBackup(trigger: "manual" | "scheduled"): Promise<BackupRunResult> {
    const startedAt = now();
    const settings = this.getSettings();
    this.store.updatePlatformBackupRunState({
      lastRunAt: startedAt,
      lastRunStatus: "running",
      lastRunError: "",
      lastRunSummary: { trigger, startedAt }
    });
    const targetResults: Array<Record<string, unknown>> = [];
    let fatalError: string | undefined;
    try {
      const targets = this.store.listPlatformBackupTargets()
        .filter((row) => Number(row.enabled) === 1)
        .sort((left, right) => Number(left.sort_order) - Number(right.sort_order) || String(left.created_at).localeCompare(String(right.created_at)));
      if (targets.length === 0) {
        throw new AppError(400, "BACKUP_TARGET_REQUIRED", "请至少启用一个 S3 备份目标");
      }
      const snapshotPath = await this.createDatabaseSnapshot();
      try {
        for (const row of targets) {
          const credentials = this.resolveTargetRowCredentials(row);
          const summary: Record<string, unknown> = {
            targetId: credentials.failureContext.targetId,
            name: credentials.failureContext.name,
            endpoint: credentials.failureContext.endpoint,
            region: credentials.failureContext.region,
            bucket: credentials.failureContext.bucket,
            pathPrefix: credentials.failureContext.pathPrefix,
            dbUploaded: false,
            imagesUploaded: 0,
            imagesSkipped: 0,
            dbDeleted: 0
          };
          try {
            await this.assertEndpointSafe(credentials.config.endpoint);
            const dbKey = buildScriverseObjectKey(
              credentials.failureContext.pathPrefix ?? "",
              "db",
              `novel-${formatBackupTimestamp(new Date(startedAt))}.db`
            );
            await s3PutObject(
              this.fetchImpl,
              credentials.config,
              dbKey,
              readFileSync(snapshotPath),
              "application/octet-stream",
              credentials.failureContext
            );
            summary.dbUploaded = true;
            summary.dbKey = dbKey;
            if (settings.includeImages) {
              const imageStats = await this.uploadImages(credentials.config, credentials.failureContext);
              summary.imagesUploaded = imageStats.uploaded;
              summary.imagesSkipped = imageStats.skipped;
            }
            summary.dbDeleted = await this.enforceRetention(
              credentials.config,
              credentials.failureContext,
              settings.retentionCount
            );
            targetResults.push({ ...summary, status: "success" });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error("backup.target.failed", {
              ...publicS3Config(credentials.failureContext),
              error: sanitizeError(error)
            });
            targetResults.push({ ...summary, status: "failed", error: message });
            throw error;
          }
        }
      } finally {
        rmSync(snapshotPath, { force: true });
      }
      const finishedAt = now();
      const result: BackupRunResult = {
        startedAt,
        finishedAt,
        status: "success",
        includeImages: settings.includeImages,
        targets: targetResults
      };
      this.store.updatePlatformBackupRunState({
        lastRunAt: finishedAt,
        lastRunStatus: "success",
        lastRunError: "",
        lastRunSummary: { trigger, ...result }
      });
      this.store.auditPlatformBackup("platform.backup.run.succeeded", {
        trigger,
        includeImages: settings.includeImages,
        targetCount: targetResults.length
      });
      logger.info("backup.run.succeeded", { trigger, targetCount: targetResults.length, includeImages: settings.includeImages });
      return result;
    } catch (error) {
      fatalError = error instanceof Error ? error.message : String(error);
      const finishedAt = now();
      const result: BackupRunResult = {
        startedAt,
        finishedAt,
        status: "failed",
        includeImages: settings.includeImages,
        targets: targetResults,
        error: fatalError
      };
      this.store.updatePlatformBackupRunState({
        lastRunAt: finishedAt,
        lastRunStatus: "failed",
        lastRunError: fatalError,
        lastRunSummary: { trigger, ...result }
      });
      this.store.auditPlatformBackup("platform.backup.run.failed", {
        trigger,
        error: fatalError,
        targetCount: targetResults.length
      });
      logger.error("backup.run.failed", { trigger, error: sanitizeError(error), targets: targetResults });
      if (error instanceof AppError) throw error;
      throw new AppError(502, "BACKUP_FAILED", fatalError);
    }
  }

  private async createDatabaseSnapshot(): Promise<string> {
    const backupRoot = join(this.dataDirectory, "backups", "s3-runtime");
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    const snapshotPath = join(backupRoot, `novel-${formatBackupTimestamp()}.db`);
    // 在线一致性快照：VACUUM INTO 生成独立文件，避免直接拷贝 WAL 库；内存库同样支持。
    const escaped = snapshotPath.replace(/'/gu, "''");
    this.store.db.raw.exec(`VACUUM INTO '${escaped}'`);
    return snapshotPath;
  }

  private async uploadImages(
    config: S3ClientConfig,
    failureContext: S3RequestFailureContext
  ): Promise<{ uploaded: number; skipped: number }> {
    let uploaded = 0;
    let skipped = 0;
    const files = walkFiles(this.attachmentDirectory);
    for (const absolutePath of files) {
      const relativePath = relative(this.attachmentDirectory, absolutePath).split(sep).join("/");
      if (!relativePath || relativePath.startsWith("..")) continue;
      const objectKey = buildScriverseObjectKey(failureContext.pathPrefix ?? "", "img", relativePath);
      const exists = await s3HeadObject(this.fetchImpl, config, objectKey, failureContext);
      if (exists) {
        skipped += 1;
        continue;
      }
      await s3PutObject(
        this.fetchImpl,
        config,
        objectKey,
        readFileSync(absolutePath),
        mimeFromStorageKey(relativePath),
        failureContext
      );
      uploaded += 1;
    }
    return { uploaded, skipped };
  }

  private async enforceRetention(
    config: S3ClientConfig,
    failureContext: S3RequestFailureContext,
    retentionCount: number
  ): Promise<number> {
    const prefix = buildScriverseObjectKey(failureContext.pathPrefix ?? "", "db", "");
    const objects = (await s3ListObjects(this.fetchImpl, config, prefix.endsWith("/") ? prefix : `${prefix}/`, failureContext))
      .filter((item) => item.key !== prefix && item.key !== `${prefix}/`)
      .sort((left, right) => {
        const leftTime = left.lastModified ? Date.parse(left.lastModified) : 0;
        const rightTime = right.lastModified ? Date.parse(right.lastModified) : 0;
        if (leftTime !== rightTime) return leftTime - rightTime;
        return left.key.localeCompare(right.key);
      });
    const overflow = objects.slice(0, Math.max(0, objects.length - retentionCount));
    for (const item of overflow) {
      await s3DeleteObject(this.fetchImpl, config, item.key, failureContext);
    }
    return overflow.length;
  }

  private resolveTargetCredentials(targetId: string): {
    config: S3ClientConfig;
    failureContext: S3RequestFailureContext;
  } {
    return this.resolveTargetRowCredentials(this.store.getPlatformBackupTargetRow(targetId));
  }

  private resolveTargetRowCredentials(row: Record<string, unknown>): {
    config: S3ClientConfig;
    failureContext: S3RequestFailureContext;
  } {
    const secretAccessKey = this.vault.decrypt({
      encrypted: String(row.encrypted_secret_key),
      iv: String(row.secret_key_iv),
      tag: String(row.secret_key_tag)
    });
    const failureContext: S3RequestFailureContext = {
      targetId: String(row.id),
      name: String(row.name),
      endpoint: String(row.endpoint),
      region: String(row.region),
      bucket: String(row.bucket),
      pathPrefix: String(row.path_prefix ?? ""),
      enabled: Number(row.enabled) === 1,
      forcePathStyle: Number(row.force_path_style) === 1
    };
    return {
      config: {
        endpoint: failureContext.endpoint,
        region: failureContext.region,
        bucket: failureContext.bucket,
        accessKeyId: String(row.access_key_id),
        secretAccessKey,
        forcePathStyle: failureContext.forcePathStyle
      },
      failureContext
    };
  }

  private mapTarget(row: Record<string, unknown>): BackupTargetPublic {
    return {
      id: String(row.id),
      name: String(row.name),
      endpoint: String(row.endpoint),
      region: String(row.region),
      bucket: String(row.bucket),
      accessKeyId: String(row.access_key_id),
      secretAccessKeyHint: String(row.secret_key_hint),
      pathPrefix: String(row.path_prefix ?? ""),
      enabled: Number(row.enabled) === 1,
      forcePathStyle: Number(row.force_path_style) === 1,
      sortOrder: Number(row.sort_order ?? 0),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private normalizeEndpoint(endpoint: string): string {
    const url = new URL(endpoint);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/u, "");
  }

  private normalizePathPrefix(pathPrefix: string): string {
    return pathPrefix.trim().replace(/^\/+|\/+$/gu, "").replace(/\/{2,}/gu, "/");
  }

  private async assertEndpointSafe(endpoint: string): Promise<void> {
    if (this.validateEndpoint) {
      await this.validateEndpoint(endpoint);
      return;
    }
    await assertSafeAiEndpoint(endpoint, this.allowPrivateEndpoints);
  }
}
