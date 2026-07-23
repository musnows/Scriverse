import { describe, expect, it } from "vitest";
import {
  canReadPermissionModule,
  canReadUiModule,
  canWritePermissionModule,
  canWriteUiModule,
  emptyModulePermissions,
  firstReadableUiModule,
  normalizeModulePermissions,
  permissionSummary
} from "../../src/public/work-permissions.js";
import {
  classifyWorkModulePermissions,
  migrateLegacyModulePermissions,
  settingsEditorModulePermissions,
  storedMembershipForPermissions,
  storedWorkModulePermissions
} from "../../src/work-permissions.js";

describe("作品模块权限", () => {
  it("将旧成员角色映射为等价模块权限", () => {
    const legacySettings = storedWorkModulePermissions("editor", JSON.stringify({ editScope: "settings" }));
    expect(legacySettings).toEqual(settingsEditorModulePermissions());
    expect(classifyWorkModulePermissions(legacySettings)).toBe("settings-editor");
    expect(storedWorkModulePermissions("viewer", "{}").prose).toBe("read");
    expect(storedWorkModulePermissions("editor", "{}").prose).toBe("write");
    expect(storedWorkModulePermissions("editor", "{}")["ai-chat"]).toBe("write");
    expect(storedWorkModulePermissions("editor", "{}")["ai-analysis"]).toBe("write");
  });

  it("持久化自定义权限且不把只读成员保存为编辑者", () => {
    const permissions = settingsEditorModulePermissions();
    permissions.prose = "none";
    const stored = storedMembershipForPermissions(permissions);
    expect(stored.role).toBe("editor");
    expect(storedWorkModulePermissions(stored.role, stored.permissionsJson)).toEqual(permissions);

    const readOnly = Object.fromEntries(Object.keys(permissions).map((module) => [module, "read"]));
    expect(storedMembershipForPermissions(readOnly as typeof permissions).role).toBe("viewer");
  });

  it("前端按当前模块分别判断读取与写入", () => {
    const permissions = emptyModulePermissions();
    permissions.prose = "read";
    permissions.settings = "write";
    const work = { accessRole: "custom", modulePermissions: permissions };
    expect(canReadUiModule(work, "editor")).toBe(true);
    expect(canWriteUiModule(work, "editor")).toBe(false);
    expect(canReadUiModule(work, "settings")).toBe(true);
    expect(canWriteUiModule(work, "settings")).toBe(true);
    expect(canReadUiModule(work, "characters")).toBe(false);
    expect(firstReadableUiModule(work)).toBe("editor");
    expect(permissionSummary(permissions)).toContain("可编辑：设定库");
    expect(permissionSummary(permissions)).toContain("只读：正文");
  });

  it("将旧版 ai 权限迁移为独立的对话与分析权限", () => {
    const legacy = {
      prose: "read",
      settings: "read",
      characters: "read",
      races: "read",
      organizations: "read",
      timeline: "read",
      relationships: "read",
      outlines: "read",
      reviews: "none",
      ai: "write",
      "ai-settings": "none"
    };
    const migrated = migrateLegacyModulePermissions(legacy);
    expect(migrated["ai-chat"]).toBe("write");
    expect(migrated["ai-analysis"]).toBe("write");
    const stored = storedWorkModulePermissions("editor", JSON.stringify({ modules: legacy }));
    expect(stored["ai-analysis"]).toBe("write");
    expect(stored["ai-chat"]).toBe("write");
    const work = { accessRole: "custom", modulePermissions: normalizeModulePermissions(legacy, "custom") };
    expect(canReadPermissionModule(work, "ai-chat")).toBe(true);
    expect(canWritePermissionModule(work, "ai-chat")).toBe(true);
    expect(canWriteUiModule(work, "tasks")).toBe(true);
  });

  it("将旧版 ai 键迁移为 ai-analysis，并保留已有 ai-chat", () => {
    const legacySplit = {
      prose: "read",
      settings: "read",
      characters: "read",
      races: "read",
      organizations: "read",
      timeline: "read",
      relationships: "read",
      outlines: "read",
      reviews: "none",
      "ai-chat": "none",
      ai: "write",
      "ai-settings": "none"
    };
    const stored = storedWorkModulePermissions("editor", JSON.stringify({ modules: legacySplit }));
    expect(stored["ai-chat"]).toBe("none");
    expect(stored["ai-analysis"]).toBe("write");
  });

  it("允许单独关闭侧边栏 AI 对话而不影响分析模块", () => {
    const permissions = emptyModulePermissions();
    permissions["ai-analysis"] = "write";
    permissions["ai-chat"] = "none";
    const work = { accessRole: "custom", modulePermissions: permissions };
    expect(canReadPermissionModule(work, "ai-chat")).toBe(false);
    expect(canWritePermissionModule(work, "ai-chat")).toBe(false);
    expect(canReadUiModule(work, "tasks")).toBe(true);
    expect(canWriteUiModule(work, "tasks")).toBe(true);
  });

  it("拒绝不完整权限对象并安全回退", () => {
    const normalized = normalizeModulePermissions({ prose: "write" }, "custom");
    expect(normalized.prose).toBe("none");
    expect(Object.values(normalized).every((access) => access === "none")).toBe(true);
    const stored = storedWorkModulePermissions("editor", JSON.stringify({ modules: { prose: "read", settings: "invalid" } }));
    expect(stored.prose).toBe("read");
    expect(stored.settings).toBe("none");
    expect(stored.characters).toBe("none");
    expect(stored["ai-chat"]).toBe("none");
    expect(stored["ai-analysis"]).toBe("none");
  });
});
