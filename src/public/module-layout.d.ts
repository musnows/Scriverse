export type ModuleLayout = "cards" | "rows";

export const MODULE_LAYOUT_STORAGE_KEY: string;
export const LEGACY_SETTINGS_LAYOUT_STORAGE_KEY: string;
export const MODULE_LAYOUTS: readonly ModuleLayout[];

export function normalizeModuleLayout(value: unknown): ModuleLayout;
export function moduleLayoutLabel(layout: unknown): string;

/** @deprecated 使用 normalizeModuleLayout */
export function normalizeSettingsLayout(value: unknown): ModuleLayout;
/** @deprecated 使用 moduleLayoutLabel */
export function settingsLayoutLabel(layout: unknown): string;
/** @deprecated 使用 MODULE_LAYOUTS */
export const SETTINGS_LAYOUTS: readonly ModuleLayout[];
/** @deprecated 使用 MODULE_LAYOUT_STORAGE_KEY */
export const SETTINGS_LAYOUT_STORAGE_KEY: string;
