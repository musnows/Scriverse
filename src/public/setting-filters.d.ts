export type SettingLockFilter = "all" | "locked" | "unlocked";

export interface SettingFilterOptions {
  keyword?: string;
  category?: string;
  lockState?: SettingLockFilter;
}

export interface SettingFilterRecord {
  title?: unknown;
  category?: unknown;
  contentPreview?: unknown;
  locked?: unknown;
}

export function filterSettings<T extends SettingFilterRecord>(records: readonly T[], filters?: SettingFilterOptions): T[];
