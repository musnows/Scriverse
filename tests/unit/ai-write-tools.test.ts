import { describe, expect, it } from "vitest";
import {
  applyEntryChanges,
  buildEntryFieldDiffs,
  resolveAiWritePlanLimits,
  writeToolSwitchKey,
  type AiWriteEntityType
} from "../../src/ai-write-tools.js";

describe("resolveAiWritePlanLimits", () => {
  it("使用默认限制", () => {
    expect(resolveAiWritePlanLimits({})).toEqual({
      maxOperations: 5,
      planTtlMs: 24 * 3_600_000,
      questionTtlMs: 30 * 60_000
    });
  });

  it("解析合法配置", () => {
    expect(resolveAiWritePlanLimits({ AI_WRITE_PLAN_MAX_OPERATIONS: "12" }).maxOperations).toBe(12);
    expect(resolveAiWritePlanLimits({ AI_WRITE_PLAN_TTL_HOURS: "6" }).planTtlMs).toBe(6 * 3_600_000);
    expect(resolveAiWritePlanLimits({ AI_TOOL_QUESTION_TTL_MINUTES: "5" }).questionTtlMs).toBe(5 * 60_000);
  });

  it("超过 20 的操作数配置被拒绝并回退默认值", () => {
    expect(resolveAiWritePlanLimits({ AI_WRITE_PLAN_MAX_OPERATIONS: "21" }).maxOperations).toBe(5);
    expect(resolveAiWritePlanLimits({ AI_WRITE_PLAN_MAX_OPERATIONS: "100" }).maxOperations).toBe(5);
    expect(resolveAiWritePlanLimits({ AI_WRITE_PLAN_MAX_OPERATIONS: "0" }).maxOperations).toBe(5);
    expect(resolveAiWritePlanLimits({ AI_WRITE_PLAN_MAX_OPERATIONS: "-3" }).maxOperations).toBe(5);
    expect(resolveAiWritePlanLimits({ AI_WRITE_PLAN_MAX_OPERATIONS: "abc" }).maxOperations).toBe(5);
    expect(resolveAiWritePlanLimits({ AI_WRITE_PLAN_MAX_OPERATIONS: "7.5" }).maxOperations).toBe(5);
  });

  it("边界值 1 与 20 被接受", () => {
    expect(resolveAiWritePlanLimits({ AI_WRITE_PLAN_MAX_OPERATIONS: "1" }).maxOperations).toBe(1);
    expect(resolveAiWritePlanLimits({ AI_WRITE_PLAN_MAX_OPERATIONS: "20" }).maxOperations).toBe(20);
  });
});

describe("writeToolSwitchKey", () => {
  it("映射操作模块到开关键", () => {
    expect(writeToolSwitchKey("settings")).toBe("settings");
    expect(writeToolSwitchKey("characters")).toBe("characters");
    expect(writeToolSwitchKey("outlines")).toBe("outlines");
    expect(writeToolSwitchKey("prose")).toBe("prose-annotations");
    expect(writeToolSwitchKey("ai-analysis")).toBe("analysis-tasks");
  });
});

describe("applyEntryChanges", () => {
  it("仅保留实体字段并整体替换对象字段", () => {
    const current = {
      id: "setting-1",
      workId: "work-1",
      title: "旧标题",
      category: "地理",
      content: "旧内容",
      versionNo: 3,
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const next = applyEntryChanges("setting", current, { title: "新标题", ignored: true });
    expect(next).toEqual({ title: "新标题", category: "地理", content: "旧内容" });
  });

  it("跳过 undefined 修改但保留 null", () => {
    const current = { name: "角色", code: "c1", aliases: ["a"], attributes: { hp: 10 } } as Record<string, unknown>;
    const next = applyEntryChanges("character", current, { name: undefined, code: null, attributes: { mp: 5 } });
    expect(next.name).toBe("角色");
    expect(next.code).toBeNull();
    expect(next.attributes).toEqual({ mp: 5 });
  });
});

describe("buildEntryFieldDiffs", () => {
  it("生成字段级差异并跳过未变化字段", () => {
    const entityType: AiWriteEntityType = "setting";
    const diffs = buildEntryFieldDiffs(entityType, { title: "旧", content: "不变" }, { title: "新", content: "不变" });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toEqual({ field: "title", label: "标题", before: "旧", after: "新" });
  });

  it("新建词条时所有字段标记为新增", () => {
    const entityType: AiWriteEntityType = "foreshadow";
    const diffs = buildEntryFieldDiffs(entityType, null, { title: "伏笔", description: "说明" });
    expect(diffs.map((diff) => diff.before)).toEqual([null, null]);
    expect(new Set(diffs.map((diff) => diff.label))).toEqual(new Set(["标题", "描述"]));
  });
});
