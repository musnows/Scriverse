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
    expect(page.text.match(/class="product-footer-meta"/gu)).toHaveLength(3);
    expect(page.text.match(/aria-hidden="true">·<\/span>/gu)).toHaveLength(6);
    expect(page.text.match(/aria-label="在 GitHub 查看叙界仓库">GitHub<\/a>/gu)).toHaveLength(3);
    expect(page.text).not.toContain(">GitHub · musnows/Scriverse</a>");
    expect(page.text.match(/data-product-footer-development>开发模式<\/span>/gu)).toHaveLength(3);
    expect(application.text).toContain("async function initializeProductFooters()");
    expect(application.text).toContain('const [authenticated] = await Promise.all([initializeAuthentication(), initializeProductFooters()]);');
    expect(styles.text).toContain(".shelf-view { display: flex; flex-direction: column; height: 100%;");
    expect(styles.text).toContain("#shelf-view, #settings-hub-view { padding-bottom: 24px; }");
    expect(styles.text).toContain("width: 100%; min-width: 0; max-width: 1400px;");
    expect(styles.text).toContain("margin: auto auto 0;");
    expect(styles.text).toContain("grid-template-rows: minmax(min-content, 1fr) auto;");
    expect(styles.text).toContain(".product-footer-meta { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }");
    expect(styles.text).toContain(".product-footer-development {");
    expect(health.body.data).toMatchObject({ version: APP_VERSION, development: true });
  });
});
