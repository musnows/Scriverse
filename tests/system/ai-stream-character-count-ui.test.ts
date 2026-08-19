import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 流式回复字数显示", () => {
  it("为流式字数和单位预留固定宽度", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [page, application, styles] = await Promise.all([
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(page).toContain("&feature=ai-stream-character-count-stable-v1");
    expect(application).toContain("function createAiStreamCharacterCount(value)");
    expect(application).toContain("function renderAiStreamingCharacterProgress(meta, visibleCharacters, receivedCharacters)");
    expect(application).toContain('count.className = "ai-stream-character-count";');
    expect(application).toContain('count.textContent = Math.max(0, Number(value) || 0).toLocaleString("zh-CN");');
    expect(application).toContain("renderAiStreamingCharacterProgress(meta, progress.visibleCharacters, receivedCharacters);");
    expect(styles).toContain(".message-meta .ai-stream-character-count { display: inline-block; min-width: 6ch; font-variant-numeric: tabular-nums; text-align: right; }");
  });
});
