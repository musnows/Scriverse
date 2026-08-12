import { describe, expect, it } from "vitest";
import {
  millisecondsUntilSchedule,
  normalizeS3Prefix,
  parseScheduleTime,
  s3DatabaseFileName,
  s3DatabaseObjectKey,
  s3ImageObjectKey,
  selectDatabaseBackupsToDelete,
  shouldRunMissedSchedule
} from "../../src/s3-backup-paths.js";

describe("S3 备份路径与留存", () => {
  it("把对象放到给定子目录下的 scriverse 目录，缺省时使用桶根目录", () => {
    expect(s3ImageObjectKey("", "ab/abcd.webp")).toBe("scriverse/img/ab/abcd.webp");
    expect(s3DatabaseObjectKey("backups/prod", "novel-20260812T120000Z.db")).toBe("backups/prod/scriverse/db/novel-20260812T120000Z.db");
    expect(normalizeS3Prefix("/foo/bar/")).toBe("foo/bar");
  });

  it("拒绝相对路径子目录", () => {
    expect(() => normalizeS3Prefix("../secret")).toThrow(/相对路径/);
  });

  it("按时间戳文件名删除超出留存个数的最旧数据库备份，不处理图片", () => {
    expect(selectDatabaseBackupsToDelete([
      "scriverse/db/novel-20260101T000000Z.db",
      "scriverse/img/ab/photo.webp",
      "scriverse/db/novel-20260301T000000Z.db",
      "scriverse/db/novel-20260201T000000Z.db"
    ], 2)).toEqual(["scriverse/db/novel-20260101T000000Z.db"]);
  });

  it("生成可排序的数据库快照文件名", () => {
    expect(s3DatabaseFileName(new Date("2026-08-12T15:03:09.123Z"))).toBe("novel-20260812T150309Z.db");
  });

  it("按服务器本地时区计算下次触发延迟，并补跑当天已过点的任务", () => {
    parseScheduleTime("03:00");
    const now = new Date("2026-08-12T10:00:00");
    now.setHours(10, 0, 0, 0);
    expect(millisecondsUntilSchedule("03:00", now)).toBeGreaterThan(0);
    const todayRun = new Date(now);
    todayRun.setHours(3, 0, 0, 0);
    expect(shouldRunMissedSchedule("03:00", null, now)).toBe(true);
    expect(shouldRunMissedSchedule("03:00", todayRun.toISOString(), now)).toBe(false);
  });
});
