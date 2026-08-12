import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStorage } from "./attachment-storage.js";
import { CredentialVault } from "./credential-vault.js";
import { PLATFORM_AI_WORK_ID, type Row } from "./database.js";
import { AppError, notFound } from "./errors.js";
import { logger, sanitizeError } from "./logger.js";
import {
  millisecondsUntilSchedule,
  normalizeS3Prefix,
  parseScheduleTime,
  s3DatabaseFileName,
  s3DatabaseObjectKey,
  s3DatabaseObjectPrefix,
  s3ImageObjectKey,
  selectDatabaseBackupsToDelete,
  shouldRunMissedSchedule
} from "./s3-backup-paths.js";
import { S3CompatibleClient, S3RequestError, type S3TargetPublicConfig } from "./s3-client.js";
import { Store } from "./store.js";
import { id, json, maskSecret, now } from "./utils.js";

const maximumTargets = 20;

export type S3BackupSettings = {
  includeImages: boolean;
  scheduleEnabled: boolean;
  scheduleTime: string;
  retentionCount: number;
  lastRunAt: string | null;
  lastRunStatus: "idle" | "running" | "success" | "partial" | "failed";
  lastRunError: string;
  lastRun: Record<string, unknown>;
  updatedAt: string;
};

export type S3BackupTargetInput = {
  name: string;
  endpoint: string;
  region?: string;
  bucket: string;
  prefix?: string;
  forcePathStyle?: boolean;
  enabled?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
};

export type S3BackupTargetView = S3TargetPublicConfig & {
  accessKeyHint: string;
  lastSuccessAt: string | null;
  lastError: string;
  createdAt: string;
  updatedAt: string;
};

export type S3BackupTargetResult = {
  targetId: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  enabled: boolean;
  status: "success" | "failed" | "skipped";
  databaseKey?: string;
  uploadedImages: number;
  skippedImages: number;
  deletedDatabaseBackups: number;
  error?: string;
  responseBody?: string;
};

export type S3BackupRunResult = {
  status: "success" | "partial" | "failed";
  includeImages: boolean;
  startedAt: string;
  finishedAt: string;
  targets: S3BackupTargetResult[];
  error: string;
};

function boolValue(row: Row | undefined, key: string, fallback = false): boolean {
  return Number(row?.[key] ?? (fallback ? 1 : 0)) === 1;
}

function stringValue(row: Row | undefined, key: string, fallback = ""): string {
  return String(row?.[key] ?? fallback);
}

function imageContentType(storageKey: string): string {
  if (storageKey.endsWith(".png")) return "image/png";
  if (storageKey.endsWith(".jpg") || storageKey.endsWith(".jpeg")) return "image/jpeg";
  if (storageKey.endsWith(".gif")) return "image/gif";
  return "image/webp";
}

function publicTargetConfig(row: Row): S3TargetPublicConfig {
  return {
    id: stringValue(row, "id"),
    name: stringValue(row, "name"),
    endpoint: stringValue(row, "endpoint"),
    region: stringValue(row, "region", "us-east-1"),
    bucket: stringValue(row, "bucket"),
    prefix: stringValue(row, "prefix"),
    forcePathStyle: boolValue(row, "force_path_style", true),
    enabled: boolValue(row, "enabled", true)
  };
}

function loggableTargetConfig(config: S3TargetPublicConfig): Record<string, unknown> {
  return {
    targetId: config.id,
    name: config.name,
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    prefix: config.prefix,
    forcePathStyle: config.forcePathStyle,
    enabled: config.enabled
  };
}

function normalizeEndpoint(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.pathname === "/") url.pathname = "";
    return url.toString().replace(/\/+$/u, "");
  } catch {
    throw new AppError(400, "INVALID_S3_ENDPOINT", "S3 服务地址不是有效的 URL");
  }
}

export class S3BackupManager {
  private readonly client: S3CompatibleClient;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly store: Store,
    private readonly vault: CredentialVault,
    private readonly attachmentStorage: AttachmentStorage,
    fetchImpl: typeof fetch,
    private readonly validateEndpoint: (url: string) => Promise<unknown>
  ) {
    this.client = new S3CompatibleClient({ fetchImpl });
  }

  start(): void {
    this.reschedule();
    const settings = this.getSettings();
    if (settings.scheduleEnabled && shouldRunMissedSchedule(settings.scheduleTime, settings.lastRunAt)) {
      logger.info("s3.backup.missed_schedule", { scheduleTime: settings.scheduleTime, lastRunAt: settings.lastRunAt });
      void this.run("schedule").catch((error) => {
        logger.error("s3.backup.missed_schedule_failed", { error: sanitizeError(error) });
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getSettings(): S3BackupSettings {
    const row = this.store.db.get("SELECT * FROM platform_s3_backup_settings WHERE id = 1");
    const lastRunStatus = stringValue(row, "last_run_status", "idle");
    return {
      includeImages: boolValue(row, "include_images", true),
      scheduleEnabled: boolValue(row, "schedule_enabled"),
      scheduleTime: stringValue(row, "schedule_time", "03:00"),
      retentionCount: Math.min(100, Math.max(1, Number(row?.retention_count ?? 7))),
      lastRunAt: row?.last_run_at ? stringValue(row, "last_run_at") : null,
      lastRunStatus: lastRunStatus === "running" || lastRunStatus === "success" || lastRunStatus === "partial" || lastRunStatus === "failed"
        ? lastRunStatus
        : "idle",
      lastRunError: stringValue(row, "last_run_error"),
      lastRun: json(stringValue(row, "last_run_json", "{}"), {}),
      updatedAt: stringValue(row, "updated_at")
    };
  }

  getOverview(): { settings: S3BackupSettings; targets: S3BackupTargetView[] } {
    return { settings: this.getSettings(), targets: this.listTargets() };
  }

  updateSettings(input: {
    includeImages?: boolean;
    scheduleEnabled?: boolean;
    scheduleTime?: string;
    retentionCount?: number;
  }): S3BackupSettings {
    const current = this.getSettings();
    const scheduleTime = input.scheduleTime ? (parseScheduleTime(input.scheduleTime), input.scheduleTime.trim()) : current.scheduleTime;
    const retentionCount = input.retentionCount ?? current.retentionCount;
    if (!Number.isInteger(retentionCount) || retentionCount < 1 || retentionCount > 100) {
      throw new AppError(400, "INVALID_BACKUP_RETENTION", "数据库备份留存个数必须是 1 到 100 的整数");
    }
    const timestamp = now();
    this.store.db.transaction(() => {
      this.store.db.run(
        `INSERT INTO platform_s3_backup_settings (
           id, include_images, schedule_enabled, schedule_time, retention_count,
           last_run_at, last_run_status, last_run_error, last_run_json, updated_at
         ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           include_images = excluded.include_images,
           schedule_enabled = excluded.schedule_enabled,
           schedule_time = excluded.schedule_time,
           retention_count = excluded.retention_count,
           updated_at = excluded.updated_at`,
        input.includeImages ?? current.includeImages ? 1 : 0,
        input.scheduleEnabled ?? current.scheduleEnabled ? 1 : 0,
        scheduleTime,
        retentionCount,
        current.lastRunAt,
        current.lastRunStatus,
        current.lastRunError,
        JSON.stringify(current.lastRun),
        timestamp
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.s3-backup.settings-updated", "s3-backup-settings", "s3-backup-settings", {
        includeImages: input.includeImages ?? current.includeImages,
        scheduleEnabled: input.scheduleEnabled ?? current.scheduleEnabled,
        scheduleTime,
        retentionCount
      });
    });
    this.reschedule();
    return this.getSettings();
  }

  listTargets(): S3BackupTargetView[] {
    return this.store.db.all("SELECT * FROM s3_backup_targets ORDER BY sort_order, created_at, id")
      .map((row) => this.mapTarget(row));
  }

  async createTarget(input: S3BackupTargetInput): Promise<S3BackupTargetView> {
    if (!input.accessKeyId?.trim() || !input.secretAccessKey?.trim()) {
      throw new AppError(400, "S3_CREDENTIALS_REQUIRED", "请填写 Access Key 和 Secret Key");
    }
    const count = Number(this.store.db.get("SELECT COUNT(*) AS count FROM s3_backup_targets")?.count ?? 0);
    if (count >= maximumTargets) throw new AppError(400, "S3_TARGET_LIMIT", `最多配置 ${maximumTargets} 个备份目标`);
    const prepared = await this.prepareTargetInput(input);
    const targetId = id("s3target");
    const timestamp = now();
    const access = this.vault.encrypt(prepared.accessKeyId);
    const secret = this.vault.encrypt(prepared.secretAccessKey);
    this.store.db.transaction(() => {
      this.store.db.run(
        `INSERT INTO s3_backup_targets (
           id, name, endpoint, region, bucket, prefix, force_path_style, enabled,
           encrypted_access_key, access_key_iv, access_key_tag,
           encrypted_secret_key, secret_key_iv, secret_key_tag, access_key_hint,
           sort_order, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
        targetId,
        prepared.name,
        prepared.endpoint,
        prepared.region,
        prepared.bucket,
        prepared.prefix,
        prepared.forcePathStyle ? 1 : 0,
        prepared.enabled ? 1 : 0,
        access.encrypted,
        access.iv,
        access.tag,
        secret.encrypted,
        secret.iv,
        secret.tag,
        maskSecret(prepared.accessKeyId),
        count,
        timestamp,
        timestamp
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.s3-backup.target-created", "s3-backup-target", targetId, {
        name: prepared.name,
        endpoint: prepared.endpoint,
        region: prepared.region,
        bucket: prepared.bucket,
        prefix: prepared.prefix,
        enabled: prepared.enabled
      });
    });
    return this.getTarget(targetId);
  }

  async updateTarget(targetId: string, input: S3BackupTargetInput): Promise<S3BackupTargetView> {
    const row = this.getTargetRow(targetId);
    const prepared = await this.prepareTargetInput({
      name: input.name,
      endpoint: input.endpoint,
      region: input.region,
      bucket: input.bucket,
      prefix: input.prefix,
      forcePathStyle: input.forcePathStyle,
      enabled: input.enabled,
      accessKeyId: input.accessKeyId || this.decryptField(row, "encrypted_access_key", "access_key_iv", "access_key_tag"),
      secretAccessKey: input.secretAccessKey || this.decryptField(row, "encrypted_secret_key", "secret_key_iv", "secret_key_tag")
    }, true);
    let encryptedAccess = stringValue(row, "encrypted_access_key");
    let accessIv = stringValue(row, "access_key_iv");
    let accessTag = stringValue(row, "access_key_tag");
    let encryptedSecret = stringValue(row, "encrypted_secret_key");
    let secretIv = stringValue(row, "secret_key_iv");
    let secretTag = stringValue(row, "secret_key_tag");
    let accessHint = stringValue(row, "access_key_hint");
    if (input.accessKeyId?.trim()) {
      const access = this.vault.encrypt(input.accessKeyId.trim());
      encryptedAccess = access.encrypted;
      accessIv = access.iv;
      accessTag = access.tag;
      accessHint = maskSecret(input.accessKeyId.trim());
    }
    if (input.secretAccessKey?.trim()) {
      const secret = this.vault.encrypt(input.secretAccessKey.trim());
      encryptedSecret = secret.encrypted;
      secretIv = secret.iv;
      secretTag = secret.tag;
    }
    const timestamp = now();
    this.store.db.transaction(() => {
      this.store.db.run(
        `UPDATE s3_backup_targets SET
           name = ?, endpoint = ?, region = ?, bucket = ?, prefix = ?, force_path_style = ?, enabled = ?,
           encrypted_access_key = ?, access_key_iv = ?, access_key_tag = ?,
           encrypted_secret_key = ?, secret_key_iv = ?, secret_key_tag = ?, access_key_hint = ?,
           updated_at = ?
         WHERE id = ?`,
        prepared.name,
        prepared.endpoint,
        prepared.region,
        prepared.bucket,
        prepared.prefix,
        prepared.forcePathStyle ? 1 : 0,
        prepared.enabled ? 1 : 0,
        encryptedAccess,
        accessIv,
        accessTag,
        encryptedSecret,
        secretIv,
        secretTag,
        accessHint,
        timestamp,
        targetId
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.s3-backup.target-updated", "s3-backup-target", targetId, {
        name: prepared.name,
        endpoint: prepared.endpoint,
        region: prepared.region,
        bucket: prepared.bucket,
        prefix: prepared.prefix,
        enabled: prepared.enabled
      });
    });
    return this.getTarget(targetId);
  }

  deleteTarget(targetId: string): void {
    this.getTargetRow(targetId);
    this.store.db.transaction(() => {
      this.store.db.run("DELETE FROM s3_backup_targets WHERE id = ?", targetId);
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.s3-backup.target-deleted", "s3-backup-target", targetId, {});
    });
  }

  async run(trigger: "manual" | "schedule" = "manual"): Promise<S3BackupRunResult> {
    if (this.running) throw new AppError(409, "S3_BACKUP_RUNNING", "已有备份任务正在执行");
    this.running = true;
    const startedAt = now();
    const settings = this.getSettings();
    this.writeRunState("running", startedAt, "", { trigger, status: "running" });
    logger.info("s3.backup.started", { trigger, includeImages: settings.includeImages });
    const snapshotDirectory = await mkdtemp(join(tmpdir(), "scriverse-s3-backup-"));
    const databaseFileName = s3DatabaseFileName(new Date(startedAt));
    const snapshotPath = join(snapshotDirectory, databaseFileName);
    try {
      this.store.db.backupTo(snapshotPath);
      const imageKeys = settings.includeImages ? await this.attachmentStorage.listImageStorageKeys() : [];
      const targets = this.store.db.all("SELECT * FROM s3_backup_targets ORDER BY sort_order, created_at, id")
        .filter((row) => boolValue(row, "enabled", true));
      if (targets.length === 0) {
        const result: S3BackupRunResult = {
          status: "failed",
          includeImages: settings.includeImages,
          startedAt,
          finishedAt: now(),
          targets: [],
          error: "没有已启用的 S3 备份目标"
        };
        this.finishRun(result);
        throw new AppError(400, "S3_BACKUP_TARGET_REQUIRED", result.error, result);
      }
      const results: S3BackupTargetResult[] = [];
      for (const row of targets) {
        results.push(await this.syncTarget(row, snapshotPath, databaseFileName, imageKeys, settings));
      }
      const failed = results.filter((item) => item.status === "failed");
      const result: S3BackupRunResult = {
        status: failed.length === 0 ? "success" : failed.length === results.length ? "failed" : "partial",
        includeImages: settings.includeImages,
        startedAt,
        finishedAt: now(),
        targets: results,
        error: failed.length === 0
          ? ""
          : failed.map((item) => `${item.name}：${item.error ?? "备份失败"}`).join("；")
      };
      this.finishRun(result);
      if (result.status !== "success") {
        throw new AppError(502, "S3_BACKUP_FAILED", result.error || "S3 备份未全部成功", result);
      }
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const result: S3BackupRunResult = {
        status: "failed",
        includeImages: settings.includeImages,
        startedAt,
        finishedAt: now(),
        targets: [],
        error: error instanceof Error ? error.message : String(error)
      };
      this.finishRun(result);
      logger.error("s3.backup.failed", { trigger, error: sanitizeError(error) });
      throw new AppError(502, "S3_BACKUP_FAILED", result.error, result);
    } finally {
      this.running = false;
      await rm(snapshotDirectory, { recursive: true, force: true });
    }
  }

  private async syncTarget(
    row: Row,
    snapshotPath: string,
    databaseFileName: string,
    imageKeys: string[],
    settings: S3BackupSettings
  ): Promise<S3BackupTargetResult> {
    const config = publicTargetConfig(row);
    const credentials = {
      accessKeyId: this.decryptField(row, "encrypted_access_key", "access_key_iv", "access_key_tag"),
      secretAccessKey: this.decryptField(row, "encrypted_secret_key", "secret_key_iv", "secret_key_tag")
    };
    const result: S3BackupTargetResult = {
      ...config,
      targetId: config.id,
      status: "success",
      uploadedImages: 0,
      skippedImages: 0,
      deletedDatabaseBackups: 0
    };
    try {
      await this.validateEndpoint(config.endpoint);
      const databaseKey = s3DatabaseObjectKey(config.prefix, databaseFileName);
      result.databaseKey = databaseKey;
      await this.client.putFile(config, credentials, databaseKey, snapshotPath, "application/octet-stream");
      if (settings.includeImages) {
        for (const storageKey of imageKeys) {
          const objectKey = s3ImageObjectKey(config.prefix, storageKey);
          const exists = await this.client.headObject(config, credentials, objectKey);
          if (exists) {
            result.skippedImages += 1;
            continue;
          }
          await this.client.putFile(
            config,
            credentials,
            objectKey,
            this.attachmentStorage.path(storageKey),
            imageContentType(storageKey)
          );
          result.uploadedImages += 1;
        }
      }
      const existing = await this.client.listObjectKeys(config, credentials, s3DatabaseObjectPrefix(config.prefix));
      const stale = selectDatabaseBackupsToDelete(existing, settings.retentionCount);
      for (const objectKey of stale) {
        await this.client.deleteObject(config, credentials, objectKey);
        result.deletedDatabaseBackups += 1;
      }
      this.store.db.run(
        "UPDATE s3_backup_targets SET last_success_at = ?, last_error = '', updated_at = ? WHERE id = ?",
        now(),
        now(),
        config.id
      );
      logger.info("s3.backup.target.succeeded", {
        ...loggableTargetConfig(config),
        databaseKey,
        uploadedImages: result.uploadedImages,
        skippedImages: result.skippedImages,
        deletedDatabaseBackups: result.deletedDatabaseBackups
      });
      return result;
    } catch (error) {
      const failure = this.describeFailure(config, error);
      result.status = "failed";
      result.error = failure.message;
      result.responseBody = failure.responseBody;
      this.store.db.run(
        "UPDATE s3_backup_targets SET last_error = ?, updated_at = ? WHERE id = ?",
        failure.message.slice(0, 2000),
        now(),
        config.id
      );
      logger.error("s3.backup.request_failed", {
        ...loggableTargetConfig(config),
        method: failure.method,
        objectKey: failure.objectKey,
        status: failure.status,
        responseBody: failure.responseBody,
        error: failure.message
      });
      return result;
    }
  }

  private describeFailure(config: S3TargetPublicConfig, error: unknown): {
    message: string;
    method: string;
    objectKey: string;
    status: number | null;
    responseBody: string;
  } {
    if (error instanceof S3RequestError) {
      return {
        message: error.message,
        method: error.method,
        objectKey: error.objectKey,
        status: error.status,
        responseBody: error.responseBody
      };
    }
    if (error instanceof AppError) {
      return {
        message: error.message,
        method: "",
        objectKey: "",
        status: error.status,
        responseBody: ""
      };
    }
    return {
      message: error instanceof Error ? error.message : String(error),
      method: "",
      objectKey: "",
      status: null,
      responseBody: ""
    };
  }

  private finishRun(result: S3BackupRunResult): void {
    this.writeRunState(result.status, result.finishedAt, result.error, result);
    this.store.audit(PLATFORM_AI_WORK_ID, "platform.s3-backup.run-finished", "s3-backup-settings", "s3-backup-settings", {
      status: result.status,
      includeImages: result.includeImages,
      targetCount: result.targets.length,
      error: result.error
    });
    if (result.status === "success") logger.info("s3.backup.finished", { status: result.status, targetCount: result.targets.length });
    else logger.error("s3.backup.finished", { status: result.status, error: result.error, targetCount: result.targets.length });
  }

  private writeRunState(status: S3BackupSettings["lastRunStatus"], at: string, error: string, payload: Record<string, unknown>): void {
    this.store.db.run(
      `UPDATE platform_s3_backup_settings SET last_run_at = ?, last_run_status = ?, last_run_error = ?, last_run_json = ?, updated_at = ? WHERE id = 1`,
      at,
      status,
      error.slice(0, 4000),
      JSON.stringify(payload),
      now()
    );
  }

  private reschedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.disposed) return;
    const settings = this.getSettings();
    if (!settings.scheduleEnabled) return;
    const delay = millisecondsUntilSchedule(settings.scheduleTime);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run("schedule")
        .catch((error) => {
          if (error instanceof AppError && error.code === "S3_BACKUP_RUNNING") {
            logger.warn("s3.backup.schedule_skipped", { reason: "already_running" });
            return;
          }
          logger.error("s3.backup.schedule_failed", { error: sanitizeError(error) });
        })
        .finally(() => this.reschedule());
    }, delay);
    logger.info("s3.backup.scheduled", { scheduleTime: settings.scheduleTime, delayMs: delay });
  }

  private getTarget(targetId: string): S3BackupTargetView {
    return this.mapTarget(this.getTargetRow(targetId));
  }

  private getTargetRow(targetId: string): Row {
    const row = this.store.db.get("SELECT * FROM s3_backup_targets WHERE id = ?", targetId);
    if (!row) throw notFound("备份目标");
    return row;
  }

  private mapTarget(row: Row): S3BackupTargetView {
    return {
      ...publicTargetConfig(row),
      accessKeyHint: stringValue(row, "access_key_hint"),
      lastSuccessAt: row.last_success_at ? stringValue(row, "last_success_at") : null,
      lastError: stringValue(row, "last_error"),
      createdAt: stringValue(row, "created_at"),
      updatedAt: stringValue(row, "updated_at")
    };
  }

  private decryptField(row: Row, encryptedKey: string, ivKey: string, tagKey: string): string {
    return this.vault.decrypt({
      encrypted: stringValue(row, encryptedKey),
      iv: stringValue(row, ivKey),
      tag: stringValue(row, tagKey)
    });
  }

  private async prepareTargetInput(input: S3BackupTargetInput, updating = false): Promise<{
    name: string;
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    forcePathStyle: boolean;
    enabled: boolean;
    accessKeyId: string;
    secretAccessKey: string;
  }> {
    const name = input.name.trim();
    if (!name) throw new AppError(400, "INVALID_S3_TARGET_NAME", "请填写备份目标名称");
    const endpoint = normalizeEndpoint(input.endpoint);
    await this.validateEndpoint(endpoint);
    const region = (input.region ?? "us-east-1").trim() || "us-east-1";
    const bucket = input.bucket.trim();
    if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/iu.test(bucket)) {
      throw new AppError(400, "INVALID_S3_BUCKET", "S3 桶名不符合要求");
    }
    const prefix = normalizeS3Prefix(input.prefix ?? "");
    const accessKeyId = input.accessKeyId?.trim() ?? "";
    const secretAccessKey = input.secretAccessKey?.trim() ?? "";
    if (!updating && (!accessKeyId || !secretAccessKey)) {
      throw new AppError(400, "S3_CREDENTIALS_REQUIRED", "请填写 Access Key 和 Secret Key");
    }
    return {
      name: name.slice(0, 80),
      endpoint,
      region: region.slice(0, 64),
      bucket,
      prefix,
      forcePathStyle: input.forcePathStyle !== false,
      enabled: input.enabled !== false,
      accessKeyId,
      secretAccessKey
    };
  }
}
