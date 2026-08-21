import { describe, expect, it } from "vitest";
import {
  buildWritingCalendar,
  buildWritingMonthCalendar,
  formatServerLocalClock,
  resolveServerTimeZone,
  resolveWritingTimeZone,
  writingDateKey
} from "../../src/writing-progress-time.js";

describe("写作进度时区", () => {
  it("按配置时区计算跨午夜的日历日期和 UTC 边界", () => {
    const now = new Date("2026-07-29T16:30:00.000Z");
    const calendar = buildWritingCalendar(now, 2, "Asia/Shanghai");

    expect(writingDateKey(now, calendar.timeZone)).toBe("2026-07-30");
    expect(calendar.dateKeys).toEqual(["2026-07-29", "2026-07-30"]);
    expect(calendar.startInclusive).toBe("2026-07-28T16:00:00.000Z");
    expect(calendar.endExclusive).toBe("2026-07-30T16:00:00.000Z");
  });

  it("夏令时切换时仍按本地日期计算结束边界", () => {
    const calendar = buildWritingCalendar(new Date("2026-03-08T06:30:00.000Z"), 2, "America/New_York");

    expect(calendar.dateKeys).toEqual(["2026-03-07", "2026-03-08"]);
    expect(calendar.startInclusive).toBe("2026-03-07T05:00:00.000Z");
    expect(calendar.endExclusive).toBe("2026-03-09T04:00:00.000Z");
  });

  it("按服务端时区计算自然月的起止边界", () => {
    const calendar = buildWritingMonthCalendar(new Date("2026-07-31T15:30:00.000Z"), "Asia/Shanghai");

    expect(calendar.monthKey).toBe("2026-07");
    expect(calendar.startKey).toBe("2026-07-01");
    expect(calendar.startInclusive).toBe("2026-06-30T16:00:00.000Z");
    expect(calendar.endExclusive).toBe("2026-07-31T16:00:00.000Z");
  });

  it("未配置或配置无效时默认使用上海时区", () => {
    expect(resolveWritingTimeZone({})).toBe("Asia/Shanghai");
    expect(resolveWritingTimeZone({ TZ: "Invalid/Zone" })).toBe("Asia/Shanghai");
  });

  it("额度日历优先使用后端 TZ，并在未配置时使用系统时区", () => {
    expect(resolveServerTimeZone({ TZ: "America/New_York" }, "Europe/Berlin")).toBe("America/New_York");
    expect(resolveServerTimeZone({}, "Europe/Berlin")).toBe("Europe/Berlin");
    expect(resolveServerTimeZone({ TZ: "Invalid/Zone" }, "Invalid/System")).toBe("Asia/Shanghai");
  });

  it("按服务端时区格式化本地日期、时刻与星期", () => {
    expect(formatServerLocalClock(new Date("2026-08-01T03:05:00.000Z"), "Asia/Shanghai")).toBe(
      "当前时间：2026-08-01 11:05 星期六（Asia/Shanghai）"
    );
    expect(formatServerLocalClock(new Date("2026-08-02T04:00:00.000Z"), "America/New_York")).toBe(
      "当前时间：2026-08-02 00:00 星期日（America/New_York）"
    );
  });
});
