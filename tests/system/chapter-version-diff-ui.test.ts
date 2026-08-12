import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("章节版本差异界面", () => {
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    while (runtimes.length) await runtimes.pop()?.close();
  });

  it("提供可键盘操作的双版本选择和逐行结果区域", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "chapter-version-diff-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
    runtimes.push(runtime);

    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);

    expect(page.text).toContain('id="chapter-version-before"');
    expect(page.text).toContain('id="chapter-version-after"');
    expect(page.text).toContain('id="chapter-version-compare"');
    expect(page.text).toContain('id="chapter-version-diff"');
    expect(page.text).toContain('aria-label="逐行差异结果"');
    expect(application.text).toContain("diffChapterLines(before.content, after.content)");
    expect(application.text).toContain('value="current">当前正文</option>');
    expect(application.text).toContain('$("#chapter-version-before").focus()');
    expect(application.text).toContain('const dialog = $("#versions-dialog");');
    expect(application.text).toContain("dialog.close();");
    expect(application.text).toContain("dialog.showModal();");
    expect(application.text).toContain("button.focus();");
    expect(styles.text).toContain(".chapter-diff-row.is-added");
    expect(styles.text).toContain(".chapter-diff-row.is-deleted");
    expect(styles.text).toContain(".chapter-diff-row.is-modified");
    expect(styles.text).toContain("overflow-wrap: anywhere");
    expect(styles.text).toContain(".chapter-version-compare { grid-template-columns: minmax(0, 1fr);");
  });
});
