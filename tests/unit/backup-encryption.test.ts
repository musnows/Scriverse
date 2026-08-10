import { describe, expect, it } from "vitest";
import {
  BACKUP_ENCRYPTION_MAGIC,
  decryptObject,
  encryptObject,
  generateKek,
  isEncryptedEnvelope
} from "../../src/backup-encryption.js";

describe("S3 备份加密信封", () => {
  it("生成 256 位 KEK 并完成信封加解密往返", () => {
    const key = generateKek();
    const plaintext = Buffer.from("SQLite format 3\0backup payload");
    const envelope = encryptObject(plaintext, key);

    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(envelope.subarray(0, Buffer.byteLength(BACKUP_ENCRYPTION_MAGIC)).toString("ascii")).toBe(BACKUP_ENCRYPTION_MAGIC);
    expect(isEncryptedEnvelope(envelope)).toBe(true);
    expect(isEncryptedEnvelope(plaintext)).toBe(false);
    expect(envelope.includes(plaintext)).toBe(false);
    expect(decryptObject(envelope, key)).toEqual(plaintext);
  });

  it("为同一明文使用不同的 DEK 与 IV", () => {
    const key = generateKek();
    const plaintext = Buffer.from("same backup object");
    const first = encryptObject(plaintext, key);
    const second = encryptObject(plaintext, key);

    expect(first).not.toEqual(second);
    expect(decryptObject(first, key)).toEqual(plaintext);
    expect(decryptObject(second, key)).toEqual(plaintext);
  });

  it("拒绝错误密钥、篡改密文和无效密钥格式", () => {
    const key = generateKek();
    const envelope = encryptObject(Buffer.from("protected backup"), key);
    const tampered = Buffer.from(envelope);
    tampered[tampered.byteLength - 1] = tampered.readUInt8(tampered.byteLength - 1) ^ 0xff;

    expect(() => decryptObject(envelope, generateKek())).toThrow(expect.objectContaining({ code: "BACKUP_DECRYPTION_FAILED" }));
    expect(() => decryptObject(tampered, key)).toThrow(expect.objectContaining({ code: "BACKUP_DECRYPTION_FAILED" }));
    expect(() => encryptObject(Buffer.from("backup"), "not-a-valid-key")).toThrow(expect.objectContaining({ code: "BACKUP_KEK_INVALID" }));
  });

  it("校验魔数、版本和信封长度", () => {
    const key = generateKek();
    const envelope = encryptObject(Buffer.from("versioned backup"), key);
    const wrongMagic = Buffer.from(envelope);
    wrongMagic[0] = wrongMagic.readUInt8(0) ^ 0xff;
    const wrongVersion = Buffer.from(envelope);
    wrongVersion[Buffer.byteLength(BACKUP_ENCRYPTION_MAGIC)] = 2;

    expect(() => decryptObject(Buffer.from("plain backup"), key)).toThrow(expect.objectContaining({ code: "BACKUP_ENVELOPE_INVALID" }));
    expect(() => decryptObject(wrongMagic, key)).toThrow(expect.objectContaining({ code: "BACKUP_ENVELOPE_INVALID" }));
    expect(() => decryptObject(wrongVersion, key)).toThrow(expect.objectContaining({ code: "BACKUP_ENVELOPE_UNSUPPORTED" }));
    expect(() => decryptObject(envelope.subarray(0, -1), key)).toThrow(expect.objectContaining({ code: "BACKUP_ENVELOPE_INVALID" }));
  });
});
