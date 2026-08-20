import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  LiteLlmPriceCache,
  estimateLiteLlmUsageCost,
  nextLiteLlmPriceUpdate,
  parseLiteLlmPriceTable
} from "../../src/ai-model-pricing.js";

const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots.splice(0)) execFileSync("rmtrash", ["-rf", root]);
});

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

  it("成功更新才替换 JSON 缓存，失败时保留历史文件并可重启恢复", async () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-litellm-price-cache-"));
    temporaryRoots.push(root);
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
      version: 1,
      source: expect.stringContaining("model_prices_and_context_window.json"),
      updatedAt: "2026-08-20T16:00:00.000Z"
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
    temporaryRoots.push(root);
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
