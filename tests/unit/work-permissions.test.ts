import { describe, expect, it } from "vitest";
import {
  canReadUiModule,
  canWriteUiModule,
  emptyModulePermissions,
  firstReadableUiModule,
  normalizeModulePermissions,
  permissionSummary
} from "../../src/public/work-permissions.js";
import {
  classifyWorkModulePermissions,
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

  it("拒绝不完整权限对象并安全回退", () => {
    const normalized = normalizeModulePermissions({ prose: "write" }, "custom");
    expect(normalized.prose).toBe("none");
    expect(Object.values(normalized).every((access) => access === "none")).toBe(true);
    const stored = storedWorkModulePermissions("editor", JSON.stringify({ modules: { prose: "read", settings: "invalid" } }));
    expect(stored.prose).toBe("read");
    expect(stored.settings).toBe("none");
    expect(stored.characters).toBe("none");
  });
});
