import { describe, expect, it } from "vitest";
import { creatableAnalysisTaskTypeSchema } from "../../src/app.js";
import { ANALYSIS_TASK_TYPES, CREATABLE_ANALYSIS_TASK_TYPES, HISTORICAL_ANALYSIS_TASK_TYPES } from "../../src/domain.js";

describe("分析任务类型定义", () => {
  it("创建 API 校验与可新建类型常量使用相同选项", () => {
    expect(creatableAnalysisTaskTypeSchema.options).toEqual([...CREATABLE_ANALYSIS_TASK_TYPES]);
  });

  it("全量类型为可新建类型与历史类型的并集（单一来源）", () => {
    expect([...CREATABLE_ANALYSIS_TASK_TYPES, ...HISTORICAL_ANALYSIS_TASK_TYPES]).toEqual([...ANALYSIS_TASK_TYPES]);
    expect(ANALYSIS_TASK_TYPES).toContain("structure");
    expect(ANALYSIS_TASK_TYPES).toContain("report-update");
    expect(CREATABLE_ANALYSIS_TASK_TYPES).not.toContain("structure");
    expect(CREATABLE_ANALYSIS_TASK_TYPES).not.toContain("report-update");
  });
});
