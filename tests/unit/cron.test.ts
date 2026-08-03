import { describe, expect, it } from "vitest";
import { buildDailyCron, buildIntervalCron, cronMatches, CronParseError, parseCron } from "../../src/cron.js";

describe("cron 解析与匹配", () => {
  it("解析每天定时", () => {
    const parsed = parseCron("30 3 * * *");
    expect(parsed.minute.values).toEqual([30]);
    expect(parsed.hour.values).toEqual([3]);
    expect(parsed.dayOfMonth.values.length).toBe(31);
    expect(parsed.month.values.length).toBe(12);
    expect(parsed.dayOfWeek.values.length).toBe(8);
  });

  it("解析每隔 N 小时", () => {
    const parsed = parseCron("0 */6 * * *");
    expect(parsed.minute.values).toEqual([0]);
    expect(parsed.hour.values).toEqual([0, 6, 12, 18]);
  });

  it("解析列表与范围", () => {
    const parsed = parseCron("0,12 1,2,3 * * *");
    expect(parsed.minute.values).toEqual([0, 12]);
    expect(parsed.hour.values).toEqual([1, 2, 3]);
  });

  it("周日 7 统一为 0", () => {
    const parsed = parseCron("0 0 * * 7");
    expect(parsed.dayOfWeek.values).toEqual([0]);
  });

  it("cronMatches 命中每天定时", () => {
    const parsed = parseCron("30 3 * * *");
    expect(cronMatches(parsed, new Date(2026, 7, 3, 3, 30, 0))).toBe(true);
    expect(cronMatches(parsed, new Date(2026, 7, 3, 3, 31, 0))).toBe(false);
    expect(cronMatches(parsed, new Date(2026, 7, 3, 4, 30, 0))).toBe(false);
  });

  it("cronMatches 命中每隔 6 小时", () => {
    const parsed = parseCron("0 */6 * * *");
    expect(cronMatches(parsed, new Date(2026, 7, 3, 0, 0, 0))).toBe(true);
    expect(cronMatches(parsed, new Date(2026, 7, 3, 6, 0, 0))).toBe(true);
    expect(cronMatches(parsed, new Date(2026, 7, 3, 7, 0, 0))).toBe(false);
  });

  it("cronMatches 命中指定星期", () => {
    // 2026-08-03 是周一（getDay()=1）
    const parsed = parseCron("0 0 * * 1");
    expect(cronMatches(parsed, new Date(2026, 7, 3, 0, 0, 0))).toBe(true);
    expect(cronMatches(parsed, new Date(2026, 7, 4, 0, 0, 0))).toBe(false);
  });

  it("buildDailyCron 生成正确表达式", () => {
    expect(buildDailyCron(3, 30)).toBe("30 3 * * *");
    expect(() => buildDailyCron(24, 0)).toThrow(CronParseError);
    expect(() => buildDailyCron(3, 60)).toThrow(CronParseError);
  });

  it("buildIntervalCron 生成正确表达式", () => {
    expect(buildIntervalCron(6)).toBe("0 */6 * * *");
    expect(() => buildIntervalCron(0)).toThrow(CronParseError);
    expect(() => buildIntervalCron(24)).toThrow(CronParseError);
  });

  it("拒绝非法字段数", () => {
    expect(() => parseCron("30 3 * *")).toThrow(CronParseError);
    expect(() => parseCron("30 3 * * * *")).toThrow(CronParseError);
    expect(() => parseCron("")).toThrow(CronParseError);
  });

  it("拒绝超出范围的数值", () => {
    expect(() => parseCron("60 3 * * *")).toThrow(CronParseError);
    expect(() => parseCron("30 24 * * *")).toThrow(CronParseError);
    expect(() => parseCron("30 3 32 * *")).toThrow(CronParseError);
  });

  it("拒绝非法步长", () => {
    expect(() => parseCron("*/0 3 * * *")).toThrow(CronParseError);
  });
});
