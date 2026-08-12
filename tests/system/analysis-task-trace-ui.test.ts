import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 分析全流程追踪界面", () => {
  it("在任务详情中按调用直接加载完整 Prompt、Agent 轮次和工具结果", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, styles] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(application).toContain("Promise.all([");
    expect(application).toContain('moduleApiPage("tasks", `/api/works/${state.work.id}/tasks`, page, pageSize, { refresh })');
    expect(application).toContain('const pageSize = pageSizeFor("analysisTasks")');
    expect(application).not.toContain('apiAllPages(`/api/works/${state.work.id}/tasks`');
    expect(application).toContain('aria-label="AI 分析任务分页"');
    expect(application).toContain('data-task-page="${taskPage.page - 1}"');
    expect(application).toContain("taskPage.stats?.pendingCount");
    expect(application).toContain("`/api/tasks/${taskId}/trace`");
    expect(application).toContain("/trace/calls/${callId}");
    expect(application).toContain('data-load-task-trace-call="full"');
    expect(application).not.toContain('data-load-task-trace-call="preview"');
    expect(application).toContain("function renderTaskTraceVisualization(trace");
    expect(application).toContain("function renderTaskTraceRound(round)");
    expect(application).not.toContain("function renderTaskTraceRoundSummary(round)");
    expect(application).toContain("function renderTaskTraceMessages(messages)");
    expect(application).toContain("function bindTaskTraceCallActions(container)");
    expect(application).toContain('error.code === "WORK_MODULE_READ_DENIED"');
    expect(application).toContain("完整上下文受权限保护");
    expect(application).toContain("完整全流程上下文");
    expect(application).toContain("本轮发出的完整 Prompt");
    expect(application).toContain("工具执行结果");
    expect(application).toContain("调用内容尚未加载");
    expect(application).toContain("加载完整内容");
    expect(application).toContain('button.textContent = "正在加载中"');
    expect(application).toContain("task-trace-call-sources");
    expect(application).not.toContain("全部消息合计最多传输");
    expect(application).toContain("options.trace");
    expect(application).toContain('api(`/api/tasks/${taskId}/detail`)');
    expect(application).toContain("function renderTaskResult(task)");
    expect(application).toContain("function renderTaskResultItem(item)");
    expect(application).toContain("function bindTaskResultActions(container)");
    expect(application).toContain('<p><strong>任务 ID</strong><br><code>${esc(task.id)}</code><br><small>创建于 ${esc(formatDateTime(task.createdAt))} · 更新于 ${esc(formatDateTime(task.updatedAt))}</small></p>');
    expect(application).toContain("<h4>结果保存位置</h4>");
    expect(application).toContain('target.location || "当前作品 · AI 分析记录"');
    expect(application).not.toContain("target.database");
    expect(application).not.toContain("target.table");
    expect(application).not.toContain("当前作品 SQLite 数据库");
    expect(application).not.toMatch(/(?:FROM|INTO|UPDATE|JOIN)\s+analysis_tasks\b/u);
    expect(application).toContain("write_analysis_tasks");
    expect(application).not.toContain("result_json");
    expect(application).toContain("完整返回 JSON");
    expect(application).toContain("不做字符截断");
    expect(application).toContain('if (item.type === "selection") return item.restricted');
    expect(application).toContain('`<li>选定内容：${esc(item.selection || "未提供")}</li>`');
    expect(application).toContain('api(`/api/tasks/${encodeURIComponent(button.dataset.loadTaskResultJson)}/result`)');
    expect(application).toContain("JSON.stringify(payload.result, null, 2)");
    expect(application).toContain('document.createElement("textarea")');
    expect(application).toContain("content.replaceChildren(resultJson)");
    expect(application).not.toContain("JSON.stringify(payload.result, null, 2).slice");
    expect(styles).toContain(".trace-dialog { width: min(1180px, 94vw);");
    expect(styles).toContain(".task-result-readable {");
    expect(styles).toContain(".task-result-storage-list {");
    expect(styles).toContain(".task-result-item {");
    expect(styles).toContain(".task-result-item > header > div { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px;");
    expect(styles).toContain(".task-result-json-loader {");
    expect(styles).toContain(".task-result-json-content textarea {");
    expect(styles).toContain(".task-result-metrics {");
    expect(styles).toContain(".task-trace-metrics {");
    expect(styles).toContain(".task-trace-round {");
    expect(styles).toContain(".task-trace-load-state {");
    expect(styles).toContain(".task-trace-call > summary .task-trace-call-sources {");
    expect(styles).toContain(".task-trace-call.is-failed .task-trace-status {");
    expect(styles).toContain("background: color-mix(in srgb, var(--accent) 14%, var(--surface));");
    expect(styles).toContain(".task-trace-message.is-system");
    expect(styles).toContain(".task-trace-tool-grid {");
  });
});
