import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("AI 对话历史弹窗", () => {
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    while (runtimes.length) await runtimes.pop()?.close();
  });

  it("将历史列表放入独立弹窗并保留会话切换交互", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "ai-history-dialog-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
    runtimes.push(runtime);

    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);

    expect(page.text).toContain('id="ai-history-toggle"');
    expect(page.text).toContain('id="ai-history-toggle" type="button" aria-label="历史记录"');
    expect(page.text).toContain('class="ai-heading-action-icon"');
    expect(page.text.indexOf('id="ai-history-toggle"')).toBeLessThan(page.text.indexOf('id="ai-new-conversation"'));
    expect(page.text).toContain('aria-controls="ai-history-dialog"');
    expect(page.text).toContain('id="ai-history-dialog" class="dialog wide-dialog ai-history-dialog"');
    expect(page.text).toContain('id="ai-history-list" class="ai-history-list"');
    expect(page.text).toContain('id="ai-history-pagination" class="module-pagination ai-history-pagination hidden"');
    expect(page.text).toContain('id="ai-history-previous"');
    expect(page.text).toContain('id="ai-history-next"');
    expect(page.text).not.toContain('id="ai-history-panel"');
    expect(application.text).toContain('$("#ai-history-dialog").open');
    expect(application.text).toContain("dialog.showModal()");
    expect(application.text).toContain('$("#ai-history-close").addEventListener');
    expect(application.text).toContain('$("#ai-history-previous").addEventListener');
    expect(application.text).toContain('$("#ai-history-next").addEventListener');
    expect(styles.text).toContain(".ai-history-dialog-body");
    expect(styles.text).toContain(".ai-heading-action-icon");
    expect(styles.text).not.toContain(".ai-history-panel");
  });
});
