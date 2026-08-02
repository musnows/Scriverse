import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("S3 备份配置管理 API", () => {
  let runtime: Runtime;

  beforeEach(() => {
    // 创建带开发绕过用户的运行时，自动拥有 admin 权限
    runtime = createTestRuntime();
    // 在数据库中创建一个 admin 用户供开发绕过使用
    runtime.auth.register({ username: "admin", password: "AdminPass123!" });
  });

  afterEach(() => {
    runtime.close();
  });

  // 通过直接调用 store/database 方法测试配置 CRUD（绕过 HTTP auth 中间件）

  it("创建备份配置后能列出", () => {
    const config = runtime.s3Backup.createConfig({
      name: "测试备份",
      endpoint: "https://s3.amazonaws.com",
      bucket: "my-backup",
      accessKeyId: "AKIATEST",
      secretAccessKey: "test-secret-key-minimum-20-chars"
    });
    expect(config.name).toBe("测试备份");
    expect(config.bucket).toBe("my-backup");

    const configs = runtime.s3Backup.listConfigs();
    expect(configs).toHaveLength(1);
  });

  it("获取单个配置", () => {
    const config = runtime.s3Backup.createConfig({
      name: "单个查询",
      endpoint: "https://s3.example.com",
      bucket: "test-bucket",
      accessKeyId: "KEYTEST",
      secretAccessKey: "secretkeyfortesting1234567890"
    });

    const found = runtime.s3Backup.getConfig(config.id);
    expect(found).toBeTruthy();
    expect(found!.name).toBe("单个查询");
  });

  it("获取不存在的配置返回 undefined", () => {
    const found = runtime.s3Backup.getConfig("nonexistent-id");
    expect(found).toBeUndefined();
  });

  it("更新备份配置", () => {
    const config = runtime.s3Backup.createConfig({
      name: "原始名称",
      endpoint: "https://s3.example.com",
      bucket: "old-bucket",
      accessKeyId: "OLDKEY",
      secretAccessKey: "oldsecretkey1234567890123"
    });

    const updated = runtime.s3Backup.updateConfig(config.id, {
      name: "更新后名称",
      bucket: "new-bucket",
      enabled: false
    });
    expect(updated.name).toBe("更新后名称");
    expect(updated.bucket).toBe("new-bucket");
    expect(updated.enabled).toBe(false);
  });

  it("删除备份配置", () => {
    const config = runtime.s3Backup.createConfig({
      name: "待删除",
      endpoint: "https://s3.example.com",
      bucket: "delete-bucket",
      accessKeyId: "DELKEY",
      secretAccessKey: "delsecretkey12345678901234"
    });

    runtime.s3Backup.deleteConfig(config.id);
    const configs = runtime.s3Backup.listConfigs();
    expect(configs).toHaveLength(0);
  });

  it("创建配置含所有可选参数", () => {
    const config = runtime.s3Backup.createConfig({
      name: "完整配置",
      endpoint: "https://play.min.io",
      region: "ap-southeast-1",
      bucket: "backups",
      subdirectory: "production",
      accessKeyId: "MINIOUSER",
      secretAccessKey: "miniosecretkey1234567890",
      includeImages: true,
      scheduleEnabled: true,
      scheduleHour: 4,
      scheduleMinute: 30,
      retentionCount: 14,
      enabled: true
    });

    expect(config.region).toBe("ap-southeast-1");
    expect(config.subdirectory).toBe("production");
    expect(config.includeImages).toBe(true);
    expect(config.scheduleEnabled).toBe(true);
    expect(config.scheduleHour).toBe(4);
    expect(config.scheduleMinute).toBe(30);
    expect(config.retentionCount).toBe(14);
    expect(config.enabled).toBe(true);
  });

  it("备份禁用的配置返回错误", async () => {
    const config = runtime.s3Backup.createConfig({
      name: "禁用的备份",
      endpoint: "https://s3.example.com",
      bucket: "disabled-bucket",
      accessKeyId: "DISABLED",
      secretAccessKey: "disabledsecretkey123456789012",
      enabled: false
    });

    const result = await runtime.s3Backup.executeBackup(config.id);
    expect(result.success).toBe(false);
    expect(result.error).toContain("已禁用");
  });

  it("备份不存在的配置返回错误", async () => {
    const result = await runtime.s3Backup.executeBackup("nonexistent");
    expect(result.success).toBe(false);
  });

  it("密钥在列表时不暴露原始值", () => {
    runtime.s3Backup.createConfig({
      name: "密钥测试",
      endpoint: "https://s3.example.com",
      bucket: "secret-bucket",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    });

    const configs = runtime.s3Backup.listConfigs();
    expect(configs).toHaveLength(1);
    // S3BackupConfig 类型不应包含 secretAccessKey 在 listConfigs 中
    expect((configs[0] as Record<string, unknown>).secretAccessKey).toBeUndefined();
  });

  it("定期备份默认参数正确", () => {
    const config = runtime.s3Backup.createConfig({
      name: "默认参数测试",
      endpoint: "https://s3.example.com",
      bucket: "default-bucket",
      accessKeyId: "DEFAULTKEY",
      secretAccessKey: "defaultsecretkey1234567890"
    });

    expect(config.includeImages).toBe(true);
    expect(config.scheduleEnabled).toBe(false);
    expect(config.scheduleHour).toBe(3);
    expect(config.scheduleMinute).toBe(0);
    expect(config.retentionCount).toBe(7);
    expect(config.enabled).toBe(true);
  });
});
