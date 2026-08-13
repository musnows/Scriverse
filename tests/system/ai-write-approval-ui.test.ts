import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestRuntime } from "../helpers.js";

const publicRoot = join(process.cwd(), "src", "public");

describe("AI 操作审批中心界面", () => {
  it("页面骨架包含审批中心视图、详情对话框与设置入口", () => {
    const page = readFileSync(join(publicRoot, "index.html"), "utf8");
    expect(page).toContain('id="ai-approval-center-view"');
    expect(page).toContain('id="ai-approval-center-list"');
    expect(page).toContain('id="ai-approval-status-select"');
    expect(page).toContain('id="ai-write-plan-dialog"');
    expect(page).toContain('id="ai-write-plan-operations"');
    expect(page).toContain('id="ai-approval-center-button"');
    expect(page).toContain("AI 操作审批中心");
    for (const status of ["pending", "rejected", "expired", "invalidated", "executing", "succeeded", "failed"]) {
      expect(page).toContain(`value="${status}"`);
    }
  });

  it("前端脚本包含审批中心交互与 SSE 事件处理", () => {
    const application = readFileSync(join(publicRoot, "app.js"), "utf8");
    expect(application).toContain('eventName === "plan_created"');
    expect(application).toContain('eventName === "question_created"');
    expect(application).toContain("showAiWritePlanToast");
    expect(application).toContain("showAiQuestionToast");
    expect(application).toContain("showAiApprovalCenter");
    expect(application).toContain("openAiWritePlanDetailDialog");
    expect(application).toContain("（最推荐）");
    expect(application).toContain('name="ai-write-tool"');
    expect(application).toContain("save-ai-write-tools");
    expect(application).toContain("resumeAiConversationWithQuestionAnswer");
    // AI 可写工具的展示名称与说明已登记
    expect(application).toContain('create_story_entity: "新建词条"');
    expect(application).toContain('update_story_entity: "编辑词条"');
    expect(application).toContain('create_chapter_annotation: "创建正文批注"');
    expect(application).toContain('create_analysis_task: "创建分析任务"');
    expect(application).toContain('ask_user_question: "向用户提问"');
    // 状态与操作类型文案
    expect(application).toContain('pending: "待确认"');
    expect(application).toContain('succeeded: "执行成功"');
    expect(application).toContain('failed: "执行失败"');
    expect(application).toContain('entity_create: "新建词条"');
    expect(application).toContain('analysis_task: "分析任务"');
  });

  it("页面路由支持审批中心视图", () => {
    const route = readFileSync(join(publicRoot, "page-route.js"), "utf8");
    expect(route).toContain('view === "ai-approval-center"');
  });

  it("样式表包含审批中心与 diff 表格样式", () => {
    const styles = readFileSync(join(publicRoot, "styles.css"), "utf8");
    expect(styles).toContain(".ai-approval-center-view");
    expect(styles).toContain(".ai-approval-record");
    expect(styles).toContain(".ai-approval-operation");
    expect(styles).toContain(".ai-diff-table");
    expect(styles).toContain(".ai-question-option");
    expect(styles).toContain(".ai-question-toast");
  });

  it("审批相关接口路由已注册", async () => {
    const runtime = createTestRuntime();
    try {
      const work = await runtime.store.createWork({ title: "t", author: "a" });
      const list = await fetchList(runtime, String(work.id));
      expect(list.status).toBe(200);
    } finally {
      runtime.close();
    }
  });
});

async function fetchList(runtime: ReturnType<typeof createTestRuntime>, workId: string): Promise<{ status: number }> {
  const server = runtime.app as unknown as { address(): { port: number } | null };
  const address = server.address();
  if (!address) throw new Error("测试服务地址不可用");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/works/${workId}/ai-write-plans`);
  return { status: response.status };
}
