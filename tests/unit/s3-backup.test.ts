import { describe, expect, it } from "vitest";
import {
  formatS3BackupDbFileName,
  maskS3Credential,
  nextBackupScheduleDelay,
  normalizeS3BackupPrefix,
  s3BackupTargetLogFields,
  selectS3BackupRetentionDeletes,
  splitS3BackupLogText
} from "../../src/s3-backup.js";

describe("S3 备份纯函数", () => {
  it("数据库备份文件名包含 UTC 毫秒时间戳且可按字典序排序", () => {
    const first = formatS3BackupDbFileName(new Date("2026-08-15T03:04:05.123Z"));
    const second = formatS3BackupDbFileName(new Date("2026-08-15T03:04:05.124Z"));
    expect(first).toBe("novel-20260815T030405.123Z.db");
    expect(second).toBe("novel-20260815T030405.124Z.db");
    expect(formatS3BackupDbFileName(new Date("2026-08-15T03:04:05.123Z"), 2)).toBe("novel-20260815T030405.123Z-2.db");
    expect([second, first].sort()[0]).toBe(first);
  });

  it("规范化子目录并拒绝保留空段", () => {
    expect(normalizeS3BackupPrefix(" /tenant/a//b/ ")).toBe("tenant/a/b");
    expect(normalizeS3BackupPrefix("")).toBe("");
  });

  it("留存清理仅删除最老的直接数据库备份", () => {
    const prefix = "tenant/scriverse/db";
    const keys = [
      "tenant/scriverse/img/ab/hash.webp",
      "tenant/scriverse/db/novel-20260814T030000.000Z.db",
      "tenant/scriverse/db/novel-20260815T030000.000Z.db",
      "tenant/scriverse/db/nested/novel-20260813T030000.000Z.db",
      "tenant/scriverse/db/notes.txt"
    ];
    expect(selectS3BackupRetentionDeletes(keys, prefix, 1)).toEqual([
      "tenant/scriverse/db/novel-20260814T030000.000Z.db"
    ]);
    expect(selectS3BackupRetentionDeletes(keys, prefix, 2)).toEqual([]);
  });

  it("按服务器本地时间计算下一次定时触发", () => {
    expect(nextBackupScheduleDelay("03:00", new Date("2026-08-15T02:59:59"))).toBe(1_000);
    const delay = nextBackupScheduleDelay("03:00", new Date("2026-08-15T03:00:00"));
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(24 * 60 * 60 * 1_000);
    expect(nextBackupScheduleDelay("25:99")).toBeGreaterThan(0);
  });

  it("目标日志字段包含完整配置但不包含任何凭据", () => {
    const fields = s3BackupTargetLogFields({
      id: "t1",
      name: "目标",
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "bucket",
      prefix: "tenant",
      enabled: 1,
      encrypted_access_key: "encrypted-ak",
      encrypted_secret_key: "encrypted-sk",
      access_key_iv: "iv",
      secret_key_iv: "iv",
      access_key_tag: "tag",
      secret_key_tag: "tag",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    });
    expect(fields).toEqual({
      id: "t1",
      name: "目标",
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "bucket",
      prefix: "tenant",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(Object.keys(fields).join(",")).not.toMatch(/access|secret|encrypted|iv|tag/u);
  });

  it("凭据掩码不泄露首尾之外的完整片段", () => {
    expect(maskS3Credential("AKIA1234567890ABCDEF")).toBe("AKIA****CDEF");
    expect(maskS3Credential("short")).toBe("********");
  });

  it("长响应日志按分片完整保留服务端返回", () => {
    const body = "x".repeat(7_500);
    const chunks = splitS3BackupLogText("body", body);
    expect(chunks.bodyLength).toBe(7_500);
    expect(chunks.bodyPart1).toHaveLength(3_000);
    expect(chunks.bodyPart2).toHaveLength(3_000);
    expect(chunks.bodyPart3).toHaveLength(1_500);
    expect(`${chunks.bodyPart1}${chunks.bodyPart2}${chunks.bodyPart3}`).toBe(body);
  });
});
