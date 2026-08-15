import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { AppError } from "../../src/errors.js";
import type { PaginatedResult, Pagination } from "../../src/pagination.js";
import { createTestRuntime, createWork } from "../helpers.js";

function countReadQueries<T>(runtime: Runtime, operation: () => T): {
  result: T;
  queryCount: number;
  getSql: string[];
  allSql: string[];
} {
  const getSpy = vi.spyOn(runtime.database, "get");
  const allSpy = vi.spyOn(runtime.database, "all");
  const result = operation();
  const readResult = {
    result,
    queryCount: getSpy.mock.calls.length + allSpy.mock.calls.length,
    getSql: getSpy.mock.calls.map(([sql]) => String(sql)),
    allSql: allSpy.mock.calls.map(([sql]) => String(sql))
  };
  getSpy.mockRestore();
  allSpy.mockRestore();
  return readResult;
}

function pagination(page: number, limit: number): Pagination {
  return { page, limit, offset: (page - 1) * limit };
}

function itemIds(page: PaginatedResult<Record<string, unknown>>): string[] {
  return page.items.map((item) => String(item.id));
}

afterEach(() => vi.restoreAllMocks());

describe("伏笔列表批量映射", () => {
  it("批量读取详情并保持筛选、分页、occurrence、版本、逾期和作品边界", async () => {
    const runtime = createTestRuntime();
    try {
      runtime.store.setRelationshipIndexQueuedHandler(null);
      const workId = String((await createWork(runtime, "伏笔批量查询")).id);
      const volume = runtime.store.createVolume(workId, { title: "第一卷" });
      const chapters = Array.from({ length: 4 }, (_, index) => runtime.store.createChapter(workId, {
        volumeId: String(volume.id),
        title: `第${index + 1}章`
      }));
      const chapterIds = chapters.map((chapter) => String(chapter.id));
      const foreshadows = [
        runtime.store.createForeshadow(workId, {
          title: "高优先已埋设",
          importance: "high",
          status: "planted",
          plannedPayoffChapterId: chapterIds[1],
          occurrences: [
            { chapterId: chapterIds[2] as string, role: "reminder", note: "后出现" },
            { chapterId: chapterIds[0] as string, role: "setup", note: "先出现" }
          ]
        }),
        runtime.store.createForeshadow(workId, {
          title: "高优先已解决",
          importance: "high",
          status: "resolved",
          plannedPayoffChapterId: chapterIds[0]
        }),
        runtime.store.createForeshadow(workId, {
          title: "中优先待回收",
          importance: "medium",
          status: "planned",
          plannedPayoffChapterId: chapterIds[3]
        }),
        runtime.store.createForeshadow(workId, { title: "中优先已放弃", importance: "medium", status: "abandoned" }),
        runtime.store.createForeshadow(workId, { title: "低优先待回收", importance: "low", status: "planned" }),
        runtime.store.createForeshadow(workId, { title: "低优先已解决", importance: "low", status: "resolved" })
      ];
      for (const [index, foreshadow] of foreshadows.entries()) {
        runtime.database.run(
          "UPDATE foreshadows SET created_at = ? WHERE id = ?",
          new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
          foreshadow.id as string
        );
      }
      const firstId = String(foreshadows[0]?.id);
      runtime.store.updateForeshadow(firstId, { description: "更新后的伏笔说明" });

      const otherWorkId = String((await createWork(runtime, "其他作品")).id);
      const otherForeshadow = runtime.store.createForeshadow(otherWorkId, { title: "跨作品伏笔", status: "planned" });
      const currentChapterId = chapterIds[2] as string;
      const expected = foreshadows.map((foreshadow) => runtime.store.getForeshadow(String(foreshadow.id), currentChapterId));

      const small = countReadQueries(runtime, () => runtime.store.listForeshadowsPage(workId, pagination(1, 1), "all"));
      const large = countReadQueries(runtime, () => runtime.store.listForeshadowsPage(workId, pagination(1, 4), "all"));
      const withCurrentSmall = countReadQueries(runtime, () => runtime.store.listForeshadowsPage(
        workId,
        pagination(1, 1),
        "all",
        currentChapterId
      ));
      const withCurrentLarge = countReadQueries(runtime, () => runtime.store.listForeshadowsPage(
        workId,
        pagination(1, 4),
        "all",
        currentChapterId
      ));

      expect(small.queryCount).toBe(6);
      expect(large.queryCount).toBe(6);
      expect(withCurrentSmall.queryCount).toBe(8);
      expect(withCurrentLarge.queryCount).toBe(8);
      expect([...withCurrentLarge.getSql, ...withCurrentLarge.allSql].filter((sql) => sql.includes("entity_id = ?"))).toEqual([]);
      expect(withCurrentLarge.allSql.filter((sql) => sql.includes("fo.foreshadow_id IN ("))).toHaveLength(1);
      expect(withCurrentLarge.allSql.filter((sql) => sql.includes("c.id IN ("))).toHaveLength(1);

      const currentFirstPage = withCurrentLarge.result;
      expect(currentFirstPage).toMatchObject({ page: 1, limit: 4, hasMore: true, nextPage: 2 });
      expect(currentFirstPage.items).toEqual(expected.slice(0, 4));
      expect(currentFirstPage.items[0]).toMatchObject({
        id: firstId,
        description: "更新后的伏笔说明",
        unresolved: true,
        overdue: true,
        versionNo: 2
      });
      expect((currentFirstPage.items[0]?.occurrences as Array<Record<string, unknown>>).map((item) => item.chapterId))
        .toEqual([chapterIds[0], chapterIds[2]]);
      expect(currentFirstPage.items[1]).toMatchObject({ status: "resolved", unresolved: false, overdue: false, occurrences: [] });
      expect(small.result.items[0]).toMatchObject({ overdue: false });

      const unresolved = runtime.store.listForeshadowsPage(workId, pagination(1, 10), "unresolved", currentChapterId);
      const resolved = runtime.store.listForeshadowsPage(workId, pagination(1, 10), "resolved", currentChapterId);
      const secondPage = runtime.store.listForeshadowsPage(workId, pagination(2, 4), "all", currentChapterId);
      const empty = countReadQueries(runtime, () => runtime.store.listForeshadowsPage(workId, pagination(5, 4), "all"));
      expect(itemIds(unresolved)).toEqual([String(foreshadows[0]?.id), String(foreshadows[2]?.id), String(foreshadows[4]?.id)]);
      expect(itemIds(resolved)).toEqual([String(foreshadows[1]?.id), String(foreshadows[3]?.id), String(foreshadows[5]?.id)]);
      expect(itemIds(secondPage)).toEqual(expected.slice(4).map((item) => String(item.id)));
      expect(empty.result).toMatchObject({ items: [], page: 5, limit: 4, hasMore: false, nextPage: null });
      expect(empty.queryCount).toBe(4);
      expect(expected.some((item) => item.id === otherForeshadow.id)).toBe(false);

      try {
        runtime.store.listForeshadowsPage(workId, pagination(1, 2), "all", String(
          runtime.store.createChapter(
            otherWorkId,
            { volumeId: String(runtime.store.createVolume(otherWorkId, { title: "跨作品卷" }).id), title: "跨作品章" }
          ).id
        ));
        throw new Error("跨作品 currentChapterId 应被拒绝");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("CHAPTER_WORK_MISMATCH");
      }
    } finally {
      await runtime.close();
    }
  });
});
