import { describe, expect, it } from "vitest";
import { applyImportFileHints, parseNovelText } from "../../src/parser.js";
import { countWords } from "../../src/utils.js";

describe("小说结构解析", () => {
  it("严格按正文中的明确卷标题切分章节", () => {
    const result = parseNovelText(`第一卷 起航
第一章 初见
林舟在北港醒来。
第二章 冲突
警报响起。
第二卷 深空
第三章 跃迁
飞船进入跃迁。`);

    expect(result.volumes).toHaveLength(2);
    expect(result.volumes[0]).toMatchObject({ title: "第一卷 起航", source: "explicit" });
    expect(result.volumes[0]?.chapters.map((chapter) => chapter.title)).toEqual(["第一章 初见", "第二章 冲突"]);
    expect(result.volumes[0]?.chapters[1]?.content).toBe("警报响起。");
    expect(result.volumes[1]?.chapters[0]?.content).toBe("飞船进入跃迁。");
  });

  it("没有卷标题时保留单一默认卷，不进行 AI 自动分卷", () => {
    const result = parseNovelText(`第一章 开端
旧城下起了雨。
第二章 来客
陌生人敲响门。`);

    expect(result.volumes).toHaveLength(1);
    expect(result.volumes[0]).toMatchObject({ title: "正文", source: "default" });
    expect(result.volumes[0]?.chapters).toHaveLength(2);
    expect(result.warnings).toContain("未检测到明确卷标题，内容保留在默认卷中");
  });

  it("忽略目录中的重复卷章标题，只使用正文标题切分", () => {
    const result = parseNovelText(`目录
第一卷 起航
第一章 初见
第二卷 深空
第二章 跃迁

第一卷 起航
第一章 初见
林舟醒来。
第二卷 深空
第二章 跃迁
飞船离港。`);

    expect(result.volumes).toHaveLength(2);
    expect(result.volumes[0]?.chapters).toHaveLength(1);
    expect(result.volumes[0]?.chapters[0]?.content).toBe("林舟醒来。");
    expect(result.volumes[1]?.chapters[0]?.content).toBe("飞船离港。");
  });

  it("忽略文件中部带页码的长目录，并保留后续正文卷章", () => {
    const result = parseNovelText(`第一章 前传开端
旧世界的故事。
目录
作品标题\t1
第一卷 归来\t10
第一章 重返地表\t12
资料附录\t15
第二卷 邻居\t20
第二章 初遇\t22

第一卷 归来
第一章 重返地表
哥斯拉苏醒。
第二卷 邻居
第二章 初遇
舰队发现新文明。`);

    expect(result.volumes.map((volume) => volume.title)).toEqual(["未归属内容", "第一卷 归来", "第二卷 邻居"]);
    expect(result.volumes.flatMap((volume) => volume.chapters).map((chapter) => chapter.title)).toEqual([
      "第一章 前传开端",
      "第一章 重返地表",
      "第二章 初遇"
    ]);
    expect(result.warnings.some((warning) => warning.includes("已忽略目录"))).toBe(true);
  });

  it("根据含前传文件名标记首个未分卷内容", () => {
    const parsed = applyImportFileHints(parseNovelText(`第一章 旧日
前传正文。
第一卷 归来
第一章 新章
主线正文。`), "作品（含前传）.txt");

    expect(parsed.volumes[0]).toMatchObject({ title: "前传", kind: "prequel", source: "default" });
    expect(parsed.warnings).toContain("根据文件名将首个未分卷内容识别为前传");
  });

  it("不会把以章节号开头的正文句子误判为标题", () => {
    const parsed = parseNovelText(`第一章 回忆录
第一章放出之后，引发了人们激烈的讨论。
故事仍在继续。`);

    expect(parsed.volumes[0]?.chapters).toHaveLength(1);
    expect(parsed.volumes[0]?.chapters[0]?.content).toContain("第一章放出之后");
  });

  it("将前传和番外识别为分卷，并把后记留在当前分卷中", () => {
    const result = parseNovelText(`前传 风暴前夜
第一章 信号
信号来自深空。
番外 旧照片
第二章 往事
照片已经褪色。
后记
第三章 归航
他们回到了家。`);

    expect(result.volumes.map((volume) => volume.kind)).toEqual(["prequel", "extra"]);
    expect(result.volumes[1]?.chapters.map((chapter) => chapter.title)).toEqual(["第二章 往事", "后记", "第三章 归航"]);
    expect(result.volumes[1]?.chapters[1]).toMatchObject({ title: "后记", chapterType: "作者的话" });
  });

  it("不会把流浪地球正文末尾的后记拆成独立分卷", () => {
    const result = parseNovelText(`第一卷 流浪地球
第一章 刹车时代
地球发动机点燃。
第二章 逃逸时代
地球离开太阳。
后记
感谢读者陪伴这段旅程。`);

    expect(result.volumes).toHaveLength(1);
    expect(result.volumes[0]?.title).toBe("第一卷 流浪地球");
    expect(result.volumes[0]?.chapters.map((chapter) => chapter.title)).toEqual(["第一章 刹车时代", "第二章 逃逸时代", "后记"]);
    expect(result.volumes[0]?.chapters[2]).toMatchObject({ chapterType: "作者的话", content: "感谢读者陪伴这段旅程。" });
  });

  it("统计中文字符和拉丁词", () => {
    expect(countWords("你好，world 2026")) .toBe(4);
  });
});
