import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app.js";

const runtime = createRuntime({
  databasePath: ":memory:",
  masterSecret: "admin-ai-conversations-ui-system-test-secret",
  disableUserAuth: true,
  serveUi: true
});

afterAll(() => runtime.close());

describe("管理员 Chat 对话列表界面", () => {
  it("提供系统设置入口、默认收起筛选、只读列表和响应式布局", async () => {
    const [page, application, styles] = await Promise.all([
      request(runtime.app).get("/").expect(200),
      request(runtime.app).get("/app.js").expect(200),
      request(runtime.app).get("/styles.css").expect(200)
    ]);

    expect(page.text).toContain('id="admin-ai-conversations-button" class="settings-hub-card hidden"');
    expect(page.text).toContain("查看所有作品、所有用户的对话记录");
    expect(page.text).toContain('id="admin-ai-conversations-dialog"');
    expect(page.text).toContain('id="admin-ai-conversations-filter-toggle" class="module-filter-toggle"');
    expect(page.text).toContain('aria-controls="admin-ai-conversations-filter-panel" aria-expanded="false"');
    expect(page.text).toContain('id="admin-ai-conversations-filter-panel" class="admin-ai-conversations-filters hidden"');
    expect(page.text).toContain('id="admin-ai-conversations-query"');
    expect(page.text).toContain('id="admin-ai-conversations-work"');
    expect(page.text).toContain('id="admin-ai-conversations-user"');
    expect(page.text).toContain('id="admin-ai-conversations-list"');
    expect(page.text).toContain('id="admin-ai-conversations-load-more"');
    expect(page.text).toContain("feature=admin-ai-conversations-v1");

    expect(application.text).toContain('$("#admin-ai-conversations-button").classList.toggle("hidden", !isAdmin);');
    expect(application.text).toContain('async function openAdminAiConversationsDialog()');
    expect(application.text).toContain('apiPage(adminAiConversationListPath(), page, 30)');
    expect(application.text).toContain('apiAllPages("/api/users", 100)');
    expect(application.text).toContain('adminAiConversationFiltersOpen = !adminAiConversationFiltersOpen;');
    expect(application.text).toContain('setAttribute("aria-expanded", String(adminAiConversationFiltersOpen))');
    expect(application.text).toContain('class="admin-ai-conversation-row"');
    expect(application.text).toContain("未归属历史对话");
    expect(application.text).not.toContain('data-admin-ai-conversation-delete');

    expect(styles.text).toContain('.dialog.admin-ai-conversations-dialog { width: min(1040px, 94vw);');
    expect(styles.text).toContain('.admin-ai-conversations-filters { display: grid;');
    expect(styles.text).toContain('.admin-ai-conversation-meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));');
    expect(styles.text).toContain('.admin-ai-conversations-filters { grid-template-columns: minmax(0, 1fr); align-items: stretch; }');
    expect(styles.text).toContain('.admin-ai-conversation-meta { grid-template-columns: minmax(0, 1fr); }');
  });
});
