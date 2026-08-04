import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AttachmentStorage } from "./attachment-storage.js";
import type { CredentialVault } from "./credential-vault.js";
import type { Database, Row } from "./database.js";
import { PLATFORM_AI_WORK_ID } from "./database.js";
import { AppError } from "./errors.js";
import { logger, sanitizeError } from "./logger.js";
import {
  backupDatabasePrefix,
  backupImagePrefix,
  buildBackupObjectKey,
  normalizeBackupPrefix,
  S3Client,
  S3RequestError,
  type S3Credentials,
  type S3RequestSender,
  type S3TargetDescriptor
} from "./s3-client.js";
import type { Store } from "./store.js";
import { maskSecret } from "./utils.js";

/** 单个目标连续失败到该数量后停止继续上传图片，避免凭据失效时反复打无效请求。 */
const maximumConsecutiveImageFailures = 5;
/** 备份文件全部读入内存后签名，超过该体积直接失败而不是耗尽内存。 */
const maximumSnapshotByteLength = 2 * 1024 * 1024 * 1024;
const maximumRunListLimit = 100;

export type BackupTrigger = "manual" | "schedule";
export type BackupRunStatus = "running" | "success" | "partial" | "failed";

export type BackupSettings = {
  scheduleEnabled: boolean;
  scheduleTime: string;
  includeImages: boolean;
  retentionCount: number;
  updatedAt: string;
  nextRunAt: string | null;
};

export type BackupTargetInput = {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix?: string;
  forcePathStyle?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  status?: "enabled" | "disabled";
};

export type BackupTargetFailure = {
  operation: string;
  method: string;
  objectKey: string;
  httpStatus: number | null;
  s3Code: string;
  s3Message: string;
  s3RequestId: string;
  responseBody: string;
  message: string;
};

export type BackupTargetResult = {
  targetId: string;
  targetName: string;
  status: "success" | "failed";
  objectRoot: string;
  databaseUploaded: boolean;
  uploadedImageCount: number;
  skippedImageCount: number;
  failedImageCount: number;
  deletedBackupCount: number;
  error: BackupTargetFailure | null;
};

type BackupManagerOptions = {
  databasePath: string;
  dataDirectory: string;
  attachmentStorage: AttachmentStorage;
  /** 已完成 SSRF 校验与地址锁定的出站请求实现。 */
  sendRequest: S3RequestSender;
  /** 保存或测试目标时校验地址是否安全；未提供时跳过（仅测试用）。 */
  validateEndpoint?: (endpoint: string) => Promise<unknown>;
  now?: () => Date;
};

/** 计算下一次定时备份的本地时间；当天时间点已过则顺延到次日。 */
export function nextScheduledBackupAt(from: Date, scheduleTime: string): Date {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(scheduleTime);
  if (!match) throw new AppError(400, "INVALID_BACKUP_SCHEDULE", "备份时间必须是 24 小时制的 HH:MM");
  const next = new Date(from.getTime());
  next.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** 生成带时间戳的数据库备份文件名，按字典序即按时间递增。 */
export function backupDatabaseFileName(databasePath: string, at: Date): string {
  const rawName = basename(databasePath).replace(/\.db$/iu, "");
  const safeName = rawName.replace(/[^A-Za-z0-9._-]/gu, "") || "novel";
  const timestamp = at.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  return `${safeName}-${timestamp}.db`;
}

/** 按最后修改时间倒序保留指定数量，返回需要删除的历史备份键。 */
export function selectExpiredBackupKeys(
  objects: Array<{ key: string; lastModified: string }>,
  retentionCount: number
): string[] {
  return [...objects]
    .filter((object) => object.key.toLocaleLowerCase().endsWith(".db"))
    .sort((left, right) => {
      const difference = Date.parse(right.lastModified || "") - Date.parse(left.lastModified || "");
      if (Number.isFinite(difference) && difference !== 0) return difference;
      return right.key.localeCompare(left.key);
    })
    .slice(Math.max(1, retentionCount))
    .map((object) => object.key);
}

function booleanValue(row: Row | undefined, column: string, fallback = false): boolean {
  const value = row?.[column];
  return value === undefined || value === null ? fallback : Number(value) === 1;
}

function textValue(row: Row | undefined, column: string, fallback = ""): string {
  const value = row?.[column];
  return value === undefined || value === null ? fallback : String(value);
}

function failureFromError(error: unknown): BackupTargetFailure {
  if (error instanceof S3RequestError) {
    return {
      operation: error.detail.operation,
      method: error.detail.method,
      objectKey: error.detail.objectKey,
      httpStatus: error.detail.httpStatus,
      s3Code: error.detail.s3Code,
      s3Message: error.detail.s3Message,
      s3RequestId: error.detail.s3RequestId,
      responseBody: error.detail.responseBody,
      message: error.message
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    operation: "Backup",
    method: "",
    objectKey: "",
    httpStatus: null,
    s3Code: error instanceof AppError ? error.code : "BACKUP_ERROR",
    s3Message: message,
    s3RequestId: "",
    responseBody: "",
    message
  };
}

export class BackupManager {
  private scheduleTimer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    private readonly store: Store,
    private readonly vault: CredentialVault,
    private readonly options: BackupManagerOptions
  ) {
    this.now = options.now ?? (() => new Date());
  }

  getSettings(): BackupSettings {
    const row = this.db.get("SELECT * FROM backup_settings WHERE id = 1");
    const scheduleEnabled = booleanValue(row, "schedule_enabled");
    const scheduleTime = textValue(row, "schedule_time", "03:00");
    return {
      scheduleEnabled,
      scheduleTime,
      includeImages: booleanValue(row, "include_images"),
      retentionCount: Number(row?.retention_count ?? 7),
      updatedAt: textValue(row, "updated_at"),
      nextRunAt: scheduleEnabled ? nextScheduledBackupAt(this.now(), scheduleTime).toISOString() : null
    };
  }

  updateSettings(input: {
    scheduleEnabled?: boolean;
    scheduleTime?: string;
    includeImages?: boolean;
    retentionCount?: number;
  }): BackupSettings {
    const current = this.getSettings();
    const scheduleTime = input.scheduleTime ?? current.scheduleTime;
    nextScheduledBackupAt(this.now(), scheduleTime);
    const next = {
      scheduleEnabled: input.scheduleEnabled ?? current.scheduleEnabled,
      scheduleTime,
      includeImages: input.includeImages ?? current.includeImages,
      retentionCount: input.retentionCount ?? current.retentionCount
    };
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO backup_settings (id, schedule_enabled, schedule_time, include_images, retention_count, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET schedule_enabled = excluded.schedule_enabled, schedule_time = excluded.schedule_time,
           include_images = excluded.include_images, retention_count = excluded.retention_count, updated_at = excluded.updated_at`,
        next.scheduleEnabled ? 1 : 0,
        next.scheduleTime,
        next.includeImages ? 1 : 0,
        next.retentionCount,
        this.now().toISOString()
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup-settings.updated", "backup-settings", "backup-settings", next);
    });
    this.scheduleNextRun();
    return this.getSettings();
  }

  private mapTarget(row: Row): Record<string, unknown> {
    const prefix = textValue(row, "prefix");
    return {
      id: textValue(row, "id"),
      name: textValue(row, "name"),
      endpoint: textValue(row, "endpoint"),
      region: textValue(row, "region"),
      bucket: textValue(row, "bucket"),
      prefix,
      objectRoot: buildBackupObjectKey(prefix),
      forcePathStyle: booleanValue(row, "force_path_style", true),
      accessKeyId: textValue(row, "access_key_id_hint"),
      secretAccessKey: textValue(row, "secret_key_hint"),
      status: textValue(row, "status", "enabled"),
      connectionStatus: textValue(row, "connection_status", "unchecked"),
      lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
      lastCheckedAt: row.last_checked_at === null || row.last_checked_at === undefined ? null : String(row.last_checked_at),
      lastSuccessAt: row.last_success_at === null || row.last_success_at === undefined ? null : String(row.last_success_at),
      createdAt: textValue(row, "created_at"),
      updatedAt: textValue(row, "updated_at")
    };
  }

  listTargets(): Record<string, unknown>[] {
    return this.db.all("SELECT * FROM backup_targets ORDER BY sort_order, created_at, id").map((row) => this.mapTarget(row));
  }

  private requireTargetRow(targetId: string): Row {
    const row = this.db.get("SELECT * FROM backup_targets WHERE id = ?", targetId);
    if (!row) throw new AppError(404, "BACKUP_TARGET_NOT_FOUND", "备份目标不存在");
    return row;
  }

  getTarget(targetId: string): Record<string, unknown> {
    return this.mapTarget(this.requireTargetRow(targetId));
  }

  async createTarget(input: BackupTargetInput): Promise<Record<string, unknown>> {
    const prefix = normalizeBackupPrefix(input.prefix ?? "");
    await this.options.validateEndpoint?.(input.endpoint);
    const accessKey = this.vault.encrypt(input.accessKeyId);
    const secretKey = this.vault.encrypt(input.secretAccessKey);
    const timestamp = this.now().toISOString();
    const id = `bkt_${randomUUID()}`;
    const nextSortOrder = Number(this.db.get<{ next: number }>("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM backup_targets")?.next ?? 0);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO backup_targets (
          id, name, endpoint, region, bucket, prefix, force_path_style,
          encrypted_access_key_id, access_key_id_iv, access_key_id_tag, access_key_id_hint,
          encrypted_secret_key, secret_key_iv, secret_key_tag, secret_key_hint,
          status, connection_status, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unchecked', ?, ?, ?)`,
        id,
        input.name,
        input.endpoint,
        input.region,
        input.bucket,
        prefix,
        input.forcePathStyle === false ? 0 : 1,
        accessKey.encrypted,
        accessKey.iv,
        accessKey.tag,
        maskSecret(input.accessKeyId),
        secretKey.encrypted,
        secretKey.iv,
        secretKey.tag,
        maskSecret(input.secretAccessKey),
        input.status ?? "enabled",
        nextSortOrder,
        timestamp,
        timestamp
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup-target.created", "backup-target", id, {
        name: input.name,
        endpoint: input.endpoint,
        region: input.region,
        bucket: input.bucket,
        prefix
      });
    });
    logger.info("backup.target.created", { targetId: id, endpoint: input.endpoint, region: input.region, bucket: input.bucket, prefix });
    return this.getTarget(id);
  }

  async updateTarget(targetId: string, input: Partial<BackupTargetInput>): Promise<Record<string, unknown>> {
    const row = this.requireTargetRow(targetId);
    if (input.endpoint !== undefined) await this.options.validateEndpoint?.(input.endpoint);
    const prefix = input.prefix === undefined ? textValue(row, "prefix") : normalizeBackupPrefix(input.prefix);
    const timestamp = this.now().toISOString();
    const accessKey = input.accessKeyId === undefined ? null : this.vault.encrypt(input.accessKeyId);
    const secretKey = input.secretAccessKey === undefined ? null : this.vault.encrypt(input.secretAccessKey);
    const credentialsChanged = Boolean(accessKey || secretKey);
    this.db.transaction(() => {
      this.db.run(
        `UPDATE backup_targets SET
           name = ?, endpoint = ?, region = ?, bucket = ?, prefix = ?, force_path_style = ?, status = ?,
           encrypted_access_key_id = ?, access_key_id_iv = ?, access_key_id_tag = ?, access_key_id_hint = ?,
           encrypted_secret_key = ?, secret_key_iv = ?, secret_key_tag = ?, secret_key_hint = ?,
           connection_status = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
        input.name ?? textValue(row, "name"),
        input.endpoint ?? textValue(row, "endpoint"),
        input.region ?? textValue(row, "region"),
        input.bucket ?? textValue(row, "bucket"),
        prefix,
        input.forcePathStyle === undefined ? (booleanValue(row, "force_path_style", true) ? 1 : 0) : (input.forcePathStyle ? 1 : 0),
        input.status ?? textValue(row, "status", "enabled"),
        accessKey?.encrypted ?? textValue(row, "encrypted_access_key_id"),
        accessKey?.iv ?? textValue(row, "access_key_id_iv"),
        accessKey?.tag ?? textValue(row, "access_key_id_tag"),
        input.accessKeyId === undefined ? textValue(row, "access_key_id_hint") : maskSecret(input.accessKeyId),
        secretKey?.encrypted ?? textValue(row, "encrypted_secret_key"),
        secretKey?.iv ?? textValue(row, "secret_key_iv"),
        secretKey?.tag ?? textValue(row, "secret_key_tag"),
        input.secretAccessKey === undefined ? textValue(row, "secret_key_hint") : maskSecret(input.secretAccessKey),
        credentialsChanged ? "unchecked" : textValue(row, "connection_status", "unchecked"),
        credentialsChanged ? null : (row.last_error === undefined ? null : row.last_error as string | null),
        timestamp,
        targetId
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup-target.updated", "backup-target", targetId, {
        credentialsChanged,
        changedKeys: Object.keys(input).filter((key) => key !== "accessKeyId" && key !== "secretAccessKey")
      });
    });
    return this.getTarget(targetId);
  }

  deleteTarget(targetId: string): void {
    this.requireTargetRow(targetId);
    this.db.transaction(() => {
      this.db.run("DELETE FROM backup_targets WHERE id = ?", targetId);
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup-target.deleted", "backup-target", targetId, {});
    });
    logger.info("backup.target.deleted", { targetId });
  }

  private targetDescriptor(row: Row): S3TargetDescriptor {
    return {
      endpoint: textValue(row, "endpoint"),
      region: textValue(row, "region"),
      bucket: textValue(row, "bucket"),
      prefix: textValue(row, "prefix"),
      forcePathStyle: booleanValue(row, "force_path_style", true)
    };
  }

  /** 便于日志输出的目标配置快照，不包含 Access Key 与 Secret Key。 */
  private targetLogFields(row: Row): Record<string, unknown> {
    const prefix = textValue(row, "prefix");
    return {
      targetId: textValue(row, "id"),
      targetName: textValue(row, "name"),
      endpoint: textValue(row, "endpoint"),
      region: textValue(row, "region"),
      bucket: textValue(row, "bucket"),
      prefix,
      objectRoot: buildBackupObjectKey(prefix),
      pathStyle: booleanValue(row, "force_path_style", true),
      targetStatus: textValue(row, "status", "enabled")
    };
  }

  private credentialsFor(row: Row): S3Credentials {
    return {
      accessKeyId: this.vault.decrypt({
        encrypted: textValue(row, "encrypted_access_key_id"),
        iv: textValue(row, "access_key_id_iv"),
        tag: textValue(row, "access_key_id_tag")
      }),
      secretAccessKey: this.vault.decrypt({
        encrypted: textValue(row, "encrypted_secret_key"),
        iv: textValue(row, "secret_key_iv"),
        tag: textValue(row, "secret_key_tag")
      })
    };
  }

  private clientFor(row: Row): S3Client {
    return new S3Client(this.targetDescriptor(row), this.credentialsFor(row), this.options.sendRequest, this.now);
  }

  private recordTargetOutcome(targetId: string, success: boolean, message: string | null): void {
    const timestamp = this.now().toISOString();
    this.db.run(
      `UPDATE backup_targets SET connection_status = ?, last_error = ?, last_checked_at = ?,
         last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END, updated_at = ?
       WHERE id = ?`,
      success ? "success" : "failed",
      success ? null : (message ?? "").slice(0, 1_000),
      timestamp,
      success ? 1 : 0,
      timestamp,
      timestamp,
      targetId
    );
  }

  /** 记录失败详情，含完整的目标配置（不含密钥）与 S3 服务端返回内容。 */
  private logTargetFailure(event: string, row: Row, failure: BackupTargetFailure, extra: Record<string, unknown> = {}): void {
    logger.error(event, {
      ...this.targetLogFields(row),
      ...extra,
      operation: failure.operation,
      httpMethod: failure.method,
      objectKey: failure.objectKey,
      httpStatus: failure.httpStatus,
      s3Code: failure.s3Code,
      s3Message: failure.s3Message,
      s3RequestId: failure.s3RequestId,
      s3ResponseBody: failure.responseBody,
      failureMessage: failure.message
    });
  }

  async testTarget(targetId: string): Promise<{ ok: boolean; error: BackupTargetFailure | null }> {
    const row = this.requireTargetRow(targetId);
    await this.options.validateEndpoint?.(textValue(row, "endpoint"));
    try {
      await this.clientFor(row).probe();
      this.recordTargetOutcome(targetId, true, null);
      logger.info("backup.target.probe_succeeded", this.targetLogFields(row));
      return { ok: true, error: null };
    } catch (error) {
      const failure = failureFromError(error);
      this.recordTargetOutcome(targetId, false, failure.message);
      this.logTargetFailure("backup.target.probe_failed", row, failure);
      return { ok: false, error: failure };
    }
  }

  private snapshotDirectory(): string {
    const directory = join(this.options.dataDirectory, "backups");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  /** 用 VACUUM INTO 生成一致的独立数据库快照，包含全部已提交的 WAL 内容。 */
  private async createDatabaseSnapshot(fileName: string): Promise<{ path: string; body: Buffer }> {
    const path = join(this.snapshotDirectory(), `.pending-${randomUUID()}-${fileName}`);
    this.db.run("VACUUM INTO ?", path);
    const size = (await stat(path)).size;
    if (size > maximumSnapshotByteLength) {
      await rm(path, { force: true });
      throw new AppError(413, "BACKUP_SNAPSHOT_TOO_LARGE", "数据库快照超过 2GiB 上传上限");
    }
    return { path, body: await readFile(path) };
  }

  private async syncTarget(
    row: Row,
    context: { databaseKey: string; databaseBody: Buffer; includeImages: boolean; retentionCount: number }
  ): Promise<BackupTargetResult> {
    const client = this.clientFor(row);
    const prefix = textValue(row, "prefix");
    const result: BackupTargetResult = {
      targetId: textValue(row, "id"),
      targetName: textValue(row, "name"),
      status: "success",
      objectRoot: buildBackupObjectKey(prefix),
      databaseUploaded: false,
      uploadedImageCount: 0,
      skippedImageCount: 0,
      failedImageCount: 0,
      deletedBackupCount: 0,
      error: null
    };
    try {
      await client.putObject(context.databaseKey, context.databaseBody, "application/vnd.sqlite3");
      result.databaseUploaded = true;
      logger.info("backup.database.uploaded", {
        ...this.targetLogFields(row),
        objectKey: context.databaseKey,
        byteLength: context.databaseBody.byteLength
      });
    } catch (error) {
      result.status = "failed";
      result.error = failureFromError(error);
      this.logTargetFailure("backup.database.upload_failed", row, result.error, { objectKey: context.databaseKey });
      this.recordTargetOutcome(result.targetId, false, result.error.message);
      return result;
    }

    if (context.includeImages) {
      const imageFailure = await this.syncTargetImages(row, client, prefix, result);
      if (imageFailure) {
        result.status = "failed";
        result.error = imageFailure;
      }
    }

    try {
      const objects = await client.listObjects(backupDatabasePrefix(prefix));
      for (const key of selectExpiredBackupKeys(objects, context.retentionCount)) {
        await client.deleteObject(key);
        result.deletedBackupCount += 1;
        logger.info("backup.database.retention_deleted", { ...this.targetLogFields(row), objectKey: key });
      }
    } catch (error) {
      const failure = failureFromError(error);
      result.status = "failed";
      result.error = result.error ?? failure;
      this.logTargetFailure("backup.retention.failed", row, failure);
    }

    this.recordTargetOutcome(result.targetId, result.status === "success", result.error?.message ?? null);
    return result;
  }

  private async syncTargetImages(
    row: Row,
    client: S3Client,
    prefix: string,
    result: BackupTargetResult
  ): Promise<BackupTargetFailure | null> {
    const storageKeys = this.store.listAllAttachmentStorageKeys();
    if (!storageKeys.length) return null;
    let existingKeys: Set<string>;
    try {
      existingKeys = new Set((await client.listObjects(backupImagePrefix(prefix))).map((object) => object.key));
    } catch (error) {
      const failure = failureFromError(error);
      this.logTargetFailure("backup.images.list_failed", row, failure);
      return failure;
    }
    let firstFailure: BackupTargetFailure | null = null;
    let consecutiveFailures = 0;
    for (const storageKey of storageKeys) {
      const objectKey = buildBackupObjectKey(prefix, "img", storageKey);
      if (existingKeys.has(objectKey)) {
        result.skippedImageCount += 1;
        continue;
      }
      try {
        const body = await this.options.attachmentStorage.read(storageKey);
        await client.putObject(objectKey, body, "application/octet-stream");
        result.uploadedImageCount += 1;
        consecutiveFailures = 0;
      } catch (error) {
        result.failedImageCount += 1;
        consecutiveFailures += 1;
        const failure = failureFromError(error);
        firstFailure = firstFailure ?? failure;
        this.logTargetFailure("backup.image.upload_failed", row, failure, { objectKey, storageKey });
        if (consecutiveFailures >= maximumConsecutiveImageFailures) {
          logger.error("backup.images.aborted", {
            ...this.targetLogFields(row),
            consecutiveFailures,
            uploadedImageCount: result.uploadedImageCount,
            failedImageCount: result.failedImageCount
          });
          break;
        }
      }
    }
    return firstFailure;
  }

  async runBackup(trigger: BackupTrigger): Promise<Record<string, unknown>> {
    if (this.running) throw new AppError(409, "BACKUP_ALREADY_RUNNING", "已有备份任务正在执行，请稍后再试");
    const settings = this.getSettings();
    const targetRows = this.db.all("SELECT * FROM backup_targets WHERE status = 'enabled' ORDER BY sort_order, created_at, id");
    if (!targetRows.length) throw new AppError(400, "NO_ENABLED_BACKUP_TARGET", "尚未启用任何 S3 备份目标");
    this.running = true;
    const startedAt = this.now();
    const runId = `bkr_${randomUUID()}`;
    const fileName = backupDatabaseFileName(this.options.databasePath, startedAt);
    const results: BackupTargetResult[] = [];
    let snapshotPath: string | null = null;
    let databaseKey = "";
    let databaseByteLength = 0;
    this.db.run(
      `INSERT INTO backup_runs (id, trigger_source, status, include_images, retention_count, target_count, started_at)
       VALUES (?, ?, 'running', ?, ?, ?, ?)`,
      runId,
      trigger,
      settings.includeImages ? 1 : 0,
      settings.retentionCount,
      targetRows.length,
      startedAt.toISOString()
    );
    logger.info("backup.run.started", {
      runId,
      trigger,
      targetCount: targetRows.length,
      includeImages: settings.includeImages,
      retentionCount: settings.retentionCount
    });
    try {
      const snapshot = await this.createDatabaseSnapshot(fileName);
      snapshotPath = snapshot.path;
      databaseByteLength = snapshot.body.byteLength;
      for (const row of targetRows) {
        const targetKey = buildBackupObjectKey(textValue(row, "prefix"), "db", fileName);
        databaseKey = databaseKey || targetKey;
        results.push(await this.syncTarget(row, {
          databaseKey: targetKey,
          databaseBody: snapshot.body,
          includeImages: settings.includeImages,
          retentionCount: settings.retentionCount
        }));
      }
    } catch (error) {
      const failure = failureFromError(error);
      this.finishRun(runId, "failed", { databaseKey, databaseByteLength, results });
      this.running = false;
      if (snapshotPath) await rm(snapshotPath, { force: true }).catch(() => undefined);
      logger.error("backup.run.failed", { runId, trigger, failureMessage: failure.message, error: sanitizeError(error) });
      throw error;
    }
    if (snapshotPath) await rm(snapshotPath, { force: true }).catch(() => undefined);
    this.running = false;
    const succeeded = results.filter((item) => item.status === "success").length;
    const status: BackupRunStatus = succeeded === results.length ? "success" : succeeded === 0 ? "failed" : "partial";
    this.finishRun(runId, status, { databaseKey, databaseByteLength, results });
    const summary = {
      runId,
      trigger,
      targetCount: results.length,
      succeededTargetCount: succeeded,
      status,
      includeImages: settings.includeImages
    };
    if (status === "success") logger.info("backup.run.completed", summary);
    else logger.error("backup.run.completed_with_failures", summary);
    return this.getRun(runId);
  }

  private finishRun(
    runId: string,
    status: BackupRunStatus,
    context: { databaseKey: string; databaseByteLength: number; results: BackupTargetResult[] }
  ): void {
    this.db.transaction(() => {
      this.db.run(
        `UPDATE backup_runs SET status = ?, database_object_key = ?, database_byte_length = ?,
           succeeded_target_count = ?, results_json = ?, finished_at = ?
         WHERE id = ?`,
        status,
        context.databaseKey,
        context.databaseByteLength,
        context.results.filter((item) => item.status === "success").length,
        JSON.stringify(context.results),
        this.now().toISOString(),
        runId
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup-run.finished", "backup-run", runId, {
        status,
        targetCount: context.results.length,
        succeededTargetCount: context.results.filter((item) => item.status === "success").length
      });
    });
  }

  private mapRun(row: Row): Record<string, unknown> {
    let results: unknown = [];
    try {
      results = JSON.parse(textValue(row, "results_json", "[]"));
    } catch {
      results = [];
    }
    return {
      id: textValue(row, "id"),
      trigger: textValue(row, "trigger_source"),
      status: textValue(row, "status"),
      includeImages: booleanValue(row, "include_images"),
      retentionCount: Number(row.retention_count ?? 0),
      databaseObjectKey: textValue(row, "database_object_key"),
      databaseByteLength: Number(row.database_byte_length ?? 0),
      targetCount: Number(row.target_count ?? 0),
      succeededTargetCount: Number(row.succeeded_target_count ?? 0),
      results: Array.isArray(results) ? results : [],
      acknowledgedAt: row.acknowledged_at === null || row.acknowledged_at === undefined ? null : String(row.acknowledged_at),
      startedAt: textValue(row, "started_at"),
      finishedAt: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at)
    };
  }

  getRun(runId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM backup_runs WHERE id = ?", runId);
    if (!row) throw new AppError(404, "BACKUP_RUN_NOT_FOUND", "备份记录不存在");
    return this.mapRun(row);
  }

  listRuns(limit = 20): Record<string, unknown>[] {
    return this.db
      .all("SELECT * FROM backup_runs ORDER BY started_at DESC, id DESC LIMIT ?", Math.max(1, Math.min(maximumRunListLimit, Math.trunc(limit))))
      .map((row) => this.mapRun(row));
  }

  /** 未确认的失败备份，供前端轮询后 toast 提示，避免定时任务静默失败。 */
  listPendingAlerts(): Record<string, unknown>[] {
    return this.db
      .all(
        `SELECT * FROM backup_runs WHERE acknowledged_at IS NULL AND status IN ('failed', 'partial')
         ORDER BY started_at DESC, id DESC LIMIT 20`
      )
      .map((row) => this.mapRun(row));
  }

  acknowledgeAlerts(runIds: string[]): number {
    if (!runIds.length) return 0;
    return this.db.transaction(() => {
      let changes = 0;
      for (const runId of runIds) {
        changes += this.db.run(
          "UPDATE backup_runs SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL",
          this.now().toISOString(),
          runId
        ).changes;
      }
      return changes;
    });
  }

  start(): void {
    this.scheduleNextRun();
  }

  private scheduleNextRun(): void {
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    const settings = this.getSettings();
    if (!settings.scheduleEnabled) return;
    const nextRunAt = nextScheduledBackupAt(this.now(), settings.scheduleTime);
    const delay = Math.max(1_000, nextRunAt.getTime() - this.now().getTime());
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = null;
      void this.runBackup("schedule")
        .catch((error: unknown) => {
          logger.error("backup.schedule.run_failed", { error: sanitizeError(error) });
        })
        .finally(() => this.scheduleNextRun());
    }, delay);
    this.scheduleTimer.unref?.();
    logger.info("backup.schedule.armed", { nextRunAt: nextRunAt.toISOString(), scheduleTime: settings.scheduleTime });
  }

  dispose(): void {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = null;
  }
}
