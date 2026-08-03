import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ServiceException
} from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import type { CredentialVault } from "./credential-vault.js";
import type { Database } from "./database.js";
import { AppError } from "./errors.js";
import { logger } from "./logger.js";
import { assertSafeAiEndpoint } from "./security.js";
import type { Store } from "./store.js";
import { id, now } from "./utils.js";

export type S3BackupTargetInput = {
  id?: string;
  name: string;
  enabled: boolean;
  endpoint: string;
  region?: string;
  bucket: string;
  prefix?: string;
  accessKey?: string;
  secretKey?: string;
};

export type S3BackupSettingsInput = {
  enabled?: boolean;
  backupImages?: boolean;
  scheduleTime?: string;
  retentionCount?: number;
  targets?: S3BackupTargetInput[];
};

export type S3BackupTargetPublic = {
  id: string;
  name: string;
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyHint: string;
  secretKeyHint: string;
  hasAccessKey: boolean;
  hasSecretKey: boolean;
  sortOrder: number;
};

export type S3BackupSettingsPublic = {
  enabled: boolean;
  backupImages: boolean;
  scheduleTime: string;
  retentionCount: number;
  targets: S3BackupTargetPublic[];
  lastRunAt: string;
  lastRunStatus: "idle" | "running" | "success" | "failed" | "partial";
  lastRunMessage: string;
  lastScheduledDate: string;
  pendingAlerts: string[];
  updatedAt: string;
};

export type S3BackupRunResult = {
  status: "success" | "failed" | "partial";
  message: string;
  failures: S3BackupFailure[];
};

export type S3BackupFailure = {
  targetId: string;
  targetName: string;
  config: Record<string, unknown>;
  serverResponse: string;
};

type ResolvedS3BackupTarget = S3BackupTargetPublic & {
  accessKey: string;
  secretKey: string;
};

type BackupRunOptions = {
  databasePath: string;
  attachmentDirectory: string;
  trigger: "manual" | "scheduled";
};

const attachmentKeyPattern = /^[a-f0-9]{2}\/[a-f0-9]{64}\.(?:webp|png|jpe?g|gif)$/u;
const dbBackupNamePattern = /^novel-(\d{8}-\d{6}(?:-\d{3})?)\.db$/u;

export function normalizeS3Prefix(value: string): string {
  return value.normalize("NFKC").trim().replace(/^\/+|\/+$/gu, "");
}

export function buildScriverseRoot(prefix: string): string {
  const normalized = normalizeS3Prefix(prefix);
  return normalized ? `${normalized}/scriverse` : "scriverse";
}

export function buildBackupTimestamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  const millisecond = String(date.getMilliseconds()).padStart(3, "0");
  return `${year}${month}${day}-${hour}${minute}${second}-${millisecond}`;
}

export function parseScheduleTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function credentialHint(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 4) return "****";
  return `****${trimmed.slice(-4)}`;
}

export function redactS3TargetForLog(target: S3BackupTargetPublic): Record<string, unknown> {
  return {
    id: target.id,
    name: target.name,
    enabled: target.enabled,
    endpoint: target.endpoint,
    region: target.region,
    bucket: target.bucket,
    prefix: target.prefix,
    accessKeyHint: target.accessKeyHint,
    secretKeyHint: target.secretKeyHint,
    sortOrder: target.sortOrder
  };
}

function formatS3ServiceResponse(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const record = error as S3ServiceException & {
    Code?: string;
    $metadata?: { httpStatusCode?: number; requestId?: string; extendedRequestId?: string };
  };
  return JSON.stringify({
    name: record.name,
    message: record.message,
    code: record.Code ?? record.name,
    statusCode: record.$metadata?.httpStatusCode ?? null,
    requestId: record.$metadata?.requestId ?? null,
    extendedRequestId: record.$metadata?.extendedRequestId ?? null
  });
}

async function walkAttachmentFiles(rootDirectory: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string, relative = ""): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".tmp") continue;
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const nextPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(nextPath, nextRelative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!attachmentKeyPattern.test(nextRelative)) continue;
      files.push(nextRelative);
    }
  }
  await walk(rootDirectory);
  return files;
}

export class S3BackupService {
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private runOptions: BackupRunOptions | null = null;

  constructor(
    private readonly store: Store,
    private readonly database: Database,
    private readonly vault: CredentialVault,
    private readonly allowPrivateNetwork: boolean
  ) {}

  configureRunOptions(options: BackupRunOptions): void {
    this.runOptions = options;
  }

  startScheduler(): void {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => {
      void this.checkScheduledRun();
    }, 60_000);
    void this.checkScheduledRun();
  }

  stopScheduler(): void {
    if (!this.schedulerTimer) return;
    clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
  }

  dispose(): void {
    this.stopScheduler();
  }

  async checkScheduledRun(): Promise<void> {
    if (this.running || !this.runOptions) return;
    const settings = this.store.getPlatformS3BackupSettings();
    if (!settings.enabled) return;
    const schedule = parseScheduleTime(settings.scheduleTime);
    if (!schedule) return;
    const current = new Date();
    if (current.getHours() !== schedule.hour || current.getMinutes() !== schedule.minute) return;
    const today = current.toISOString().slice(0, 10);
    if (settings.lastScheduledDate === today) return;
    this.store.updatePlatformS3BackupRunState({
      lastScheduledDate: today,
      lastRunStatus: "running",
      lastRunAt: now()
    });
    await this.runBackup("scheduled");
  }

  async runBackup(trigger: "manual" | "scheduled"): Promise<S3BackupRunResult> {
    if (!this.runOptions) {
      throw new AppError(500, "BACKUP_NOT_CONFIGURED", "备份服务尚未完成运行时配置");
    }
    if (this.running) {
      throw new AppError(409, "BACKUP_ALREADY_RUNNING", "已有备份任务正在执行");
    }
    this.running = true;
    const settings = this.store.getPlatformS3BackupSettings();
    const enabledTargets = this.store.listResolvedS3BackupTargets(this.vault).filter((target) => target.enabled);
    if (!enabledTargets.length) {
      this.running = false;
      const message = "没有启用的 S3 备份目标";
      this.store.updatePlatformS3BackupRunState({
        lastRunAt: now(),
        lastRunStatus: "failed",
        lastRunMessage: message,
        pendingAlerts: [message]
      });
      return { status: "failed", message, failures: [] };
    }

    this.store.updatePlatformS3BackupRunState({
      lastRunAt: now(),
      lastRunStatus: "running",
      lastRunMessage: trigger === "manual" ? "手动备份进行中" : "定时备份进行中"
    });

    const failures: S3BackupFailure[] = [];
    let successCount = 0;
    for (const target of enabledTargets) {
      try {
        await this.syncTarget(target, settings, this.runOptions);
        successCount += 1;
      } catch (error) {
        const failure: S3BackupFailure = {
          targetId: target.id,
          targetName: target.name,
          config: redactS3TargetForLog(target),
          serverResponse: formatS3ServiceResponse(error)
        };
        failures.push(failure);
        logger.error("backup.s3.target_failed", {
          trigger,
          target: failure.config,
          serverResponse: failure.serverResponse,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const status: S3BackupRunResult["status"] = failures.length === 0
      ? "success"
      : successCount === 0
        ? "failed"
        : "partial";
    const message = failures.length === 0
      ? `备份完成，已同步 ${successCount} 个目标`
      : failures.length === enabledTargets.length
        ? `备份失败，${failures.length} 个目标均未成功`
        : `备份部分成功：${successCount} 个成功，${failures.length} 个失败`;
    const pendingAlerts = failures.map((failure) => (
      `${failure.targetName} 备份失败：${failure.serverResponse}`
    ));

    this.store.updatePlatformS3BackupRunState({
      lastRunAt: now(),
      lastRunStatus: status,
      lastRunMessage: message,
      pendingAlerts
    });
    this.running = false;
    return { status, message, failures };
  }

  private async syncTarget(
    target: ResolvedS3BackupTarget,
    settings: S3BackupSettingsPublic,
    options: BackupRunOptions
  ): Promise<void> {
    await assertSafeAiEndpoint(target.endpoint, this.allowPrivateNetwork);
    const client = new S3Client({
      endpoint: target.endpoint,
      region: target.region || "us-east-1",
      credentials: {
        accessKeyId: target.accessKey,
        secretAccessKey: target.secretKey
      },
      forcePathStyle: true
    });
    const root = buildScriverseRoot(target.prefix);
    try {
      await this.uploadDatabase(client, target.bucket, root, options.databasePath, settings.retentionCount);
      if (settings.backupImages) {
        await this.uploadImages(client, target.bucket, root, options.attachmentDirectory);
      }
    } finally {
      client.destroy();
    }
  }

  private async uploadDatabase(
    client: S3Client,
    bucket: string,
    root: string,
    databasePath: string,
    retentionCount: number
  ): Promise<void> {
    const timestamp = buildBackupTimestamp();
    const tempDirectory = await mkdtemp(join(tmpdir(), "scriverse-db-backup-"));
    try {
      await chmod(tempDirectory, 0o700);
      this.database.run("PRAGMA wal_checkpoint(TRUNCATE)");
      const tempDatabasePath = join(tempDirectory, `novel-${timestamp}.db`);
      await copyFile(databasePath, tempDatabasePath);
      await chmod(tempDatabasePath, 0o600);
      const key = `${root}/db/novel-${timestamp}.db`;
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(tempDatabasePath),
        ContentType: "application/octet-stream"
      }));
      await this.enforceDatabaseRetention(client, bucket, root, retentionCount);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  private async enforceDatabaseRetention(
    client: S3Client,
    bucket: string,
    root: string,
    retentionCount: number
  ): Promise<void> {
    const prefix = `${root}/db/`;
    const entries: { key: string; timestamp: string }[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken
      }));
      for (const item of response.Contents ?? []) {
        if (!item.Key) continue;
        const fileName = basename(item.Key);
        const match = dbBackupNamePattern.exec(fileName);
        if (!match?.[1]) continue;
        entries.push({ key: item.Key, timestamp: match[1] });
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    entries.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
    const removable = entries.slice(retentionCount);
    for (const entry of removable) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: entry.key }));
    }
  }

  private async uploadImages(
    client: S3Client,
    bucket: string,
    root: string,
    attachmentDirectory: string
  ): Promise<void> {
    const files = await walkAttachmentFiles(attachmentDirectory);
    for (const storageKey of files) {
      const key = `${root}/img/${storageKey}`;
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        continue;
      } catch (error) {
        const record = error as S3ServiceException;
        const statusCode = record.$metadata?.httpStatusCode;
        if (statusCode !== 404 && record.name !== "NotFound" && record.name !== "NoSuchKey") {
          throw error;
        }
      }
      const localPath = join(attachmentDirectory, storageKey);
      const fileStat = await stat(localPath);
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(localPath),
        ContentLength: fileStat.size,
        ContentType: "application/octet-stream"
      }));
    }
  }
}

export function createS3BackupTargetId(): string {
  return id("s3target");
}
