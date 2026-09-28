import { describe, expect, it } from "vitest";
import {
  chapterTitleWithoutNumber,
  detectChapterTitleFormat,
  formatChapterNumber,
  inferVolumeNumberStart,
  isChapterNumberTemplate,
  parseChapterTitleNumber,
  planAutoNumberedTitles,
  planVolumeTitleRenumber,
  renumberChapterTitle,
  resolveChapterTitleFormat
} from "../../src/chapter-title-numbering.js";

describe("章节标题序号重排", () => {
  it("校验单个序号占位符和安全长度", () => {
    expect(isChapterNumberTemplate("第{n}章")).toBe(true);
    expect(isChapterNumberTemplate("Chapter {n}:")).toBe(true);
    expect(isChapterNumberTemplate("第1章")).toBe(false);
    expect(isChapterNumberTemplate("{n}-{n}")).toBe(false);
    expect(isChapterNumberTemplate("第{n}章\n")).toBe(false);
    expect(isChapterNumberTemplate(`${"章".repeat(50)}{n}`)).toBe(false);
  });

  it("输出阿拉伯数字和常用中文数字", () => {
    expect(formatChapterNumber(12, "arabic")).toBe("12");
    expect([
      1,
      10,
      11,
      20,
      101,
      1_001,
      10_010,
      100_000,
      999_999
    ].map((value) => formatChapterNumber(value, "chinese"))).toEqual([
      "一",
      "十",
      "十一",
      "二十",
      "一百零一",
      "一千零一",
      "一万零一十",
      "十万",
      "九十九万九千九百九十九"
    ]);
  });

  it("只清洗可识别的旧序号并保留异常标题", () => {
    expect(chapterTitleWithoutNumber("第十二章：旧城")).toBe("旧城");
    expect(chapterTitleWithoutNumber("Chapter 77 - Return")).toBe("Return");
    expect(chapterTitleWithoutNumber("003、远航")).toBe("远航");
    expect(chapterTitleWithoutNumber("第X章 异常编号")).toBe("第X章 异常编号");
    expect(chapterTitleWithoutNumber("序章")).toBe("序章");
  });

  it("按指定模板生成统一标题并规范副标题间距", () => {
    expect(renumberChapterTitle("第九章： 旧城", 1, "第{n}章", "chinese")).toBe("第一章 旧城");
    expect(renumberChapterTitle("Chapter 9", 2, "第{n}章", "arabic")).toBe("第2章");
    expect(renumberChapterTitle("序章", 3, "Chapter {n}:", "arabic")).toBe("Chapter 3: 序章");
    expect(renumberChapterTitle("第X章 异常编号", 4, "第{n}章", "chinese")).toBe("第四章 第X章 异常编号");
  });

  it("识别常见标题序号，并在票数相同时放弃判断", () => {
    expect(parseChapterTitleNumber("36. 拜访孤爪 | 摩斯拉")).toEqual({
      formatId: "dot",
      number: 36,
      suffix: "拜访孤爪 | 摩斯拉"
    });
    expect(parseChapterTitleNumber("第36章 偷偷去找她 | 哥斯拉")).toMatchObject({ formatId: "chapter-arabic", number: 36, suffix: "偷偷去找她 | 哥斯拉" });
    expect(parseChapterTitleNumber("第三十六章 噩梦与相伴")).toMatchObject({ formatId: "chapter-chinese", number: 36, suffix: "噩梦与相伴" });
    expect(parseChapterTitleNumber("003、远航")).toMatchObject({ formatId: "enumeration", number: 3, suffix: "远航" });
    expect(parseChapterTitleNumber("Chapter 77 - Return")).toMatchObject({ formatId: "english", number: 77, suffix: "Return" });
    expect(parseChapterTitleNumber("第X章 异常编号")).toBeNull();
    expect(parseChapterTitleNumber("偷偷去找她 | 哥斯拉")).toBeNull();
    expect(detectChapterTitleFormat([
      "36. 拜访孤爪 | 摩斯拉",
      "偷偷去找她 | 哥斯拉",
      "37. 下一章"
    ])).toBe("dot");
    expect(detectChapterTitleFormat(["第1章 甲", "1. 乙"])).toBeNull();
    expect(resolveChapterTitleFormat("off", ["1. 甲"])).toBeNull();
    expect(resolveChapterTitleFormat("auto", ["第2章 甲", "第3章 乙"])).toBe("chapter-arabic");
    expect(resolveChapterTitleFormat("enumeration", ["1. 甲"])).toBe("enumeration");
  });

  it("中文数字可以还原常用章节序号", () => {
    for (const value of [1, 10, 11, 20, 101, 1_001, 10_010, 100_000]) {
      expect(parseChineseRoundTrip(value)).toBe(value);
    }
  });

  it("中间插入时只后移本卷后续序号，并保留序号以外的文字", () => {
    const chapters = [
      { id: "a", title: "36. 拜访孤爪 | 摩斯拉" },
      { id: "new", title: "" },
      { id: "b", title: "偷偷去找她 | 哥斯拉" },
      { id: "c", title: "37. 下一章 | 摩斯拉" },
      { id: "d", title: "序章" }
    ];
    expect(planAutoNumberedTitles(chapters, "new", "噩梦与相伴 | 哥斯拉", "dot")).toEqual([
      { id: "new", sequence: 37, title: "37. 噩梦与相伴 | 哥斯拉" },
      { id: "c", sequence: 38, title: "38. 下一章 | 摩斯拉" }
    ]);
    expect(planAutoNumberedTitles(chapters, "b", "37. 已经手写", "dot")).toEqual([]);
  });

  it("分卷重排从已有起始序号连续编号，不猜测其他分卷", () => {
    expect(inferVolumeNumberStart(["序章", "36. 拜访孤爪 | 摩斯拉"])).toBe(35);
    const plan = planVolumeTitleRenumber([
      { id: "a", title: "36. 拜访孤爪 | 摩斯拉" },
      { id: "b", title: "偷偷去找她 | 哥斯拉" },
      { id: "c", title: "37. 下一章 | 摩斯拉" }
    ], "chapter-arabic");
    expect(plan.startAt).toBe(36);
    expect(plan.updates.map((item) => item.title)).toEqual([
      "第36章 拜访孤爪 | 摩斯拉",
      "第37章 偷偷去找她 | 哥斯拉",
      "第38章 下一章 | 摩斯拉"
    ]);
  });
});

function parseChineseRoundTrip(value: number): number | null {
  return parseChapterTitleNumber(`第${formatChapterNumber(value, "chinese")}章`)?.number ?? null;
}
