import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { runWithRequestActor } from "../../src/request-context.js";
import {
  emptyWorkModulePermissions,
  fullWorkModulePermissions,
  type WorkModulePermissions
} from "../../src/work-permissions.js";
import { createTestRuntime } from "../helpers.js";

type WorkSummary = {
  id: string;
  coverUrl: string | null;
  accessRole: string | null;
  modulePermissions: WorkModulePermissions;
  chapterCount: number;
  wordCount: number;
  updatedAt: string;
};

const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2z94AAAAASUVORK5CYII=",
  "base64"
);

function seedChapters(runtime: Runtime, workId: string, contents: string[]): Record<string, unknown>[] {
  if (contents.length === 0) return [];
  const volume = runtime.store.createVolume(workId, { title: "正文" });
  return contents.map((content, index) => runtime.store.createChapter(workId, {
    volumeId: String(volume.id),
    title: `第${index + 1}章`,
    content
  }));
}

function summaryById(items: WorkSummary[], workId: string): WorkSummary {
  const summary = items.find((item) => item.id === workId);
  expect(summary).toBeDefined();
  return summary as WorkSummary;
}

function perWorkGetQueries(calls: Array<[string, ...unknown[]]>): string[] {
  return calls
    .map(([sql]) => sql)
    .filter((sql) => [
      "FROM work_memberships WHERE work_id = ?",
      "FROM chapters WHERE work_id = ?",
      "FROM work_covers WHERE work_id = ?"
    ].some((fragment) => sql.includes(fragment)));
}

afterEach(() => vi.restoreAllMocks());

describe("作品列表批量映射", () => {
  it("批量组装多作品统计和封面，并保持全量与分页语义", async () => {
    const runtime = createTestRuntime();
    try {
      runtime.store.setRelationshipIndexQueuedHandler(null);
      const fallbackWork = runtime.store.createWork({
        title: "回退封面作品",
        coverUrl: "https://static.example.test/fallback.png"
      });
      const uploadedCoverWork = runtime.store.createWork({ title: "上传封面作品" });
      const emptyWork = runtime.store.createWork({ title: "空作品" });
      const fallbackWorkId = String(fallbackWork.id);
      const uploadedCoverWorkId = String(uploadedCoverWork.id);
      const emptyWorkId = String(emptyWork.id);
      const fallbackChapters = seedChapters(runtime, fallbackWorkId, ["第一段正文。", "第二段更长的正文内容。"]);
      const uploadedCoverChapters = seedChapters(runtime, uploadedCoverWorkId, ["唯一章节正文。"]);
      runtime.store.setWorkCover(uploadedCoverWorkId, "image/png", validPng);

      const orderedUpdates: Array<[string, string]> = [
        [fallbackWorkId, "2026-01-01T00:00:01.000Z"],
        [uploadedCoverWorkId, "2026-01-01T00:00:02.000Z"],
        [emptyWorkId, "2026-01-01T00:00:03.000Z"]
      ];
      for (const [workId, updatedAt] of orderedUpdates) {
        runtime.database.run("UPDATE works SET updated_at = ? WHERE id = ?", updatedAt, workId);
      }
      await request(runtime.app).get("/api/works").expect(200);
      await new Promise<void>((resolve) => setImmediate(resolve));

      const getSpy = vi.spyOn(runtime.database, "get");
      const allSpy = vi.spyOn(runtime.database, "all");
      const response = await request(runtime.app).get("/api/works").expect(200);
      const summaries = response.body.data as WorkSummary[];

      expect(summaries.map((item) => item.id)).toEqual([emptyWorkId, uploadedCoverWorkId, fallbackWorkId]);
      expect(summaryById(summaries, fallbackWorkId)).toMatchObject({
        coverUrl: "https://static.example.test/fallback.png",
        chapterCount: 2,
        wordCount: fallbackChapters.reduce((total, chapter) => total + Number(chapter.wordCount), 0)
      });
      expect(summaryById(summaries, uploadedCoverWorkId)).toMatchObject({
        chapterCount: 1,
        wordCount: Number(uploadedCoverChapters[0]?.wordCount)
      });
      expect(summaryById(summaries, uploadedCoverWorkId).coverUrl)
        .toContain(`/api/works/${uploadedCoverWorkId}/cover?v=`);
      expect(summaryById(summaries, emptyWorkId)).toMatchObject({
        coverUrl: null,
        chapterCount: 0,
        wordCount: 0
      });
      expect(perWorkGetQueries(getSpy.mock.calls)).toEqual([]);
      expect(allSpy.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes("work_id IN ("))).toHaveLength(2);

      getSpy.mockClear();
      allSpy.mockClear();
      const firstPage = await request(runtime.app).get("/api/works?limit=2&page=1").expect(200);
      const secondPage = await request(runtime.app).get("/api/works?limit=2&page=2").expect(200);
      expect(firstPage.body.data).toMatchObject({ page: 1, limit: 2, hasMore: true, nextPage: 2 });
      expect(secondPage.body.data).toMatchObject({ page: 2, limit: 2, hasMore: false, nextPage: null });
      expect((firstPage.body.data.items as WorkSummary[]).map((item) => item.id))
        .toEqual(summaries.slice(0, 2).map((item) => item.id));
      expect((secondPage.body.data.items as WorkSummary[]).map((item) => item.id))
        .toEqual(summaries.slice(2).map((item) => item.id));
      expect(perWorkGetQueries(getSpy.mock.calls)).toEqual([]);
      expect(allSpy.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes("work_id IN ("))).toHaveLength(4);
    } finally {
      runtime.close();
    }
  });

  it("批量组装成员权限，并按正文权限隐藏章节统计", () => {
    const runtime = createTestRuntime();
    try {
      runtime.store.setRelationshipIndexQueuedHandler(null);
      const owner = runtime.auth.register({ username: "batch_owner", password: "secure-password-123" }).session.user;
      const member = runtime.auth.register({ username: "batch_member", password: "secure-password-123" }).session.user;
      const seeded = runWithRequestActor(owner, () => {
        const editorWork = runtime.store.createWork({ title: "编辑成员作品" });
        const customWork = runtime.store.createWork({ title: "自定义权限作品" });
        const hiddenWork = runtime.store.createWork({ title: "不可见作品" });
        const editorChapters = seedChapters(runtime, String(editorWork.id), ["编辑成员可见正文。"]);
        seedChapters(runtime, String(customWork.id), ["自定义成员不可见正文。"]);
        return { editorWork, customWork, hiddenWork, editorChapters };
      });
      const editorWorkId = String(seeded.editorWork.id);
      const customWorkId = String(seeded.customWork.id);
      const hiddenWorkId = String(seeded.hiddenWork.id);
      const hiddenProsePermissions = emptyWorkModulePermissions();
      hiddenProsePermissions.settings = "read";
      runtime.auth.addMember(editorWorkId, member.userId, { role: "editor" }, owner.userId);
      runtime.auth.addMember(customWorkId, member.userId, { permissions: hiddenProsePermissions }, owner.userId);
      runtime.database.run("UPDATE works SET updated_at = ? WHERE id = ?", "2026-01-01T00:00:01.000Z", editorWorkId);
      runtime.database.run("UPDATE works SET updated_at = ? WHERE id = ?", "2026-01-01T00:00:02.000Z", customWorkId);
      runtime.database.run("UPDATE works SET updated_at = ? WHERE id = ?", "2026-01-01T00:00:03.000Z", hiddenWorkId);

      const getSpy = vi.spyOn(runtime.database, "get");
      const allSpy = vi.spyOn(runtime.database, "all");
      const summaries = runWithRequestActor({ ...member, authentication: "session" }, () => runtime.store.listWorks()) as WorkSummary[];

      expect(summaries.map((item) => item.id)).toEqual([customWorkId, editorWorkId]);
      expect(summaryById(summaries, editorWorkId)).toMatchObject({
        accessRole: "editor",
        modulePermissions: fullWorkModulePermissions(),
        chapterCount: 1,
        wordCount: Number(seeded.editorChapters[0]?.wordCount)
      });
      expect(summaryById(summaries, customWorkId)).toMatchObject({
        accessRole: "custom",
        modulePermissions: hiddenProsePermissions,
        chapterCount: 0,
        wordCount: 0
      });
      expect(perWorkGetQueries(getSpy.mock.calls)).toEqual([]);
      expect(allSpy.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes("work_id IN ("))).toHaveLength(3);
    } finally {
      runtime.close();
    }
  });
});
