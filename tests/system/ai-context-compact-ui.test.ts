import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 上下文压缩界面", () => {
  it("提供阈值设置、提醒操作和自动压缩前置检查", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [page, application, styles] = await Promise.all([
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(page).toContain('id="ai-context-warning"');
    expect(page).toContain('id="ai-context-compact"');
    expect(page).toContain('id="ai-context-new-conversation"');
    expect(application).toContain('id="context-compact-threshold" type="number" min="50" max="90"');
    expect(application).toContain("/context/prepare`");
    expect(application).toContain("/compact`");
    expect(application).toContain("currentMessageId: persistedUserMessage.id");
    expect(application).toContain('prepared.action === "warn"');
    expect(application).toContain('prepared.action === "compacted"');
    expect(styles).toContain(".ai-context-warning.hidden { display: none; }");
  });
});
