import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("全书概要上下文引用", () => {
  const runtimes: Runtime[] = [];

  afterEach(() => {
    while (runtimes.length) runtimes.pop()?.close();
  });

  it("提供可切换的全书概要引用按钮并加载对应交互", async () => {
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

    expect(page.text).toContain('id="ai-book-summary-reference"');
    expect(page.text).toContain('/app.js?v=20260715-agent-tools');
    expect(application.text).toContain('id="save-agent-tools"');
    expect(application.text).toContain("function renderBookSummaryReference()");
    expect(application.text).toContain("scope.includeBookSummary = true");
    expect(styles.text).toContain(".ai-book-summary-reference.is-active");
  });
});
