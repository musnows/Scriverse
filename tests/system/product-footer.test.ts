import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { APP_VERSION } from "../../src/version.js";

describe("产品信息页脚", () => {
  let runtime: Runtime;

  beforeAll(() => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "product-footer-system-test-secret",
      disableUserAuth: true,
      serveUi: true,
      developmentServer: true
    });
  });

  afterAll(() => runtime.close());

  it("在登录、书架和设置页展示作者、版本与仓库信息", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);
    const health = await request(runtime.app).get("/api/health").expect(200);

    expect(page.text.match(/<footer class="[^"]*product-footer[^"]*" data-product-footer/gu)).toHaveLength(3);
    expect(page.text.match(/© <time data-product-footer-year><\/time>/gu)).toHaveLength(3);
    expect(page.text.match(/href="https:\/\/github.com\/musnows\/Scriverse"/gu)).toHaveLength(3);
    expect(page.text.match(/data-product-footer-development>开发模式<\/span>/gu)).toHaveLength(3);
    expect(application.text).toContain("async function initializeProductFooters()");
    expect(application.text).toContain('const [authenticated] = await Promise.all([initializeAuthentication(), initializeProductFooters()]);');
    expect(styles.text).toContain(".product-footer-development {");
    expect(health.body.data).toMatchObject({ version: APP_VERSION, development: true });
  });
});
