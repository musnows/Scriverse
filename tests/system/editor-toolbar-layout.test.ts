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
    expect(page.text).not.toContain('id="import-history-button"');
    expect(page.text).toContain('id="import-history-dialog"');
    expect(page.text).toContain("大纲、伏笔、首次登场等章节关联信息不在快照中");
    expect(page.text).toContain('id="import-mode-dialog"');
    expect(page.text).toContain('id="import-mode-append"');
    expect(page.text).toContain('id="import-mode-overwrite"');
    expect(page.text).toContain('name="importMode" value="append"');
    expect(page.text).toContain('id="import-mode-confirm"');
    expect(page.text).toContain('value="confirm" type="submit" disabled>确认</button>');
    expect(page.text).toContain("把新文件解析出的卷章添加到目录末尾");
    expect(page.text).toContain("覆盖会影响章节关联资料，需要所有受影响模块均为可编辑");
    expect(styles.text).toContain(".import-mode-options");
    expect(styles.text).toContain(".import-mode-option input:checked + .import-mode-option-card");
    expect(application.text).toContain("function confirmToast(message");
    expect(application.text).toContain("当前选项：覆盖正文");
    expect(styles.text).toContain(".import-history-load-more");
    expect(application.text).toContain('$("#import-file-button").setAttribute("aria-disabled", String(proseReadOnly));');
    expect(application.text).toContain('$("#import-file-button").addEventListener("click", (event) => {');
    expect(application.text).toContain('$("#import-file").disabled = proseReadOnly;');
    expect(application.text).toContain('toast("当前权限只能编辑设定资料，不能导入正文", "error");');
    expect(styles.text).not.toContain('.prose-read-only-mode:not(.shelf-mode) .left-primary-actions .file-button');
    expect(styles.text).not.toContain('.view-only-mode:not(.shelf-mode) .left-primary-actions .file-button');
    expect(application.text).toContain('$("#import-mode-overwrite").disabled = !canOverwrite;');
    expect(application.text).toContain("function canReplaceProse(work = state.work)");
    expect(application.text).toContain("正文导入历史");
    expect(application.text).toContain('$("#form-dialog").close();');
    expect(application.text).toContain("resetWorkScopedUiCaches();");
    expect(application.text).toContain("if (state.dirty) scheduleChapterAutoSave();");
    expect(application.text).toContain('apiPage(`/api/works/${encodeURIComponent(workId)}/file-versions`, page, 25)');
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
