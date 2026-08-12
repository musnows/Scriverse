export const workPermissionModules = [
  "prose",
  "drafts",
  "settings",
  "characters",
  "races",
  "organizations",
  "timeline",
  "relationships",
  "outlines",
  "reviews",
  "ai-chat",
  "ai-analysis",
  "ai-settings"
] as const;

export type WorkPermissionModule = typeof workPermissionModules[number];
export type WorkModuleAccess = "none" | "read" | "write";
export type WorkModulePermissions = Record<WorkPermissionModule, WorkModuleAccess>;
export type PublicWorkAccessRole = "owner" | "editor" | "settings-editor" | "viewer" | "custom";

export const proseReplacementPermissionModules = workPermissionModules.filter(
  (module): module is WorkPermissionModule => module !== "ai-settings"
);

export const contentPermissionModules = workPermissionModules.filter(
  (module): module is WorkPermissionModule => !["drafts", "reviews", "ai-chat", "ai-analysis", "ai-settings"].includes(module)
);

export function relationshipAnalysisReadModules(scope: unknown): WorkPermissionModule[] {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return [];
  const value = scope as Record<string, unknown>;
  if (!Array.isArray(value.characterIds) || value.characterIds.length === 0) return [];
  const modules = new Set<WorkPermissionModule>(["characters"]);
  if (value.type !== "settings") modules.add("prose");
  if (value.type === "settings" || value.includeAllSettings === true) {
    for (const module of ["settings", "races", "organizations", "timeline", "relationships", "outlines", "reviews"] as const) {
      modules.add(module);
    }
  }
  return [...modules];
}

const analysisTaskDirectReadModules: Record<string, readonly WorkPermissionModule[]> = {
  structure: ["prose"],
  "chapter-analysis": ["prose"],
  "character-extraction": ["prose", "characters", "races", "organizations"],
  "character-summary": ["prose", "characters", "races", "organizations"],
  "character-identity-audit": [...contentPermissionModules, "reviews"],
  "timeline-analysis": ["prose", "timeline", "characters"],
  "worldview-analysis": ["prose", "settings"],
  "setting-extraction": ["prose", "settings"],
  "consistency-check": [...contentPermissionModules, "reviews"],
  "book-analysis": ["prose"],
  "report-update": ["prose"]
};

export function analysisTaskReadModules(taskType: unknown, scope: unknown): WorkPermissionModule[] {
  const scopeValue = scope && typeof scope === "object" && !Array.isArray(scope)
    ? scope as Record<string, unknown>
    : { type: "book" };
  const modules = new Set<WorkPermissionModule>(scopeValue.type === "none" ? [] : contentPermissionModules);
  for (const module of analysisTaskDirectReadModules[String(taskType)] ?? []) modules.add(module);
  if (taskType === "relationship-analysis") {
    for (const module of relationshipAnalysisReadModules(scopeValue)) modules.add(module);
  }
  return [...modules];
}

export const workPermissionModuleLabels: Record<WorkPermissionModule, string> = {
  prose: "正文",
  drafts: "想法",
  settings: "设定库",
  characters: "角色",
  races: "种族",
  organizations: "组织",
  timeline: "时间轴",
  relationships: "关系",
  outlines: "大纲/伏笔",
  reviews: "审核",
  "ai-chat": "AI 对话",
  "ai-analysis": "AI 分析",
  "ai-settings": "AI 设置"
};

const settingsEditorWriteModules = new Set<WorkPermissionModule>([
  "settings",
  "characters",
  "races",
  "organizations",
  "timeline",
  "relationships",
  "outlines"
]);

function permissionRecord(access: WorkModuleAccess): WorkModulePermissions {
  return Object.fromEntries(workPermissionModules.map((module) => [module, access])) as WorkModulePermissions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsedPermissions(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isModuleAccess(value: unknown): value is WorkModuleAccess {
  return value === "none" || value === "read" || value === "write";
}

/**
 * 兼容旧权限键：
 * - 仅有 ai：同时填充 ai-chat 与 ai-analysis
 * - 已有 ai-chat + ai：将 ai 迁到 ai-analysis
 */
export function migrateLegacyModulePermissions(value: Record<string, unknown>): Record<string, unknown> {
  const migrated = { ...value };
  if (!isModuleAccess(migrated.drafts)) {
    const prose = isModuleAccess(migrated.prose) ? migrated.prose : "none";
    const settings = isModuleAccess(migrated.settings) ? migrated.settings : "none";
    migrated.drafts = prose === "write" && settings === "write"
      ? "write"
      : prose === "none" || settings === "none" ? "none" : "read";
  }
  const legacyAi = isModuleAccess(migrated.ai) ? migrated.ai : null;
  if (!isModuleAccess(migrated["ai-chat"]) && legacyAi) migrated["ai-chat"] = legacyAi;
  if (!isModuleAccess(migrated["ai-analysis"])) {
    if (isModuleAccess(migrated.ai)) migrated["ai-analysis"] = migrated.ai;
  }
  return migrated;
}

export function fullWorkModulePermissions(): WorkModulePermissions {
  return permissionRecord("write");
}

export function readOnlyWorkModulePermissions(): WorkModulePermissions {
  return permissionRecord("read");
}

export function emptyWorkModulePermissions(): WorkModulePermissions {
  return permissionRecord("none");
}

export function settingsEditorModulePermissions(): WorkModulePermissions {
  const permissions = readOnlyWorkModulePermissions();
  for (const module of settingsEditorWriteModules) permissions[module] = "write";
  return permissions;
}

export function normalizeWorkModulePermissions(value: unknown): WorkModulePermissions | null {
  if (!isRecord(value)) return null;
  const migrated = migrateLegacyModulePermissions(value);
  const permissions = emptyWorkModulePermissions();
  for (const module of workPermissionModules) {
    const access = migrated[module];
    if (!isModuleAccess(access)) return null;
    permissions[module] = access;
  }
  return permissions;
}

export function storedWorkModulePermissions(role: string, permissionsValue: unknown): WorkModulePermissions {
  if (role === "owner") return fullWorkModulePermissions();
  const parsed = parsedPermissions(permissionsValue);
  const explicit = normalizeWorkModulePermissions(parsed.modules);
  if (explicit) return explicit;
  if ("modules" in parsed) {
    const permissions = emptyWorkModulePermissions();
    if (!isRecord(parsed.modules)) return permissions;
    const modules = migrateLegacyModulePermissions(parsed.modules);
    for (const module of workPermissionModules) {
      const access = modules[module];
      if (isModuleAccess(access)) permissions[module] = access;
    }
    return permissions;
  }
  if (role === "viewer") return readOnlyWorkModulePermissions();
  if (role === "editor" && parsed.editScope === "settings") return settingsEditorModulePermissions();
  if (role === "editor") return fullWorkModulePermissions();
  return emptyWorkModulePermissions();
}

export function storedMembershipForPermissions(permissions: WorkModulePermissions): { role: "editor" | "viewer"; permissionsJson: string } {
  const role = workPermissionModules.some((module) => permissions[module] === "write") ? "editor" : "viewer";
  return { role, permissionsJson: JSON.stringify({ modules: permissions }) };
}

export function classifyWorkModulePermissions(permissions: WorkModulePermissions): PublicWorkAccessRole {
  if (workPermissionModules.every((module) => permissions[module] === "write")) return "editor";
  if (workPermissionModules.every((module) => permissions[module] === "read")) return "viewer";
  const settingsEditor = settingsEditorModulePermissions();
  if (workPermissionModules.every((module) => permissions[module] === settingsEditor[module])) return "settings-editor";
  return "custom";
}

export function canReadWorkModule(permissions: WorkModulePermissions, module: WorkPermissionModule): boolean {
  return permissions[module] === "read" || permissions[module] === "write";
}

export function canWriteWorkModule(permissions: WorkModulePermissions, module: WorkPermissionModule): boolean {
  return permissions[module] === "write";
}
