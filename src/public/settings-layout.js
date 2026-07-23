export const SETTINGS_LAYOUT_STORAGE_KEY = "scriverse-settings-layout-v1";

export const SETTINGS_LAYOUTS = ["cards", "rows"];

export function normalizeSettingsLayout(value) {
  return value === "rows" ? "rows" : "cards";
}

export function settingsLayoutLabel(layout) {
  return normalizeSettingsLayout(layout) === "rows" ? "列表" : "卡片";
}
