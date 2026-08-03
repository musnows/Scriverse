import { AppError } from "./errors.js";

const INVALID_PREFIX_MESSAGE = "子目录只能包含字母、数字和常见符号，且不能包含 . 或 .. 路径段";
const INVALID_SCHEDULE_MESSAGE = "备份时间格式必须为 HH:MM（24 小时制）";

// 备份子目录的每个路径段只允许 Unicode 字母数字和 - _ . ~，
// 从根上排除路径穿越、反斜杠、控制字符和空白等容易引发对象存储歧义的字符。
const BACKUP_SEGMENT_PATTERN = /^[\p{L}\p{N}._~-]+$/u;

/**
 * 规范化用户配置的备份子目录前缀：去掉首尾空白和首尾斜杠，按 / 分段校验。
 * 拒绝空段（连续斜杠）、.、..、反斜杠、控制字符以及白名单以外的字符。
 * 合法输入返回不带首尾斜杠的字符串，空前缀返回空字符串。
 */
export function normalizeBackupPathPrefix(input: string): string {
  const normalized = input.trim().replace(/^\/+|\/+$/gu, "");
  if (normalized === "") return "";
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || !BACKUP_SEGMENT_PATTERN.test(segment)) {
      throw new AppError(400, "INVALID_BACKUP_PATH_PREFIX", INVALID_PREFIX_MESSAGE);
    }
  }
  return segments.join("/");
}

/** 数据库备份对象在桶内的 key 前缀。 */
export function backupDbPrefix(prefix: string): string {
  return prefix === "" ? "scriverse/db/" : `${prefix}/scriverse/db/`;
}

/** 图片备份对象在桶内的 key 前缀。 */
export function backupImagePrefix(prefix: string): string {
  return prefix === "" ? "scriverse/img/" : `${prefix}/scriverse/img/`;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** 生成一次数据库备份的完整对象 key，时间部分使用 UTC，格式 scriverse-YYYYMMDD-HHmmss.db。 */
export function backupDatabaseObjectKey(prefix: string, date: Date): string {
  const stamp = `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}`
    + `-${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}`;
  return `${backupDbPrefix(prefix)}scriverse-${stamp}.db`;
}

const BACKUP_DATABASE_FILENAME = /^scriverse-\d{8}-\d{6}\.db$/u;

/** 判断给定 key 是否是当前前缀下由本系统生成的数据库备份对象。 */
export function isBackupDatabaseKey(key: string, prefix: string): boolean {
  const dbPrefix = backupDbPrefix(prefix);
  if (!key.startsWith(dbPrefix)) return false;
  return BACKUP_DATABASE_FILENAME.test(key.slice(dbPrefix.length));
}

const ascending = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 从桶内 key 列表中筛出数据库备份，按 key 字典序（时间戳命名保证字典序等于时间序）
 * 保留最新的 retentionCount 个，返回应删除的其余 key（升序输出，便于阅读）。
 * retentionCount 小于 1 时按 1 处理。
 */
export function selectExpiredBackupKeys(keys: string[], prefix: string, retentionCount: number): string[] {
  const retention = Math.max(1, Math.floor(retentionCount));
  const backupKeys = keys.filter((key) => isBackupDatabaseKey(key, prefix)).sort(ascending).reverse();
  return backupKeys.slice(retention).sort(ascending);
}

const SCHEDULE_PATTERN = /^(\d{2}):(\d{2})$/u;

/**
 * 计算从 now 到下一个每日 scheduleTime（服务器本地时间，HH:MM）的毫秒数。
 * 今天该时刻晚于 now 时取今天，否则取明天；结果恒为正。
 */
export function nextDailyRunDelayMs(scheduleTime: string, now: Date): number {
  const match = SCHEDULE_PATTERN.exec(scheduleTime);
  const hour = match ? Number(match[1]) : Number.NaN;
  const minute = match ? Number(match[2]) : Number.NaN;
  if (!match || hour > 23 || minute > 59) {
    throw new AppError(400, "INVALID_BACKUP_SCHEDULE", INVALID_SCHEDULE_MESSAGE);
  }
  const target = new Date(now.getTime());
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}
