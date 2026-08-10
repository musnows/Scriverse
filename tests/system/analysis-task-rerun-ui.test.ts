import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 分析任务重跑界面", () => {
  it("仅在终态任务详情中提供直接重试和换模型重试入口", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, styles] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(application).toContain("function canRerunAnalysisTask(task)");
    expect(application).toContain('"review", "completed", "partial", "failed", "expired", "cancelled"');
    expect(application).not.toContain('data-rerun-task="${esc(item.id)}"');
    expect(application).toContain('data-rerun-task-detail="${esc(task.id)}"');
    expect(application).toContain('data-rerun-task-model="${esc(task.id)}"');
    expect(application).toContain("按原配置重新执行");
    expect(application).toContain("换模型重试");
    expect(application).toContain("async function rerunAnalysisTask(taskId, button");
    expect(application).toContain("async function rerunAnalysisTaskWithModel(task, button)");
    expect(application).toContain("/rerun`, { method: \"POST\", body: {} }");
    expect(application).toContain("body: { modelId }");
    expect(application).toContain("当前没有其他可用模型，请先配置并测试模型");
    expect(application).toContain("已按原配置创建新任务");
    expect(application).toContain("新任务会重新读取当前正文、设定和人物资料，旧任务记录保持不变。");
    expect(styles).toContain(".task-detail-actions {");
    expect(styles).toContain(".task-rerun-model-intro {");
  });
});
