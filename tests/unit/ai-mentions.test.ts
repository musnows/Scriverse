import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { buildAiReferenceScope, listAiMentionOptions, mergeAiReferenceScope, userMessageMentionNames } from "../../src/public/ai-mentions.js";

describe("AI @ 引用", () => {
  const characters = [{ id: "character-1", name: "哥斯拉" }];
  const settings = [{ id: "setting-1", title: "跃迁限制" }];
  const chapters = [{ id: "chapter-1", title: "第一章 泰坦密谈", volumeTitle: "前传" }];

  it("在空查询中优先展示上下文能力并同时展示角色、设定和章节", () => {
    const options = listAiMentionOptions(characters, settings, chapters);
    expect(options.map((item: { kind: string }) => item.kind)).toEqual(["context-settings", "character", "setting", "chapter"]);
    expect(listAiMentionOptions(characters, settings, chapters, "注入")).toEqual([
      { kind: "context-settings", kindLabel: "能力", id: "include-setting-info", name: "注入上下文设定" }
    ]);
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

  it("将每轮新增引用合并到已锁定的基础上下文", () => {
    expect(mergeAiReferenceScope({ type: "chapter", chapterId: "chapter-base", chapterIds: ["chapter-old"] }, [
      { kind: "chapter", id: "chapter-old" },
      { kind: "chapter", id: "chapter-new" },
      { kind: "setting", id: "setting-1" }
    ])).toEqual({
      type: "chapter",
      chapterId: "chapter-base",
      chapterIds: ["chapter-old", "chapter-new"],
      settingIds: ["setting-1"]
    });
  });

  it("通过上下文能力显式开启本轮设定注入", () => {
    expect(mergeAiReferenceScope({ type: "none", includeSettingInfo: false }, [
      { kind: "context-settings", id: "include-setting-info" }
    ])).toEqual({ type: "none", includeSettingInfo: true });
  });

  it("按消息引用顺序解析角色名并跳过重复或已删除角色", () => {
    expect(userMessageMentionNames([
      "character-2",
      "character-1",
      "character-2",
      "character-deleted"
    ], [
      { id: "character-1", name: "哥斯拉" },
      { id: "character-2", name: "魔斯拉" }
    ])).toEqual(["魔斯拉", "哥斯拉"]);
  });

  it("没有有效角色引用时返回空列表", () => {
    expect(userMessageMentionNames([], characters)).toEqual([]);
    expect(userMessageMentionNames(["character-deleted"], characters)).toEqual([]);
    expect(userMessageMentionNames(null, characters)).toEqual([]);
  });
});
