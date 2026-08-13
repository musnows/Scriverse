import { Readable } from "node:stream";
import { createDeflateRaw } from "node:zlib";

export type ZipStreamEntry = {
  name: string;
  content: string | Buffer | (() => string | Buffer);
  compression?: "STORE" | "DEFLATE";
};

type CentralDirectoryEntry = {
  name: Buffer;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
};

const ZIP32_MAX = 0xffff_ffff;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb8_8320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(content: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of content) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffff_ffff) >>> 0;
}

function dosTimestamp(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function assertZip32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > ZIP32_MAX) {
    throw new Error(`ZIP32_LIMIT_EXCEEDED: ${label}`);
  }
}

function localHeader(input: CentralDirectoryEntry, streamed: boolean): Buffer {
  const header = Buffer.allocUnsafe(30 + input.name.length);
  header.writeUInt32LE(0x0403_4b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(input.flags, 6);
  header.writeUInt16LE(input.method, 8);
  header.writeUInt16LE(input.dosTime, 10);
  header.writeUInt16LE(input.dosDate, 12);
  header.writeUInt32LE(streamed ? 0 : input.crc, 14);
  header.writeUInt32LE(streamed ? 0 : input.compressedSize, 18);
  header.writeUInt32LE(streamed ? 0 : input.uncompressedSize, 22);
  header.writeUInt16LE(input.name.length, 26);
  header.writeUInt16LE(0, 28);
  input.name.copy(header, 30);
  return header;
}

function dataDescriptor(input: CentralDirectoryEntry): Buffer {
  const descriptor = Buffer.allocUnsafe(16);
  descriptor.writeUInt32LE(0x0807_4b50, 0);
  descriptor.writeUInt32LE(input.crc, 4);
  descriptor.writeUInt32LE(input.compressedSize, 8);
  descriptor.writeUInt32LE(input.uncompressedSize, 12);
  return descriptor;
}

function centralHeader(input: CentralDirectoryEntry): Buffer {
  const header = Buffer.allocUnsafe(46 + input.name.length);
  header.writeUInt32LE(0x0201_4b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(input.flags, 8);
  header.writeUInt16LE(input.method, 10);
  header.writeUInt16LE(input.dosTime, 12);
  header.writeUInt16LE(input.dosDate, 14);
  header.writeUInt32LE(input.crc, 16);
  header.writeUInt32LE(input.compressedSize, 20);
  header.writeUInt32LE(input.uncompressedSize, 24);
  header.writeUInt16LE(input.name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(input.offset, 42);
  input.name.copy(header, 46);
  return header;
}

function endOfCentralDirectory(entryCount: number, centralSize: number, centralOffset: number): Buffer {
  if (entryCount > 0xffff) throw new Error("ZIP32_LIMIT_EXCEEDED: entry count");
  const footer = Buffer.allocUnsafe(22);
  footer.writeUInt32LE(0x0605_4b50, 0);
  footer.writeUInt16LE(0, 4);
  footer.writeUInt16LE(0, 6);
  footer.writeUInt16LE(entryCount, 8);
  footer.writeUInt16LE(entryCount, 10);
  footer.writeUInt32LE(centralSize, 12);
  footer.writeUInt32LE(centralOffset, 16);
  footer.writeUInt16LE(0, 20);
  return footer;
}

async function* generateZip(entries: readonly ZipStreamEntry[], date: Date): AsyncGenerator<Buffer> {
  const directory: CentralDirectoryEntry[] = [];
  const timestamp = dosTimestamp(date);
  let offset = 0;

  const tracked = (chunk: Buffer): Buffer => {
    offset += chunk.length;
    assertZip32(offset, "archive offset");
    return chunk;
  };

  for (const source of entries) {
    const name = Buffer.from(source.name, "utf8");
    if (name.length > 0xffff) throw new Error("ZIP32_LIMIT_EXCEEDED: file name");
    const resolved = typeof source.content === "function" ? source.content() : source.content;
    const content = Buffer.isBuffer(resolved) ? resolved : Buffer.from(resolved, "utf8");
    assertZip32(content.length, "entry size");
    const streamed = source.compression !== "STORE";
    const record: CentralDirectoryEntry = {
      name,
      flags: UTF8_FLAG | (streamed ? DATA_DESCRIPTOR_FLAG : 0),
      method: streamed ? 8 : 0,
      ...timestamp,
      crc: crc32(content),
      compressedSize: streamed ? 0 : content.length,
      uncompressedSize: content.length,
      offset
    };
    yield tracked(localHeader(record, streamed));
    if (!streamed) {
      yield tracked(content);
    } else {
      const compressor = createDeflateRaw({ level: 6 });
      try {
        compressor.end(content);
        for await (const chunk of compressor) {
          const compressed = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          record.compressedSize += compressed.length;
          assertZip32(record.compressedSize, "compressed entry size");
          yield tracked(compressed);
        }
      } finally {
        compressor.destroy();
      }
      yield tracked(dataDescriptor(record));
    }
    directory.push(record);
  }

  const centralOffset = offset;
  for (const entry of directory) yield tracked(centralHeader(entry));
  const centralSize = offset - centralOffset;
  assertZip32(centralSize, "central directory size");
  yield endOfCentralDirectory(directory.length, centralSize, centralOffset);
}

export function createZipStream(entries: readonly ZipStreamEntry[], date: Date): Readable {
  return Readable.from(generateZip(entries, date), { objectMode: false });
}
