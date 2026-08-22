import { describe, expect, it } from "vitest";
import {
  buildCompletionRequestBody,
  parseCompletionPayload,
  parseProviderModelListPage,
  providerCompletionEndpoint,
  providerModelListPageEndpoint,
  providerModelEndpoints,
  providerRequestHeaders
} from "../../src/ai-protocol.js";

describe("AI 供应商协议适配", () => {
  it("为 Anthropic 与 LongCat 基础地址补全版本化端点", () => {
    expect(providerCompletionEndpoint("https://api.anthropic.com", "anthropic-messages"))
      .toBe("https://api.anthropic.com/v1/messages");
    expect(providerCompletionEndpoint("https://api.longcat.chat/anthropic", "anthropic-messages"))
      .toBe("https://api.longcat.chat/anthropic/v1/messages");
    expect(providerCompletionEndpoint("https://api.longcat.chat/anthropic/v1/messages", "anthropic-messages"))
      .toBe("https://api.longcat.chat/anthropic/v1/messages");
    expect(providerModelEndpoints("https://api.longcat.chat/anthropic", "anthropic-messages"))
      .toEqual(["https://api.longcat.chat/anthropic/v1/models", "https://api.longcat.chat/v1/models"]);
  });

  it("为 OpenAI Responses 基础地址补全 responses 端点", () => {
    expect(providerCompletionEndpoint("https://api.openai.com", "openai-responses"))
      .toBe("https://api.openai.com/v1/responses");
    expect(providerCompletionEndpoint("https://api.openai.com/v1/responses", "openai-responses"))
      .toBe("https://api.openai.com/v1/responses");
    expect(providerModelEndpoints("https://api.openai.com/v1", "openai-responses"))
      .toEqual(["https://api.openai.com/v1/models"]);
  });

  it.each(["openai-chat-completions", "openai-responses", "google-vertex"] as const)(
    "按 %s 的 OpenAI 兼容结构解析模型列表",
    (protocol) => {
      expect(parseProviderModelListPage(protocol, {
        object: "list",
        data: [
          { id: " model-a ", object: "model", created: 1, owned_by: "provider" },
          { id: "model-b", object: "model" },
          { object: "model" }
        ]
      })).toEqual({
        models: [
          { modelId: "model-a", displayName: "model-a" },
          { modelId: "model-b", displayName: "model-b" }
        ],
        invalidItemCount: 1
      });
    }
  );

  it("按 Anthropic 结构解析名称、能力、上下文与分页游标", () => {
    expect(parseProviderModelListPage("anthropic-messages", {
      data: [{
        id: "claude-sonnet",
        display_name: "Claude Sonnet",
        type: "model",
        max_input_tokens: 200_000,
        max_tokens: 64_000,
        capabilities: { image_input: { supported: true } }
      }],
      has_more: true,
      last_id: "claude-sonnet"
    })).toEqual({
      models: [{
        modelId: "claude-sonnet",
        displayName: "Claude Sonnet",
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        multimodalEnabled: true
      }],
      invalidItemCount: 0,
      nextCursor: "claude-sonnet"
    });
    expect(providerModelListPageEndpoint(
      "https://api.anthropic.com/v1/models",
      "anthropic-messages",
      "claude-sonnet"
    )).toBe("https://api.anthropic.com/v1/models?limit=1000&after_id=claude-sonnet");
  });

  it("拒绝缺少协议模型列表字段或 Anthropic 分页游标的响应", () => {
    expect(() => parseProviderModelListPage("openai-responses", { models: [] })).toThrow(/缺少 data 列表/u);
    expect(() => parseProviderModelListPage("anthropic-messages", { data: [], has_more: true })).toThrow(/缺少 last_id/u);
  });

  it("为 Anthropic 请求设置版本与两种兼容鉴权头", () => {
    expect(providerRequestHeaders("anthropic-messages", "secret-key", "application/json")).toEqual({
      Authorization: "Bearer secret-key",
      "x-api-key": "secret-key",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      Accept: "application/json"
    });
  });

  it("把系统消息、工具定义和工具结果转换为 Anthropic Messages 格式", () => {
    const body = buildCompletionRequestBody({
      protocol: "anthropic-messages",
      model: "LongCat-2.0",
      messages: [
        { role: "system", content: "系统约束" },
        { role: "user", content: "读取目录" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "toolu_1",
            type: "function",
            function: { name: "story_index", arguments: "{\"limit\":5}" }
          }]
        },
        { role: "tool", tool_call_id: "toolu_1", content: "{\"ok\":true}" },
        { role: "user", content: "请继续" }
      ],
      parameters: { max_tokens: 2_048, temperature: 0.2, presence_penalty: 1, output_config: { effort: "medium" } },
      tools: [{
        type: "function",
        function: {
          name: "story_index",
          description: "读取目录",
          parameters: { type: "object", properties: { limit: { type: "integer" } } }
        }
      }],
      toolChoice: "auto"
    });
    expect(body).toMatchObject({
      model: "LongCat-2.0",
      system: "系统约束",
      max_tokens: 2_048,
      temperature: 0.2,
      output_config: { effort: "medium" },
      tool_choice: { type: "auto" },
      tools: [{
        name: "story_index",
        description: "读取目录",
        input_schema: { type: "object", properties: { limit: { type: "integer" } } }
      }]
    });
    expect(body).not.toHaveProperty("presence_penalty");
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "读取目录" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "story_index", input: { limit: 5 } }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "{\"ok\":true}" },
          { type: "text", text: "请继续" }
        ]
      }
    ]);
  });

  it("把统一图片内容块转换为 Anthropic image source", () => {
    const body = buildCompletionRequestBody({
      protocol: "anthropic-messages",
      model: "claude-vision",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "理解这张图片" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "auto" } }
        ]
      }],
      parameters: { max_tokens: 128 }
    });
    expect(body.messages).toEqual([{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        { type: "text", text: "理解这张图片" }
      ]
    }]);
  });

  it("切换到 OpenAI 协议时不携带 Anthropic 回放字段或空工具调用", () => {
    const body = buildCompletionRequestBody({
      protocol: "openai-chat-completions",
      model: "mock-model",
      messages: [
        { role: "user", content: "第一轮" },
        {
          role: "assistant",
          content: "回答",
          anthropic_content: [{ type: "thinking", thinking: "内部思考", signature: "opaque" }]
        },
        { role: "user", content: "第二轮" }
      ],
      parameters: {},
      tools: [{ type: "function", function: { name: "story_index", parameters: {} } }],
      toolChoice: "auto"
    });
    expect(body.messages).toEqual([
      { role: "user", content: "第一轮" },
      { role: "assistant", content: "回答" },
      { role: "user", content: "第二轮" }
    ]);
    expect(body).toHaveProperty("tools");
    expect((body.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty("tool_calls");
  });

  it("默认保留 max_tokens，并可为 OpenAI 兼容请求切换为 max_completion_tokens", () => {
    const defaultBody = buildCompletionRequestBody({
      protocol: "openai-chat-completions",
      model: "mock-model",
      messages: [{ role: "user", content: "你好" }],
      parameters: { max_tokens: 2_048, temperature: 0.2 }
    });
    expect(defaultBody).toMatchObject({ max_tokens: 2_048, temperature: 0.2 });
    expect(defaultBody).not.toHaveProperty("max_completion_tokens");

    const completionTokensBody = buildCompletionRequestBody({
      protocol: "openai-chat-completions",
      model: "mock-model",
      messages: [{ role: "user", content: "你好" }],
      parameters: { max_tokens: 2_048, temperature: 0.2 },
      maxTokensParameter: "max_completion_tokens"
    });
    expect(completionTokensBody).toMatchObject({ max_completion_tokens: 2_048, temperature: 0.2 });
    expect(completionTokensBody).not.toHaveProperty("max_tokens");
  });

  it("Anthropic Messages 始终发送官方 max_tokens 参数", () => {
    const body = buildCompletionRequestBody({
      protocol: "anthropic-messages",
      model: "claude-model",
      messages: [{ role: "user", content: "你好" }],
      parameters: { max_tokens: 1_024 },
      maxTokensParameter: "max_completion_tokens"
    });
    expect(body).toMatchObject({ max_tokens: 1_024 });
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("为 OpenAI Responses 转换 input、图片、工具和思考强度", () => {
    const body = buildCompletionRequestBody({
      protocol: "openai-responses",
      model: "gpt-5",
      messages: [
        { role: "system", content: "系统约束" },
        {
          role: "user",
          content: [
            { type: "text", text: "理解这张图片" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "low" } }
          ]
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "story_index", arguments: "{\"limit\":1}" } }]
        },
        { role: "tool", tool_call_id: "call_1", content: "{\"ok\":true}" }
      ],
      parameters: { max_tokens: 2_048, temperature: 0.2, reasoning_effort: "auto" },
      tools: [{
        type: "function",
        function: { name: "story_index", description: "读取目录", parameters: { type: "object", properties: {} } }
      }],
      toolChoice: "auto",
      stream: true
    });
    expect(body).toMatchObject({
      model: "gpt-5",
      max_output_tokens: 2_048,
      temperature: 0.2,
      reasoning: { effort: "auto" },
      stream: true,
      tool_choice: "auto",
      tools: [{ type: "function", name: "story_index", description: "读取目录" }]
    });
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body.input).toEqual([
      { type: "message", role: "system", content: [{ type: "input_text", text: "系统约束" }] },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "理解这张图片" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "low" }
        ]
      },
      { type: "function_call", call_id: "call_1", name: "story_index", arguments: "{\"limit\":1}" },
      { type: "function_call_output", call_id: "call_1", output: "{\"ok\":true}" }
    ]);
  });

  it("解析 OpenAI Responses 的文本、思考摘要和函数调用", () => {
    expect(parseCompletionPayload("openai-responses", {
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "先确认图片内容。" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "图片连接成功" }] },
        { type: "function_call", call_id: "call_2", name: "story_index", arguments: "{\"limit\":1}" }
      ],
      usage: { input_tokens: 12, output_tokens: 8 }
    })).toEqual({
      usage: { input_tokens: 12, output_tokens: 8 },
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: "图片连接成功",
          reasoning_content: "先确认图片内容。",
          tool_calls: [{ id: "call_2", type: "function", function: { name: "story_index", arguments: "{\"limit\":1}" } }]
        }
      }]
    });
  });

  it("保留 OpenAI 多模态消息内容块", () => {
    const body = buildCompletionRequestBody({
      protocol: "openai-chat-completions",
      model: "vision-model",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "理解这张图片" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "auto" } }
        ]
      }],
      parameters: { max_tokens: 128 }
    });
    expect(body.messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "理解这张图片" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "auto" } }
      ]
    }]);
  });

  it("为 Google Vertex 使用 OpenAI 兼容端点与 Bearer 头", () => {
    expect(providerCompletionEndpoint(
      "https://aiplatform.googleapis.com/v1/projects/demo/locations/global/endpoints/openapi",
      "google-vertex"
    )).toBe("https://aiplatform.googleapis.com/v1/projects/demo/locations/global/endpoints/openapi/chat/completions");
    expect(providerModelEndpoints(
      "https://aiplatform.googleapis.com/v1/projects/demo/locations/global/endpoints/openapi",
      "google-vertex"
    )).toEqual(["https://aiplatform.googleapis.com/v1/projects/demo/locations/global/endpoints/openapi/models"]);
    expect(providerRequestHeaders("google-vertex", "ya29.access-token", "application/json")).toEqual({
      Authorization: "Bearer ya29.access-token",
      "Content-Type": "application/json",
      Accept: "application/json"
    });
    const body = buildCompletionRequestBody({
      protocol: "google-vertex",
      model: "google/gemini-2.0-flash-001",
      messages: [{ role: "user", content: "你好" }],
      parameters: { max_tokens: 32 }
    });
    expect(body).toMatchObject({
      model: "google/gemini-2.0-flash-001",
      messages: [{ role: "user", content: "你好" }],
      max_tokens: 32
    });
    const imageBody = buildCompletionRequestBody({
      protocol: "google-vertex",
      model: "google/gemini-2.0-flash-001",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "理解这张图片" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "low" } }
        ]
      }],
      parameters: { max_tokens: 32 }
    });
    expect(imageBody.messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "理解这张图片" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "low" } }
      ]
    }]);
    expect(parseCompletionPayload("google-vertex", {
      choices: [{ message: { content: "连接成功" } }]
    })).toMatchObject({
      choices: [{ message: { content: "连接成功" } }]
    });
  });
});
