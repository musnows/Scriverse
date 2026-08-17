import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 对话 Session ID 复制界面", () => {
  it("从历史记录操作菜单复制所选对话 ID", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [page, application, styles] = await Promise.all([
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(page).not.toContain('id="ai-session-id-copy"');
    expect(page).toContain('data-ai-history-action="copy-session-id"');
    expect(page).toContain("复制用于后端问题定位的对话标识");
    expect(page).toContain("feature=ai-session-id-copy-v2");
    expect(page.indexOf('data-ai-history-action="favorite"')).toBeLessThan(page.indexOf('data-ai-history-action="copy-session-id"'));
    expect(page.indexOf('data-ai-history-action="copy-session-id"')).toBeLessThan(page.indexOf('data-ai-history-action="export"'));
    expect(application).toContain("async function copyAiConversationSessionId(conversation)");
    expect(application).toContain('if (!sessionId) throw new Error("无法确定对话 Session ID");');
    expect(application).toContain("await copyAiRawMarkdown(sessionId);");
    expect(application).toContain('if (action === "copy-session-id") {');
    expect(application).toContain('toast("对话 Session ID 已复制");');
    expect(application).not.toContain("function currentAiConversationSessionId()");
    expect(styles).toContain(".ai-history-action-menu { position: fixed;");
  });
});
