import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { formatAiContextUsageTooltip } from "../../src/public/ai-context-meter.js";

describe("AI 上下文用量提示", () => {
  it("分别显示作品、对话和输出预留预算", () => {
    expect(formatAiContextUsageTooltip({
      inputTokens: 12_345,
      contextWindow: 128_000,
      contextTokens: 6_000,
      conversationTokens: 2_500,
      conversationBudgetTokens: 30_000,
      outputReserveTokens: 32_000
    })).toBe("总输入 12,345 / 128,000 tok · 作品上下文 6,000 tok · 对话历史 2,500 / 30,000 tok · 输出预留 32,000 tok");
  });
});
