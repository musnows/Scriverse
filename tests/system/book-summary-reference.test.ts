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
    expect(page.text).toContain('/app.js?v=20260722-optimistic-version-lock-v2');
    expect(application.text).toContain('id="save-agent-tools"');
    expect(application.text).toContain('class="book-summary-context-percent-field"');
    expect(application.text).toContain('class="ai-agent-tools"');
    expect(application.text).toContain('const includeBookSummary = scopeType === "chapter-summary";');
    expect(application.text).toContain('scopeType === "none" ? { type: "none"');
    expect(application.text).toContain("if (includeBookSummary) scope.includeBookSummary = true;");
    expect(styles.text).not.toContain(".ai-book-summary-reference");
    expect(styles.text).toContain(".book-summary-context-percent-field input, .context-compact-threshold-field input { min-height: 40px;");
    expect(styles.text).toContain(".ai-agent-tools { display: grid; gap: 8px; }");
    expect(styles.text).toContain(".card-actions .primary-button { border-color: var(--accent);");
  });
});
