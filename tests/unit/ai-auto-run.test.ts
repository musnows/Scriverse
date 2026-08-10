import { describe, expect, it } from "vitest";
import { autoRunFailureDisposition } from "../../src/ai.js";
import { AppError } from "../../src/errors.js";

describe("AI 分析队列失败策略", () => {
  it("对限流和服务端错误安排有上限的退避重试", () => {
    const limited = new AppError(502, "AI_CALL_FAILED", "AI 调用失败", { failure: "HTTP 429: too many requests" });
    expect(autoRunFailureDisposition(limited, 1)).toEqual({
      retry: true,
      retryDelayMs: 5_000,
      pauseImmediately: false
    });
    expect(autoRunFailureDisposition(limited, 3)).toEqual({
      retry: false,
      retryDelayMs: 0,
      pauseImmediately: false
    });

    const invalidJson = new AppError(502, "AI_INVALID_JSON", "AI 返回内容无效");
    expect(autoRunFailureDisposition(invalidJson, 2)).toEqual({
      retry: true,
      retryDelayMs: 30_000,
      pauseImmediately: false
    });
  });

  it("对凭据、权限和认证错误立即熔断", () => {
    const unauthorized = new AppError(502, "AI_CALL_FAILED", "AI 调用失败", { failure: "HTTP 401: unauthorized" });
    expect(autoRunFailureDisposition(unauthorized, 1)).toEqual({
      retry: false,
      retryDelayMs: 0,
      pauseImmediately: true
    });

    const missingModel = new AppError(409, "MODEL_REQUIRED", "尚未配置模型");
    expect(autoRunFailureDisposition(missingModel, 1)).toEqual({
      retry: false,
      retryDelayMs: 0,
      pauseImmediately: true
    });
  });

  it("对不支持的任务类型直接失败且不重试", () => {
    const unsupported = new AppError(400, "UNSUPPORTED_TASK_TYPE", "不支持的任务类型：structure");
    expect(autoRunFailureDisposition(unsupported, 1)).toEqual({
      retry: false,
      retryDelayMs: 0,
      pauseImmediately: false
    });
  });
});
