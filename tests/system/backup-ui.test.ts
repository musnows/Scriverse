import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app.js";

const runtime = createRuntime({
  databasePath: ":memory:",
  masterSecret: "backup-ui-system-test-secret-at-least-32-characters",
  disableUserAuth: true,
  serveUi: true
});

afterAll(() => runtime.close());

describe("数据备份界面", () => {
  it("在设置中心提供管理员专属的数据备份入口与独立页面", async () => {
    const page = await request(runtime.app).get("/").expect(200);

    expect(page.text).toContain('<button id="platform-backup-button" class="settings-hub-card hidden" type="button">');
    expect(page.text).toContain("<strong>数据备份</strong>");
    expect(page.text).toContain("<small>S3 兼容目标、定时备份与快照留存</small>");
    expect(page.text).toContain('<section id="platform-backup-view" class="shelf-view hidden" aria-labelledby="platform-backup-title">');
    expect(page.text).toContain('<h1 id="platform-backup-title">数据备份</h1>');
    expect(page.text).toContain('<button id="platform-backup-return" class="ghost-button settings-parent-button" type="button">返回设置</button>');
    expect(page.text).toContain('<button id="platform-backup-run" class="ghost-button" type="button">立即备份</button>');
    expect(page.text).toContain('<button id="platform-new-backup-target" class="primary-button" type="button">新建备份目标</button>');
    expect(page.text).toContain('<div id="platform-backup-content" class="module-content"></div>');
    expect(page.text).toContain("/app.js?v=20260804-s3-backup-v2");
    expect(page.text).toContain("/styles.css?v=20260804-s3-backup-v2");

    const module = await request(runtime.app).get("/backup-format.js").expect(200);
    expect(module.text).toContain("export function backupAlertMessage(run)");
  });

  it("沿用平台 AI 管理的分区、卡片与对话框实现", async () => {
    const application = await request(runtime.app).get("/app.js").expect(200);

    expect(application.text).toContain('import {\n  backupAlertMessage,');
    expect(application.text).toContain('"/backup-format.js?v=20260804-s3-backup-v2"');
    expect(application.text).toContain("async function renderPlatformBackupConfig()");
    expect(application.text).toContain('api("/api/platform/backup/settings")');
    expect(application.text).toContain('api("/api/platform/backup/targets")');
    expect(application.text).toContain('api("/api/platform/backup/runs?limit=10")');
    expect(application.text).toContain('<div class="card-grid provider-card-grid">');
    expect(application.text).toContain('<article class="record-card provider-card');
    expect(application.text).toContain('class="config-section backup-schedule-section"');
    expect(application.text).toContain('class="config-section backup-targets-section"');
    expect(application.text).toContain('class="config-section backup-runs-section"');
    expect(application.text).toContain('<section class="task-auto-run-panel backup-schedule-panel"');
    expect(application.text).toContain('<div class="table-scroll"><table class="table-list"><thead><tr><th>开始时间</th>');
    expect(application.text).toContain("function openBackupTargetDialog(item)");
    expect(application.text).toContain('field("prefix", "桶内子目录（留空则使用桶根目录）", "text"');
    expect(application.text).toContain('field("accessKeyId", item ? "替换 Access Key ID（留空则不变）" : "Access Key ID", "password")');
    expect(application.text).toContain('field("secretAccessKey", item ? "替换 Secret Access Key（留空则不变）" : "Secret Access Key", "password")');
    expect(application.text).toContain('field("forcePathStyle", "使用路径风格地址（自建 MinIO 等通常需要）", "checkbox"');
  });

  it("备份计划提供启用开关、触发时间、图片选项与留存个数", async () => {
    const application = await request(runtime.app).get("/app.js").expect(200);

    expect(application.text).toContain('id="backup-schedule-enabled" type="checkbox"');
    expect(application.text).toContain("<span>启用定时备份</span>");
    expect(application.text).toContain('id="backup-schedule-time" type="time" step="60"');
    expect(application.text).toContain('id="backup-include-images" type="checkbox"');
    expect(application.text).toContain("<span>同时备份图片</span>");
    expect(application.text).toContain('id="backup-retention-count" type="number" min="1" max="365"');
    expect(application.text).toContain('id="save-backup-settings" class="primary-button"');
    expect(application.text).toContain("超过留存个数后只删除最旧的数据库快照，已上传的图片不会被清理。");
    expect(application.text).toContain("主密钥 master.key 不会上传");
  });

  it("目标操作覆盖编辑、连通测试、删除确认与手动备份", async () => {
    const application = await request(runtime.app).get("/app.js").expect(200);

    expect(application.text).toContain("data-edit-backup-target=");
    expect(application.text).toContain("data-test-backup-target=");
    expect(application.text).toContain("data-delete-backup-target=");
    expect(application.text).toContain("/test`, { method: \"POST\", body: {} })");
    expect(application.text).toContain("async function runPlatformBackupNow()");
    expect(application.text).toContain('api("/api/platform/backup/run", { method: "POST", body: {} })');
    expect(application.text).toContain('title: "删除备份目标"');
    expect(application.text).toContain('$("#platform-backup-run").disabled = !targets.some((target) => target.status === "enabled")');
  });

  it("轮询未确认的备份失败并以错误提示告知管理员", async () => {
    const application = await request(runtime.app).get("/app.js").expect(200);

    expect(application.text).toContain("async function refreshBackupAlerts()");
    expect(application.text).toContain('if (state.user?.role !== "admin") return;');
    expect(application.text).toContain('api("/api/platform/backup/alerts")');
    expect(application.text).toContain('toast(backupAlertMessage(run), "error")');
    expect(application.text).toContain('api("/api/platform/backup/alerts/ack", { method: "POST", body: { runIds: alerts.map((run) => run.id) } })');
    expect(application.text).toContain("await refreshBackupAlerts();");
    expect(application.text).toContain('$("#platform-backup-button").classList.toggle("hidden", !isAdmin);');
  });

  it("备份页面参与设置路由与视图切换", async () => {
    const application = await request(runtime.app).get("/app.js").expect(200);

    expect(application.text).toContain("async function showPlatformBackup()");
    expect(application.text).toContain('return { view: "platform-backup", workId, ...settingsRouteContext() };');
    expect(application.text).toContain('if (route.view === "platform-backup") {');
    expect(application.text).toContain('["settings", "platform-ai", "platform-usage", "platform-backup", "work-audit"].includes(route.view)');
    expect(application.text).toContain('$("#platform-backup-view").classList.remove("hidden");');
  });

  it("备份面板样式复用自动执行面板并补齐结果列表", async () => {
    const styles = await request(runtime.app).get("/styles.css").expect(200);

    expect(styles.text).toContain(".backup-schedule-panel { grid-template-columns: minmax(0, 1fr); column-gap: 0; }");
    expect(styles.text).toContain('.backup-schedule-panel .task-auto-run-controls input[type="time"] { box-sizing: border-box; height: 32px; padding: 6px 8px; font-size: 12px; }');
    expect(styles.text).toContain(".backup-run-targets { display: grid; gap: 6px; margin: 0; padding-left: 16px; }");
  });
});
