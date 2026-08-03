import { join, relative, sep } from "node:path";
import { readdirSync, statSync } from "node:fs";
import type { Logger } from "./logger.js";
import type { S3Like } from "./s3-client.js";

export type BackupTargetMeta = {
  /** 用于日志与通知的可读名称。 */
  label: string;
  /** 桶内子目录；为空时直接使用桶根目录。 */
  subDirectory: string;
};

export type BackupRunOptions = {
  client: S3Like;
  meta: BackupTargetMeta;
  /** 由调用方通过 VACUUM INTO 生成的本地数据库快照文件。 */
  dbSnapshotPath: string;
  /** 本地附件根目录（AttachmentStorage.rootDirectory）。 */
  attachmentDirectory: string;
  backupImages: boolean;
  retentionCount: number;
  logger: Logger;
};

export type BackupTargetResult = {
  label: string;
  uploadedImages: number;
  skippedImages: number;
  uploadedDb: boolean;
  deletedDbBackups: number;
};

/** 规整子目录：去除首尾斜杠，空字符串表示桶根目录。 */
export function normalizeSubDirectory(value: string): string {
  return value.trim().replace(/^\/+/u, "").replace(/\/+$/u, "");
}

/** 根据子目录生成 img/db 两个远程前缀（均落在 /scriverse 下）。 */
export function buildPrefixes(subDirectory: string): { imgPrefix: string; dbPrefix: string } {
  const sub = normalizeSubDirectory(subDirectory);
  const base = sub ? `${sub}/scriverse/` : "scriverse/";
  return { imgPrefix: `${base}img/`, dbPrefix: `${base}db/` };
}

/** 在已有远程键集合中筛选出需要新增上传的图片（已存在则跳过）。 */
export function planImageUploads(storageKeys: string[], existingRemoteKeys: Set<string>, imgPrefix: string): string[] {
  return storageKeys.filter((key) => !existingRemoteKeys.has(`${imgPrefix}${key}`));
}

/**
 * 依据留存数选出应当删除的最老数据库备份。
 * 仅识别 `novel-<时间戳>.db` 形态的文件，其余文件一律忽略，避免误删。
 */
export function selectExpiredDbBackups(dbRemoteKeys: string[], retentionCount: number): string[] {
  if (retentionCount < 1) return [];
  const timestampPattern = /^novel-([0-9TZ]+)\.db$/u;
  const dated = dbRemoteKeys
    .map((key) => {
      const name = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key;
      const match = timestampPattern.exec(name);
      return match ? { key, ts: match[1] } : null;
    })
    .filter((item): item is { key: string; ts: string } => item !== null)
    .sort((left, right) => left.ts.localeCompare(right.ts));
  if (dated.length <= retentionCount) return [];
  return dated.slice(0, dated.length - retentionCount).map((item) => item.key);
}

/** 递归收集附件目录下所有文件的相对存储键（使用 / 分隔，忽略临时目录）。 */
export function collectAttachmentStorageKeys(attachmentDirectory: string): string[] {
  const keys: string[] = [];
  const temporaryName = ".tmp";
  const walk = (directory: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === temporaryName) continue;
      const fullPath = join(directory, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        walk(fullPath);
      } else if (stats.isFile()) {
        const relativePath = relative(attachmentDirectory, fullPath);
        keys.push(relativePath.split(sep).join("/"));
      }
    }
  };
  walk(attachmentDirectory);
  return keys;
}

function guessContentType(storageKey: string): string {
  const lower = storageKey.toLowerCase();
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

/** 依次将一个目标的数据库快照与图片同步到 S3 兼容存储。 */
export async function runBackupToTarget(options: BackupRunOptions): Promise<BackupTargetResult> {
  const { client, meta, dbSnapshotPath, attachmentDirectory, backupImages, retentionCount, logger } = options;
  const { imgPrefix, dbPrefix } = buildPrefixes(meta.subDirectory);
  const result: BackupTargetResult = {
    label: meta.label,
    uploadedImages: 0,
    skippedImages: 0,
    uploadedDb: false,
    deletedDbBackups: 0
  };

  if (backupImages) {
    const storageKeys = collectAttachmentStorageKeys(attachmentDirectory);
    const existingImgKeys = new Set(await client.listObjects(imgPrefix));
    const toUpload = planImageUploads(storageKeys, existingImgKeys, imgPrefix);
    for (const storageKey of toUpload) {
      const remoteKey = `${imgPrefix}${storageKey}`;
      const localPath = join(attachmentDirectory, storageKey);
      await client.putObject(remoteKey, localPath, guessContentType(storageKey));
      result.uploadedImages += 1;
    }
    result.skippedImages = storageKeys.length - toUpload.length;
  }

  const timestamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
  const dbFileName = `novel-${timestamp}.db`;
  const dbRemoteKey = `${dbPrefix}${dbFileName}`;
  await client.putObject(dbRemoteKey, dbSnapshotPath, "application/octet-stream");
  result.uploadedDb = true;

  if (retentionCount >= 1) {
    const existingDbKeys = await client.listObjects(dbPrefix);
    const expired = selectExpiredDbBackups(existingDbKeys, retentionCount);
    if (expired.length > 0) {
      await client.deleteObjects(expired);
      result.deletedDbBackups = expired.length;
    }
  }

  logger.info("backup.target_completed", { ...result });
  return result;
}
