import { describe, expect, it } from "vitest";
import {
  aiApprovalOperationChangesHtml,
  aiApprovalOperationHtml,
  aiApprovalStatusLabel,
  aiApprovalStatusOptions,
  aiApprovalStatusTone,
  aiWriteOperationLabel
} from "../../src/public/ai-approvals.js";

describe("AI 操作审批中心前端纯函数", () => {
  it("状态标签与色调完整覆盖全部审批状态", () => {
    for (const status of ["pending", "rejected", "expired", "invalidated", "executing", "succeeded", "failed"]) {
      expect(aiApprovalStatusLabel(status)).toBeTruthy();
      expect(aiApprovalStatusTone(status)).toBeTruthy();
    }
    expect(aiApprovalStatusLabel("pending")).toBe("待确认");
    expect(aiApprovalStatusLabel("succeeded")).toBe("执行成功");
  });

  it("操作类型标签覆盖全部可写操作", () => {
    for (const operationType of [
      "create_setting", "update_setting", "create_character", "update_character",
      "create_race", "update_race", "create_organization", "update_organization",
      "create_timeline_event", "update_timeline_event", "create_relationship", "update_relationship",
      "create_outline", "update_outline", "create_foreshadow", "update_foreshadow",
      "create_chapter_annotation", "create_analysis_task"
    ]) {
      expect(aiWriteOperationLabel(operationType)).toBeTruthy();
      expect(aiWriteOperationLabel(operationType)).not.toBe(operationType);
    }
  });

  it("编辑操作 diff 表格展示字段、修改前值与修改后值", () => {
    const html = aiApprovalOperationChangesHtml({
      operationType: "update_character",
      changes: [
        { field: "aliases", label: "别名", before: ["旧别名"], after: ["新别名"] },
        { field: "isDead", label: "已死亡", before: false, after: true }
      ]
    });
    expect(html).toContain("修改前");
    expect(html).toContain("修改后");
    expect(html).toContain("别名");
    expect(html).toContain("旧别名");
    expect(html).toContain("新别名");
    expect(html).toContain("已死亡");
  });

  it("新建操作明确标记为新增且不显示修改前值", () => {
    const html = aiApprovalOperationChangesHtml({
      operationType: "create_setting",
      changes: [
        { field: "title", label: "标题", before: null, after: "南港" }
      ]
    });
    expect(html).toContain("新增");
    expect(html).toContain("南港");
  });

  it("正文批注 diff 展示批注类型、行号与引用正文", () => {
    const html = aiApprovalOperationHtml({
      operationType: "create_chapter_annotation",
      moduleLabel: "正文",
      aiSummary: "批注第二行",
      targetId: "chapter-1",
      targetLabel: "章节“第一章”",
      targetVersionNo: 3,
      referencedText: "第二行。",
      changes: [
        { field: "kind", label: "批注类型", before: null, after: "待办" },
        { field: "lines", label: "行号", before: null, after: "第 2 行" }
      ]
    }, 0);
    expect(html).toContain("创建正文批注");
    expect(html).toContain("待办");
    expect(html).toContain("第 2 行");
    expect(html).toContain("第二行。");
  });

  it("分析任务 diff 展示任务类型与模型范围", () => {
    const html = aiApprovalOperationHtml({
      operationType: "create_analysis_task",
      moduleLabel: "AI 分析",
      aiSummary: "分析第一章",
      targetId: null,
      targetLabel: "分析任务（章节分析）",
      targetVersionNo: null,
      changes: [
        { field: "taskType", label: "任务类型", before: null, after: "章节分析" },
        { field: "scope", label: "分析范围", before: null, after: "指定章节；全书概要" }
      ]
    }, 0);
    expect(html).toContain("创建分析任务");
    expect(html).toContain("章节分析");
    expect(html).toContain("指定章节；全书概要");
  });

  it("状态筛选选项包含全部状态与全部选项", () => {
    const options = aiApprovalStatusOptions("pending");
    expect(options).toContain("全部状态");
    expect(options).toContain("待确认");
    expect(options).toContain("已失效");
    expect(options).toContain('value="pending" selected');
  });

  it("HTML 渲染对用户内容做转义，防止注入", () => {
    const html = aiApprovalOperationHtml({
      operationType: "update_setting",
      moduleLabel: "设定库",
      aiSummary: "<script>alert(1)</script>",
      targetId: "x",
      targetLabel: '<img src="x" onerror="alert(2)">',
      targetVersionNo: 1,
      changes: [
        { field: "content", label: "内容", before: "<b>旧</b>", after: "<script>alert(3)</script>" }
      ]
    }, 0);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain('<img src="x"');
    expect(html).not.toContain("<script>alert(3)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
