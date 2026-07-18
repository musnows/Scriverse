import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { tokenizeVisibleSpaces } from "../../src/public/whitespace-visualization.js";

describe("正文空白符可视化", () => {
  it("区分半角空格、全角空格与 Tab，同时保持原始文本不变", () => {
    const source = "甲 乙　丙\n丁\t戊\u00a0己";
    const tokens = tokenizeVisibleSpaces(source);

    expect(tokens.filter((token: { type: string }) => token.type === "space")).toHaveLength(1);
    expect(tokens.filter((token: { type: string }) => token.type === "ideographic-space")).toHaveLength(1);
    expect(tokens.filter((token: { type: string }) => token.type === "tab")).toHaveLength(1);
    expect(tokens.map((token: { text: string }) => token.text).join("")).toBe(source);
  });

  it("连续空格逐个生成标记，便于定位多余空格", () => {
    expect(tokenizeVisibleSpaces("甲   乙").map((token: { type: string }) => token.type)).toEqual([
      "text", "space", "space", "space", "text"
    ]);
  });

  it("连续 Tab 逐个生成标记，并保留真实制表符", () => {
    const source = "甲\t\t乙";
    const tokens = tokenizeVisibleSpaces(source);
    expect(tokens.map((token: { type: string }) => token.type)).toEqual([
      "text", "tab", "tab", "text"
    ]);
    expect(tokens.map((token: { text: string }) => token.text).join("")).toBe(source);
  });
});
