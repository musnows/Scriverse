import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("全书概要上下文引用", () => {
  const runtimes: Runtime[] = [];

  afterEach(() => {
    while (runtimes.length) runtimes.pop()?.close();
  });

  it("将全书概要作为当前章节的上下文范围选项", async () => {
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

    expect(page.text).toContain('<option value="chapter-summary">当前章节 + 全书概要</option>');
    expect(page.text).not.toContain('id="ai-book-summary-reference"');
    expect(page.text).toContain('/app.js?v=20260716-ai-mention-chips');
    expect(application.text).toContain('id="save-agent-tools"');
    expect(application.text).toContain('const includeBookSummary = scopeType === "chapter-summary";');
    expect(application.text).toContain("if (includeBookSummary) scope.includeBookSummary = true;");
    expect(styles.text).not.toContain(".ai-book-summary-reference");
  });
});
