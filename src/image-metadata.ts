export type RasterImageMetadata = {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
};

export class InvalidRasterImageError extends Error {
  constructor(message = "图片文件无效") {
    super(message);
    this.name = "InvalidRasterImageError";
  }
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new InvalidRasterImageError("图片尺寸无效");
  }
  if (width > 4096 || height > 4096 || width * height > 16_777_216) {
    throw new InvalidRasterImageError("图片尺寸不能超过 4096 × 4096 像素");
  }
}

function readPng(bytes: Buffer): RasterImageMetadata | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < signature.length || !bytes.subarray(0, signature.length).equals(signature)) return null;
  if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new InvalidRasterImageError("PNG 文件缺少有效的 IHDR 数据");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  let offset = 8;
  let hasEndChunk = false;
  while (offset + 12 <= bytes.length) {
    const chunkLength = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + chunkLength;
    if (chunkEnd > bytes.length) throw new InvalidRasterImageError("PNG 文件结构不完整");
    const chunkType = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (chunkType === "IEND") {
      if (chunkLength !== 0) throw new InvalidRasterImageError("PNG 文件的 IEND 数据无效");
      hasEndChunk = true;
      break;
    }
    offset = chunkEnd;
  }
  if (!hasEndChunk) throw new InvalidRasterImageError("PNG 文件缺少结束标记");
  assertDimensions(width, height);
  return { mimeType: "image/png", width, height };
}

const jpegStartOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function readJpeg(bytes: Buffer): RasterImageMetadata | null {
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  if (bytes.length < 4 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new InvalidRasterImageError("JPEG 文件结构不完整");
  }
  let offset = 2;
  while (offset + 1 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      throw new InvalidRasterImageError("JPEG 文件段长度无效");
    }
    if (jpegStartOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) throw new InvalidRasterImageError("JPEG 尺寸数据无效");
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      assertDimensions(width, height);
      return { mimeType: "image/jpeg", width, height };
    }
    if (marker === 0xda) break;
    offset += segmentLength;
  }
  throw new InvalidRasterImageError("JPEG 文件缺少尺寸数据");
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function readWebp(bytes: Buffer): RasterImageMetadata | null {
  if (bytes.length < 12 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WEBP") return null;
  const declaredLength = bytes.readUInt32LE(4) + 8;
  if (declaredLength > bytes.length || declaredLength < 30) throw new InvalidRasterImageError("WebP 文件结构不完整");
  const chunkType = bytes.subarray(12, 16).toString("ascii");
  const chunkLength = bytes.readUInt32LE(16);
  if (20 + chunkLength > declaredLength) throw new InvalidRasterImageError("WebP 图像块不完整");
  let width: number;
  let height: number;
  if (chunkType === "VP8X") {
    if (chunkLength < 10) throw new InvalidRasterImageError("WebP 扩展头无效");
    width = readUInt24LE(bytes, 24) + 1;
    height = readUInt24LE(bytes, 27) + 1;
  } else if (chunkType === "VP8 ") {
    if (chunkLength < 10 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      throw new InvalidRasterImageError("WebP 有损图像头无效");
    }
    width = bytes.readUInt16LE(26) & 0x3fff;
    height = bytes.readUInt16LE(28) & 0x3fff;
  } else if (chunkType === "VP8L") {
    if (chunkLength < 5 || bytes[20] !== 0x2f) throw new InvalidRasterImageError("WebP 无损图像头无效");
    width = 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8);
    height = 1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10);
  } else {
    throw new InvalidRasterImageError("WebP 文件缺少受支持的图像块");
  }
  assertDimensions(width, height);
  return { mimeType: "image/webp", width, height };
}

export function readRasterImageMetadata(bytes: Buffer): RasterImageMetadata {
  const metadata = readPng(bytes) ?? readJpeg(bytes) ?? readWebp(bytes);
  if (!metadata) throw new InvalidRasterImageError("仅支持 PNG、JPEG 或 WebP 图片");
  return metadata;
}
