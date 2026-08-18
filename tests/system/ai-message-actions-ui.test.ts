import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 消息操作区", () => {
  it("区分助手回复与用户指令的复制入口并按消息归属定位", async () => {
    const [page, application, styles] = await Promise.all([
      readFile(join(process.cwd(), "src", "public", "index.html"), "utf8"),
      readFile(join(process.cwd(), "src", "public", "app.js"), "utf8"),
      readFile(join(process.cwd(), "src", "public", "styles.css"), "utf8")
    ]);

    expect(page).toContain("feature=ai-message-actions-v1");
    expect(application).toContain("function attachUserCopyAction(message, text)");
    expect(application).toContain('const hasCopyValue = Object.hasOwn(message.dataset, "rawMarkdown") || Object.hasOwn(message.dataset, "copyText");');
    expect(application).toContain('message.dataset.copyText = String(text ?? "");');
    expect(application).toContain('message.dataset.rawMarkdown ?? message.dataset.copyText ?? ""');
    expect(application).toContain('isUserMessage ? "复制用户指令" : "复制 AI 回复"');
    expect(application).toContain('if (role === "user") attachUserCopyAction(message, text);');
    expect(styles).toContain(".assistant-message .message-card-actions { right: auto; left: 0; }");
    expect(styles).toContain(".user-message .message-card-actions { right: 0; left: auto; }");
  });
});
