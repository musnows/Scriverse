import { afterEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime, createWork } from "../helpers.js";

describe("章节段落关键字索引", () => {
  let runtime: Runtime | undefined;

  afterEach(() => runtime?.close());

  it("按作品返回完整段落并默认限制前二十条", async () => {
    runtime = createTestRuntime();
    const work = await createWork(runtime, "索引作品");
    const volume = runtime.store.createVolume(String(work.id), { title: "第一卷" });
    const content = Array.from({ length: 25 }, (_, index) => `第${index + 1}段发现秘密线索。\n段内补充内容。`).join("\n\n");
    const chapter = runtime.store.createChapter(String(work.id), {
      volumeId: String(volume.id),
      title: "第一章 追踪",
      content
    });
    const otherWork = await createWork(runtime, "隔离作品");
    const otherVolume = runtime.store.createVolume(String(otherWork.id), { title: "另一卷" });
    runtime.store.createChapter(String(otherWork.id), {
      volumeId: String(otherVolume.id),
      title: "另一章",
      content: "这里也有秘密线索。"
    });

    const defaults = runtime.store.searchChapterParagraphs(String(work.id), "秘密线索");
    expect(defaults).toHaveLength(20);
    expect(defaults[0]).toEqual({
      chapterId: chapter.id,
      chapterTitle: "第一章 追踪",
      paragraph: "第1段发现秘密线索。\n段内补充内容。"
    });
    expect(defaults.every((match) => match.chapterId === chapter.id)).toBe(true);
    expect(runtime.store.searchChapterParagraphs(String(work.id), "线索", 3)).toHaveLength(3);
  });

  it("在章节编辑和删除时同步更新索引", async () => {
    runtime = createTestRuntime();
    const work = await createWork(runtime, "同步索引作品");
    const volume = runtime.store.createVolume(String(work.id), { title: "正文" });
    const chapter = runtime.store.createChapter(String(work.id), {
      volumeId: String(volume.id),
      title: "第一章",
      content: "旧关键字只在这里。"
    });

    runtime.store.saveChapter(String(chapter.id), { content: "第一段没有命中。\n\n新关键字出现在完整段落里。" });
    expect(runtime.store.searchChapterParagraphs(String(work.id), "旧关键字")).toEqual([]);
    expect(runtime.store.searchChapterParagraphs(String(work.id), "新关键字")).toEqual([{
      chapterId: chapter.id,
      chapterTitle: "第一章",
      paragraph: "新关键字出现在完整段落里。"
    }]);

    runtime.store.deleteChapter(String(chapter.id));
    expect(runtime.store.searchChapterParagraphs(String(work.id), "新关键字")).toEqual([]);
  });

  it("供 AI 检索时排除作者的话章节", async () => {
    runtime = createTestRuntime();
    const work = await createWork(runtime, "作者的话检索作品");
    const volume = runtime.store.createVolume(String(work.id), { title: "第一卷" });
    runtime.store.createChapter(String(work.id), {
      volumeId: String(volume.id),
      title: "作者的话",
      chapterType: "作者的话",
      content: "AUTHOR_NOTE_SEARCH_MARKER"
    });
    const chapter = runtime.store.createChapter(String(work.id), {
      volumeId: String(volume.id),
      title: "第一章",
      content: "正文 AUTHOR_NOTE_SEARCH_MARKER。"
    });

    const matches = runtime.store.searchChapterParagraphs(String(work.id), "AUTHOR_NOTE_SEARCH_MARKER", 20, { excludeAuthorNotes: true });

    expect(matches).toEqual([expect.objectContaining({ chapterId: chapter.id, chapterTitle: "第一章" })]);
  });

  it("供 AI 检索时附带独立分卷、卷内章节与已确认时间线顺序", async () => {
    runtime = createTestRuntime();
    const work = await createWork(runtime, "剧情顺序检索");
    const volume = runtime.store.createVolume(String(work.id), { title: "倒叙卷", storyOrder: 6 });
    const chapter = runtime.store.createChapter(String(work.id), {
      volumeId: String(volume.id),
      title: "重逢",
      content: "林舟在港口重逢。"
    });
    runtime.store.createTimelineEvent(String(work.id), {
      name: "港口重逢",
      timeLabel: "第 12 日",
      timeSort: 12,
      chapterIds: [String(chapter.id)],
      status: "confirmed"
    });

    const matches = runtime.store.searchChapterParagraphs(String(work.id), "重逢", 20, {
      excludeAuthorNotes: true,
      includeStoryOrder: true,
      includeTimeline: true
    });

    expect(matches[0]).toMatchObject({
      chapterId: chapter.id,
      storyOrder: {
        volume: { id: volume.id, directoryOrder: 0, storyOrder: 6 },
        chapter: { order: 0, isLatestByStructure: true },
        confirmedTimelineEvents: [{ name: "港口重逢", timeSort: 12, trackId: null }]
      }
    });
  });
});
