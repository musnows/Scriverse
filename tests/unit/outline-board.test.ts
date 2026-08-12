import { describe, expect, it } from "vitest";
import {
  normalizeOutlineBoardState,
  outlineBoardUnresolvedCount,
  prepareOutlineBoard
} from "../../src/public/outline-board.js";

const board = {
  volumes: [
    {
      id: "volume-late",
      title: "第二卷",
      sortOrder: 20,
      chapters: [
        {
          id: "chapter-ready",
          title: "潮门开启",
          chapterType: "正文",
          sortOrder: 2,
          outline: { goal: "驶向外海", conflict: "风暴逼近", turningPoint: "潮门开启", notes: "", status: "ready" },
          foreshadows: [{ id: "f-planted", title: "旧信", status: "planted" }]
        },
        {
          id: "chapter-empty",
          title: "无声海域",
          chapterType: "正文",
          sortOrder: 1,
          outline: null,
          foreshadows: []
        }
      ]
    },
    { id: "volume-empty", title: "空卷", sortOrder: 30, chapters: [] },
    {
      id: "volume-first",
      title: "第一卷",
      sortOrder: 10,
      chapters: [{
        id: "chapter-complete",
        title: "旧港回响",
        chapterType: "正文",
        sortOrder: 0,
        outline: { goal: "找出旧信真相", conflict: "同伴隐瞒", turningPoint: "旧信被调包", notes: "线索已回收", status: "completed" },
        foreshadows: [
          { id: "f-resolved", title: "铜钥匙", status: "resolved" },
          { id: "f-planned", title: "沉船坐标", status: "planned" }
        ]
      }]
    }
  ]
};

describe("prepareOutlineBoard", () => {
  it("默认按章节树顺序组织，并保留空分卷", () => {
    const result = prepareOutlineBoard(board);

    expect(result.volumes.map((volume) => volume.id)).toEqual(["volume-first", "volume-late", "volume-empty"]);
    expect(result.volumes[1]?.chapters.map((chapter) => chapter.id)).toEqual(["chapter-empty", "chapter-ready"]);
    expect(result.totalChapterCount).toBe(3);
    expect(result.visibleChapterCount).toBe(3);
    expect(result.filtersActive).toBe(false);
  });

  it("跨标题、大纲和伏笔搜索，并组合状态筛选", () => {
    expect(prepareOutlineBoard(board, { query: "旧信" }).volumes.flatMap((volume) => volume.chapters).map((chapter) => chapter.id))
      .toEqual(["chapter-complete", "chapter-ready"]);
    expect(prepareOutlineBoard(board, { outlineStatus: "empty" }).volumes.flatMap((volume) => volume.chapters).map((chapter) => chapter.id))
      .toEqual(["chapter-empty"]);
    expect(prepareOutlineBoard(board, { foreshadowStatus: "unresolved", outlineStatus: "completed" }).volumes.flatMap((volume) => volume.chapters).map((chapter) => chapter.id))
      .toEqual(["chapter-complete"]);
    expect(prepareOutlineBoard(board, { foreshadowStatus: "none" }).volumes.flatMap((volume) => volume.chapters).map((chapter) => chapter.id))
      .toEqual(["chapter-empty"]);
  });

  it("指定空分卷时保留空状态，其他筛选无结果时移除空分组", () => {
    const selectedEmpty = prepareOutlineBoard(board, { volumeId: "volume-empty" });
    expect(selectedEmpty.volumes).toEqual([expect.objectContaining({ id: "volume-empty", chapters: [] })]);

    const noMatch = prepareOutlineBoard(board, { query: "不存在的摘要" });
    expect(noMatch.volumes).toEqual([]);
    expect(noMatch.visibleChapterCount).toBe(0);
  });

  it("仅在卷内排序并保持输入数据不变", () => {
    const snapshot = structuredClone(board);
    const byStatus = prepareOutlineBoard(board, { volumeId: "volume-late", sort: "status" });
    expect(byStatus.volumes[0]?.chapters.map((chapter) => chapter.id)).toEqual(["chapter-empty", "chapter-ready"]);
    const byTitle = prepareOutlineBoard(board, { volumeId: "volume-late", sort: "title" });
    expect(byTitle.volumes[0]?.chapters.map((chapter) => chapter.id)).toEqual(["chapter-ready", "chapter-empty"]);
    const byForeshadows = prepareOutlineBoard(board, { volumeId: "volume-late", sort: "foreshadows" });
    expect(byForeshadows.volumes[0]?.chapters.map((chapter) => chapter.id)).toEqual(["chapter-ready", "chapter-empty"]);
    expect(board).toEqual(snapshot);
  });
});

describe("outline board state", () => {
  it("规范无效筛选与排序值", () => {
    expect(normalizeOutlineBoardState({ outlineStatus: "invalid" as "draft", foreshadowStatus: "invalid" as "none", sort: "invalid" as "tree" }))
      .toEqual({ query: "", volumeId: "", outlineStatus: "all", foreshadowStatus: "all", sort: "tree" });
  });

  it("统计章节关联的未回收伏笔", () => {
    const chapter = board.volumes[2]?.chapters[0];
    expect(chapter && outlineBoardUnresolvedCount(chapter)).toBe(1);
  });
});
