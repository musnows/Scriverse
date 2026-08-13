import { describe, expect, it } from "vitest";
import {
  buildFieldDiff,
  entityBeforeSnapshot,
  resolveAiWritePlanMaxOperations,
  DEFAULT_AI_WRITE_PLAN_MAX_OPERATIONS
} from "../../src/ai-write-approvals.js";

describe("resolveAiWritePlanMaxOperations", () => {
  it("未配置时返回默认值 5", () => {
    expect(resolveAiWritePlanMaxOperations(undefined)).toBe(DEFAULT_AI_WRITE_PLAN_MAX_OPERATIONS);
    expect(resolveAiWritePlanMaxOperations("")).toBe(DEFAULT_AI_WRITE_PLAN_MAX_OPERATIONS);
  });

  it("解析 1-20 范围内的配置", () => {
    expect(resolveAiWritePlanMaxOperations("1")).toBe(1);
    expect(resolveAiWritePlanMaxOperations("20")).toBe(20);
    expect(resolveAiWritePlanMaxOperations("8")).toBe(8);
  });

  it("超出 1-20 范围或非法值回退默认值并告警", () => {
    const warnings: string[] = [];
    const warn = (message: string): void => {
      warnings.push(message);
    };
    expect(resolveAiWritePlanMaxOperations("0", warn)).toBe(DEFAULT_AI_WRITE_PLAN_MAX_OPERATIONS);
    expect(resolveAiWritePlanMaxOperations("21", warn)).toBe(DEFAULT_AI_WRITE_PLAN_MAX_OPERATIONS);
    expect(resolveAiWritePlanMaxOperations("abc", warn)).toBe(DEFAULT_AI_WRITE_PLAN_MAX_OPERATIONS);
    expect(resolveAiWritePlanMaxOperations("3.7", warn)).toBe(DEFAULT_AI_WRITE_PLAN_MAX_OPERATIONS);
    expect(warnings.length).toBe(4);
  });
});

describe("buildFieldDiff", () => {
  it("新建词条 before 为 null 时所有字段显示为新增", () => {
    const diff = buildFieldDiff("setting", null, { title: "新设定", content: "正文" });
    expect(diff).toEqual([
      { field: "title", label: "标题", before: null, after: "新设定" },
      { field: "content", label: "内容", before: null, after: "正文" }
    ]);
  });

  it("编辑词条逐字段对比 before 与 after", () => {
    const diff = buildFieldDiff("setting", { title: "旧标题", content: "旧正文", status: "draft" }, {
      title: "新标题",
      content: "旧正文"
    });
    expect(diff).toEqual([
      { field: "title", label: "标题", before: "旧标题", after: "新标题" },
      { field: "content", label: "内容", before: "旧正文", after: "旧正文" }
    ]);
  });

  it("忽略无标签的未知字段", () => {
    const diff = buildFieldDiff("character", null, { name: "张三", hacker: "注入" });
    expect(diff).toEqual([{ field: "name", label: "姓名", before: null, after: "张三" }]);
  });

  it("覆盖各实体类型字段标签", () => {
    expect(buildFieldDiff("foreshadow", null, { title: "伏笔", importance: "high" })).toEqual([
      { field: "title", label: "标题", before: null, after: "伏笔" },
      { field: "importance", label: "重要程度", before: null, after: "high" }
    ]);
    expect(buildFieldDiff("relationship", null, { category: "师徒", directed: true })).toEqual([
      { field: "category", label: "关系类型", before: null, after: "师徒" },
      { field: "directed", label: "是否单向", before: null, after: true }
    ]);
    expect(buildFieldDiff("outline", null, { goal: "目标", status: "ready" })).toEqual([
      { field: "goal", label: "本章目标", before: null, after: "目标" },
      { field: "status", label: "状态", before: null, after: "ready" }
    ]);
  });
});

describe("entityBeforeSnapshot", () => {
  it("仅挑选计划涉及字段生成修改前值快照", () => {
    const snapshot = entityBeforeSnapshot("setting", {
      id: "setting_1",
      workId: "work_1",
      title: "旧标题",
      category: "地理",
      content: "旧正文",
      tags: ["tag"],
      status: "draft",
      locked: false
    }, ["title", "content", "tags"]);
    expect(snapshot).toEqual({ title: "旧标题", content: "旧正文", tags: ["tag"] });
  });

  it("跳过无标签字段并填充缺失字段为 null", () => {
    const snapshot = entityBeforeSnapshot("character", { name: "张三" }, ["name", "aliases"]);
    expect(snapshot).toEqual({ name: "张三", aliases: null });
  });
});
