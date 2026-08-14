import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { formatAiMessageMeta } from "../../src/public/ai-message-meta.js";

describe("AI 回答卡片元信息", () => {
  it("在 token 数量后显示缓存命中率", () => {
    expect(formatAiMessageMeta("Agent 模型", 1234, 72.35)).toBe("Agent 模型 · 1,234 tok · 缓存命中 72.4%");
  });

  it("供应商未返回缓存统计时保持原有展示", () => {
    expect(formatAiMessageMeta("Agent 模型", 1234, undefined)).toBe("Agent 模型 · 1,234 tok");
  });

  it("按生成耗时显示不带小数的 TPS", () => {
    expect(formatAiMessageMeta("Agent 模型", 417, undefined, "", 13_800)).toBe("Agent 模型 · 417 tok · 30\u00a0tok/s");
  });

  it("将建议版本信息放在缓存命中率之后", () => {
    expect(formatAiMessageMeta("Agent 模型", 32, 50, "基于 v3")).toBe("Agent 模型 · 32 tok · 缓存命中 50% · 基于 v3");
  });
});
