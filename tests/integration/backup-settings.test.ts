import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "../../src/database.js";
import { Store } from "../../src/store.js";
import { CredentialVault } from "../../src/credential-vault.js";

const MASTER_SECRET = "test-master-secret-with-at-least-32-characters";

describe("平台备份设置与系统通知", () => {
  let database: Database;
  let store: Store;
  beforeEach(() => {
    database = new Database(":memory:");
    store = new Store(database, new CredentialVault(MASTER_SECRET));
  });
  afterEach(() => {
    database.close();
  });

  it("默认备份设置为空目标且不暴露密钥", () => {
    const settings = store.getPlatformBackupSettings();
    expect(settings.targets).toEqual([]);
    expect(settings.backupImages).toBe(true);
    expect(settings.scheduleTime).toBe("03:00");
    expect(settings.retentionCount).toBe(7);
  });

  it("写入含密钥的目标后，对外视图仅标记 hasSecretAccessKey 且不回显明文", () => {
    const updated = store.updatePlatformBackupSettings({
      targets: [{
        id: "t1",
        name: "主存储",
        enabled: true,
        endpoint: "https://s3.example.com",
        region: "auto",
        bucket: "backups",
        accessKeyId: "AKID",
        secretAccessKey: "super-secret-value",
        hasSecretAccessKey: true,
        subDirectory: ""
      }],
      backupImages: false,
      scheduleTime: "04:30",
      retentionCount: 5
    });
    const target = (updated.targets as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(target.hasSecretAccessKey).toBe(true);
    expect(target.secretAccessKey).toBeUndefined();

    const decrypted = store.getDecryptedBackupSettings();
    expect(decrypted.targets[0]?.secretAccessKey).toBe("super-secret-value");
    expect(decrypted.backupImages).toBe(false);
    expect(decrypted.scheduleTime).toBe("04:30");
    expect(decrypted.retentionCount).toBe(5);
  });

  it("保存时留空密钥且 hasSecretAccessKey 为真则保留既有密钥", () => {
    store.updatePlatformBackupSettings({
      targets: [{
        id: "t1",
        name: "主存储",
        enabled: true,
        endpoint: "https://s3.example.com",
        region: "auto",
        bucket: "backups",
        accessKeyId: "AKID",
        secretAccessKey: "original-secret",
        hasSecretAccessKey: true,
        subDirectory: ""
      }]
    });
    const reSaved = store.updatePlatformBackupSettings({
      targets: [{
        id: "t1",
        name: "主存储",
        enabled: true,
        endpoint: "https://s3.example.com",
        region: "auto",
        bucket: "backups",
        accessKeyId: "AKID",
        secretAccessKey: "",
        hasSecretAccessKey: true,
        subDirectory: "team-a"
      }]
    });
    expect((reSaved.targets as Array<Record<string, unknown>>)[0]?.hasSecretAccessKey).toBe(true);
    expect(store.getDecryptedBackupSettings().targets[0]?.secretAccessKey).toBe("original-secret");
    expect(store.getDecryptedBackupSettings().targets[0]?.subDirectory).toBe("team-a");
  });

  it("系统通知可创建、列出未读并标记已读", () => {
    expect(store.listUnreadSystemNotifications()).toEqual([]);
    store.createSystemNotification("backup-failure", "备份到「主存储」失败：拒绝访问");
    const unread = store.listUnreadSystemNotifications();
    expect(unread).toHaveLength(1);
    expect(unread[0]?.type).toBe("backup-failure");
    expect(unread[0]?.message).toBe("备份到「主存储」失败：拒绝访问");
    store.markSystemNotificationsRead([Number(unread[0]?.id)]);
    expect(store.listUnreadSystemNotifications()).toEqual([]);
  });
});
