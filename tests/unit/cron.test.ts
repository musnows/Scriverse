import { describe, expect, it } from "vitest";
import { cronMatches, describeCronExpression, isValidCronExpression, parseCronExpression } from "../../src/cron.js";

describe("cron 表达式解析", () => {
  it("解析标准 5 段表达式", () => {
    const parsed = parseCronExpression("0 3 * * *");
    expect(parsed.minute.has(0)).toBe(true);
    expect(parsed.hour.has(3)).toBe(true);
    expect(parsed.dayOfMonth.size).toBe(31);
    expect(parsed.month.size).toBe(12);
    expect(parsed.dayOfWeek.size).toBe(8);
  });

  it("支持星号步长与区间", () => {
    const parsed = parseCronExpression("*/15 9-18 * * 1-5");
    expect(parsed.minute.size).toBe(4);
    expect(parsed.minute.has(0)).toBe(true);
    expect(parsed.minute.has(45)).toBe(true);
    expect(parsed.hour.size).toBe(10);
    expect(parsed.hour.has(9)).toBe(true);
    expect(parsed.hour.has(18)).toBe(true);
    expect(parsed.dayOfWeek.has(1)).toBe(true);
    expect(parsed.dayOfWeek.has(5)).toBe(true);
    expect(parsed.dayOfWeek.has(0)).toBe(false);
  });

  it("支持逗号组合与 7 表示周日", () => {
    const parsed = parseCronExpression("0,30 * * * 0,7");
    expect(parsed.minute.has(0)).toBe(true);
    expect(parsed.minute.has(30)).toBe(true);
    expect(parsed.dayOfWeek.has(0)).toBe(true);
    expect(parsed.dayOfWeek.has(7)).toBe(true);
  });

  it("拒绝字段数量错误、越界与非法片段", () => {
    expect(() => parseCronExpression("0 3 * *")).toThrow("5 个字段");
    expect(() => parseCronExpression("60 * * * *")).toThrow("范围");
    expect(() => parseCronExpression("* 24 * * *")).toThrow("范围");
    expect(() => parseCronExpression("* * 0 * *")).toThrow("范围");
    expect(() => parseCronExpression("* * * * 8")).toThrow("范围");
    expect(() => parseCronExpression("a * * * *")).toThrow("无法识别");
    expect(() => parseCronExpression("")).toThrow("不能为空");
    expect(() => parseCronExpression("1-2-3 * * * *")).toThrow("无法识别");
    expect(() => parseCronExpression("*/0 * * * *")).toThrow("步长");
  });

  it("isValidCronExpression 返回布尔值", () => {
    expect(isValidCronExpression("0 3 * * *")).toBe(true);
    expect(isValidCronExpression("not-a-cron")).toBe(false);
  });
});

describe("cron 时间匹配", () => {
  // 定时调度按服务器本地时区匹配（与系统 cron 守护进程一致）
  function localDate(year: number, month: number, day: number, hour: number, minute: number): Date {
    return new Date(year, month - 1, day, hour, minute, 0, 0);
  }

  it("在指定分钟触发", () => {
    const parsed = parseCronExpression("0 3 * * *");
    expect(cronMatches(parsed, localDate(2026, 8, 2, 3, 0))).toBe(true);
    expect(cronMatches(parsed, localDate(2026, 8, 2, 3, 1))).toBe(false);
    expect(cronMatches(parsed, localDate(2026, 8, 2, 2, 0))).toBe(false);
  });

  it("每 5 分钟触发", () => {
    const parsed = parseCronExpression("*/5 * * * *");
    expect(cronMatches(parsed, localDate(2026, 8, 2, 10, 25))).toBe(true);
    expect(cronMatches(parsed, localDate(2026, 8, 2, 10, 26))).toBe(false);
  });

  it("工作日限定", () => {
    // 2026-08-03 是周一
    const parsed = parseCronExpression("0 9 * * 1-5");
    expect(cronMatches(parsed, localDate(2026, 8, 3, 9, 0))).toBe(true);
    // 2026-08-02 是周日
    expect(cronMatches(parsed, localDate(2026, 8, 2, 9, 0))).toBe(false);
  });
});

describe("cron 描述", () => {
  it("生成中文描述", () => {
    expect(describeCronExpression("* * * * *")).toBe("每分钟触发");
    expect(describeCronExpression("0 3 * * *")).toContain("每天 03:00 触发");
    expect(describeCronExpression("0 9 * * 1-5")).toContain("周一、周二、周三、周四、周五");
    expect(describeCronExpression("0 0 * * 7")).toContain("每周日的 00:00 触发");
    expect(describeCronExpression("bad")).toBe("无法解析的表达式");
  });
});
