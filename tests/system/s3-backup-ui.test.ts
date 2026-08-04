import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const publicPath = join(process.cwd(), "src", "public");

describe("S3 系统备份设置界面", () => {
  it("在系统设置中提供目标管理、即时同步和失败提示入口", async () => {
    const [page, application, styles, routes] = await Promise.all([
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8"),
      readFile(join(publicPath, "page-route.js"), "utf8")
    ]);

    expect(page).toContain('id="platform-backups-button" class="settings-hub-card hidden"');
    expect(page).toContain('id="platform-backups-view"');
    expect(page).toContain('id="platform-backup-run-all"');
    expect(page).toContain('/app.js?v=20260804-s3-backup-v1');
    expect(page).toContain('/styles.css?v=20260804-s3-backup-v1');
    expect(application).toContain('async function showPlatformBackups()');
    expect(application).toContain('async function renderPlatformBackups(options = {})');
    expect(application).toContain('function openS3BackupTargetDialog(target = null)');
    expect(application).toContain('async function pollS3BackupFailures()');
    expect(application).toContain('/api/platform/backups/run');
    expect(styles).toContain('.s3-backup-target-grid');
    expect(styles).toContain('.s3-backup-target-details');
    expect(routes).toContain('view === "platform-backups"');
  });
});
