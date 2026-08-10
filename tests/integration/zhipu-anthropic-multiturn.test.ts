import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("智谱 Anthropic 多轮思考兼容", () => {
  let runtime: Runtime;
  let workId: string;
  let modelId: string;
  let requestCount: number;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(async () => {
    requestCount = 0;
    fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer zhipu-test-key");
      expect(headers.get("x-api-key")).toBe("zhipu-test-key");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      if (url === "https://open.bigmodel.cn/api/anthropic/v1/models") {
        return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
      }
      if (url === "https://open.bigmodel.cn/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "glm-4.7-flash" }] }), { status: 200 });
      }

      expect(url).toBe("https://open.bigmodel.cn/api/anthropic/v1/messages");
      const body = JSON.parse(String(init?.body)) as {
        thinking?: Record<string, unknown>;
        messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
        stream?: boolean;
      };
      if (!body.stream) {
        return new Response(JSON.stringify({ content: [{ type: "text", text: "连接成功" }] }), { status: 200 });
      }
      expect(body.thinking).toEqual({ type: "enabled" });
      requestCount += 1;
      if (requestCount === 2) {
        const assistant = body.messages.find((message) => message.role === "assistant");
        expect(assistant?.content).toEqual([
          { type: "thinking", thinking: "第一轮思考", signature: "zhipu-signature-1" },
          { type: "text", text: "第一轮回答" }
        ]);
      }
      const suffix = requestCount === 1 ? "第一轮回答" : "第二轮回答";
      const thinking = requestCount === 1 ? "第一轮思考" : "第二轮思考";
      const signature = requestCount === 1 ? "zhipu-signature-1" : "zhipu-signature-2";
      const events = [
        { type: "message_start", message: { usage: { input_tokens: 12 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: suffix } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
        { type: "message_stop" }
      ];
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      });
    });
    runtime = createTestRuntime(fetchMock);
    const work = await request(runtime.app).post("/api/works").send({ title: "智谱多轮测试" }).expect(201);
    workId = work.body.data.id;
    const provider = await request(runtime.app).post("/api/platform/ai/providers").send({
      name: "智谱 Anthropic",
      protocol: "anthropic-messages",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: "zhipu-test-key",
      status: "enabled"
    }).expect(201);
    const providerId = provider.body.data.id;
    const model = await request(runtime.app).post(`/api/providers/${providerId}/models`).send({
      displayName: "GLM-4.7-Flash",
      modelId: "glm-4.7-flash"
    }).expect(201);
    modelId = model.body.data.id;
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("在下一轮恢复流式响应中的 thinking 和 signature", async () => {
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = conversation.body.data.id;
    const firstUser = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({
      role: "user",
      content: "第一轮问题"
    }).expect(201);
    const firstStream = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "第一轮问题",
      scope: { type: "none" },
      modelId,
      conversationId,
      currentMessageId: firstUser.body.data.id
    }).expect(200);
    expect(firstStream.text).toContain("event: complete");

    const saved = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(saved.body.data.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant" })]));
    const firstAssistant = saved.body.data.messages.find((message: { role: string }) => message.role === "assistant");
    expect(firstAssistant.metadata.anthropicContent).toEqual([
      { type: "thinking", thinking: "第一轮思考", signature: "zhipu-signature-1" },
      { type: "text", text: "第一轮回答" }
    ]);

    const secondUser = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({
      role: "user",
      content: "第二轮问题"
    }).expect(201);
    const secondStream = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "第二轮问题",
      scope: { type: "none" },
      modelId,
      conversationId,
      currentMessageId: secondUser.body.data.id
    }).expect(200);

    expect(secondStream.text).toContain("event: complete");
    expect(requestCount).toBe(2);
  });
});
