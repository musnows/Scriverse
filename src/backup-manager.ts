import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { CredentialVault } from "./credential-vault.js";
import type { Database, Row } from "./database.js";
import { PLATFORM_AI_WORK_ID } from "./database.js";
import { AppError } from "./errors.js";
import { logger, sanitizeError } from "./logger.js";
import {
  dbObjectKey,
  dbObjectPrefix,
  formatBackupDbFilename,
  formatLocalDate,
  imageObjectKey,
  normalizeBackupPrefix,
  parseScheduleTime,
  selectExpiredDbObjectKeys,
  shouldTriggerSchedule
} from "./backup-paths.js";
import { S3CompatibleClient, S3RequestError, type S3ClientConfig } from "./s3-client.js";
import type { Store } from "./store.js";
import { id, maskSecret, now } from "./utils.js";

export type BackupTargetInput = {
  name: string;
  endpoint: string;
  region?: string;
  bucket: string;
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  enabled?: boolean;
  sortOrder?: number;
};

export type BackupTargetUpdateInput = {
  name?: string;
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  enabled?: boolean;
  sortOrder?: number;
};

export type BackupSettingsInput = {
  enabled?: boolean;
  includeImages?: boolean;
  scheduleTime?: string;
  retentionCount?: number;
};

export type BackupRunTrigger = "manual" | "schedule";

export type BackupTargetResult = {
  targetId: string;
  name: string;
  status: "succeeded" | "failed";
  imagesUploaded: number;
  imagesSkipped: number;
  dbObjectKey: string | null;
  deletedDbObjects: number;
  error: string | null;
};

export type BackupRunResult = {
  runId: string;
  trigger: BackupRunTrigger;
  status: "succeeded" | "failed" | "partial";
  includeImages: boolean;
  startedAt: string;
  finishedAt: string;
  targets: BackupTargetResult[];
  errorMessage: string | null;
};

function requiredString(row: Row, key: string): string {
  return String(row[key] ?? "");
}

function numberValue(row: Row, key: string): number {
  return Number(row[key] ?? 0);
}

function publicTarget(row: Row): Record<string, unknown> {
  return {
    id: requiredString(row, "id"),
    name: requiredString(row, "name"),
    endpoint: requiredString(row, "endpoint"),
    region: requiredString(row, "region"),
    bucket: requiredString(row, "bucket"),
    prefix: requiredString(row, "prefix"),
    accessKeyHint: requiredString(row, "access_key_hint"),
    forcePathStyle: numberValue(row, "force_path_style") === 1,
    enabled: numberValue(row, "enabled") === 1,
    sortOrder: numberValue(row, "sort_order"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at")
  };
}

function sanitizeTargetForLog(row: Row | Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    endpoint: String(row.endpoint ?? ""),
    region: String(row.region ?? ""),
    bucket: String(row.bucket ?? ""),
    prefix: String(row.prefix ?? ""),
    forcePathStyle: row.force_path_style !== undefined
      ? Number(row.force_path_style) === 1
      : row.forcePathStyle === true,
    enabled: row.enabled !== undefined
      ? (typeof row.enabled === "boolean" ? row.enabled : Number(row.enabled) === 1)
      : true,
    sortOrder: Number(row.sort_order ?? row.sortOrder ?? 0)
  };
}

function normalizeEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new AppError(400, "BACKUP_ENDPOINT_REQUIRED", "请填写 S3 Endpoint");
  if (trimmed.length > 500) throw new AppError(400, "BACKUP_ENDPOINT_INVALID", "S3 Endpoint 过长");
  const withProtocol = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new AppError(400, "BACKUP_ENDPOINT_INVALID", "S3 Endpoint 不是有效 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(400, "BACKUP_ENDPOINT_INVALID", "S3 Endpoint 必须使用 http 或 https");
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, "")}`;
}

function normalizeBucket(value: string): string {
  const bucket = value.trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/iu.test(bucket)) {
    throw new AppError(400, "BACKUP_BUCKET_INVALID", "S3 Bucket 名称无效");
  }
  return bucket;
}

function normalizeRegion(value: string | undefined): string {
  const region = (value ?? "us-east-1").trim() || "us-east-1";
  if (region.length > 64 || !/^[a-z0-9-]+$/iu.test(region)) {
    throw new AppError(400, "BACKUP_REGION_INVALID", "S3 Region 无效");
  }
  return region;
}

function normalizeName(value: string): string {
  const name = value.trim();
  if (!name) throw new AppError(400, "BACKUP_TARGET_NAME_REQUIRED", "请填写备份目标名称");
  if (name.length > 100) throw new AppError(400, "BACKUP_TARGET_NAME_INVALID", "备份目标名称过长");
  return name;
}

async function collectAttachmentFiles(rootDirectory: string): Promise<Array<{ storageKey: string; absolutePath: string; size: number }>> {
  const results: Array<{ storageKey: string; absolutePath: string; size: number }> = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === ".tmp" || entry.name.startsWith(".")) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const storageKey = relative(rootDirectory, absolutePath).split(sep).join("/");
      if (!/^[a-f0-9]{2}\/[a-f0-9]{64}\.(?:webp|png|jpe?g|gif)$/u.test(storageKey)) continue;
      const fileStat = await stat(absolutePath);
      results.push({ storageKey, absolutePath, size: fileStat.size });
    }
  };
  await walk(rootDirectory);
  return results;
}

async function readFileBuffer(path: string): Promise<Buffer> {
  return readFile(path);
}

export class BackupManager {
  private running: Promise<BackupRunResult> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly validateEndpoint?: (url: string) => Promise<unknown>;

  constructor(
    private readonly store: Store,
    private readonly database: Database,
    private readonly vault: CredentialVault,
    private readonly attachmentDirectory: string,
    fetchImpl: typeof fetch = fetch,
    validateEndpoint?: (url: string) => Promise<unknown>
  ) {
    this.fetchImpl = fetchImpl;
    this.validateEndpoint = validateEndpoint;
    this.ensureSettingsRow();
  }

  private async assertEndpointSafe(endpoint: string): Promise<void> {
    if (!this.validateEndpoint) return;
    await this.validateEndpoint(endpoint);
  }

  private ensureSettingsRow(): void {
    const timestamp = now();
    this.database.run(
      `INSERT INTO platform_backup_settings (id, enabled, include_images, schedule_time, retention_count, updated_at)
       VALUES (1, 0, 1, '03:00', 7, ?) ON CONFLICT(id) DO NOTHING`,
      timestamp
    );
  }

  startScheduler(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollSchedule().catch((error) => {
        logger.error("backup.schedule.poll_failed", { error: sanitizeError(error) });
      });
    }, intervalMs);
    this.timer.unref?.();
    void this.pollSchedule().catch((error) => {
      logger.error("backup.schedule.poll_failed", { error: sanitizeError(error) });
    });
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollSchedule(referenceDate = new Date()): Promise<BackupRunResult | null> {
    const settings = this.getSettings();
    if (!settings.enabled) return null;
    if (!shouldTriggerSchedule(String(settings.scheduleTime), referenceDate, settings.lastTriggeredDate as string | null)) {
      return null;
    }
    const localDate = formatLocalDate(referenceDate);
    this.database.run(
      "UPDATE platform_backup_settings SET last_triggered_date = ?, updated_at = ? WHERE id = 1",
      localDate,
      now()
    );
    logger.info("backup.schedule.triggered", { scheduleTime: settings.scheduleTime, localDate });
    return this.runBackup("schedule");
  }

  getSettings(): Record<string, unknown> {
    this.ensureSettingsRow();
    const row = this.database.get("SELECT * FROM platform_backup_settings WHERE id = 1");
    return {
      enabled: numberValue(row ?? {}, "enabled") === 1,
      includeImages: numberValue(row ?? {}, "include_images") === 1,
      scheduleTime: requiredString(row ?? { schedule_time: "03:00" }, "schedule_time") || "03:00",
      retentionCount: Math.max(1, numberValue(row ?? { retention_count: 7 }, "retention_count") || 7),
      lastTriggeredDate: row?.last_triggered_date ? String(row.last_triggered_date) : null,
      lastRunStatus: row?.last_run_status ? String(row.last_run_status) : null,
      lastRunAt: row?.last_run_at ? String(row.last_run_at) : null,
      lastRunError: row?.last_run_error ? String(row.last_run_error) : null,
      lastRunSummary: row?.last_run_summary_json
        ? (() => {
          try { return JSON.parse(String(row.last_run_summary_json)); }
          catch { return null; }
        })()
        : null,
      updatedAt: requiredString(row ?? {}, "updated_at"),
      targets: this.listTargets()
    };
  }

  updateSettings(input: BackupSettingsInput): Record<string, unknown> {
    this.ensureSettingsRow();
    const current = this.getSettings();
    const enabled = input.enabled ?? Boolean(current.enabled);
    const includeImages = input.includeImages ?? Boolean(current.includeImages);
    const scheduleTime = input.scheduleTime ? (() => {
      parseScheduleTime(input.scheduleTime);
      return input.scheduleTime.trim();
    })() : String(current.scheduleTime);
    const retentionCount = input.retentionCount ?? Number(current.retentionCount);
    if (!Number.isInteger(retentionCount) || retentionCount < 1 || retentionCount > 365) {
      throw new AppError(400, "BACKUP_RETENTION_INVALID", "备份留存个数须为 1–365 的整数");
    }
    const timestamp = now();
    this.database.transaction(() => {
      this.database.run(
        `UPDATE platform_backup_settings
         SET enabled = ?, include_images = ?, schedule_time = ?, retention_count = ?, updated_at = ?
         WHERE id = 1`,
        enabled ? 1 : 0,
        includeImages ? 1 : 0,
        scheduleTime,
        retentionCount,
        timestamp
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup-settings.updated", "platform-backup-settings", "platform-backup-settings", {
        enabled,
        includeImages,
        scheduleTime,
        retentionCount
      });
    });
    return this.getSettings();
  }

  listTargets(): Record<string, unknown>[] {
    return this.database.all(
      "SELECT * FROM platform_backup_targets ORDER BY sort_order ASC, created_at ASC"
    ).map((row) => publicTarget(row));
  }

  getTarget(targetId: string): Record<string, unknown> {
    return publicTarget(this.getTargetRow(targetId));
  }

  async createTarget(input: BackupTargetInput): Promise<Record<string, unknown>> {
    const targetId = id("backup-target");
    const timestamp = now();
    const accessKeyId = input.accessKeyId.trim();
    const secretAccessKey = input.secretAccessKey.trim();
    if (!accessKeyId || !secretAccessKey) {
      throw new AppError(400, "BACKUP_CREDENTIALS_REQUIRED", "请填写 Access Key 与 Secret Key");
    }
    if (accessKeyId.length > 200 || secretAccessKey.length > 500) {
      throw new AppError(400, "BACKUP_CREDENTIALS_INVALID", "Access Key 或 Secret Key 过长");
    }
    const endpoint = normalizeEndpoint(input.endpoint);
    await this.assertEndpointSafe(endpoint);
    const encryptedAccess = this.vault.encrypt(accessKeyId);
    const encryptedSecret = this.vault.encrypt(secretAccessKey);
    const sortOrder = input.sortOrder ?? (this.listTargets().length + 1);
    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO platform_backup_targets (
          id, name, endpoint, region, bucket, prefix,
          access_key_encrypted, access_key_iv, access_key_tag,
          secret_key_encrypted, secret_key_iv, secret_key_tag,
          access_key_hint, force_path_style, enabled, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        targetId,
        normalizeName(input.name),
        endpoint,
        normalizeRegion(input.region),
        normalizeBucket(input.bucket),
        normalizeBackupPrefix(input.prefix),
        encryptedAccess.encrypted,
        encryptedAccess.iv,
        encryptedAccess.tag,
        encryptedSecret.encrypted,
        encryptedSecret.iv,
        encryptedSecret.tag,
        maskSecret(accessKeyId),
        input.forcePathStyle === false ? 0 : 1,
        input.enabled === false ? 0 : 1,
        sortOrder,
        timestamp,
        timestamp
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup-target.created", "platform-backup-target", targetId, {
        name: normalizeName(input.name),
        endpoint,
        bucket: normalizeBucket(input.bucket)
      });
    });
    return this.getTarget(targetId);
  }

  async updateTarget(targetId: string, input: BackupTargetUpdateInput): Promise<Record<string, unknown>> {
    const row = this.getTargetRow(targetId);
    const timestamp = now();
    const endpoint = input.endpoint !== undefined
      ? normalizeEndpoint(input.endpoint)
      : requiredString(row, "endpoint");
    await this.assertEndpointSafe(endpoint);
    let accessEncrypted = requiredString(row, "access_key_encrypted");
    let accessIv = requiredString(row, "access_key_iv");
    let accessTag = requiredString(row, "access_key_tag");
    let accessHint = requiredString(row, "access_key_hint");
    let secretEncrypted = requiredString(row, "secret_key_encrypted");
    let secretIv = requiredString(row, "secret_key_iv");
    let secretTag = requiredString(row, "secret_key_tag");
    if (input.accessKeyId?.trim()) {
      const accessKeyId = input.accessKeyId.trim();
      if (accessKeyId.length > 200) throw new AppError(400, "BACKUP_CREDENTIALS_INVALID", "Access Key 过长");
      const encrypted = this.vault.encrypt(accessKeyId);
      accessEncrypted = encrypted.encrypted;
      accessIv = encrypted.iv;
      accessTag = encrypted.tag;
      accessHint = maskSecret(accessKeyId);
    }
    if (input.secretAccessKey?.trim()) {
      const secretAccessKey = input.secretAccessKey.trim();
      if (secretAccessKey.length > 500) throw new AppError(400, "BACKUP_CREDENTIALS_INVALID", "Secret Key 过长");
      const encrypted = this.vault.encrypt(secretAccessKey);
      secretEncrypted = encrypted.encrypted;
      secretIv = encrypted.iv;
      secretTag = encrypted.tag;
    }
    this.database.transaction(() => {
      this.database.run(
        `UPDATE platform_backup_targets SET
          name = ?, endpoint = ?, region = ?, bucket = ?, prefix = ?,
          access_key_encrypted = ?, access_key_iv = ?, access_key_tag = ?,
          secret_key_encrypted = ?, secret_key_iv = ?, secret_key_tag = ?,
          access_key_hint = ?, force_path_style = ?, enabled = ?, sort_order = ?, updated_at = ?
         WHERE id = ?`,
        input.name !== undefined ? normalizeName(input.name) : requiredString(row, "name"),
        endpoint,
        input.region !== undefined ? normalizeRegion(input.region) : requiredString(row, "region"),
        input.bucket !== undefined ? normalizeBucket(input.bucket) : requiredString(row, "bucket"),
        input.prefix !== undefined ? normalizeBackupPrefix(input.prefix) : requiredString(row, "prefix"),
        accessEncrypted,
        accessIv,
        accessTag,
        secretEncrypted,
        secretIv,
        secretTag,
        accessHint,
        input.forcePathStyle !== undefined ? (input.forcePathStyle ? 1 : 0) : numberValue(row, "force_path_style"),
        input.enabled !== undefined ? (input.enabled ? 1 : 0) : numberValue(row, "enabled"),
        input.sortOrder !== undefined ? input.sortOrder : numberValue(row, "sort_order"),
        timestamp,
        targetId
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup-target.updated", "platform-backup-target", targetId, {
        name: input.name ?? requiredString(row, "name")
      });
    });
    return this.getTarget(targetId);
  }

  deleteTarget(targetId: string): void {
    this.getTargetRow(targetId);
    this.database.transaction(() => {
      this.database.run("DELETE FROM platform_backup_targets WHERE id = ?", targetId);
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup-target.deleted", "platform-backup-target", targetId, {});
    });
  }

  getStatus(): Record<string, unknown> {
    const settings = this.getSettings();
    return {
      running: this.running !== null,
      enabled: settings.enabled,
      includeImages: settings.includeImages,
      scheduleTime: settings.scheduleTime,
      retentionCount: settings.retentionCount,
      lastRunStatus: settings.lastRunStatus,
      lastRunAt: settings.lastRunAt,
      lastRunError: settings.lastRunError,
      lastRunSummary: settings.lastRunSummary,
      targetCount: this.listTargets().length,
      enabledTargetCount: this.listTargets().filter((target) => target.enabled === true).length
    };
  }

  runBackup(trigger: BackupRunTrigger = "manual"): Promise<BackupRunResult> {
    if (this.running) {
      throw new AppError(409, "BACKUP_ALREADY_RUNNING", "已有备份任务正在执行");
    }
    const task = this.executeBackup(trigger).finally(() => {
      if (this.running === task) this.running = null;
    });
    this.running = task;
    return task;
  }

  private getTargetRow(targetId: string): Row {
    const row = this.database.get("SELECT * FROM platform_backup_targets WHERE id = ?", targetId);
    if (!row) throw new AppError(404, "BACKUP_TARGET_NOT_FOUND", "备份目标不存在");
    return row;
  }

  private decryptTargetConfig(row: Row): S3ClientConfig {
    return {
      endpoint: requiredString(row, "endpoint"),
      region: requiredString(row, "region"),
      bucket: requiredString(row, "bucket"),
      accessKeyId: this.vault.decrypt({
        encrypted: requiredString(row, "access_key_encrypted"),
        iv: requiredString(row, "access_key_iv"),
        tag: requiredString(row, "access_key_tag")
      }),
      secretAccessKey: this.vault.decrypt({
        encrypted: requiredString(row, "secret_key_encrypted"),
        iv: requiredString(row, "secret_key_iv"),
        tag: requiredString(row, "secret_key_tag")
      }),
      forcePathStyle: numberValue(row, "force_path_style") === 1
    };
  }

  private createClient(row: Row): S3CompatibleClient {
    return new S3CompatibleClient(this.decryptTargetConfig(row), this.fetchImpl);
  }

  private async createDatabaseSnapshot(filename: string): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
    const directory = await mkdtemp(join(tmpdir(), "scriverse-backup-"));
    const filePath = join(directory, filename);
    const escaped = filePath.replaceAll("'", "''");
    try {
      this.database.raw.exec(`VACUUM INTO '${escaped}'`);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return {
      filePath,
      cleanup: async () => {
        await rm(directory, { recursive: true, force: true });
      }
    };
  }

  private logS3Failure(row: Row, error: unknown): string {
    const target = sanitizeTargetForLog(row);
    if (error instanceof S3RequestError) {
      logger.error("backup.s3.request_failed", {
        target,
        operation: error.operation,
        objectKey: error.objectKey,
        status: error.status,
        responseBody: error.responseBody
      });
      return `${error.message}${error.responseBody ? `: ${error.responseBody.slice(0, 500)}` : ""}`;
    }
    logger.error("backup.s3.request_failed", {
      target,
      error: sanitizeError(error)
    });
    return error instanceof Error ? error.message : String(error);
  }

  private async syncTarget(row: Row, options: {
    includeImages: boolean;
    retentionCount: number;
    dbSnapshotPath: string;
    dbFilename: string;
    images: Array<{ storageKey: string; absolutePath: string; size: number }>;
  }): Promise<BackupTargetResult> {
    const targetId = requiredString(row, "id");
    const name = requiredString(row, "name");
    const prefix = requiredString(row, "prefix");
    const result: BackupTargetResult = {
      targetId,
      name,
      status: "succeeded",
      imagesUploaded: 0,
      imagesSkipped: 0,
      dbObjectKey: null,
      deletedDbObjects: 0,
      error: null
    };
    try {
      await this.assertEndpointSafe(requiredString(row, "endpoint"));
      const client = this.createClient(row);
      if (options.includeImages) {
        for (const image of options.images) {
          const objectKey = imageObjectKey(prefix, image.storageKey);
          const head = await client.headObject(objectKey);
          if (head.exists) {
            result.imagesSkipped += 1;
            continue;
          }
          const body = await readFileBuffer(image.absolutePath);
          const contentType = objectKey.endsWith(".png") ? "image/png"
            : objectKey.endsWith(".jpg") || objectKey.endsWith(".jpeg") ? "image/jpeg"
              : objectKey.endsWith(".gif") ? "image/gif"
                : objectKey.endsWith(".webp") ? "image/webp"
                  : "application/octet-stream";
          await client.putObject(objectKey, body, contentType);
          result.imagesUploaded += 1;
        }
      }
      const objectKey = dbObjectKey(prefix, options.dbFilename);
      const dbBody = await readFileBuffer(options.dbSnapshotPath);
      await client.putObject(objectKey, dbBody, "application/x-sqlite3");
      result.dbObjectKey = objectKey;

      const listed = await client.listObjects(dbObjectPrefix(prefix));
      const expired = selectExpiredDbObjectKeys(listed.map((item) => item.key), options.retentionCount);
      for (const expiredKey of expired) {
        await client.deleteObject(expiredKey);
        result.deletedDbObjects += 1;
      }
      logger.info("backup.target.succeeded", {
        target: sanitizeTargetForLog(row),
        imagesUploaded: result.imagesUploaded,
        imagesSkipped: result.imagesSkipped,
        dbObjectKey: result.dbObjectKey,
        deletedDbObjects: result.deletedDbObjects
      });
    } catch (error) {
      result.status = "failed";
      result.error = this.logS3Failure(row, error);
    }
    return result;
  }

  private async executeBackup(trigger: BackupRunTrigger): Promise<BackupRunResult> {
    const settings = this.getSettings();
    const includeImages = Boolean(settings.includeImages);
    const retentionCount = Number(settings.retentionCount) || 7;
    const enabledTargets = this.database.all(
      "SELECT * FROM platform_backup_targets WHERE enabled = 1 ORDER BY sort_order ASC, created_at ASC"
    );
    const runId = id("backup-run");
    const startedAt = now();
    if (enabledTargets.length === 0) {
      const finishedAt = now();
      const result: BackupRunResult = {
        runId,
        trigger,
        status: "failed",
        includeImages,
        startedAt,
        finishedAt,
        targets: [],
        errorMessage: "没有已启用的备份目标"
      };
      this.persistRunResult(result);
      logger.error("backup.run.failed", { runId, trigger, errorMessage: result.errorMessage });
      throw new AppError(400, "BACKUP_NO_TARGETS", result.errorMessage!);
    }

    logger.info("backup.run.started", {
      runId,
      trigger,
      includeImages,
      targetCount: enabledTargets.length
    });

    const dbFilename = formatBackupDbFilename(new Date(startedAt));
    const snapshot = await this.createDatabaseSnapshot(dbFilename);
    try {
      const images = includeImages ? await collectAttachmentFiles(this.attachmentDirectory) : [];
      const targets: BackupTargetResult[] = [];
      for (const row of enabledTargets) {
        targets.push(await this.syncTarget(row, {
          includeImages,
          retentionCount,
          dbSnapshotPath: snapshot.filePath,
          dbFilename,
          images
        }));
      }
      const failed = targets.filter((target) => target.status === "failed");
      const finishedAt = now();
      const result: BackupRunResult = {
        runId,
        trigger,
        status: failed.length === 0 ? "succeeded" : failed.length === targets.length ? "failed" : "partial",
        includeImages,
        startedAt,
        finishedAt,
        targets,
        errorMessage: failed.length === 0
          ? null
          : failed.map((target) => `${target.name}: ${target.error}`).join("；")
      };
      this.persistRunResult(result);
      if (result.status === "succeeded") {
        logger.info("backup.run.succeeded", { runId, trigger, targetCount: targets.length });
      } else {
        logger.error("backup.run.failed", {
          runId,
          trigger,
          status: result.status,
          errorMessage: result.errorMessage,
          targets: targets.map((target) => ({
            targetId: target.targetId,
            name: target.name,
            status: target.status,
            error: target.error
          }))
        });
      }
      if (result.status !== "succeeded") {
        throw new AppError(
          502,
          result.status === "partial" ? "BACKUP_PARTIAL_FAILURE" : "BACKUP_FAILED",
          result.errorMessage ?? "备份失败",
          { run: result }
        );
      }
      return result;
    } finally {
      await snapshot.cleanup();
    }
  }

  private persistRunResult(result: BackupRunResult): void {
    this.database.run(
      `UPDATE platform_backup_settings SET
        last_run_status = ?, last_run_at = ?, last_run_error = ?, last_run_summary_json = ?, updated_at = ?
       WHERE id = 1`,
      result.status,
      result.finishedAt,
      result.errorMessage,
      JSON.stringify({
        runId: result.runId,
        trigger: result.trigger,
        includeImages: result.includeImages,
        targets: result.targets
      }),
      now()
    );
    this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup.run", "platform-backup-run", result.runId, {
      trigger: result.trigger,
      status: result.status,
      includeImages: result.includeImages,
      targetCount: result.targets.length,
      errorMessage: result.errorMessage
    });
  }
}
