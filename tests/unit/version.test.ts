import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_VERSION, resolveBetaVersionLabel } from "../../src/version.js";

describe("应用版本", () => {
  it("与包版本保持一致", () => {
    const packageMetadata = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

    expect(APP_VERSION).toBe(packageMetadata.version);
  });

  it("仅在注入有效提交哈希时生成 Beta 展示版本", () => {
    expect(resolveBetaVersionLabel({})).toBeUndefined();
    expect(resolveBetaVersionLabel({ SCRIVERSE_BETA_COMMIT: "1234567" })).toBeUndefined();
    expect(resolveBetaVersionLabel({ SCRIVERSE_BETA_COMMIT: "ABCDEF1234567890" })).toBe("abcdef12 beta");
  });
});
