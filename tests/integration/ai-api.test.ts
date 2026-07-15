import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { estimateAiTokens } from "../../src/ai.js";
import { createTestRuntime } from "../helpers.js";

describe("AI 供应商、模型与建议 API", () => {
  let runtime: Runtime;
  let workId: string;
  let chapterId: string;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let expectedMaxTokens: number;

  beforeEach(async () => {
    expectedMaxTokens = 32_000;
    fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }>; max_tokens?: number };
      expect(body.messages[1]?.content).toContain("跃迁后必须冷却十二小时");
      expect(body.max_tokens).toBe(expectedMaxTokens);
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
  afterEach(() => {
    vi.useRealTimers();
    runtime.close();
  });

  async function configureAi(): Promise<{ providerId: string; modelId: string }> {
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "本地兼容服务",
      baseUrl: "https://mock-ai.test/v1/chat/completions",
      apiKey: "sk-sensitive-test-value",
      status: "enabled"
    }).expect(201);
    const providerId = provider.body.data.id;
    expect(provider.body.data.apiKey).not.toContain("sensitive");
    expect(provider.body.data.baseUrl).toBe("https://mock-ai.test/v1");
    expect(provider.body.data).toMatchObject({ concurrencyLimit: 10, rpmLimit: 10, maxTokens: 32_000 });
    const databaseRow = runtime.database.get<Record<string, unknown>>("SELECT encrypted_key FROM providers WHERE id = ?", providerId);
    expect(databaseRow?.encrypted_key).not.toContain("sk-sensitive-test-value");

    const model = await request(runtime.app).post(`/api/providers/${providerId}/models`).send({
      displayName: "小说模型",
      modelId: "mock-novel-model",
      preset: { temperature: 0.4, unsupported: "ignored" }
    }).expect(201);
    expect(model.body.data.preset).toMatchObject({ temperature: 0.4, max_tokens: 32_000, unsupported: "ignored" });
    return { providerId, modelId: model.body.data.id };
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
    const updatedModel = await request(runtime.app).patch(`/api/models/${modelId}`).send({ contextWindow: 4096 }).expect(200);
    expect(updatedModel.body.data.contextWindow).toBe(4096);

    const usage = await request(runtime.app).post(`/api/works/${workId}/ai-context-usage`).send({
      modelId,
      taskType: "chat",
      scope: { type: "chapter", chapterId },
      instruction: "概述本章"
    }).expect(200);
    expect(usage.body.data).toMatchObject({ modelId, contextWindow: 4096 });
    expect(usage.body.data.inputTokens).toBeGreaterThan(0);

    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      expect(body.messages[0]?.content).toContain("作者锁定的事实是不可违反的硬约束");
      expect(body.messages[0]?.content).toContain("平台追加：保持克制叙事。");
      expect(body.messages[0]?.content).toContain("本书追加：哥斯拉不得离开地球。");
      return new Response(JSON.stringify({ choices: [{ message: { content: "提示词已生效。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "检查提示词",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);
    await request(runtime.app).put(`/api/works/${secondWork.body.data.id}/task-defaults/chat`).send({ modelId }).expect(200);
    expect(secondChapter.body.data.title).toBe("第二章");
  });

  it("按模型上下文比例裁剪全书概要引用", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/models/${modelId}`).send({ contextWindow: 1024 }).expect(200);
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

    expect(sentContext).toContain("已裁剪较早概要");
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

  it("聊天默认暴露聚合查询工具并把结果回传给模型", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { tools?: Array<{ function?: { name?: string } }>; messages: Array<{ role: string; content?: string }> };
      expect(body.tools?.map((tool) => tool.function?.name)).toEqual(["story_index", "read_chapters", "query_story_knowledge"]);
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
      expect.objectContaining({ id: "tool-call-1", name: "story_index", status: "completed", arguments: { offset: 0, limit: 1 } })
    ]);
    expect(completionCount).toBe(2);
  });

  it("覆盖所有查询工具的可选参数组合并把结构化结果交回模型", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    const calls = [
      { id: "index-default", name: "story_index", arguments: {} },
      { id: "index-page", name: "story_index", arguments: { offset: 0, limit: 1 } },
      { id: "chapter-summary", name: "read_chapters", arguments: { chapterIds: [chapterId], include: "summary" } },
      { id: "chapter-content", name: "read_chapters", arguments: { chapterIds: [chapterId], include: "content" } },
      { id: "chapter-both", name: "read_chapters", arguments: { chapterIds: [chapterId], include: "both" } },
      { id: "knowledge-default", name: "query_story_knowledge", arguments: { query: "跃迁" } },
      { id: "knowledge-categories", name: "query_story_knowledge", arguments: { query: "跃迁", categories: ["setting", "character", "race", "organization", "timeline", "relationship", "outline", "foreshadow"] } }
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
      expect(results.get("knowledge-default")).toMatchObject({ ok: true, data: { query: "跃迁" } });
      expect(results.get("knowledge-categories")).toMatchObject({ ok: true, data: { matches: expect.any(Array) } });
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
          { id: "bad-query", type: "function", function: { name: "query_story_knowledge", arguments: { query: "", categories: ["unknown"] } } },
          { id: "unknown", type: "function", function: { name: "write_chapter", arguments: {} } }
        ] } }] }), { status: 200 });
      }
      const errors = body.messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content ?? "{}") as { ok: boolean; error: { code: string; message: string } });
      expect(errors).toHaveLength(5);
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

    expect(response.body.data.toolCalls).toHaveLength(5);
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

  it("工具连续调用达到安全轮次后强制模型生成最终回答", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { tool_choice?: string };
      if (body.tool_choice === "none") {
        return new Response(JSON.stringify({ choices: [{ message: { content: "已基于六轮工具结果回答。" } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: `round-${completionCount}`, type: "function", function: { name: "story_index", arguments: "{\"limit\":1}" } }] } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "反复检查后给出结论。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);

    expect(response.body.data.content).toBe("已基于六轮工具结果回答。");
    expect(response.body.data.toolCalls).toHaveLength(6);
    expect(completionCount).toBe(7);
  });

  it("生成建议不改正文，作者采纳后才生成新版本", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expectedMaxTokens = 24_000;
    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ maxTokens: expectedMaxTokens }).expect(200);

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
      const body = JSON.parse(String(init?.body)) as { stream?: boolean; max_tokens?: number; messages?: Array<{ content: string }> };
      expect(body).toMatchObject({ stream: true, max_tokens: 32_000 });
      expect(body.messages?.[1]?.content).toContain("[第一章 L1-L2]");
      expect(body.messages?.[1]?.content).toContain("林舟启动了飞船。");
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"飞船"}}]}\n\n'));
          setTimeout(() => {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"离港"},"finish_reason":"stop"}]}\n\n'));
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
    expect(streamed.text.indexOf('"飞船"')).toBeLessThan(streamed.text.indexOf('"离港"'));
    expect(streamed.text).toContain("event: complete");

    const suggestions = await request(runtime.app).get(`/api/works/${workId}/suggestions`).expect(200);
    expect(suggestions.body.data[0]).toMatchObject({ taskType: "chat", action: "note", content: "飞船离港" });
    const calls = await request(runtime.app).get(`/api/works/${workId}/ai-calls`).expect(200);
    expect(calls.body.data[0]).toMatchObject({ taskType: "chat", status: "completed", outputChars: 4 });
  });

  it("通过 SSE 推送工具调用并在对话 metadata 中持久化详情", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      if (completionCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "stream-tool", type: "function", function: { name: "story_index", arguments: "{\"limit\":1}" } }] } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "已读取目录。" } }], usage: { completion_tokens: 8 } }), { status: 200 });
    });

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "读取目录后回答。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);

    expect(streamed.text).toContain("event: tool_call");
    expect(streamed.text).toContain('"name":"story_index"');
    expect(streamed.text).toContain('"arguments":{"offset":0,"limit":1}');
    expect(streamed.text).toContain('"result":{"ok":true');
    expect(streamed.text).toContain('event: complete');
    expect(streamed.text).toContain('"toolCalls":[{"id":"stream-tool"');

    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const toolCalls = [{ id: "stream-tool", name: "story_index", arguments: { offset: 0, limit: 1 }, status: "completed", result: { ok: true, data: { totalChapters: 1 } } }];
    await request(runtime.app).post(`/api/ai-conversations/${conversation.body.data.id}/messages`).send({
      role: "assistant",
      content: "已读取目录。",
      metadata: { modelDisplayName: "小说模型", outputTokens: 8, toolCalls }
    }).expect(201);
    const reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversation.body.data.id}`).expect(200);
    expect(reloaded.body.data.messages[0].metadata.toolCalls).toEqual(toolCalls);
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
    const rejection = expect(call).rejects.toThrow("AI 调用失败");
    await vi.advanceTimersByTimeAsync(60_001);
    await rejection;
    const calls = await request(runtime.app).get(`/api/works/${workId}/ai-calls`).expect(200);
    expect(calls.body.data[0]).toMatchObject({ status: "failed" });
  });
});
