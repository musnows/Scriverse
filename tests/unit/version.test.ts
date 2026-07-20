import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_VERSION } from "../../src/version.js";

describe("应用版本", () => {
  it("与包版本保持一致", () => {
    const packageMetadata = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

    expect(APP_VERSION).toBe(packageMetadata.version);
  });
});
