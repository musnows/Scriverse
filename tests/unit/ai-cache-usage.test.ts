import { describe, expect, it } from "vitest";
import { resolveAiTokenUsage, resolveCacheHitPercent } from "../../src/ai.js";

describe("AI 输入缓存命中率", () => {
  it("解析 OpenAI 兼容格式", () => {
    expect(resolveCacheHitPercent({
      prompt_tokens: 800,
      prompt_tokens_details: { cached_tokens: 600 }
    })).toBe(75);
  });

  it("解析命中与未命中 token 格式", () => {
    expect(resolveCacheHitPercent({
      prompt_cache_hit_tokens: 200,
      prompt_cache_miss_tokens: 100
    })).toBe(66.7);
  });

  it("将 Anthropic 缓存读取和写入计入输入总量", () => {
    const usage = {
      input_tokens: 20,
      output_tokens: 6,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 10
    };
    expect(resolveCacheHitPercent(usage)).toBe(28.6);
    expect(resolveAiTokenUsage(usage, 1, 1)).toMatchObject({
      inputTokens: 35,
      outputTokens: 6,
      cachedInputTokens: 10,
      cacheEligibleInputTokens: 35,
      source: "reported"
    });
  });

  it("缺少完整缓存统计时不返回命中率", () => {
    expect(resolveCacheHitPercent({ prompt_tokens: 800 })).toBeUndefined();
    expect(resolveCacheHitPercent({ prompt_tokens_details: { cached_tokens: 600 } })).toBeUndefined();
  });

  it("解析 Vertex usageMetadata 中的服务端输入用量", () => {
    expect(resolveAiTokenUsage({
      usageMetadata: { promptTokenCount: 1_234, candidatesTokenCount: 56 }
    }, 700, 100)).toMatchObject({
      inputTokens: 1_234,
      outputTokens: 100,
      source: "mixed"
    });
  });

  it("统一解析供应商用量并标记估算来源", () => {
    expect(resolveAiTokenUsage({
      prompt_tokens: 800,
      completion_tokens: 120,
      prompt_tokens_details: { cached_tokens: 600 }
    }, 700, 100)).toEqual({
      inputTokens: 800,
      outputTokens: 120,
      cachedInputTokens: 600,
      cacheEligibleInputTokens: 800,
      source: "reported"
    });
    expect(resolveAiTokenUsage({ prompt_tokens: 800 }, 700, 100)).toMatchObject({
      inputTokens: 800,
      outputTokens: 100,
      source: "mixed"
    });
    expect(resolveAiTokenUsage(undefined, 700, 100)).toMatchObject({
      inputTokens: 700,
      outputTokens: 100,
      source: "estimated"
    });
  });
});
