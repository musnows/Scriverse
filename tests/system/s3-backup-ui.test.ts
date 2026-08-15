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
    expect(page.text).toContain('id="s3-backup-encryption-toggle"');
    expect(page.text).toContain('id="s3-backup-encryption-warning"');
    expect(page.text).toContain("请将所有 S3 目标桶设置为私有桶");
    expect(page.text).toContain('id="s3-backup-key-dialog"');
    expect(page.text).toContain('id="s3-backup-key-value"');
    expect(page.text).toContain('id="s3-backup-key-copy"');
    expect(page.text).toContain('id="s3-backup-key-download"');
    expect(page.text).toContain('id="s3-backup-key-confirm"');
    expect(page.text).toContain("我已保存");
    expect(page.text).toContain("确认已保存后才会开启加密");
    expect(page.text).toContain("刷新页面会放弃此次开启，下次可重新生成");
    expect(page.text).toContain("开启加密不会回写桶内已有的明文图片对象，请继续将所有 S3 桶保持为私有桶");
    expect(page.text).toContain('id="s3-backup-target-dialog"');
    expect(page.text).toContain('<form id="s3-backup-target-form" method="post" action="/api/platform/backups/targets">');
    expect(page.text).toContain('id="s3-backup-base-path"');
    expect(page.text).toContain('id="s3-backup-access-key"');
    expect(page.text).toContain('id="s3-backup-secret-key"');
    expect(page.text).toContain('id="s3-backup-images"');
    expect(page.text).toContain('id="s3-backup-schedule-time"');
    expect(page.text).toContain('id="s3-backup-retention-count"');
    expect(page.text).toContain('id="s3-backup-run-all"');
    expect(page.text).toContain('id="s3-backup-runs"');
    expect(page.text).toContain('/styles.css?v=20260816-task-scope-checkbox-v1');
    expect(page.text).toContain('/app.js?v=20260815-ai-stream-persistence-v4');

    expect(application.text).toContain('/s3-backup-ui.js?v=20260810-backup-encryption-v1');
    expect(application.text).toContain('api("/api/platform/backups/encryption")');
    expect(application.text).toContain('api("/api/platform/backups/encryption/confirm"');
    expect(application.text).toContain("s3BackupEncryptionConfirmationToken = confirmationToken");
    expect(application.text).toContain("async function confirmS3BackupEncryptionKeySaved()");
    expect(application.text).toContain('toast("未开启备份加密，请将 S3 桶设置为私有桶，避免数据泄露", "warning")');
    expect(application.text).toContain('anchor.download = "scriverse-s3-backup-key.txt"');
    expect(application.text).toContain('addEventListener("cancel", (event) => event.preventDefault())');
    expect(application.text).not.toContain('title: "准备开启备份加密"');
    expect(application.text).toContain('if (restoreToggleFocus && !$("#s3-backup-key-dialog").open) toggle.focus()');
    expect(application.text).toContain('$("#s3-backup-encryption-toggle").focus()');
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
    expect(helpers.text).toContain("export function s3BackupEncryptionPresentation");
    expect(helpers.text).toContain("export function s3BackupEncryptionKeyFile");
    expect(styles.text).toContain(".dialog.s3-backup-dialog { width: min(900px, 94vw); }");
    expect(styles.text).toContain(".s3-backup-encryption { display: grid;");
    expect(styles.text).toContain(".dialog.s3-backup-key-dialog { width: min(620px, 94vw); }");
    expect(styles.text).toContain(".dialog.s3-backup-target-dialog { width: min(780px, 94vw); height: min(720px, calc(100dvh - 24px));");
    expect(styles.text).toContain(".s3-backup-target-dialog > form { display: grid; grid-template-rows: auto minmax(0, 1fr) auto;");
    expect(styles.text).toContain(".s3-backup-target-meta { grid-column: 1 / -1;");
    expect(styles.text).toContain("@media (max-width: 640px)");
    expect(styles.text).toContain(".s3-backup-target-fields { grid-template-columns: minmax(0, 1fr) !important;");
  });
});
