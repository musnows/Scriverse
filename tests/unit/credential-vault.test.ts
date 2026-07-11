import { describe, expect, it } from "vitest";
import { CredentialVault } from "../../src/credential-vault.js";
import { maskSecret, normalizeBaseUrl } from "../../src/utils.js";

describe("供应商凭据保护", () => {
  it("使用带随机 IV 的认证加密并可正确解密", () => {
    const vault = new CredentialVault("a-secure-test-master-secret-value");
    const first = vault.encrypt("sk-private-value-123456");
    const second = vault.encrypt("sk-private-value-123456");

    expect(first.encrypted).not.toContain("sk-private");
    expect(first.encrypted).not.toBe(second.encrypted);
    expect(vault.decrypt(first)).toBe("sk-private-value-123456");
    expect(vault.decrypt(second)).toBe("sk-private-value-123456");
  });

  it("拒绝过短主密钥", () => {
    expect(() => new CredentialVault("too-short")).toThrow("主密钥长度至少为 16 个字符");
  });

  it("仅显示密钥掩码并规范化兼容接口地址", () => {
    expect(maskSecret("sk-abcdefghijklmnopqrstuvwxyz")).toMatch(/^sk-\*+wxyz$/u);
    expect(normalizeBaseUrl("https://example.test/v1/chat/completions/")) .toBe("https://example.test/v1");
  });
});
