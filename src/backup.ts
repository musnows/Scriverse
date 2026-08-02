/**
 * 平台数据备份管理器。
 * 负责：S3 兼容目标的多目标顺序备份、数据库快照（含 WAL 与主密钥）、
 * 图片增量上传、数据库备份留存清理、cron 定时调度与失败结果聚合。
 * 任何失败都必须完整记录目标配置（不含 AK/SK）与 S3 服务端返回，禁止静默失败。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { parseCronExpression, cronMatches, type CronExpression } from "./cron.js";
import { CredentialVault, type EncryptedSecret } from "./credential-vault.js";
import { AppError } from "./errors.js";
import { logger, sanitizeError } from "./logger.js";
import { S3CompatClient, S3ServiceError, contentTypeForStorageKey } from "./s3-client.js";
import { now } from "./utils.js";
import type { Database } from "./database.js";
import type { BackupTargetRow, Store } from "./store.js";

/** 桶内备份根目录。 */
export const BACKUP_ROOT_DIR = "scriverse";
export const BACKUP_IMAGE_DIR = "img";
export const BACKUP_DB_DIR = "db";

/** 数据库备份文件名中的时间戳格式，与迁移前备份保持一致。 */
export function backupTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/gu, "-");
}

/** 图片存储 key 校验，与附件存储的目录布局保持一致。 */
export const STORAGE_KEY_PATTERN = /^[a-f0-9]{2}\/[a-f0-9]{64}\.(?:webp|png|jpe?g|gif)$/u;

export type BackupSettingsInput = {
  schedulerEnabled: boolean;
  scheduleCron: string;
  backupImages: boolean;
  retentionCount: number;
};

export type BackupSettingsView = BackupSettingsInput & { updatedAt: string };

export type BackupTargetInput = {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  enabled: boolean;
};

export type BackupTargetUpdateInput = Partial<Omit<BackupTargetInput, "secretAccessKey">> & {
  secretAccessKey?: string;
};

export type BackupTargetView = {
  id: number;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  enabled: boolean;
  hasSecretKey: boolean;
  lastBackupAt: string | null;
  lastStatus: "success" | "failed" | null;
  lastError: string;
  createdAt: string;
  updatedAt: string;
};

export type BackupRunResult = {
  targetId: number;
  name: string;
  ok: boolean;
  error: string;
  uploadedDbFileCount: number;
  uploadedImageCount: number;
  skippedImageCount: number;
  prunedBackupCount: number;
};

export type BackupRunOutcome = { results: BackupRunResult[] } | { busy: true };

/** 规范化备份子目录：去首尾斜杠，禁止路径穿越与不可见字符。 */
export function normalizeBackupPrefix(value: string): string {
  const cleaned = value.trim().replace(/^\/+|\/+$/gu, "");
  if (cleaned.includes("..")) throw new AppError(400, "BACKUP_PREFIX_INVALID", "备份子目录不允许包含 ..");
  if (/[\u0000-\u001f\u007f]/u.test(cleaned)) throw new AppError(400, "BACKUP_PREFIX_INVALID", "备份子目录包含非法字符");
  return cleaned;
}

function joinPrefix(base: string, ...parts: string[]): string {
  return [base, ...parts].filter(Boolean).join("/");
}

/**
 * 计算需要删除的最老数据库备份文件。
 * 一份备份 = 同一时间戳下的 novel-*.db（可能带 -wal 文件）与 master-*.key 文件集合；
 * 按时间戳升序保留最近的 retentionCount 份，其余全部删除。图片不参与清理。
 */
export function selectPruneKeys(remoteKeys: readonly string[], retentionCount: number): string[] {
  const timestampPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/u;
  const groups = new Map<string, string[]>();
  for (const key of remoteKeys) {
    const base = key.split("/").pop() ?? "";
    const timestampMatch = /^novel-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.db$/u.exec(base)
      ?? /^novel-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-wal\.db$/u.exec(base)
      ?? /^master-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.key$/u.exec(base);
    const timestamp = timestampMatch?.[1];
    if (!timestamp || !timestampPattern.test(timestamp)) continue;
    const entries = groups.get(timestamp) ?? [];
    entries.push(key);
    groups.set(timestamp, entries);
  }
  const timestamps = [...groups.keys()].sort();
  const pruneCount = Math.max(0, timestamps.length - Math.max(1, retentionCount));
  return timestamps.slice(0, pruneCount).flatMap((timestamp) => groups.get(timestamp) ?? []);
}

/** 遍历附件目录，返回符合存储 key 布局的相对路径列表（排除临时目录与异常文件）。 */
export function walkAttachmentKeys(root: string): string[] {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const parent = entry.parentPath;
    const relative = parent.startsWith(rootPrefix) ? parent.slice(rootPrefix.length) : "";
    const storageKey = relative ? `${relative}${sep}${entry.name}` : entry.name;
    if (storageKey.startsWith(".tmp")) continue;
    if (!STORAGE_KEY_PATTERN.test(storageKey)) continue;
    results.push(storageKey);
  }
  return results.sort();
}

function summarizeBackupError(error: unknown): string {
  if (error instanceof S3ServiceError) {
    return `目标存储返回错误 ${error.s3Status}（${error.s3Code}）：${error.s3Message}`.slice(0, 500);
  }
  if (error instanceof AppError) return error.message.slice(0, 500);
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

export type BackupManagerOptions = {
  store: Store;
  vault: CredentialVault;
  database: Database;
  databasePath: string;
  masterKeyPath: string;
  attachmentDirectory: string;
  fetchImpl?: typeof fetch;
};

export class BackupManager {
  private readonly store: Store;
  private readonly vault: CredentialVault;
  private readonly database: Database;
  private readonly databasePath: string;
  private readonly masterKeyPath: string;
  private readonly attachmentDirectory: string;
  private readonly fetchImpl: typeof fetch;

  private scheduled: CronExpression | null = null;
  private alignTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: BackupManagerOptions) {
    this.store = options.store;
    this.vault = options.vault;
    this.database = options.database;
    this.databasePath = options.databasePath;
    this.masterKeyPath = options.masterKeyPath;
    this.attachmentDirectory = options.attachmentDirectory;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 读取当前备份配置并启动定时调度；配置变更后会自动重新调度。 */
  start(): void {
    this.stop();
    try {
      const settings = this.store.getPlatformBackupSettings();
      if (!settings.scheduler_enabled) return;
      this.scheduled = parseCronExpression(settings.schedule_cron);
    } catch (error) {
      logger.warn("backup.scheduler.invalid_cron", { error: sanitizeError(error) });
      return;
    }
    const delayToMinute = 60_000 - (Date.now() % 60_000) + 1_000;
    this.alignTimer = setTimeout(() => {
      this.alignTimer = null;
      void this.tick();
      this.tickTimer = setInterval(() => void this.tick(), 60_000);
      this.tickTimer.unref?.();
    }, delayToMinute);
    this.alignTimer.unref?.();
    logger.info("backup.scheduler.started", { scheduleCron: this.store.getPlatformBackupSettings().schedule_cron });
  }

  stop(): void {
    if (this.alignTimer) {
      clearTimeout(this.alignTimer);
      this.alignTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.scheduled = null;
  }

  private async tick(): Promise<void> {
    if (!this.scheduled || this.running) return;
    if (!cronMatches(this.scheduled, new Date())) return;
    try {
      await this.runNow("schedule");
    } catch (error) {
      // runNow 内部逐目标捕获，到达此处属于整体性异常，记录日志但不中断服务。
      logger.error("backup.scheduler.tick_failed", { error: sanitizeError(error) });
    }
  }

  /** 当前备份配置与目标列表（脱敏视图，不含任何密钥）。 */
  getSnapshot(): { settings: BackupSettingsView; targets: BackupTargetView[] } {
    return {
      settings: this.mapSettings(this.store.getPlatformBackupSettings()),
      targets: this.store.listPlatformBackupTargets().map((row) => this.mapTarget(row))
    };
  }

  updateSettings(input: BackupSettingsInput): BackupSettingsView {
    const updated = this.store.updatePlatformBackupSettings(input);
    this.start();
    return this.mapSettings(updated);
  }

  createTarget(input: BackupTargetInput): BackupTargetView {
    const row = this.store.createPlatformBackupTarget({
      name: input.name,
      endpoint: input.endpoint,
      region: input.region,
      bucket: input.bucket,
      accessKeyId: input.accessKeyId,
      secretAccessKeyJson: JSON.stringify(this.vault.encrypt(input.secretAccessKey)),
      prefix: normalizeBackupPrefix(input.prefix),
      enabled: input.enabled
    });
    return this.mapTarget(row);
  }

  updateTarget(targetId: number, input: BackupTargetUpdateInput): BackupTargetView {
    const row = this.store.updatePlatformBackupTarget(targetId, {
      ...input,
      ...(input.prefix !== undefined ? { prefix: normalizeBackupPrefix(input.prefix) } : {}),
      ...(input.secretAccessKey !== undefined && input.secretAccessKey !== ""
        ? { secretAccessKeyJson: JSON.stringify(this.vault.encrypt(input.secretAccessKey)) }
        : {})
    });
    return this.mapTarget(row);
  }

  deleteTarget(targetId: number): void {
    this.store.deletePlatformBackupTarget(targetId);
  }

  /** 立即对所有启用的目标执行备份；正在执行中时返回 busy。 */
  async runNow(trigger: "manual" | "schedule"): Promise<BackupRunOutcome> {
    if (this.running) return { busy: true };
    this.running = true;
    try {
      const settings = this.store.getPlatformBackupSettings();
      if (trigger === "schedule" && !settings.scheduler_enabled) return { results: [] };
      const targets = this.store.listPlatformBackupTargets().filter((row) => row.enabled === 1);
      const results: BackupRunResult[] = [];
      for (const target of targets) {
        results.push(await this.runTarget(target, settings, trigger));
      }
      return { results };
    } finally {
      this.running = false;
    }
  }

  private async runTarget(
    target: BackupTargetRow,
    settings: { backup_images: number; retention_count: number },
    trigger: "manual" | "schedule"
  ): Promise<BackupRunResult> {
    const startedAt = Date.now();
    // 失败日志的完整配置上下文：除 AK/SK 外全部打印，便于定位问题目标。
    const logContext = {
      targetId: target.id,
      name: target.name,
      endpoint: target.endpoint,
      region: target.region,
      bucket: target.bucket,
      prefix: target.prefix,
      enabled: target.enabled === 1,
      trigger
    };
    const emptyResult: BackupRunResult = {
      targetId: target.id,
      name: target.name,
      ok: false,
      error: "",
      uploadedDbFileCount: 0,
      uploadedImageCount: 0,
      skippedImageCount: 0,
      prunedBackupCount: 0
    };
    let secretAccessKey: string;
    try {
      secretAccessKey = this.vault.decrypt(JSON.parse(target.secret_access_key_json) as EncryptedSecret);
    } catch (error) {
      const summary = "该备份目标的密钥无法解密，请重新填写并保存 Secret Key";
      logger.error("backup.target.failed", {
        ...logContext,
        s3Response: null,
        error: sanitizeError(error),
        elapsedMs: Date.now() - startedAt
      });
      this.store.markPlatformBackupTargetResult(target.id, "failed", summary, now());
      return { ...emptyResult, error: summary };
    }
    const client = new S3CompatClient({
      endpoint: target.endpoint,
      region: target.region,
      bucket: target.bucket,
      accessKeyId: target.access_key_id,
      secretAccessKey,
      fetchImpl: this.fetchImpl
    });
    const basePrefix = normalizeBackupPrefix(target.prefix);
    const dbPrefix = `${joinPrefix(basePrefix, BACKUP_ROOT_DIR, BACKUP_DB_DIR)}/`;
    const imagePrefix = `${joinPrefix(basePrefix, BACKUP_ROOT_DIR, BACKUP_IMAGE_DIR)}/`;
    try {
      // 1. 数据库快照：先合并 WAL，再连同主密钥一起上传（文件名带时间戳，支持后续回滚）。
      let uploadedDbFileCount = 0;
      for (const file of this.createDatabaseSnapshot()) {
        await client.putObject(`${dbPrefix}${file.key}`, file.content);
        uploadedDbFileCount += 1;
      }
      // 2. 图片增量备份：已存在的对象跳过，只上传缺失内容（图片按内容寻址，无需覆盖）。
      let uploadedImageCount = 0;
      let skippedImageCount = 0;
      if (settings.backup_images) {
        const remoteImageKeys = await client.listAllKeys(imagePrefix);
        for (const storageKey of walkAttachmentKeys(this.attachmentDirectory)) {
          const remoteKey = `${imagePrefix}${storageKey}`;
          if (remoteImageKeys.has(remoteKey)) {
            skippedImageCount += 1;
            continue;
          }
          const content = readFileSync(join(this.attachmentDirectory, storageKey));
          await client.putObject(remoteKey, content, contentTypeForStorageKey(storageKey));
          uploadedImageCount += 1;
        }
      }
      // 3. 留存清理：仅清理数据库备份，不清理图片。
      const remoteDbKeys = (await client.listObjects(dbPrefix)).map((object) => object.key);
      const pruneKeys = selectPruneKeys(remoteDbKeys, settings.retention_count);
      for (const key of pruneKeys) await client.deleteObject(key);
      const elapsedMs = Date.now() - startedAt;
      this.store.markPlatformBackupTargetResult(target.id, "success", "", now());
      logger.info("backup.target.succeeded", {
        ...logContext,
        uploadedDbFileCount,
        uploadedImageCount,
        skippedImageCount,
        prunedBackupCount: pruneKeys.length,
        elapsedMs
      });
      return {
        targetId: target.id,
        name: target.name,
        ok: true,
        error: "",
        uploadedDbFileCount,
        uploadedImageCount,
        skippedImageCount,
        prunedBackupCount: pruneKeys.length
      };
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      const summary = summarizeBackupError(error);
      const s3Response = error instanceof S3ServiceError
        ? {
          status: error.s3Status,
          code: error.s3Code,
          message: error.s3Message,
          requestId: error.s3RequestId,
          bodyText: error.s3BodyText.slice(0, 2_000)
        }
        : null;
      // 失败必须完整打印目标配置（不含 AK/SK）与 S3 服务端返回结果，禁止静默失败。
      logger.error("backup.target.failed", {
        ...logContext,
        s3Response,
        error: sanitizeError(error),
        elapsedMs
      });
      this.store.markPlatformBackupTargetResult(target.id, "failed", summary, now());
      return { ...emptyResult, error: summary };
    }
  }

  /** 生成数据库快照文件列表：WAL 合并后的主库、非空 WAL 与主密钥，文件名携带统一时间戳。 */
  private createDatabaseSnapshot(): { key: string; content: Buffer }[] {
    const timestamp = backupTimestamp();
    const files: { key: string; content: Buffer }[] = [];
    try {
      this.database.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) {
      logger.warn("backup.wal_checkpoint_failed", { error: sanitizeError(error) });
    }
    if (existsSync(this.databasePath)) {
      files.push({ key: `novel-${timestamp}.db`, content: readFileSync(this.databasePath) });
    }
    const walPath = `${this.databasePath}-wal`;
    if (existsSync(walPath) && statSync(walPath).size > 0) {
      files.push({ key: `novel-${timestamp}-wal.db`, content: readFileSync(walPath) });
    }
    if (existsSync(this.masterKeyPath)) {
      files.push({ key: `master-${timestamp}.key`, content: readFileSync(this.masterKeyPath) });
    }
    return files;
  }

  private mapSettings(row: { scheduler_enabled: number; schedule_cron: string; backup_images: number; retention_count: number; updated_at: string }): BackupSettingsView {
    return {
      schedulerEnabled: row.scheduler_enabled === 1,
      scheduleCron: row.schedule_cron,
      backupImages: row.backup_images === 1,
      retentionCount: Number(row.retention_count),
      updatedAt: String(row.updated_at)
    };
  }

  private mapTarget(row: BackupTargetRow): BackupTargetView {
    const lastStatus = row.last_status === "success" || row.last_status === "failed" ? row.last_status : null;
    return {
      id: Number(row.id),
      name: row.name,
      endpoint: row.endpoint,
      region: row.region,
      bucket: row.bucket,
      prefix: row.prefix,
      enabled: row.enabled === 1,
      hasSecretKey: Boolean(row.secret_access_key_json),
      lastBackupAt: row.last_backup_at,
      lastStatus,
      lastError: row.last_error ?? "",
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}
