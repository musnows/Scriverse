export type WorkPermissionModule = "prose" | "settings" | "characters" | "races" | "organizations" | "timeline" | "relationships" | "outlines" | "reviews" | "ai" | "ai-settings";
export type WorkUiModule = "editor" | "settings" | "characters" | "races" | "organizations" | "timeline" | "relationships" | "outlines" | "reviews" | "tasks" | "ai-settings";
export type WorkModuleAccess = "none" | "read" | "write";
export type WorkModulePermissions = Record<WorkPermissionModule, WorkModuleAccess>;
export type WorkPermissionAware = { accessRole?: string | null; modulePermissions?: WorkModulePermissions };

export const WORK_PERMISSION_MODULES: readonly Readonly<{ id: WorkPermissionModule; uiModule: WorkUiModule; label: string }>[];
export function emptyModulePermissions(): WorkModulePermissions;
export function normalizeModulePermissions(value: unknown, accessRole?: string): WorkModulePermissions;
export function permissionModuleForUiModule(uiModule: string): WorkPermissionModule;
export function canReadUiModule(work: WorkPermissionAware | null | undefined, uiModule: string): boolean;
export function canWriteUiModule(work: WorkPermissionAware | null | undefined, uiModule: string): boolean;
export function firstReadableUiModule(work: WorkPermissionAware | null | undefined): WorkUiModule | null;
export function permissionSummary(value: unknown): string;
