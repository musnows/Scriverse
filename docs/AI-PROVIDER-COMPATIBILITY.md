# AI 供应商兼容性与配置

本文记录叙界（Scriverse）当前已经验证的 OpenAI Chat Completions 兼容服务商、配置填写方式和已知差异。

验证日期：2026-07-23。

## 通用填写规则

在 AI 管理中分别填写供应商和模型：

- 供应商地址填写 Chat Completions 的基础地址，不要填写完整的 `/chat/completions` 路径。系统会自动追加该路径。
- API 密钥只填写密钥本身，不要带 `Bearer ` 前缀。
- 模型标识符必须填写供应商 API 接受的精确值，不要复制其他客户端附加的上下文或路由标记。
- 保存供应商后先点击“测试连接”，确认 `/models` 请求成功，再启用模型或设置任务默认模型。
- `max_tokens` 应根据模型上下文窗口设置。上下文较长或模型推理较慢时，不要把输出上限设置得过大。

## 已验证配置

| 供应商 | Chat Completions 基础地址 | 模型标识符 | 验证内容 |
| --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-v4-pro` | 普通请求、Thinking、SSE 流式、工具调用和工具结果回传 |
| DeepSeek | `https://api.deepseek.com` | `deepseek-v4-flash` | 官方模型列表可用；请求格式与 `deepseek-v4-pro` 相同 |
| SiliconFlow | `https://api.siliconflow.cn/v1` | `Qwen/Qwen3-8B` | 普通请求、Thinking、SSE 流式、工具调用和项目自身调用链 |

### DeepSeek

推荐填写：

```text
显示名称：DeepSeek
Chat Completions 基础地址：https://api.deepseek.com
模型标识符：deepseek-v4-pro
模型上下文总量：按 DeepSeek 官方模型信息填写
默认 max_tokens：建议从 8192 或更低开始
Thinking：开启
```

不要把 Claude Code 配置中的以下值直接填写到本项目：

```text
https://api.deepseek.com/anthropic
deepseek-v4-pro[1m]
```

前者是 Anthropic 协议地址，不是本项目使用的 OpenAI Chat Completions 地址；后者包含客户端上下文标记，DeepSeek OpenAI 接口只接受 `deepseek-v4-pro` 或 `deepseek-v4-flash`。

官方资料：[首次 API 调用](https://api-docs.deepseek.com/guides/reasoning_model)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[工具调用](https://api-docs.deepseek.com/guides/tool_calls/)。

### SiliconFlow

推荐填写：

```text
显示名称：硅基流动
Chat Completions 基础地址：https://api.siliconflow.cn/v1
模型标识符：Qwen/Qwen3-8B
模型上下文总量：按硅基流动模型页面填写
默认 max_tokens：建议从 8192 或更低开始
Thinking：按需要开启
```

硅基流动官方 Qwen3 参数名是 `enable_thinking`，并返回 `reasoning_content`。本项目当前对非 Gemini 供应商发送通用 `thinking` 字段；该配置已用 Qwen/Qwen3-8B 实际验证通过，包括流式输出和工具调用。

官方资料：[Chat Completions](https://docs.siliconflow.cn/en/api-reference/chat-completions/chat-completions)、[快速开始](https://docs.siliconflow.cn/en/userguide/quickstart)、[流式输出](https://docs.siliconflow.cn/cn/faqs/stream-mode)。

### Gemini OpenAI 兼容接口

Gemini 的 OpenAI 兼容地址通常为：

```text
Chat Completions 基础地址：https://generativelanguage.googleapis.com/v1beta/openai/
模型标识符：gemini-2.5-flash、gemini-3-flash-preview 等实际可用模型名
```

Gemini 不接受本项目原先通用发送的 `thinking` 字段。本项目现在会在供应商地址包含 `gemini` 或 `generativelanguage.googleapis.com`，或者模型标识符包含 `gemini` 时，自动省略该字段。Gemini 的 Thinking 参数应使用其官方支持的 `reasoning_effort` 或 Google 专用 `thinking_config`。

本项目目前只对 Gemini 的错误字段规避做了代码级验证，未使用真实 Gemini API key 完成在线联调。

官方资料：[Gemini OpenAI 兼容性](https://ai.google.dev/gemini-api/docs/openai)。

## 已知兼容性边界

本项目采用 OpenAI Chat Completions 的共同子集，并额外读取以下响应字段：

- 普通响应：`choices[0].message.content`
- Thinking 响应：`choices[0].message.reasoning_content`
- 工具调用：`choices[0].message.tool_calls`
- 流式响应：SSE 的 `data:` 数据、`delta.content`、`delta.reasoning_content` 和 `[DONE]`

不同供应商的扩展参数并不通用。当前 Gemini 会跳过 `thinking`；其他供应商仍按项目现有兼容字段发送。新增供应商时，应至少验证普通请求、流式请求、关闭 Thinking 和工具调用四条路径。

如果看到 `This operation was aborted`，优先检查基础地址、模型标识符、浏览器是否中断了 SSE，以及请求是否超过项目当前的上游超时；不要先把它判断为 OpenAI 协议不兼容。
