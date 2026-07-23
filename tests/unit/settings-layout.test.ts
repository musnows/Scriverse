import { describe, expect, it } from "vitest";
import {
  SETTINGS_LAYOUTS,
  normalizeSettingsLayout,
  settingsLayoutLabel
} from "../../src/public/settings-layout.js";

describe("设定库布局偏好", () => {
  it("只接受卡片与列表两种样式", () => {
    expect(SETTINGS_LAYOUTS).toEqual(["cards", "rows"]);
    expect(normalizeSettingsLayout("cards")).toBe("cards");
    expect(normalizeSettingsLayout("rows")).toBe("rows");
    expect(normalizeSettingsLayout("grid")).toBe("cards");
    expect(normalizeSettingsLayout(undefined)).toBe("cards");
  });

  it("提供布局切换文案", () => {
    expect(settingsLayoutLabel("cards")).toBe("卡片");
    expect(settingsLayoutLabel("rows")).toBe("列表");
  });
});
