import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app.js";

const runtime = createRuntime({
  databasePath: ":memory:",
  masterSecret: "foreshadow-reminder-ui-system-test-secret",
  disableUserAuth: true,
  serveUi: true
});

afterAll(() => runtime.close());

describe("编辑器伏笔提醒界面", () => {
  it("提供不遮挡正文的逐条提示、详情和状态操作", async () => {
    const [page, application, styles, reminderModule] = await Promise.all([
      request(runtime.app).get("/").expect(200),
      request(runtime.app).get("/app.js").expect(200),
      request(runtime.app).get("/styles.css").expect(200),
      request(runtime.app).get("/foreshadow-reminder.js").expect(200)
    ]);

    expect(page.text).toContain('/styles.css?v=20260812-mobile-main-fill-v1');
    expect(page.text).toContain('/app.js?v=20260812-foreshadow-reminder-v2');
    expect(page.text).toContain('id="chapter-foreshadow-reminder" class="chapter-foreshadow-reminder hidden"');
    expect(page.text).toContain('aria-live="polite" aria-labelledby="chapter-foreshadow-reminder-title"');
    expect(page.text).toContain('id="chapter-foreshadow-reminder-previous"');
    expect(page.text).toContain('id="chapter-foreshadow-reminder-next"');
    expect(page.text).toContain('aria-controls="chapter-foreshadow-reminder-details" aria-expanded="false"');
    expect(page.text).toContain('id="chapter-foreshadow-reminder-snooze"');
    expect(page.text).toContain('id="chapter-foreshadow-reminder-resolve"');
    expect(page.text.indexOf('id="chapter-foreshadow-reminder"')).toBeLessThan(page.text.indexOf('class="editor-body"'));

    expect(application.text).toContain('/foreshadow-reminder.js?v=20260812-editor-reminder-v1');
    expect(application.text).toContain("async function loadChapterForeshadowReminders");
    expect(application.text).toContain("foreshadowReminderRequestTargetsState");
    expect(application.text).toContain("visibleForeshadowReminders");
    expect(application.text).toContain("snoozeCurrentChapterForeshadowReminder");
    expect(application.text).toContain("resolveCurrentChapterForeshadowReminder");
    expect(application.text).toContain("await loadChapterForeshadowReminders();");
    expect(application.text).toContain('error.code === "VERSION_CONFLICT" || error.status === 404');
    expect(application.text).toContain('event.key !== "Escape" || !chapterForeshadowReminderDetailsExpanded');
    expect(application.text).toContain('resolve.classList.toggle("hidden", !canEditModule("outlines"));');
    expect(application.text).toContain('/foreshadow-reminders/${encodeURIComponent(reminder.foreshadowId)}/resolve');

    expect(reminderModule.text).toContain('scriverse.foreshadow-reminder-snoozes.v1');
    expect(reminderModule.text).toContain("foreshadowReminderSnoozeKey");
    expect(reminderModule.text).toContain("versionNo");
    expect(reminderModule.text).toContain("visibleForeshadowReminders");
    expect(styles.text).toContain("grid-template-rows: auto auto minmax(0, 1fr)");
    expect(styles.text).toContain('.chapter-foreshadow-reminder[data-role="payoff"]');
    expect(styles.text).toContain('@container editor-workspace (max-width: 720px)');
    expect(styles.text).toContain('.chapter-foreshadow-reminder-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); width: 100%; }');
    expect(styles.text).toContain("overflow-wrap: anywhere");
  });
});
