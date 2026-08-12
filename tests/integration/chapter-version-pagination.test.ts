import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

function seedChapterVersions(runtime: Runtime): string {
  const work = runtime.store.createWork({ title: "章节版本分页接口测试" });
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

describe("章节版本分页 API", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = createTestRuntime();
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("返回连续三页、最后一页和空页，并保持无分页参数响应", async () => {
    const chapterId = seedChapterVersions(runtime);
    const unpaged = await request(runtime.app).get(`/api/chapters/${chapterId}/versions`).expect(200);
    const firstPage = await request(runtime.app).get(`/api/chapters/${chapterId}/versions?page=1&limit=3`).expect(200);
    const secondPage = await request(runtime.app).get(`/api/chapters/${chapterId}/versions?page=2&limit=3`).expect(200);
    const lastPage = await request(runtime.app).get(`/api/chapters/${chapterId}/versions?page=3&limit=3`).expect(200);
    const emptyPage = await request(runtime.app).get(`/api/chapters/${chapterId}/versions?page=4&limit=3`).expect(200);

    expect(unpaged.body.data.map((version: { versionNo: number }) => version.versionNo)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(firstPage.body.data).toMatchObject({ page: 1, limit: 3, hasMore: true, nextPage: 2 });
    expect(secondPage.body.data).toMatchObject({ page: 2, limit: 3, hasMore: true, nextPage: 3 });
    expect(lastPage.body.data).toMatchObject({ page: 3, limit: 3, hasMore: false, nextPage: null });
    expect(emptyPage.body.data).toEqual({ items: [], page: 4, limit: 3, hasMore: false, nextPage: null });

    const versionNumbers = [firstPage, secondPage, lastPage]
      .flatMap((response) => response.body.data.items)
      .map((version: { versionNo: number }) => version.versionNo);
    expect(versionNumbers).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(new Set(versionNumbers).size).toBe(7);
  });

  it("沿用非法页码和页大小的错误语义", async () => {
    const chapterId = seedChapterVersions(runtime);
    const invalidPage = await request(runtime.app).get(`/api/chapters/${chapterId}/versions?page=0&limit=3`).expect(400);
    const invalidLimit = await request(runtime.app).get(`/api/chapters/${chapterId}/versions?page=1&limit=101`).expect(400);

    expect(invalidPage.body.error).toEqual({ code: "INVALID_PAGINATION", message: "page 超出允许范围" });
    expect(invalidLimit.body.error).toEqual({ code: "INVALID_PAGINATION", message: "limit 超出允许范围" });
  });
});
