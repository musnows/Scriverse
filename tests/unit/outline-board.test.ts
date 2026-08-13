import { describe, expect, it } from "vitest";
import {
  normalizeOutlineBoardState,
  outlineBoardRequestPath,
  outlineBoardUnresolvedCount
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

describe("outline board state", () => {
  it("规范无效筛选与排序值", () => {
    expect(normalizeOutlineBoardState({ outlineStatus: "invalid" as "draft", foreshadowStatus: "invalid" as "none", sort: "invalid" as "tree" }))
      .toEqual({ query: "", volumeId: "", outlineStatus: "all", foreshadowStatus: "all", sort: "tree" });
  });

  it("为服务端分页筛选生成有界请求参数", () => {
    const path = outlineBoardRequestPath("work / 一", {
      query: " 旧信 坐标 ",
      volumeId: "volume-late",
      outlineStatus: "ready",
      foreshadowStatus: "unresolved",
      sort: "foreshadows"
    }, 3, 50);
    const url = new URL(path, "http://localhost");

    expect(url.pathname).toBe("/api/works/work%20%2F%20%E4%B8%80/outline-board");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      page: "3",
      limit: "50",
      q: "旧信 坐标",
      volumeId: "volume-late",
      outlineStatus: "ready",
      foreshadowStatus: "unresolved",
      sort: "foreshadows"
    });
  });

  it("修正无效分页并限制搜索长度", () => {
    const url = new URL(outlineBoardRequestPath("work", { query: "查".repeat(250) }, 0, 500), "http://localhost");
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("limit")).toBe("30");
    expect(url.searchParams.get("q")).toHaveLength(200);
  });

  it("统计章节关联的未回收伏笔", () => {
    const chapter = board.volumes[2]?.chapters[0];
    expect(chapter && outlineBoardUnresolvedCount(chapter)).toBe(1);
  });
});
