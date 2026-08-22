import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LiteLlmPriceCache,
  estimateLiteLlmUsageCost,
  nextLiteLlmPriceUpdate,
  parseModelsDevPriceTable,
  parseOpenRouterPriceTable,
  parsePublicProviderConfPriceTable,
  parseLiteLlmPriceTable
} from "../../src/ai-model-pricing.js";

const pricePayload = {
  "deepseek-chat": {
    input_cost_per_token: 2.8e-7,
    output_cost_per_token: 4.2e-7,
    cache_read_input_token_cost: 2.8e-8,
    cache_creation_input_token_cost: 5.6e-7
  },
  "not-a-model": { input_cost_per_token: "invalid", output_cost_per_token: 1 }
};

describe("LiteLLM 模型价格估算", () => {
  it("按模型 ID、直接输入、缓存读写和输入输出 Token 计算价格", () => {
    const table = parseLiteLlmPriceTable(pricePayload);
    const result = estimateLiteLlmUsageCost([
      { modelId: "deepseek-chat", inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, cacheWriteInputTokens: 5 },
      { modelId: "DEEPSEEK-CHAT", inputTokens: 30, outputTokens: 10, cachedInputTokens: 0 },
      { modelId: "not-in-price-table", inputTokens: 8, outputTokens: 2, cachedInputTokens: 0 }
    ], table);

    expect(result).toMatchObject({
      pricedModelCount: 2,
      unpricedModelCount: 1,
      pricingAvailable: true
    });
    expect(result.estimatedCost).toBeCloseTo(0.00004032, 10);
  });

  it("没有成功价格表时不返回可展示的估价", () => {
    expect(estimateLiteLlmUsageCost([])).toEqual({
      estimatedCost: 0,
      pricedModelCount: 0,
      unpricedModelCount: 0,
      pricingAvailable: false
    });
    expect(estimateLiteLlmUsageCost([
      { modelId: "not-in-price-table", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }
    ])).toMatchObject({
      estimatedCost: null,
      pricedModelCount: 0,
      unpricedModelCount: 1,
      pricingAvailable: false
    });
  });

  it("解析 OpenRouter、Models.dev 和 PublicProviderConf 的统一价格字段", () => {
    const openRouter = parseOpenRouterPriceTable({
      data: [{
        id: "xiaomi/mimo-v2.5-pro",
        pricing: {
          prompt: "0.000000435",
          completion: "0.00000087",
          input_cache_read: "0.0000000036",
          input_cache_write: "0.000000435"
        }
      }]
    });
    const modelsDev = parseModelsDevPriceTable({
      xiaomi: {
        id: "xiaomi",
        models: {
          "mimo-v2.5-pro": {
            id: "mimo-v2.5-pro",
            cost: { input: 0.435, output: 0.87, cache_read: 0.0036, cache_write: 0.435 }
          }
        }
      }
    });
    const publicProviderConf = parsePublicProviderConfPriceTable({
      providers: {
        xiaomi: {
          id: "xiaomi",
          models: [{
            id: "mimo-v2.5-pro",
            cost: { input: 0.435, output: 0.87, cache_read: 0.0036, cache_write: 0.435 }
          }]
        }
      }
    });

    expect(openRouter.get("xiaomi/mimo-v2.5-pro")).toEqual({
      input_cost_per_token: 4.35e-7,
      output_cost_per_token: 8.7e-7,
      cache_read_input_token_cost: 3.6e-9,
      cache_creation_input_token_cost: 4.35e-7
    });
    expect(modelsDev.get("xiaomi/mimo-v2.5-pro")).toEqual(openRouter.get("xiaomi/mimo-v2.5-pro"));
    expect(publicProviderConf.get("xiaomi/mimo-v2.5-pro")).toEqual(openRouter.get("xiaomi/mimo-v2.5-pro"));
  });

  it("先精确匹配，再按价格表 key 包含模型 ID 匹配前缀模型", () => {
    const table = new Map([
      ["exact-model", { input_cost_per_token: 1, output_cost_per_token: 2 }],
      ["xiaomi/mimo-v2.5-pro", { input_cost_per_token: 3, output_cost_per_token: 4 }],
      ["longcat/LongCat-2.0", { input_cost_per_token: 5, output_cost_per_token: 6 }]
    ]);
    expect(estimateLiteLlmUsageCost([
      { modelId: "EXACT-MODEL", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
      { modelId: "mimo-v2.5-pro", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
      { modelId: "LongCat-2.0", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }
    ], table)).toMatchObject({
      estimatedCost: 21,
      pricedModelCount: 3,
      unpricedModelCount: 0
    });
  });

  it("按来源优先级聚合，并允许单个来源失败后继续刷新其他来源", async () => {
    const cache = new LiteLlmPriceCache({
      schedule: false,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("openrouter.ai")) {
          return new Response(JSON.stringify({
            data: [{ id: "xiaomi/mimo-v2.5-pro", pricing: { prompt: "2", completion: "2" } }]
          }));
        }
        if (url.includes("models.dev")) return new Response("Models.dev unavailable", { status: 503 });
        if (url.includes("ThinkInAIXYZ")) {
          return new Response(JSON.stringify({
            providers: {
              xiaomi: { id: "xiaomi", models: [{ id: "mimo-v2.5-pro", cost: { input: 4, output: 4 } }] },
              public: { id: "public", models: [{ id: "public-only", cost: { input: 5, output: 5 } }] }
            }
          }));
        }
        return new Response(JSON.stringify({
          "xiaomi/mimo-v2.5-pro": { input_cost_per_token: 1, output_cost_per_token: 1 },
          "public/mimo-v2.5-pro": { input_cost_per_token: 1.5, output_cost_per_token: 1.5 }
        }));
      }
    });

    expect(await cache.refresh()).toBe(true);
    expect(cache.getPriceTable().get("xiaomi/mimo-v2.5-pro")).toEqual({
      input_cost_per_token: 1,
      output_cost_per_token: 1
    });
    expect(cache.getPriceTable().get("public/public-only")).toEqual({
      input_cost_per_token: 5e-6,
      output_cost_per_token: 5e-6
    });
    expect(cache.getSourceStatuses()).toEqual([
      expect.objectContaining({ source: "litellm", lastRefreshSucceeded: true }),
      expect.objectContaining({ source: "openrouter", lastRefreshSucceeded: true }),
      expect.objectContaining({ source: "models.dev", lastRefreshSucceeded: false }),
      expect.objectContaining({ source: "public-provider-conf", lastRefreshSucceeded: true })
    ]);
    cache.dispose();
  });

  it("成功更新才替换 JSON 缓存，失败时保留历史文件并可重启恢复", async () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-litellm-price-cache-"));
    const cachePath = join(root, "litellm-model-prices.json");
    const cache = new LiteLlmPriceCache({
      cachePath,
      schedule: false,
      fetchImpl: async () => new Response(JSON.stringify(pricePayload)),
      now: () => new Date("2026-08-21T00:00:00.000+08:00")
    });

    expect(cache.hasData()).toBe(false);
    expect(await cache.refresh()).toBe(true);
    expect(cache.hasData()).toBe(true);
    const firstFile = readFileSync(cachePath, "utf8");
    expect(JSON.parse(firstFile)).toMatchObject({
      version: 2,
      updatedAt: "2026-08-20T16:00:00.000Z"
    });
    expect(JSON.parse(firstFile).sources.litellm).toMatchObject({
      source: "litellm",
      url: expect.stringContaining("model_prices_and_context_window.json")
    });
    cache.dispose();

    const failedRefresh = new LiteLlmPriceCache({
      cachePath,
      schedule: false,
      fetchImpl: async () => new Response("upstream unavailable", { status: 503 })
    });
    expect(failedRefresh.hasData()).toBe(true);
    expect(await failedRefresh.refresh()).toBe(false);
    expect(readFileSync(cachePath, "utf8")).toBe(firstFile);
    failedRefresh.dispose();

    const restarted = new LiteLlmPriceCache({
      cachePath,
      schedule: false,
      fetchImpl: async () => new Response("network unavailable", { status: 503 })
    });
    expect(restarted.hasData()).toBe(true);
    expect(restarted.getPriceTable().get("deepseek-chat")?.output_cost_per_token).toBe(4.2e-7);
    restarted.dispose();
  });

  it("没有历史缓存且更新失败时保持不可用", async () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-litellm-price-cache-empty-"));
    const cache = new LiteLlmPriceCache({
      cachePath: join(root, "litellm-model-prices.json"),
      schedule: false,
      fetchImpl: async () => new Response("not json")
    });

    expect(await cache.refresh()).toBe(false);
    expect(cache.hasData()).toBe(false);
    cache.dispose();
  });

  it("把下一次更新安排在服务器本地时间的下一个零点", () => {
    const current = new Date(2026, 7, 21, 23, 45, 0, 0);
    const next = nextLiteLlmPriceUpdate(current);
    expect(next.getHours()).toBe(0);
    expect(next.getDate()).toBe(22);
    expect(next.getTime() - current.getTime()).toBe(15 * 60 * 1_000);
  });
});
