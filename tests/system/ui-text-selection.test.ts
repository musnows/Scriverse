import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("界面文本选中行为", () => {
  it("默认禁用界面选中并保留正文与编辑控件的文本操作", async () => {
    const [page, styles] = await Promise.all([
      readFile(join(process.cwd(), "src", "public", "index.html"), "utf8"),
      readFile(join(process.cwd(), "src", "public", "styles.css"), "utf8")
    ]);

    expect(page).toContain('/styles.css?v=20260815-task-control-alignment-v1');
    expect(styles).toContain("body { user-select: none; }");
    expect(styles).toContain('body :is(input, textarea, select, [contenteditable="true"], .reader-content, .message-body, .record-markdown-preview, .knowledge-markdown-block, .vditor-reset, pre, code) { user-select: text; }');
  });
});
