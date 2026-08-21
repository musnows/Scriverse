import { describe, expect, it } from "vitest";
import {
  AI_BACKOFF_RETRY_COUNT_ENV,
  AI_RETRY_BASE_DELAY_MS,
  AI_RETRY_COUNT_ENV,
  AI_RETRY_MAX_DELAY_MS,
  DEFAULT_AI_BACKOFF_RETRY_COUNT,
  DEFAULT_AI_RETRY_COUNT,
  MAX_AI_RETRY_COUNT,
  MIN_AI_RETRY_COUNT,
  aiHttpRetryCount,
  aiHttpRetryDelayMs,
  resolveAiRetryPolicy
} from "../../src/ai-retry.js";

describe("AI HTTP 重试策略", () => {
  it("默认普通错误重试 3 次，429 和 502 重试 10 次", () => {
    const policy = resolveAiRetryPolicy({});
    expect(policy).toEqual({
      retryCount: DEFAULT_AI_RETRY_COUNT,
      backoffRetryCount: DEFAULT_AI_BACKOFF_RETRY_COUNT
    });
    expect(aiHttpRetryCount(402, policy)).toBe(3);
    expect(aiHttpRetryCount(429, policy)).toBe(10);
    expect(aiHttpRetryCount(502, policy)).toBe(10);
  });

  it("403 和 404 始终不重试，其他 HTTP 错误使用普通重试配置", () => {
    const policy = { retryCount: 4, backoffRetryCount: 12 };
    expect(aiHttpRetryCount(403, policy)).toBe(0);
    expect(aiHttpRetryCount(404, policy)).toBe(0);
    expect(aiHttpRetryCount(400, policy)).toBe(4);
    expect(aiHttpRetryCount(401, policy)).toBe(4);
    expect(aiHttpRetryCount(500, policy)).toBe(4);
    expect(aiHttpRetryCount(503, policy)).toBe(4);
  });

  it("读取环境配置并把重试次数限制在安全边界内", () => {
    expect(resolveAiRetryPolicy({
      [AI_RETRY_COUNT_ENV]: " 5 ",
      [AI_BACKOFF_RETRY_COUNT_ENV]: "8"
    })).toEqual({ retryCount: 5, backoffRetryCount: 8 });
    expect(resolveAiRetryPolicy({
      [AI_RETRY_COUNT_ENV]: "0",
      [AI_BACKOFF_RETRY_COUNT_ENV]: "99"
    })).toEqual({ retryCount: MIN_AI_RETRY_COUNT, backoffRetryCount: MAX_AI_RETRY_COUNT });
  });

  it.each(["", "-1", "1.5", "NaN", "Infinity", "9007199254740992"])(
    "非法配置 %s 回退到默认值",
    (value) => {
      expect(resolveAiRetryPolicy({
        [AI_RETRY_COUNT_ENV]: value,
        [AI_BACKOFF_RETRY_COUNT_ENV]: value
      })).toEqual({
        retryCount: DEFAULT_AI_RETRY_COUNT,
        backoffRetryCount: DEFAULT_AI_BACKOFF_RETRY_COUNT
      });
    }
  );

  it("普通错误线性等待，429 和 502 指数退避并封顶", () => {
    expect(aiHttpRetryDelayMs(402, 1)).toBe(AI_RETRY_BASE_DELAY_MS);
    expect(aiHttpRetryDelayMs(402, 3)).toBe(1_500);
    expect(aiHttpRetryDelayMs(429, 1)).toBe(AI_RETRY_BASE_DELAY_MS);
    expect(aiHttpRetryDelayMs(429, 4)).toBe(4_000);
    expect(aiHttpRetryDelayMs(502, 5)).toBe(AI_RETRY_MAX_DELAY_MS);
    expect(aiHttpRetryDelayMs(502, 20)).toBe(AI_RETRY_MAX_DELAY_MS);
  });

  it("429 和 502 遵循秒数格式 Retry-After，并限制最长等待", () => {
    expect(aiHttpRetryDelayMs(429, 1, "2")).toBe(2_000);
    expect(aiHttpRetryDelayMs(502, 1, "0.1")).toBe(AI_RETRY_BASE_DELAY_MS);
    expect(aiHttpRetryDelayMs(429, 1, "60")).toBe(AI_RETRY_MAX_DELAY_MS);
    expect(aiHttpRetryDelayMs(429, 2, "invalid")).toBe(1_000);
  });
});
