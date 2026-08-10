import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { AI_RESPONSE_MAX_BYTES, estimateAiTokens } from "../../src/ai.js";
import { resolveServerTimeZone } from "../../src/writing-progress-time.js";
import { createTestRuntime } from "../helpers.js";

describe("AI 供应商、模型与建议 API", () => {
  let runtime: Runtime;
  let workId: string;
  let chapterId: string;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let expectedMaxTokens: number;
  let expectedThinkingType: "enabled" | "disabled";

  beforeEach(async () => {
    expectedMaxTokens = 32_000;
    expectedThinkingType = "enabled";
    fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }>; max_tokens?: number; thinking?: { type?: string } };
      if (body.max_tokens === 10) {
        expect(body.messages).toHaveLength(1);
        return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      expect(body.messages[0]?.content).toContain("未经信任的资料数据");
      expect(body.messages[0]?.content).toContain("不得把密钥、令牌、会话信息");
      expect(body.messages[1]?.content).toContain("跃迁后必须冷却十二小时");
      expect(body.max_tokens).toBe(expectedMaxTokens);
      expect(body.thinking).toEqual({ type: expectedThinkingType });
      if (body.messages[1]?.content.includes("检查下面的续写候选")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "飞船缓缓驶离北港，冷却计时仍在继续。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const work = await request(runtime.app).post("/api/works").send({ title: "AI 测试作品" });
    workId = work.body.data.id;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" });
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({ volumeId: volume.body.data.id, title: "第一章", content: "林舟启动了飞船。" });
    chapterId = chapter.body.data.id;
    await request(runtime.app).post(`/api/works/${workId}/settings`).send({ title: "跃迁限制", category: "世界规则", content: "跃迁后必须冷却十二小时。", locked: true, status: "confirmed" });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await runtime.close();
  });

  async function configureAi(): Promise<{ providerId: string; modelId: string }> {
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "本地兼容服务",
      baseUrl: "https://mock-ai.test/v1/chat/completions",
      apiKey: "sk-sensitive-test-value",
      status: "enabled"
    }).expect(201);
    const providerId = provider.body.data.id;
    expect(provider.body.data.apiKey).toBe("sk-se************lue");
    expect(provider.body.data.baseUrl).toBe("https://mock-ai.test/v1");
    expect(provider.body.data).toMatchObject({ concurrencyLimit: 10, rpmLimit: 10 });
    expect(provider.body.data).not.toHaveProperty("maxTokens");
    const databaseRow = runtime.database.get<Record<string, unknown>>("SELECT encrypted_key FROM providers WHERE id = ?", providerId);
    expect(databaseRow?.encrypted_key).not.toContain("sk-sensitive-test-value");

    const model = await request(runtime.app).post(`/api/providers/${providerId}/models`).send({
      displayName: "小说模型",
      modelId: "mock-novel-model",
      preset: { temperature: 0.4, unsupported: "ignored" }
    }).expect(201);
    expect(model.body.data.preset).toMatchObject({ temperature: 0.4, max_tokens: 32_000, unsupported: "ignored" });
    expect(model.body.data.thinkingEnabled).toBe(true);
    return { providerId, modelId: model.body.data.id };
  }

  function setLegacyModelContextWindow(modelId: string, contextWindow: number): void {
    runtime.database.run("UPDATE models SET context_window = ? WHERE id = ?", contextWindow, modelId);
  }

  it("只有连接测试成功的启用供应商才能设置默认模型", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).put(`/api/works/${workId}/task-defaults/continue`).send({ modelId }).expect(409);

    const tested = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expect(tested.body.data).toMatchObject({ ok: true, availableModels: ["mock-novel-model"] });
    const limited = await request(runtime.app).patch(`/api/providers/${providerId}`).send({ concurrencyLimit: 3, rpmLimit: 120 }).expect(200);
    expect(limited.body.data).toMatchObject({ concurrencyLimit: 3, rpmLimit: 120 });
    await request(runtime.app).put(`/api/works/${workId}/task-defaults/continue`).send({ modelId }).expect(200);

    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ status: "disabled" }).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "continue",
      instruction: "续写一段",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(409);
  });

  it("达到本书每日 Token 额度后拒绝新的 AI 调用", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      dailyTokenQuota: 10_000,
      agentTools: []
    }).expect(200);
    const createdAt = new Date().toISOString();
    runtime.database.run(
      `INSERT INTO ai_calls (
         id, work_id, task_type, provider_id, model_id, context_scope_json, status,
         input_tokens, output_tokens, token_usage_source, created_at, completed_at
       ) VALUES ('quota-used', ?, 'chat', ?, ?, '{}', 'completed', 9000, 1000, 'reported', ?, ?)`,
      workId,
      providerId,
      modelId,
      createdAt,
      createdAt
    );

    const rejected = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "继续分析",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(429);
    expect(rejected.body.error).toMatchObject({
      code: "DAILY_TOKEN_QUOTA_EXCEEDED",
      details: {
        dailyTokenQuota: 10_000,
        usedTokens: 10_000,
        remainingTokens: 0,
        timezone: resolveServerTimeZone()
      }
    });
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM ai_calls WHERE work_id = ?", workId)).toEqual({ count: 1 });
  });

  it("聊天模型和历史列表通过独立接口返回", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    for (let index = 1; index <= 21; index += 1) {
      await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({ title: `初始化会话 ${index}` }).expect(201);
    }

    const models = await request(runtime.app).get(`/api/works/${workId}/models`).expect(200);
    const firstPage = await request(runtime.app).get(`/api/works/${workId}/ai-conversations`).expect(200);
    const secondPage = await request(runtime.app).get(`/api/works/${workId}/ai-conversations?page=2`).expect(200);

    expect(models.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: modelId })]));
    expect(firstPage.body.data).toMatchObject({ page: 1, limit: 20, hasMore: true, nextPage: 2 });
    expect(firstPage.body.data.items).toHaveLength(20);
    expect(secondPage.body.data).toMatchObject({ page: 2, limit: 20, hasMore: false, nextPage: null });
    expect(secondPage.body.data.items).toHaveLength(1);
  });

  it("拒绝新增或改为低于 32K 上下文的模型", async () => {
    const { providerId, modelId } = await configureAi();
    const invalidCreate = await request(runtime.app).post(`/api/providers/${providerId}/models`).send({
      displayName: "过小上下文模型",
      modelId: "short-context-model",
      contextWindow: 32_767
    }).expect(400);
    expect(invalidCreate.body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      details: [{ path: "contextWindow", message: "模型上下文不能低于 32768 Token" }]
    });

    const invalidUpdate = await request(runtime.app).patch(`/api/models/${modelId}`).send({ contextWindow: 32_767 }).expect(400);
    expect(invalidUpdate.body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      details: [{ path: "contextWindow", message: "模型上下文不能低于 32768 Token" }]
    });

    const minimum = await request(runtime.app).patch(`/api/models/${modelId}`).send({ contextWindow: 32_768 }).expect(200);
    expect(minimum.body.data.contextWindow).toBe(32_768);
  });

  it("连接测试必须用 max_tokens=10 收到正文或 thinking", async () => {
    const { providerId } = await configureAi();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
      expect(body.max_tokens).toBe(10);
      return new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const tested = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expect(tested.body.data).toMatchObject({ ok: false, provider: { connectionStatus: "failed" } });
    expect(tested.body.data.error).toContain("响应缺少可用回复");
  });

  it("连接测试在只有 thinking 时也视为成功", async () => {
    const { providerId } = await configureAi();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
      expect(body.max_tokens).toBe(10);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "", reasoning_content: "正在确认连接。" } }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const tested = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expect(tested.body.data).toMatchObject({
      ok: true,
      availableModels: ["mock-novel-model"],
      provider: { connectionStatus: "success" }
    });
  });

  it("连接测试拒绝成功状态下的超大模型列表响应", async () => {
    const { providerId } = await configureAi();
    fetchMock.mockImplementation(async () => new Response("{}", {
      status: 200,
      headers: { "Content-Length": String(AI_RESPONSE_MAX_BYTES + 1) }
    }));

    const tested = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expect(tested.body.data).toMatchObject({
      ok: false,
      provider: { connectionStatus: "failed" }
    });
    expect(tested.body.data.error).toContain("AI 供应商响应超过");
  });

  it("可以单独测试指定模型并使用该模型标识符", async () => {
    const { providerId, modelId } = await configureAi();
    fetchMock.mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model?: string; max_tokens?: number };
      expect(body).toMatchObject({ model: "mock-novel-model", max_tokens: 10 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "模型连接成功" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const tested = await request(runtime.app).post(`/api/models/${modelId}/test`).send({}).expect(200);
    expect(tested.body.data).toMatchObject({
      ok: true,
      model: { id: modelId, modelId: "mock-novel-model" },
      provider: { id: providerId, connectionStatus: "success" }
    });
  });

  it("多模态模型单独测试会发送图片内容块", async () => {
    const { modelId } = await configureAi();
    await request(runtime.app).patch(`/api/models/${modelId}`).send({ multimodalEnabled: true }).expect(200);
    fetchMock.mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: unknown }>; max_tokens?: number };
      expect(body.max_tokens).toBe(10);
      const content = body.messages?.[0]?.content;
      expect(Array.isArray(content)).toBe(true);
      expect(content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text" }),
        expect.objectContaining({ type: "image_url", image_url: expect.objectContaining({ detail: "low" }) })
      ]));
      const imageBlock = (content as Array<Record<string, unknown>>).find((block) => block.type === "image_url");
      const imageUrl = String((imageBlock?.image_url as Record<string, unknown>)?.url);
      expect(imageUrl).toMatch(/^data:image\/png;base64,/u);
      const imageBytes = Buffer.from(imageUrl.slice("data:image/png;base64,".length), "base64");
      expect(imageBytes.subarray(16, 20).readUInt32BE(0)).toBe(128);
      expect(imageBytes.subarray(20, 24).readUInt32BE(0)).toBe(128);
      return new Response(JSON.stringify({ choices: [{ message: { content: "图片连接成功" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const tested = await request(runtime.app).post(`/api/models/${modelId}/test`).send({}).expect(200);
    expect(tested.body.data).toMatchObject({ ok: true, multimodalTested: true });
  });

  it("非 Chat Completions 供应商不能启用多模态模型", async () => {
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "Anthropic 测试供应商",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-anthropic-test",
      status: "enabled"
    }).expect(201);
    const rejected = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "不支持的多模态模型",
      modelId: "claude-test",
      multimodalEnabled: true
    }).expect(400);
    expect(rejected.body.error.code).toBe("MODEL_MULTIMODAL_PROTOCOL_UNSUPPORTED");
  });

  it("模型默认开启 thinking 并可按模型关闭", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "验证默认思考参数",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);

    expectedThinkingType = "disabled";
    const updated = await request(runtime.app).patch(`/api/models/${modelId}`).send({ thinkingEnabled: false }).expect(200);
    expect(updated.body.data.thinkingEnabled).toBe(false);
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "验证关闭思考参数",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);
  });

  it("Kimi 模型默认温度为 1 并保留用户手动设置", async () => {
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "Kimi 测试供应商",
      baseUrl: "https://api.kimi.com/coding/v1",
      apiKey: "sk-kimi-test-value",
      status: "enabled"
    }).expect(201);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "Kimi Coding",
      modelId: "kimi-for-coding"
    }).expect(201);
    expect(model.body.data.preset.temperature).toBe(1);

    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "使用 Kimi 默认温度",
      scope: { type: "chapter", chapterId },
      modelId: model.body.data.id
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "使用 Kimi 自定义温度",
      scope: { type: "chapter", chapterId },
      modelId: model.body.data.id,
      parameters: { temperature: 0.2 }
    }).expect(201);

    const calls = await request(runtime.app).get(`/api/works/${workId}/ai-calls`).expect(200);
    const temperatures: number[] = calls.body.data
      .filter((call: { model: { id: string }; taskType: string }) => call.model.id === model.body.data.id && call.taskType === "chat")
      .map((call: { parameters: { temperature?: number } }) => Number(call.parameters.temperature));
    expect(temperatures.sort((left, right) => left - right)).toEqual([0.2, 1]);
  });

  it("Gemini endpoint 或模型名命中时不发送 thinking 字段", async () => {
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { model?: string; stream?: boolean; thinking?: unknown };
      expect(body).not.toHaveProperty("thinking");
      if (body.stream) {
        return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"Gemini\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "Gemini" } }] }), { status: 200 });
    });

    const endpointProvider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "Gemini endpoint 测试",
      baseUrl: "https://gemini-compatible.test/v1",
      apiKey: "sk-gemini-endpoint-test",
      status: "enabled"
    }).expect(201);
    const endpointModel = await request(runtime.app).post(`/api/providers/${endpointProvider.body.data.id}/models`).send({
      displayName: "兼容模型",
      modelId: "mock-model"
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${endpointProvider.body.data.id}/test`).send({}).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "测试 Gemini endpoint 参数",
      scope: { type: "chapter", chapterId },
      modelId: endpointModel.body.data.id
    }).expect(200).expect("Content-Type", /text\/event-stream/u);

    const modelProvider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "Gemini model 测试",
      baseUrl: "https://generic-ai.test/v1",
      apiKey: "sk-gemini-model-test",
      status: "enabled"
    }).expect(201);
    const model = await request(runtime.app).post(`/api/providers/${modelProvider.body.data.id}/models`).send({
      displayName: "Gemini 模型",
      modelId: "gemini-2.5-flash"
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${modelProvider.body.data.id}/test`).send({}).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "测试 Gemini model 参数",
      scope: { type: "chapter", chapterId },
      modelId: model.body.data.id
    }).expect(201);
  });

  it("平台供应商可被多本书复用，并在内置提示词后追加平台和书籍提示词", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    const secondWork = await request(runtime.app).post("/api/works").send({ title: "第二本 AI 作品" }).expect(201);
    const secondVolume = await request(runtime.app).post(`/api/works/${secondWork.body.data.id}/volumes`).send({ title: "第二卷" }).expect(201);
    const secondChapter = await request(runtime.app).post(`/api/works/${secondWork.body.data.id}/chapters`).send({
      volumeId: secondVolume.body.data.id,
      title: "第二章",
      content: "第二本书的正文。"
    }).expect(201);

    const platformProviders = await request(runtime.app).get("/api/platform/ai/providers").expect(200);
    expect(platformProviders.body.data.map((item: { id: string }) => item.id)).toContain(providerId);
    const sharedModels = await request(runtime.app).get(`/api/works/${secondWork.body.data.id}/models`).expect(200);
    expect(sharedModels.body.data.map((item: { id: string }) => item.id)).toContain(modelId);

    await request(runtime.app).patch("/api/platform/ai/settings").send({ systemPrompt: "平台追加：保持克制叙事。" }).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ systemPrompt: "本书追加：哥斯拉不得离开地球。" }).expect(200);
    const updatedModel = await request(runtime.app).patch(`/api/models/${modelId}`).send({ contextWindow: 32_768 }).expect(200);
    expect(updatedModel.body.data.contextWindow).toBe(32_768);

    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      expect(body.messages[0]?.content).toContain("作者锁定的事实是不可违反的硬约束");
      expect(body.messages[0]?.content).toContain("平台追加：保持克制叙事。");
      expect(body.messages[0]?.content).toContain("本书追加：哥斯拉不得离开地球。");
      return new Response(JSON.stringify({ choices: [{ message: { content: "提示词已生效。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const measured = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "检查提示词",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);
    expect(measured.body.data.contextUsage).toMatchObject({ modelId, contextWindow: 32_768 });
    expect(measured.body.data.contextUsage.inputTokens).toBeGreaterThan(0);
    await request(runtime.app).put(`/api/works/${secondWork.body.data.id}/task-defaults/chat`).send({ modelId }).expect(200);
    expect(secondChapter.body.data.title).toBe("第二章");
  });

  it("功能模型列表排除禁用模型但保留历史任务中的模型", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "book-analysis",
      scope: { type: "book" },
      modelId
    }).expect(201);

    const availableBeforeDisable = await request(runtime.app).get(`/api/works/${workId}/models`).expect(200);
    expect(availableBeforeDisable.body.data.map((model: { id: string }) => model.id)).toContain(modelId);

    await request(runtime.app).patch(`/api/models/${modelId}`).send({ enabled: false }).expect(200);

    const availableAfterDisable = await request(runtime.app).get(`/api/works/${workId}/models`).expect(200);
    expect(availableAfterDisable.body.data.map((model: { id: string }) => model.id)).not.toContain(modelId);
    const tasks = await request(runtime.app).get(`/api/works/${workId}/tasks`).expect(200);
    expect(tasks.body.data.items.find((item: { id: string }) => item.id === task.body.data.id)?.model)
      .toMatchObject({ id: modelId, modelId: "mock-novel-model" });
  });

  it("按模型上下文比例裁剪全书概要引用", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    setLegacyModelContextWindow(modelId, 1_024);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ bookSummaryContextPercent: 25 }).expect(200);
    runtime.store.db.run(
      `INSERT INTO chapter_insights (id, chapter_id, chapter_version, summary, events_json, characters_json,
       settings_json, evidence_json, uncertainties_json, status, created_at) VALUES (?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', 'review', ?)`,
      "insight-book-summary-budget",
      chapterId,
      1,
      `${"较早概要。".repeat(120)}保留最新概要。`,
      "2026-07-15T00:00:00.000Z"
    );
    let sentContext = "";
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      sentContext = body.messages[1]?.content ?? "";
      return new Response(JSON.stringify({ choices: [{ message: { content: "已根据概要回答。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "根据全书概要回答。",
      scope: { type: "entities", includeBookSummary: true },
      modelId
    }).expect(201);

    expect(sentContext).toContain("本卷其余章节概要已按预算折叠");
    expect(sentContext).toContain("较早概要");
    expect(sentContext).toContain("保留最新概要");
    expect(estimateAiTokens(sentContext)).toBeLessThan(450);
  });

  it("无上下文请求只携带用户主动添加的正文引用", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let sentPrompt = "";
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      sentPrompt = body.messages[1]?.content ?? "";
      return new Response(JSON.stringify({ choices: [{ message: { content: "仅根据主动引用回答。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "只检查我添加的引用。",
      scope: { type: "none" },
      modelId,
      citations: [{ chapterId, chapterTitle: "第一章", startLine: 1, endLine: 1, text: "用户主动引用的句子。" }]
    }).expect(201);

    expect(sentPrompt).toContain("[第一章 L1]");
    expect(sentPrompt).toContain("用户主动引用的句子。");
    expect(sentPrompt).not.toContain("林舟启动了飞船。");
    expect(sentPrompt).not.toContain("跃迁后必须冷却十二小时");
  });

  it("作品全局开关自动注入设定且与主动注入合并为一次", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      alwaysIncludeSettingInfo: true,
      agentTools: []
    }).expect(200);
    const sentContexts: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      sentContexts.push(body.messages[1]?.content ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "设定上下文已生效。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    for (const includeSettingInfo of [false, true]) {
      await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
        taskType: "chat",
        instruction: "检查设定上下文。",
        scope: { type: "none", includeSettingInfo },
        modelId
      }).expect(201);
    }

    expect(sentContexts).toHaveLength(2);
    for (const context of sentContexts) {
      expect(context).toContain("跃迁后必须冷却十二小时");
      expect(context.match(/<locked_settings>/gu)).toHaveLength(1);
    }
  });

  it("无上下文请求将 @ 章节的当前保存正文作为显式上下文发送", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let sentPrompt = "";
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      sentPrompt = body.messages[1]?.content ?? "";
      return new Response(JSON.stringify({ choices: [{ message: { content: "已读取主动引用章节。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "概括我 @ 的章节。",
      scope: { type: "none", chapterIds: [chapterId] },
      modelId
    }).expect(201);

    expect(sentPrompt).toContain("作者主动引用的章节");
    expect(sentPrompt).toContain("第一章");
    expect(sentPrompt).toContain("林舟启动了飞船。");
    expect(sentPrompt).not.toContain("跃迁后必须冷却十二小时");
  });

  it("无上下文作品问题会收到主动工具指引并通过目录读取作品信息", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }>; tools?: Array<{ function?: { name?: string } }> };
      if (completionCount === 1) {
        expect(body.messages[0]?.content).toContain("预加载上下文为空或不足时，必须先调用工具主动查询");
        expect(body.messages[0]?.content).toContain("整体介绍、作品基本信息、目录或章节定位优先调用 story_index");
        expect(body.messages[1]?.content).toContain("本轮未预加载作品上下文");
        expect(body.tools?.map((tool) => tool.function?.name)).toContain("story_index");
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "project-index", type: "function", function: { name: "story_index", arguments: "{}" } }] } }] }), { status: 200 });
      }
      const toolMessage = body.messages.find((message) => message.role === "tool");
      expect(toolMessage?.content).toContain('"title":"AI 测试作品"');
      expect(toolMessage?.content).toContain('"chapterCount":1');
      return new Response(JSON.stringify({ choices: [{ message: { content: "这是《AI 测试作品》，当前包含一章。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "这是一个什么项目？",
      scope: { type: "none" },
      modelId
    }).expect(201);

    expect(response.body.data.content).toBe("这是《AI 测试作品》，当前包含一章。");
    expect(response.body.data.toolCalls).toEqual([expect.objectContaining({ name: "story_index", status: "completed" })]);
    expect(completionCount).toBe(2);
  });

  it("已开始的对话锁定工具集，中途改作品设置不影响该对话", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentTools: ["story_index", "read_chapters", "grep", "search_story_entities", "read_character_sections", "search_drafts"]
    }).expect(200);

    const created = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({ title: "锁定工具对话" }).expect(201);
    const conversationId = created.body.data.id as string;
    expect(created.body.data.agentTools).toEqual([
      "story_index",
      "read_chapters",
      "grep",
      "search_story_entities",
      "read_character_sections",
      "search_drafts"
    ]);

    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentTools: ["story_index"]
    }).expect(200);

    let lockedTools: string[] | undefined;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as {
        tools?: Array<{ function?: { name?: string } }>;
        messages?: Array<{ role?: string; content?: string }>;
      };
      lockedTools = body.tools?.map((tool) => tool.function?.name).filter((name): name is string => Boolean(name));
      expect(body.messages?.[0]?.content).toContain("当前可用作品查询工具：story_index、read_chapters、grep、search_story_entities、read_character_sections、search_drafts");
      return new Response(JSON.stringify({
        choices: [{ message: { content: "仍可使用创建时锁定的工具集。" } }]
      }), { status: 200 });
    });

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "确认本对话工具是否仍完整。",
      scope: { type: "none" },
      modelId,
      conversationId
    }).expect(200);

    expect(streamed.text).toContain("仍可使用创建时锁定的工具集。");
    expect(lockedTools).toEqual([
      "story_index",
      "read_chapters",
      "grep",
      "search_story_entities",
      "read_character_sections",
      "search_drafts"
    ]);

    const summary = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(summary.body.data.agentTools).toEqual(lockedTools);

    let newConversationTools: string[] | undefined;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { tools?: Array<{ function?: { name?: string } }> };
      newConversationTools = body.tools?.map((tool) => tool.function?.name).filter((name): name is string => Boolean(name));
      return new Response(JSON.stringify({
        choices: [{ message: { content: "新对话只看到 story_index。" } }]
      }), { status: 200 });
    });

    const fresh = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "新对话应使用最新设置。",
      scope: { type: "none" },
      modelId
    }).expect(200);
    expect(fresh.text).toContain("新对话只看到 story_index。");
    expect(newConversationTools).toEqual(["story_index"]);
  });

  it("聊天默认暴露聚合查询工具并把结果回传给模型", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { tools?: Array<{ function?: { name?: string } }>; messages: Array<{ role: string; content?: string }> };
      expect(body.tools?.map((tool) => tool.function?.name)).toEqual(["story_index", "read_chapters", "grep", "search_story_entities", "read_character_sections", "search_drafts", "image"]);
      if (completionCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "tool-call-1", type: "function", function: { name: "story_index", arguments: "{\"limit\":1}" } }] } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const toolMessage = body.messages.find((message) => message.role === "tool");
      expect(toolMessage?.content).toContain("第一章");
      return new Response(JSON.stringify({ choices: [{ message: { content: "已根据章节目录回答。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "先查看章节目录再回答。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);

    expect(response.body.data.content).toBe("已根据章节目录回答。");
    expect(response.body.data.toolCalls).toEqual([
      expect.objectContaining({ id: "tool-call-1", name: "story_index", calledAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u), status: "completed", arguments: { offset: 0, limit: 1 } })
    ]);
    expect(completionCount).toBe(2);
  });

  it("Agent 搜索草稿时明确返回未确认语义且不把草稿当作正式事实", async () => {
    await request(runtime.app).post(`/api/works/${workId}/drafts`).send({
      draftType: "setting",
      title: "跃迁失忆备选",
      content: "也许每次跃迁都会失去一段记忆，但这个方向可能永远不会采用。"
    }).expect(201);
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        tools?: Array<{ function?: { name?: string; description?: string } }>;
        messages: Array<{ role: string; content?: string }>;
      };
      const draftTool = body.tools?.find((tool) => tool.function?.name === "search_drafts");
      expect(draftTool?.function?.description).toContain("可能永远不会写入正文或正式设定");
      expect(body.messages[0]?.content).toContain("不得把它当作故事事实");
      if (completionCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "draft-search",
          type: "function",
          function: { name: "search_drafts", arguments: { query: "跃迁", draftType: "setting", limit: 5 } }
        }] } }] }), { status: 200 });
      }
      const toolMessage = body.messages.find((message) => message.role === "tool");
      expect(toolMessage?.content).toContain("这些内容是作者记录的未确认临时想法");
      expect(toolMessage?.content).toContain("跃迁失忆备选");
      expect(toolMessage?.content).toContain("这个方向可能永远不会采用");
      return new Response(JSON.stringify({ choices: [{ message: { content: "草稿里有一个未确认的跃迁失忆方向，不能视为正式设定。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "草稿里有没有跃迁相关的备选想法？",
      scope: { type: "none" },
      modelId
    }).expect(201);

    expect(response.body.data.content).toContain("未确认");
    expect(response.body.data.toolCalls).toEqual([
      expect.objectContaining({ name: "search_drafts", status: "completed", arguments: { query: "跃迁", draftType: "setting", limit: 5 } })
    ]);
    expect(completionCount).toBe(2);
  });

  it("种族知识查询向模型返回层级与继承设定", async () => {
    const titan = await request(runtime.app).post(`/api/works/${workId}/races`).send({ name: "泰坦", isExtinct: true, settings: ["体型巨大"] }).expect(201);
    const original = await request(runtime.app).post(`/api/works/${workId}/races`).send({
      name: "原生泰坦",
      parentRaceId: titan.body.data.id,
      settings: ["源自远古"]
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "哥斯拉", isDead: true, raceId: original.body.data.id }).expect(201);
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }>; tools?: Array<{ function?: { name?: string; description?: string } }> };
      if (completionCount === 1) {
        const searchTool = body.tools?.find((tool) => tool.function?.name === "search_story_entities");
        expect(searchTool?.function?.description).toContain("只有值为 true 才能判定");
        expect(searchTool?.function?.description).toContain("字段为 false 时必须视为仍存活、未灭绝或未解散");
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "race-knowledge",
          type: "function",
          function: { name: "search_story_entities", arguments: { query: "泰坦", categories: ["race", "character"] } }
        }] } }] }), { status: 200 });
      }
      const toolMessage = body.messages.find((message) => message.role === "tool");
      expect(toolMessage?.content).toContain('"racePath":"泰坦 / 原生泰坦"');
      expect(toolMessage?.content).toContain('"isDead":true');
      expect(toolMessage?.content).toContain('"isExtinct":true');
      expect(toolMessage?.content).toContain('"lineage":[{"id":"' + titan.body.data.id + '","name":"泰坦"}');
      expect(toolMessage?.content).toContain('"value":"体型巨大"');
      return new Response(JSON.stringify({ choices: [{ message: { content: "已读取种族层级。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "查询泰坦种族层级。",
      scope: { type: "none" },
      modelId
    }).expect(201);

    expect(response.body.data.content).toBe("已读取种族层级。");
    expect(response.body.data.toolCalls).toEqual([expect.objectContaining({ name: "search_story_entities", status: "completed" })]);
  });

  it("覆盖所有查询工具的可选参数组合并把结构化结果交回模型", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    const character = runtime.store.createCharacter(workId, { name: "哥斯拉" });
    const section = runtime.store.createCharacterProfileSection(String(character.id), {
      sectionType: "background",
      title: "背景故事",
      summary: "哥斯拉在远古时期守护地球生态。",
      contentMarkdown: "## 远古时期\n\n哥斯拉守护地球生态。"
    });
    const calls = [
      { id: "index-default", name: "story_index", arguments: {} },
      { id: "index-page", name: "story_index", arguments: { offset: 0, limit: 1 } },
      { id: "chapter-summary", name: "read_chapters", arguments: { chapterIds: [chapterId], include: "summary" } },
      { id: "chapter-content", name: "read_chapters", arguments: { chapterIds: [chapterId], include: "content" } },
      { id: "chapter-both", name: "read_chapters", arguments: { chapterIds: [chapterId], include: "both" } },
      { id: "grep-default", name: "grep", arguments: { keyword: "林舟" } },
      { id: "grep-limit", name: "grep", arguments: { keyword: "林舟", limit: 1 } },
      { id: "knowledge-default", name: "search_story_entities", arguments: { query: "跃迁" } },
      { id: "knowledge-categories", name: "search_story_entities", arguments: { query: "跃迁", categories: ["setting", "character", "race", "organization", "timeline", "relationship", "outline", "foreshadow"] } },
      { id: "character-section-summary", name: "read_character_sections", arguments: { sectionIds: [section.id], include: "summary" } },
      { id: "character-section-content", name: "read_character_sections", arguments: { sectionIds: [section.id], include: "content" } },
      { id: "character-section-both", name: "read_character_sections", arguments: { sectionIds: [section.id], include: "both" } }
    ];
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; tool_call_id?: string; content?: string }> };
      if (completionCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } }] }), { status: 200 });
      }
      const results = new Map(body.messages.filter((message) => message.role === "tool").map((message) => [message.tool_call_id, JSON.parse(message.content ?? "{}") as Record<string, unknown>]));
      expect(results.size).toBe(calls.length);
      expect(results.get("index-default")).toMatchObject({ ok: true, data: { offset: 0, totalChapters: 1 } });
      expect(results.get("index-page")).toMatchObject({ ok: true, data: { chapters: [{ title: "第一章" }] } });
      expect(results.get("chapter-summary")).toMatchObject({ ok: true, data: { chapters: [{ chapterId, summary: "" }] } });
      expect(results.get("chapter-summary")).not.toHaveProperty("data.chapters.0.content");
      expect(results.get("chapter-content")).toMatchObject({ ok: true, data: { chapters: [{ chapterId, content: "林舟启动了飞船。" }] } });
      expect(results.get("chapter-content")).not.toHaveProperty("data.chapters.0.summary");
      expect(results.get("chapter-both")).toMatchObject({ ok: true, data: { chapters: [{ chapterId, summary: "", content: "林舟启动了飞船。" }] } });
      expect(results.get("grep-default")).toMatchObject({ ok: true, data: { keyword: "林舟", limit: 20, matches: [{ chapterId, chapterTitle: "第一章", paragraph: "林舟启动了飞船。" }] } });
      expect(results.get("grep-limit")).toMatchObject({ ok: true, data: { limit: 1, matches: [{ chapterId }] } });
      expect(results.get("knowledge-default")).toMatchObject({ ok: true, data: { query: "跃迁", matchMode: "hybrid_exact_phonetic" } });
      expect(results.get("knowledge-categories")).toMatchObject({ ok: true, data: { matchMode: "hybrid_exact_phonetic", matches: expect.any(Array) } });
      expect(results.get("character-section-summary")).toMatchObject({ ok: true, data: { sections: [{ sectionId: section.id, characterName: "哥斯拉", summary: "哥斯拉在远古时期守护地球生态。" }] } });
      expect(results.get("character-section-summary")).not.toHaveProperty("data.sections.0.contentMarkdown");
      expect(results.get("character-section-content")).toMatchObject({ ok: true, data: { sections: [{ sectionId: section.id, contentMarkdown: "## 远古时期\n\n哥斯拉守护地球生态。" }] } });
      expect(results.get("character-section-content")).not.toHaveProperty("data.sections.0.summary");
      expect(results.get("character-section-both")).toMatchObject({ ok: true, data: { sections: [{ sectionId: section.id, summary: "哥斯拉在远古时期守护地球生态。", contentMarkdown: "## 远古时期\n\n哥斯拉守护地球生态。" }] } });
      return new Response(JSON.stringify({ choices: [{ message: { content: "工具参数组合均已处理。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "依次验证所有查询工具。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);

    expect(response.body.data.content).toBe("工具参数组合均已处理。");
    expect(response.body.data.toolCalls).toHaveLength(calls.length);
    expect(response.body.data.toolCalls.every((call: { status: string }) => call.status === "completed")).toBe(true);
  });

  it("长工具结果按完整结构限制在一万字符内并通过游标续读", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    setLegacyModelContextWindow(modelId, 30_000);
    const content = "长正文。".repeat(3_000);
    runtime.store.saveChapter(chapterId, { content });
    const fragments: string[] = [];
    const maxTokens: number[] = [];
    let compactRequestCount = 0;
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { max_tokens: number; messages: Array<{ role: string; tool_call_id?: string; content?: string }> };
      if (body.messages[0]?.content?.includes("压缩已完成的 AI 工具调用上下文")) {
        compactRequestCount += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: "已压缩先前分页正文，仍需继续读取剩余游标。" } }] }), { status: 200 });
      }
      maxTokens.push(body.max_tokens);
      if (completionCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "long-chapter-first",
          type: "function",
          function: { name: "read_chapters", arguments: { chapterIds: [chapterId], include: "content" } }
        }] } }] }), { status: 200 });
      }
      const latest = body.messages.filter((message) => message.role === "tool").at(-1);
      const result = JSON.parse(latest?.content ?? "{}") as {
        data: { chapters: Array<{ content?: string; _fragment?: { index: number; total: number; path: string | null } }> };
        pagination: { cursor: number; nextCursor: number | null; maxChars: number };
      };
      expect((latest?.content ?? "").length).toBeLessThanOrEqual(10_000);
      expect(result.pagination.maxChars).toBe(10_000);
      expect(result.data.chapters.every((chapter) => chapter._fragment)).toBe(true);
      fragments.push(...result.data.chapters.map((chapter) => chapter.content ?? ""));
      if (result.pagination.nextCursor !== null) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: `long-chapter-${result.pagination.nextCursor}`,
          type: "function",
          function: {
            name: "read_chapters",
            arguments: { chapterIds: [chapterId], include: "content", cursor: result.pagination.nextCursor }
          }
        }] } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "已读取全部分页正文。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "分页读取当前章节。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);

    expect(response.body.data.content).toBe("已读取全部分页正文。");
    expect(response.body.data.toolCalls.length).toBeGreaterThan(1);
    expect(response.body.data.toolCalls[1].arguments).toMatchObject({ cursor: expect.any(Number) });
    expect(fragments.join("")).toBe(content);
    expect(maxTokens.every((value) => value > 0)).toBe(true);
    expect(compactRequestCount).toBeGreaterThan(0);
  });

  it("工具结果接近模型上限时先压缩旧工具上下文再拼入新结果", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    setLegacyModelContextWindow(modelId, 16_000);
    runtime.store.saveChapter(chapterId, { content: "分页上下文证据。".repeat(2_500) });
    let completionCount = 0;
    let firstPageContent = "";
    let compactedFirstPage = false;
    let finalMessages: Array<{ role: string; content?: string }> = [];
    const requestInputTokens: number[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content?: string }>;
        tools?: unknown[];
      };
      requestInputTokens.push(estimateAiTokens(JSON.stringify(body.messages)));
      if (body.messages[0]?.content?.includes("压缩已完成的 AI 工具调用上下文")) {
        expect(body.tools).toBeUndefined();
        const prefix = "待压缩的工具调用上下文：\n";
        const compactionInput = body.messages[1]?.content ?? "";
        const compactedMessages = JSON.parse(compactionInput.slice(prefix.length)) as Array<{ role: string; content?: string }>;
        compactedFirstPage = compactedMessages.some((message) => message.role === "tool" && message.content === firstPageContent);
        return new Response(JSON.stringify({ choices: [{ message: { content: "已确认前一页包含章节正文证据，后续仍需按游标读取。" } }] }), { status: 200 });
      }
      const toolMessages = body.messages.filter((message) => message.role === "tool");
      if (toolMessages.length === 0) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "context-page-1",
          type: "function",
          function: { name: "read_chapters", arguments: { chapterIds: [chapterId], include: "content" } }
        }] } }] }), { status: 200 });
      }
      const joined = body.messages.map((message) => message.content ?? "").join("\n");
      if (!joined.includes("已压缩的工具调用上下文")) {
        firstPageContent = toolMessages[0]?.content ?? "";
        const firstPage = JSON.parse(firstPageContent) as { pagination: { nextCursor: number | null } };
        expect(firstPage.pagination.nextCursor).toEqual(expect.any(Number));
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "context-page-2",
          type: "function",
          function: {
            name: "read_chapters",
            arguments: { chapterIds: [chapterId], include: "content", cursor: firstPage.pagination.nextCursor }
          }
        }] } }] }), { status: 200 });
      }
      finalMessages = body.messages;
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]?.content).not.toBe(firstPageContent);
      return new Response(JSON.stringify({ choices: [{ message: { content: "已结合压缩摘要和最新分页结果回答。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "读取章节后回答。",
      scope: { type: "none" },
      modelId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);

    expect(response.text).toContain('event: delta\ndata: {"delta":"已结合压缩摘要和最新分页结果回答。"}');
    expect(response.text).toContain("event: context_compacted");
    expect(response.text).toContain('event: process_step\ndata: {"id":"process_');
    expect(response.text).toContain('"type":"context_compaction"');
    const compactPayload = JSON.parse(response.text.match(/event: context_compacted\ndata: ([^\n]+)/u)?.[1] ?? "{}") as {
      contextUsage?: { inputTokens?: number; contextWindow?: number; usagePercent?: number };
    };
    expect(compactPayload.contextUsage?.inputTokens).toBeGreaterThan(0);
    expect(compactPayload.contextUsage?.inputTokens).toBeLessThan(compactPayload.contextUsage?.contextWindow ?? 0);
    expect(compactPayload.contextUsage?.usagePercent).toEqual(expect.any(Number));
    const completePayload = JSON.parse(response.text.match(/event: complete\ndata: ([^\n]+)/u)?.[1] ?? "{}") as {
      contextUsage?: { inputTokens?: number; contextWindow?: number };
      toolCalls?: unknown[];
    };
    expect(completePayload.contextUsage?.inputTokens).toBeLessThan(completePayload.contextUsage?.contextWindow ?? 0);
    expect(completePayload.toolCalls?.length).toBe(2);
    expect(completionCount).toBe(4);
    expect(compactedFirstPage).toBe(true);
    const finalContext = finalMessages.map((message) => message.content ?? "").join("\n");
    expect(finalContext).toContain("已压缩的工具调用上下文");
    expect(finalContext).toContain("已确认前一页包含章节正文证据");
    expect(finalContext).not.toContain(firstPageContent);
    const firstUserMessageIndex = finalMessages.findIndex((message) => message.role === "user");
    expect(firstUserMessageIndex).toBeGreaterThan(0);
    expect(finalMessages.slice(0, firstUserMessageIndex).every((message) => message.role === "system")).toBe(true);
    expect(finalMessages[firstUserMessageIndex]?.content).toContain("已压缩的工具调用上下文");
    expect(finalMessages.filter((message) => message.role === "system").every((message) => !message.content?.includes("已压缩的工具调用上下文"))).toBe(true);
    expect(requestInputTokens.every((tokens) => tokens < 16_000)).toBe(true);
  });

  it("模型上下文较小时按剩余预算缩小工具结果分页", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    setLegacyModelContextWindow(modelId, 6_000);
    runtime.store.saveChapter(chapterId, { content: "小窗口分页正文。".repeat(2_000) });
    let completionCount = 0;
    const returnedPages: Array<{ pagination: { maxChars: number; nextCursor: number | null } }> = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> };
      const toolMessage = body.messages.find((message) => message.role === "tool");
      if (!toolMessage) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "small-context-page",
          type: "function",
          function: { name: "read_chapters", arguments: { chapterIds: [chapterId], include: "content" } }
        }] } }] }), { status: 200 });
      }
      returnedPages.push(JSON.parse(toolMessage.content ?? "{}") as { pagination: { maxChars: number; nextCursor: number | null } });
      expect(estimateAiTokens(JSON.stringify(body.messages))).toBeLessThan(6_000);
      return new Response(JSON.stringify({ choices: [{ message: { content: "已读取适配小窗口的结构化分页。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "读取章节后回答。",
      scope: { type: "none" },
      modelId
    }).expect(201);

    expect(response.body.data.content).toBe("已读取适配小窗口的结构化分页。");
    expect(completionCount).toBe(2);
    expect(returnedPages[0]?.pagination.maxChars).toBeLessThan(10_000);
    expect(returnedPages[0]?.pagination.nextCursor).toEqual(expect.any(Number));
  });

  it("把无效工具参数和未知工具作为英文错误结果反馈给模型", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> };
      if (completionCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
          { id: "bad-json", type: "function", function: { name: "story_index", arguments: "{" } },
          { id: "bad-index", type: "function", function: { name: "story_index", arguments: { limit: 0, extra: true } } },
          { id: "bad-read", type: "function", function: { name: "read_chapters", arguments: { chapterIds: [], include: "invalid" } } },
          { id: "bad-character-section", type: "function", function: { name: "read_character_sections", arguments: { sectionIds: [], include: "invalid" } } },
          { id: "bad-grep", type: "function", function: { name: "grep", arguments: { keyword: "", limit: 0 } } },
          { id: "bad-query", type: "function", function: { name: "search_story_entities", arguments: { query: "", categories: ["unknown"] } } },
          { id: "unknown", type: "function", function: { name: "write_chapter", arguments: {} } }
        ] } }] }), { status: 200 });
      }
      const errors = body.messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content ?? "{}") as { ok: boolean; error: { code: string; message: string } });
      expect(errors).toHaveLength(7);
      expect(errors.every((result) => result.ok === false && /^[A-Z_]+$/u.test(result.error.code))).toBe(true);
      expect(errors.every((result) => /Invalid|not available/u.test(result.error.message))).toBe(true);
      return new Response(JSON.stringify({ choices: [{ message: { content: "工具失败信息已正确处理。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "验证工具错误。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);

    expect(response.body.data.toolCalls).toHaveLength(7);
    expect(response.body.data.toolCalls.every((call: { status: string }) => call.status === "failed")).toBe(true);
    expect(response.body.data.content).toBe("工具失败信息已正确处理。");
  });

  it("上游返回非限流 4xx 时不进行无效重试", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "invalid request" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    }));

    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "触发上游参数错误。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(502);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("工具配额限制不改动 prompt cache 前缀的 tools 定义与系统消息", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentToolCallLimit: 5,
      agentToolCallGlobalMultiplier: 1
    }).expect(200);

    const generationToolSnapshots: string[] = [];
    const generationSystemSnapshots: string[] = [];
    const generationToolChoices: Array<string | undefined> = [];
    let generationCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role?: string; content?: string }>;
        tools?: unknown[];
        tool_choice?: string;
      };
      const isCompaction = body.messages?.[0]?.content?.includes("压缩已完成的 AI 工具调用上下文");
      if (isCompaction) {
        expect(body.tools).toBeUndefined();
        return new Response(JSON.stringify({
          choices: [{ message: { content: "压缩摘要仅用于测试。" } }]
        }), { status: 200 });
      }
      generationCount += 1;
      generationToolSnapshots.push(JSON.stringify(body.tools ?? null));
      generationSystemSnapshots.push(JSON.stringify(
        (body.messages ?? []).filter((message) => message.role === "system")
      ));
      generationToolChoices.push(body.tool_choice);
      expect(body.tools?.length).toBeGreaterThan(0);
      expect(body.tool_choice).toBe("auto");
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: `quota-round-${generationCount}`,
              type: "function",
              function: { name: "story_index", arguments: "{\"limit\":1}" }
            }]
          }
        }]
      }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "反复查询目录直到得出结论。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(502);

    expect(response.body.error).toMatchObject({ code: "AI_CALL_FAILED", message: "AI 调用失败" });
    const failureText = JSON.stringify(response.body.error);
    expect(failureText).toMatch(/more than 5 tool calls|global tool call limit/iu);
    expect(generationCount).toBeGreaterThan(1);
    expect(new Set(generationToolSnapshots).size).toBe(1);
    expect(new Set(generationSystemSnapshots).size).toBe(1);
    expect(generationToolChoices.every((choice) => choice === "auto")).toBe(true);
    expect(generationToolSnapshots[0]).toContain("story_index");
  });

  it("角色扮演对话只提供自身回忆工具并持久化角色卡", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    const role = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "林舟",
      isDead: false,
      profile: { summary: "北港领航员" },
      currentState: { location: "北港" }
    }).expect(201);
    await request(runtime.app).post(`/api/characters/${role.body.data.id}/sections`).send({
      sectionType: "background",
      title: "旧日记忆",
      contentMarkdown: "林舟记得十二岁那年第一次看见星舰。",
      summary: "第一次看见星舰"
    }).expect(201);
    const otherRole = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "顾潮",
      aliases: ["潮哥"],
      profile: { secret: "这段其他角色的私密档案不得被读取" }
    }).expect(201);
    const thirdRole = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: role.body.data.id,
      toCharacterId: otherRole.body.data.id,
      category: "social",
      subtype: "旧友",
      keywords: ["共同远航"],
      directed: false,
      currentStatus: "active",
      confirmationStatus: "confirmed",
      evidence: [{ quote: "林舟和顾潮曾共同远航" }]
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: otherRole.body.data.id,
      toCharacterId: thirdRole.body.data.id,
      category: "conflict",
      subtype: "秘密对手",
      keywords: ["其他两人的关系"],
      directed: false,
      currentStatus: "active",
      confirmationStatus: "confirmed"
    }).expect(201);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({
      content: "林舟启动了飞船。\n\n顾潮独自藏起了只有自己知道的密钥。"
    }).expect(200);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const roleplay = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/roleplay`).send({
      characterId: role.body.data.id
    }).expect(200);
    expect(roleplay.body.data.taskType).toBe("roleplay");
    expect(roleplay.body.data.roleplayCharacter).toMatchObject({ id: role.body.data.id, name: "林舟" });
    const otherWork = await request(runtime.app).post("/api/works").send({ title: "其他作品" }).expect(201);
    const foreignCharacter = await request(runtime.app).post(`/api/works/${otherWork.body.data.id}/characters`).send({ name: "越界角色" }).expect(201);
    const mismatch = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/roleplay`).send({
      characterId: foreignCharacter.body.data.id
    }).expect(400);
    expect(mismatch.body.error.code).toBe("ROLEPLAY_CHARACTER_WORK_MISMATCH");
    await request(runtime.app).patch("/api/platform/ai/settings").send({
      systemPrompt: "平台创作助手提示不得进入角色扮演。"
    }).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      systemPrompt: "作品创作助手提示不得进入角色扮演。"
    }).expect(200);

    let completionCount = 0;
    const roleplaySystemPrompts: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role?: string; content?: string }>;
        tools?: Array<{ function?: { name?: string; description?: string; parameters?: Record<string, unknown> } }>;
      };
      const systemPrompt = String(body.messages[0]?.content ?? "");
      roleplaySystemPrompts.push(systemPrompt);
      expect(systemPrompt).toContain("<roleplay_main_prompt>");
      expect(systemPrompt).toContain("你是沉浸式角色扮演引擎");
      expect(systemPrompt).toContain("<character_card>");
      expect(systemPrompt).toContain('"name":"林舟"');
      expect(systemPrompt).toContain('"isDead":false');
      expect(systemPrompt).not.toContain("小说作者的创作协作助手");
      expect(systemPrompt).not.toContain("平台创作助手提示不得进入角色扮演");
      expect(systemPrompt).not.toContain("作品创作助手提示不得进入角色扮演");
      expect(systemPrompt).not.toContain("<platform_system_prompt>");
      expect(systemPrompt).not.toContain("<work_system_prompt>");
      expect(systemPrompt).not.toContain("<extra_system_prompt>");
      expect(systemPrompt).not.toContain("<current_time>");
      expect(JSON.stringify(body.messages)).toContain("<scene_context>");
      expect(JSON.stringify(body.messages)).toContain("<user_message>");
      expect(JSON.stringify(body.messages)).not.toContain("<author_instruction>");
      expect(body.tools?.map((tool) => tool.function?.name)).toEqual(["recall_self", "recall_relationship"]);
      expect(body.tools?.[0]?.function?.description).toContain("只有值为 true 才能判定已死亡");
      expect(body.tools?.[0]?.function?.description).toContain("字段为 false 时必须视为仍存活");
      expect(body.tools?.[1]?.function?.description).toContain("只能返回当前角色参与的关系");
      expect(body.tools?.[1]?.function?.description).toContain("未传入 characters");
      expect(JSON.stringify(body.tools)).not.toContain("characterId");
      expect(JSON.stringify(body.tools)).not.toContain("otherCharacter");
      if (completionCount === 1) {
        expect(JSON.stringify(body.messages)).not.toContain("顾潮独自藏起");
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
          { id: "self-memory", type: "function", function: { name: "recall_self", arguments: JSON.stringify({ categories: ["profile", "sections", "chapters"] }) } },
          { id: "relationship-list", type: "function", function: { name: "recall_relationship", arguments: "{}" } },
          { id: "forbidden-index", type: "function", function: { name: "story_index", arguments: "{}" } }
        ] } }] }), { status: 200 });
      }
      if (completionCount === 2) {
        const toolMessages = body.messages.filter((message) => message.role === "tool").map((message) => String(message.content));
        expect(toolMessages[0]).toContain("北港领航员");
        expect(toolMessages[0]).toContain('"isDead":false');
        expect(toolMessages[0]).toContain("第一次看见星舰");
        expect(toolMessages[0]).toContain("林舟启动了飞船");
        expect(toolMessages[0]).not.toContain("其他角色的私密档案");
        expect(toolMessages[0]).not.toContain("只有自己知道的密钥");
        expect(toolMessages[1]).toContain("顾潮");
        expect(toolMessages[1]).toContain("潮哥");
        expect(toolMessages[1]).toContain("relationshipCount");
        expect(toolMessages[1]).not.toContain("旧友");
        expect(toolMessages[1]).not.toContain("共同远航");
        expect(toolMessages[2]).toContain("TOOL_NOT_AVAILABLE");
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
          { id: "relationship-details", type: "function", function: { name: "recall_relationship", arguments: JSON.stringify({ characters: ["潮哥", "沈星"] }) } }
        ] } }] }), { status: 200 });
      }
      if (completionCount === 3) {
        const toolMessages = body.messages.filter((message) => message.role === "tool").map((message) => String(message.content));
        const relationshipDetails = toolMessages.at(-1) ?? "";
        expect(relationshipDetails).toContain('"mode":"details"');
        expect(relationshipDetails).toContain("顾潮");
        expect(relationshipDetails).toContain("旧友");
        expect(relationshipDetails).toContain("共同远航");
        expect(relationshipDetails).not.toContain("秘密对手");
        expect(relationshipDetails).not.toContain("其他两人的关系");
        return new Response(JSON.stringify({ choices: [{ message: { content: "我记得第一次看见星舰，也记得自己在北港启动了飞船。" } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "我还在北港。你想知道什么？" } }] }), { status: 200 });
    });

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "你记得什么？",
      scope: { type: "book" },
      modelId,
      conversationId: conversation.body.data.id
    }).expect(200);
    expect(streamed.text).toContain('"name":"recall_self"');
    expect(streamed.text).toContain('"name":"story_index"');
    expect(streamed.text).toContain('"status":"failed"');
    expect(streamed.text).toContain("我记得第一次看见星舰");
    const secondTurn = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "你现在在哪里？",
      scope: { type: "none", suppressAutomaticContext: true },
      modelId,
      conversationId: conversation.body.data.id
    }).expect(200);
    expect(secondTurn.text).toContain("我还在北港");
    expect(roleplaySystemPrompts).toHaveLength(4);
    expect(new Set(roleplaySystemPrompts).size).toBe(1);

    const reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversation.body.data.id}`).expect(200);
    expect(reloaded.body.data.taskType).toBe("roleplay");
    expect(reloaded.body.data.roleplayCharacter).toMatchObject({ id: role.body.data.id, name: "林舟" });
    const forked = await request(runtime.app).post(`/api/ai-conversations/${conversation.body.data.id}/fork`).send({
      messageId: reloaded.body.data.messages.at(-1).id
    }).expect(201);
    expect(forked.body.data.taskType).toBe("roleplay");
    expect(forked.body.data.roleplayCharacter).toMatchObject({ id: role.body.data.id, name: "林舟" });
    const lockedRole = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/roleplay`).send({
      characterId: otherRole.body.data.id
    }).expect(409);
    expect(lockedRole.body.error.code).toBe("ROLEPLAY_CHARACTER_LOCKED");
    const exitLockedRole = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/roleplay`).send({
      characterId: null
    }).expect(409);
    expect(exitLockedRole.body.error.code).toBe("ROLEPLAY_CHARACTER_LOCKED");

    const ordinaryConversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    await request(runtime.app).post(`/api/ai-conversations/${ordinaryConversation.body.data.id}/messages`).send({
      role: "user",
      content: "普通问答已经开始"
    }).expect(201);
    const started = await request(runtime.app).patch(`/api/ai-conversations/${ordinaryConversation.body.data.id}/roleplay`).send({
      characterId: role.body.data.id
    }).expect(409);
    expect(started.body.error.code).toBe("ROLEPLAY_CONVERSATION_STARTED");
  });

  it("对话开始后锁定问答、角色扮演、续写和润色任务类型", async () => {
    const taskTypes = ["chat", "roleplay", "continue", "polish"] as const;
    const draftConversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({
      taskType: "chat"
    }).expect(201);
    for (const taskType of taskTypes) {
      const changed = await request(runtime.app).patch(`/api/ai-conversations/${draftConversation.body.data.id}/task-type`).send({
        taskType
      }).expect(200);
      expect(changed.body.data.taskType).toBe(taskType);
    }

    for (const initialTaskType of taskTypes) {
      const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({
        taskType: initialTaskType
      }).expect(201);
      await request(runtime.app).post(`/api/ai-conversations/${conversation.body.data.id}/messages`).send({
        role: "user",
        content: `已开始 ${initialTaskType} 对话`
      }).expect(201);
      const unchanged = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/task-type`).send({
        taskType: initialTaskType
      }).expect(200);
      expect(unchanged.body.data.taskType).toBe(initialTaskType);
      for (const nextTaskType of taskTypes.filter((taskType) => taskType !== initialTaskType)) {
        const locked = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/task-type`).send({
          taskType: nextTaskType
        }).expect(409);
        expect(locked.body.error.code).toBe("AI_CONVERSATION_TASK_LOCKED");
      }
    }

    await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({ taskType: "analysis" }).expect(400);
  });

  it("对话开始后锁定实际上下文引用并在分支中保留", async () => {
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({
      taskType: "chat"
    }).expect(201);
    await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/context-scope`).send({
      scope: { type: "book" }
    }).expect(200);
    const selected = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/context-scope`).send({
      scope: { type: "chapter", chapterId, includeBookSummary: true }
    }).expect(200);
    expect(selected.body.data.contextScope).toEqual({ type: "chapter", chapterId, includeBookSummary: true });
    const message = await request(runtime.app).post(`/api/ai-conversations/${conversation.body.data.id}/messages`).send({
      role: "user",
      content: "已开始固定章节上下文的对话"
    }).expect(201);
    await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/context-scope`).send({
      scope: { type: "chapter", chapterId, includeBookSummary: true }
    }).expect(200);
    const locked = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/context-scope`).send({
      scope: { type: "book" }
    }).expect(409);
    expect(locked.body.error.code).toBe("AI_CONVERSATION_CONTEXT_LOCKED");

    const forked = await request(runtime.app).post(`/api/ai-conversations/${conversation.body.data.id}/fork`).send({
      messageId: message.body.data.id
    }).expect(201);
    expect(forked.body.data.contextScope).toEqual({ type: "chapter", chapterId, includeBookSummary: true });

    const otherWork = await request(runtime.app).post("/api/works").send({ title: "上下文越界作品" }).expect(201);
    const otherVolume = await request(runtime.app).post(`/api/works/${otherWork.body.data.id}/volumes`).send({ title: "越界卷" }).expect(201);
    const otherChapter = await request(runtime.app).post(`/api/works/${otherWork.body.data.id}/chapters`).send({
      volumeId: otherVolume.body.data.id,
      title: "越界章节",
      content: "不得引用"
    }).expect(201);
    const draft = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const mismatch = await request(runtime.app).patch(`/api/ai-conversations/${draft.body.data.id}/context-scope`).send({
      scope: { type: "chapter", chapterId: otherChapter.body.data.id }
    }).expect(400);
    expect(mismatch.body.error.code).toBe("CHAPTER_WORK_MISMATCH");
  });

  it("生成建议不改正文，作者采纳后才生成新版本", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expectedMaxTokens = 24_000;
    await request(runtime.app).patch(`/api/models/${modelId}`).send({ preset: { max_tokens: expectedMaxTokens } }).expect(200);

    const suggestion = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "continue",
      instruction: "续写离港场景",
      scope: { type: "chapter", chapterId },
      modelId,
      parameters: { temperature: 9, unsupported: "drop" }
    }).expect(201);
    expect(suggestion.body.data).toMatchObject({ status: "pending", action: "append", chapterVersion: 1 });
    const unchanged = await request(runtime.app).get(`/api/chapters/${chapterId}`).expect(200);
    expect(unchanged.body.data).toMatchObject({ content: "林舟启动了飞船。", versionNo: 1 });

    const accepted = await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/accept`).send({}).expect(200);
    expect(accepted.body.data.chapter.content).toContain("飞船缓缓驶离北港");
    expect(accepted.body.data.chapter.versionNo).toBe(2);

    const calls = await request(runtime.app).get(`/api/works/${workId}/ai-calls`).expect(200);
    const continuationCall = calls.body.data.find((call: { taskType: string }) => call.taskType === "continue");
    expect(continuationCall).toMatchObject({ status: "completed", parameters: { temperature: 2, max_tokens: 24_000 } });
    expect(continuationCall.provider.name).toBe("本地兼容服务");
    expect(continuationCall.model.displayName).toBe("小说模型");
    expect(suggestion.body.data.guard).toMatchObject({ status: "clear", issues: [] });
  });

  it("拒绝采纳基于旧正文版本的建议", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({});
    const suggestion = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "continue",
      instruction: "续写",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({ content: "作者已经重写正文。" }).expect(200);
    const stale = await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/accept`).send({}).expect(409);
    expect(stale.body.error.code).toBe("STALE_SUGGESTION");
  });

  it("润色缺少选中文本时在调用模型前失败", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({});
    fetchMock.mockClear();
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "polish",
      instruction: "润色",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("侧栏问答通过 SSE 逐段输出并在完整读取后记录建议", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body)) as { stream?: boolean; max_tokens?: number; messages?: Array<{ content: string }>; thinking?: { type?: string } };
      expect(body).toMatchObject({ stream: true, max_tokens: 32_000 });
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.messages?.some((message) => message.content.includes("[第一章 L1-L2]"))).toBe(true);
      expect(body.messages?.some((message) => message.content.includes("林舟启动了飞船。"))).toBe(true);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"先读取"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"现有上下文。"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"飞船"}}]}\n\n'));
          setTimeout(() => {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"离港"},"finish_reason":"stop"}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":75},"completion_tokens":4}}\n\n'));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }, 5);
        }
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "飞船接下来怎样？",
      scope: { type: "chapter", chapterId },
      modelId,
      citations: [{ chapterId, chapterTitle: "第一章", startLine: 1, endLine: 2, text: "林舟启动了飞船。\n跃迁准备完成。" }]
    }).expect(200).expect("Content-Type", /text\/event-stream/u);
    expect(streamed.text).toContain('event: delta\ndata: {"delta":"飞船"}');
    expect(streamed.text).toContain('event: delta\ndata: {"delta":"离港"}');
    expect(streamed.text).toContain('event: process_step\ndata: {"id":"process_');
    expect(streamed.text).toContain('"type":"thinking","round":1,"content":"先读取"');
    expect(streamed.text).toContain('"content":"现有上下文。"');
    expect(streamed.text.indexOf('"飞船"')).toBeLessThan(streamed.text.indexOf('"离港"'));
    expect(streamed.text).toContain("event: complete");
    expect(streamed.text).toContain('"outputTokens":4,"cacheHitPercent":75');
    expect(streamed.text).toContain('"processSteps":[{"id":"process_');
    expect(streamed.text).toContain('"content":"先读取现有上下文。"');

    const suggestions = await request(runtime.app).get(`/api/works/${workId}/suggestions`).expect(200);
    expect(suggestions.body.data[0]).toMatchObject({ taskType: "chat", action: "note", content: "飞船离港" });
    const calls = await request(runtime.app).get(`/api/works/${workId}/ai-calls`).expect(200);
    expect(calls.body.data[0]).toMatchObject({ taskType: "chat", status: "completed", outputChars: 4 });
    const usage = await request(runtime.app).get(`/api/works/${workId}/ai-settings/usage`).expect(200);
    expect(usage.body.data.summary).toMatchObject({
      totalTokens: 104,
      inputTokens: 100,
      outputTokens: 4,
      cachedInputTokens: 75,
      cacheEligibleInputTokens: 100,
      cacheHitRate: 75,
      estimatedRequestCount: 0
    });
  });

  it("首轮对话默认使用提示词前十五字并可由独立模型生成标题", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    const settingsBefore = await request(runtime.app).get(`/api/works/${workId}/ai-settings`).expect(200);
    expect(settingsBefore.body.data.titleGenerationModelId).toBeNull();

    const defaultConversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    await request(runtime.app).post(`/api/ai-conversations/${defaultConversation.body.data.id}/messages`).send({
      role: "user",
      content: "一二三四五六七八九十一二三四五六七八九十"
    }).expect(201);
    const defaultReloaded = await request(runtime.app).get(`/api/ai-conversations/${defaultConversation.body.data.id}`).expect(200);
    expect(defaultReloaded.body.data.title).toBe("一二三四五六七八九十一二三四五");

    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ titleGenerationModelId: modelId, agentTools: [] }).expect(200);
    const completionBodies: Array<{ stream?: boolean; tools?: unknown; messages?: Array<{ content?: string }> }> = [];
    let titleRequestStarted = false;
    let releaseTitleRequest: (() => void) | null = null;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { stream?: boolean; tools?: unknown; messages?: Array<{ content?: string }> };
      completionBodies.push(body);
      if (body.stream) {
        return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"助手回答\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
      expect(body.tools).toBeUndefined();
      expect(body.messages?.some((message) => message.content?.includes("请规划北港跃迁路线"))).toBe(true);
      expect(body.messages?.some((message) => message.content?.includes("助手回答"))).toBe(true);
      titleRequestStarted = true;
      return new Promise<Response>((resolve) => {
        releaseTitleRequest = () => resolve(new Response(JSON.stringify({ choices: [{ message: { content: "标题：北港跃迁路线" } }] }), { status: 200 }));
      });
    });

    const streamPromise = request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "请规划北港跃迁路线",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(200).expect("Content-Type", /text\/event-stream/u).then((response) => response);
    for (let index = 0; index < 50 && !titleRequestStarted; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(titleRequestStarted).toBe(true);
    const streamed = await Promise.race([
      streamPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("流式回答被标题生成阻塞")), 500))
    ]).finally(() => releaseTitleRequest?.());

    expect(streamed.text).toContain("event: context");
    expect(streamed.text).toContain("event: user_message");
    expect(streamed.text).not.toContain('"conversationTitle":"北港跃迁路线"');
    expect(completionBodies).toHaveLength(2);
    const completePayload = JSON.parse(streamed.text.match(/event: complete\ndata: ([^\n]+)/u)?.[1] ?? "{}") as { conversationId?: string };
    let reloaded = await request(runtime.app).get(`/api/ai-conversations/${completePayload.conversationId}`).expect(200);
    for (let index = 0; index < 50 && reloaded.body.data.title !== "北港跃迁路线"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      reloaded = await request(runtime.app).get(`/api/ai-conversations/${completePayload.conversationId}`).expect(200);
    }
    expect(reloaded.body.data.title).toBe("北港跃迁路线");
    expect(reloaded.body.data.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
    const settingsAfter = await request(runtime.app).get(`/api/works/${workId}/ai-settings`).expect(200);
    expect(settingsAfter.body.data.titleGenerationModelId).toBe(modelId);
  });

  it("首轮标题生成失败时不影响主回答", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ titleGenerationModelId: modelId, agentTools: [] }).expect(200);
    let titleRequestCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { stream?: boolean };
      if (body.stream) {
        return new Response('data: {"choices":[{"delta":{"content":"主回答"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
      titleRequestCount += 1;
      return new Response(JSON.stringify({ error: { message: "标题模型不可用" } }), { status: 400 });
    });

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "标题生成失败时仍保留默认",
      scope: { type: "none" },
      modelId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);

    for (let index = 0; index < 50 && titleRequestCount < 1; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(streamed.text).toContain('event: delta\ndata: {"delta":"主回答"}');
    expect(streamed.text).toContain("event: complete");
    expect(streamed.text).not.toContain("event: error");
    expect(titleRequestCount).toBe(1);
  });

  it("侧栏问答失败时通过 SSE 返回受控错误信息", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      const authorization = new Headers(init?.headers).get("Authorization");
      return new Response(JSON.stringify({ error: { message: `上游参数无效：${authorization}` } }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    });

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "触发可读错误",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);

    expect(streamed.text).toContain("event: error");
    expect(streamed.text).toContain('"code":"AI_CALL_FAILED"');
    expect(streamed.text).toContain('"status":502');
    expect(streamed.text).toContain('"providerName":"本地兼容服务"');
    expect(streamed.text).toContain(`"providerId":"${providerId}"`);
    expect(streamed.text).toContain('"modelId":"mock-novel-model"');
    expect(streamed.text).toContain(`"modelRecordId":"${modelId}"`);
    expect(streamed.text).toContain('"failure":"HTTP 400: {\\"error\\":{\\"message\\":\\"上游参数无效：Bearer sk-s*****lue\\"}}"');
    expect(streamed.text).not.toContain("sk-sensitive-test-value");
    expect(streamed.text).toMatch(/"callId":"call_[^"]+"/u);
    const calls = await request(runtime.app).get(`/api/works/${workId}/ai-calls`).expect(200);
    expect(calls.body.data[0].failure).toContain("上游参数无效：Bearer sk-s*****lue");
  });

  it("流式成功响应不会向浏览器或记录回显供应商密钥", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    fetchMock.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"安全前缀 sk-sensitive-"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"test-value 安全后缀"},"finish_reason":"stop"}]}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "检查密钥回显",
      scope: { type: "none" },
      modelId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);
    const suggestions = await request(runtime.app).get(`/api/works/${workId}/suggestions`).expect(200);

    expect(streamed.text).toContain('event: delta\ndata: {"delta":"安全前缀 "}');
    expect(streamed.text).toContain('event: delta\ndata: {"delta":"sk-s*****lue 安全后缀"}');
    expect(streamed.text).not.toContain("sk-sensitive-test-value");
    expect(suggestions.body.data[0].content).toBe("安全前缀 sk-s*****lue 安全后缀");
  });

  it("收到 OpenAI 流式 DONE 标记后不等待供应商关闭连接", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    let cancelled = false;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"已结束"},"finish_reason":"stop"}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
        },
        cancel() {
          cancelled = true;
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "测试 DONE 结束标记",
      scope: { type: "none" },
      modelId
    }).timeout({ deadline: 1_000 }).expect(200).expect("Content-Type", /text\/event-stream/u);

    expect(streamed.text).toContain('event: delta\ndata: {"delta":"已结束"}');
    expect(streamed.text).toContain("event: complete");
    expect(cancelled).toBe(true);
  });

  it("首轮上下文超限时不请求模型并提示减少上下文", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    setLegacyModelContextWindow(modelId, 1_024);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    fetchMock.mockClear();

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "必须保留的超长首轮指令。".repeat(1_000),
      scope: { type: "none" },
      modelId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(streamed.text).toContain("event: error");
    expect(streamed.text).toContain('"code":"CONTEXT_WINDOW_EXCEEDED"');
    expect(streamed.text).toContain('"status":400');
    expect(streamed.text).toContain("首轮上下文约");
    expect(streamed.text).toContain("本轮未进行上下文压缩，请减少选中的正文、设定、引用、对话历史或指令长度后重试");
    expect(streamed.text).toContain('"providerName":"本地兼容服务"');
    expect(streamed.text).toContain(`"providerId":"${providerId}"`);
    expect(streamed.text).toContain('"modelId":"mock-novel-model"');
    expect(streamed.text).toContain(`"modelRecordId":"${modelId}"`);
  });

  it("通过 SSE 推送工具调用并在对话 metadata 中持久化详情", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      if (completionCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "我先读取作品目录。", reasoning_content: "需要先确认作品结构。", tool_calls: [{ id: "stream-tool", type: "function", function: { name: "story_index", arguments: "{\"limit\":1}" } }] } }], usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 50 } } }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; reasoning_content?: string | null }> };
      expect(body.messages.find((message) => message.role === "assistant")?.reasoning_content).toBe("需要先确认作品结构。");
      return new Response(JSON.stringify({ choices: [{ message: { content: "已读取目录。", reasoning_content: "目录结果足以回答。" } }], usage: { prompt_tokens: 200, prompt_tokens_details: { cached_tokens: 150 }, completion_tokens: 8 } }), { status: 200 });
    });

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "读取目录后回答。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);

    expect(streamed.text).toContain("event: tool_call");
    expect(streamed.text).toContain("event: process_step");
    expect(streamed.text).toContain('"type":"thinking","round":1,"content":"需要先确认作品结构。"');
    expect(streamed.text).toContain('"type":"intermediate","round":1,"content":"我先读取作品目录。"');
    expect(streamed.text).toContain('"type":"thinking","round":2,"content":"目录结果足以回答。"');
    expect(streamed.text.indexOf('"type":"thinking","round":1')).toBeLessThan(streamed.text.indexOf("event: tool_call"));
    expect(streamed.text).toContain('"name":"story_index"');
    expect(streamed.text).toContain('"arguments":{"offset":0,"limit":1}');
    expect(streamed.text).toMatch(/"calledAt":"\d{4}-\d{2}-\d{2}T/u);
    expect(streamed.text).toContain('"result":{"ok":true');
    expect(streamed.text).toContain('event: complete');
    expect(streamed.text).toContain('"outputTokens":8,"cacheHitPercent":66.7');
    expect(streamed.text).toContain('"toolCalls":[{"id":"stream-tool"');
    expect(streamed.text).toContain('"processSteps":[{"id":"process_');

    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const toolCalls = [{ id: "stream-tool", name: "story_index", calledAt: "2026-07-17T12:34:56.000Z", arguments: { offset: 0, limit: 1 }, status: "completed", result: { ok: true, data: { totalChapters: 1 } } }];
    const processSteps = [
      { id: "process-thinking", type: "thinking", round: 1, content: "需要读取目录。", createdAt: "2026-07-17T12:34:55.000Z" },
      { id: "process-compaction", type: "context_compaction", round: 1, sourceMessageCount: 2, sourceChars: 12000, summaryChars: 180, createdAt: "2026-07-17T12:34:55.500Z" },
      { id: "process-tool", type: "tool", round: 1, toolCall: toolCalls[0], createdAt: "2026-07-17T12:34:56.000Z" }
    ];
    await request(runtime.app).post(`/api/ai-conversations/${conversation.body.data.id}/messages`).send({
      role: "assistant",
      content: "已读取目录。",
      metadata: { modelDisplayName: "小说模型", outputTokens: 8, cacheHitPercent: 66.7, processDurationMs: 1450, toolCalls, processSteps }
    }).expect(201);
    const reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversation.body.data.id}`).expect(200);
    expect(reloaded.body.data.messages[0].metadata.toolCalls).toEqual(toolCalls);
    expect(reloaded.body.data.messages[0].metadata.processSteps).toEqual(processSteps);
    expect(reloaded.body.data.messages[0].metadata.processDurationMs).toBe(1450);
    expect(reloaded.body.data.messages[0].metadata.cacheHitPercent).toBe(66.7);
  });

  it("完整读取响应正文前不释放供应商并发槽", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ concurrencyLimit: 3, rpmLimit: 100 }).expect(200);
    let active = 0;
    let maximumActive = 0;
    let chatStarts = 0;
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      chatStarts += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: "并发响应" } }] })));
            controller.close();
            active -= 1;
          }, 20);
        }
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    });
    await Promise.all(Array.from({ length: 7 }, (_, index) => runtime.ai.generate({
      workId,
      taskType: "chat",
      instruction: `并发请求 ${index}`,
      scope: { type: "chapter", chapterId },
      modelId
    })));
    expect(chatStarts).toBe(7);
    expect(maximumActive).toBe(3);
  });

  it("按滚动一分钟窗口限制供应商 RPM", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ concurrencyLimit: 10, rpmLimit: 2 }).expect(200);
    let chatStarts = 0;
    fetchMock.mockImplementation(async () => {
      chatStarts += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "限流响应" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.useFakeTimers();
    const calls = Array.from({ length: 3 }, (_, index) => runtime.ai.generate({
      workId,
      taskType: "chat",
      instruction: `RPM 请求 ${index}`,
      scope: { type: "chapter", chapterId },
      modelId
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(chatStarts).toBe(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(chatStarts).toBe(2);
    await vi.advanceTimersByTimeAsync(2);
    await Promise.all(calls);
    expect(chatStarts).toBe(3);
  });

  it("修改供应商限额后立即刷新已经存在的排队请求", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ concurrencyLimit: 1, rpmLimit: 1 }).expect(200);
    let chatStarts = 0;
    const resolveRequests: Array<() => void> = [];
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      chatStarts += 1;
      return new Promise<Response>((resolve) => {
        resolveRequests.push(() => resolve(new Response(JSON.stringify({ choices: [{ message: { content: "动态限额响应" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })));
      });
    });
    const calls = Array.from({ length: 3 }, (_, index) => runtime.ai.generate({
      workId,
      taskType: "chat",
      instruction: `动态限额请求 ${index}`,
      scope: { type: "chapter", chapterId },
      modelId
    }));
    for (let index = 0; index < 50 && chatStarts < 1; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(chatStarts).toBe(1);

    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ concurrencyLimit: 2, rpmLimit: 2 }).expect(200);
    for (let index = 0; index < 50 && chatStarts < 2; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(chatStarts).toBe(2);
    resolveRequests.splice(0).forEach((resolve) => resolve());

    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ rpmLimit: 3 }).expect(200);
    for (let index = 0; index < 50 && chatStarts < 3; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(chatStarts).toBe(3);
    resolveRequests.splice(0).forEach((resolve) => resolve());
    await Promise.all(calls);
  });

  it("请求超时覆盖响应正文读取阶段", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    fetchMock.mockImplementation(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.useFakeTimers();
    const call = runtime.ai.generate({
      workId,
      taskType: "chat",
      instruction: "等待慢响应正文",
      scope: { type: "chapter", chapterId },
      modelId,
      maxAttempts: 1
    });
    const rejection = expect(call).rejects.toMatchObject({
      message: "AI 调用失败",
      details: { failure: "AI 请求超时（60 秒）" }
    });
    await vi.advanceTimersByTimeAsync(60_001);
    await rejection;
    const calls = await request(runtime.app).get(`/api/works/${workId}/ai-calls`).expect(200);
    expect(calls.body.data[0]).toMatchObject({ status: "failed" });
  });
});
