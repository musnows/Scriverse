export const workPermissionModules = [
  "prose",
  "settings",
  "characters",
  "races",
  "organizations",
  "timeline",
  "relationships",
  "outlines",
  "reviews",
  "ai",
  "ai-settings"
] as const;

export type WorkPermissionModule = typeof workPermissionModules[number];
export type WorkModuleAccess = "none" | "read" | "write";
export type WorkModulePermissions = Record<WorkPermissionModule, WorkModuleAccess>;
export type PublicWorkAccessRole = "owner" | "editor" | "settings-editor" | "viewer" | "custom";

export const proseReplacementPermissionModules = workPermissionModules.filter(
  (module): module is WorkPermissionModule => module !== "ai-settings"
);

export const workPermissionModuleLabels: Record<WorkPermissionModule, string> = {
  prose: "正文",
  settings: "设定库",
  characters: "角色",
  races: "种族",
  organizations: "组织",
  timeline: "时间轴",
  relationships: "关系",
  outlines: "大纲与伏笔",
  reviews: "审核",
  ai: "AI 对话与分析",
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
  const permissions = emptyWorkModulePermissions();
  for (const module of workPermissionModules) {
    const access = value[module];
    if (access !== "none" && access !== "read" && access !== "write") return null;
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
    for (const module of workPermissionModules) {
      const access = parsed.modules[module];
      if (access === "none" || access === "read" || access === "write") permissions[module] = access;
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
