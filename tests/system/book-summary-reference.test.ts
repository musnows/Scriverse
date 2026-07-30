import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("全书概要上下文引用", () => {
  const runtimes: Runtime[] = [];

  afterEach(() => {
    while (runtimes.length) runtimes.pop()?.close();
  });

  it("默认不引用上下文并保留显式的章节与全书范围", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "book-summary-reference-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
    runtimes.push(runtime);

    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);

    expect(page.text).toContain('<select id="ai-scope" aria-label="上下文范围">\n              <option value="none">无上下文</option>');
    expect(page.text).toContain('<option value="chapter-summary">当前章节 + 全书概要</option>');
    expect(page.text).not.toContain('<option value="selection">选中文本</option>');
    expect(page.text).not.toContain('id="ai-book-summary-reference"');
    expect(page.text).toContain('/app.js?v=20260730-ai-error-model-availability-token-distribution-v1');
    expect(application.text).toContain('id="save-agent-tools"');
    expect(application.text).toContain('class="book-summary-context-percent-field"');
    expect(application.text).toContain('class="config-inline-save"');
    expect(application.text).toContain('class="ghost-button config-save-button"');
    expect(application.text).toContain('id="save-book-summary-context-percent" class="ghost-button config-save-button" type="button">保存</button>');
    expect(application.text).toContain('id="save-context-compact-threshold" class="ghost-button config-save-button" type="button">保存</button>');
    expect(application.text).toContain('id="sync-relationship-search-index"');
    expect(application.text).toContain('id="refresh-relationship-search-index"');
    expect(application.text).toContain('id="rebuild-relationship-search-index"');
    expect(application.text).toContain('增量任务队列');
    expect(application.text).toContain('ready: "已索引"');
    expect(application.text).toContain('<dt>已索引正文段落</dt>');
    expect(application.text).toContain('<dt>已索引设定来源</dt>');
    expect(application.text).toContain('class="ai-agent-tools"');
    expect(application.text).toContain('const includeBookSummary = scopeType === "chapter-summary";');
    expect(application.text).toContain('const requiresChapter = taskType === "polish" || taskType === "continue" || scopeType !== "none";');
    expect(application.text).toContain('if (!state.work) return toast("请先选择作品", "error");');
    expect(application.text).toContain('scopeType === "none" ? { type: "none"');
    expect(application.text).toContain("if (includeBookSummary) scope.includeBookSummary = true;");
    expect(application.text).toContain('body.append("expectedVersionNo", String(state.work.versionNo));');
    expect(styles.text).not.toContain(".ai-book-summary-reference");
    expect(styles.text).toContain(".book-summary-context-percent-field input, .context-compact-threshold-field input { width: 64px; min-height: 32px; padding: 5px 8px; font-size: 13px;");
    expect(styles.text).toContain(".config-inline-save { display: flex; align-items: flex-end; gap: 10px;");
    expect(styles.text).toContain('.config-inline-save .context-compact-threshold-field { display: grid; gap: 6px; width: 64px;');
    expect(styles.text).toContain(".relationship-index-summary { display: grid;");
    expect(styles.text).toContain(".config-section .config-save-button { min-height: 32px; padding: 5px 11px; font-size: 11px; }");
    expect(styles.text).toContain(".ai-agent-tools { display: grid; gap: 8px; }");
    expect(styles.text).toContain(".card-actions .primary-button { border-color: var(--accent);");
  });
});
