import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { splitRelationshipKeywordInput, splitRelationshipKeywords, uniqueRelationshipKeywords } from "../../src/public/relationship-keywords.js";

describe("人物关系关键词", () => {
  it("支持中英文逗号和分号批量拆分", () => {
    expect(splitRelationshipKeywords("远航, 互信，守望；共同任务")).toEqual(["远航", "互信", "守望", "共同任务"]);
  });

  it("输入分隔符时提交已完成项并保留正在输入项", () => {
    expect(splitRelationshipKeywordInput("远航,互"))
      .toEqual({ completed: ["远航"], remainder: "互" });
  });

  it("关键词去重时忽略大小写并保留首次出现的文本", () => {
    expect(uniqueRelationshipKeywords(["远航", "远航", "Trust", "trust"])).toEqual(["远航", "Trust"]);
  });
});
