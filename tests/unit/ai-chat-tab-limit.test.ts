import { describe, expect, it } from "vitest";
import {
  AI_CHAT_TAB_LIMIT_ENV,
  DEFAULT_AI_CHAT_TAB_LIMIT,
  MAX_AI_CHAT_TAB_LIMIT,
  MIN_AI_CHAT_TAB_LIMIT,
  resolveAiChatTabLimit
} from "../../src/ai-chat-tab-limit.js";

describe("Agent 对话页签上限", () => {
  it("默认允许同时打开五个对话", () => {
    expect(resolveAiChatTabLimit({})).toBe(DEFAULT_AI_CHAT_TAB_LIMIT);
    expect(DEFAULT_AI_CHAT_TAB_LIMIT).toBe(5);
  });

  it("允许用环境变量关闭多会话或调整上限", () => {
    expect(resolveAiChatTabLimit({ [AI_CHAT_TAB_LIMIT_ENV]: "1" })).toBe(MIN_AI_CHAT_TAB_LIMIT);
    expect(resolveAiChatTabLimit({ [AI_CHAT_TAB_LIMIT_ENV]: " 8 " })).toBe(8);
    expect(resolveAiChatTabLimit({ [AI_CHAT_TAB_LIMIT_ENV]: "999" })).toBe(MAX_AI_CHAT_TAB_LIMIT);
  });

  it("非法配置回退默认值", () => {
    for (const value of ["", "0.5", "false", "NaN", "-1"]) {
      expect(resolveAiChatTabLimit({ [AI_CHAT_TAB_LIMIT_ENV]: value })).toBe(DEFAULT_AI_CHAT_TAB_LIMIT);
    }
  });
});
