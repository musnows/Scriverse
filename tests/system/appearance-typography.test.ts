import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("显示设置字号选项", () => {
  it("提供独立的界面、正文和 Agent 对话字号", async () => {
    const [page, application, styles] = await Promise.all([
      readFile(join(process.cwd(), "src", "public", "index.html"), "utf8"),
      readFile(join(process.cwd(), "src", "public", "app.js"), "utf8"),
      readFile(join(process.cwd(), "src", "public", "styles.css"), "utf8")
    ]);

    expect(page).toContain('id="appearance-ui-font-size" name="uiFontSize"');
    expect(page).toContain('id="appearance-font-size" name="fontSize"');
    expect(page).toContain('id="appearance-ai-font-size" name="aiFontSize"');
    expect(page).toContain("界面 14 px · Agent 对话 14 px");
    expect(application).toContain("uiFontSize: 14, aiFontSize: 14");
    expect(application).toContain('root.style.setProperty("--ai-font-size", `${normalized.aiFontSize}px`);');
    expect(application).toContain('form.get("aiFontSize")');
    expect(styles).toContain("body { font-size: var(--ui-font-size); }");
    expect(styles).toContain(":is(.module-nav button, .ghost-button.ghost-button, .primary-button.primary-button) { font-size: calc(12px * var(--ui-font-scale)); }");
    expect(styles).toContain(".settings-hub-card strong { font-size: calc(16px * var(--ui-font-scale)); }");
    expect(styles).not.toContain("font-size: calc(1em * var(--ui-font-scale));");
    expect(styles).toContain(".assistant-message, .user-message { font-size: var(--ai-font-size); }");
    expect(styles).toContain(".ai-tool-call-dialog { font-size: var(--ai-font-size); }");
  });
});
