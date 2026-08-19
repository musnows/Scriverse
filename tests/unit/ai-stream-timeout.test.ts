import { describe, expect, it } from "vitest";
import {
  AI_STREAM_IDLE_TIMEOUT_SECONDS_ENV,
  DEFAULT_AI_STREAM_IDLE_TIMEOUT_SECONDS,
  MAX_AI_STREAM_IDLE_TIMEOUT_SECONDS,
  MIN_AI_STREAM_IDLE_TIMEOUT_SECONDS,
  normalizeAiStreamIdleTimeoutSeconds,
  resolveAiStreamIdleTimeoutMs,
  resolveAiStreamIdleTimeoutSeconds
} from "../../src/ai-stream-timeout.js";

describe("AI 流事件空闲超时配置", () => {
  it("默认使用 90 秒并提供毫秒运行时值", () => {
    expect(resolveAiStreamIdleTimeoutSeconds({})).toBe(DEFAULT_AI_STREAM_IDLE_TIMEOUT_SECONDS);
    expect(resolveAiStreamIdleTimeoutMs({})).toBe(90_000);
  });

  it("接受 30 秒和 120 秒边界值", () => {
    expect(resolveAiStreamIdleTimeoutSeconds({ [AI_STREAM_IDLE_TIMEOUT_SECONDS_ENV]: "30" }))
      .toBe(MIN_AI_STREAM_IDLE_TIMEOUT_SECONDS);
    expect(resolveAiStreamIdleTimeoutSeconds({ [AI_STREAM_IDLE_TIMEOUT_SECONDS_ENV]: " 120 " }))
      .toBe(MAX_AI_STREAM_IDLE_TIMEOUT_SECONDS);
  });

  it("把有效整数钳制在 30 至 120 秒", () => {
    expect(resolveAiStreamIdleTimeoutSeconds({ [AI_STREAM_IDLE_TIMEOUT_SECONDS_ENV]: "0" }))
      .toBe(MIN_AI_STREAM_IDLE_TIMEOUT_SECONDS);
    expect(resolveAiStreamIdleTimeoutSeconds({ [AI_STREAM_IDLE_TIMEOUT_SECONDS_ENV]: "29" }))
      .toBe(MIN_AI_STREAM_IDLE_TIMEOUT_SECONDS);
    expect(resolveAiStreamIdleTimeoutSeconds({ [AI_STREAM_IDLE_TIMEOUT_SECONDS_ENV]: "121" }))
      .toBe(MAX_AI_STREAM_IDLE_TIMEOUT_SECONDS);
    expect(resolveAiStreamIdleTimeoutSeconds({ [AI_STREAM_IDLE_TIMEOUT_SECONDS_ENV]: "999999" }))
      .toBe(MAX_AI_STREAM_IDLE_TIMEOUT_SECONDS);
  });

  it.each(["", "-1", "1.5", "NaN", "Infinity", "9007199254740992"])(
    "非法值 %s 回退为默认值",
    (value) => {
      expect(resolveAiStreamIdleTimeoutSeconds({ [AI_STREAM_IDLE_TIMEOUT_SECONDS_ENV]: value }))
        .toBe(DEFAULT_AI_STREAM_IDLE_TIMEOUT_SECONDS);
    }
  );

  it("规范化平台设置的秒数", () => {
    expect(normalizeAiStreamIdleTimeoutSeconds(29)).toBe(MIN_AI_STREAM_IDLE_TIMEOUT_SECONDS);
    expect(normalizeAiStreamIdleTimeoutSeconds(90)).toBe(90);
    expect(normalizeAiStreamIdleTimeoutSeconds(121)).toBe(MAX_AI_STREAM_IDLE_TIMEOUT_SECONDS);
    expect(normalizeAiStreamIdleTimeoutSeconds(Number.NaN)).toBe(DEFAULT_AI_STREAM_IDLE_TIMEOUT_SECONDS);
  });
});
