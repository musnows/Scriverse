import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("全局替换界面", () => {
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    while (runtimes.length) await runtimes.pop()?.close();
  });

  it("提供正文默认范围、设定库范围和正文加设定库范围", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "global-replace-ui-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
    runtimes.push(runtime);

    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js?v=global-replace").expect(200);
    const styles = await request(runtime.app).get("/styles.css?v=global-replace").expect(200);

    expect(page.text).toContain('id="global-replace-button" class="settings-hub-card"');
    expect(page.text).toContain('id="replace-dialog" class="dialog replace-dialog"');
    expect(page.text).toContain('id="replace-find" name="find"');
    expect(page.text).toContain('id="replace-with" name="replacement"');
    expect(page.text).toContain('name="replaceScope" value="prose" checked');
    expect(page.text).toContain('name="replaceScope" value="settings"');
    expect(page.text).toContain('name="replaceScope" value="prose-and-settings"');
    expect(page.text).toContain('/app.js?v=20260816-ai-chat-switcher-v2');
    expect(application.text).toContain("function submitGlobalReplace(");
    expect(application.text).toContain("function syncGlobalReplaceScopeOptions(");
    expect(application.text).toContain('/replace`');
    expect(styles.text).toContain(".replace-dialog-body");
    expect(styles.text).toContain(".replace-scope-option:has(input:checked)");
  });
});
