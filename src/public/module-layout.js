export const MODULE_LAYOUT_STORAGE_KEY = "scriverse-module-layout-v1";
export const LEGACY_SETTINGS_LAYOUT_STORAGE_KEY = "scriverse-settings-layout-v1";

export const MODULE_LAYOUTS = ["cards", "rows"];

export function normalizeModuleLayout(value) {
  return value === "rows" ? "rows" : "cards";
}

export function moduleLayoutLabel(layout) {
  return normalizeModuleLayout(layout) === "rows" ? "列表" : "卡片";
}

/** @deprecated 使用 normalizeModuleLayout */
export function normalizeSettingsLayout(value) {
  return normalizeModuleLayout(value);
}

/** @deprecated 使用 moduleLayoutLabel */
export function settingsLayoutLabel(layout) {
  return moduleLayoutLabel(layout);
}

/** @deprecated 使用 MODULE_LAYOUTS */
export const SETTINGS_LAYOUTS = MODULE_LAYOUTS;

/** @deprecated 使用 MODULE_LAYOUT_STORAGE_KEY */
export const SETTINGS_LAYOUT_STORAGE_KEY = MODULE_LAYOUT_STORAGE_KEY;
