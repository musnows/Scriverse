import { describe, expect, it } from "vitest";
import { ProviderSecretStreamRedactor } from "../../src/ai.js";

describe("ProviderSecretStreamRedactor", () => {
  const secret = "sk-sensitive-test-value";

  it("在正常结束时只输出一次暂存尾部", () => {
    const redactor = new ProviderSecretStreamRedactor(secret);

    expect(redactor.push("普通正文末尾s")).toBe("普通正文末尾");
    expect(redactor.flush()).toBe("s");
    expect(redactor.flush()).toBe("");
  });

  it("跨事件拼接密钥后输出脱敏值", () => {
    const redactor = new ProviderSecretStreamRedactor(secret);

    expect(redactor.push("安全前缀 sk-sensitive-")).toBe("安全前缀 ");
    expect(redactor.push("test-value 安全后缀")).toBe("sk-s*****lue 安全后缀");
    expect(redactor.flush()).toBe("");
  });

  it("异常结束尾部包含已拼接密钥时不会泄露或重复", () => {
    const redactor = new ProviderSecretStreamRedactor(secret);
    const output = [
      redactor.push("正文 sk-sensitive-"),
      redactor.push("test-values"),
      redactor.flush(),
      redactor.flush()
    ].join("");

    expect(output).toBe("正文 sk-s*****lues");
    expect(output).not.toContain(secret);
  });

  it("异常结束时隐藏超过既有掩码可见范围的密钥前缀", () => {
    const redactor = new ProviderSecretStreamRedactor(secret);

    expect(redactor.push("正文 sk-sensitive-")).toBe("正文 ");
    expect(redactor.flush({ interrupted: true })).toBe("sk-s*****");
    expect(redactor.flush({ interrupted: true })).toBe("");
  });

  it("异常结束时仍输出掩码允许范围内的普通短尾部", () => {
    const redactor = new ProviderSecretStreamRedactor(secret);

    expect(redactor.push("普通正文末尾s")).toBe("普通正文末尾");
    expect(redactor.flush({ interrupted: true })).toBe("s");
  });

  it("未配置密钥时不暂存正文", () => {
    const redactor = new ProviderSecretStreamRedactor("");

    expect(redactor.push("普通正文末尾s")).toBe("普通正文末尾s");
    expect(redactor.flush()).toBe("");
  });
});
