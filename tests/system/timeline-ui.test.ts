import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app.js";

const runtime = createRuntime({
  databasePath: ":memory:",
  masterSecret: "timeline-ui-system-test-secret-at-least-32-characters",
  disableUserAuth: true,
  serveUi: true
});

afterAll(() => runtime.close());

describe("时间轴界面", () => {
  it("为可编辑时间事件提供经过两次确认的删除操作", async () => {
    const [page, application, styles] = await Promise.all([
      request(runtime.app).get("/").expect(200),
      request(runtime.app).get("/app.js").expect(200),
      request(runtime.app).get("/styles.css").expect(200)
    ]);

    expect(page.text).toContain('/app.js?v=20260812-global-replace-tree-v2');

    const deletionStart = application.text.indexOf("async function deleteTimelineEvent");
    const renderStart = application.text.indexOf("async function renderTimeline", deletionStart);
    expect(deletionStart).toBeGreaterThan(-1);
    expect(renderStart).toBeGreaterThan(deletionStart);
    const deletionSource = application.text.slice(deletionStart, renderStart);
    expect(deletionSource).toContain('if (!item || !canEditModule("timeline"))');
    expect(deletionSource.match(/if \(!await confirmToast/g)).toHaveLength(2);
    expect(deletionSource).toContain('title: "删除时间事件"');
    expect(deletionSource).toContain('title: "删除操作需要再次确认"');
    expect(deletionSource).toContain('confirmLabel: "继续删除"');
    expect(deletionSource).toContain('confirmLabel: "确认删除"');
    expect(deletionSource).toContain("版本历史和审计记录仍会保留");
    expect(deletionSource).toContain('/api/timeline/${encodeURIComponent(item.id)}');
    expect(deletionSource).toContain('{ method: "DELETE", body: { expectedVersionNo: item.versionNo } }');
    expect(deletionSource).toContain("await renderTimeline(page)");
    expect(deletionSource).toContain('toast(error.message, "error")');

    const renderSource = application.text.slice(renderStart, application.text.indexOf("async function renderOutlines", renderStart));
    expect(renderSource).toContain('const canEditTimeline = canEditModule("timeline")');
    expect(renderSource).toContain('canEditTimeline ? `<button class="danger-button" data-delete-timeline-event=');
    expect(renderSource).toContain('aria-label="删除时间事件 ${esc(item.name)}"');
    expect(renderSource).toContain('querySelectorAll("[data-delete-timeline-event]")');
    expect(renderSource).toContain("void deleteTimelineEvent(item, pageResult.page)");
    expect(styles.text).toContain(".card-actions .danger-button");
    expect(styles.text).toContain(".card-actions button, .task-row-actions button { flex: 1 1 auto; min-height: 38px; }");
  });
});
