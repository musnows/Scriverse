export type CronField = {
  values: number[];
};

export type ParsedCron = {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
};

export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronParseError";
  }
}

const FIELD_RANGES = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 7 }
] as const;

function parseField(expression: string, range: { min: number; max: number }, fieldName: string): number[] {
  const result = new Set<number>();
  for (const part of expression.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) throw new CronParseError(`cron ${fieldName} 字段为空`);
    if (trimmed === "*") {
      for (let value = range.min; value <= range.max; value += 1) result.add(value);
      continue;
    }
    const stepMatch = /^\*\/(\d+)$/u.exec(trimmed);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      if (!Number.isInteger(step) || step < 1) throw new CronParseError(`cron ${fieldName} 步长无效：${trimmed}`);
      for (let value = range.min; value <= range.max; value += step) result.add(value);
      continue;
    }
    const rangeStepMatch = /^(\d+)-(\d+)\/(\d+)$/u.exec(trimmed);
    if (rangeStepMatch) {
      const start = Number(rangeStepMatch[1]);
      const end = Number(rangeStepMatch[2]);
      const step = Number(rangeStepMatch[3]);
      if (start < range.min || end > range.max || start > end || step < 1) {
        throw new CronParseError(`cron ${fieldName} 范围步长无效：${trimmed}`);
      }
      for (let value = start; value <= end; value += step) result.add(value);
      continue;
    }
    const rangeMatch = /^(\d+)-(\d+)$/u.exec(trimmed);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start < range.min || end > range.max || start > end) {
        throw new CronParseError(`cron ${fieldName} 范围无效：${trimmed}`);
      }
      for (let value = start; value <= end; value += 1) result.add(value);
      continue;
    }
    const stepFromValueMatch = /^(\d+)\/(\d+)$/u.exec(trimmed);
    if (stepFromValueMatch) {
      const start = Number(stepFromValueMatch[1]);
      const step = Number(stepFromValueMatch[2]);
      if (start < range.min || start > range.max || step < 1) {
        throw new CronParseError(`cron ${fieldName} 步长无效：${trimmed}`);
      }
      for (let value = start; value <= range.max; value += step) result.add(value);
      continue;
    }
    if (/^\d+$/u.test(trimmed)) {
      const value = Number(trimmed);
      if (value < range.min || value > range.max) {
        throw new CronParseError(`cron ${fieldName} 数值超出范围：${trimmed}`);
      }
      result.add(value);
      continue;
    }
    throw new CronParseError(`cron ${fieldName} 字段格式无法识别：${trimmed}`);
  }
  return [...result].sort((a, b) => a - b);
}

export function parseCron(expression: string): ParsedCron {
  const trimmed = expression.trim();
  if (!trimmed) throw new CronParseError("cron 表达式为空");
  const fields = trimmed.split(/\s+/u);
  if (fields.length !== 5) throw new CronParseError(`cron 表达式必须包含 5 个字段，实际为 ${fields.length} 个`);
  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = fields as [string, string, string, string, string];
  const [minuteRange, hourRange, dayOfMonthRange, monthRange, dayOfWeekRange] = FIELD_RANGES;
  const parsed: ParsedCron = {
    minute: { values: parseField(minuteField, minuteRange, "minute") },
    hour: { values: parseField(hourField, hourRange, "hour") },
    dayOfMonth: { values: parseField(dayOfMonthField, dayOfMonthRange, "dayOfMonth") },
    month: { values: parseField(monthField, monthRange, "month") },
    dayOfWeek: { values: parseField(dayOfWeekField, dayOfWeekRange, "dayOfWeek") }
  };
  // 周日可以是 0 或 7，统一为 0
  parsed.dayOfWeek.values = parsed.dayOfWeek.values.map((value) => (value === 7 ? 0 : value));
  return parsed;
}

export function cronMatches(parsed: ParsedCron, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();
  if (!parsed.minute.values.includes(minute)) return false;
  if (!parsed.hour.values.includes(hour)) return false;
  if (!parsed.month.values.includes(month)) return false;
  // S3/cron 语义：dayOfMonth 和 dayOfWeek 同时为 * 时按 OR，否则按 AND。
  const domRange = FIELD_RANGES[2];
  const dowRange = FIELD_RANGES[4];
  const domAny = parsed.dayOfMonth.values.length === domRange.max - domRange.min + 1;
  const dowAny = parsed.dayOfWeek.values.length === dowRange.max - dowRange.min + 1;
  const domMatch = parsed.dayOfMonth.values.includes(dayOfMonth);
  const dowMatch = parsed.dayOfWeek.values.includes(dayOfWeek);
  if (domAny && dowAny) return true;
  if (domAny) return dowMatch;
  if (dowAny) return domMatch;
  return domMatch || dowMatch;
}

export function buildDailyCron(hour: number, minute: number): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new CronParseError("小时必须在 0-23 之间");
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new CronParseError("分钟必须在 0-59 之间");
  return `${minute} ${hour} * * *`;
}

export function buildIntervalCron(hours: number): string {
  if (!Number.isInteger(hours) || hours < 1 || hours > 23) throw new CronParseError("间隔小时必须在 1-23 之间");
  return `0 */${hours} * * *`;
}
