import { describe, expect, it } from "vitest";
import {
  aiConversationExportContentDisposition,
  aiConversationExportFilename,
  exportAiConversationMarkdown
} from "../../src/ai-conversation-export.js";

describe("AI 对话 Markdown 导出", () => {
  const conversation = {
    id: "conversation_safe-1",
    title: "../星海：密谈\r\nX-Test: injected",
    createdAt: "2026-08-12T01:02:03.000Z",
    updatedAt: "2026-08-12T02:03:04.000Z",
    roleplayCharacter: null,
    messages: [
      {
        role: "user",
        content: "请保留 @林舟 与特殊字符 *原样*。\n\n```ts\nconst answer = 42;\n```",
        createdAt: "2026-08-12T01:03:00.000Z",
        metadata: { apiKey: "INTERNAL_KEY", reasoningContent: "INTERNAL_REASONING" }
      },
      {
        role: "assistant",
        content: "第一行\n第二行\n\n- 列表项",
        createdAt: "2026-08-12T01:04:00.000Z"
      }
    ]
  };

  it("按屏幕顺序保留角色、时间和消息 Markdown，且不输出内部 metadata", () => {
    const markdown = exportAiConversationMarkdown(conversation);

    expect(markdown).toContain("# \\.\\./星海：密谈 X-Test: injected");
    expect(markdown).toContain("## 作者 · 2026-08-12T01:03:00.000Z");
    expect(markdown).toContain("## 助手 · 2026-08-12T01:04:00.000Z");
    expect(markdown).toContain("请保留 @林舟 与特殊字符 *原样*。\n\n```ts\nconst answer = 42;\n```");
    expect(markdown).toContain("第一行\n第二行\n\n- 列表项");
    expect(markdown.indexOf("请保留 @林舟")).toBeLessThan(markdown.indexOf("第一行"));
    expect(markdown).not.toContain("INTERNAL_KEY");
    expect(markdown).not.toContain("INTERNAL_REASONING");
  });

  it("生成无路径穿越或响应头换行的下载文件名", () => {
    const filename = aiConversationExportFilename(conversation);
    const disposition = aiConversationExportContentDisposition(conversation);

    expect(filename).toBe("星海-密谈 X-Test- injected-conversation_safe-1.md");
    expect(filename).not.toContain("..");
    expect(disposition).toContain('filename="ai-conversation-conversation_safe-1.md"');
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).not.toMatch(/[\r\n]/u);
    expect(disposition).not.toContain("../");
  });
});
