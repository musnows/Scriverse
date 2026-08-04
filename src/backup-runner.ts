/**
 * 备份定时调度器。
 *
 * 行为：
 * - 通过 config.snapshotDirectory 准备快照；
 * - 显式 {@link BackupScheduler.triggerTarget} 用于"立即备份"；
 * - 定时 {@link BackupScheduler.start} 对所有启用目标按其 `scheduleHour`/`scheduleMinute`
 *   触发一次；下一个整点过后 ±30s 才会再触发；
 * - 单目标失败不影响其它目标继续运行；
 * - 内存数据库或开发环境跳过启动（避免挂测试）。
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "./logger.js";
import { sanitizeError } from "./logger.js";
import {
  BackupFailure,
  materializeBackupConfig,
  runBackupToTarget,
  safeLogConfigForTarget,
  type BackupS3Like,
  type RunBackupResult
} from "./backup-service.js";

export type BackupManagerContext = {
  store: {
    listPlatformBackupTargetsForScheduler(): Record<string, unknown>[];
    listPlatformBackupTargets(): Record<string, unknown>[];
    decryptPlatformBackupSecretAccessKey(row: { encrypted_secret_access_key: unknown; secret_iv: unknown; secret_tag: unknown }): string | null;
    readPlatformBackupTargetForBackup(targetId: string): {
      public: Record<string, unknown>;
      secretAccessKey: string | null;
    } | null;
    recordPlatformBackupRun(input: {
      targetId: string;
      triggeredBy: "schedule" | "manual";
      status: "succeeded" | "failed" | "partial";
      startedAt: string;
      completedAt: string;
      uploadedImageCount: number;
      skippedImageCount: number;
      deletedDbBackupCount: number;
      uploadedDbKey: string | null;
      uploadedDbSize: number | null;
      errorMessage: string | null;
    }): Record<string, unknown>;
  };
  databasePath: string;
  attachmentDirectory: string;
  snapshotDirectory: string;
  /** 可选：在内存数据库或开发环境下不启动定时 */
  enabled: boolean;
  /** 可选：用 mock S3 替换真实客户端（仅测试） */
  s3Factory?: (options: {
    endpoint: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    pathStyle: boolean;
  }) => BackupS3Like;
  now?: () => Date;
};

export class BackupScheduler {
  private readonly context: BackupManagerContext;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private running = false;
  private currentClock: () => Date;
  private readonly minimumGapMs = 30_000;
  private lastScheduledRunAt = 0;

  constructor(context: BackupManagerContext) {
    this.context = context;
    this.currentClock = context.now ?? (() => new Date());
  }

  start(): void {
    if (!this.context.enabled) {
      logger.info("backup.scheduler.disabled", { reason: "scheduler_disabled_for_environment" });
      return;
    }
    if (this.timer) return;
    this.stopping = false;
    this.scheduleNext();
    logger.info("backup.scheduler.started");
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info("backup.scheduler.stopped");
  }

  /**
   * 立即触发单个目标的备份。供 API "POST /api/platform/backup/run" 调用。
   * 同一目标已有备份运行中时跳过；不同目标可并行触发。
   */
  async triggerTarget(targetId: string, source: "manual" | "schedule" = "manual"): Promise<RunBackupResult> {
    const target = this.context.store.readPlatformBackupTargetForBackup(targetId);
    if (!target) {
      throw new Error(`备份目标 ${targetId} 不存在或已被删除`);
    }
    const publicConfig = target.public;
    if (!publicConfig.enabled) {
      throw new Error("备份目标未启用，无法立即运行");
    }
    if (!target.secretAccessKey) {
      throw new Error("备份目标缺少有效的 secretAccessKey，无法执行备份");
    }
    const secretAccessKey = target.secretAccessKey;
    const config = materializeBackupConfig({
      id: String(publicConfig.id),
      endpoint: String(publicConfig.endpoint),
      bucket: String(publicConfig.bucket),
      region: String(publicConfig.region),
      prefix: String(publicConfig.prefix),
      accessKeyId: String(publicConfig.accessKeyId),
      secretAccessKey,
      pathStyle: Boolean(publicConfig.pathStyle),
      backupImages: Boolean(publicConfig.backupImages),
      retentionCount: Number(publicConfig.retentionCount)
    });
    return this.executeForTarget(publicConfig, config, source);
  }

  private async executeForTarget(target: Record<string, unknown>, normalizedConfig: Parameters<typeof runBackupToTarget>[0]["config"], source: "manual" | "schedule"): Promise<RunBackupResult> {
    const safeLog = safeLogConfigForTarget({
      id: String(target.id),
      displayName: String(target.displayName ?? ""),
      endpoint: String(target.endpoint),
      bucket: String(target.bucket),
      region: String(target.region),
      prefix: String(target.prefix),
      pathStyle: Boolean(target.pathStyle),
      backupImages: Boolean(target.backupImages),
      retentionCount: Number(target.retentionCount),
      scheduleHour: Number(target.scheduleHour),
      scheduleMinute: Number(target.scheduleMinute),
      enabled: Boolean(target.enabled),
      accessKeyId: String(target.accessKeyId),
      secretKeyHint: String(target.secretKeyHint ?? "")
    });
    if (this.running) {
      logger.warn("backup.target.busy", { target: safeLog });
      throw new Error("已有其它备份任务正在运行");
    }
    this.running = true;
    const startedAt = this.currentClock().toISOString();
    try {
      await mkdir(dirname(this.context.snapshotDirectory), { recursive: true, mode: 0o700 });
      const s3 = this.context.s3Factory?.({
        endpoint: normalizedConfig.endpoint,
        bucket: normalizedConfig.bucket,
        region: normalizedConfig.region,
        accessKeyId: normalizedConfig.accessKeyId,
        secretAccessKey: normalizedConfig.secretAccessKey,
        pathStyle: normalizedConfig.pathStyle
      });
      const result = await runBackupToTarget({
        config: normalizedConfig,
        databasePath: this.context.databasePath,
        attachmentRoot: this.context.attachmentDirectory,
        snapshotDirectory: this.context.snapshotDirectory,
        ...(s3 ? { s3 } : {})
      });
      this.context.store.recordPlatformBackupRun({
        targetId: String(target.id),
        triggeredBy: source,
        status: "succeeded",
        startedAt,
        completedAt: result.completedAt,
        uploadedImageCount: result.uploadedImageCount,
        skippedImageCount: result.skippedImageCount,
        deletedDbBackupCount: result.deletedDbBackupCount,
        uploadedDbKey: result.uploadedDbKey,
        uploadedDbSize: result.uploadedDbSize,
        errorMessage: null
      });
      logger.info("backup.run.completed", {
        target: safeLog,
        uploadedImageCount: result.uploadedImageCount,
        skippedImageCount: result.skippedImageCount,
        deletedDbBackupCount: result.deletedDbBackupCount,
        uploadedDbKey: result.uploadedDbKey,
        uploadedDbSize: result.uploadedDbSize,
        trigger: source
      });
      this.lastScheduledRunAt = Date.now();
      return result;
    } catch (error) {
      const completedAt = this.currentClock().toISOString();
      const message = error instanceof BackupFailure ? error.message : error instanceof Error ? error.message : String(error);
      const kind = error instanceof BackupFailure ? error.kind : "snapshot_failed";
      logger.error("backup.run.failed", {
        target: safeLog,
        kind,
        message: safeFailureMessage(message),
        status: error instanceof BackupFailure ? error.status : undefined,
        requestId: error instanceof BackupFailure ? error.requestId : undefined,
        error: error instanceof Error ? sanitizeError(error) : undefined
      });
      try {
        this.context.store.recordPlatformBackupRun({
          targetId: String(target.id),
          triggeredBy: source,
          status: "failed",
          startedAt,
          completedAt,
          uploadedImageCount: 0,
          skippedImageCount: 0,
          deletedDbBackupCount: 0,
          uploadedDbKey: null,
          uploadedDbSize: null,
          errorMessage: message
        });
      } catch (recordError) {
        logger.warn("backup.run.record_failed", { error: sanitizeError(recordError) });
      }
      throw new BackupFailure({
        kind,
        message,
        exposeToClient: false
      });
    } finally {
      this.running = false;
    }
  }

  private scheduleNext(): void {
    if (this.stopping) return;
    const next = this.computeNextFireDelay();
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (this.stopping) return;
      try {
        await this.tick();
      } catch (error) {
        logger.warn("backup.scheduler.tick_error", { error: sanitizeError(error) });
      } finally {
        this.scheduleNext();
      }
    }, next);
    logger.debug("backup.scheduler.next_tick", { delayMs: next });
  }

  private computeNextFireDelay(): number {
    const now = this.currentClock();
    const nowMs = now.getTime();
    const targets = this.context.store.listPlatformBackupTargetsForScheduler();
    let nextDelay = 60 * 60_000; // 默认 1 小时兜底
    for (const target of targets) {
      const hour = Number(target.scheduleHour);
      const minute = Number(target.scheduleMinute);
      const nextRun = nextOccurrenceFrom(now, hour, minute);
      const delay = Math.max(1_000, nextRun.getTime() - nowMs);
      if (delay < nextDelay) nextDelay = delay;
    }
    if (this.lastScheduledRunAt > 0 && nextDelay < this.minimumGapMs) {
      return this.minimumGapMs;
    }
    return nextDelay;
  }

  private async tick(): Promise<void> {
    const now = this.currentClock();
    const targets = this.context.store.listPlatformBackupTargetsForScheduler();
    for (const target of targets) {
      const hour = Number(target.scheduleHour);
      const minute = Number(target.scheduleMinute);
      if (!withinMatchWindow(now, hour, minute)) continue;
      try {
        await this.triggerTarget(String(target.id), "schedule");
      } catch (error) {
        logger.warn("backup.scheduler.target_failed", {
          targetId: String(target.id),
          error: sanitizeError(error)
        });
      }
    }
  }
}

function nextOccurrenceFrom(now: Date, hour: number, minute: number): Date {
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

function withinMatchWindow(now: Date, hour: number, minute: number, windowMinutes = 5): boolean {
  const occurrence = new Date(now);
  occurrence.setHours(hour, minute, 0, 0);
  let candidate = occurrence;
  if (candidate.getTime() > now.getTime() + 60_000) {
    // 还没到当天/下一次触发，不算在窗口内
    return false;
  }
  let previous = new Date(candidate);
  if (candidate.getTime() > now.getTime()) previous.setDate(previous.getDate() - 1);
  if (Math.abs(now.getTime() - previous.getTime()) <= windowMinutes * 60_000) return true;
  return false;
}

function safeFailureMessage(message: string): string {
  // 在写日志前二次清理，避免日志框架注入任何被认为"敏感"的内容
  return message.slice(0, 4_000);
}
