import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("知识模块布局切换", () => {
  const runtimes: Runtime[] = [];

  afterEach(() => {
    while (runtimes.length) runtimes.pop()?.close();
  });

  it("设定、角色、种族、组织、伏笔与审核保留卡片并支持列表切换", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "module-layout-toggle-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
    runtimes.push(runtime);

    const page = await request(runtime.app).get("/").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const layoutModule = await request(runtime.app).get("/module-layout.js").expect(200);

    expect(page.text).toContain('/styles.css?v=20260723-character-code');
    expect(page.text).toContain('/app.js?v=20260723-character-code');

    expect(layoutModule.text).toContain('export const MODULE_LAYOUTS = ["cards", "rows"]');
    expect(application.text).toContain('/module-layout.js?v=20260723-module-layout-toggle');
    expect(application.text).toContain('data-module-layout="cards"');
    expect(application.text).toContain('data-module-layout="rows"');
    expect(application.text).toContain('class="card-grid"');
    expect(application.text).toContain('class="module-row-list"');
    expect(application.text).toContain("MODULE_LAYOUT_STORAGE_KEY");
    expect(application.text).toContain('renderModuleLayoutToggle(layout, "角色列表样式")');
    expect(application.text).toContain('renderModuleLayoutToggle(layout, "种族列表样式")');
    expect(application.text).toContain('renderModuleLayoutToggle(layout, "组织列表样式")');
    expect(application.text).toContain('renderModuleLayoutToggle(layout, "伏笔列表样式")');
    expect(application.text).toContain('renderModuleLayoutToggle(layout, "审核列表样式")');

    expect(styles.text).toContain(".card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 13px; }");
    expect(styles.text).toContain(".settings-row-list, .module-row-list { display: grid; gap: 8px; }");
    expect(styles.text).toContain(".setting-row, .module-row {");
    expect(styles.text).toContain(".settings-layout-toggle, .module-layout-toggle");
  });
});
