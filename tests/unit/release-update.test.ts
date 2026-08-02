import { describe, expect, it, vi } from "vitest";
import {
  defaultReleaseCheckIntervalMs,
  defaultReleaseCheckRetries,
  defaultReleaseCheckTimeoutMs,
  isNewerRelease,
  maximumReleaseCheckRetries,
  maximumReleaseCheckTimeoutMs,
  minimumReleaseCheckIntervalMs,
  ReleaseUpdateChecker,
  resolveReleaseCheckIntervalMs,
  resolveReleaseCheckRetries,
  resolveReleaseCheckTimeoutMs
} from "../../src/release-update.js";

describe("GitHub Release 更新探测", () => {
  it("比较稳定版版本号", () => {
    expect(isNewerRelease("0.6.7", "v0.6.8")).toBe(true);
    expect(isNewerRelease("0.6.7", "0.7.0")).toBe(true);
    expect(isNewerRelease("0.6.7", "0.6.7")).toBe(false);
    expect(isNewerRelease("0.6.7", "0.6.6")).toBe(false);
    expect(isNewerRelease("0.6.7", "latest")).toBe(false);
  });

  it("默认每小时探测并将过短配置限制为 10 分钟", () => {
    expect(defaultReleaseCheckIntervalMs).toBe(60 * 60 * 1000);
    expect(resolveReleaseCheckIntervalMs(undefined)).toBe(defaultReleaseCheckIntervalMs);
    expect(resolveReleaseCheckIntervalMs("")).toBe(defaultReleaseCheckIntervalMs);
    expect(resolveReleaseCheckIntervalMs("invalid")).toBe(defaultReleaseCheckIntervalMs);
    expect(resolveReleaseCheckIntervalMs("-5")).toBe(minimumReleaseCheckIntervalMs);
    expect(resolveReleaseCheckIntervalMs("0")).toBe(minimumReleaseCheckIntervalMs);
    expect(resolveReleaseCheckIntervalMs("5")).toBe(minimumReleaseCheckIntervalMs);
    expect(resolveReleaseCheckIntervalMs("10")).toBe(minimumReleaseCheckIntervalMs);
    expect(resolveReleaseCheckIntervalMs("25")).toBe(25 * 60 * 1000);
  });

  it("解析超时与重试配置并限制安全边界", () => {
    expect(defaultReleaseCheckTimeoutMs).toBe(90_000);
    expect(maximumReleaseCheckTimeoutMs).toBe(300_000);
    expect(defaultReleaseCheckRetries).toBe(1);
    expect(resolveReleaseCheckTimeoutMs(undefined)).toBe(defaultReleaseCheckTimeoutMs);
    expect(resolveReleaseCheckTimeoutMs("invalid")).toBe(defaultReleaseCheckTimeoutMs);
    expect(resolveReleaseCheckTimeoutMs("120")).toBe(120_000);
    expect(resolveReleaseCheckTimeoutMs("600")).toBe(maximumReleaseCheckTimeoutMs);
    expect(resolveReleaseCheckRetries(undefined)).toBe(defaultReleaseCheckRetries);
    expect(resolveReleaseCheckRetries("invalid")).toBe(defaultReleaseCheckRetries);
    expect(resolveReleaseCheckRetries("0")).toBe(0);
    expect(resolveReleaseCheckRetries("3")).toBe(3);
    expect(resolveReleaseCheckRetries("99")).toBe(maximumReleaseCheckRetries);
  });

  it("发现新版本后返回经过校验的 Release 页面并缓存结果", async () => {
    let now = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      tag_name: "v0.6.8",
      html_url: "https://github.com/musnows/Scriverse/releases/tag/v0.6.8"
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const checker = new ReleaseUpdateChecker("0.6.7", fetchMock, {
      intervalMs: minimumReleaseCheckIntervalMs,
      now: () => now
    });

    await expect(checker.check()).resolves.toEqual({
      checked: true,
      updateAvailable: true,
      currentVersion: "0.6.7",
      latestVersion: "0.6.8",
      releaseUrl: "https://github.com/musnows/Scriverse/releases/tag/v0.6.8",
      checkedAt: "1970-01-01T00:00:00.000Z",
      nextCheckAt: "1970-01-01T00:10:00.000Z"
    });
    await checker.check();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/musnows/Scriverse/releases/latest",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          "User-Agent": "Scriverse-Update-Checker"
        }),
        signal: expect.any(AbortSignal)
      })
    );

    now = minimumReleaseCheckIntervalMs;
    await checker.check();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("失败后按配置进行一次内部重试", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tag_name: "v0.6.8",
        html_url: "https://github.com/musnows/Scriverse/releases/tag/v0.6.8"
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await new ReleaseUpdateChecker("0.6.7", fetchMock, { retries: 1 }).check();
    expect(result).toMatchObject({ checked: true, updateAvailable: true, latestVersion: "0.6.8" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("请求失败或返回不可信链接时不报告更新", async () => {
    const failedFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error("network unavailable"));
    const invalidUrlFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      tag_name: "v9.0.0",
      html_url: "https://example.com/releases/tag/v9.0.0"
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(new ReleaseUpdateChecker("0.6.7", failedFetch).check()).resolves.toMatchObject({
      checked: false,
      updateAvailable: false,
      currentVersion: "0.6.7"
    });
    await expect(new ReleaseUpdateChecker("0.6.7", invalidUrlFetch).check()).resolves.toMatchObject({
      checked: false,
      updateAvailable: false,
      currentVersion: "0.6.7"
    });
    expect(failedFetch).toHaveBeenCalledTimes(2);
    expect(invalidUrlFetch).toHaveBeenCalledTimes(2);
  });
});
