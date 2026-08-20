const DEFAULT_WRITING_TIME_ZONE = "Asia/Shanghai";

type Environment = { TZ?: string };

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
};

function formatterParts(date: Date, timeZone: string, includeTime: boolean): DateParts {
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" } : {})
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    ...(includeTime ? { hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) } : {})
  };
}

function dateKeyFromParts(parts: Pick<DateParts, "year" | "month" | "day">): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function resolveWritingTimeZone(environment: Environment = process.env): string {
  const candidate = environment.TZ?.trim() || DEFAULT_WRITING_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format();
    return candidate;
  } catch {
    return DEFAULT_WRITING_TIME_ZONE;
  }
}

export function resolveServerTimeZone(
  environment: Environment = process.env,
  systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
): string {
  for (const candidate of [environment.TZ?.trim(), systemTimeZone?.trim(), DEFAULT_WRITING_TIME_ZONE]) {
    if (!candidate) continue;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format();
      return candidate;
    } catch {
      // 继续尝试服务器运行时解析出的时区或项目默认时区
    }
  }
  return DEFAULT_WRITING_TIME_ZONE;
}

/** 按服务端 TZ 格式化当前本地日期、时刻与星期，供 AI system prompt 使用。 */
export function formatServerLocalClock(date: Date = new Date(), timeZone = resolveServerTimeZone()): string {
  const parts = formatterParts(date, timeZone, true);
  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "long" }).format(date);
  const hour = String(parts.hour ?? 0).padStart(2, "0");
  const minute = String(parts.minute ?? 0).padStart(2, "0");
  return `当前时间：${dateKeyFromParts(parts)} ${hour}:${minute} ${weekday}（${timeZone}）`;
}

export function writingDateKey(date: Date, timeZone: string): string {
  return dateKeyFromParts(formatterParts(date, timeZone, false));
}

export function shiftWritingDateKey(dateKey: string, days: number): string {
  const parts = dateKey.split("-").map(Number);
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function localDateTimeToUtc(dateKey: string, timeZone: string): Date {
  const parts = dateKey.split("-").map(Number);
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  let timestamp = Date.UTC(year, month - 1, day);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = formatterParts(new Date(timestamp), timeZone, true);
    if (local.year === year && local.month === month && local.day === day && local.hour === 0 && local.minute === 0 && local.second === 0) break;
    const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    const offset = localAsUtc - timestamp;
    timestamp -= offset;
  }
  return new Date(timestamp);
}

export function buildWritingCalendar(now: Date, days: number, timeZone = resolveWritingTimeZone()): {
  timeZone: string;
  dateKeys: string[];
  startKey: string;
  startInclusive: string;
  endExclusive: string;
} {
  const periodDays = Math.max(1, Math.floor(days));
  const todayKey = writingDateKey(now, timeZone);
  const startKey = shiftWritingDateKey(todayKey, -periodDays + 1);
  const dateKeys = Array.from({ length: periodDays }, (_, index) => shiftWritingDateKey(startKey, index));
  return {
    timeZone,
    dateKeys,
    startKey,
    startInclusive: localDateTimeToUtc(startKey, timeZone).toISOString(),
    endExclusive: localDateTimeToUtc(shiftWritingDateKey(todayKey, 1), timeZone).toISOString()
  };
}

export function buildWritingMonthCalendar(now: Date, timeZone = resolveWritingTimeZone()): {
  timeZone: string;
  monthKey: string;
  startKey: string;
  startInclusive: string;
  endExclusive: string;
} {
  const todayKey = writingDateKey(now, timeZone);
  const monthKey = todayKey.slice(0, 7);
  const startKey = `${monthKey}-01`;
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const nextMonthKey = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  return {
    timeZone,
    monthKey,
    startKey,
    startInclusive: localDateTimeToUtc(startKey, timeZone).toISOString(),
    endExclusive: localDateTimeToUtc(nextMonthKey, timeZone).toISOString()
  };
}
