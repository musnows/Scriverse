import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("Agent 多页签对话界面", () => {
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    while (runtimes.length) await runtimes.pop()?.close();
  });

  it("提供可访问的页签栏、独立面板和页签级并发请求状态", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "ai-chat-tabs-system-test-secret-32-bytes",
      disableUserAuth: true,
      serveUi: true
    });
    runtimes.push(runtime);

    const [page, application, manager, tabs, styles] = await Promise.all([
      request(runtime.app).get("/").expect(200),
      request(runtime.app).get("/app.js").expect(200),
      request(runtime.app).get("/ai-request-manager.js").expect(200),
      request(runtime.app).get("/ai-chat-tabs.js").expect(200),
      request(runtime.app).get("/styles.css").expect(200)
    ]);

    expect(page.text).toContain('id="ai-chat-tabs" class="ai-chat-tabs" role="tablist"');
    expect(page.text).toContain('id="ai-chat-panels" class="ai-chat-panels"');
    expect(application.text).toContain('/ai-chat-tabs.js?v=20260816-ai-chat-tabs-v1');
    expect(application.text).toContain('function activateAiChatTab(tabId');
    expect(application.text).toContain('function closeAiChatTab(tabId)');
    expect(application.text).toContain('snapshot: aiRequestManager.begin({\n      tabId: tab.id');
    expect(application.text).toContain('const feed = tab.feed;');
    expect(application.text).toContain('appendMessage("user", persistedUserMessage.content');
    expect(manager.text).toContain('const activeRequests = new Map();');
    expect(manager.text).toContain('activeRequests.has(request.tabId)');
    expect(tabs.text).toContain('export function createAiChatTabManager');
    expect(styles.text).toContain('.ai-chat-tabs { display: flex;');
    expect(styles.text).toContain('.ai-chat-tab-status.is-streaming');
    expect(styles.text).toContain('.ai-chat-panels { display: flex; flex: 1; min-height: 0; }');
  });
});
