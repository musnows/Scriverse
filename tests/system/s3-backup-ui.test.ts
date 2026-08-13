import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const [page, application, styles] = await Promise.all([
  readFile(join(process.cwd(), "src", "public", "index.html"), "utf8"),
  readFile(join(process.cwd(), "src", "public", "app.js"), "utf8"),
  readFile(join(process.cwd(), "src", "public", "styles.css"), "utf8")
]);

describe("S3 备份设置界面静态结构", () => {
  it("设置中心包含 S3 备份入口卡片与独立视图", () => {
    expect(page).toContain('id="s3-backup-button" class="settings-hub-card hidden"');
    expect(page).toContain("S3 备份");
    expect(page).toContain('id="backup-view"');
    expect(page).toContain('id="backup-title"');
    expect(page).toContain('id="backup-return"');
    expect(page).toContain('id="backup-run-now" class="primary-button"');
    expect(page).toContain('id="backup-content" class="module-content"');
  });

  it("入口卡片仅对管理员可见", () => {
    const showSettingsHubToggle = application.match(/\$\("#s3-backup-button"\)\.classList\.toggle\("hidden", !isAdmin\);/u);
    expect(showSettingsHubToggle).not.toBeNull();
    expect(page).toContain('app.js?v=20260813-s3-backup-v1');
  });

  it("渲染函数拉取设置、目标与最近状态", () => {
    expect(application).toContain('function showS3Backup()');
    expect(application).toContain('function renderS3Backup()');
    expect(application).toContain('api("/api/platform/backup/settings")');
    expect(application).toContain('api("/api/platform/backup/targets")');
    expect(application).toContain('api("/api/platform/backup/status")');
    expect(application).toContain('id="backup-schedule-enabled"');
    expect(application).toContain('id="backup-schedule-time" type="time"');
    expect(application).toContain('id="backup-images-enabled"');
    expect(application).toContain('id="backup-retention-count" type="number"');
    expect(application).toContain('id="backup-settings-save" class="primary-button"');
    expect(application).toContain('id="backup-new-target" class="ghost-button"');
    expect(application).toContain('id="backup-last-run" class="backup-run-status');
  });

  it("目标卡片展示端点、桶、子目录与掩码密钥", () => {
    expect(application).toContain('data-edit-backup-target');
    expect(application).toContain('data-delete-backup-target');
    expect(application).toContain("存储桶：");
    expect(application).toContain("子目录：");
    expect(application).toContain("桶根目录");
    expect(application).toContain("访问密钥：");
  });

  it("目标编辑对话框使用留空不变的凭据模式", () => {
    expect(application).toContain('function openBackupTargetDialog(item)');
    expect(application).toContain('"替换访问密钥 ID（留空则不变）"');
    expect(application).toContain('"替换访问密钥（留空则不变）"');
    expect(application).toContain('field("enabled", "启用该目标", "checkbox"');
    expect(application).toContain("scriverse/db");
    expect(application).toContain("scriverse/img");
    expect(application).toContain('"/api/platform/backup/targets"');
    expect(application).toContain('`/api/platform/backup/targets/${item.id}`');
  });

  it("立即备份触发后轮询直至结束并提示结果", () => {
    expect(application).toContain('async function triggerBackupNow()');
    expect(application).toContain('api("/api/platform/backup/run", { method: "POST", body: {} })');
    expect(application).toContain('async function pollBackupUntilFinished()');
    expect(application).toContain('toast("备份完成")');
    expect(application).toContain('toast(`备份失败：${failedTargets.length');
  });

  it("后台轮询发现新失败时提示，禁止静默失败", () => {
    expect(application).toContain('function observeBackupStatus(status');
    expect(application).toContain('async function checkBackupFailureNotice()');
    expect(application).toContain('function scheduleBackupFailureCheck(delay = 60000)');
    expect(application).toContain('scheduleBackupFailureCheck();');
    expect(application).toContain('toast(`${summary} 同步失败，请打开 S3 备份设置查看详情`, "error")');
  });

  it("样式包含备份状态与设置网格", () => {
    expect(styles).toContain(".backup-run-status");
    expect(styles).toContain(".backup-run-status.is-failed");
    expect(styles).toContain(".backup-settings-grid .checkbox-field");
  });
});
