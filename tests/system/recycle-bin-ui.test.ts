import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("作品与正文回收站界面", () => {
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    while (runtimes.length) await runtimes.pop()?.close();
  });

  it("提供作品、分卷和章节的恢复与彻底删除入口", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "recycle-bin-system-test-secret-32-bytes",
      disableUserAuth: true,
      serveUi: true
    });
    runtimes.push(runtime);

    const [page, application, styles] = await Promise.all([
      request(runtime.app).get("/").expect(200),
      request(runtime.app).get("/app.js").expect(200),
      request(runtime.app).get("/styles.css").expect(200)
    ]);

    expect(page.text).toContain('id="shelf-recycle-bin"');
    expect(page.text).toContain('id="work-recycle-bin-dialog"');
    expect(page.text).toContain('id="chapter-recycle-bin-dialog"');
    expect(page.text).toContain("默认保留 30 天");
    expect(application.text).toContain("async function openWorkRecycleBin()");
    expect(application.text).toContain('api("/api/recycle-bin/works")');
    expect(application.text).toContain("data-restore-deleted-work");
    expect(application.text).toContain("data-purge-deleted-work");
    expect(application.text).toContain("data-restore-deleted-volume");
    expect(application.text).toContain("data-purge-deleted-volume");
    expect(application.text).toContain("data-restore-deleted-chapter");
    expect(application.text).toContain("data-purge-deleted-chapter");
    expect(application.text).toContain('id="work-delete-button"');
    expect(application.text).toContain("async function deleteWork(work)");
    expect(application.text).toContain("body: { expectedVersionNo: work.versionNo }");
    expect(application.text).toContain("body: { expectedVersionNo: volume.versionNo }");
    expect(application.text).toContain("body: { versionNo: chapter.versionNo, expectedVersionNo: chapter.versionNo }");
    expect(application.text).toContain("dialog.close();");
    expect(application.text).toContain("dialog.showModal();");
    expect(styles.text).toContain(".shelf-header-actions");
    expect(styles.text).toContain(".recycle-bin-section-list");
    expect(styles.text).toContain(".recycle-bin-card { grid-template-columns: minmax(0, 1fr);");
    expect(page.text).toContain('/styles.css?v=20260812-outline-board-v1');
    expect(page.text).toContain('/app.js?v=20260812-outline-board-v1');
  });
});
