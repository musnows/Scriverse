export const WORK_PERMISSION_MODULES = Object.freeze([
  { id: "prose", uiModule: "editor", label: "正文" },
  { id: "settings", uiModule: "settings", label: "设定库" },
  { id: "characters", uiModule: "characters", label: "角色" },
  { id: "races", uiModule: "races", label: "种族" },
  { id: "organizations", uiModule: "organizations", label: "组织" },
  { id: "timeline", uiModule: "timeline", label: "时间轴" },
  { id: "relationships", uiModule: "relationships", label: "关系" },
  { id: "outlines", uiModule: "outlines", label: "大纲与伏笔" },
  { id: "reviews", uiModule: "reviews", label: "审核" },
  { id: "ai", uiModule: "tasks", label: "AI 对话与分析" },
  { id: "ai-settings", uiModule: "ai-settings", label: "AI 设置" }
]);

const permissionModuleByUiModule = new Map(WORK_PERMISSION_MODULES.map((item) => [item.uiModule, item.id]));
const validAccess = new Set(["none", "read", "write"]);

export function emptyModulePermissions() {
  return Object.fromEntries(WORK_PERMISSION_MODULES.map((item) => [item.id, "none"]));
}

export function normalizeModulePermissions(value, accessRole = "viewer") {
  if (value && typeof value === "object" && !Array.isArray(value)
    && WORK_PERMISSION_MODULES.every((item) => validAccess.has(value[item.id]))) {
    return Object.fromEntries(WORK_PERMISSION_MODULES.map((item) => [item.id, value[item.id]]));
  }
  const fallback = emptyModulePermissions();
  for (const item of WORK_PERMISSION_MODULES) {
    fallback[item.id] = accessRole === "editor" || accessRole === "admin" || accessRole === "owner"
      ? "write"
      : accessRole === "viewer" || accessRole === "settings-editor" ? "read" : "none";
  }
  if (accessRole === "settings-editor") {
    fallback.prose = "read";
    fallback.reviews = "read";
    fallback.ai = "read";
    fallback["ai-settings"] = "read";
  }
  return fallback;
}

export function permissionModuleForUiModule(uiModule) {
  return permissionModuleByUiModule.get(String(uiModule)) ?? "prose";
}

export function canReadUiModule(work, uiModule) {
  if (!work) return false;
  const permissions = normalizeModulePermissions(work.modulePermissions, work.accessRole);
  return permissions[permissionModuleForUiModule(uiModule)] !== "none";
}

export function canWriteUiModule(work, uiModule) {
  if (!work) return false;
  const permissions = normalizeModulePermissions(work.modulePermissions, work.accessRole);
  return permissions[permissionModuleForUiModule(uiModule)] === "write";
}

export function firstReadableUiModule(work) {
  return WORK_PERMISSION_MODULES.find((item) => canReadUiModule(work, item.uiModule))?.uiModule ?? null;
}

export function permissionSummary(value) {
  const permissions = normalizeModulePermissions(value, "custom");
  const writable = WORK_PERMISSION_MODULES.filter((item) => permissions[item.id] === "write").map((item) => item.label);
  const readable = WORK_PERMISSION_MODULES.filter((item) => permissions[item.id] === "read").map((item) => item.label);
  const parts = [];
  if (writable.length) parts.push(`可编辑：${writable.join("、")}`);
  if (readable.length) parts.push(`只读：${readable.join("、")}`);
  if (!parts.length) parts.push("未授权任何模块");
  return parts.join("；");
}
