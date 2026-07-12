import { describe, expect, it } from "vitest";
import { normalizeParagraphSpacing } from "../../src/public/text-formatting.js";

describe("正文排版整理", () => {
  it("把段间连续空行压缩为一个并清理首尾空行", () => {
    expect(normalizeParagraphSpacing("\n\n第一段。\n \n\t\n\n第二段。\n\n"))
      .toBe("第一段。\n\n第二段。");
  });

  it("保留段内单换行和已经规范的段间距", () => {
    expect(normalizeParagraphSpacing("第一行\n第二行\n\n下一段"))
      .toBe("第一行\n第二行\n\n下一段");
  });
});
