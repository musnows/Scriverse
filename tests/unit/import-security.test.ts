import { describe, expect, it } from "vitest";
import { decodeUtf8ImportedText } from "../../src/import-security.js";

describe("TXT 导入编码检查", () => {
  it("接受无 BOM 和带 BOM 的 UTF-8 文本", () => {
    expect(decodeUtf8ImportedText(Buffer.from("第一章 开始\n正文。", "utf8"))).toBe("第一章 开始\n正文。");
    expect(decodeUtf8ImportedText(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("第一章 开始", "utf8")
    ]))).toBe("第一章 开始");
  });

  it("拒绝 GBK、UTF-16 和非法 UTF-8 字节", () => {
    const invalidFiles = [
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
      Buffer.from([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]),
      Buffer.from([0xc3, 0x28])
    ];

    for (const content of invalidFiles) {
      expect(() => decodeUtf8ImportedText(content)).toThrowError(expect.objectContaining({
        status: 415,
        code: "INVALID_TEXT_ENCODING"
      }));
    }
  });
});
