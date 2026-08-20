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
        volume: { volumeId: volume.id, directoryOrder: 0, storyOrder: 6 },
        chapter: { order: 0, isLatestByStructure: true },
        confirmedTimelineEvents: [{ name: "港口重逢", timeSort: 12, trackId: null }]
      }
    });
    expect(runtime.store.searchLatestChapterParagraphsByTimelineTrack(String(work.id), "重逢")).toEqual([
      expect.objectContaining({
        trackId: null,
        trackName: null,
        timeSort: 12,
        occurrence: expect.objectContaining({ chapterId: chapter.id })
      })
    ]);
  });

  it("独立定位关键词的结构末位与各已确认时间线轨道末位", async () => {
    runtime = createTestRuntime();
    const work = await createWork(runtime, "倒叙关键词检索");
    const flashbackVolume = runtime.store.createVolume(String(work.id), { title: "倒叙卷", storyOrder: 8 });
    const earlierVolume = runtime.store.createVolume(String(work.id), { title: "早期卷", storyOrder: 1 });
    const flashbackChapter = runtime.store.createChapter(String(work.id), {
      volumeId: String(flashbackVolume.id),
      title: "结构末章",
      content: "密钥第一次出现在倒叙卷。\n\n密钥最后一次出现在倒叙卷。"
    });
    const timelineLaterChapter = runtime.store.createChapter(String(work.id), {
      volumeId: String(earlierVolume.id),
      title: "时间线后期",
      content: "密钥在主线较晚时刻出现。"
    });
    const track = runtime.store.createTimelineTrack(String(work.id), { name: "主线" });
    runtime.store.createTimelineEvent(String(work.id), {
      name: "倒叙回忆",
      trackId: String(track.id),
      timeLabel: "第 5 日",
      timeSort: 5,
      chapterIds: [String(flashbackChapter.id)],
      status: "confirmed"
    });
    runtime.store.createTimelineEvent(String(work.id), {
      name: "主线后期",
      trackId: String(track.id),
      timeLabel: "第 50 日",
      timeSort: 50,
      chapterIds: [String(timelineLaterChapter.id)],
      status: "confirmed"
    });
    runtime.store.createTimelineEvent(String(work.id), {
      name: "未确认未来",
      trackId: String(track.id),
      timeLabel: "第 999 日",
      timeSort: 999,
      chapterIds: [String(flashbackChapter.id)],
      status: "candidate"
    });

    const matches = runtime.store.searchChapterParagraphs(String(work.id), "密钥", 1, {
      includeStoryOrder: true,
      includeTimeline: true,
      order: "story_desc"
    });
    const latestByStructure = runtime.store.searchLatestChapterParagraphsByStructure(String(work.id), "密钥", {
      includeTimeline: true
    });
    const latestByTimelineTrack = runtime.store.searchLatestChapterParagraphsByTimelineTrack(String(work.id), "密钥");

    expect(matches).toEqual([
      expect.objectContaining({
        chapterId: flashbackChapter.id,
        paragraphOrder: 1,
        paragraph: "密钥最后一次出现在倒叙卷。"
      })
    ]);
    expect(latestByStructure).toEqual([
      expect.objectContaining({
        chapterId: flashbackChapter.id,
        paragraphOrder: 1,
        storyOrder: expect.objectContaining({ volume: expect.objectContaining({ storyOrder: 8 }) })
      })
    ]);
    expect(latestByTimelineTrack).toEqual([
      expect.objectContaining({
        trackId: track.id,
        trackName: "主线",
        timeSort: 50,
        timeLabel: "第 50 日",
        timelineEvent: expect.objectContaining({ name: "主线后期" }),
        occurrence: expect.objectContaining({ chapterId: timelineLaterChapter.id, paragraphOrder: 0 }),
        matchingLinksAtLatestTime: 1
      })
    ]);
    expect(JSON.stringify(latestByTimelineTrack)).not.toContain("未确认未来");

    expect(runtime.store.searchLatestChapterParagraphsByTimelineTrack(String(work.id), "密钥", {
      chapterIds: [String(flashbackChapter.id)]
    })).toEqual([
      expect.objectContaining({ timeSort: 5, occurrence: expect.objectContaining({ chapterId: flashbackChapter.id }) })
    ]);
  });

  it("最小工具结果预算下仍能分页返回关键词末位信息", async () => {
    runtime = createTestRuntime();
    const work = await createWork(runtime, "小预算关键词检索");
    const volume = runtime.store.createVolume(String(work.id), { title: "第一卷" });
    runtime.store.createChapter(String(work.id), {
      volumeId: String(volume.id),
      title: "长段落",
      content: `密钥${"正文".repeat(2_000)}`
    });
    const internalAi = runtime.ai as unknown as {
      executeAgentTool: (
        workId: string,
        toolCall: Record<string, unknown>,
        maximumResultChars?: number
      ) => Promise<{ result: Record<string, unknown> }>;
    };

    const execution = await internalAi.executeAgentTool(String(work.id), {
      id: "small-budget-grep",
      type: "function",
      function: { name: "grep", arguments: { keyword: "密钥" } }
    }, 1_000);

    expect(JSON.stringify(execution.result).length).toBeLessThanOrEqual(1_000);
    expect(execution.result).toMatchObject({
      ok: true,
      data: { latestOccurrences: expect.any(Object) },
      pagination: { nextCursor: expect.any(Number), maxChars: 1_000 }
    });
  });
});
