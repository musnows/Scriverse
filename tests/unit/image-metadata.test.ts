import { describe, expect, it } from "vitest";
import { InvalidRasterImageError, readRasterImageMetadata } from "../../src/image-metadata.js";

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(45);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(0, 33);
  bytes.write("IEND", 37, "ascii");
  return bytes;
}

function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x07, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0xff, 0xd9
  ]);
}

function webpLossless(width: number, height: number): Buffer {
  const widthBits = width - 1;
  const heightBits = height - 1;
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBPVP8L", 8, "ascii");
  bytes.writeUInt32LE(5, 16);
  bytes[20] = 0x2f;
  bytes[21] = widthBits & 0xff;
  bytes[22] = ((widthBits >> 8) & 0x3f) | ((heightBits & 0x03) << 6);
  bytes[23] = (heightBits >> 2) & 0xff;
  bytes[24] = (heightBits >> 10) & 0x0f;
  return bytes;
}

describe("图片元数据校验", () => {
  it("读取 PNG、JPEG 和 WebP 的真实格式与尺寸", () => {
    expect(readRasterImageMetadata(png(640, 480))).toEqual({ mimeType: "image/png", width: 640, height: 480 });
    expect(readRasterImageMetadata(jpeg(320, 240))).toEqual({ mimeType: "image/jpeg", width: 320, height: 240 });
    expect(readRasterImageMetadata(webpLossless(1024, 768))).toEqual({ mimeType: "image/webp", width: 1024, height: 768 });
  });

  it("拒绝伪造扩展名、截断文件和超限尺寸", () => {
    expect(() => readRasterImageMetadata(Buffer.from("not an image"))).toThrow(InvalidRasterImageError);
    expect(() => readRasterImageMetadata(png(200, 200).subarray(0, 33))).toThrow(/缺少结束标记/u);
    expect(() => readRasterImageMetadata(png(4097, 100))).toThrow(/4096/u);
    expect(() => readRasterImageMetadata(jpeg(100, 100).subarray(0, -2))).toThrow(/不完整/u);
  });
});
