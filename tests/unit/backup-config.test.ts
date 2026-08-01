import { describe, expect, it } from "vitest";
import { createEmptyTarget, defaultBackupConfig, describeBackupStatus } from "../../src/public/backup-config.js";

describe("backup-config 纯逻辑", () => {
  it("defaultBackupConfig 返回安全默认值", () => {
    const config = defaultBackupConfig();
    expect(config.targets).toEqual([]);
    expect(config.backupImages).toBe(true);
    expect(config.scheduleTime).toBe("03:00");
    expect(config.retentionCount).toBe(10);
  });

  it("createEmptyTarget 生成带 id 且默认启用的空白目标", () => {
    const target = createEmptyTarget();
    expect(typeof target.id).toBe("string");
    expect(target.id.length).toBeGreaterThan(0);
    expect(target.enabled).toBe(true);
    expect(target.accessKeyId).toBe("");
    expect(target.secretAccessKey).toBe("");
    expect(target.hasAccessKeyId).toBe(false);
    expect(target.hasSecretAccessKey).toBe(false);
  });

  it("describeBackupStatus 归纳不同运行状态", () => {
    expect(describeBackupStatus({ running: true, lastError: null, lastFinishedAt: null }).state).toBe("running");
    expect(describeBackupStatus({ running: false, lastError: "炸了", lastFinishedAt: null }).state).toBe("failed");
    expect(describeBackupStatus({ running: false, lastError: null, lastFinishedAt: "2026-08-01T00:00:00.000Z" }).state).toBe("success");
    expect(describeBackupStatus({ running: false, lastError: null, lastFinishedAt: null }).state).toBe("idle");
  });
});
