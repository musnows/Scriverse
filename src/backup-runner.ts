import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "./database.js";
import type { Store } from "./store.js";
import { createS3Client, S3RequestError, type S3Target } from "./s3-client.js";
import { runBackupToTarget, type BackupTargetResult } from "./backup-service.js";
import { logger as defaultLogger, sanitizeError, type Logger } from "./logger.js";

export type BackupContext = {
  store: Store;
  database: Database;
  attachmentDirectory: string;
  databasePath: string;
  logger?: Logger;
};

export type BackupTargetOutcome = BackupTargetResult & { ok: boolean; error?: string };

export type BackupRunSummary = {
  startedAt: string;
  skipped: boolean;
  reason?: string;
  targets: BackupTargetOutcome[];
};

/** 构造用于日志打印的配置副本：完整但剔除 accessKeyId 与 secretAccessKey 等凭证字段。 */
function safeConfigLog(target: S3Target & { label: string; subDirectory?: string }): Record<string, unknown> {
  return {
    label: target.label,
    endpoint: target.endpoint,
    region: target.region,
    bucket: target.bucket,
    subDirectory: target.subDirectory ?? "",
    addressStyle: target.addressStyle ?? "path"
  };
}

export async function runSystemBackupNow(context: BackupContext): Promise<BackupRunSummary> {
  const log = context.logger ?? defaultLogger;
  const startedAt = new Date().toISOString();
  const settings = context.store.getDecryptedBackupSettings();
  const enabledTargets = settings.targets.filter((target) => target.enabled && target.endpoint && target.bucket);
  if (enabledTargets.length === 0) {
    log.info("backup.skipped", { reason: "no_enabled_targets" });
    return { startedAt, skipped: true, reason: "no_enabled_targets", targets: [] };
  }

  const snapshotDir = mkdtempSync(join(tmpdir(), "scriverse-backup-"));
  const snapshotPath = join(snapshotDir, "novel-snapshot.db");
  const summary: BackupRunSummary = { startedAt, skipped: false, targets: [] };
  try {
    try {
      context.database.snapshotToFile(snapshotPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("backup.snapshot_failed", { error: sanitizeError(error) });
      context.store.createSystemNotification("backup-failure", `数据库快照生成失败，未执行任何远程备份：${message}`);
      return summary;
    }

    for (const target of enabledTargets) {
      const s3Target: S3Target = {
        endpoint: target.endpoint,
        region: target.region,
        bucket: target.bucket,
        accessKeyId: target.accessKeyId,
        secretAccessKey: target.secretAccessKey,
        addressStyle: "path"
      };
      const meta = { label: target.name || target.bucket, subDirectory: target.subDirectory };
      try {
        const result = await runBackupToTarget({
          client: createS3Client(s3Target),
          meta,
          dbSnapshotPath: snapshotPath,
          attachmentDirectory: context.attachmentDirectory,
          backupImages: settings.backupImages,
          retentionCount: settings.retentionCount,
          logger: log
        });
        summary.targets.push({ ...result, ok: true });
        log.info("backup.target_succeeded", { ...result });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        const serverDetail = error instanceof S3RequestError
          ? `status=${error.status} code=${error.code} message=${error.serverMessage}`
          : "";
        // 完整打印失败配置（不含 ak/sk）与服务端返回，禁止静默失败。
        log.error("backup.target_failed", {
          ...safeConfigLog({ ...s3Target, label: meta.label, subDirectory: meta.subDirectory }),
          error: failure.message,
          serverDetail
        });
        context.store.createSystemNotification(
          "backup-failure",
          `数据备份到「${meta.label}」失败：${failure.message}${serverDetail ? `（服务端：${serverDetail}）` : ""}`
        );
        summary.targets.push({
          label: meta.label,
          uploadedImages: 0,
          skippedImages: 0,
          uploadedDb: false,
          deletedDbBackups: 0,
          ok: false,
          error: failure.message
        });
      }
    }
    return summary;
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true });
  }
}

/** 按配置时间每日触发一次系统备份的轻量调度器。 */
export class BackupScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly runNow: () => Promise<void>,
    private readonly getScheduleTime: () => string,
    private readonly logger: Logger = defaultLogger
  ) {}

  start(): void {
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const delay = this.delayUntilNext(this.getScheduleTime());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire();
    }, delay);
  }

  private async fire(): Promise<void> {
    try {
      await this.runNow();
    } catch (error) {
      this.logger.error("backup.scheduled_run_failed", { error: sanitizeError(error) });
    } finally {
      this.scheduleNext();
    }
  }

  private delayUntilNext(scheduleTime: string): number {
    const match = /^(\d{1,2}):(\d{2})$/u.exec(scheduleTime.trim());
    const hour = match ? Math.min(23, Number(match[1])) : 3;
    const minute = match ? Number(match[2]) : 0;
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }
}
