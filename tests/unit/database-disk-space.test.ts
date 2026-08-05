import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSqliteDiskIoError, logSqliteDiskIoError, readAvailableDiskSpace, SQLITE_IOERR_SHMSIZE } from "../../src/database.js";
import { logger } from "../../src/logger.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SQLite 磁盘空间错误提示", () => {
  it("识别 SQLITE_IOERR_SHMSIZE 而不误判约束错误", () => {
    const diskIoError = Object.assign(new Error("disk I/O error"), {
      code: "ERR_SQLITE_ERROR",
      errcode: SQLITE_IOERR_SHMSIZE,
      errstr: "disk I/O error"
    });
    const constraintError = Object.assign(new Error("constraint failed"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 1555,
      errstr: "constraint failed"
    });

    expect(isSqliteDiskIoError(diskIoError)).toBe(true);
    expect(isSqliteDiskIoError(constraintError)).toBe(false);
  });

  it("读取数据库目录所在文件系统的可用空间", () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-disk-space-"));
    roots.push(root);

    const available = readAvailableDiskSpace(root);

    expect(available?.availableBytes).toBeGreaterThan(0);
    expect(available?.availableMiB).toBeGreaterThan(0);
  });

  it("检测到 SQLite 磁盘错误时连续输出空间和处理提示", () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-disk-space-log-"));
    roots.push(root);
    const records: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const error = Object.assign(new Error("disk I/O error"), {
      code: "ERR_SQLITE_ERROR",
      errcode: SQLITE_IOERR_SHMSIZE,
      errstr: "disk I/O error"
    });
    const errorSpy = vi.spyOn(logger, "error").mockImplementation((event, fields) => {
      records.push({ event, fields });
    });

    try {
      logSqliteDiskIoError(join(root, "novel.db"), error);
    } finally {
      errorSpy.mockRestore();
    }

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      event: "database.disk_io_error.space_check",
      fields: {
        spaceCheck: "completed",
        availableBytes: expect.any(Number),
        availableMiB: expect.any(Number)
      }
    });
    expect(records[1]).toMatchObject({
      event: "database.disk_io_error.guidance",
      fields: {
        message: expect.stringContaining("Check the host disk's available space")
      }
    });
  });
});
