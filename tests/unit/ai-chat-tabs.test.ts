import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { createAiChatTabManager, normalizeAiChatTabLimit } from "../../src/public/ai-chat-tabs.js";

describe("Agent 对话页签", () => {
  it("为不同对话保留独立状态并复用已经打开的对话", () => {
    let sequence = 0;
    const manager = createAiChatTabManager(() => `tab-${++sequence}`);
    const first = manager.open({ conversationId: "conversation-a", prompt: "第一项草稿" });
    const second = manager.open({ conversationId: "conversation-b", prompt: "第二项草稿" });

    expect(first.id).toBe("tab-1");
    expect(second.id).toBe("tab-2");
    expect(manager.active()).toBe(second);
    expect(manager.open({ conversationId: "conversation-a" })).toBe(first);
    expect(manager.list()).toHaveLength(2);
    expect(manager.active()?.prompt).toBe("第一项草稿");
  });

  it("关闭活动页签后激活相邻页签", () => {
    const manager = createAiChatTabManager();
    const first = manager.open({ title: "一" });
    const second = manager.open({ title: "二" });
    const third = manager.open({ title: "三" });

    manager.activate(second.id);
    expect(manager.close(second.id)).toMatchObject({ closed: second, active: third });
    expect(manager.close(third.id)).toMatchObject({ closed: third, active: first });
    expect(manager.close(first.id)).toMatchObject({ closed: first, active: null });
  });

  it("只接受一到二十之间的安全整数上限", () => {
    expect(normalizeAiChatTabLimit(1)).toBe(1);
    expect(normalizeAiChatTabLimit("5")).toBe(5);
    expect(normalizeAiChatTabLimit(999)).toBe(20);
    expect(normalizeAiChatTabLimit(0)).toBe(5);
    expect(normalizeAiChatTabLimit("invalid", 8)).toBe(8);
  });
});
