import { describe, expect, it } from "vitest";
import {
  MODULE_LAYOUTS,
  normalizeModuleLayout,
  moduleLayoutLabel,
  LEGACY_SETTINGS_LAYOUT_STORAGE_KEY,
  MODULE_LAYOUT_STORAGE_KEY
} from "../../src/public/module-layout.js";

describe("知识模块布局偏好", () => {
  it("只接受卡片与列表两种样式", () => {
    expect(MODULE_LAYOUTS).toEqual(["cards", "rows"]);
    expect(normalizeModuleLayout("cards")).toBe("cards");
    expect(normalizeModuleLayout("rows")).toBe("rows");
    expect(normalizeModuleLayout("grid")).toBe("cards");
    expect(normalizeModuleLayout(undefined)).toBe("cards");
  });

  it("提供布局切换文案与存储键", () => {
    expect(moduleLayoutLabel("cards")).toBe("卡片");
    expect(moduleLayoutLabel("rows")).toBe("列表");
    expect(MODULE_LAYOUT_STORAGE_KEY).toBe("scriverse-module-layout-v1");
    expect(LEGACY_SETTINGS_LAYOUT_STORAGE_KEY).toBe("scriverse-settings-layout-v1");
  });
});
