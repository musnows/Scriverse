import { describe, expect, it } from "vitest";
import { findTextMatches, replaceTextMatches } from "../../src/public/chapter-search.js";

describe("本章搜索与替换", () => {
  it("按字面量返回非重叠匹配位置", () => {
    expect(findTextMatches("艾利，艾利再次出现", "艾利")).toEqual([0, 3]);
    expect(findTextMatches("aaaa", "aa")).toEqual([0, 2]);
    expect(findTextMatches("正文", "")).toEqual([]);
  });

  it("按字面量替换并保留替换文本中的特殊字符", () => {
    expect(replaceTextMatches("艾利和艾利", "艾利", "$&-新名")).toEqual({
      content: "$&-新名和$&-新名",
      matches: 2
    });
    expect(replaceTextMatches("没有命中", "艾利", "艾达拉")).toEqual({ content: "没有命中", matches: 0 });
  });
});
