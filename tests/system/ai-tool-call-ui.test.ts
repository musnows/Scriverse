import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 工具调用记录界面", () => {
  it("生成时展开思考与工具步骤并在最终答案出现后折叠", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [page, application, styles] = await Promise.all([
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(page).toContain('id="ai-tool-call-dialog"');
    expect(page).toContain('id="ai-tool-call-name"');
    expect(page).toContain('id="ai-tool-call-time"');
    expect(page).toContain('id="ai-tool-call-description"');
    expect(page).toContain('id="ai-tool-call-arguments"');
    expect(page).toContain('id="ai-tool-call-result"');
    expect(application).toContain('eventName === "tool_call"');
    expect(application).toContain('eventName === "process_step"');
    expect(application).toContain('`调用了 ${name} 工具`');
    expect(application).toContain("function renderAiProcessSteps(message, steps, completed, durationMs = null)");
    expect(application).toContain("function formatAiProcessDuration(value)");
    expect(application).toContain("function resolveAiProcessDuration(metadata, steps, completedAt)");
    expect(application).toContain('` · 耗时 ${duration}`');
    expect(application).toContain("toolCalls, processSteps, processDurationMs");
    expect(application).toContain("details.open = !completed");
    expect(application).toContain("if (firstFinalDelta && processSteps.length) renderAiProcessSteps(message, processSteps, true, elapsedProcessTime())");
    expect(application).toContain('title.textContent = completed ? "思考与执行过程" : "正在思考与执行"');
    expect(application).toContain("function scrollAiFeedToBottom()");
    expect(application).toContain("window.requestAnimationFrame(() =>");
    expect(application.match(/scrollAiFeedToBottom\(\);/gu)?.length).toBeGreaterThanOrEqual(7);
    expect(application).toContain('return "历史记录未保存"');
    expect(application).toContain('new Intl.DateTimeFormat("zh-CN"');
    expect(styles).toContain(".ai-tool-call-summary::after { content: \"查看详情\";");
    expect(styles).toContain(".ai-process-details > summary");
    expect(styles).toContain(".ai-process-step-body");
    expect(styles).toContain(".ai-tool-call-detail { display: grid; grid-template-columns: minmax(0, 1fr);");
    expect(styles).toContain(".ai-tool-call-info { display: grid;");
  });
});
