import { describe, expect, it } from "vitest";
import { backupDatabaseFileName, nextScheduledBackupAt, selectExpiredBackupKeys } from "../../src/backup.js";
import { AppError } from "../../src/errors.js";

describe("备份定时时间计算", () => {
  it("当天时间点未到时安排在今天", () => {
    const from = new Date(2026, 7, 4, 10, 0, 0);
    const next = nextScheduledBackupAt(from, "23:30");
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(7);
    expect(next.getDate()).toBe(4);
    expect(next.getHours()).toBe(23);
    expect(next.getMinutes()).toBe(30);
    expect(next.getSeconds()).toBe(0);
  });

  it("当天时间点已过或正好相等时顺延到次日", () => {
    expect(nextScheduledBackupAt(new Date(2026, 7, 4, 10, 0, 0), "03:00").getDate()).toBe(5);
    expect(nextScheduledBackupAt(new Date(2026, 7, 4, 3, 0, 0), "03:00").getDate()).toBe(5);
    expect(nextScheduledBackupAt(new Date(2026, 7, 4, 2, 59, 59), "03:00").getDate()).toBe(4);
  });

  it("跨月与跨年时正确进位", () => {
    const monthEnd = nextScheduledBackupAt(new Date(2026, 7, 31, 23, 59, 0), "01:00");
    expect(monthEnd.getMonth()).toBe(8);
    expect(monthEnd.getDate()).toBe(1);
    const yearEnd = nextScheduledBackupAt(new Date(2026, 11, 31, 23, 59, 0), "01:00");
    expect(yearEnd.getFullYear()).toBe(2027);
    expect(yearEnd.getMonth()).toBe(0);
    expect(yearEnd.getDate()).toBe(1);
  });

  it("拒绝非法时间格式", () => {
    for (const value of ["", "3:00", "24:00", "12:60", "12-00", "十二点"]) {
      expect(() => nextScheduledBackupAt(new Date(), value)).toThrowError(AppError);
    }
  });
});

describe("备份文件名", () => {
  it("在数据库文件名后追加 UTC 时间戳", () => {
    expect(backupDatabaseFileName("/srv/app/.data/novel.db", new Date("2026-08-04T11:22:33.444Z")))
      .toBe("novel-20260804T112233Z.db");
    expect(backupDatabaseFileName("C:/data/Scriverse.DB", new Date("2026-01-02T03:04:05.000Z")))
      .toBe("Scriverse-20260102T030405Z.db");
  });

  it("清理文件名中的特殊字符并保证非空", () => {
    expect(backupDatabaseFileName(":memory:", new Date("2026-08-04T00:00:00.000Z"))).toBe("memory-20260804T000000Z.db");
    expect(backupDatabaseFileName("中文名.db", new Date("2026-08-04T00:00:00.000Z"))).toBe("novel-20260804T000000Z.db");
  });

  it("同一天不同时刻生成互不覆盖且按字典序递增的文件名", () => {
    const earlier = backupDatabaseFileName("novel.db", new Date("2026-08-04T01:00:00.000Z"));
    const later = backupDatabaseFileName("novel.db", new Date("2026-08-04T02:00:00.000Z"));
    expect(earlier).not.toBe(later);
    expect(earlier < later).toBe(true);
  });
});

describe("备份留存筛选", () => {
  const objects = [
    { key: "scriverse/db/novel-20260801T000000Z.db", lastModified: "2026-08-01T00:00:00.000Z" },
    { key: "scriverse/db/novel-20260804T000000Z.db", lastModified: "2026-08-04T00:00:00.000Z" },
    { key: "scriverse/db/novel-20260802T000000Z.db", lastModified: "2026-08-02T00:00:00.000Z" },
    { key: "scriverse/db/novel-20260803T000000Z.db", lastModified: "2026-08-03T00:00:00.000Z" }
  ];

  it("保留最新的指定数量并返回其余最旧的键", () => {
    expect(selectExpiredBackupKeys(objects, 2)).toEqual([
      "scriverse/db/novel-20260802T000000Z.db",
      "scriverse/db/novel-20260801T000000Z.db"
    ]);
    expect(selectExpiredBackupKeys(objects, 4)).toEqual([]);
    expect(selectExpiredBackupKeys(objects, 10)).toEqual([]);
  });

  it("留存数量至少保留一个备份", () => {
    expect(selectExpiredBackupKeys(objects, 0)).toHaveLength(3);
    expect(selectExpiredBackupKeys(objects, -5)).toHaveLength(3);
  });

  it("只清理数据库备份，忽略图片等其他对象", () => {
    const mixed = [
      ...objects,
      { key: "scriverse/img/ab/hash.webp", lastModified: "2020-01-01T00:00:00.000Z" },
      { key: "scriverse/db/readme.txt", lastModified: "2020-01-01T00:00:00.000Z" }
    ];
    const expired = selectExpiredBackupKeys(mixed, 1);
    expect(expired).toHaveLength(3);
    expect(expired.every((key) => key.endsWith(".db"))).toBe(true);
  });

  it("时间相同时按键名倒序稳定排序", () => {
    const sameTime = [
      { key: "scriverse/db/a.db", lastModified: "2026-08-04T00:00:00.000Z" },
      { key: "scriverse/db/b.db", lastModified: "2026-08-04T00:00:00.000Z" },
      { key: "scriverse/db/c.db", lastModified: "2026-08-04T00:00:00.000Z" }
    ];
    expect(selectExpiredBackupKeys(sameTime, 1)).toEqual(["scriverse/db/b.db", "scriverse/db/a.db"]);
  });

  it("缺失或非法修改时间时不会丢弃全部备份", () => {
    const invalid = [
      { key: "scriverse/db/x.db", lastModified: "" },
      { key: "scriverse/db/y.db", lastModified: "not-a-date" }
    ];
    expect(selectExpiredBackupKeys(invalid, 1)).toEqual(["scriverse/db/x.db"]);
  });
});
