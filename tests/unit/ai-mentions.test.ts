import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { buildAiReferenceScope, listAiMentionOptions } from "../../src/public/ai-mentions.js";

describe("AI @ 引用", () => {
  const characters = [{ id: "character-1", name: "哥斯拉" }];
  const settings = [{ id: "setting-1", title: "跃迁限制" }];
  const chapters = [{ id: "chapter-1", title: "第一章 泰坦密谈", volumeTitle: "前传" }];

  it("在空查询中同时展示角色、设定和章节", () => {
    const options = listAiMentionOptions(characters, settings, chapters);
    expect(options.map((item: { kind: string }) => item.kind)).toEqual(["character", "setting", "chapter"]);
  });

  it("按标题搜索章节并生成去重后的章节引用范围", () => {
    expect(listAiMentionOptions(characters, settings, chapters, "泰坦密谈")).toEqual([
      { kind: "chapter", kindLabel: "章节", id: "chapter-1", name: "前传 / 第一章 泰坦密谈" }
    ]);
    expect(buildAiReferenceScope([
      { kind: "chapter", id: "chapter-1" },
      { kind: "chapter", id: "chapter-1" },
      { kind: "character", id: "character-1" }
    ])).toEqual({ chapterIds: ["chapter-1"], characterIds: ["character-1"] });
  });
});
