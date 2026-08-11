import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { buildChapterLineMirror, findChapterLineWindow } from "../../src/public/chapter-editor-virtualization.js";

describe("正文编辑器可视区虚拟化", () => {
  it("构建单文本节点镜像并保留空行与规范化后的偏移", () => {
    const mirror = buildChapterLineMirror("甲\r\n\r\n乙");

    expect(mirror.lines).toEqual(["甲", "", "乙"]);
    expect(mirror.text).toBe("\u200b甲\n\u200b\n\u200b乙");
    expect(mirror.offsets).toEqual([0, 3, 5]);
    expect(mirror.offsets.map((offset: number, index: number) => (
      mirror.text.slice(offset + 1, offset + 1 + mirror.lines[index].length)
    ))).toEqual(mirror.lines);
  });

  it("空正文仍生成一个可测量的逻辑行", () => {
    expect(buildChapterLineMirror("")).toEqual({ lines: [""], offsets: [0], text: "\u200b" });
  });

  it("按可视高度二分选出包含软换行高度的逻辑行窗口", () => {
    const rows = [
      { top: 0, bottom: 24 },
      { top: 24, bottom: 72 },
      { top: 72, bottom: 96 },
      { top: 96, bottom: 144 },
      { top: 144, bottom: 168 }
    ];

    expect(findChapterLineWindow(rows.length, (index: number) => rows[index], 50, 118)).toEqual({ start: 1, end: 4 });
    expect(findChapterLineWindow(rows.length, (index: number) => rows[index], -100, 10)).toEqual({ start: 0, end: 1 });
    expect(findChapterLineWindow(rows.length, (index: number) => rows[index], 200, 240)).toEqual({ start: 4, end: 5 });
  });
});
