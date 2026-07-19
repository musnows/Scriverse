import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("注册入口状态", () => {
  let runtime: Runtime;

  beforeAll(() => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "auth-registration-ui-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
  });

  afterAll(() => runtime.close());

  it("关闭注册时展示不可交互的注册已禁用状态", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);

    expect(page.text).toContain('id="auth-register-tab"');
    expect(application.text).toContain('registerTab.disabled = !canRegister;');
    expect(application.text).toContain('registerTab.setAttribute("aria-disabled", String(!canRegister));');
    expect(application.text).toContain('registerTab.textContent = canRegister ? "注册" : "注册已禁用";');
    expect(application.text).toContain('const login = mode === "login" || registerTab.disabled;');
    expect(application.text).not.toContain('$("#auth-register-tab").classList.toggle("hidden", !canRegister);');
    expect(styles.text).toContain(".auth-tabs button:disabled {");
    expect(styles.text).toContain("cursor: not-allowed;");
  });
});
