import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { buildGlobalReplaceRefreshPlan } from "../../src/public/global-replace-refresh.js";

describe("全局替换后的正文目录刷新计划", () => {
  const volumes = [
    { id: "volume-1", chapters: [{ id: "chapter-1" }] },
    { id: "volume-2", chapters: [{ id: "chapter-2" }] },
    { id: "volume-3", chapters: [{ id: "chapter-3" }] }
  ];

  it("保留展开状态并重新加载展开卷和当前章节所在卷", () => {
    const plan = buildGlobalReplaceRefreshPlan({
      volumes,
      collapsedVolumeIds: new Set(["volume-2"]),
      selectedChapterId: "chapter-2",
      selectedChapterVolumeId: "volume-2",
      scope: "prose",
      chapterCount: 1
    });

    expect(plan).toMatchObject({
      proseChanged: true,
      selectedChapterId: "chapter-2",
      selectedChapterVolumeId: "volume-2",
      expandedVolumeIds: ["volume-1", "volume-3"],
      reloadVolumeIds: ["volume-1", "volume-3", "volume-2"]
    });
  });

  it("命中设定库时不重置正文目录", () => {
    const plan = buildGlobalReplaceRefreshPlan({
      volumes,
      collapsedVolumeIds: ["volume-2"],
      selectedChapterId: "chapter-1",
      scope: "settings",
      settingCount: 1
    });

    expect(plan).toMatchObject({
      proseChanged: false,
      settingsChanged: true,
      selectedChapterId: "chapter-1",
      selectedChapterVolumeId: "volume-1",
      reloadVolumeIds: []
    });
  });

  it("零命中或没有章节命中时不安排正文目录刷新", () => {
    expect(buildGlobalReplaceRefreshPlan({
      volumes,
      collapsedVolumeIds: ["volume-2"],
      scope: "prose",
      chapterCount: 0
    })).toMatchObject({ proseChanged: false, reloadVolumeIds: [] });

    expect(buildGlobalReplaceRefreshPlan({
      volumes,
      collapsedVolumeIds: ["volume-2"],
      scope: "prose-and-settings",
      chapterCount: 0,
      settingCount: 2
    })).toMatchObject({ proseChanged: false, settingsChanged: true, reloadVolumeIds: [] });
  });
});
