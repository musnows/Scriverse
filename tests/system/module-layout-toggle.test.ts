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

    expect(page.text).toContain('/styles.css?v=20260724-footer-metadata');
    expect(page.text).toContain('/app.js?v=20260724-product-footer');

    expect(layoutModule.text).toContain('export const MODULE_LAYOUTS = ["cards", "rows"]');
    expect(application.text).toContain('/module-layout.js?v=20260723-module-layout-toggle');
    expect(application.text).toContain('data-module-layout="cards"');
    expect(application.text).toContain('data-module-layout="rows"');
    expect(application.text).toContain('class="card-grid"');
    expect(application.text).toContain('class="module-row-list"');
    expect(application.text).toContain("MODULE_LAYOUT_STORAGE_KEY");
    const characterCardsStart = application.text.indexOf("const characterCards = () =>");
    const characterRowsStart = application.text.indexOf("const characterRows = () =>", characterCardsStart);
    const characterCardsSource = application.text.slice(characterCardsStart, characterRowsStart);
    expect(characterCardsSource).toContain('recordCardEditButton("edit-character", item.id');
    expect(characterCardsSource).not.toContain('<div class="card-actions">${characterActions(item)}</div>');
    expect(application.text).toContain('mountModuleLayoutToggle(layout, "设定列表样式")');
    expect(application.text).toContain('mountModuleLayoutToggle(layout, "角色列表样式")');
    expect(application.text).toContain('mountModuleLayoutToggle(layout, "种族列表样式")');
    expect(application.text).toContain('mountModuleLayoutToggle(layout, "组织列表样式")');
    expect(application.text).toContain('mountModuleLayoutToggle(layout, "伏笔列表样式")');
    expect(application.text).toContain('mountModuleLayoutToggle(layout, "审核列表样式")');
    expect(page.text).toContain('id="module-header-actions"');
    expect(application.text).toContain('$("#module-header-actions").insertAdjacentHTML');
    expect(application.text).toContain('function mountModuleLayoutToggle(layout, ariaLabel)');
    expect(application.text).toContain('id="timeline-tools" class="timeline-tools" data-module-header-action="timeline-tools"');
    expect(application.text).toContain('id="timeline-multi-select-toggle"');
    expect(application.text).toContain('function setTimelineMultiSelectMode(enabled)');
    expect(application.text).toContain('aria-label="选择 ${esc(item.name)}" hidden');
    expect(application.text).toContain('$("#module-header-actions").querySelectorAll("[data-module-layout]")');

    expect(styles.text).toContain(".card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 13px; }");
    expect(styles.text).toContain(".settings-row-list, .module-row-list { display: grid; gap: 8px; }");
    expect(styles.text).toContain(".setting-row, .module-row {");
    expect(styles.text).toContain(".settings-layout-toggle, .module-layout-toggle");
    expect(styles.text).toContain(".settings-layout-toolbar, .module-layout-toolbar { display: flex;");
    expect(styles.text).toContain(".module-header-actions { display: flex;");
    expect(styles.text).toContain("body.work-viewer-mode #timeline-multi-select-toggle");
  });
});
