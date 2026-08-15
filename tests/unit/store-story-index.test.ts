import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("story_index 目录读取", () => {
  let runtime: Runtime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it("只读取当前页目录字段和当前页摘要，不加载长篇正文", () => {
    runtime = createTestRuntime();
    const work = runtime.store.createWork({ title: "长篇目录", author: "测试作者" });
    const firstVolume = runtime.store.createVolume(String(work.id), { title: "第一卷" });
    const secondVolume = runtime.store.createVolume(String(work.id), { title: "第二卷" });
    const hugeContent = "正文内容".repeat(100_000);
    const chapters = [
      runtime.store.createChapter(String(work.id), { volumeId: String(firstVolume.id), title: "第一章", content: hugeContent }),
      runtime.store.createChapter(String(work.id), { volumeId: String(firstVolume.id), title: "第二章", content: hugeContent }),
      runtime.store.createChapter(String(work.id), { volumeId: String(secondVolume.id), title: "第三章", content: hugeContent }),
      runtime.store.createChapter(String(work.id), { volumeId: String(secondVolume.id), title: "第四章", content: hugeContent })
    ];
    const timestamp = new Date().toISOString();
    for (const [index, chapter] of chapters.entries()) {
      runtime.database.run(
        `INSERT INTO chapter_insights (
           id, chapter_id, chapter_version, summary, events_json, characters_json,
           settings_json, evidence_json, uncertainties_json, status, created_at
         ) VALUES (?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', 'review', ?)`,
        `story-index-insight-${index}`,
        String(chapter.id),
        Number(chapter.versionNo),
        `第 ${index + 1} 章摘要`,
        timestamp
      );
    }
    const allSpy = vi.spyOn(runtime.database, "all");

    const page = runtime.store.getStoryIndexChapterPage(String(work.id), 1, 2);

    expect(page).toEqual({
      totalChapters: 4,
      chapters: [
        { id: chapters[1]?.id, volumeTitle: "第一卷", title: "第二章", versionNo: 1, summary: "第 2 章摘要" },
        { id: chapters[2]?.id, volumeTitle: "第二卷", title: "第三章", versionNo: 1, summary: "第 3 章摘要" }
      ]
    });
    expect(JSON.stringify(page)).not.toContain("正文内容");

    const chapterPageCall = allSpy.mock.calls.find(([sql]) => String(sql).includes("SELECT chapter.id, chapter.title"));
    expect(chapterPageCall).toBeDefined();
    expect(String(chapterPageCall?.[0])).not.toMatch(/chapter\.content|SELECT\s+\*/iu);
    expect(chapterPageCall?.slice(1)).toEqual([work.id, 2, 1]);

    const insightCall = allSpy.mock.calls.find(([sql]) => String(sql).includes("SELECT insight.chapter_id, insight.summary"));
    expect(insightCall?.slice(1)).toEqual([work.id, chapters[1]?.id, chapters[2]?.id]);
    expect(insightCall?.slice(1)).not.toContain(chapters[0]?.id);
    expect(insightCall?.slice(1)).not.toContain(chapters[3]?.id);
  });

  it("供 AI 查询时排除作者的话章节并保持分页总数一致", () => {
    runtime = createTestRuntime();
    const work = runtime.store.createWork({ title: "作者的话目录", author: "测试作者" });
    const volume = runtime.store.createVolume(String(work.id), { title: "第一卷" });
    runtime.store.createChapter(String(work.id), {
      volumeId: String(volume.id),
      title: "作者的话",
      chapterType: "作者的话",
      content: "作者注释不应提供给 AI。"
    });
    const chapter = runtime.store.createChapter(String(work.id), {
      volumeId: String(volume.id),
      title: "第一章",
      content: "正文目录项。"
    });

    const page = runtime.store.getStoryIndexChapterPage(String(work.id), 0, 20, { excludeAuthorNotes: true });

    expect(page.totalChapters).toBe(1);
    expect(page.chapters).toEqual([
      expect.objectContaining({ id: chapter.id, title: "第一章" })
    ]);
    expect(JSON.stringify(page)).not.toContain("作者的话");
  });
});
