import { AppError } from "./errors.js";

/** 规范化备份子目录：空字符串表示桶根目录。 */
export function normalizeBackupPrefix(subdir: string | null | undefined): string {
  const cleaned = String(subdir ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "")
    .replace(/\/{2,}/gu, "/");
  if (!cleaned) return "";
  const segments = cleaned.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new AppError(400, "BACKUP_PREFIX_INVALID", "备份子目录不能包含空段或相对路径");
  }
  if (cleaned.length > 200) {
    throw new AppError(400, "BACKUP_PREFIX_INVALID", "备份子目录过长");
  }
  return cleaned;
}

/** 返回 `{prefix}/scriverse` 或 `scriverse`。 */
export function scriverseRoot(subdir: string | null | undefined): string {
  const prefix = normalizeBackupPrefix(subdir);
  return prefix ? `${prefix}/scriverse` : "scriverse";
}

export function imageObjectKey(subdir: string | null | undefined, storageKey: string): string {
  const normalizedKey = storageKey.replace(/^\/+/u, "");
  if (!normalizedKey || normalizedKey.includes("..")) {
    throw new AppError(400, "BACKUP_IMAGE_KEY_INVALID", "图片存储键无效");
  }
  return `${scriverseRoot(subdir)}/img/${normalizedKey}`;
}

export function dbObjectPrefix(subdir: string | null | undefined): string {
  return `${scriverseRoot(subdir)}/db/`;
}

export function dbObjectKey(subdir: string | null | undefined, filename: string): string {
  const safeName = filename.replace(/^\/+/u, "");
  if (!safeName || safeName.includes("/") || safeName.includes("..")) {
    throw new AppError(400, "BACKUP_DB_NAME_INVALID", "数据库备份文件名无效");
  }
  return `${dbObjectPrefix(subdir)}${safeName}`;
}

export function formatBackupDbFilename(date = new Date()): string {
  const stamp = date.toISOString().replace(/[:.]/gu, "-");
  return `novel-${stamp}.db`;
}

export function parseScheduleTime(value: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(String(value ?? "").trim());
  if (!match) {
    throw new AppError(400, "BACKUP_SCHEDULE_INVALID", "备份时间格式须为 HH:MM（24 小时制）");
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 当天尚未触发且当前本地时间已达到或超过设定时刻时返回 true。 */
export function shouldTriggerSchedule(
  scheduleTime: string,
  now: Date,
  lastTriggeredDate: string | null | undefined
): boolean {
  const { hour, minute } = parseScheduleTime(scheduleTime);
  const localDate = formatLocalDate(now);
  if (lastTriggeredDate === localDate) return false;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const targetMinutes = hour * 60 + minute;
  return currentMinutes >= targetMinutes;
}

/** 按对象键排序后，返回需要删除的过期数据库备份键（保留最新的 retentionCount 个）。 */
export function selectExpiredDbObjectKeys(keys: string[], retentionCount: number): string[] {
  const limit = Math.max(1, Math.floor(retentionCount));
  const sorted = [...keys].filter((key) => key.endsWith(".db")).sort((left, right) => left.localeCompare(right));
  if (sorted.length <= limit) return [];
  return sorted.slice(0, sorted.length - limit);
}
