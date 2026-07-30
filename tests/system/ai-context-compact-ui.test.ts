import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 对话上下文 compact 界面", () => {
  it("提供独立预算 compact 阈值、整理操作和自动整理前置检查", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [page, application, styles] = await Promise.all([
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(page).toContain('id="ai-context-warning"');
    expect(page).toContain('id="ai-context-popover"');
    expect(page).toContain('id="ai-context-distribution"');
    expect(page).toContain('id="ai-context-compact"');
    expect(page).toContain('id="ai-context-new-conversation"');
    expect(page).toContain("整理长期记忆");
    expect(application).toContain('id="context-compact-threshold" type="number" min="50" max="90"');
    expect(application).toContain('<h2>对话上下文 Compact</h2>');
    expect(application).toContain('Compact 阈值（%）');
    expect(application).toContain('对话 context 使用独立预算');
    expect(application).toContain("对话历史已使用 ${percent}% 的独立预算");
    expect(application).toContain("作品正文超限不会触发此操作");
    expect(application).toContain("/context/prepare`");
    expect(application).toContain("/compact`");
    expect(application).toContain("currentMessageId: persistedUserMessage.id");
    expect(application).toContain('prepared.action === "warn"');
    expect(application).toContain('prepared.action === "compacted"');
    expect(application).toContain("normalizeAiContextTokenDistribution");
    expect(application).toContain("setAiContextDistributionVisible");
    expect(styles).toContain(".ai-context-popover.hidden { display: none; }");
    expect(styles).toContain(".ai-context-warning.hidden { display: none; }");
  });
});
