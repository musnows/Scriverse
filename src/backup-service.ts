/**
 * 系统级数据库 + 图片 S3 备份服务的核心逻辑。
 *
 * 设计原则：
 * - 纯函数尽量可独立测试：把"路径构造 / 上传计划 / 旧备份筛选"等无副作用的部分
 *   抽离出 {@link buildPrefixes} / {@link planImageUploads} / {@link selectExpiredDbBackups}。
 * - 通过 {@link BackupS3Like} 接口注入 S3 客户端，便于单元测试使用 in-memory 模拟。
 * - 数据库快照统一使用 {@link snapshotDatabaseToFile}，调用方传入稳定的 db path。
 *
 * 失败约定：所有 S3 请求失败都必须抛出继承自 {@link BackupFailure} 的异常，其中
 * {@link exposeCredentials} 决定敏感信息是否允许返回给调用方（默认 false，绝不暴露密钥）。
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createS3Client, type S3Client } from "./s3-client.js";

export type BackupFailureKind =
  | "endpoint_invalid"
  | "credential_missing"
  | "snapshot_failed"
  | "image_listing_failed"
  | "image_not_found_local"
  | "image_upload_failed"
  | "db_upload_failed"
  | "list_failed"
  | "delete_failed"
  | "expire_selection_failed";

export class BackupFailure extends Error {
  readonly kind: BackupFailureKind;
  readonly status?: number;
  readonly requestId?: string;
  readonly exposeToClient: boolean;

  constructor(options: {
    kind: BackupFailureKind;
    message: string;
    status?: number;
    requestId?: string;
    exposeToClient?: boolean;
  }) {
    super(options.message);
    this.name = "BackupFailure";
    this.kind = options.kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    this.exposeToClient = options.exposeToClient ?? false;
  }
}

export type BackupS3Like = Pick<S3Client, "headObject" | "putObject" | "listObjects" | "deleteObjects">;

export type BackupTargetConfig = {
  id: string;
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
  backupImages: boolean;
  retentionCount: number;
};

export type BackupPathOptions = {
  /** 用户提供的子目录（例如 "prod"），可为空字符串或缺失表示桶根目录。 */
  userPrefix: string;
};

const SCRIVERSE_ROOT = "scriverse";

export function buildPrefixes(userPrefix: string): { rootPrefix: string; imagePrefix: string; dbPrefix: string } {
  const segments = [SCRIVERSE_ROOT];
  const trimmed = userPrefix.trim().replace(/^\/+|\/+$/gu, "");
  if (trimmed) {
    for (const piece of trimmed.split("/")) {
      const cleaned = piece.trim();
      if (cleaned) segments.push(cleaned);
    }
  }
  const rootPrefix = segments.join("/");
  return {
    rootPrefix,
    imagePrefix: `${rootPrefix}/img`,
    dbPrefix: `${rootPrefix}/db`
  };
}

export function buildDbBackupKey(dbPrefix: string, now: Date): string {
  // e.g. scriverse/db/database-2026-08-04T22-44-30Z.db
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  return `${dbPrefix}/database-${stamp}.db`;
}

export function buildImageKey(imagePrefix: string, storageKey: string): string {
  // 镜像 storageKey 的目录结构，避免同名冲突
  const normalized = storageKey.replace(/^\/+/u, "").replace(/\/+$/u, "");
  return `${imagePrefix}/${normalized}`;
}

export function isDatabaseBackupKey(key: string, dbPrefix: string): boolean {
  return key.startsWith(`${dbPrefix}/`) && key.endsWith(".db");
}

export function isImageBackupKey(key: string, imagePrefix: string): boolean {
  return key.startsWith(`${imagePrefix}/`);
}

export async function collectAttachmentStorageKeys(attachmentRoot: string): Promise<string[]> {
  const out: string[] = [];
  const hashDir = await readdir(attachmentRoot).catch(() => []);
  for (const part of hashDir) {
    if (part === ".tmp" || part.startsWith(".")) continue;
    if (part.length !== 2) continue;
    const target = join(attachmentRoot, part);
    const files = await readdir(target).catch(() => []);
    for (const file of files) out.push(`${part}/${file}`);
  }
  return out.sort();
}

export type ImageUploadPlan = {
  total: number;
  uploads: Array<{ storageKey: string; objectKey: string; bytes: number }>;
  skipped: Array<{ storageKey: string; objectKey: string }>;
};

export async function planImageUploads(options: {
  s3: BackupS3Like;
  storageKeys: string[];
  imagePrefix: string;
  attachmentRoot: string;
}): Promise<ImageUploadPlan> {
  const { s3, storageKeys, imagePrefix, attachmentRoot } = options;
  const uploads: ImageUploadPlan["uploads"] = [];
  const skipped: ImageUploadPlan["skipped"] = [];
  for (const storageKey of storageKeys) {
    const objectKey = buildImageKey(imagePrefix, storageKey);
    try {
      const head = await s3.headObject(objectKey);
      if (head.exists) {
        skipped.push({ storageKey, objectKey });
        continue;
      }
    } catch (error) {
      throw wrapS3Error(error, "image_listing_failed", `无法检查远端图片 ${objectKey} 是否存在`);
    }
    let bytes = 0;
    try {
      const stats = await stat(join(attachmentRoot, storageKey));
      bytes = stats.size;
    } catch (error) {
      throw new BackupFailure({
        kind: "image_not_found_local",
        message: `图片文件 ${storageKey} 在本地不存在，无法上传`,
        exposeToClient: true
      });
    }
    uploads.push({ storageKey, objectKey, bytes });
  }
  return { total: storageKeys.length, uploads, skipped };
}

export type DbBackupUploadResult = {
  dbObjectKey: string;
  size: number;
};

export async function snapshotDatabaseToFile(sourceDbPath: string, targetDbPath: string): Promise<number> {
  if (sourceDbPath === ":memory:") {
    throw new BackupFailure({ kind: "snapshot_failed", message: "内存数据库无法生成可上传快照", exposeToClient: true });
  }
  // 用 VACUUM INTO 拿到一个独立、committed 的副本：
  //   - 调用方在备份期间仍可继续写入（VACUUM INTO 读到的视图是已写入的稳定快照）。
  //   - 避免直接 cp 当前 WAL 文件时不完整。
  const database = new DatabaseSync(sourceDbPath, { readOnly: true });
  try {
    // VACUUM INTO 是单一 SQL 语句，需要通过 function 参数拼接；这里我们使用 prepared 语句并绑定字符串。
    const statement = database.prepare("VACUUM INTO ?");
    try {
      statement.run(targetDbPath);
    } catch (error) {
      throw new BackupFailure({
        kind: "snapshot_failed",
        message: `无法复制数据库到 ${targetDbPath}：${(error as Error).message}`,
        exposeToClient: true
      });
    }
  } finally {
    database.close();
  }
  const targetStats = await stat(targetDbPath).catch(() => null);
  if (!targetStats || targetStats.size === 0) {
    throw new BackupFailure({
      kind: "snapshot_failed",
      message: `数据库快照 ${targetDbPath} 为空，请检查源数据库文件`,
      exposeToClient: true
    });
  }
  return targetStats.size;
}

export async function uploadDatabaseSnapshot(options: {
  s3: BackupS3Like;
  sourceDbPath: string;
  snapshotFile: string;
  dbObjectKey: string;
  cleanupSnapshot: boolean;
}): Promise<DbBackupUploadResult> {
  const { s3, sourceDbPath, snapshotFile, dbObjectKey, cleanupSnapshot } = options;
  try {
    const bytes = await snapshotDatabaseToFile(sourceDbPath, snapshotFile);
    const body = await readFile(snapshotFile);
    try {
      await s3.putObject({ key: dbObjectKey, body, contentType: "application/octet-stream" });
    } catch (error) {
      throw wrapS3Error(error, "db_upload_failed", `无法上传数据库快照到 ${dbObjectKey}`);
    }
    return { dbObjectKey, size: bytes };
  } finally {
    if (cleanupSnapshot) {
      await rm(snapshotFile, { force: true });
    }
  }
}

/** 列出 db 目录下当前的所有备份文件，按时间戳字典序排序（最旧的在前）。 */
export async function listRemoteDbBackups(s3: BackupS3Like, dbPrefix: string): Promise<Array<{ key: string; size: number; lastModified?: string }>> {
  try {
    const result = await s3.listObjects({ prefix: `${dbPrefix}/` });
    return result.objects
      .filter((object) => isDatabaseBackupKey(object.key, dbPrefix))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  } catch (error) {
    throw wrapS3Error(error, "list_failed", `无法列出 ${dbPrefix} 下的历史备份`);
  }
}

/**
 * 决定需要删除的 db 备份 key。
 * 只删除数据库备份，不清理图片；如果新上传已经发生在该批次中，则一并跳过最新副本。
 */
export function selectExpiredDbBackups(options: {
  existing: Array<{ key: string }>;
  retentionCount: number;
  excludeKeys?: Set<string>;
}): string[] {
  if (options.retentionCount < 1) return [];
  const exclude = options.excludeKeys ?? new Set<string>();
  const sorted = options.existing.slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const protectedCount = sorted.reduce((count, item) => (exclude.has(item.key) ? count + 1 : count), 0);
  const overflowCandidates = sorted.filter((item) => !exclude.has(item.key));
  // `protectCount` 个被排除项在总数 `existing.length` 中保留的部分，留存上限中可分配给其余项的额度 = `retentionCount - protectedCount`。
  const allowanceForCandidates = options.retentionCount - protectedCount;
  if (allowanceForCandidates <= 0) return [];
  const deletionsNeeded = Math.max(0, overflowCandidates.length - allowanceForCandidates);
  return overflowCandidates.slice(0, deletionsNeeded).map((item) => item.key);
}

export type RunBackupOptions = {
  config: BackupTargetConfig;
  databasePath: string;
  attachmentRoot: string;
  /** 临时目录用来存放数据库快照；调用方需保证存在且可写。 */
  snapshotDirectory: string;
  s3?: BackupS3Like;
  now?: Date;
};

export type RunBackupResult = {
  uploadedImageCount: number;
  skippedImageCount: number;
  deletedDbBackupCount: number;
  uploadedDbKey: string;
  uploadedDbSize: number;
  trigger: "schedule" | "manual";
  startedAt: string;
  completedAt: string;
};

export async function runBackupToTarget(options: RunBackupOptions): Promise<RunBackupResult> {
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();
  const { config, databasePath, attachmentRoot, snapshotDirectory } = options;
  const prefixes = buildPrefixes(config.prefix);
  const s3 = options.s3 ?? createS3Client({
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    pathStyle: config.pathStyle
  });

  let uploadedImageCount = 0;
  let skippedImageCount = 0;
  let deletedDbBackupCount = 0;
  let uploadedDbKey = "";
  let uploadedDbSize = 0;

  try {
    await mkdir(snapshotDirectory, { recursive: true, mode: 0o700 });
    const snapshotFile = join(snapshotDirectory, `${config.id}-${now.getTime()}.db`);
    if (config.backupImages) {
      const storageKeys = await collectAttachmentStorageKeys(attachmentRoot).catch((error) => {
        throw new BackupFailure({
          kind: "image_listing_failed",
          message: `无法读取附件目录：${(error as Error).message}`,
          exposeToClient: true
        });
      });
      const plan = await planImageUploads({
        s3,
        storageKeys,
        imagePrefix: prefixes.imagePrefix,
        attachmentRoot
      });
      for (const entry of plan.uploads) {
        const body = await readFile(join(attachmentRoot, entry.storageKey)).catch((error) => {
          throw new BackupFailure({
            kind: "image_not_found_local",
            message: `图片文件 ${entry.storageKey} 在备份过程中无法读取：${(error as Error).message}`,
            exposeToClient: true
          });
        });
        try {
          await s3.putObject({
            key: entry.objectKey,
            body,
            contentType: guessContentTypeFromExtension(entry.storageKey)
          });
        } catch (error) {
          throw wrapS3Error(error, "image_upload_failed", `上传图片 ${entry.objectKey} 失败`);
        }
        uploadedImageCount += 1;
      }
      skippedImageCount = plan.skipped.length;
    }

    uploadedDbKey = buildDbBackupKey(prefixes.dbPrefix, now);
    const uploadResult = await uploadDatabaseSnapshot({
      s3,
      sourceDbPath: databasePath,
      snapshotFile,
      dbObjectKey: uploadedDbKey,
      cleanupSnapshot: true
    });
    uploadedDbSize = uploadResult.size;

    const existing = await listRemoteDbBackups(s3, prefixes.dbPrefix);
    const exclude = new Set<string>([uploadedDbKey]);
    const expired = selectExpiredDbBackups({
      existing,
      retentionCount: config.retentionCount,
      excludeKeys: exclude
    });
    if (expired.length) {
      try {
        await s3.deleteObjects(expired);
        deletedDbBackupCount = expired.length;
      } catch (error) {
        throw wrapS3Error(error, "delete_failed", `无法删除旧的数据库备份 ${expired.join(", ")}`);
      }
    }
  } finally {
    // nothing to clean up: snapshot already removed in uploadDatabaseSnapshot
  }

  const completedAt = new Date().toISOString();
  return {
    uploadedImageCount,
    skippedImageCount,
    deletedDbBackupCount,
    uploadedDbKey,
    uploadedDbSize,
    trigger: "manual",
    startedAt,
    completedAt
  };
}

export function safeLogConfigForTarget(input: {
  id: string;
  displayName?: string;
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  pathStyle?: boolean;
  backupImages?: boolean;
  retentionCount?: number;
  scheduleHour?: number;
  scheduleMinute?: number;
  enabled?: boolean;
  accessKeyId: string;
  secretKeyHint?: string;
}): Record<string, unknown> {
  // 严格只导出字面字段，避免意外把 secretAccessKey / encrypted_* 等字段泄露到日志
  return {
    targetId: input.id,
    displayName: input.displayName ?? null,
    endpoint: input.endpoint,
    bucket: input.bucket,
    region: input.region,
    prefix: input.prefix,
    pathStyle: input.pathStyle ?? null,
    backupImages: input.backupImages ?? null,
    retentionCount: input.retentionCount ?? null,
    scheduleHour: input.scheduleHour ?? null,
    scheduleMinute: input.scheduleMinute ?? null,
    enabled: input.enabled ?? null,
    accessKeyId: input.accessKeyId,
    secretKeyHint: input.secretKeyHint ?? null
  };
}

function guessContentTypeFromExtension(storageKey: string): string | undefined {
  const lower = storageKey.toLocaleLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return undefined;
}

function wrapS3Error(error: unknown, kind: BackupFailureKind, prefix: string): BackupFailure {
  if (error instanceof BackupFailure) return error;
  if (error && typeof error === "object") {
    const record = error as { status?: number; code?: string; message?: string; requestId?: string; resource?: string };
    const codeDetail = record.code ? ` [${record.code}]` : "";
    const statusDetail = typeof record.status === "number" ? ` HTTP ${record.status}` : "";
    const requestIdDetail = record.requestId ? ` x-amz-request-id=${record.requestId}` : "";
    const message = record.message ?? (error instanceof Error ? error.message : JSON.stringify(error));
    return new BackupFailure({
      kind,
      message: `${prefix}：${message}${codeDetail}${statusDetail}${requestIdDetail}`,
      status: typeof record.status === "number" ? record.status : undefined,
      requestId: record.requestId
    });
  }
  return new BackupFailure({
    kind,
    message: `${prefix}：${String(error)}`,
    exposeToClient: false
  });
}

/**
 * 工具函数：根据用户输入和数据库原始行把一个备份目标配置回填出所有必要字段。
 * secretAccessKey 字段从外部传入（必须已经是明文，因为数据库中存的是密文）。
 */
export function materializeBackupConfig(input: {
  id: string;
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
  backupImages: boolean;
  retentionCount: number;
}): BackupTargetConfig {
  return {
    id: input.id,
    endpoint: input.endpoint,
    bucket: input.bucket,
    region: input.region,
    prefix: input.prefix,
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
    pathStyle: input.pathStyle,
    backupImages: input.backupImages,
    retentionCount: input.retentionCount
  };
}

export function hashAttachmentBytes(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
