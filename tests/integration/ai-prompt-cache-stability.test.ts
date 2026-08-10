/**
 * Prompt cache 稳定性门禁。
 *
 * 本文件断言多轮对话上行时：system 冻结、历史 message content 原样复用、本轮注入只追加在末尾。
 * 除非明确咨询用户并获得同意，否则任何时候禁止修改本测试用例（含弱化断言、删除用例、改期望值、
 * 调整捕获范围）来绕过失败；失败时必须先修复产品实现，不得为本文件开例外。
 */
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

type CompletionMessage = {
  role: string;
  content?: string;
  reasoning_content?: string;
};

function isChatCompletionRequest(input: unknown, init?: RequestInit): boolean {
  if (String(input).endsWith("/models")) return false;
  const body = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean; max_tokens?: number };
  return body.stream === true || (body.max_tokens !== 10 && !String(input).endsWith("/models"));
}

function parseMessages(init?: RequestInit): CompletionMessage[] {
  const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: CompletionMessage[] };
  return body.messages ?? [];
}

/** 去掉末尾本轮注入（story_context + author_instruction），得到可缓存前缀。 */
function cacheablePrefix(messages: CompletionMessage[]): CompletionMessage[] {
  expect(messages.length).toBeGreaterThanOrEqual(3);
  expect(messages.at(-1)?.content).toContain("<author_instruction>");
  expect(messages.at(-2)?.content).toContain("<story_context>");
  return messages.slice(0, -2).map(normalizeMessage);
}

function normalizeMessage(message: CompletionMessage): CompletionMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.reasoning_content === undefined ? {} : { reasoning_content: message.reasoning_content })
  };
}

// 门禁：未经用户明确同意，禁止改本 describe 内断言以消解失败。
describe("AI 多轮 prompt cache 稳定性", () => {
  let runtime: Runtime;
  let workId: string;
  let chapterId: string;
  let modelId: string;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let capturedTurns: CompletionMessage[][];

  beforeEach(async () => {
    capturedTurns = [];
    fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "cache-stable-model" }] }), { status: 200 });
      }
      if (!isChatCompletionRequest(input, init)) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean; messages?: CompletionMessage[] };
      if (body.stream) {
        capturedTurns.push(parseMessages(init));
        const turn = capturedTurns.length;
        return new Response(
          `data: {"choices":[{"delta":{"content":"第${turn}轮助手回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "非流式占位" } }] }), { status: 200 });
    });
    runtime = createTestRuntime(fetchMock);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-01T03:05:00.000Z"));

    const work = await request(runtime.app).post("/api/works").send({ title: "Prompt Cache 测试" }).expect(201);
    workId = work.body.data.id;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "林舟抵达北港，准备跃迁。"
    }).expect(201);
    chapterId = chapter.body.data.id;
    await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "跃迁限制",
      category: "世界规则",
      content: "跃迁后必须冷却十二小时。",
      locked: true,
      status: "confirmed"
    }).expect(201);

    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "Cache 测试服务",
      baseUrl: "https://cache-stable.test/v1",
      apiKey: "sk-cache-stable",
      status: "enabled"
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "Cache 模型",
      modelId: "cache-stable-model",
      contextWindow: 32_768
    }).expect(201);
    modelId = model.body.data.id;
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentTools: [],
      contextCompactThreshold: 90
    }).expect(200);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await runtime.close();
  });

  async function streamTurn(instruction: string, scope: Record<string, unknown>, conversationId?: string): Promise<string> {
    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction,
      scope,
      modelId,
      ...(conversationId ? { conversationId } : {})
    }).expect(200).expect("Content-Type", /text\/event-stream/u);
    const complete = JSON.parse(streamed.text.match(/event: complete\ndata: ([^\n]+)/u)?.[1] ?? "{}") as { conversationId?: string };
    expect(complete.conversationId).toBeTruthy();
    return String(complete.conversationId);
  }

  // 门禁：未经用户明确同意，禁止修改本用例断言来绕过失败。
  it("多轮上行时 system 与历史前缀字节级不变，本轮注入只追加在末尾", async () => {
    const conversationId = await streamTurn("第一轮：北港有什么约束？", {
      type: "chapter",
      chapterId,
      includeSettingInfo: true
    });

    vi.setSystemTime(new Date("2026-08-01T05:55:00.000Z"));
    await streamTurn("第二轮：冷却多久？", {
      type: "none",
      suppressAutomaticContext: true,
      includeSettingInfo: false
    }, conversationId);

    vi.setSystemTime(new Date("2026-08-02T10:00:00.000Z"));
    await streamTurn("第三轮：再确认一次地点", {
      type: "chapter",
      chapterId,
      includeSettingInfo: true
    }, conversationId);

    expect(capturedTurns).toHaveLength(3);
    const [turn1, turn2, turn3] = capturedTurns as [CompletionMessage[], CompletionMessage[], CompletionMessage[]];

    // system 使用 XML 分区，且对话内时钟首轮冻结
    for (const turn of [turn1, turn2, turn3]) {
      expect(turn[0]?.role).toBe("system");
      expect(turn[0]?.content).toContain("<system_prompt>");
      expect(turn[0]?.content).toContain("<core_rules>");
      expect(turn[0]?.content).toContain("<current_time>");
      expect(turn[0]?.content).toContain("当前时间：2026-08-01 11:05 星期六（Asia/Shanghai）");
      expect(turn[0]?.content).not.toContain("12:55");
      expect(turn[0]?.content).not.toContain("2026-08-02");
    }
    expect(turn2[0]?.content).toBe(turn1[0]?.content);
    expect(turn3[0]?.content).toBe(turn1[0]?.content);

    // 历史消息不得被 XML 外包
    const historyBlob = [...turn2, ...turn3].map((message) => message.content ?? "").join("\n");
    expect(historyBlob).not.toContain("<prior_author_instruction>");
    expect(historyBlob).not.toContain("<assistant_reply>");

    // 第 1 轮：无历史，仅本轮 context + instruction
    expect(turn1.map((message) => message.role)).toEqual(["system", "user", "user"]);
    expect(turn1[1]?.content).toContain("<story_context>");
    expect(turn1[1]?.content).toContain("跃迁后必须冷却十二小时");
    expect(turn1[2]?.content).toContain("<author_instruction>");
    expect(turn1[2]?.content).toContain("第一轮：北港有什么约束？");

    // 第 2 轮：历史原文在前，本轮注入在后；上下文选择变化不影响历史
    expect(turn2.map((message) => message.role)).toEqual(["system", "user", "assistant", "user", "user"]);
    expect(turn2[1]?.content).toBe("第一轮：北港有什么约束？");
    expect(turn2[2]?.content).toBe("第1轮助手回复");
    expect(turn2[3]?.content).toContain("<story_context>");
    expect(turn2[3]?.content).toContain("本轮未提供作品上下文");
    expect(turn2[3]?.content).not.toContain("跃迁后必须冷却十二小时");
    expect(turn2[4]?.content).toContain("第二轮：冷却多久？");

    // 第 3 轮：前缀 = 第 2 轮去掉本轮注入后的全部内容
    expect(cacheablePrefix(turn3)).toEqual([
      ...cacheablePrefix(turn2),
      { role: "user", content: "第二轮：冷却多久？" },
      { role: "assistant", content: "第2轮助手回复" }
    ]);
    expect(turn3.at(-2)?.content).toContain("跃迁后必须冷却十二小时");
    expect(turn3.at(-1)?.content).toContain("第三轮：再确认一次地点");

    // 库内历史也保持原文，与上行历史一致
    const stored = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(stored.body.data.messages.map((message: { role: string; content: string }) => ({
      role: message.role,
      content: message.content
    }))).toEqual([
      { role: "user", content: "第一轮：北港有什么约束？" },
      { role: "assistant", content: "第1轮助手回复" },
      { role: "user", content: "第二轮：冷却多久？" },
      { role: "assistant", content: "第2轮助手回复" },
      { role: "user", content: "第三轮：再确认一次地点" },
      { role: "assistant", content: "第3轮助手回复" }
    ]);
    expect(turn2.slice(1, 3).map(normalizeMessage)).toEqual([
      { role: "user", content: "第一轮：北港有什么约束？" },
      { role: "assistant", content: "第1轮助手回复" }
    ]);
    expect(turn3.slice(1, 5).map(normalizeMessage)).toEqual([
      { role: "user", content: "第一轮：北港有什么约束？" },
      { role: "assistant", content: "第1轮助手回复" },
      { role: "user", content: "第二轮：冷却多久？" },
      { role: "assistant", content: "第2轮助手回复" }
    ]);
  });

  // 门禁：未经用户明确同意，禁止修改本用例断言来绕过失败。
  it("同一对话再次计量上下文用量也不会改写已冻结的 system 时钟", async () => {
    const conversationId = await streamTurn("先问一句", { type: "chapter", chapterId });
    const frozenSystem = capturedTurns[0]?.[0]?.content;
    expect(frozenSystem).toContain("当前时间：2026-08-01 11:05 星期六（Asia/Shanghai）");

    vi.setSystemTime(new Date("2026-12-31T15:00:00.000Z"));
    await request(runtime.app).post(`/api/ai-conversations/${conversationId}/context/prepare`).send({
      modelId,
      scope: { type: "chapter", chapterId },
      instruction: "只做用量预览"
    }).expect(200);

    await streamTurn("再问一句", { type: "chapter", chapterId }, conversationId);
    expect(capturedTurns[1]?.[0]?.content).toBe(frozenSystem);
  });
});
