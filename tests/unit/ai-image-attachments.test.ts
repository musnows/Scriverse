import { describe, expect, it } from "vitest";
import {
  AI_CHAT_IMAGE_ATTACHMENT_MAX_COUNT,
  aiChatImageAttachmentIds,
  aiChatImageAttachmentUrl,
  isAiChatImageFile,
  normalizeAiChatImageAttachments
} from "../../src/public/ai-image-attachments.js";

describe("AI 对话图片附件前端工具", () => {
  it("只接受支持的图片类型并限制附件数量", () => {
    expect(isAiChatImageFile({ type: "image/png" })).toBe(true);
    expect(isAiChatImageFile({ type: "image/svg+xml" })).toBe(false);
    const attachments = normalizeAiChatImageAttachments([
      { id: "one", originalName: "一.png" },
      { id: "one", originalName: "重复.png" },
      { id: "two", originalName: "二.webp" },
      { id: "three", originalName: "三.jpg" },
      { id: "four", originalName: "四.gif" },
      { id: "five", originalName: "五.png" }
    ]);
    expect(attachments).toHaveLength(AI_CHAT_IMAGE_ATTACHMENT_MAX_COUNT);
    expect(aiChatImageAttachmentIds(attachments)).toEqual(["one", "two", "three", "four"]);
  });

  it("为历史消息生成编码后的附件内容地址", () => {
    expect(aiChatImageAttachmentUrl("attachment/图片")).toBe("/api/attachments/attachment%2F%E5%9B%BE%E7%89%87/content");
  });
});
