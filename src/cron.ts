/**
 * 轻量 cron 表达式解析与匹配。
 * 支持标准 5 段字段：分 时 日 月 周（周 0-7，0 与 7 均表示周日）。
 * 每段支持：*、数字、a-b 区间、斜杠步长（如 * /2、a-b /2），以及逗号组合。
 * 匹配语义：五个字段全部满足时匹配（日与周取 AND，与常见守护进程不同，行为更可预期）。
 */

export type CronFieldName = "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";

export type CronExpression = Record<CronFieldName, ReadonlySet<number>>;

export const CRON_FIELDS: readonly { name: CronFieldName; label: string; min: number; max: number }[] = [
  { name: "minute", label: "分钟", min: 0, max: 59 },
  { name: "hour", label: "小时", min: 0, max: 23 },
  { name: "dayOfMonth", label: "日期", min: 1, max: 31 },
  { name: "month", label: "月份", min: 1, max: 12 },
  { name: "dayOfWeek", label: "星期", min: 0, max: 7 }
];

function parseFieldToken(token: string, field: { label: string; min: number; max: number }): ReadonlySet<number> {
  const values = new Set<number>();
  for (const part of token.split(",")) {
    if (part === "") throw new Error(`cron 字段「${field.label}」包含空项`);
    const stepMatch = /^(.+)\/(\d+)$/u.exec(part);
    const step = stepMatch?.[2] ? Number(stepMatch[2]) : 1;
    const base = stepMatch?.[1] ?? part;
    if (step < 1 || step > 100) throw new Error(`cron 字段「${field.label}」步长无效`);
    let start: number;
    let end: number;
    if (base === "*") {
      start = field.min;
      end = field.max;
    } else if (/^\d+$/u.test(base)) {
      start = Number(base);
      end = start;
    } else {
      const range = /^(\d+)-(\d+)$/u.exec(base);
      if (!range) throw new Error(`cron 字段「${field.label}」存在无法识别的片段「${part}」`);
      start = Number(range[1]);
      end = Number(range[2]);
    }
    if (Number.isNaN(start) || Number.isNaN(end)) throw new Error(`cron 字段「${field.label}」取值无效`);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < field.min || end > field.max || start > end) {
      throw new Error(`cron 字段「${field.label}」取值超出 ${field.min}-${field.max} 范围`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (values.size === 0) throw new Error(`cron 字段「${field.label}」没有可匹配的值`);
  return values;
}

export function parseCronExpression(expression: string): CronExpression {
  if (typeof expression !== "string" || expression.trim() === "") {
    throw new Error("cron 表达式不能为空");
  }
  const parts = expression.trim().split(/\s+/u);
  if (parts.length !== 5) {
    throw new Error(`cron 表达式必须包含 5 个字段（分 时 日 月 周），当前为 ${parts.length} 个`);
  }
  const result = {} as CronExpression;
  for (let index = 0; index < CRON_FIELDS.length; index += 1) {
    const field = CRON_FIELDS[index];
    const part = parts[index];
    if (!field || !part) throw new Error("cron 表达式字段缺失");
    result[field.name] = parseFieldToken(part, field);
    if (field.name === "dayOfWeek") {
      // 兼容 7 表示周日
      const dayOfWeek = new Set<number>(result.dayOfWeek);
      if (dayOfWeek.has(7)) dayOfWeek.add(0);
      result.dayOfWeek = dayOfWeek;
    }
  }
  return result;
}

export function isValidCronExpression(expression: string): boolean {
  try {
    parseCronExpression(expression);
    return true;
  } catch {
    return false;
  }
}

export function cronMatches(expression: CronExpression, date: Date): boolean {
  const minutes = date.getMinutes();
  const hours = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();
  return expression.minute.has(minutes)
    && expression.hour.has(hours)
    && expression.dayOfMonth.has(dayOfMonth)
    && expression.month.has(month)
    && expression.dayOfWeek.has(dayOfWeek);
}

/** 生成可读的中文 cron 描述，用于设置界面提示。 */
export function describeCronExpression(expression: string): string {
  try {
    const parsed = parseCronExpression(expression);
    const minute = [...parsed.minute];
    const hour = [...parsed.hour];
    const dayOfMonth = [...parsed.dayOfMonth];
    const month = [...parsed.month];
    const dayOfWeek = [...parsed.dayOfWeek];
    const everyMinute = minute.length === 60;
    const everyHour = hour.length === 24;
    const everyDay = dayOfMonth.length === 31 && month.length === 12 && dayOfWeek.length === 8;
    if (everyMinute) return "每分钟触发";
    if (everyHour && minute.length === 1) return `每小时的第 ${minute[0]} 分触发`;
    if (everyDay && hour.length === 1 && minute.length === 1) {
      return `每天 ${String(hour[0]).padStart(2, "0")}:${String(minute[0]).padStart(2, "0")} 触发`;
    }
    const weekdayOnly = dayOfWeek.length <= 7 && dayOfWeek.length > 0 && dayOfMonth.length === 31 && month.length === 12;
    if (weekdayOnly && hour.length === 1 && minute.length === 1) {
      const labels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
      const days = [...dayOfWeek].sort((a, b) => a - b).map((value) => labels[value]).join("、");
      return `每${days}的 ${String(hour[0]).padStart(2, "0")}:${String(minute[0]).padStart(2, "0")} 触发`;
    }
    return `每分钟 ${[...minute].sort((a, b) => a - b).slice(0, 8).join("、")} 触发（完整表达式 ${expression}）`;
  } catch {
    return "无法解析的表达式";
  }
}
