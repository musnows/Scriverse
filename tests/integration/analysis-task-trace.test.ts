import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("AI 分析全流程追踪", () => {
  let runtime: Runtime | null = null;

  afterEach(() => {
    runtime?.close();
    runtime = null;
  });

  it("保存每轮完整 Prompt、模型响应与工具执行结果", async () => {
    let completionRound = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "trace-model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { max_tokens?: number };
      if (body.max_tokens === 10) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      completionRound += 1;
      const reflectedAuthorization = new Headers(init?.headers).get("Authorization");
      if (completionRound === 1) {
        return new Response(JSON.stringify({
          debug: { authorization: reflectedAuthorization },
          choices: [{
            finish_reason: "tool_calls",
            message: {
              content: `先查询角色档案和正文证据。${reflectedAuthorization}`,
              reasoning_content: `需要完成两项必需查询。${reflectedAuthorization}`,
              tool_calls: [
                {
                  id: "tool-search",
                  type: "function",
                  function: { name: "search_story_entities", arguments: JSON.stringify({ query: "林舟", categories: ["character"] }) }
                },
                {
                  id: "tool-grep",
                  type: "function",
                  function: { name: "grep", arguments: JSON.stringify({ keyword: "林舟", limit: 10 }) }
                }
              ]
            }
          }],
          usage: { prompt_tokens: 120, completion_tokens: 30 }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        debug: { authorization: reflectedAuthorization },
        choices: [{ finish_reason: "stop", message: { content: "<json>[]</json>", reasoning_content: `没有重复角色。${reflectedAuthorization}` } }],
        usage: { prompt_tokens: 180, completion_tokens: 12 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);

    const work = await request(runtime.app).post("/api/works").send({ title: "追踪测试作品" }).expect(201);
    const workId = work.body.data.id;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "林舟在北港遇见林川，两人确认彼此并非同一个人。"
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "林舟",
      aliases: ["阿舟"],
      firstChapterId: chapter.body.data.id
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "林川",
      aliases: ["阿川"],
      firstChapterId: chapter.body.data.id
    }).expect(201);

    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "追踪测试服务",
      baseUrl: "https://trace-ai.test/v1",
      apiKey: "sk-trace-secret",
      status: "enabled"
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "追踪模型",
      modelId: "trace-model",
      purposes: ["book-analysis"]
    }).expect(201);

    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "character-identity-audit",
      scope: { type: "book" }
    }).expect(201);
    await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({
      modelId: model.body.data.id
    }).expect(200);

    const traceResponse = await request(runtime.app).get(`/api/tasks/${task.body.data.id}/trace`).expect(200);
    const trace = traceResponse.body.data;
    expect(trace).toMatchObject({ taskId: task.body.data.id, captured: true });
    expect(trace.calls).toHaveLength(1);
    expect(trace.calls[0]).toMatchObject({
      status: "completed",
      model: { displayName: "追踪模型" },
      sourceRefs: [{ type: "chapter", title: "第一章" }],
      trace: { available: true, initialMessageCount: 2, roundCount: 2, serializedChars: expect.any(Number) }
    });
    expect(JSON.stringify(trace)).not.toContain("审核角色规范表");
    expect(trace.calls[0].trace).not.toHaveProperty("initialMessages");
    expect(trace.calls[0].trace).not.toHaveProperty("rounds");

    const callId = String(trace.calls[0].id);
    const fullResponse = await request(runtime.app).get(`/api/tasks/${task.body.data.id}/trace/calls/${callId}`).expect(200);
    const full = fullResponse.body.data;
    expect(full).toMatchObject({
      taskId: task.body.data.id,
      callId,
      mode: "full",
      trace: { initialMessages: expect.any(Array), rounds: expect.any(Array) }
    });
    const fullTrace = full.trace;
    expect(fullTrace.initialMessages[1].content).toContain("审核角色规范表");
    expect(fullTrace.rounds).toHaveLength(2);
    expect(fullTrace.rounds[0]).toMatchObject({
      round: 1,
      request: {
        model: "trace-model",
        messages: expect.any(Array),
        toolChoice: "auto",
        tools: expect.any(Array)
      },
      attempts: [{
        attempt: 1,
        status: "completed",
        httpStatus: 200,
        response: { choices: [{ message: { tool_calls: expect.any(Array) } }] }
      }],
      toolExecutions: [
        { id: "tool-search", name: "search_story_entities", status: "completed" },
        { id: "tool-grep", name: "grep", status: "completed" }
      ]
    });
    expect(fullTrace.rounds[1].request.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", tool_calls: expect.any(Array) }),
      expect.objectContaining({ role: "tool", tool_call_id: "tool-search" }),
      expect.objectContaining({ role: "tool", tool_call_id: "tool-grep" })
    ]));
    expect(JSON.stringify(fullTrace)).not.toContain("sk-trace-secret");
    expect(JSON.stringify(fullTrace)).toContain("Bearer sk-t*****ret");
    expect(fullTrace.rounds[0].attempts[0].response).not.toHaveProperty("debug");

    const call = runtime.database.get<Record<string, unknown>>("SELECT task_id FROM ai_calls WHERE id = ?", trace.calls[0].id);
    expect(call?.task_id).toBe(task.body.data.id);

    runtime.ai.deleteProvider(provider.body.data.id);
    const retainedTrace = await request(runtime.app).get(`/api/tasks/${task.body.data.id}/trace`).expect(200);
    expect(retainedTrace.body.data.calls[0]).toMatchObject({
      provider: { id: provider.body.data.id, name: "已删除的供应商", deleted: true },
      model: { id: model.body.data.id, displayName: "已删除的模型", modelId: null, deleted: true },
      trace: { available: true, roundCount: 2 }
    });
  });

  it("历史任务没有追踪记录时返回明确的空状态", async () => {
    runtime = createTestRuntime();
    const work = await request(runtime.app).post("/api/works").send({ title: "历史追踪测试" }).expect(201);
    const task = await request(runtime.app).post(`/api/works/${work.body.data.id}/tasks`).send({
      taskType: "book-analysis",
      scope: { type: "book" }
    }).expect(201);

    const trace = await request(runtime.app).get(`/api/tasks/${task.body.data.id}/trace`).expect(200);
    expect(trace.body.data).toEqual({
      taskId: task.body.data.id,
      captured: false,
      calls: []
    });
  });

  it("多次超长调用只在摘要后按单次调用加载完整内容", async () => {
    runtime = createTestRuntime();
    const work = await request(runtime.app).post("/api/works").send({ title: "超长追踪测试" }).expect(201);
    const task = await request(runtime.app).post(`/api/works/${work.body.data.id}/tasks`).send({
      taskType: "book-analysis",
      scope: { type: "book" }
    }).expect(201);
    const unrelatedTask = await request(runtime.app).post(`/api/works/${work.body.data.id}/tasks`).send({
      taskType: "book-analysis",
      scope: { type: "book" }
    }).expect(201);
    const timestamp = new Date().toISOString();
    for (let index = 0; index < 20; index += 1) {
      const callId = `call_large_trace_${index}`;
      const systemPrefix = `SYSTEM_${index}_`;
      const userPrefix = index === 0
        ? `USER_${index}_<CHAPTER id="chapter_trace" title="第一章"><正文不应进入摘要></CHAPTER><SETTING id="setting_trace" title="旧港盟约"><设定正文不应进入摘要></SETTING>`
        : `USER_${index}_`;
      const initialMessages = [
        { role: "system", content: systemPrefix + "系".repeat(35_000 - systemPrefix.length) },
        { role: "user", content: userPrefix + "用".repeat(35_000 - userPrefix.length) }
      ];
      runtime.database.run(
        `INSERT INTO ai_calls (id, work_id, task_id, task_type, provider_id, model_id, context_scope_json, parameters_json,
         status, input_chars, output_chars, created_at, completed_at) VALUES (?, ?, ?, 'book-analysis', ?, ?, '{}', '{}',
         'completed', 70000, 0, ?, ?)`,
        callId,
        work.body.data.id,
        task.body.data.id,
        `deleted_provider_${index}`,
        `deleted_model_${index}`,
        timestamp,
        timestamp
      );
      runtime.database.run(
        `INSERT INTO ai_call_traces (call_id, task_id, initial_messages_json, rounds_json, source_refs_json, created_at, updated_at)
         VALUES (?, ?, ?, '[]', ?, ?, ?)`,
        callId,
        task.body.data.id,
        JSON.stringify(initialMessages),
        JSON.stringify(index === 0 ? [
          { type: "chapter", title: "第一章" },
          { type: "setting", title: "旧港盟约" }
        ] : []),
        timestamp,
        timestamp
      );
    }

    const summaryResponse = await request(runtime.app).get(`/api/tasks/${task.body.data.id}/trace`).expect(200);
    expect(summaryResponse.body.data.calls).toHaveLength(20);
    expect(JSON.stringify(summaryResponse.body.data)).not.toContain("SYSTEM_0_");
    expect(JSON.stringify(summaryResponse.body.data)).not.toContain("正文不应进入摘要");
    expect(summaryResponse.body.data.calls[0].sourceRefs).toEqual([
      { type: "chapter", title: "第一章" },
      { type: "setting", title: "旧港盟约" }
    ]);
    expect(JSON.stringify(summaryResponse.body.data).length).toBeLessThan(25_000);

    const fullResponse = await request(runtime.app).get(`/api/tasks/${task.body.data.id}/trace/calls/call_large_trace_0`).expect(200);
    expect(fullResponse.body.data.mode).toBe("full");
    expect(fullResponse.body.data.trace.initialMessages.reduce((total: number, message: { content?: string }) => total + String(message.content ?? "").length, 0)).toBe(70_000);
    await request(runtime.app).get(`/api/tasks/${unrelatedTask.body.data.id}/trace/calls/call_large_trace_0`).expect(404);
  });

  it("供应商错误响应反射密钥时统一脱敏调用与追踪失败信息", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "failure-trace-model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { max_tokens?: number };
      if (body.max_tokens === 10) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const authorization = new Headers(init?.headers).get("Authorization");
      return new Response(`Provider rejected ${authorization}`, { status: 400 });
    });
    runtime = createTestRuntime(fetchMock);
    const work = await request(runtime.app).post("/api/works").send({ title: "失败追踪脱敏" }).expect(201);
    const workId = work.body.data.id;
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "失败追踪服务",
      baseUrl: "https://failure-trace.test/v1",
      apiKey: "sk-failure-trace-secret",
      status: "enabled"
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "失败追踪模型",
      modelId: "failure-trace-model",
      purposes: ["book-analysis"]
    }).expect(201);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "book-analysis",
      scope: { type: "book" }
    }).expect(201);

    const failedRun = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId: model.body.data.id }).expect(502);
    expect(JSON.stringify(failedRun.body)).not.toContain("sk-failure-trace-secret");
    expect(JSON.stringify(failedRun.body)).toContain("Bearer sk-f*****ret");
    const trace = await request(runtime.app).get(`/api/tasks/${task.body.data.id}/trace`).expect(200);
    const serializedTrace = JSON.stringify(trace.body.data);
    expect(serializedTrace).not.toContain("sk-failure-trace-secret");
    expect(serializedTrace).toContain("Bearer sk-f*****ret");
    const call = runtime.database.get<Record<string, unknown>>("SELECT failure FROM ai_calls WHERE task_id = ?", task.body.data.id);
    expect(String(call?.failure)).not.toContain("sk-failure-trace-secret");
    expect(String(call?.failure)).toContain("Bearer sk-f*****ret");
  });
});
