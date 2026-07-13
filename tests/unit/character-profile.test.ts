import { describe, expect, it } from "vitest";
import { buildCharacterDetails, buildCharacterSections, buildCharacterState, characterStateEntries, normalizeCharacterDetails, normalizeCharacterSections } from "../../src/public/character-profile.js";

describe("复杂人物设定结构", () => {
  it("清理扩展属性并保留不同泰坦的异构字段", () => {
    expect(buildCharacterDetails(
      ["身高", "雄性翼展", "", "危险等级"],
      ["119.786米", "136米", "无效值", "五级"]
    )).toEqual([
      { label: "身高", value: "119.786米" },
      { label: "雄性翼展", value: "136米" },
      { label: "危险等级", value: "五级" }
    ]);
    expect(normalizeCharacterDetails(null)).toEqual([]);
  });

  it("保存长篇设定章节并过滤不完整的章节", () => {
    expect(buildCharacterSections(
      ["能力与特征", "新增记录 v2", "空章节"],
      ["- 原子吐息\n- 星球之力", "记录正文", ""]
    )).toEqual([
      { title: "能力与特征", content: "- 原子吐息\n- 星球之力" },
      { title: "新增记录 v2", content: "记录正文" }
    ]);
    expect(normalizeCharacterSections({})).toEqual([]);
  });

  it("编辑任意当前状态并保留未修改值的原始类型", () => {
    const previous = { location: "地球", energy: 95, nested: { phase: "active" } };
    const entries = characterStateEntries(previous);
    expect(entries).toEqual([
      { label: "location", value: "地球" },
      { label: "energy", value: "95" },
      { label: "nested", value: "{\"phase\":\"active\"}" }
    ]);
    expect(buildCharacterState(
      ["location", "energy", "nested", "__proto__"],
      ["地心", "95", "{\"phase\":\"active\"}", "blocked"],
      previous
    )).toEqual({ location: "地心", energy: 95, nested: { phase: "active" } });
  });
});
