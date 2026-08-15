import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { readClipboardPlainText } from "../../src/public/plain-text-paste.js";

describe("纯文本粘贴", () => {
  it("只读取 text/plain 并统一换行符", () => {
    const data = {
      getData: (format: string) => format === "text/plain" ? "第一行\r\n第二行\r第三行" : "<span style=\"background: orange\">富文本</span>"
    };
    expect(readClipboardPlainText(data)).toBe("第一行\n第二行\n第三行");
  });

  it("剪贴板不可读时返回空文本", () => {
    expect(readClipboardPlainText(null)).toBe("");
    expect(readClipboardPlainText({ getData: () => { throw new Error("clipboard unavailable"); } })).toBe("");
  });
});
