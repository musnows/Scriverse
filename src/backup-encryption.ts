import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "./errors.js";

export const BACKUP_ENCRYPTION_MAGIC = "SCRIVERSE-ENC1";

const magic = Buffer.from(BACKUP_ENCRYPTION_MAGIC, "ascii");
const envelopeVersion = 1;
const aes256GcmAlgorithm = 1;
const dekLength = 32;
const ivLength = 12;
const authTagLength = 16;
const headerLength = magic.byteLength + 16;

function parseKek(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new AppError(400, "BACKUP_KEK_INVALID", "S3 备份加密密钥格式无效");
  }
  const key = Buffer.from(value, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== value) {
    throw new AppError(400, "BACKUP_KEK_INVALID", "S3 备份加密密钥格式无效");
  }
  return key;
}

function envelopeHeader(ciphertextLength: number): Buffer {
  const header = Buffer.alloc(headerLength);
  magic.copy(header, 0);
  let offset = magic.byteLength;
  header.writeUInt8(envelopeVersion, offset++);
  header.writeUInt8(aes256GcmAlgorithm, offset++);
  header.writeUInt8(ivLength, offset++);
  header.writeUInt8(authTagLength, offset++);
  header.writeUInt8(ivLength, offset++);
  header.writeUInt8(authTagLength, offset++);
  header.writeUInt16BE(dekLength, offset);
  offset += 2;
  header.writeBigUInt64BE(BigInt(ciphertextLength), offset);
  return header;
}

export function generateKek(): string {
  return randomBytes(32).toString("base64url");
}

export function isEncryptedEnvelope(value: Buffer): boolean {
  return value.byteLength >= magic.byteLength && value.subarray(0, magic.byteLength).equals(magic);
}

export function encryptObject(plaintext: Buffer, kek: string): Buffer {
  const key = parseKek(kek);
  const dek = randomBytes(dekLength);
  const wrappingIv = randomBytes(ivLength);
  const payloadIv = randomBytes(ivLength);
  const header = envelopeHeader(plaintext.byteLength);

  const keyCipher = createCipheriv("aes-256-gcm", key, wrappingIv);
  keyCipher.setAAD(header);
  const wrappedDek = Buffer.concat([keyCipher.update(dek), keyCipher.final()]);
  const keyTag = keyCipher.getAuthTag();

  const payloadCipher = createCipheriv("aes-256-gcm", dek, payloadIv);
  payloadCipher.setAAD(header);
  const ciphertext = Buffer.concat([payloadCipher.update(plaintext), payloadCipher.final()]);
  const payloadTag = payloadCipher.getAuthTag();

  return Buffer.concat([
    header,
    wrappingIv,
    keyTag,
    payloadIv,
    payloadTag,
    wrappedDek,
    ciphertext
  ]);
}

export function decryptObject(envelope: Buffer, kek: string): Buffer {
  if (envelope.byteLength < headerLength || !isEncryptedEnvelope(envelope)) {
    throw new AppError(400, "BACKUP_ENVELOPE_INVALID", "备份对象不是 Scriverse 加密信封");
  }

  const header = envelope.subarray(0, headerLength);
  let offset = magic.byteLength;
  const version = header.readUInt8(offset++);
  const algorithm = header.readUInt8(offset++);
  const wrappingIvLength = header.readUInt8(offset++);
  const wrappingTagLength = header.readUInt8(offset++);
  const payloadIvLength = header.readUInt8(offset++);
  const payloadTagLength = header.readUInt8(offset++);
  const wrappedDekLength = header.readUInt16BE(offset);
  offset += 2;
  const ciphertextLengthBigInt = header.readBigUInt64BE(offset);
  if (ciphertextLengthBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError(400, "BACKUP_ENVELOPE_INVALID", "备份加密信封长度无效");
  }
  const ciphertextLength = Number(ciphertextLengthBigInt);
  if (
    version !== envelopeVersion
    || algorithm !== aes256GcmAlgorithm
    || wrappingIvLength !== ivLength
    || wrappingTagLength !== authTagLength
    || payloadIvLength !== ivLength
    || payloadTagLength !== authTagLength
    || wrappedDekLength !== dekLength
  ) {
    throw new AppError(400, "BACKUP_ENVELOPE_UNSUPPORTED", "备份加密信封版本或算法不受支持");
  }

  const expectedLength = headerLength
    + wrappingIvLength
    + wrappingTagLength
    + payloadIvLength
    + payloadTagLength
    + wrappedDekLength
    + ciphertextLength;
  if (expectedLength !== envelope.byteLength) {
    throw new AppError(400, "BACKUP_ENVELOPE_INVALID", "备份加密信封长度无效");
  }

  let bodyOffset = headerLength;
  const wrappingIv = envelope.subarray(bodyOffset, bodyOffset += wrappingIvLength);
  const wrappingTag = envelope.subarray(bodyOffset, bodyOffset += wrappingTagLength);
  const payloadIv = envelope.subarray(bodyOffset, bodyOffset += payloadIvLength);
  const payloadTag = envelope.subarray(bodyOffset, bodyOffset += payloadTagLength);
  const wrappedDek = envelope.subarray(bodyOffset, bodyOffset += wrappedDekLength);
  const ciphertext = envelope.subarray(bodyOffset);

  try {
    const keyDecipher = createDecipheriv("aes-256-gcm", parseKek(kek), wrappingIv);
    keyDecipher.setAAD(header);
    keyDecipher.setAuthTag(wrappingTag);
    const dek = Buffer.concat([keyDecipher.update(wrappedDek), keyDecipher.final()]);
    if (dek.byteLength !== dekLength) throw new Error("Invalid DEK length");

    const payloadDecipher = createDecipheriv("aes-256-gcm", dek, payloadIv);
    payloadDecipher.setAAD(header);
    payloadDecipher.setAuthTag(payloadTag);
    return Buffer.concat([payloadDecipher.update(ciphertext), payloadDecipher.final()]);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, "BACKUP_DECRYPTION_FAILED", "备份对象解密失败，密钥错误或对象已损坏");
  }
}
