import { describe, expect, it } from "vitest";
import {
  buildCompletionRequestBody,
  parseCompletionPayload,
  providerCompletionEndpoint,
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
    expect(parseCompletionPayload("google-vertex", {
      choices: [{ message: { content: "连接成功" } }]
    })).toMatchObject({
      choices: [{ message: { content: "连接成功" } }]
    });
  });
});
