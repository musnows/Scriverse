import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("编辑器工具栏布局", () => {
  const runtimes: Runtime[] = [];

  afterEach(() => {
    while (runtimes.length) runtimes.pop()?.close();
  });

  it("让章节路径独占首行，并统一左侧工具按钮高度", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "editor-toolbar-layout-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
    runtimes.push(runtime);

    const page = await request(runtime.app).get("/").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);

    expect(page.text).toContain('<span id="chapter-path" class="eyebrow">未选择章节</span>\n            <input id="chapter-title"');
    expect(styles.text).toContain('grid-template-areas: "path path" "title actions"');
    expect(styles.text).toContain('#chapter-path { grid-area: path;');
    expect(styles.text).toContain('.file-button, .secondary-button { display: grid; place-items: center; min-height: 24px;');
    expect(styles.text).toContain('#left-panel-toggle { flex: 0 0 24px; width: 24px; height: 24px; }');
  });
});
