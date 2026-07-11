import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type EncryptedSecret = {
  encrypted: string;
  iv: string;
  tag: string;
};

export class CredentialVault {
  private readonly key: Buffer;

  constructor(masterSecret: string) {
    if (masterSecret.length < 16) throw new Error("主密钥长度至少为 16 个字符");
    this.key = createHash("sha256").update(masterSecret).digest();
  }

  encrypt(secret: string): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return {
      encrypted: encrypted.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64")
    };
  }

  decrypt(value: EncryptedSecret): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(value.iv, "base64"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(value.encrypted, "base64")),
      decipher.final()
    ]).toString("utf8");
  }
}

export function loadMasterSecret(path: string, environmentSecret?: string): string {
  if (environmentSecret) return environmentSecret;
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(dirname(path), { recursive: true });
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(path, secret, { encoding: "utf8", mode: 0o600 });
  return secret;
}
