import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { assertSafeDocxArchive } from "../../src/docx-security.js";

async function createDocx(documentXml = "<w:document><w:body><w:p>正文</w:p></w:body></w:document>"): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types></Types>");
  zip.file("_rels/.rels", "<Relationships></Relationships>");
  zip.file("word/document.xml", documentXml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
}

describe("DOCX 导入安全检查", () => {
  it("接受包含必要结构的普通 DOCX", async () => {
    const docx = await createDocx();
    expect(() => assertSafeDocxArchive(docx)).not.toThrow();
  });

  it("拒绝改成 docx 后缀的普通文件", () => {
    expect(() => assertSafeDocxArchive(Buffer.from("这不是 DOCX 文件"))).toThrowError(expect.objectContaining({
      status: 415,
      code: "INVALID_DOCX_FILE"
    }));
  });

  it("拒绝缺少 DOCX 必要结构的普通 ZIP", async () => {
    const zip = new JSZip();
    zip.file("notes.txt", "普通压缩包");
    const archive = await zip.generateAsync({ type: "nodebuffer" });

    expect(() => assertSafeDocxArchive(archive)).toThrowError(expect.objectContaining({
      status: 415,
      code: "INVALID_DOCX_FILE"
    }));
  });

  it("在解压前拒绝压缩比异常的 DOCX", async () => {
    const archive = await createDocx(`<w:document>${"A".repeat(2 * 1024 * 1024)}</w:document>`);

    expect(() => assertSafeDocxArchive(archive)).toThrowError(expect.objectContaining({
      status: 413,
      code: "UNSAFE_DOCX_ARCHIVE"
    }));
  });

  it("在实际展开达到上限时拒绝伪造解压大小的 DOCX", async () => {
    const archive = await createDocx(`<w:document>${"B".repeat(32 * 1024)}</w:document>`);
    let cursor = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    let patched = false;
    while (cursor >= 0 && cursor + 46 <= archive.length) {
      const nameLength = archive.readUInt16LE(cursor + 28);
      const extraLength = archive.readUInt16LE(cursor + 30);
      const commentLength = archive.readUInt16LE(cursor + 32);
      const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
      if (name === "word/document.xml") {
        archive.writeUInt32LE(1, cursor + 24);
        patched = true;
        break;
      }
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    expect(patched).toBe(true);

    expect(() => assertSafeDocxArchive(archive)).toThrowError(expect.objectContaining({
      status: 413,
      code: "UNSAFE_DOCX_ARCHIVE"
    }));
  });

  it("拒绝条目数量超过预算的 DOCX", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types></Types>");
    zip.file("_rels/.rels", "<Relationships></Relationships>");
    zip.file("word/document.xml", "<w:document></w:document>");
    for (let index = 0; index < 2_000; index += 1) zip.file(`word/items/${index}.xml`, "");
    const archive = await zip.generateAsync({ type: "nodebuffer" });

    expect(() => assertSafeDocxArchive(archive)).toThrowError(expect.objectContaining({
      status: 413,
      code: "UNSAFE_DOCX_ARCHIVE"
    }));
  });

  it("拒绝中央目录被截断的 DOCX", async () => {
    const archive = await createDocx();
    const truncated = archive.subarray(0, archive.length - 8);

    expect(() => assertSafeDocxArchive(truncated)).toThrowError(expect.objectContaining({
      status: 415,
      code: "INVALID_DOCX_FILE"
    }));
  });
});
