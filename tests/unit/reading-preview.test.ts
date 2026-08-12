import { describe, expect, it } from "vitest";
import {
  adjacentReadingChapter,
  buildReadingChapterSequence,
  createReadingRequestGate,
  normalizeReadingPosition,
  normalizeReadingPreferences,
  normalizeStoredReadingPreferences,
  readingPositionStorageKey,
  resolvePagedReadingStep,
  resolveReadingTheme,
  resolveReadingStart
} from "../../src/public/reading-preview.js";

const work = {
  id: "work / 1",
  volumes: [
    { id: "volume-1", title: "第一卷", chapters: [
      { id: "chapter-1", title: "起航", sortOrder: 0 },
      { id: "chapter-2", title: "风暴", sortOrder: 1 }
    ] },
    { id: "volume-2", title: "第二卷", chapters: [
      { id: "chapter-3", title: "归途", sortOrder: 0 }
    ] }
  ]
};

describe("沉浸式阅读状态", () => {
  it("保持作品树中的跨卷章节顺序并忽略重复章节", () => {
    const sequence = buildReadingChapterSequence({
      ...work,
      volumes: [...work.volumes, { id: "volume-3", title: "重复", chapters: [{ id: "chapter-2", title: "重复章" }] }]
    });
    expect(sequence.map((chapter) => [chapter.volumeTitle, chapter.title])).toEqual([
      ["第一卷", "起航"],
      ["第一卷", "风暴"],
      ["第二卷", "归途"]
    ]);
    expect(sequence.map((chapter) => chapter.sequenceIndex)).toEqual([0, 1, 2]);
    expect(adjacentReadingChapter(sequence, "chapter-2", 1)?.id).toBe("chapter-3");
    expect(adjacentReadingChapter(sequence, "chapter-3", 1)).toBeNull();
  });

  it("按显式章节、保存位置、分卷和全书首章依次解析起点", () => {
    const sequence = buildReadingChapterSequence(work);
    const storedPosition = { chapterId: "chapter-2", scrollRatio: 0.65, pageIndex: 3 };
    expect(resolveReadingStart(sequence, { chapterId: "chapter-3", storedPosition })?.id).toBe("chapter-3");
    expect(resolveReadingStart(sequence, { chapterId: "missing", storedPosition })?.id).toBe("chapter-2");
    expect(resolveReadingStart(sequence, { volumeId: "volume-2" })?.id).toBe("chapter-3");
    expect(resolveReadingStart(sequence)?.id).toBe("chapter-1");
    expect(normalizeReadingPosition({ chapterId: "chapter-2", scrollRatio: 8, pageIndex: -2 }, sequence)).toEqual({
      chapterId: "chapter-2",
      scrollRatio: 1,
      pageIndex: 0
    });
  });

  it("规范化可访问阅读偏好且默认主题跟随工作台", () => {
    expect(normalizeReadingPreferences({ mode: "paged", fontSize: 24, lineHeight: 2.2, theme: "dark" })).toEqual({
      mode: "paged",
      fontSize: 24,
      lineHeight: 2.2,
      theme: "dark"
    });
    expect(normalizeReadingPreferences({ mode: "invalid", fontSize: 99, lineHeight: 7, theme: "blue" })).toEqual({
      mode: "scroll",
      fontSize: 20,
      lineHeight: 1.9,
      theme: "auto"
    });
    expect(resolveReadingTheme("auto", "dark")).toBe("dark");
    expect(resolveReadingTheme("auto", "light")).toBe("paper");
    expect(resolveReadingTheme("light", "dark")).toBe("light");
    expect(normalizeStoredReadingPreferences({ mode: "paged", theme: "paper" }).theme).toBe("auto");
    expect(normalizeStoredReadingPreferences({ mode: "paged", theme: "paper", version: 2 }).theme).toBe("paper");
    expect(readingPositionStorageKey("work / 1")).toBe("scriverse-reading-position-v1:work%20%2F%201");
  });

  it("分页到边界时跨章并在跨卷返回上一章末页", () => {
    const sequence = buildReadingChapterSequence(work);
    expect(resolvePagedReadingStep({ sequence, chapterId: "chapter-2", pageIndex: 1, pageCount: 3 }, 1)).toEqual({
      chapterId: "chapter-2",
      pageIndex: 2,
      chapterChanged: false
    });
    expect(resolvePagedReadingStep({ sequence, chapterId: "chapter-2", pageIndex: 2, pageCount: 3 }, 1)).toEqual({
      chapterId: "chapter-3",
      pageIndex: 0,
      chapterChanged: true
    });
    expect(resolvePagedReadingStep({ sequence, chapterId: "chapter-3", pageIndex: 0, pageCount: 1 }, -1)).toEqual({
      chapterId: "chapter-2",
      pageIndex: -1,
      chapterChanged: true
    });
  });

  it("新章节请求会取消旧请求且旧代次不能覆盖当前内容", () => {
    const gate = createReadingRequestGate();
    const first = gate.begin("chapter-1");
    const second = gate.begin("chapter-2");
    expect(first.signal.aborted).toBe(true);
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
    gate.finish(first);
    expect(gate.isCurrent(second)).toBe(true);
    gate.cancel();
    expect(second.signal.aborted).toBe(true);
    expect(gate.isCurrent(second)).toBe(false);
  });
});
