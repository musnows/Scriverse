import type { AiMessage } from "./domain.js";
import { normalizeBaseUrl } from "./utils.js";

export const AI_PROVIDER_PROTOCOLS = ["openai-chat-completions", "anthropic-messages"] as const;
export type AiProviderProtocol = (typeof AI_PROVIDER_PROTOCOLS)[number];

export type CompletionToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: unknown;
  };
};

type AnthropicReplayContentBlock = Record<string, unknown>;

export type CompletionMessage = AiMessage | {
  role: "assistant";
  content: string | null;
  reasoning_content?: string | null;
  tool_calls: CompletionToolCall[];
  anthropic_content?: AnthropicReplayContentBlock[];
} | {
  role: "tool";
  tool_call_id: string;
  content: string;
};

export type CompletionPayload = {
  usage?: Record<string, unknown>;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: CompletionToolCall[];
      anthropic_content?: AnthropicReplayContentBlock[];
    };
  }>;
};

export function normalizeProviderBaseUrl(value: string): string {
  return normalizeBaseUrl(value).replace(/\/messages$/u, "");
}

function appendVersionedResource(baseUrl: string, resource: string): string {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  return /\/v1$/u.test(normalized) ? `${normalized}/${resource}` : `${normalized}/v1/${resource}`;
}

export function providerCompletionEndpoint(baseUrl: string, protocol: AiProviderProtocol): string {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  return protocol === "anthropic-messages"
    ? appendVersionedResource(normalized, "messages")
    : `${normalized}/chat/completions`;
}

export function providerModelEndpoints(baseUrl: string, protocol: AiProviderProtocol): string[] {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  if (protocol === "openai-chat-completions") return [`${normalized}/models`];
  const primary = appendVersionedResource(normalized, "models");
  const root = new URL("/v1/models", normalized).toString();
  return primary === root ? [primary] : [primary, root];
}

export function providerRequestHeaders(
  protocol: AiProviderProtocol,
  apiKey: string,
  accept: "application/json" | "text/event-stream"
): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    ...(protocol === "anthropic-messages" ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : {}),
    "Content-Type": "application/json",
    Accept: accept
  };
}

function textContent(value: string | null | undefined): Array<Record<string, unknown>> {
  return typeof value === "string" && value.length > 0 ? [{ type: "text", text: value }] : [];
}

function parsedToolInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function anthropicAssistantContent(message: Extract<CompletionMessage, { role: "assistant" }>): Array<Record<string, unknown>> {
  if (Array.isArray(message.anthropic_content) && message.anthropic_content.length > 0) {
    return structuredClone(message.anthropic_content);
  }
  return [
    ...textContent(message.content),
    ...message.tool_calls.map((toolCall) => ({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function.name,
      input: parsedToolInput(toolCall.function.arguments)
    }))
  ];
}

function anthropicToolResult(message: Extract<CompletionMessage, { role: "tool" }>): Record<string, unknown> {
  let isError = false;
  try {
    const result = JSON.parse(message.content) as Record<string, unknown>;
    isError = result.ok === false;
  } catch {
    isError = false;
  }
  return {
    type: "tool_result",
    tool_use_id: message.tool_call_id,
    content: message.content,
    ...(isError ? { is_error: true } : {})
  };
}

function anthropicMessages(messages: CompletionMessage[]): {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }>;
} {
  const system = messages
    .filter((message): message is AiMessage & { role: "system" } => message.role === "system")
    .map((message) => message.content)
    .filter(Boolean)
    .join("\n\n");
  const output: Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }> = [];
  const append = (role: "user" | "assistant", content: Array<Record<string, unknown>>): void => {
    if (content.length === 0) return;
    const previous = output.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else output.push({ role, content });
  };
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      append("user", [anthropicToolResult(message)]);
      continue;
    }
    if (message.role === "assistant" && "tool_calls" in message) {
      append("assistant", anthropicAssistantContent(message));
      continue;
    }
    append(message.role, textContent(message.content));
  }
  return { ...(system ? { system } : {}), messages: output };
}

function anthropicTools(tools: Record<string, unknown>[]): Record<string, unknown>[] {
  return tools.flatMap((tool) => {
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function)
      ? tool.function as Record<string, unknown>
      : null;
    if (!fn || typeof fn.name !== "string") return [];
    return [{
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      input_schema: fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
        ? fn.parameters
        : { type: "object", properties: {} }
    }];
  });
}

export function buildCompletionRequestBody(input: {
  protocol: AiProviderProtocol;
  model: string;
  messages: CompletionMessage[];
  parameters: Record<string, unknown>;
  tools?: Record<string, unknown>[];
  toolChoice?: "auto" | "none";
  stream?: boolean;
}): Record<string, unknown> {
  const tools = input.toolChoice === "auto" ? input.tools ?? [] : [];
  if (input.protocol === "openai-chat-completions") {
    return {
      model: input.model,
      messages: input.messages.map((message) => {
        if (message.role !== "assistant" || !("anthropic_content" in message)) return message;
        const { anthropic_content: _anthropicContent, ...openAiMessage } = message;
        return openAiMessage;
      }),
      ...input.parameters,
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      ...(input.stream ? { stream: true, stream_options: { include_usage: true } } : {})
    };
  }
  const translated = anthropicMessages(input.messages);
  const parameters = Object.fromEntries(Object.entries(input.parameters)
    .filter(([key]) => ["temperature", "top_p", "max_tokens", "thinking"].includes(key)));
  return {
    model: input.model,
    ...translated,
    ...parameters,
    ...(tools.length > 0 ? { tools: anthropicTools(tools), tool_choice: { type: "auto" } } : {}),
    ...(input.stream ? { stream: true } : {})
  };
}

function replayableAnthropicBlock(value: unknown): AnthropicReplayContentBlock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const block = value as Record<string, unknown>;
  if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
  if (block.type === "thinking" && typeof block.thinking === "string" && typeof block.signature === "string") {
    return { type: "thinking", thinking: block.thinking, signature: block.signature };
  }
  if (block.type === "redacted_thinking" && typeof block.data === "string") {
    return { type: "redacted_thinking", data: block.data };
  }
  if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
    return { type: "tool_use", id: block.id, name: block.name, input: parsedToolInput(block.input) };
  }
  return null;
}

function anthropicFinishReason(value: unknown): string | null {
  if (value === "max_tokens") return "length";
  return typeof value === "string" ? value : null;
}

export function parseCompletionPayload(protocol: AiProviderProtocol, value: unknown): CompletionPayload {
  if (protocol === "openai-chat-completions") {
    return value && typeof value === "object" && !Array.isArray(value) ? value as CompletionPayload : {};
  }
  const response = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const content = Array.isArray(response.content) ? response.content : [];
  const replay = content.map(replayableAnthropicBlock).filter((block): block is AnthropicReplayContentBlock => block !== null);
  const text = content.flatMap((value) => {
    const block = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("");
  const reasoning = content.flatMap((value) => {
    const block = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    if (block.type === "thinking" && typeof block.thinking === "string") return [block.thinking];
    if (block.type === "text" && typeof block.thinking === "string") return [block.thinking];
    return [];
  }).join("");
  const toolCalls: CompletionToolCall[] = content.flatMap((value) => {
    const block = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    if (block.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") return [];
    return [{
      id: block.id,
      type: "function" as const,
      function: {
        name: block.name,
        arguments: parsedToolInput(block.input)
      }
    }];
  });
  return {
    ...(response.usage && typeof response.usage === "object" && !Array.isArray(response.usage)
      ? { usage: response.usage as Record<string, unknown> }
      : {}),
    choices: [{
      finish_reason: anthropicFinishReason(response.stop_reason),
      message: {
        content: text || null,
        reasoning_content: reasoning || null,
        tool_calls: toolCalls,
        anthropic_content: replay
      }
    }]
  };
}
