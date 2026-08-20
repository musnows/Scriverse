import { describe, expect, it } from "vitest";
import { estimateLiteLlmUsageCost } from "../../src/ai-model-pricing.js";

describe("LiteLLM 模型价格估算", () => {
  it("按模型 ID、缓存命中和输入输出 Token 计算价格", () => {
    const result = estimateLiteLlmUsageCost([
      { modelId: "deepseek-chat", inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 },
      { modelId: "DEEPSEEK-CHAT", inputTokens: 30, outputTokens: 10, cachedInputTokens: 0 },
      { modelId: "not-in-price-table", inputTokens: 8, outputTokens: 2, cachedInputTokens: 0 }
    ]);

    expect(result.pricedModelCount).toBe(2);
    expect(result.unpricedModelCount).toBe(1);
    expect(result.estimatedCost).toBeCloseTo(0.00003892, 10);
  });

  it("没有用量时保留零成本，有未知模型时不把未知用量当作零成本", () => {
    expect(estimateLiteLlmUsageCost([])).toEqual({
      estimatedCost: 0,
      pricedModelCount: 0,
      unpricedModelCount: 0
    });
    expect(estimateLiteLlmUsageCost([
      { modelId: "not-in-price-table", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }
    ])).toMatchObject({ estimatedCost: null, pricedModelCount: 0, unpricedModelCount: 1 });
  });
});
