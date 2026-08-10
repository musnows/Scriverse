import { afterEach, describe, expect, it } from "vitest";
import { createTestRuntime, seedChapter } from "../helpers.js";

describe("AI 对话 system 时钟冻结", () => {
  const runtimes: ReturnType<typeof createTestRuntime>[] = [];
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.close();
  });

  it("首轮写入后禁止更新，分支对话继承原时钟", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const { work } = await seedChapter(runtime);
    const conversation = runtime.store.createAiConversation(String(work.id), "时钟冻结");

    const first = runtime.store.ensureAiConversationSystemClock(
      String(conversation.id),
      String(work.id),
      "当前时间：2026-08-01 11:05 星期六（Asia/Shanghai）"
    );
    const second = runtime.store.ensureAiConversationSystemClock(
      String(conversation.id),
      String(work.id),
      "当前时间：2026-08-01 12:99 星期六（Asia/Shanghai）"
    );
    expect(first).toBe("当前时间：2026-08-01 11:05 星期六（Asia/Shanghai）");
    expect(second).toBe(first);

    const message = runtime.store.addAiConversationMessage(String(conversation.id), {
      role: "user",
      content: "你好"
    });
    const forked = runtime.store.forkAiConversation(String(conversation.id), String(message.id));
    const forkedClock = runtime.store.ensureAiConversationSystemClock(
      String(forked.id),
      String(work.id),
      "当前时间：2099-01-01 00:00 星期四（Asia/Shanghai）"
    );
    expect(forkedClock).toBe(first);
  });
});
