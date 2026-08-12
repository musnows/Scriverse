import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

function seedChapterVersions(runtime: Runtime): string {
  const work = runtime.store.createWork({ title: "章节版本分页单元测试" });
  const workId = String(work.id);
  const volume = runtime.store.createVolume(workId, { title: "正文" });
  const chapter = runtime.store.createChapter(workId, {
    volumeId: String(volume.id),
    title: "第一章",
    content: "第 1 版正文"
  });
  const chapterId = String(chapter.id);
  for (let versionNo = 2; versionNo <= 7; versionNo += 1) {
    runtime.store.saveChapter(chapterId, { content: `第 ${versionNo} 版正文` });
  }
  return chapterId;
}

describe("章节版本存储分页", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = createTestRuntime();
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("跨三页稳定返回全部版本且不重复或遗漏", () => {
    const chapterId = seedChapterVersions(runtime);
    const firstPage = runtime.store.listChapterVersionsPage(chapterId, { page: 1, limit: 3, offset: 0 });
    const secondPage = runtime.store.listChapterVersionsPage(chapterId, { page: 2, limit: 3, offset: 3 });
    const lastPage = runtime.store.listChapterVersionsPage(chapterId, { page: 3, limit: 3, offset: 6 });
    const emptyPage = runtime.store.listChapterVersionsPage(chapterId, { page: 4, limit: 3, offset: 9 });

    expect(firstPage).toMatchObject({ page: 1, limit: 3, hasMore: true, nextPage: 2 });
    expect(secondPage).toMatchObject({ page: 2, limit: 3, hasMore: true, nextPage: 3 });
    expect(lastPage).toMatchObject({ page: 3, limit: 3, hasMore: false, nextPage: null });
    expect(emptyPage).toEqual({ items: [], page: 4, limit: 3, hasMore: false, nextPage: null });

    expect(firstPage.items.map((version) => version.versionNo)).toEqual([7, 6, 5]);
    expect(secondPage.items.map((version) => version.versionNo)).toEqual([4, 3, 2]);
    expect(lastPage.items.map((version) => version.versionNo)).toEqual([1]);

    const versionNumbers = [...firstPage.items, ...secondPage.items, ...lastPage.items]
      .map((version) => Number(version.versionNo));
    const storedTotal = Number(runtime.database.get(
      "SELECT COUNT(*) AS total FROM chapter_versions WHERE chapter_id = ?",
      chapterId
    )?.total);
    expect(versionNumbers).toHaveLength(storedTotal);
    expect(new Set(versionNumbers).size).toBe(storedTotal);
  });
});
