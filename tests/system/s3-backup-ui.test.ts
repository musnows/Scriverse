import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("S3 备份设置界面", () => {
  const runtimes: Runtime[] = [];

  afterEach(() => {
    while (runtimes.length) runtimes.pop()?.close();
  });

  it("在系统设置中提供管理员入口并包含完整备份配置", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "s3-backup-system-test-secret-with-32-characters",
      disableUserAuth: true,
      serveUi: true
    });
    runtimes.push(runtime);

    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);

    expect(page.text).toContain('id="s3-backup-button" class="settings-hub-card hidden"');
    expect(page.text).toContain('id="s3-backup-dialog"');
    expect(page.text).toContain('id="s3-backup-dialog-title">S3 备份</h2>');
    expect(page.text).toContain('id="s3-backup-settings-return"');
    expect(page.text).toContain('/app.js?v=20260815-s3-backup-v1');
    expect(page.text).toContain('/styles.css?v=20260815-s3-backup-v1');

    expect(application.text).toContain('async function openS3BackupDialog()');
    expect(application.text).toContain('function renderS3BackupContent()');
    expect(application.text).toContain('function runS3BackupNow()');
    expect(application.text).toContain('function refreshS3BackupNotifications()');
    expect(application.text).toContain('api("/api/platform/s3-backup/run"');
    expect(application.text).toContain('/api/platform/s3-backup/targets');
    expect(application.text).toContain('同步到“子目录/scriverse/img”');
    expect(application.text).toContain('数据库同步到“子目录/scriverse/db”');

    expect(styles.text).toContain('.s3-backup-content');
    expect(styles.text).toContain('.s3-backup-settings-grid');
    expect(styles.text).toContain('.s3-backup-run-targets');
  });
});
