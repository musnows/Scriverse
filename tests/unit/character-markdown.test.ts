import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { clipboardImageFiles } from "../../src/public/character-markdown.js";

describe("人物 Markdown 剪贴板图片", () => {
  it("从剪贴板条目中提取支持的图片并忽略文本和不支持的格式", () => {
    const png = { name: "截图.png", type: "image/png" };
    const files = clipboardImageFiles({
      items: [
        { kind: "string", type: "text/plain" },
        { kind: "file", type: "image/png", getAsFile: () => png },
        { kind: "file", type: "image/svg+xml", getAsFile: () => ({ name: "图标.svg", type: "image/svg+xml" }) }
      ]
    });

    expect(files).toEqual([png]);
  });

  it("在没有剪贴板条目时从 files 回退提取图片", () => {
    const jpeg = { name: "照片.jpg", type: "image/jpeg" };
    const text = { name: "文本.txt", type: "text/plain" };

    expect(clipboardImageFiles({ items: [], files: [jpeg, text] })).toEqual([jpeg]);
  });
});
