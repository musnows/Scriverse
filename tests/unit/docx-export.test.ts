import JSZip from "jszip";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { exportWorkDocx } from "../../src/docx-export.js";

let validPng: Buffer;
let validWebp: Buffer;
const validGif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

async function loadDocumentXml(buffer: Buffer): Promise<{ archive: JSZip; documentXml: string }> {
  const archive = await JSZip.loadAsync(buffer);
  const documentXml = await archive.file("word/document.xml")?.async("string");
  expect(documentXml).toBeTruthy();
  return { archive, documentXml: documentXml! };
}

describe("exportWorkDocx", () => {
  beforeAll(async () => {
    validPng = await sharp({
      create: { width: 8, height: 12, channels: 3, background: { r: 32, g: 64, b: 128 } }
    }).png().toBuffer();
    validWebp = await sharp(validPng).webp().toBuffer();
  });

  it("按书名、分卷、章节生成三级标题并保留正文换行", async () => {
    const buffer = await exportWorkDocx({
      title: "北港纪事",
      volumes: [
        {
          title: "第一卷",
          chapters: [
            {
              title: "第一章 启航",
              content: "飞船驶离北港。\n\n星图重新点亮。"
            }
          ]
        }
      ]
    });

    const { archive, documentXml } = await loadDocumentXml(buffer);
    expect(Object.keys(archive.files).some((name) => name.startsWith("word/media/"))).toBe(false);
    expect(documentXml).toContain('w:val="Heading1"');
    expect(documentXml).toContain("北港纪事");
    expect(documentXml).toContain('w:val="Heading2"');
    expect(documentXml).toContain("第一卷");
    expect(documentXml).toContain('w:val="Heading3"');
    expect(documentXml).toContain("第一章 启航");
    expect(documentXml).toContain("飞船驶离北港。");
    expect(documentXml).toContain("星图重新点亮。");
  });

  it("有 PNG 封面时嵌入首页图片并分页", async () => {
    const buffer = await exportWorkDocx({
      title: "封面书",
      volumes: [{ title: "卷一", chapters: [{ title: "章一", content: "正文。" }] }],
      cover: { mimeType: "image/png", content: validPng }
    });

    const { archive, documentXml } = await loadDocumentXml(buffer);
    const mediaEntry = Object.entries(archive.files).find(([name, file]) => /^word\/media\/[^/]+$/u.test(name) && !file.dir);
    expect(mediaEntry).toBeTruthy();
    expect(documentXml).toMatch(/<a:blip\b/u);
    expect(documentXml).toContain("w:br");
    expect(documentXml).toContain("封面书");
  });

  it("WebP 封面转码为 PNG 后可嵌入", async () => {
    const buffer = await exportWorkDocx({
      title: "WebP 封面书",
      volumes: [{ title: "卷一", chapters: [{ title: "章一", content: "正文。" }] }],
      cover: { mimeType: "image/webp", content: validWebp }
    });

    const { archive, documentXml } = await loadDocumentXml(buffer);
    const mediaEntry = Object.entries(archive.files).find(([name, file]) => /^word\/media\/[^/]+$/u.test(name) && !file.dir);
    expect(mediaEntry).toBeTruthy();
    const media = await mediaEntry![1].async("nodebuffer");
    expect(media.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(documentXml).toContain("WebP 封面书");
  });

  it("GIF 封面转码为 PNG 后可嵌入", async () => {
    const buffer = await exportWorkDocx({
      title: "GIF 封面书",
      volumes: [{ title: "卷一", chapters: [{ title: "章一", content: "正文。" }] }],
      cover: { mimeType: "image/gif", content: validGif }
    });

    const { archive, documentXml } = await loadDocumentXml(buffer);
    const mediaEntry = Object.entries(archive.files).find(([name, file]) => /^word\/media\/[^/]+$/u.test(name) && !file.dir);
    expect(mediaEntry).toBeTruthy();
    const media = await mediaEntry![1].async("nodebuffer");
    expect(media.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(documentXml).toContain("GIF 封面书");
  });
});
