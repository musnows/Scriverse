import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 对话标题生成设置", () => {
  it("第一轮助手回复后刷新异步生成的对话标题", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, page, ai, routes] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(process.cwd(), "src", "ai.ts"), "utf8"),
      readFile(join(process.cwd(), "src", "app.ts"), "utf8")
    ]);

    expect(application).toContain("data-title-generation-default");
    expect(application).toContain("创作助手对话标题生成");
    expect(application).toContain("使用提示词前 15 个字");
    expect(application).toContain("titleGenerationModelId: select.value");
    expect(application).toContain('aiConversationTitleSource(String(prompt ?? ""))');
    expect(application).toContain("/roleplay-turn.js?v=20260930-ai-title-xml-v1");
    expect(application).toContain("applyAiConversationTitle(streamed.conversationTitle, streamedRequest.conversationId)");
    expect(application).toContain("conversationTitle = typeof payload.conversationTitle === \"string\"");
    expect(application).toContain("conversationTitleGenerationStarted = payload.conversationTitleGenerationStarted === true");
    expect(application).toContain("refreshAiConversationTitleAfterGeneration(");
    expect(application).toContain("/api/ai-conversations/${encodeURIComponent(conversationId)}/title");
    expect(ai).toContain("isCompletingFirstAssistantTurn");
    expect(ai).not.toContain("isCompletingSecondAssistantTurn");
    expect(routes).toContain("await ai.waitForConversationTitle(conversationId)");
    expect(page).toContain('id="ai-conversation-title"');
    expect(page).toContain("feature=ai-title-first-turn-v1");
    expect(page).toContain("feature=ai-title-xml-v1");
  });
});
