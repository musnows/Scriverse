import { AppError } from "./errors.js";

const scheduleTimePattern = /^([01]\d|2[0-3]):([0-5]\d)$/u;
const databaseBackupNamePattern = /^novel-\d{8}T\d{6}Z\.db$/u;

export function normalizeS3Prefix(value: string): string {
  const trimmed = value.trim().replaceAll("\\", "/").replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (!trimmed) return "";
  if (trimmed.length > 200) throw new AppError(400, "INVALID_S3_PREFIX", "S3 子目录最长 200 个字符");
  const parts = trimmed.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new AppError(400, "INVALID_S3_PREFIX", "S3 子目录不能包含空段或相对路径");
  }
  return parts.join("/");
}

export function scriverseBackupRoot(prefix: string): string {
  const normalized = normalizeS3Prefix(prefix);
  return normalized ? `${normalized}/scriverse` : "scriverse";
}

export function s3ImageObjectKey(prefix: string, storageKey: string): string {
  return `${scriverseBackupRoot(prefix)}/img/${storageKey}`;
}

export function s3DatabaseObjectPrefix(prefix: string): string {
  return `${scriverseBackupRoot(prefix)}/db/`;
}

export function s3DatabaseFileName(at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  return `novel-${stamp}.db`;
}

export function s3DatabaseObjectKey(prefix: string, fileName: string): string {
  return `${s3DatabaseObjectPrefix(prefix)}${fileName}`;
}

export function isDatabaseBackupFileName(fileName: string): boolean {
  return databaseBackupNamePattern.test(fileName);
}

export function parseScheduleTime(value: string): { hours: number; minutes: number } {
  const matched = scheduleTimePattern.exec(value.trim());
  if (!matched) throw new AppError(400, "INVALID_BACKUP_SCHEDULE", "备份触发时间必须是 HH:MM");
  return { hours: Number(matched[1]), minutes: Number(matched[2]) };
}

export function millisecondsUntilSchedule(scheduleTime: string, now = new Date()): number {
  const { hours, minutes } = parseScheduleTime(scheduleTime);
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function shouldRunMissedSchedule(scheduleTime: string, lastRunAt: string | null, now = new Date()): boolean {
  const { hours, minutes } = parseScheduleTime(scheduleTime);
  const todayRun = new Date(now);
  todayRun.setSeconds(0, 0);
  todayRun.setHours(hours, minutes, 0, 0);
  if (now.getTime() < todayRun.getTime()) return false;
  if (!lastRunAt) return true;
  const lastRun = new Date(lastRunAt);
  return Number.isNaN(lastRun.getTime()) || lastRun.getTime() < todayRun.getTime();
}

export function selectDatabaseBackupsToDelete(objectKeys: string[], retentionCount: number): string[] {
  const keep = Math.max(1, Math.trunc(retentionCount));
  const backups = objectKeys
    .map((key) => ({ key, fileName: key.split("/").pop() ?? "" }))
    .filter((item) => isDatabaseBackupFileName(item.fileName))
    .sort((left, right) => right.fileName.localeCompare(left.fileName));
  return backups.slice(keep).map((item) => item.key);
}

export function decodeXmlText(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function parseS3ListResult(xml: string): { keys: string[]; truncated: boolean; continuationToken: string | null } {
  const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/gu)].map((match) => decodeXmlText(match[1] ?? ""));
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/iu.test(xml);
  const token = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/u)?.[1];
  return {
    keys,
    truncated,
    continuationToken: token ? decodeXmlText(token) : null
  };
}

export function parseS3ErrorResult(xml: string): { code: string; message: string } {
  const code = decodeXmlText(xml.match(/<Code>([^<]*)<\/Code>/u)?.[1] ?? "");
  const message = decodeXmlText(xml.match(/<Message>([^<]*)<\/Message>/u)?.[1] ?? xml.trim());
  return { code, message };
}
