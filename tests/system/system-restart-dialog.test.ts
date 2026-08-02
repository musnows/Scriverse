import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("系统重启认证清理", () => {
  let runtime: Runtime;

  beforeAll(() => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "system-restart-dialog-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
  });

  afterAll(() => runtime.close());

  it("公开每次运行唯一的启动标识", async () => {
    const secondRuntime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "system-restart-dialog-second-test-secret",
      disableUserAuth: true,
      serveUi: false
    });
    try {
      const first = await request(runtime.app).get("/api/health").expect(200);
      const session = await request(runtime.app).get("/api/auth/session").expect(200);
      const second = await request(secondRuntime.app).get("/api/health").expect(200);
      expect(first.body.data.bootId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(session.body.data.bootId).toBe(first.body.data.bootId);
      expect(second.body.data.bootId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(second.body.data.bootId).not.toBe(first.body.data.bootId);
    } finally {
      secondRuntime.close();
    }
  });

  it("系统重启后直接清理全部弹层并返回登录页", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);

    expect(page.text).not.toContain('id="system-restart-dialog"');
    expect(application.text).toContain("function hasUnsavedEditorChanges()");
    expect(application.text).toContain("function clearAuthenticationOverlays()");
    expect(application.text).toContain("function invalidateAuthentication()");
    expect(application.text).toContain('document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());');
    expect(application.text).toContain('document.querySelectorAll("[popover]").forEach((popover) => {');
    expect(application.text).toContain('document.documentElement.classList.add("login-route");');
    expect(application.text).toContain('window.history.replaceState(null, "", serializePageRoute({ view: "login" }));');
    expect(application.text).toContain("toastRegion.replaceChildren();");
    expect(application.text).toContain("showAuth(false);");
    expect(application.text).toMatch(/systemRestartDetected = true;[\s\S]*?invalidateAuthentication\(\);[\s\S]*?return true;/u);
    expect(application.text).toContain('if (!state.user && document.documentElement.classList.contains("login-route")) return;');
    expect(application.text).toContain("if (hasUnsavedEditorChanges()) event.preventDefault();");
    expect(application.text).toContain('document.addEventListener("visibilitychange", () => {');
  });
});
