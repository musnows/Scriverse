import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app.js";

const runtime = createRuntime({
  databasePath: ":memory:",
  masterSecret: "s3-backup-ui-system-test-secret-at-least-32-chars",
  disableUserAuth: true,
  serveUi: true
});

afterAll(() => runtime.close());

describe("S3 备份界面", () => {
  it("设置中心提供管理员入口与完整备份对话框", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);

    expect(page.text).toContain('id="s3-backup-button"');
    expect(page.text).toContain("<strong>S3 备份</strong>");
    expect(page.text).toContain('id="s3-backup-dialog"');
    expect(page.text).toContain('id="s3-backup-settings-form"');
    expect(page.text).toContain('id="s3-include-images"');
    expect(page.text).toContain("同时备份图片附件（不勾选时仅备份数据库）");
    expect(page.text).toContain('id="s3-retention-count"');
    expect(page.text).toContain('id="s3-schedule-enabled"');
    expect(page.text).toContain('id="s3-schedule-time"');
    expect(page.text).toContain('id="s3-target-form"');
    expect(page.text).toContain('id="s3-target-prefix"');
    expect(page.text).toContain('id="s3-target-secret-key"');
    expect(page.text).toContain('id="s3-target-list"');
    expect(page.text).toContain('id="s3-run-button"');
    expect(page.text).toContain('id="s3-run-list"');

    expect(application.text).toContain("function openS3BackupDialog()");
    expect(application.text).toContain('$("#s3-backup-button").classList.toggle("hidden", !isAdmin)');
    expect(application.text).toContain("function pollS3BackupRun(runId)");
    expect(application.text).toContain("同步失败（HTTP");
    expect(application.text).toContain("function reportS3BackupRun(run)");
    expect(application.text).toContain("没有启用中的备份目标，本次未执行同步");
    expect(application.text).toContain("function fillS3TargetForm(target)");

    expect(styles.text).toContain(".s3-backup-dialog .s3-backup-body");
    expect(styles.text).toContain(".s3-run-row .s3-run-target-failed");
  });
});
