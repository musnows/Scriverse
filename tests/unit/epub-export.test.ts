import JSZip from "jszip";
import { buffer } from "node:stream/consumers";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createEpubArchive,
  EPUB_MIME_TYPE,
  epubContentDisposition,
  epubDownloadFileName
} from "../../src/epub-export.js";

let validWebp: Buffer;

async function generatedArchive(input: Parameters<typeof createEpubArchive>[0]): Promise<{ buffer: Buffer; zip: JSZip }> {
  const archive = await createEpubArchive({
    identifier: "urn:uuid:11111111-2222-4333-8444-555555555555",
    modifiedAt: "2026-08-12T13:00:00.000Z",
    ...input
  });
  const generated = await buffer(archive);
  return { buffer: generated, zip: await JSZip.loadAsync(generated) };
}

describe("EPUB 导出生成器", () => {
  beforeAll(async () => {
    const validPng = await sharp({
      create: { width: 8, height: 12, channels: 3, background: { r: 32, g: 64, b: 128 } }
    }).png().toBuffer();
    validWebp = await sharp(validPng).webp().toBuffer();
  });

  it("生成 EPUB 3 包、分卷目录和按顺序排列的章节", async () => {
    const { buffer, zip } = await generatedArchive({
      title: "北港 & <纪事>",
      author: "慕雪 & 合著者",
      description: "星海 <启航>",
      language: "zh-CN",
      volumes: [
        {
          title: "第一卷 <潮声>",
          chapters: [
            { title: "第一章 & 启航", content: "飞船驶离 <北港>。\r\n第二行。\n\n```ts\nconst tag = \"</script>\";\n```" },
            { title: "第二章", content: "后续正文。" }
          ]
        },
        { title: "空卷", chapters: [] }
      ]
    });

    expect(buffer.subarray(0, 4).readUInt32LE(0)).toBe(0x04034b50);
    expect(buffer.readUInt16LE(8)).toBe(0);
    const fileNameLength = buffer.readUInt16LE(26);
    const extraLength = buffer.readUInt16LE(28);
    expect(buffer.subarray(30, 30 + fileNameLength).toString("utf8")).toBe("mimetype");
    expect(extraLength).toBe(0);
    expect(buffer.subarray(30 + fileNameLength, 30 + fileNameLength + EPUB_MIME_TYPE.length).toString("utf8")).toBe(EPUB_MIME_TYPE);

    await expect(zip.file("mimetype")?.async("string")).resolves.toBe(EPUB_MIME_TYPE);
    await expect(zip.file("META-INF/container.xml")?.async("string")).resolves.toContain("OEBPS/package.opf");
    const packageXml = await zip.file("OEBPS/package.opf")?.async("string");
    expect(packageXml).toContain('version="3.0"');
    expect(packageXml).toContain("<dc:title>北港 &amp; &lt;纪事&gt;</dc:title>");
    expect(packageXml).toContain("<dc:creator>慕雪 &amp; 合著者</dc:creator>");
    expect(packageXml).toContain("<dc:description>星海 &lt;启航&gt;</dc:description>");
    expect(packageXml).toContain('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />');
    expect(packageXml).toContain('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />');
    expect(packageXml!.indexOf('idref="volume-001"')).toBeLessThan(packageXml!.indexOf('idref="chapter-001-001"'));
    expect(packageXml!.indexOf('idref="chapter-001-001"')).toBeLessThan(packageXml!.indexOf('idref="chapter-001-002"'));
    expect(packageXml!.indexOf('idref="chapter-001-002"')).toBeLessThan(packageXml!.indexOf('idref="volume-002"'));

    const nav = await zip.file("OEBPS/nav.xhtml")?.async("string");
    expect(nav).toContain('epub:type="toc"');
    expect(nav).toContain('href="text/volume-001.xhtml"');
    expect(nav).toContain('href="text/chapter-001-001.xhtml"');
    expect(nav).toContain('href="text/volume-002.xhtml"');
    const chapter = await zip.file("OEBPS/text/chapter-001-001.xhtml")?.async("string");
    expect(chapter).toContain("飞船驶离 &lt;北港&gt;。<br />\n第二行。");
    expect(chapter).toContain('<pre class="code-block"><code>const tag = &quot;&lt;/script&gt;&quot;;</code></pre>');
    expect(chapter).not.toContain("<script>");
    await expect(zip.file("OEBPS/text/volume-002.xhtml")?.async("string")).resolves.toContain("空卷");
  });

  it("无封面时不写入封面清单，有 WebP 封面时转成兼容的 PNG", async () => {
    const withoutCover = await generatedArchive({ title: "无封面", volumes: [] });
    const plainPackage = await withoutCover.zip.file("OEBPS/package.opf")?.async("string");
    expect(plainPackage).not.toContain("cover-image");
    expect(Object.keys(withoutCover.zip.files).some((name) => name.startsWith("OEBPS/images/"))).toBe(false);
    await expect(withoutCover.zip.file("OEBPS/nav.xhtml")?.async("string")).resolves.toContain('href="text/title.xhtml"');
    await expect(withoutCover.zip.file("OEBPS/toc.ncx")?.async("string")).resolves.toContain('id="title-page"');

    const withCover = await generatedArchive({
      title: "WebP 封面",
      volumes: [{ title: "正文", chapters: [] }],
      cover: { mimeType: "image/webp", content: validWebp }
    });
    const coverBytes = await withCover.zip.file("OEBPS/images/cover.png")?.async("nodebuffer");
    expect(coverBytes?.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    const coverPackage = await withCover.zip.file("OEBPS/package.opf")?.async("string");
    expect(coverPackage).toContain('properties="cover-image"');
    expect(coverPackage).toContain('href="text/cover.xhtml"');
    await expect(withCover.zip.file("OEBPS/text/cover.xhtml")?.async("string")).resolves.toContain('../images/cover.png');
  });

  it("完整保留接近章节上限的长正文", async () => {
    const longContent = `开头 <标签>。\n${"星海中的长段落 & 航线。\n".repeat(80_000)}结尾。`;
    const { zip } = await generatedArchive({
      title: "长篇测试",
      volumes: [{ title: "正文", chapters: [{ title: "长章节", content: longContent }] }]
    });
    const chapter = await zip.file("OEBPS/text/chapter-001-001.xhtml")?.async("string");
    expect(chapter).toContain("开头 &lt;标签&gt;。");
    expect(chapter).toContain("星海中的长段落 &amp; 航线。");
    expect(chapter).toContain("结尾。");
    expect(chapter).not.toContain("<标签>");
  });

  it("消费到对应 ZIP 条目时才读取章节，并在读取失败后停止", async () => {
    const reads: string[] = [];
    const archive = await createEpubArchive({
      title: "按章读取",
      identifier: "urn:uuid:11111111-2222-4333-8444-555555555555",
      modifiedAt: "2026-08-12T13:00:00.000Z",
      volumes: [{
        title: "正文",
        chapters: [
          { title: "第一章", content: () => { reads.push("first"); return "第一章正文"; } },
          { title: "第二章", content: () => { reads.push("second"); throw new Error("chapter read failed"); } },
          { title: "第三章", content: () => { reads.push("third"); return "不应读取"; } }
        ]
      }]
    });

    expect(reads).toEqual([]);
    await expect(buffer(archive)).rejects.toThrow("chapter read failed");
    expect(reads).toEqual(["first", "second"]);
  });

  it("下游断开时不继续读取尚未写出的章节", async () => {
    const reads: string[] = [];
    const archive = await createEpubArchive({
      title: "中断导出",
      identifier: "urn:uuid:11111111-2222-4333-8444-555555555555",
      modifiedAt: "2026-08-12T13:00:00.000Z",
      volumes: [{
        title: "正文",
        chapters: Array.from({ length: 20 }, (_, index) => ({
          title: `第${index + 1}章`,
          content: () => { reads.push(String(index)); return "正文".repeat(10_000); }
        }))
      }]
    });
    const disconnected = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("client disconnected"));
      }
    });

    await expect(pipeline(archive, disconnected)).rejects.toThrow("client disconnected");
    expect(reads).toEqual([]);
  });

  it("安全生成中文下载文件名和回退响应头", () => {
    expect(epubDownloadFileName(" ../北港\r\n纪事\\终章?. ")).toBe("北港 纪事 终章.epub");
    const disposition = epubContentDisposition("../北港\r\n纪事", "novel-../../work\r\nX-Test");
    expect(disposition).toMatch(/^attachment; filename="novel-work-X-Test\.epub"; filename\*=UTF-8''/u);
    expect(disposition).toContain("%E5%8C%97%E6%B8%AF");
    expect(disposition).not.toMatch(/[\r\n]/u);
    expect(disposition).not.toContain("../");
  });
});
