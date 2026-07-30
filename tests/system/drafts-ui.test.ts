import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app.js";

const runtime = createRuntime({
  databasePath: ":memory:",
  masterSecret: "drafts-ui-system-test-secret-at-least-32-characters",
  disableUserAuth: true,
  serveUi: true
});

afterAll(() => runtime.close());

describe("草稿模块界面", () => {
  it("提供草稿入口、两种类型和 Vditor 编辑器", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);

    expect(page.text).toContain('data-module="drafts"');
    expect(page.text).toContain(">草稿</button>");
    expect(page.text).toContain('/app.js?v=20260730-ai-error-model-availability-v1');
    expect(application.text).toContain('drafts: ["临时想法", "创作草稿"');
    expect(application.text).toContain('[["prose", "正文草稿"], ["setting", "设定草稿"]]');
    expect(application.text).toContain('field("content", "内容", "markdown"');
    expect(application.text).toContain('data-vditor-editor');
    expect(application.text).toContain("可能采用，也可能永远不会写入正文或正式设定");
    expect(application.text).toContain('value="search_drafts"');
    expect(application.text).toContain('id="draft-type-filter"');
    expect(application.text).toContain('function mountDraftFilterToggle()');
    expect(application.text).toContain('aria-label="筛选草稿" aria-controls="draft-filter-panel"');
    expect(application.text).toContain('id="draft-filter-panel" class="draft-filter-toolbar${draftFiltersPanelOpen ? "" : " hidden"}"');
    expect(application.text).toContain('>全部草稿</option>');
    expect(application.text).toContain('>正文草稿</option>');
    expect(application.text).toContain('>设定草稿</option>');
    expect(application.text).toContain('draft.draftType === draftTypeFilter');
    expect(application.text).toContain('没有符合筛选条件的草稿');
    expect(application.text).toContain('formDialogVditors = bindVditorEditors($("#dialog-fields"))');
    expect(application.text).toContain('formDialogVditors.forEach(destroyVditorEditor)');
    expect(application.text).toContain('data-dialog-draft-delete');
    expect(application.text).not.toContain('data-delete-draft');
    expect(application.text).toContain('editor: true');
    expect(application.text).toContain('dialog.classList.toggle("editor-dialog", Boolean(options.editor))');
    expect(styles.text).toContain('.draft-filter-toolbar { display: flex; align-items: center;');
    expect(styles.text).toContain('.draft-filter-toolbar select { min-width: 180px; min-height: 38px;');
    expect(styles.text).toContain('font-size: 11px; }');
    expect(styles.text).toContain('.editor-dialog { width: min(1180px, 94vw); max-height: calc(100dvh - 16px); }');
    expect(styles.text).toContain('.editor-dialog .dialog-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); max-height: 76dvh;');
    expect(styles.text).toContain('.editor-dialog .markdown-editor-field .vditor-editor-host.vditor { min-height: clamp(420px, 56dvh, 640px) !important; }');
  });
});
