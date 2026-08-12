import { describe, expect, it } from "vitest";
import { chapterDiffSummary, diffChapterLines } from "../../src/public/chapter-version-diff.js";

describe("章节版本逐行差异", () => {
  it("区分新增、删除和修改行，并保留两侧行号", () => {
    const rows = diffChapterLines(
      "第一行\n需要修改\n需要删除\n末行",
      "第一行\n已经修改\n新增一行\n末行"
    );

    expect(rows).toEqual([
      { type: "equal", before: "第一行", after: "第一行", beforeLine: 1, afterLine: 1 },
      { type: "modified", before: "需要修改", after: "已经修改", beforeLine: 2, afterLine: 2 },
      { type: "modified", before: "需要删除", after: "新增一行", beforeLine: 3, afterLine: 3 },
      { type: "equal", before: "末行", after: "末行", beforeLine: 4, afterLine: 4 }
    ]);
    expect(chapterDiffSummary(rows)).toEqual({ added: 0, deleted: 0, modified: 2, unchanged: 2 });
  });

  it("插入或移除内容时不把后续相同行误判为修改", () => {
    expect(diffChapterLines("甲\n乙\n丙", "甲\n新增\n乙\n丙")).toEqual([
      { type: "equal", before: "甲", after: "甲", beforeLine: 1, afterLine: 1 },
      { type: "added", after: "新增", afterLine: 2 },
      { type: "equal", before: "乙", after: "乙", beforeLine: 2, afterLine: 3 },
      { type: "equal", before: "丙", after: "丙", beforeLine: 3, afterLine: 4 }
    ]);
    expect(diffChapterLines("甲\n删除\n乙", "甲\n乙")[1]).toEqual({ type: "deleted", before: "删除", beforeLine: 2 });
  });

  it("统一换行符，并在超大输入回退时保持确定结果", () => {
    expect(diffChapterLines("甲\r\n乙", "甲\n乙")).toHaveLength(2);
    expect(diffChapterLines("旧一\n旧二", "新一\n新二", 1)).toEqual([
      { type: "modified", before: "旧一", after: "新一", beforeLine: 1, afterLine: 1 },
      { type: "modified", before: "旧二", after: "新二", beforeLine: 2, afterLine: 2 }
    ]);
  });
});
