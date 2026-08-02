import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const publicPath = join(process.cwd(), "src", "public");

describe("全局后台任务中心界面", () => {
  it("提供跨模块入口、状态弹窗和快捷操作", async () => {
    const [html, script, styles] = await Promise.all([
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(html).toContain('id="background-task-button"');
    expect(html).toContain('id="background-task-dialog"');
    expect(html).toContain('id="background-task-count"');
    expect(html).toContain("前往 AI 分析中心");
    expect(script).toContain("startBackgroundTaskCenter(nextWork.id)");
    expect(script).toContain("collectBackgroundTaskTransitions");
    expect(script).toContain('data-background-index-action="sync"');
    expect(script).toContain('data-background-index-action="rebuild"');
    expect(script).toContain("function backgroundProductUpdateMarkup()");
    expect(script).toContain("版本更新探测");
    expect(script).toContain("refreshProductUpdate()");
    expect(styles).toContain(".background-task-row");
    expect(styles).toContain(".background-task-count");
    expect(styles).toContain(".background-task-row > div { grid-column: 1; grid-row: 2; }");
  });
});
