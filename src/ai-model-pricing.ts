import liteLlmModelPrices from "./litellm-model-prices.json" with { type: "json" };

// 价格快照来自 LiteLLM model_prices_and_context_window.json，固定在 007bd43cfb6e。
// 来源：https://raw.githubusercontent.com/BerriAI/litellm/007bd43cfb6eeeabe94d6aa77bd05dd3aa6aa1bf/model_prices_and_context_window.json

export type ModelTokenUsage = {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

type LiteLlmModelPrice = {
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_token_cost?: number;
  input_cost_per_token_cache_hit?: number;
};

type TokenUsagePricing = {
  estimatedCost: number | null;
  pricedModelCount: number;
  unpricedModelCount: number;
};

const modelPriceMap = new Map(
  Object.entries(liteLlmModelPrices as Record<string, LiteLlmModelPrice>)
    .map(([modelId, price]) => [modelId.trim().toLowerCase(), price] as const)
);

function finiteNonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function modelPrice(modelId: string): LiteLlmModelPrice | null {
  const normalizedModelId = modelId.trim().toLowerCase();
  return normalizedModelId ? modelPriceMap.get(normalizedModelId) ?? null : null;
}

function cachedInputTokenPrice(price: LiteLlmModelPrice): number {
  const cachePrice = price.cache_read_input_token_cost ?? price.input_cost_per_token_cache_hit;
  return Number.isFinite(cachePrice) ? Math.max(0, Number(cachePrice)) : price.input_cost_per_token;
}

export function estimateLiteLlmUsageCost(modelUsages: readonly ModelTokenUsage[]): TokenUsagePricing {
  let estimatedCost = 0;
  let pricedModelCount = 0;
  let unpricedModelCount = 0;

  for (const usage of modelUsages) {
    const price = modelPrice(usage.modelId);
    if (!price) {
      unpricedModelCount += 1;
      continue;
    }
    pricedModelCount += 1;
    const inputTokens = finiteNonNegative(usage.inputTokens);
    const outputTokens = finiteNonNegative(usage.outputTokens);
    const cachedInputTokens = Math.min(inputTokens, finiteNonNegative(usage.cachedInputTokens));
    estimatedCost += (inputTokens - cachedInputTokens) * price.input_cost_per_token;
    estimatedCost += cachedInputTokens * cachedInputTokenPrice(price);
    estimatedCost += outputTokens * price.output_cost_per_token;
  }

  return {
    estimatedCost: pricedModelCount > 0 || modelUsages.length === 0 ? estimatedCost : null,
    pricedModelCount,
    unpricedModelCount
  };
}
