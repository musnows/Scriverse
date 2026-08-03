import { randomBytes } from "node:crypto";
import { readdirSync, rmSync, type Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import {
  backupDatabaseObjectKey,
  backupDbPrefix,
  backupImagePrefix,
  nextDailyRunDelayMs,
  normalizeBackupPathPrefix,
  selectExpiredBackupKeys
} from "./backup-plan.js";
import type { CredentialVault } from "./credential-vault.js";
import { PLATFORM_AI_WORK_ID, type Database, type Row } from "./database.js";
import { AppError } from "./errors.js";
import { logger, sanitizeError } from "./logger.js";
import { S3Client, S3RequestError } from "./s3-client.js";
import type { SafeAiEndpointValidator } from "./security.js";
import type { Store } from "./store.js";
import { id, maskSecret, now } from "./utils.js";

/** 创建备份目标时的输入（已经过 Zod 校验）。 */
export interface BackupConfigInput {
  name: string;
  endpointUrl: string;
  region: string;
  bucket: string;
  pathPrefix?: string;
  forcePathStyle?: boolean;
  includeImages?: boolean;
  scheduleTime?: string;
  retentionCount?: number;
  enabled?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/** 更新备份目标时的输入（已经过 Zod 校验）；ak/sk 缺省表示保持不变。 */
export type BackupConfigUpdateInput = Partial<BackupConfigInput>;

export type BackupRunTrigger = "manual" | "schedule";
export type BackupRunStatus = "queued" | "running" | "success" | "failed";

export interface BackupRunQuery {
  configId?: string;
  status?: BackupRunStatus;
  since?: string;
  limit: number;
}

export interface BackupManagerOptions {
  store: Store;
  vault: CredentialVault;
  database: Database;
  /** 附件根目录绝对路径（AttachmentStorage.rootDirectory）。 */
  attachmentRoot: string;
  /** 数据库快照临时目录，只由服务端写入，备份结束即清理。 */
  stagingDirectory: string;
  fetchImpl: typeof fetch;
  validateOutboundUrl?: SafeAiEndpointValidator;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const RUN_ERROR_MAX_LENGTH = 500;
const SHARD_DIRECTORY_PATTERN = /^[a-f0-9]{2}$/u;
const ATTACHMENT_FILENAME_PATTERN = /^[a-f0-9]{64}\.(webp|png|jpe?g|gif)$/u;

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif"
};

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** 备份目标配置管理与定时执行：串行队列保证多个目标依次同步，绝不并行。 */
export class BackupManager {
  private readonly store: Store;
  private readonly vault: CredentialVault;
  private readonly database: Database;
  private readonly attachmentRoot: string;
  private readonly stagingDirectory: string;
  private readonly fetchImpl: typeof fetch;
  private readonly validateOutboundUrl?: SafeAiEndpointValidator;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private queue: Promise<void> = Promise.resolve();

  constructor(options: BackupManagerOptions) {
    this.store = options.store;
    this.vault = options.vault;
    this.database = options.database;
    this.attachmentRoot = options.attachmentRoot;
    this.stagingDirectory = options.stagingDirectory;
    this.fetchImpl = options.fetchImpl;
    this.validateOutboundUrl = options.validateOutboundUrl;
  }

  listConfigs(): Record<string, unknown>[] {
    return this.store.db.all("SELECT * FROM s3_backup_configs ORDER BY created_at, id").map((row) => this.mapConfig(row));
  }

  getConfig(configId: string): Record<string, unknown> {
    return this.mapConfig(this.getConfigRow(configId));
  }

  createConfig(input: BackupConfigInput): Record<string, unknown> {
    this.assertValidEndpoint(input.endpointUrl);
    const accessKeyId = input.accessKeyId;
    const secretAccessKey = input.secretAccessKey;
    if (accessKeyId === undefined || secretAccessKey === undefined) {
      throw new AppError(400, "BACKUP_CREDENTIALS_REQUIRED", "创建备份目标必须提供 Access Key 和 Secret Key");
    }
    const configId = id("backup");
    const timestamp = now();
    const pathPrefix = normalizeBackupPathPrefix(input.pathPrefix ?? "");
    const accessKey = this.vault.encrypt(accessKeyId);
    const secretKey = this.vault.encrypt(secretAccessKey);
    this.store.db.transaction(() => {
      this.store.db.run(
        `INSERT INTO s3_backup_configs (id, name, endpoint_url, region, bucket, path_prefix, force_path_style, include_images,
         schedule_time, retention_count, enabled, encrypted_access_key, access_key_iv, access_key_tag, access_key_hint,
         encrypted_secret_key, secret_key_iv, secret_key_tag, secret_key_hint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        configId,
        input.name,
        input.endpointUrl,
        input.region,
        input.bucket,
        pathPrefix,
        input.forcePathStyle === false ? 0 : 1,
        input.includeImages === false ? 0 : 1,
        input.scheduleTime ?? "03:00",
        input.retentionCount ?? 7,
        input.enabled === false ? 0 : 1,
        accessKey.encrypted,
        accessKey.iv,
        accessKey.tag,
        maskSecret(accessKeyId),
        secretKey.encrypted,
        secretKey.iv,
        secretKey.tag,
        maskSecret(secretAccessKey),
        timestamp,
        timestamp
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "backup-config.created", "backup-config", configId, {
        name: input.name,
        endpointUrl: input.endpointUrl,
        bucket: input.bucket,
        pathPrefix
      });
    });
    this.reschedule(configId);
    return this.getConfig(configId);
  }

  updateConfig(configId: string, input: BackupConfigUpdateInput): Record<string, unknown> {
    const current = this.getConfigRow(configId);
    if (input.endpointUrl !== undefined) this.assertValidEndpoint(input.endpointUrl);
    const next = {
      name: input.name ?? String(current.name),
      endpointUrl: input.endpointUrl ?? String(current.endpoint_url),
      region: input.region ?? String(current.region),
      bucket: input.bucket ?? String(current.bucket),
      pathPrefix: input.pathPrefix === undefined ? String(current.path_prefix) : normalizeBackupPathPrefix(input.pathPrefix),
      forcePathStyle: input.forcePathStyle ?? Number(current.force_path_style) === 1,
      includeImages: input.includeImages ?? Number(current.include_images) === 1,
      scheduleTime: input.scheduleTime ?? String(current.schedule_time),
      retentionCount: input.retentionCount ?? Number(current.retention_count),
      enabled: input.enabled ?? Number(current.enabled) === 1
    };
    // ak/sk 传了才换：重新加密并更新掩码 hint；缺省时沿用现有密文。
    const accessKey = input.accessKeyId === undefined ? null : this.vault.encrypt(input.accessKeyId);
    const secretKey = input.secretAccessKey === undefined ? null : this.vault.encrypt(input.secretAccessKey);
    this.store.db.transaction(() => {
      this.store.db.run(
        `UPDATE s3_backup_configs SET name = ?, endpoint_url = ?, region = ?, bucket = ?, path_prefix = ?,
         force_path_style = ?, include_images = ?, schedule_time = ?, retention_count = ?, enabled = ?,
         encrypted_access_key = ?, access_key_iv = ?, access_key_tag = ?, access_key_hint = ?,
         encrypted_secret_key = ?, secret_key_iv = ?, secret_key_tag = ?, secret_key_hint = ?, updated_at = ?
         WHERE id = ?`,
        next.name,
        next.endpointUrl,
        next.region,
        next.bucket,
        next.pathPrefix,
        next.forcePathStyle ? 1 : 0,
        next.includeImages ? 1 : 0,
        next.scheduleTime,
        next.retentionCount,
        next.enabled ? 1 : 0,
        accessKey?.encrypted ?? String(current.encrypted_access_key),
        accessKey?.iv ?? String(current.access_key_iv),
        accessKey?.tag ?? String(current.access_key_tag),
        input.accessKeyId === undefined ? String(current.access_key_hint) : maskSecret(input.accessKeyId),
        secretKey?.encrypted ?? String(current.encrypted_secret_key),
        secretKey?.iv ?? String(current.secret_key_iv),
        secretKey?.tag ?? String(current.secret_key_tag),
        input.secretAccessKey === undefined ? String(current.secret_key_hint) : maskSecret(input.secretAccessKey),
        now(),
        configId
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "backup-config.updated", "backup-config", configId, {
        name: next.name,
        endpointUrl: next.endpointUrl,
        bucket: next.bucket,
        pathPrefix: next.pathPrefix
      });
    });
    this.reschedule(configId);
    return this.getConfig(configId);
  }

  deleteConfig(configId: string): void {
    const current = this.getConfigRow(configId);
    this.store.db.transaction(() => {
      this.store.db.run("DELETE FROM s3_backup_configs WHERE id = ?", configId);
      this.store.audit(PLATFORM_AI_WORK_ID, "backup-config.deleted", "backup-config", configId, {
        name: String(current.name),
        endpointUrl: String(current.endpoint_url),
        bucket: String(current.bucket),
        pathPrefix: String(current.path_prefix)
      });
    });
    // 配置已删除，清掉对应定时器。
    this.reschedule(configId);
  }

  listRuns(query: BackupRunQuery): Record<string, unknown>[] {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (query.configId !== undefined) {
      conditions.push("r.config_id = ?");
      params.push(query.configId);
    }
    if (query.status !== undefined) {
      conditions.push("r.status = ?");
      params.push(query.status);
    }
    if (query.since !== undefined) {
      conditions.push("r.finished_at > ?");
      params.push(query.since);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(100, Math.max(1, Math.floor(query.limit)));
    return this.store.db.all(
      `SELECT r.*, c.name AS config_name FROM s3_backup_runs r
       LEFT JOIN s3_backup_configs c ON c.id = r.config_id${where}
       ORDER BY r.started_at DESC, r.id DESC LIMIT ?`,
      ...params,
      limit
    ).map((row) => this.mapRun(row));
  }

  /** 请求一次备份执行；同一配置已有排队或运行中的执行时直接返回既有记录，不重复入队。 */
  requestRun(configId: string, trigger: BackupRunTrigger): Record<string, unknown> {
    this.getConfigRow(configId);
    const existing = this.store.db.get(
      `SELECT r.*, c.name AS config_name FROM s3_backup_runs r
       LEFT JOIN s3_backup_configs c ON c.id = r.config_id
       WHERE r.config_id = ? AND r.status IN ('queued', 'running')
       ORDER BY r.started_at DESC, r.id DESC LIMIT 1`,
      configId
    );
    if (existing) return this.mapRun(existing);
    const runId = id("backuprun");
    this.store.db.run(
      "INSERT INTO s3_backup_runs (id, config_id, trigger_kind, status, started_at) VALUES (?, ?, ?, 'queued', ?)",
      runId,
      configId,
      trigger,
      now()
    );
    // 挂到全局串行队列：多个目标依次同步执行，绝不并行。
    this.queue = this.queue.then(() => this.executeRun(runId)).catch((error: unknown) => {
      logger.error("backup.run.unhandled", { runId, error: sanitizeError(error) });
    });
    const created = this.store.db.get(
      `SELECT r.*, c.name AS config_name FROM s3_backup_runs r
       LEFT JOIN s3_backup_configs c ON c.id = r.config_id WHERE r.id = ?`,
      runId
    );
    if (!created) throw new AppError(500, "BACKUP_RUN_NOT_FOUND", "备份执行记录不存在");
    return this.mapRun(created);
  }

  /** 启动：中断恢复、清理遗留快照临时文件、为每个启用的配置 arm 定时器。 */
  start(): void {
    this.store.db.run(
      "UPDATE s3_backup_runs SET status = 'failed', error = '服务重启导致备份中断', finished_at = ? WHERE status IN ('queued', 'running')",
      now()
    );
    this.cleanStagingDirectory();
    for (const row of this.store.db.all("SELECT id FROM s3_backup_configs WHERE enabled = 1")) {
      this.reschedule(String(row.id));
    }
  }

  /** 重新 arm 指定配置的每日定时器；配置不存在或已停用时只清除旧定时器。 */
  reschedule(configId: string): void {
    const existing = this.timers.get(configId);
    if (existing) clearTimeout(existing);
    this.timers.delete(configId);
    const row = this.store.db.get("SELECT id, schedule_time, enabled FROM s3_backup_configs WHERE id = ?", configId);
    if (!row || Number(row.enabled) !== 1) return;
    let delay: number;
    try {
      delay = Math.min(nextDailyRunDelayMs(String(row.schedule_time), new Date()), MAX_TIMER_DELAY_MS);
    } catch (error) {
      logger.error("backup.scheduler.arm_failed", { configId, error: sanitizeError(error) });
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(configId);
      try {
        this.requestRun(configId, "schedule");
      } catch (error) {
        logger.error("backup.scheduler.trigger_failed", { configId, error: sanitizeError(error) });
      }
      // 立即重新 arm 下一天的执行，不等本次备份跑完。
      this.reschedule(configId);
    }, delay);
    timer.unref?.();
    this.timers.set(configId, timer);
    logger.info("backup.scheduler.armed", { configId, delayMs: delay });
  }

  /** 清掉全部定时器；队列中已开始的执行等其自然结束，不等待。 */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private getConfigRow(configId: string): Row {
    const row = this.store.db.get("SELECT * FROM s3_backup_configs WHERE id = ?", configId);
    if (!row) throw new AppError(404, "BACKUP_CONFIG_NOT_FOUND", "备份目标不存在");
    return row;
  }

  /** 同步格式校验：可解析、http/https、无内嵌用户名密码；SSRF 在运行时由 fetchSafeAiEndpoint 完成。 */
  private assertValidEndpoint(endpointUrl: string): void {
    let endpoint: URL;
    try {
      endpoint = new URL(endpointUrl);
    } catch {
      throw new AppError(400, "INVALID_S3_ENDPOINT", "S3 端点地址无效");
    }
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
      throw new AppError(400, "INVALID_S3_ENDPOINT", "S3 端点地址只支持 http/https");
    }
    if (endpoint.username !== "" || endpoint.password !== "") {
      throw new AppError(400, "INVALID_S3_ENDPOINT", "S3 端点地址不允许内嵌用户名或密码");
    }
  }

  private cleanStagingDirectory(): void {
    let entries: string[];
    try {
      entries = readdirSync(this.stagingDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn("backup.staging.cleanup_failed", { error: sanitizeError(error) });
      }
      return;
    }
    for (const entry of entries) {
      if (entry.endsWith(".db")) rmSync(join(this.stagingDirectory, entry), { force: true });
    }
  }

  private async executeRun(runId: string): Promise<void> {
    const startedAt = Date.now();
    const runRow = this.store.db.get("SELECT * FROM s3_backup_runs WHERE id = ?", runId);
    if (!runRow) return;
    const configId = String(runRow.config_id);
    const trigger = String(runRow.trigger_kind);
    const configRow = this.store.db.get("SELECT * FROM s3_backup_configs WHERE id = ?", configId);
    if (!configRow) {
      this.store.db.run(
        "UPDATE s3_backup_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
        "备份目标已删除",
        now(),
        runId
      );
      logger.error("backup.run.failed", { configId, runId, trigger, error: { message: "备份目标已删除" } });
      return;
    }
    this.store.db.run("UPDATE s3_backup_runs SET status = 'running' WHERE id = ?", runId);
    logger.info("backup.run.started", { configId, runId, trigger });
    try {
      const accessKeyId = this.vault.decrypt({
        encrypted: String(configRow.encrypted_access_key),
        iv: String(configRow.access_key_iv),
        tag: String(configRow.access_key_tag)
      });
      const secretAccessKey = this.vault.decrypt({
        encrypted: String(configRow.encrypted_secret_key),
        iv: String(configRow.secret_key_iv),
        tag: String(configRow.secret_key_tag)
      });
      const client = new S3Client({
        endpointUrl: String(configRow.endpoint_url),
        region: String(configRow.region),
        bucket: String(configRow.bucket),
        accessKeyId,
        secretAccessKey,
        forcePathStyle: Number(configRow.force_path_style) === 1,
        fetchImpl: this.fetchImpl,
        ...(this.validateOutboundUrl ? { validateOutboundUrl: this.validateOutboundUrl } : {})
      });
      const pathPrefix = String(configRow.path_prefix);
      // 数据库快照：VACUUM INTO 落盘后读入内存，临时文件在 finally 中保证删除。
      const nowDate = new Date();
      const stamp = `${nowDate.getUTCFullYear()}${pad2(nowDate.getUTCMonth() + 1)}${pad2(nowDate.getUTCDate())}`
        + `-${pad2(nowDate.getUTCHours())}${pad2(nowDate.getUTCMinutes())}${pad2(nowDate.getUTCSeconds())}`;
      const snapshotPath = join(this.stagingDirectory, `snapshot-${stamp}-${randomBytes(3).toString("hex")}.db`);
      let snapshot: Buffer;
      try {
        await mkdir(this.stagingDirectory, { recursive: true, mode: 0o700 });
        this.database.vacuumInto(snapshotPath);
        snapshot = await readFile(snapshotPath);
      } finally {
        await rm(snapshotPath, { force: true });
      }
      // 上传数据库快照。
      const dbKey = backupDatabaseObjectKey(pathPrefix, new Date());
      await client.putObject(dbKey, snapshot, "application/octet-stream");
      this.store.db.run("UPDATE s3_backup_runs SET db_key = ? WHERE id = ?", dbKey, runId);
      // 同步附件图片：已存在的跳过，单张失败即整个执行失败。
      let imagesUploaded = 0;
      let imagesSkipped = 0;
      if (Number(configRow.include_images) === 1) {
        const imagePrefix = backupImagePrefix(pathPrefix);
        const existingKeys = new Set(await client.listKeys(imagePrefix));
        for (const file of await this.listAttachmentFiles()) {
          const key = `${imagePrefix}${file.storageKey}`;
          if (existingKeys.has(key)) {
            imagesSkipped += 1;
            continue;
          }
          await client.putObject(key, await readFile(file.path), file.contentType);
          imagesUploaded += 1;
        }
      }
      // 留存清理：只删 db 前缀下匹配备份命名规则的文件，绝不碰 img 前缀。
      const dbKeys = await client.listKeys(backupDbPrefix(pathPrefix));
      const expiredKeys = selectExpiredBackupKeys(dbKeys, pathPrefix, Number(configRow.retention_count));
      for (const key of expiredKeys) await client.deleteObject(key);
      if (expiredKeys.length > 0) logger.info("backup.retention.cleaned", { configId, deleted: expiredKeys.length });
      const finishedAt = now();
      this.store.db.run(
        "UPDATE s3_backup_runs SET status = 'success', images_uploaded = ?, images_skipped = ?, finished_at = ? WHERE id = ?",
        imagesUploaded,
        imagesSkipped,
        finishedAt,
        runId
      );
      this.store.db.run(
        "UPDATE s3_backup_configs SET last_run_at = ?, last_run_status = 'success', last_error = NULL, updated_at = ? WHERE id = ?",
        finishedAt,
        finishedAt,
        configId
      );
      logger.info("backup.run.completed", {
        configId,
        runId,
        dbKey,
        imagesUploaded,
        imagesSkipped,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      this.recordRunFailure(runId, configId, trigger, error, configRow, startedAt);
    }
  }

  /** 记录执行失败：只更新数据库和日志，不再上抛（定时器场景无人接收，手动场景前端轮询 run 状态）。 */
  private recordRunFailure(runId: string, configId: string, trigger: string, error: unknown, configRow: Row, startedAt: number): void {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, RUN_ERROR_MAX_LENGTH);
    const finishedAt = now();
    this.store.db.run(
      "UPDATE s3_backup_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
      message,
      finishedAt,
      runId
    );
    this.store.db.run(
      "UPDATE s3_backup_configs SET last_run_at = ?, last_run_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
      finishedAt,
      message,
      finishedAt,
      configId
    );
    logger.error("backup.run.failed", {
      configId,
      runId,
      trigger,
      config: {
        name: String(configRow.name),
        endpointUrl: String(configRow.endpoint_url),
        region: String(configRow.region),
        bucket: String(configRow.bucket),
        pathPrefix: String(configRow.path_prefix),
        forcePathStyle: Number(configRow.force_path_style) === 1,
        includeImages: Number(configRow.include_images) === 1,
        scheduleTime: String(configRow.schedule_time),
        retentionCount: Number(configRow.retention_count)
      },
      ...(error instanceof S3RequestError ? { s3Status: error.status, s3Response: error.responseBody } : {}),
      error: sanitizeError(error),
      durationMs: Date.now() - startedAt
    });
  }

  /** 遍历附件根目录，返回符合存储命名规范的图片文件；目录不存在视为零文件。 */
  private async listAttachmentFiles(): Promise<Array<{ storageKey: string; path: string; contentType: string }>> {
    let shardEntries: Dirent[];
    try {
      shardEntries = await readdir(this.attachmentRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const files: Array<{ storageKey: string; path: string; contentType: string }> = [];
    for (const shardEntry of shardEntries) {
      if (!shardEntry.isDirectory() || !SHARD_DIRECTORY_PATTERN.test(shardEntry.name)) continue;
      const shardDirectory = join(this.attachmentRoot, shardEntry.name);
      for (const fileEntry of await readdir(shardDirectory, { withFileTypes: true })) {
        if (!fileEntry.isFile()) continue;
        const match = ATTACHMENT_FILENAME_PATTERN.exec(fileEntry.name);
        if (!match) continue;
        files.push({
          storageKey: `${shardEntry.name}/${fileEntry.name}`,
          path: join(shardDirectory, fileEntry.name),
          contentType: IMAGE_CONTENT_TYPES[String(match[1])] ?? "application/octet-stream"
        });
      }
    }
    return files;
  }

  private mapConfig(row: Row): Record<string, unknown> {
    return {
      id: String(row.id),
      name: String(row.name),
      endpointUrl: String(row.endpoint_url),
      region: String(row.region),
      bucket: String(row.bucket),
      pathPrefix: String(row.path_prefix),
      forcePathStyle: Number(row.force_path_style) === 1,
      includeImages: Number(row.include_images) === 1,
      scheduleTime: String(row.schedule_time),
      retentionCount: Number(row.retention_count),
      enabled: Number(row.enabled) === 1,
      accessKeyHint: String(row.access_key_hint),
      secretKeyHint: String(row.secret_key_hint),
      lastRunAt: row.last_run_at == null ? null : String(row.last_run_at),
      lastRunStatus: row.last_run_status == null ? null : String(row.last_run_status),
      lastError: row.last_error == null ? null : String(row.last_error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapRun(row: Row): Record<string, unknown> {
    return {
      id: String(row.id),
      configId: String(row.config_id),
      configName: row.config_name == null ? "" : String(row.config_name),
      trigger: String(row.trigger_kind),
      status: String(row.status),
      error: row.error == null ? null : String(row.error),
      dbKey: row.db_key == null ? null : String(row.db_key),
      imagesUploaded: Number(row.images_uploaded),
      imagesSkipped: Number(row.images_skipped),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at == null ? null : String(row.finished_at)
    };
  }
}
