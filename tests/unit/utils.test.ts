import { describe, expect, it } from "vitest";
import { escapeSqlLikePattern, parseBooleanEnvironmentValue } from "../../src/utils.js";

describe("布尔环境变量", () => {
  it("仅接受 true、false、1 和 0", () => {
    expect(parseBooleanEnvironmentValue("true")).toBe(true);
    expect(parseBooleanEnvironmentValue("1")).toBe(true);
    expect(parseBooleanEnvironmentValue("false")).toBe(false);
    expect(parseBooleanEnvironmentValue("0")).toBe(false);
    expect(parseBooleanEnvironmentValue("2")).toBeUndefined();
    expect(parseBooleanEnvironmentValue("-1")).toBeUndefined();
    expect(parseBooleanEnvironmentValue("TRUE")).toBeUndefined();
    expect(parseBooleanEnvironmentValue(undefined)).toBeUndefined();
  });
});

describe("SQL LIKE 字面量转义", () => {
  it("按顺序转义反斜杠、百分号和下划线", () => {
    expect(escapeSqlLikePattern(String.raw`\%_`)).toBe(String.raw`\\\%\_`);
    expect(escapeSqlLikePattern("普通关键词")).toBe("普通关键词");
  });
});
