import { AppError } from "./errors.js";
import { inflateRawSync } from "node:zlib";

const localFileHeaderSignature = 0x04034b50;
const centralDirectoryHeaderSignature = 0x02014b50;
const endOfCentralDirectorySignature = 0x06054b50;
const zip64ExtraFieldId = 0x0001;
const maximumZipCommentLength = 0xffff;
const maximumDocxEntries = 2_000;
const maximumDocxEntrySize = 96 * 1024 * 1024;
const maximumDocxExpandedSize = 128 * 1024 * 1024;
const maximumDocxCompressionRatio = 200;
const requiredDocxEntries = ["[Content_Types].xml", "_rels/.rels", "word/document.xml"] as const;

function invalidDocx(): never {
  throw new AppError(415, "INVALID_DOCX_FILE", "文件内容不是有效的 DOCX 文档");
}

function unsafeDocx(): never {
  throw new AppError(413, "UNSAFE_DOCX_ARCHIVE", "DOCX 压缩包展开规模超过安全限制");
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimumRecordLength = 22;
  if (buffer.length < minimumRecordLength) invalidDocx();
  const minimumOffset = Math.max(0, buffer.length - minimumRecordLength - maximumZipCommentLength);
  for (let offset = buffer.length - minimumRecordLength; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== endOfCentralDirectorySignature) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + minimumRecordLength + commentLength === buffer.length) return offset;
  }
  return invalidDocx();
}

function decodeEntryName(buffer: Buffer, offset: number, length: number): string {
  const name = buffer.subarray(offset, offset + length).toString("utf8");
  if (!name || name.includes("\uFFFD") || name.includes("\0")) invalidDocx();
  return name;
}

function assertSafeEntryName(name: string): void {
  const normalized = name.replace(/\\/gu, "/");
  if (normalized !== name || normalized.startsWith("/") || normalized.split("/").includes("..")) invalidDocx();
}

function assertNoZip64Extra(buffer: Buffer, offset: number, length: number): void {
  const end = offset + length;
  let cursor = offset;
  while (cursor < end) {
    if (cursor + 4 > end) invalidDocx();
    const fieldId = buffer.readUInt16LE(cursor);
    const fieldLength = buffer.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + fieldLength > end) invalidDocx();
    if (fieldId === zip64ExtraFieldId) invalidDocx();
    cursor += fieldLength;
  }
}

function assertLocalEntry(
  buffer: Buffer,
  centralDirectoryOffset: number,
  localHeaderOffset: number,
  expectedName: string,
  expectedMethod: number,
  compressedSize: number
): number {
  if (localHeaderOffset < 0 || localHeaderOffset + 30 > centralDirectoryOffset) invalidDocx();
  if (buffer.readUInt32LE(localHeaderOffset) !== localFileHeaderSignature) invalidDocx();
  const flags = buffer.readUInt16LE(localHeaderOffset + 6);
  const method = buffer.readUInt16LE(localHeaderOffset + 8);
  const fileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraFieldLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const nameOffset = localHeaderOffset + 30;
  const dataOffset = nameOffset + fileNameLength + extraFieldLength;
  if (dataOffset > centralDirectoryOffset || (flags & 0x0001) !== 0 || method !== expectedMethod || dataOffset + compressedSize > centralDirectoryOffset) invalidDocx();
  if (decodeEntryName(buffer, nameOffset, fileNameLength) !== expectedName) invalidDocx();
  assertNoZip64Extra(buffer, nameOffset + fileNameLength, extraFieldLength);
  return dataOffset;
}

function isOutputLimitError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE";
}

function measureExpandedEntry(
  buffer: Buffer,
  dataOffset: number,
  compressedSize: number,
  declaredSize: number,
  method: number,
  expandedSoFar: number
): number {
  if (method === 0) return compressedSize;
  const remainingBudget = maximumDocxExpandedSize - expandedSoFar;
  const outputLimit = Math.min(maximumDocxEntrySize, remainingBudget, declaredSize + 1);
  if (outputLimit <= 0) unsafeDocx();
  try {
    return inflateRawSync(buffer.subarray(dataOffset, dataOffset + compressedSize), { maxOutputLength: outputLimit }).byteLength;
  } catch (error) {
    if (isOutputLimitError(error)) unsafeDocx();
    return invalidDocx();
  }
}

/**
 * 在交给 DOCX 解析器前检查 ZIP 目录和展开预算，阻止伪造后缀及常见 ZIP 炸弹。
 * ZIP64 在当前 30MB 上传上限内没有必要，为避免大小字段歧义而明确拒绝。
 */
export function assertSafeDocxArchive(buffer: Buffer): void {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== localFileHeaderSignature) invalidDocx();
  const endOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(endOffset + 6);
  const diskEntryCount = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(endOffset + 16);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntryCount !== entryCount) invalidDocx();
  if (entryCount === 0 || entryCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) invalidDocx();
  if (entryCount > maximumDocxEntries) unsafeDocx();
  if (centralDirectoryOffset + centralDirectorySize !== endOffset) invalidDocx();

  const entryNames = new Set<string>();
  const nonEmptyEntries = new Set<string>();
  let declaredExpandedSize = 0;
  let actualExpandedSize = 0;
  let cursor = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset || buffer.readUInt32LE(cursor) !== centralDirectoryHeaderSignature) invalidDocx();
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraFieldLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const nameOffset = cursor + 46;
    const nextOffset = nameOffset + fileNameLength + extraFieldLength + commentLength;
    if (nextOffset > endOffset || diskStart !== 0 || localHeaderOffset === 0xffffffff) invalidDocx();
    if ((flags & 0x0001) !== 0 || ![0, 8].includes(method)) invalidDocx();
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) invalidDocx();

    const name = decodeEntryName(buffer, nameOffset, fileNameLength);
    assertSafeEntryName(name);
    if (entryNames.has(name)) invalidDocx();
    entryNames.add(name);
    assertNoZip64Extra(buffer, nameOffset + fileNameLength, extraFieldLength);

    const directory = name.endsWith("/");
    if (directory && (compressedSize !== 0 || uncompressedSize !== 0)) invalidDocx();
    if (!directory) {
      if (method === 0 && compressedSize !== uncompressedSize) invalidDocx();
      if (uncompressedSize > 0 && compressedSize === 0) unsafeDocx();
      if (uncompressedSize > maximumDocxEntrySize) unsafeDocx();
      if (compressedSize > 0 && uncompressedSize / compressedSize > maximumDocxCompressionRatio) unsafeDocx();
      declaredExpandedSize += uncompressedSize;
      if (declaredExpandedSize > maximumDocxExpandedSize) unsafeDocx();
      if (uncompressedSize > 0) nonEmptyEntries.add(name);
    }

    const dataOffset = assertLocalEntry(buffer, centralDirectoryOffset, localHeaderOffset, name, method, compressedSize);
    if (!directory) {
      const actualSize = measureExpandedEntry(buffer, dataOffset, compressedSize, uncompressedSize, method, actualExpandedSize);
      if (actualSize !== uncompressedSize) invalidDocx();
      actualExpandedSize += actualSize;
      if (actualExpandedSize > maximumDocxExpandedSize) unsafeDocx();
    }
    cursor = nextOffset;
  }

  if (cursor !== endOffset) invalidDocx();
  if (!requiredDocxEntries.every((name) => nonEmptyEntries.has(name))) invalidDocx();
}
