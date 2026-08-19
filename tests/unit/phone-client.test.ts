import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { isPhoneClient } from "../../src/public/phone-client.js";

describe("手机设备识别", () => {
  it("优先使用 User-Agent Client Hints 的手机标记", () => {
    expect(isPhoneClient({ userAgentData: { mobile: true }, userAgent: "desktop" })).toBe(true);
    expect(isPhoneClient({ userAgentData: { mobile: false }, userAgent: "iPhone" })).toBe(false);
  });

  it("在缺少 Client Hints 时识别手机并排除平板和桌面端", () => {
    expect(isPhoneClient({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" })).toBe(true);
    expect(isPhoneClient({ userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile Safari/537.36" })).toBe(true);
    expect(isPhoneClient({ userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 Safari/537.36" })).toBe(false);
    expect(isPhoneClient({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 Safari/605.1.15" })).toBe(false);
  });
});
