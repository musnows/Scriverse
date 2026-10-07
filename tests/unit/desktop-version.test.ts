import { describe, expect, it } from "vitest";
import { classifyDesktopServerCompatibility, DESKTOP_MINIMUM_VERSION } from "../../src/desktop-protocol.js";
import { APP_VERSION } from "../../src/version.js";
import { parseReportedVersion } from "../../src/version-compat.js";

const serverMinimum = "1.1.7";

describe("Desktop 四段版本与 Server 对齐", () => {
  it("Server 自身版本和最低 Desktop 版本保持三段", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(DESKTOP_MINIMUM_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(APP_VERSION.split(".")).toHaveLength(3);
  });

  it("把 1.1.7.1 和 1.1.8.0 按前三段对齐，第四段 0 仍是真实修订", () => {
    expect(parseReportedVersion("1.1.7.1")).toEqual({ major: 1, minor: 1, patch: 7, desktopRevision: 1 });
    expect(parseReportedVersion("1.1.8.0")).toEqual({ major: 1, minor: 1, patch: 8, desktopRevision: 0 });
    expect(parseReportedVersion("1.1.7")).toEqual({ major: 1, minor: 1, patch: 7, desktopRevision: null });
    expect(parseReportedVersion("1.1.7.1")).not.toBeNull();
    expect(parseReportedVersion("1.1.8.0")).not.toBeNull();
  });

  it("相对 Server 1.1.7，1.1.7.1 相等且兼容，1.1.8.0 更新且兼容", () => {
    expect(classifyDesktopServerCompatibility("1.1.7.1", serverMinimum)).toEqual({
      relation: "equal",
      compatibility: "compatible"
    });
    expect(classifyDesktopServerCompatibility("1.1.8.0", serverMinimum)).toEqual({
      relation: "newer",
      compatibility: "compatible"
    });
    expect(classifyDesktopServerCompatibility("1.1.7", "1.1.7.1")).toEqual({
      relation: "equal",
      compatibility: "compatible"
    });
    expect(classifyDesktopServerCompatibility("1.1.8", "1.1.8.0")).toEqual({
      relation: "equal",
      compatibility: "compatible"
    });
  });

  it("只有前三段低于 Server 要求时才需要升级", () => {
    expect(classifyDesktopServerCompatibility("1.1.6.9", serverMinimum)).toEqual({
      relation: "older",
      compatibility: "upgrade-required"
    });
    expect(classifyDesktopServerCompatibility("1.1.7.1", "1.1.8")).toEqual({
      relation: "older",
      compatibility: "upgrade-required"
    });
    expect(classifyDesktopServerCompatibility("1.1.8.0", "1.1.9")).toEqual({
      relation: "older",
      compatibility: "upgrade-required"
    });
    expect(classifyDesktopServerCompatibility("1.1.8.0", "1.1.8")).toEqual({
      relation: "equal",
      compatibility: "compatible"
    });
    expect(classifyDesktopServerCompatibility("1.1.7.1", "1.1.6")).toEqual({
      relation: "newer",
      compatibility: "compatible"
    });
    expect(classifyDesktopServerCompatibility("1.1.8.0", "1.1.7.9")).toEqual({
      relation: "newer",
      compatibility: "compatible"
    });
    expect(classifyDesktopServerCompatibility("1.1.7.9", "1.1.7.1")).toEqual({
      relation: "equal",
      compatibility: "compatible"
    });
  });

  it("无法解析的版本不是升级要求，四段版本不会落入该结果", () => {
    expect(classifyDesktopServerCompatibility("latest", serverMinimum)).toBeNull();
    expect(classifyDesktopServerCompatibility("1.1.7.1.2", serverMinimum)).toBeNull();
    expect(classifyDesktopServerCompatibility("", serverMinimum)).toBeNull();
    expect(classifyDesktopServerCompatibility("1.1.7.1", "latest")).toBeNull();
  });
});
