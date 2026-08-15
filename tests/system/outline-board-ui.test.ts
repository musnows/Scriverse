import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app.js";

const runtime = createRuntime({
  databasePath: ":memory:",
  masterSecret: "outline-board-ui-system-test-secret-at-least-32-characters",
  disableUserAuth: true,
  serveUi: true
});

afterAll(() => runtime.close());

describe("章节大纲看板界面", () => {
  it("提供分卷看板、收起筛选、详情和安全章节跳转", async () => {
    const [page, application, styles, boardLogic] = await Promise.all([
      request(runtime.app).get("/").expect(200),
      request(runtime.app).get("/app.js").expect(200),
      request(runtime.app).get("/styles.css").expect(200),
      request(runtime.app).get("/outline-board.js").expect(200)
    ]);

    expect(page.text).toContain('/styles.css?v=20260815-task-control-alignment-v1');
    expect(page.text).toContain('/app.js?v=20260815-task-control-alignment-v1');
    expect(application.text).toContain('/outline-board.js?v=20260813-outline-board-page-v1');
    expect(application.text).toContain('outlineBoardRequestPath(workId, outlineBoardFilters');
    expect(application.text).toContain('aria-label="筛选章节大纲看板"');
    expect(application.text).toContain('aria-controls="outline-board-filter-panel"');
    expect(application.text).toContain('class="character-filter-toolbar outline-board-filter-toolbar${outlineBoardFiltersPanelOpen ? "" : " hidden"}"');
    expect(application.text).toContain('id="outline-board-search" type="search"');
    expect(application.text).toContain('maxlength="200"');
    expect(application.text).toContain('id="outline-board-volume-filter"');
    expect(application.text).toContain('id="outline-board-status-filter"');
    expect(application.text).toContain('id="outline-board-foreshadow-filter"');
    expect(application.text).toContain('id="outline-board-sort"');
    expect(application.text).toContain('role="status" aria-live="polite"');
    expect(application.text).toContain('data-outline-board-card="${esc(chapter.id)}"');
    expect(application.text).toContain('role="link" tabindex="0" aria-label="打开章节 ${esc(chapter.title)}"');
    expect(application.text).toContain('data-outline-board-detail="${esc(chapter.id)}"');
    expect(application.text).toContain('看板仅展示摘要，本详情已读取完整大纲');
    expect(application.text).toContain('selectionGeneration !== chapterSelectionRequestGeneration');
    expect(application.text).toContain('String(selectedChapter?.workId ?? "") !== String(workId)');
    expect(application.text).toContain('state.module !== "outlines"');
    expect(application.text).toContain('Object.assign(outlineBoardFilters, normalizeOutlineBoardState());');
    expect(application.text).toContain('setAttribute("aria-busy", "true")');
    expect(application.text).toContain('bindModulePagination("outlinePlans"');
    expect(boardLogic.text).toContain('export function outlineBoardRequestPath');
    expect(boardLogic.text).toContain('new URLSearchParams({ page: String(safePage), limit: String(safeLimit) })');
    expect(styles.text).toContain('.outline-board-grid { display: grid;');
    expect(styles.text).toContain('.outline-board-card:focus-visible');
    expect(styles.text).toContain('.outline-board-card-summary p { display: -webkit-box;');
    expect(styles.text).toContain('.outline-board-volume-empty { display: grid;');
    expect(styles.text).toContain('@media (max-width: 560px)');
    expect(styles.text).toContain('.outline-board-card-summary, .outline-board-detail-grid { grid-template-columns: minmax(0, 1fr); }');
  });
});
