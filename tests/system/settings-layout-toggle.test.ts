import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("设定库布局切换", () => {
  const runtimes: Runtime[] = [];

  afterEach(() => {
    while (runtimes.length) runtimes.pop()?.close();
  });

  it("保留卡片网格，并提供一行一条列表样式切换", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "settings-layout-toggle-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
    runtimes.push(runtime);

    const page = await request(runtime.app).get("/").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const layoutModule = await request(runtime.app).get("/settings-layout.js").expect(200);

    expect(page.text).toContain('/styles.css?v=20260723-settings-layout-toggle');
    expect(page.text).toContain('/app.js?v=20260723-settings-layout-toggle');

    expect(layoutModule.text).toContain('export const SETTINGS_LAYOUTS = ["cards", "rows"]');
    expect(application.text).toContain('/settings-layout.js?v=20260723-settings-layout-toggle');
    expect(application.text).toContain('data-settings-layout="cards"');
    expect(application.text).toContain('data-settings-layout="rows"');
    expect(application.text).toContain('class="card-grid"');
    expect(application.text).toContain('class="settings-row-list"');
    expect(application.text).toContain("SETTINGS_LAYOUT_STORAGE_KEY");

    expect(styles.text).toContain(".card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 13px; }");
    expect(styles.text).toContain(".settings-row-list { display: grid; gap: 8px; }");
    expect(styles.text).toContain(".setting-row {");
    expect(styles.text).toContain(".settings-layout-toggle");
  });
});
