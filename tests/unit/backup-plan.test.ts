import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.js";
import {
  backupDatabaseObjectKey,
  backupDbPrefix,
  backupImagePrefix,
  isBackupDatabaseKey,
  nextDailyRunDelayMs,
  normalizeBackupPathPrefix,
  selectExpiredBackupKeys
} from "../../src/backup-plan.js";

describe("备份路径前缀规范化", () => {
  it("接受合法前缀并去掉首尾空白和斜杠", () => {
    expect(normalizeBackupPathPrefix("")).toBe("");
    expect(normalizeBackupPathPrefix("   ")).toBe("");
    expect(normalizeBackupPathPrefix("///")).toBe("");
    expect(normalizeBackupPathPrefix("a/b")).toBe("a/b");
    expect(normalizeBackupPathPrefix("/a/b/")).toBe("a/b");
    expect(normalizeBackupPathPrefix("  /a/b/  ")).toBe("a/b");
    expect(normalizeBackupPathPrefix("backups")).toBe("backups");
  });

  it("接受 Unicode 字母数字和 - _ . ~ 组成的多级前缀", () => {
    expect(normalizeBackupPathPrefix("备份/卷一")).toBe("备份/卷一");
    expect(normalizeBackupPathPrefix("v1.2/~draft-01")).toBe("v1.2/~draft-01");
  });

  it("拒绝路径穿越、空段、反斜杠、控制字符和白名单外字符", () => {
    const invalid = ["..", ".", "a/../b", "a/./b", "../escape", "a//b", "a\\b", "a\tb", "a\u0001b", "a b", "a?b"];
    for (const input of invalid) {
      expect(() => normalizeBackupPathPrefix(input), input).toThrowError(AppError);
    }
  });

  it("抛出的 AppError 带 400 和 INVALID_BACKUP_PATH_PREFIX", () => {
    try {
      normalizeBackupPathPrefix("../escape");
      expect.unreachable("应当抛出 AppError");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).status).toBe(400);
      expect((error as AppError).code).toBe("INVALID_BACKUP_PATH_PREFIX");
      expect((error as AppError).message).toBe("子目录只能包含字母、数字和常见符号，且不能包含 . 或 .. 路径段");
    }
  });
});

describe("备份对象前缀", () => {
  it("空前缀使用桶内默认目录", () => {
    expect(backupDbPrefix("")).toBe("scriverse/db/");
    expect(backupImagePrefix("")).toBe("scriverse/img/");
  });

  it("自定义前缀拼在默认目录之前", () => {
    expect(backupDbPrefix("a/b")).toBe("a/b/scriverse/db/");
    expect(backupImagePrefix("a/b")).toBe("a/b/scriverse/img/");
  });
});

describe("数据库备份对象 key", () => {
  it("按 UTC 时间生成完整 key", () => {
    const date = new Date(Date.UTC(2026, 7, 3, 16, 22, 59));
    expect(backupDatabaseObjectKey("", date)).toBe("scriverse/db/scriverse-20260803-162259.db");
    expect(backupDatabaseObjectKey("a/b", date)).toBe("a/b/scriverse/db/scriverse-20260803-162259.db");
  });

  it("识别数据库备份 key 的正反例", () => {
    expect(isBackupDatabaseKey("scriverse/db/scriverse-20260803-162259.db", "")).toBe(true);
    expect(isBackupDatabaseKey("a/b/scriverse/db/scriverse-20260803-162259.db", "a/b")).toBe(true);
    expect(isBackupDatabaseKey("scriverse/img/scriverse-20260803-162259.db", "")).toBe(false);
    expect(isBackupDatabaseKey("scriverse/db/scriverse-2026.db", "")).toBe(false);
    expect(isBackupDatabaseKey("scriverse/db/scriverse-20260803-162259.db.bak", "")).toBe(false);
    expect(isBackupDatabaseKey("scriverse/db/nested/scriverse-20260803-162259.db", "")).toBe(false);
    expect(isBackupDatabaseKey("a/b/scriverse/db/scriverse-20260803-162259.db", "")).toBe(false);
  });
});

describe("备份保留策略", () => {
  const keyOf = (stamp: string): string => `scriverse/db/scriverse-${stamp}.db`;

  it("数量不足或等于保留数时不删除任何 key", () => {
    expect(selectExpiredBackupKeys([keyOf("20260801-000000")], "", 3)).toEqual([]);
    expect(selectExpiredBackupKeys([keyOf("20260801-000000"), keyOf("20260802-000000")], "", 2)).toEqual([]);
  });

  it("超过保留数时删除最旧的备份并按升序输出", () => {
    const keys = [
      keyOf("20260803-030000"),
      keyOf("20260801-010000"),
      keyOf("20260804-040000"),
      keyOf("20260802-020000")
    ];
    expect(selectExpiredBackupKeys(keys, "", 2)).toEqual([keyOf("20260801-010000"), keyOf("20260802-020000")]);
  });

  it("混入的非备份 key 不参与保留计数", () => {
    const keys = ["scriverse/img/cover.png", "random.txt", keyOf("20260801-000000"), keyOf("20260802-000000")];
    expect(selectExpiredBackupKeys(keys, "", 1)).toEqual([keyOf("20260801-000000")]);
  });

  it("保留判定与传入顺序无关", () => {
    const keys = [keyOf("20260802-000000"), keyOf("20260803-000000"), keyOf("20260801-000000")];
    expect(selectExpiredBackupKeys(keys, "", 1)).toEqual([keyOf("20260801-000000"), keyOf("20260802-000000")]);
  });

  it("retentionCount 小于 1 时按 1 处理", () => {
    const keys = [keyOf("20260801-000000"), keyOf("20260802-000000")];
    expect(selectExpiredBackupKeys(keys, "", 0)).toEqual([keyOf("20260801-000000")]);
  });

  it("遵循自定义前缀筛选备份 key", () => {
    const keys = ["a/b/scriverse/db/scriverse-20260801-000000.db", "a/b/scriverse/db/scriverse-20260802-000000.db"];
    expect(selectExpiredBackupKeys(keys, "a/b", 1)).toEqual(["a/b/scriverse/db/scriverse-20260801-000000.db"]);
  });
});

describe("每日备份调度延迟", () => {
  it("今天还没到时刻时取今天", () => {
    const now = new Date(2026, 7, 3, 10, 0, 0, 0);
    expect(nextDailyRunDelayMs("12:30", now)).toBe(2.5 * 3_600_000);
  });

  it("今天已过时刻时取明天", () => {
    const now = new Date(2026, 7, 3, 10, 0, 0, 0);
    expect(nextDailyRunDelayMs("09:59", now)).toBe((24 * 60 - 1) * 60_000);
  });

  it("跨午夜计算正确", () => {
    const now = new Date(2026, 7, 3, 23, 50, 0, 0);
    expect(nextDailyRunDelayMs("00:10", now)).toBe(20 * 60_000);
  });

  it("正好等于当前时刻时取明天，结果恒为正", () => {
    const now = new Date(2026, 7, 3, 12, 30, 0, 0);
    expect(nextDailyRunDelayMs("12:30", now)).toBe(24 * 3_600_000);
  });

  it("非法格式抛出 INVALID_BACKUP_SCHEDULE", () => {
    const now = new Date(2026, 7, 3, 0, 0, 0);
    for (const bad of ["25:00", "24:00", "9:30", "12:60", "12:5", "abc", "1230", ""]) {
      expect(() => nextDailyRunDelayMs(bad, now), bad).toThrowError(AppError);
    }
    try {
      nextDailyRunDelayMs("25:00", now);
      expect.unreachable("应当抛出 AppError");
    } catch (error) {
      expect((error as AppError).code).toBe("INVALID_BACKUP_SCHEDULE");
    }
  });
});
