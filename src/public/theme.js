export const THEME_STORAGE_KEY = "scriverse-color-theme-v1";

export function normalizeTheme(value, prefersDark = false) {
  return value === "dark" || value === "light" ? value : prefersDark ? "dark" : "light";
}

export function nextTheme(theme) {
  return normalizeTheme(theme) === "dark" ? "light" : "dark";
}

export function themeToggleLabel(theme) {
  return normalizeTheme(theme) === "dark" ? "切换到白天模式" : "切换到黑夜模式";
}
