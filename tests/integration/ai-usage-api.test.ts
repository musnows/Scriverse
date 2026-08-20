import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiteLlmPriceCache } from "../../src/ai-model-pricing.js";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime, createWork } from "../helpers.js";

describe("AI Token 用量统计 API", () => {
  let runtime: Runtime;

  beforeEach(async () => {
    const priceCache = new LiteLlmPriceCache({
      schedule: false,
      fetchImpl: async () => new Response(JSON.stringify({
        "deepseek-chat": {
          input_cost_per_token: 2.8e-7,
          output_cost_per_token: 4.2e-7,
          cache_read_input_token_cost: 2.8e-8
        }
      }))
    });
    expect(await priceCache.refresh()).toBe(true);
    runtime = createTestRuntime(undefined, { liteLlmPriceCache: priceCache });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await runtime.close();
  });

  it("按项目、作品和本地日期聚合 token 与缓存命中率", async () => {
    const firstWork = await createWork(runtime, "第一部作品");
    const secondWork = await createWork(runtime, "第二部作品");
    const insertCall = (
      id: string,
      workId: string,
      inputTokens: number,
      outputTokens: number,
      cachedInputTokens: number,
      cacheEligibleInputTokens: number,
      source: "reported" | "estimated",
      createdAt: string,
      modelId = "model"
    ) => runtime.database.run(
      `INSERT INTO ai_calls (
         id, work_id, task_type, provider_id, model_id, context_scope_json, status,
         input_tokens, output_tokens, cached_input_tokens, cache_eligible_input_tokens,
         cache_usage_available, token_usage_source, created_at, completed_at
       ) VALUES (?, ?, 'chat', 'provider', ?, '{}', 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      workId,
      modelId,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheEligibleInputTokens,
      cacheEligibleInputTokens > 0 ? 1 : 0,
      source,
      createdAt,
      createdAt
    );
    insertCall("call-1", String(firstWork.id), 100, 20, 40, 100, "reported", "2026-07-26T16:30:00.000Z", "deepseek-chat");
    insertCall("call-2", String(firstWork.id), 30, 10, 0, 0, "estimated", "2026-07-27T05:00:00.000Z", "deepseek-chat");
    insertCall("call-3", String(secondWork.id), 200, 50, 100, 200, "reported", "2026-07-27T08:00:00.000Z", "not-in-price-table");
    vi.stubEnv("TZ", "Asia/Shanghai");
    await request(runtime.app)
      .patch(`/api/works/${firstWork.id}/ai-settings`)
      .send({ dailyTokenQuota: 10_000 })
      .expect(200);
    expect(runtime.ai.getWorkDailyTokenQuotaStatus(String(firstWork.id), new Date("2026-07-27T05:00:00.000Z"))).toMatchObject({
      dailyTokenQuota: 10_000,
      usedTokens: 160,
      remainingTokens: 9_840,
      dayStartedAt: "2026-07-26T16:00:00.000Z",
      resetsAt: "2026-07-27T16:00:00.000Z",
      timezone: "Asia/Shanghai"
    });

    const platform = await request(runtime.app)
      .get("/api/platform/ai/usage?timezoneOffset=480")
      .expect(200);
    expect(platform.body.data.summary).toMatchObject({
      totalTokens: 410,
      inputTokens: 330,
      outputTokens: 80,
      cachedInputTokens: 140,
      directInputTokens: 190,
      cacheReadInputTokens: 140,
      cacheWriteInputTokens: 0,
      cacheEligibleInputTokens: 300,
      cacheHitRate: 46.7,
      requestCount: 3,
      estimatedRequestCount: 1,
      estimatedCost: 0.00003892,
      unpricedModelCount: 1
    });
    expect(platform.body.data.daily).toEqual([
      expect.objectContaining({ date: "2026-07-27", totalTokens: 410, requestCount: 3 })
    ]);
    expect(platform.body.data.works).toEqual([
      expect.objectContaining({ workId: secondWork.id, workTitle: "第二部作品", totalTokens: 250, cacheHitRate: 50 }),
      expect.objectContaining({ workId: firstWork.id, workTitle: "第一部作品", totalTokens: 160, cacheHitRate: 40 })
    ]);
    expect(platform.body.data.summary.estimatedCost).toBeCloseTo(0.00003892, 10);

    const work = await request(runtime.app)
      .get(`/api/works/${firstWork.id}/ai-settings/usage?timezoneOffset=480`)
      .expect(200);
    expect(work.body.data.summary).toMatchObject({
      totalTokens: 160,
      inputTokens: 130,
      directInputTokens: 90,
      cacheReadInputTokens: 40,
      cacheWriteInputTokens: 0,
      outputTokens: 30,
      cacheHitRate: 40,
      requestCount: 2,
      estimatedRequestCount: 1,
      estimatedCost: 0.00003892,
      unpricedModelCount: 0
    });
    expect(work.body.data).not.toHaveProperty("works");
    expect(work.body.data.quota).toMatchObject({
      dailyTokenQuota: 10_000,
      usedTokens: 0,
      remainingTokens: 10_000,
      reached: false,
      timezone: "Asia/Shanghai"
    });
  });

  it("拒绝越界时区偏移", async () => {
    await request(runtime.app).get("/api/platform/ai/usage?timezoneOffset=900").expect(400);
  });

  it("没有成功价格缓存时不返回可展示的估价", async () => {
    const emptyRuntime = createTestRuntime();
    try {
      const work = await createWork(emptyRuntime, "无价格缓存作品");
      emptyRuntime.database.run(
        `INSERT INTO ai_calls (
           id, work_id, task_type, provider_id, model_id, context_scope_json, status,
           input_tokens, output_tokens, created_at, completed_at
         ) VALUES (?, ?, 'chat', 'provider', 'deepseek-chat', '{}', 'completed', ?, ?, ?, ?)`,
        "call-without-price-cache",
        String(work.id),
        100,
        20,
        "2026-08-21T00:00:00.000Z",
        "2026-08-21T00:00:00.000Z"
      );
      const platform = await request(emptyRuntime.app)
        .get("/api/platform/ai/usage?timezoneOffset=480")
        .expect(200);
      expect(platform.body.data.summary).toMatchObject({
        estimatedCost: null,
        pricingAvailable: false,
        pricedModelCount: 0,
        unpricedModelCount: 1
      });
    } finally {
      await emptyRuntime.close();
    }
  });
});
