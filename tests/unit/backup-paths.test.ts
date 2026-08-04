import { describe, expect, it } from "vitest";
import {
  dbObjectKey,
  dbObjectPrefix,
  formatBackupDbFilename,
  formatLocalDate,
  imageObjectKey,
  normalizeBackupPrefix,
  parseScheduleTime,
  selectExpiredDbObjectKeys,
  shouldTriggerSchedule,
  scriverseRoot
} from "../../src/backup-paths.js";

describe("backup-paths", () => {
  it("normalizes prefix and builds scriverse object keys", () => {
    expect(normalizeBackupPrefix("")).toBe("");
    expect(normalizeBackupPrefix(" /prod/daily/ ")).toBe("prod/daily");
    expect(scriverseRoot("")).toBe("scriverse");
    expect(scriverseRoot("prod")).toBe("prod/scriverse");
    expect(imageObjectKey("prod", "ab/abcdef.webp")).toBe("prod/scriverse/img/ab/abcdef.webp");
    expect(dbObjectPrefix("")).toBe("scriverse/db/");
    expect(dbObjectKey("prod", "novel-2026-08-05.db")).toBe("prod/scriverse/db/novel-2026-08-05.db");
  });

  it("rejects unsafe prefixes", () => {
    expect(() => normalizeBackupPrefix("../secret")).toThrow(/相对路径/u);
    expect(() => normalizeBackupPrefix("a/./b")).toThrow(/相对路径/u);
  });

  it("parses schedule time and decides trigger by local clock", () => {
    expect(parseScheduleTime("03:00")).toEqual({ hour: 3, minute: 0 });
    expect(() => parseScheduleTime("25:00")).toThrow(/HH:MM/u);
    const now = new Date(2026, 7, 5, 3, 1, 0);
    expect(formatLocalDate(now)).toBe("2026-08-05");
    expect(shouldTriggerSchedule("03:00", now, null)).toBe(true);
    expect(shouldTriggerSchedule("03:00", now, "2026-08-05")).toBe(false);
    expect(shouldTriggerSchedule("04:00", now, null)).toBe(false);
  });

  it("selects oldest db objects beyond retention", () => {
    expect(selectExpiredDbObjectKeys([
      "scriverse/db/novel-1.db",
      "scriverse/db/novel-2.db",
      "scriverse/db/novel-3.db",
      "scriverse/db/readme.txt"
    ], 2)).toEqual([
      "scriverse/db/novel-1.db"
    ]);
    expect(selectExpiredDbObjectKeys(["scriverse/db/novel-1.db"], 3)).toEqual([]);
  });

  it("formats timestamped database filenames", () => {
    expect(formatBackupDbFilename(new Date("2026-08-05T06:44:00.123Z"))).toBe("novel-2026-08-05T06-44-00-123Z.db");
  });
});
