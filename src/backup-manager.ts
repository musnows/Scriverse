import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { AttachmentStorage } from "./attachment-storage.js";
import { CredentialVault } from "./credential-vault.js";
import type { Database } from "./database.js";
import type { Store } from "./store.js";
import {
  maskTargetConfig,
  s3DeleteObject,
  s3HeadObject,
  s3ListObjects,
  s3PutObject,
  type S3ClientError,
  type S3PublicConfig,
  type S3TargetConfig
} from "./s3-client.js";
import { logger, sanitizeError } from "./logger.js";
import type { S3PublicTargetView, S3BackupSettingsView, S3BackupRunView } from "./domain.js";

export type BackupManagerCallbacks = {
  onTargetError?: (target: S3PublicConfig, error: S3ClientError | Error, stage: string) => void;
  onRunCompleted?: (run: S3BackupRunView) => void;
  onRunFailed?: (run: S3BackupRunView, errors: unknown[]) => void;
  onRunProgress?: (runId: string, message: string) => void;
};

type TargetFailure = {
  targetId: string;
  targetName: string;
  stage: string;
  message: string;
  serverResponse?: string;
  status?: number;
};

type CronParts = {
  minute: Set<number> | "any";
  hour: Set<number> | "any";
  dayOfMonth: Set<number> | "any";
  month: Set<number> | "any";
  dayOfWeek: Set<number> | "any";
};

function parseCronField(raw: string, min: number, max: number): Set<number> | "any" {
  const value = raw.trim();
  if (value === "*" || value === "?") return "any";
  const result = new Set<number>();
  const parts = value.split(",");
  for (const part of parts) {
    if (!part) continue;
    const stepMatch = part.match(/^(\*|\d+-\d+|\d+)\/(\d+)$/u);
    if (stepMatch && stepMatch[1] && stepMatch[2]) {
      const step = Number(stepMatch[2]);
      const rangeSrc = stepMatch[1];
      let rangeStart: number = min;
      let rangeEnd: number = max;
      if (rangeSrc !== "*") {
        if (rangeSrc.includes("-")) {
          const segments = rangeSrc.split("-");
          const a = Number(segments[0]);
          const b = Number(segments[1]);
          rangeStart = Number.isFinite(a) ? a : min;
          rangeEnd = Number.isFinite(b) ? b : max;
        } else {
          const parsed = Number(rangeSrc);
          rangeStart = Number.isFinite(parsed) ? parsed : min;
          rangeEnd = max;
        }
      }
      if (!Number.isInteger(step) || step <= 0) throw new Error(`Cron 步进无效: ${part}`);
      for (let i = rangeStart; i <= rangeEnd; i += step) {
        if (i >= min && i <= max) result.add(i);
      }
      continue;
    }
    if (part.includes("-")) {
      const segments = part.split("-");
      const a = Number(segments[0]);
      const b = Number(segments[1]);
      const start: number = Number.isFinite(a) ? a : min;
      const end: number = Number.isFinite(b) ? b : max;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
        throw new Error(`Cron 范围无效: ${part}`);
      }
      for (let i = start; i <= end; i++) result.add(i);
      continue;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Cron 值无效: ${part}`);
    result.add(n);
  }
  if (result.size === 0) return "any";
  return result;
}

function parseCron(expression: string): CronParts {
  const trimmed = expression.trim();
  const fields = trimmed.split(/\s+/u);
  if (fields.length === 6) fields.shift(); // 支持可选的秒字段，忽略它
  if (fields.length !== 5) throw new Error(`Cron 表达式必须包含 5 或 6 个字段：${trimmed}`);
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  return {
    minute: parseCronField(m, 0, 59),
    hour: parseCronField(h, 0, 23),
    dayOfMonth: parseCronField(dom, 1, 31),
    month: parseCronField(mon, 1, 12),
    dayOfWeek: parseCronField(dow, 0, 6)
  };
}

function matchesField(value: number, field: Set<number> | "any"): boolean {
  if (field === "any") return true;
  return field.has(value);
}

function computeNextRun(parts: CronParts, from: Date): Date {
  const now = new Date(from.getTime() + 60_000);
  now.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const d = new Date(now.getTime() + i * 60_000);
    const minute = d.getMinutes();
    const hour = d.getHours();
    const day = d.getDate();
    const month = d.getMonth() + 1;
    const dow = d.getDay();
    if (
      matchesField(minute, parts.minute)
      && matchesField(hour, parts.hour)
      && matchesField(day, parts.dayOfMonth)
      && matchesField(month, parts.month)
      && matchesField(dow, parts.dayOfWeek)
    ) {
      return d;
    }
  }
  return new Date(now.getTime() + 60_000);
}

const SCRIVERSE_ROOT = "scriverse";
const IMG_SUBDIR = "img";
const DB_SUBDIR = "db";

function buildTargetPrefix(subDirectory: string): string {
  const trimmed = subDirectory.replace(/^\/+|\/+$/gu, "");
  const base = trimmed ? `${trimmed}/${SCRIVERSE_ROOT}` : SCRIVERSE_ROOT;
  return base.replace(/\/{2,}/gu, "/");
}

function listImageFiles(rootDir: string): Array<{ relativePath: string; absolutePath: string; sha256Name: string }> {
  const results: Array<{ relativePath: string; absolutePath: string; sha256Name: string }> = [];
  if (!existsSync(rootDir)) return results;
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        if (entry.name.startsWith(".")) continue;
        const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLocaleLowerCase();
        if (ext !== ".webp" && ext !== ".png" && ext !== ".jpg" && ext !== ".jpeg" && ext !== ".gif") continue;
        const rel = relative(rootDir, full).split(sep).join("/");
        if (!/^[a-f0-9]{2}\/[a-f0-9]{64}\.(?:webp|png|jpe?g|gif)$/iu.test(rel)) continue;
        const sha = rel.split("/").pop()?.replace(/\.(?:webp|png|jpe?g|gif)$/iu, "") ?? "";
        results.push({ relativePath: rel, absolutePath: full, sha256Name: sha });
      }
    }
  }
  return results;
}

export class BackupManager {
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private currentRunId: string | null = null;
  private currentRunPromise: Promise<void> | null = null;
  private stopRequested = false;
  private readonly fetchImpl?: typeof fetch;

  constructor(
    readonly store: Store,
    readonly database: Database,
    readonly credentialVault: CredentialVault,
    readonly attachmentStorage: AttachmentStorage,
    readonly databasePath: string,
    readonly callbacks: BackupManagerCallbacks = {},
    fetchImpl?: typeof fetch
  ) {
    this.fetchImpl = fetchImpl;
  }

  startScheduler(): void {
    this.stopScheduler();
    this.rescheduleNext();
    this.schedulerTimer = setInterval(() => this.tick(), 30_000);
  }

  stopScheduler(): void {
    if (this.schedulerTimer !== null) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    this.stopRequested = true;
  }

  close(): void {
    this.stopScheduler();
  }

  notifyConfigChanged(): void {
    this.rescheduleNext();
  }

  getCurrentRun(): S3BackupRunView | null {
    if (!this.currentRunId) return null;
    try {
      return this.store.getS3BackupRun(this.currentRunId);
    } catch {
      return null;
    }
  }

  getNextRunAt(): string | null {
    try {
      const settings = this.store.getS3BackupSettings();
      return settings.nextRunAt;
    } catch {
      return null;
    }
  }

  private rescheduleNext(): void {
    try {
      const settings = this.store.getS3BackupSettings();
      if (!settings.scheduleEnabled) {
        this.store.updateS3BackupSettings({ nextRunAt: null });
        return;
      }
      const parts = parseCron(settings.scheduleCron);
      const next = computeNextRun(parts, new Date());
      this.store.updateS3BackupSettings({ nextRunAt: next.toISOString() });
    } catch (error) {
      logger.error("backup.schedule.reschedule_failed", { error: sanitizeError(error) });
    }
  }

  private tick(): void {
    try {
      const settings = this.store.getS3BackupSettings();
      if (!settings.scheduleEnabled) return;
      if (!settings.nextRunAt) {
        this.rescheduleNext();
        return;
      }
      const next = new Date(settings.nextRunAt).getTime();
      if (Number.isFinite(next) && Date.now() >= next) {
        void this.runBackup({ source: "schedule" });
      }
    } catch (error) {
      logger.error("backup.schedule.tick_failed", { error: sanitizeError(error) });
    }
  }

  async runBackup(options: { source?: "manual" | "schedule"; includeImagesOverride?: boolean } = {}): Promise<S3BackupRunView> {
    if (this.currentRunId) {
      const current = this.store.getS3BackupRun(this.currentRunId);
      if (current && current.status === "running") {
        throw new Error("已有备份任务正在运行，请稍后再试");
      }
    }
    const settings = this.store.getS3BackupSettings();
    const includeImages = options.includeImagesOverride ?? settings.backupImages;
    const targets = this.store.listS3Targets().filter((t) => t.enabled);
    const runId = this.store.createS3BackupRun({
      status: "running",
      includeImages,
      targets: targets.map((t) => ({ id: t.id, name: t.name }))
    });
    this.currentRunId = runId;
    const runPromise = this.executeRun(runId, includeImages, targets, settings.retentionCount);
    this.currentRunPromise = runPromise;
    const safePromise = runPromise.catch((error) => {
      logger.error("backup.run.unexpected_error", { runId, error: sanitizeError(error) });
    });
    void safePromise.then(() => {
      if (this.currentRunId === runId) {
        this.currentRunId = null;
        this.currentRunPromise = null;
      }
      this.rescheduleNext();
    });
    return this.store.getS3BackupRun(runId);
  }

  async waitForRun(runId: string): Promise<S3BackupRunView> {
    if (this.currentRunId === runId && this.currentRunPromise) {
      await this.currentRunPromise;
    }
    return this.store.getS3BackupRun(runId);
  }

  private async executeRun(
    runId: string,
    includeImages: boolean,
    targets: S3PublicTargetView[],
    retentionCount: number
  ): Promise<void> {
    const failures: TargetFailure[] = [];
    const perTargetDetail: Record<string, { uploadedImages: number; skippedImages: number; dbUploaded: boolean; purged: number; errors: number }> = {};
    let totalImages = 0;
    let totalUploadedImages = 0;
    let totalSkippedImages = 0;
    let totalDbSynced = 0;
    let totalPurged = 0;
    const startedAt = new Date();

    const reportProgress = (message: string): void => {
      this.callbacks.onRunProgress?.(runId, message);
      logger.info("backup.progress", { runId, message });
    };

    try {
      reportProgress(`备份任务启动，目标 ${targets.length} 个${includeImages ? "，包含图片" : "，仅数据库"}`);

      const imageFiles = includeImages ? listImageFiles(this.attachmentStorage.rootDirectory) : [];
      totalImages = imageFiles.length;

      const dbSnapshotPath = await this.createDatabaseSnapshot();
      reportProgress(`数据库快照已创建：${basename(dbSnapshotPath)}`);

      const decryptedTargets: Array<{ view: S3PublicTargetView; config: S3TargetConfig }> = [];
      for (const view of targets) {
        try {
          const config = this.store.decryptS3TargetCredentials(this.credentialVault, view.id);
          decryptedTargets.push({ view, config });
        } catch (error) {
          failures.push({
            targetId: view.id,
            targetName: view.name,
            stage: "decrypt_credentials",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }

      for (const { view, config } of decryptedTargets) {
        const prefix = buildTargetPrefix(config.subDirectory);
        const detail = { uploadedImages: 0, skippedImages: 0, dbUploaded: false, purged: 0, errors: 0 };
        perTargetDetail[view.id] = detail;

        if (includeImages) {
          const imgPrefix = `${prefix}/${IMG_SUBDIR}/`;
          reportProgress(`目标 [${view.name}] 开始同步图片：共 ${imageFiles.length} 张`);
          for (const img of imageFiles) {
            if (this.stopRequested) break;
            const key = `${imgPrefix}${img.relativePath}`;
            try {
              const head = await s3HeadObject(config, key, this.fetchImpl);
              if (head.exists) {
                detail.skippedImages += 1;
                totalSkippedImages += 1;
                continue;
              }
              const body = readFileSync(img.absolutePath);
              const ext = img.absolutePath.slice(img.absolutePath.lastIndexOf(".")).toLocaleLowerCase();
              const mime = ext === ".png" ? "image/png"
                : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
                  : ext === ".gif" ? "image/gif" : "image/webp";
              await s3PutObject(config, key, body, mime, this.fetchImpl);
              detail.uploadedImages += 1;
              totalUploadedImages += 1;
            } catch (error) {
              detail.errors += 1;
              const clientError = this.asClientError(error);
              failures.push({
                targetId: view.id,
                targetName: view.name,
                stage: "upload_image",
                message: error instanceof Error ? error.message : String(error),
                serverResponse: clientError?.responseBody,
                status: clientError?.status
              });
              this.callbacks.onTargetError?.(clientError?.config ?? maskTargetConfig(config), error as Error, "upload_image");
              logger.error("backup.target.image.failed", {
                runId,
                target: maskTargetConfig(config),
                key,
                error: sanitizeError(error)
              });
            }
          }
          this.store.updateS3BackupRunProgress(runId, {
            totalImages,
            uploadedImages: totalUploadedImages,
            skippedImages: totalSkippedImages
          });
        }

        try {
          const dbPrefix = `${prefix}/${DB_SUBDIR}/`;
          const dbKey = `${dbPrefix}${basename(dbSnapshotPath)}`;
          const body = readFileSync(dbSnapshotPath);
          await s3PutObject(config, dbKey, body, "application/vnd.sqlite3", this.fetchImpl);
          detail.dbUploaded = true;
          totalDbSynced += 1;
          reportProgress(`目标 [${view.name}] 数据库备份完成`);
        } catch (error) {
          detail.errors += 1;
          const clientError = this.asClientError(error);
          failures.push({
            targetId: view.id,
            targetName: view.name,
            stage: "upload_database",
            message: error instanceof Error ? error.message : String(error),
            serverResponse: clientError?.responseBody,
            status: clientError?.status
          });
          this.callbacks.onTargetError?.(clientError?.config ?? maskTargetConfig(config), error as Error, "upload_database");
          logger.error("backup.target.database.failed", {
            runId,
            target: maskTargetConfig(config),
            error: sanitizeError(error)
          });
        }

        if (detail.dbUploaded && retentionCount > 0) {
          try {
            const dbPrefix = `${buildTargetPrefix(config.subDirectory)}/${DB_SUBDIR}/`;
            const objects = await s3ListObjects(config, dbPrefix, this.fetchImpl);
            const dbFiles = objects
              .filter((o) => o.key.endsWith(".db") || o.key.endsWith(".db-wal") || o.key.endsWith(".db-shm"))
              .map((o) => ({ ...o, prefixOnly: o.key.replace(/\.(db|db-wal|db-shm)$/u, "") }));
            const uniquePrefixes = Array.from(new Map(dbFiles.map((o) => [o.prefixOnly, o.lastModified ?? ""])).entries())
              .sort((a, b) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
              .map(([prefix]) => prefix);
            const toRemove = uniquePrefixes.slice(0, Math.max(0, uniquePrefixes.length - retentionCount));
            for (const removePrefix of toRemove) {
              for (const suffix of [".db", ".db-wal", ".db-shm"]) {
                const candidate = `${removePrefix}${suffix}`;
                if (dbFiles.some((f) => f.key === candidate)) {
                  try {
                    await s3DeleteObject(config, candidate, this.fetchImpl);
                    detail.purged += 1;
                    totalPurged += 1;
                  } catch (error) {
                    detail.errors += 1;
                    const clientError = this.asClientError(error);
                    failures.push({
                      targetId: view.id,
                      targetName: view.name,
                      stage: "purge_old_backup",
                      message: error instanceof Error ? error.message : String(error),
                      serverResponse: clientError?.responseBody,
                      status: clientError?.status
                    });
                    this.callbacks.onTargetError?.(
                      clientError?.config ?? maskTargetConfig(config),
                      error as Error,
                      "purge_old_backup"
                    );
                    logger.error("backup.target.purge.failed", {
                      runId,
                      target: maskTargetConfig(config),
                      key: candidate,
                      error: sanitizeError(error)
                    });
                  }
                }
              }
            }
            reportProgress(`目标 [${view.name}] 已清理 ${detail.purged} 个旧备份文件`);
          } catch (error) {
            detail.errors += 1;
            const clientError = this.asClientError(error);
            failures.push({
              targetId: view.id,
              targetName: view.name,
              stage: "purge_old_backup_list",
              message: error instanceof Error ? error.message : String(error),
              serverResponse: clientError?.responseBody,
              status: clientError?.status
            });
            this.callbacks.onTargetError?.(clientError?.config ?? maskTargetConfig(config), error as Error, "purge_old_backup_list");
            logger.error("backup.target.purge_list.failed", {
              runId,
              target: maskTargetConfig(config),
              error: sanitizeError(error)
            });
          }
        }
      }

      try {
        unlinkSync(dbSnapshotPath);
      } catch { /* ignore */ }

      const successTargets = Object.values(perTargetDetail).filter((d) => d.dbUploaded).length;
      const hasErrors = failures.length > 0;
      let status: "success" | "partial" | "failed" = "success";
      if (hasErrors) {
        status = successTargets > 0 ? "partial" : "failed";
      }
      const run = this.store.completeS3BackupRun(runId, {
        status,
        totalImages,
        uploadedImages: totalUploadedImages,
        skippedImages: totalSkippedImages,
        databaseSynced: totalDbSynced,
        purgedOldBackups: totalPurged,
        failures,
        detail: {
          startedAt: startedAt.toISOString(),
          completedAt: new Date().toISOString(),
          perTarget: perTargetDetail
        }
      });
      if (status === "success") {
        this.callbacks.onRunCompleted?.(run);
      } else {
        this.callbacks.onRunFailed?.(run, failures);
      }
    } catch (error) {
      logger.error("backup.run.failed", { runId, error: sanitizeError(error) });
      const run = this.store.completeS3BackupRun(runId, {
        status: "failed",
        totalImages,
        uploadedImages: totalUploadedImages,
        skippedImages: totalSkippedImages,
        databaseSynced: totalDbSynced,
        purgedOldBackups: totalPurged,
        failures: [
          ...failures,
          {
            targetId: "",
            targetName: "(整体任务)",
            stage: "execute_run",
            message: error instanceof Error ? error.message : String(error)
          }
        ],
        detail: { startedAt: startedAt.toISOString(), completedAt: new Date().toISOString() }
      });
      this.callbacks.onRunFailed?.(run, [error]);
    }
  }

  private createDatabaseSnapshot(): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const dbDir = dirname(this.databasePath);
        mkdirSync(dbDir, { recursive: true, mode: 0o700 });
        const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
        const snapshotDir = join(dbDir, ".tmp-s3-backup");
        mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
        const snapshotPath = join(snapshotDir, `novel-${timestamp}.db`);

        try {
          this.database.raw.exec(`VACUUM INTO '${snapshotPath.replace(/'/gu, "''")}'`);
        } catch {
          copyFileSync(this.databasePath, snapshotPath);
          for (const suffix of ["-wal", "-shm"]) {
            const src = `${this.databasePath}${suffix}`;
            if (existsSync(src)) {
              try { copyFileSync(src, `${snapshotPath}${suffix}`); } catch { /* ignore */ }
            }
          }
        }
        const wal = `${snapshotPath}-wal`;
        const shm = `${snapshotPath}-shm`;
        if (existsSync(wal)) {
          try { rmSync(wal, { force: true }); } catch { /* ignore */ }
        }
        if (existsSync(shm)) {
          try { rmSync(shm, { force: true }); } catch { /* ignore */ }
        }
        if (!existsSync(snapshotPath) || statSync(snapshotPath).size === 0) {
          throw new Error("数据库快照创建失败");
        }
        resolve(snapshotPath);
      } catch (error) {
        reject(error);
      }
    });
  }

  private asClientError(error: unknown): S3ClientError | null {
    if (error && typeof error === "object" && "config" in error && "message" in error) {
      return error as S3ClientError;
    }
    return null;
  }
}

export function validateCronExpression(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

export function nextRunFromCron(expression: string, from: Date = new Date()): Date {
  return computeNextRun(parseCron(expression), from);
}

// 避免 unused 警告
export const _backupDomainExports: {
  randomUUID: typeof randomUUID;
  Settings: S3BackupSettingsView;
} = {
  randomUUID,
  Settings: null as unknown as S3BackupSettingsView
};
