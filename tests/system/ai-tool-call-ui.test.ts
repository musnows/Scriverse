import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 工具调用记录界面", () => {
  it("提供默认折叠摘要和参数返回值详情弹窗", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [page, application, styles] = await Promise.all([
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(page).toContain('id="ai-tool-call-dialog"');
    expect(page).toContain('id="ai-tool-call-arguments"');
    expect(page).toContain('id="ai-tool-call-result"');
    expect(application).toContain('eventName === "tool_call"');
    expect(application).toContain('`调用了 ${name} 工具`');
    expect(application).toContain("renderAiToolCalls(message, metadata?.toolCalls)");
    expect(styles).toContain(".ai-tool-call-summary::after { content: \"查看详情\";");
  });
});
