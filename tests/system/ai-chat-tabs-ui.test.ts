import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("Agent 多会话切换界面", () => {
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    while (runtimes.length) await runtimes.pop()?.close();
  });

  it("默认提供紧凑切换器、按需工作台和五个对话上限", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "ai-chat-tabs-system-test-secret-32-bytes",
      disableUserAuth: true,
      serveUi: true
    });
    runtimes.push(runtime);

    const [page, application, manager, tabs, styles, health] = await Promise.all([
      request(runtime.app).get("/").expect(200),
      request(runtime.app).get("/app.js").expect(200),
      request(runtime.app).get("/ai-request-manager.js").expect(200),
      request(runtime.app).get("/ai-chat-tabs.js").expect(200),
      request(runtime.app).get("/styles.css").expect(200),
      request(runtime.app).get("/api/health").expect(200)
    ]);

    expect(page.text).toContain('id="ai-conversation-switcher" class="ai-conversation-switcher"');
    expect(page.text).toContain('id="ai-conversation-switcher-menu" class="ai-conversation-switcher-menu hidden"');
    expect(page.text).toContain('id="ai-workspace-open"');
    expect(page.text).not.toContain('id="ai-workspace-close"');
    expect(page.text).toContain('id="ai-chat-tabs" class="ai-chat-tabs hidden" role="tablist"');
    expect(page.text).toContain('id="ai-chat-panels" class="ai-chat-panels"');
    expect(application.text).toContain('/ai-chat-tabs.js?v=20260816-ai-chat-switcher-v2');
    expect(application.text).toContain('function applyAiChatTabLimit(value)');
    expect(application.text).toContain('function setAiConversationWorkspaceVisible(visible)');
    expect(application.text).not.toContain('#ai-workspace-close');
    expect(application.text).toContain('$("#ai-chat-tabs").classList.add("hidden")');
    expect(application.text).toContain('最多同时打开 ${aiChatTabLimit} 个对话');
    expect(application.text).toContain('function activateAiChatTab(tabId');
    expect(application.text).toContain('function closeAiChatTab(tabId)');
    expect(application.text).toContain('snapshot: aiRequestManager.begin({\n      tabId: tab.id');
    expect(application.text).toContain('const feed = tab.feed;');
    expect(application.text).toContain('appendMessage("user", persistedUserMessage.content');
    expect(manager.text).toContain('const activeRequests = new Map();');
    expect(manager.text).toContain('activeRequests.has(request.tabId)');
    expect(tabs.text).toContain('export function createAiChatTabManager');
    expect(tabs.text).toContain('export function normalizeAiChatTabLimit');
    expect(health.body.data.aiChatTabLimit).toBe(5);
    expect(styles.text).toContain('.ai-conversation-switcher-menu { position: absolute;');
    expect(styles.text).toContain('.ai-panel.is-conversation-workspace { position: fixed;');
    expect(styles.text).toContain('.ai-chat-tabs { display: flex;');
    expect(styles.text).toContain('.ai-chat-tab-status.is-streaming');
    expect(styles.text).toContain('.ai-chat-panels { display: flex; flex: 1; min-height: 0; }');
  });

  it("把上限一暴露为关闭多会话的运行时配置", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "ai-chat-single-session-test-secret-32-bytes",
      disableUserAuth: true,
      aiChatTabLimit: 1
    });
    runtimes.push(runtime);

    const response = await request(runtime.app).get("/api/health").expect(200);
    expect(response.body.data.aiChatTabLimit).toBe(1);
  });
});
