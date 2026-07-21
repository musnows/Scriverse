import { describe, expect, it } from "vitest";
import { ANALYSIS_TYPES, analysisTypeDescription } from "../../src/public/analysis-types.js";

describe("AI 分析类型说明", () => {
  it("为弹窗中的每种分析类型提供说明", () => {
    expect(ANALYSIS_TYPES).toHaveLength(9);
    expect(new Set(ANALYSIS_TYPES.map(({ value }) => value)).size).toBe(ANALYSIS_TYPES.length);
    for (const type of ANALYSIS_TYPES) {
      expect(type.label.trim()).not.toBe("");
      expect(type.desc.trim()).not.toBe("");
      expect(analysisTypeDescription(type.value)).toBe(type.desc);
    }
  });

  it("为未知类型提供可理解的兜底说明", () => {
    expect(analysisTypeDescription("unknown-analysis")).toBe("请选择一种分析类型以查看用途说明。");
  });
});
