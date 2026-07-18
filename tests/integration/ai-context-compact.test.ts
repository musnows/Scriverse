import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("AI 对话上下文压缩", () => {
  let runtime: Runtime;
  let workId: string;
  let chapterId: string;
  let modelId: string;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(async () => {
    fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "compact-model" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }>; tools?: unknown[] };
      const joined = body.messages.map((message) => message.content).join("\n");
      if (joined.includes("结构化中文长期记忆")) {
        expect(body.tools).toBeUndefined();
        const sourceIds = [...joined.matchAll(/\[(message_[^\]]+)\]/gu)].map((match) => match[1]).filter(Boolean);
        return new Response(JSON.stringify({ choices: [{ message: { content: `<json>${JSON.stringify({
          authorGoals: [{ text: "继续确认飞船状态", sourceMessageIds: sourceIds.slice(0, 1) }],
          confirmedDecisions: [],
          storyFacts: [{ text: "飞船仍在北港附近", sourceMessageIds: sourceIds }],
          constraints: [{ text: "必须遵守跃迁冷却规则", sourceMessageIds: sourceIds.slice(0, 1) }],
          unresolvedQuestions: [],
          importantReferences: []
        })}</json>` } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "已结合压缩摘要和最近对话回答。" } }] }), { status: 200 });
    });
    runtime = createTestRuntime(fetchMock);
    const work = await request(runtime.app).post("/api/works").send({ title: "上下文压缩测试" }).expect(201);
    workId = work.body.data.id;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({ volumeId: volume.body.data.id, title: "第一章", content: "飞船停靠在北港。" }).expect(201);
    chapterId = chapter.body.data.id;
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "压缩测试服务",
      baseUrl: "https://compact.test/v1",
      apiKey: "sk-compact-test",
      status: "enabled"
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "压缩模型",
      modelId: "compact-model",
      contextWindow: 4096
    }).expect(201);
    modelId = model.body.data.id;
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ contextCompactThreshold: 50 }).expect(200);
  });

  afterEach(() => runtime.close());

  it("达到阈值先提醒，继续发送时自动压缩并只保留摘要和最近消息", async () => {
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = conversation.body.data.id;
    const oldUser = `旧作者要求：${"必须遵守跃迁冷却规则。".repeat(90)}`;
    const oldAssistant = `旧助手回答：${"飞船仍在北港附近。".repeat(90)}`;
    const recentUser = "最近问题：当前燃料还剩多少？";
    const recentAssistant = "最近回答：燃料数据尚未在正文中明确。";
    for (const [role, content] of [["user", oldUser], ["assistant", oldAssistant], ["user", recentUser], ["assistant", recentAssistant]] as const) {
      await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({ role, content }).expect(201);
    }
    const requestBody = { modelId, scope: { type: "chapter", chapterId }, instruction: "继续回答燃料问题。" };

    const usage = await request(runtime.app).post(`/api/works/${workId}/ai-context-usage`).send({ ...requestBody, taskType: "chat", conversationId }).expect(200);
    expect(usage.body.data).toMatchObject({ compactThreshold: 50, compactRecommended: true, contextWarningPending: false });
    expect(usage.body.data.usagePercent).toBeGreaterThanOrEqual(50);

    const warned = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/context/prepare`).send(requestBody).expect(200);
    expect(warned.body.data).toMatchObject({ action: "warn", usage: { contextWarningPending: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const compacted = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/context/prepare`).send(requestBody).expect(200);
    expect(compacted.body.data).toMatchObject({ action: "compacted", compaction: { compactedMessageCount: 2, retainedMessageCount: 2, changed: true } });
    const reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(reloaded.body.data).toMatchObject({ compactedMessageCount: 2, hasCompactedSummary: true, contextWarningPending: false });

    const current = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({ role: "user", content: requestBody.instruction }).expect(201);
    let actualMessages: Array<{ role: string; content: string }> = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "compact-model" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      actualMessages = body.messages;
      return new Response(JSON.stringify({ choices: [{ message: { content: "已结合压缩摘要和最近对话回答。" } }] }), { status: 200 });
    });
    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      ...requestBody,
      conversationId,
      currentMessageId: current.body.data.id
    }).expect(200);
    expect(streamed.text).toContain("已结合压缩摘要和最近对话回答。");
    const modelContext = actualMessages.map((message) => message.content).join("\n");
    expect(modelContext).toContain("较早对话的结构化长期记忆");
    expect(modelContext).toContain("必须遵守跃迁冷却规则");
    expect(modelContext).toContain(recentUser);
    expect(modelContext).toContain(recentAssistant);
    expect(modelContext).not.toContain("旧作者要求");
    expect(modelContext.match(/继续回答燃料问题。/gu)).toHaveLength(1);
  });

  it("手动整理较长对话时优先保留最近八条原始消息", async () => {
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = conversation.body.data.id;
    for (let index = 0; index < 12; index += 1) {
      await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `第 ${index + 1} 条对话，记录跃迁计划。`
      }).expect(201);
    }

    const compacted = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/compact`).send({
      modelId,
      scope: { type: "chapter", chapterId }
    }).expect(200);

    expect(compacted.body.data).toMatchObject({ compactedMessageCount: 4, retainedMessageCount: 8, changed: true });
    expect(compacted.body.data.memoryItemCount).toBeGreaterThan(0);
  });

  it("正文区块过长时降级正文而不误触发对话压缩", async () => {
    runtime.store.saveChapter(chapterId, { content: `当前章节开头。${"非常长的章节正文。".repeat(2_000)}当前章节结尾。` });
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = conversation.body.data.id;
    for (const [role, content] of [["user", "问题一"], ["assistant", "回答一"], ["user", "问题二"], ["assistant", "回答二"]] as const) {
      await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({ role, content }).expect(201);
    }

    const usage = await request(runtime.app).post(`/api/works/${workId}/ai-context-usage`).send({
      modelId,
      taskType: "chat",
      scope: { type: "chapter", chapterId },
      instruction: "概括当前章节。",
      conversationId
    }).expect(200);

    expect(usage.body.data.compactRecommended).toBe(false);
    expect(usage.body.data.degradedContextBlocks).toBeGreaterThan(0);
    expect(usage.body.data.inputTokens).toBeLessThan(usage.body.data.contextWindow);
    expect(usage.body.data).toMatchObject({ conversationTokens: expect.any(Number), conversationBudgetTokens: expect.any(Number) });
  });

  it("拒绝把其他作品的对话混入当前模型上下文", async () => {
    const otherWork = await request(runtime.app).post("/api/works").send({ title: "其他作品" }).expect(201);
    const conversation = await request(runtime.app).post(`/api/works/${otherWork.body.data.id}/ai-conversations`).send({}).expect(201);
    const response = await request(runtime.app).post(`/api/works/${workId}/ai-context-usage`).send({
      modelId,
      taskType: "chat",
      scope: { type: "chapter", chapterId },
      instruction: "越权读取",
      conversationId: conversation.body.data.id
    }).expect(400);
    expect(response.body.error.code).toBe("CONVERSATION_WORK_MISMATCH");
  });
});
