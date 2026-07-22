import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("编辑器工具栏布局", () => {
  const runtimes: Runtime[] = [];

  afterEach(() => {
    while (runtimes.length) runtimes.pop()?.close();
  });

  it("让章节路径独占首行，并统一侧栏工具按钮尺寸", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "editor-toolbar-layout-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
    runtimes.push(runtime);

    const page = await request(runtime.app).get("/").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);

    expect(page.text).toContain('<span id="chapter-path" class="eyebrow">未选择章节</span>\n            <input id="chapter-title"');
    expect(styles.text).toContain('grid-template-areas: "path path" "title actions"');
    expect(styles.text).toContain('#chapter-path { grid-area: path;');
    expect(styles.text).toContain('.file-button, .secondary-button { display: grid; place-items: center; min-height: 30px;');
    expect(page.text).toContain('<label id="import-file-button" class="file-button" aria-label="导入 TXT / DOCX">');
    expect(page.text).toContain('<span class="import-file-label import-file-label-full" aria-hidden="true">导入 TXT / DOCX</span>');
    expect(page.text).toContain('<span class="import-file-label import-file-label-compact" aria-hidden="true">导入TXT/DOCX</span>');
    expect(page.text).toContain('<span class="import-file-label import-file-label-short" aria-hidden="true">导入</span>');
    expect(page.text).toContain('id="import-history-button"');
    expect(page.text).toContain('id="import-history-dialog"');
    expect(page.text).toContain("每条记录都保存了该次导入开始前的正文");
    expect(page.text).toContain('id="import-mode-dialog"');
    expect(page.text).toContain('id="import-mode-append"');
    expect(page.text).toContain('id="import-mode-overwrite"');
    expect(page.text).toContain("把新文件解析出的卷章添加到目录末尾");
    expect(styles.text).toContain(".import-mode-options");
    expect(styles.text).toContain(".import-history-button { grid-column: 1 / -1; }");
    expect(application.text).toContain('$("#import-file-button").classList.toggle("permission-hidden", proseReadOnly);');
    expect(application.text).toContain('$("#import-file").disabled = proseReadOnly;');
    expect(styles.text).toContain('@container (max-width: 120px)');
    expect(styles.text).toContain('@container (max-width: 88px)');
    expect(styles.text).toContain('@container editor-workspace (max-width: 720px)');
    expect(styles.text).toContain('.editor-toolbar { grid-template-areas: "path" "title" "actions";');
    expect(styles.text).toContain('.chapter-title { min-height: 36px; }');
    expect(styles.text).toContain('.chapter-stats { display: none; }');
    expect(styles.text).toContain('#left-panel-toggle { flex: 0 0 30px; width: 30px; height: 30px; }');
    expect(styles.text).toContain('.ai-heading #ai-panel-toggle { flex-basis: 30px; width: 30px; height: 30px; }');
  });
});
