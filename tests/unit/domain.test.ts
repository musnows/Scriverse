import { describe, expect, it } from "vitest";
import { analysisTaskTypeSchema } from "../../src/app.js";
import { ANALYSIS_TASK_TYPES } from "../../src/domain.js";

describe("分析任务类型定义", () => {
  it("API 校验与领域常量使用相同选项", () => {
    expect(analysisTaskTypeSchema.options).toEqual([...ANALYSIS_TASK_TYPES]);
  });
});
