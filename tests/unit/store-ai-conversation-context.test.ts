import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("AI 对话上下文按需读取", () => {
  let runtime: Runtime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  function createConversation(): { workId: string; conversationId: string } {
    runtime = createTestRuntime();
    const work = runtime.store.createWork({ title: "上下文读取测试", author: "测试作者" });
    const conversation = runtime.store.createAiConversation(String(work.id));
    return { workId: String(work.id), conversationId: String(conversation.id) };
  }

  it("覆盖空历史和未压缩历史并保持消息顺序", () => {
    const { workId, conversationId } = createConversation();
    const empty = runtime!.store.getAiConversationContext(conversationId, workId);
    expect(empty).toMatchObject({ totalMessageCount: 0, compactedMessageCount: 0, messages: [] });

    const first = runtime!.store.addAiConversationMessage(conversationId, { role: "user", content: "第一条" });
    const second = runtime!.store.addAiConversationMessage(conversationId, { role: "assistant", content: "第二条" });
    const allSpy = vi.spyOn(runtime!.database, "all");

    const context = runtime!.store.getAiConversationContext(conversationId, workId);

    expect(context).toMatchObject({ totalMessageCount: 2, compactedMessageCount: 0 });
    expect(context.messages.map((message) => ({ id: message.id, role: message.role, content: message.content }))).toEqual([
      { id: first.id, role: "user", content: "第一条" },
      { id: second.id, role: "assistant", content: "第二条" }
    ]);
    const tailCall = allSpy.mock.calls.find(([sql]) => String(sql).includes("ORDER BY created_at, rowid LIMIT ?"));
    expect(tailCall?.slice(1)).toEqual([conversationId, 2]);
  });

  it("以压缩边界为游标只读取未压缩尾部，追加消息后不遗漏或重复", () => {
    const { workId, conversationId } = createConversation();
    const hugeOldContent = `旧消息：${"不会进入上下文。".repeat(50_000)}`;
    const messages = Array.from({ length: 6 }, (_, index) => runtime!.store.addAiConversationMessage(conversationId, {
      role: index % 2 === 0 ? "user" : "assistant",
      content: index < 4 ? `${hugeOldContent}${index}` : `尾部消息 ${index + 1}`
    }));
    const sharedTimestamp = "2020-01-01T00:00:00.000Z";
    runtime!.database.run(
      "UPDATE ai_conversation_messages SET created_at = ? WHERE conversation_id = ?",
      sharedTimestamp,
      conversationId
    );
    runtime!.database.run(
      "UPDATE ai_conversations SET compacted_summary = ?, compacted_message_count = ? WHERE id = ?",
      JSON.stringify({ constraints: [{ text: "旧消息已压缩", sourceMessageIds: messages.slice(0, 4).map((message) => String(message.id)) }] }),
      4,
      conversationId
    );
    const getSpy = vi.spyOn(runtime!.database, "get");
    const allSpy = vi.spyOn(runtime!.database, "all");

    const context = runtime!.store.getAiConversationContext(conversationId, workId);

    expect(context).toMatchObject({ totalMessageCount: 6, compactedMessageCount: 4 });
    expect(context.messages.map((message) => message.content)).toEqual(["尾部消息 5", "尾部消息 6"]);
    expect(JSON.stringify(context.messages)).not.toContain("不会进入上下文");
    const boundaryCall = getSpy.mock.calls.find(([sql]) => String(sql).includes("SELECT created_at, rowid"));
    expect(boundaryCall?.slice(1)).toEqual([conversationId, 3]);
    const tailCall = allSpy.mock.calls.find(([sql]) => String(sql).includes("AND (created_at > ?"));
    expect(tailCall?.[1]).toBe(conversationId);
    expect(tailCall?.at(-1)).toBe(2);

    const appended = runtime!.store.addAiConversationMessage(conversationId, { role: "user", content: "并发追加的尾部消息" });
    const appendedContext = runtime!.store.getAiConversationContext(conversationId, workId);
    expect(appendedContext).toMatchObject({ totalMessageCount: 7, compactedMessageCount: 4 });
    expect(appendedContext.messages.map((message) => message.id)).toEqual([messages[4]?.id, messages[5]?.id, appended.id]);

    const fullHistory = runtime!.store.getAiConversation(conversationId);
    expect(fullHistory.messageCount).toBe(7);
    expect((fullHistory.messages as Array<Record<string, unknown>>)[0]?.content).toContain("不会进入上下文");
  });
});
