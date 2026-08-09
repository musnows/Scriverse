import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app.js";

const runtime = createRuntime({
  databasePath: ":memory:",
  masterSecret: "s3-backup-ui-system-test-secret-at-least-32-characters",
  disableUserAuth: true,
  serveUi: true
});

afterAll(() => runtime.close());

describe("S3 系统备份界面", () => {
  it("提供管理员入口、多目标表单、运行历史和失败 Toast 轮询", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);
    const helpers = await request(runtime.app).get("/s3-backup-ui.js").expect(200);

    expect(page.text).toContain('id="s3-backup-button" class="settings-hub-card hidden"');
    expect(page.text).toContain("将整个系统的数据库和图片同步到多个目标");
    expect(page.text).toContain('id="s3-backup-dialog"');
    expect(page.text).toContain("备份范围始终是整个 Scriverse 系统，不按作品拆分");
    expect(page.text).toContain('id="s3-backup-target-dialog"');
    expect(page.text).toContain('id="s3-backup-base-path"');
    expect(page.text).toContain('id="s3-backup-access-key"');
    expect(page.text).toContain('id="s3-backup-secret-key"');
    expect(page.text).toContain('id="s3-backup-images"');
    expect(page.text).toContain('id="s3-backup-schedule-time"');
    expect(page.text).toContain('id="s3-backup-retention-count"');
    expect(page.text).toContain('id="s3-backup-run-all"');
    expect(page.text).toContain('id="s3-backup-runs"');
    expect(page.text).toContain('/styles.css?v=20260809-galaxy-memory-v1');
    expect(page.text).toContain('/app.js?v=20260809-galaxy-memory-v3');

    expect(application.text).toContain('/s3-backup-ui.js?v=20260804-s3-backup-v1');
    expect(application.text).toContain('api("/api/platform/backups/targets")');
    expect(application.text).toContain('api("/api/platform/backups/runs?limit=100")');
    expect(application.text).toContain('api("/api/platform/backups/run"');
    expect(application.text).toContain('collectS3BackupRunTransitions(');
    expect(application.text).toContain('toast(s3BackupFailureToast(run), "error")');
    expect(application.text).toContain('console.error("Failed to refresh S3 backup events", error)');
    expect(application.text).not.toContain("accessKeyId: target");
    expect(application.text).not.toContain("secretAccessKey: target");

    expect(helpers.text).toContain("export function collectS3BackupRunTransitions");
    expect(helpers.text).toContain("export function s3BackupFailureToast");
    expect(styles.text).toContain(".dialog.s3-backup-dialog { width: min(900px, 94vw); }");
    expect(styles.text).toContain(".dialog.s3-backup-target-dialog { width: min(780px, 94vw); height: min(720px, calc(100dvh - 24px));");
    expect(styles.text).toContain(".s3-backup-target-dialog > form { display: grid; grid-template-rows: auto minmax(0, 1fr) auto;");
    expect(styles.text).toContain(".s3-backup-target-meta { grid-column: 1 / -1;");
    expect(styles.text).toContain("@media (max-width: 640px)");
    expect(styles.text).toContain(".s3-backup-target-fields { grid-template-columns: minmax(0, 1fr) !important;");
  });
});
