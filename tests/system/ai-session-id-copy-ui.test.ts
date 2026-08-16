import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 对话 Session ID 复制界面", () => {
  it("只复制当前已建立的对话 ID，并在空白对话中禁用入口", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [page, application, styles] = await Promise.all([
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(page).toContain('id="ai-session-id-copy" type="button"');
    expect(page).toContain('aria-label="当前对话尚未创建 Session ID" aria-disabled="true"');
    expect(page).toContain("feature=ai-session-id-copy-v1");
    expect(page.indexOf('id="ai-session-id-copy"')).toBeLessThan(page.indexOf('id="ai-history-toggle"'));
    expect(application).toContain("function currentAiConversationSessionId()");
    expect(application).toContain("function syncAiConversationSessionIdCopyButton()");
    expect(application).toContain("button.disabled = !sessionId;");
    expect(application).toContain('button.setAttribute("aria-disabled", String(!sessionId));');
    expect(application).toContain("syncAiConversationSessionIdCopyButton();");
    expect(application).toContain('$("#ai-session-id-copy").addEventListener("click", async () => {');
    expect(application).toContain("await copyAiRawMarkdown(sessionId);");
    expect(application).toContain('toast("当前对话 Session ID 已复制");');
    expect(styles).toContain(".ai-heading-actions button:disabled { cursor: not-allowed; opacity: .42; }");
  });
});
