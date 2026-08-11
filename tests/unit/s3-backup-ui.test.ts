import { describe, expect, it } from "vitest";
import {
  collectS3BackupRunTransitions,
  s3BackupEncryptionKeyFile,
  s3BackupEncryptionPresentation,
  s3BackupFailureToast,
  s3BackupRootPrefix,
  s3BackupStatusLabel
} from "../../src/public/s3-backup-ui.js";

describe("S3 备份前端状态", () => {
  it("按可选子目录生成固定 scriverse 根路径", () => {
    expect(s3BackupRootPrefix()).toBe("scriverse");
    expect(s3BackupRootPrefix("/authors//mothra/")).toBe("authors/mothra/scriverse");
  });

  it("只在初始化后提示新增或变更为失败的运行", () => {
    const initial = collectS3BackupRunTransitions(new Map(), [
      { id: "run-1", status: "running" },
      { id: "run-old", status: "failed" }
    ], false);
    expect(initial.failures).toEqual([]);

    const changed = collectS3BackupRunTransitions(initial.snapshots, [
      { id: "run-1", status: "failed", targetName: "主备份", errorMessage: "AccessDenied" },
      { id: "run-2", status: "failed", targetName: "异地备份", errorMessage: "Timeout" }
    ], true);
    expect(changed.failures.map((run) => run.id)).toEqual(["run-1", "run-2"]);
    expect(collectS3BackupRunTransitions(changed.snapshots, [
      { id: "run-1", status: "failed" },
      { id: "run-2", status: "failed" }
    ], true).failures).toEqual([]);
  });

  it("生成状态标签和失败 Toast 文案", () => {
    expect(["running", "succeeded", "failed"].map(s3BackupStatusLabel)).toEqual(["执行中", "成功", "失败"]);
    expect(s3BackupFailureToast({ targetName: "主备份", errorMessage: "AccessDenied" })).toBe("S3 备份目标“主备份”失败：AccessDenied");
  });

  it("区分加密开启、关闭与从未配置状态", () => {
    expect(s3BackupEncryptionPresentation({ enabled: true, keyConfiguredAt: "2026-08-10T00:00:00.000Z" })).toMatchObject({
      label: "已开启",
      statusClass: "is-enabled",
      showPrivateBucketWarning: false
    });
    expect(s3BackupEncryptionPresentation({ enabled: false, keyConfiguredAt: "2026-08-10T00:00:00.000Z" })).toMatchObject({
      label: "已关闭",
      showPrivateBucketWarning: true
    });
    expect(s3BackupEncryptionPresentation({ enabled: false, keyConfiguredAt: null })).toMatchObject({
      label: "未开启",
      showPrivateBucketWarning: true
    });
    expect(s3BackupEncryptionKeyFile("backup-key")).toBe("backup-key\n");
  });
});
