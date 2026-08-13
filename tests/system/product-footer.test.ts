import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

  it("在登录、书架和设置页展示版本与仓库信息", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);
    const health = await request(runtime.app).get("/api/health").expect(200);

    expect(page.text.match(/<footer class="[^"]*product-footer[^"]*" data-product-footer/gu)).toHaveLength(3);
    expect(page.text.match(/© <time data-product-footer-year><\/time>/gu)).toHaveLength(3);
    expect(page.text.match(/href="https:\/\/github.com\/musnows\/Scriverse"/gu)).toHaveLength(3);
    expect(page.text).not.toContain('href="https://github.com/musnows"');
    expect(page.text).not.toContain(">musnows</a>");
    expect(page.text.match(/class="product-footer-meta"/gu)).toHaveLength(3);
    expect(page.text.match(/aria-hidden="true">·<\/span>/gu)).toHaveLength(6);
    expect(page.text.match(/aria-label="在 GitHub 查看叙界仓库">GitHub<\/a>/gu)).toHaveLength(3);
    expect(page.text).not.toContain(">GitHub · musnows/Scriverse</a>");
    expect(page.text.match(/data-product-footer-development>开发模式<\/span>/gu)).toHaveLength(3);
    expect(page.text).toContain('class="settings-update-dot hidden" data-settings-update-dot');
    expect(page.text).toContain('class="product-footer-update hidden" data-product-footer-update');
    expect(application.text).toContain("async function initializeProductFooters()");
    expect(application.text).toContain("function applyProductUpdateMetadata(update)");
    expect(application.text).toContain('api("/api/update-check")');
    expect(application.text).toContain('element.textContent = `发现新版本 v${latestVersion}，查看更新说明`;');
    expect(application.text).toContain('const [authenticated] = await Promise.all([initializeAuthentication(), initializeProductFooters()]);');
    expect(styles.text).toContain(".shelf-view { display: flex; flex-direction: column; height: 100%;");
    expect(styles.text).toContain('[data-pending-view="shelf"] .auth-pending #shelf-view.hidden,');
    expect(styles.text).toContain('[data-pending-view="work-audit"] .auth-pending #work-audit-view.hidden { display: flex !important; }');
    expect(styles.text).toContain("#shelf-view, #settings-hub-view { padding-bottom: 24px; }");
    expect(styles.text).toContain("width: 100%; min-width: 0; max-width: 1400px;");
    expect(styles.text).toContain("margin: auto auto 0;");
    expect(styles.text).toContain("grid-template-rows: minmax(min-content, 1fr) auto;");
    expect(styles.text).toContain(".product-footer-meta { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }");
    expect(styles.text).toContain(".product-footer-development {");
    expect(styles.text).toContain(".settings-update-dot {");
    expect(styles.text).toContain(".product-footer .product-footer-update {");
    expect(health.body.data).toMatchObject({ version: APP_VERSION, development: true });
    expect(health.body.data.bootId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("通过公开接口返回最新稳定版探测结果", async () => {
    const releaseFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      tag_name: "v99.0.0",
      html_url: "https://github.com/musnows/Scriverse/releases/tag/v99.0.0"
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const releaseRuntime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "release-update-system-test-secret",
      disableUserAuth: true,
      serveUi: false,
      releaseFetchImpl: releaseFetch
    });
    try {
      const update = await request(releaseRuntime.app).get("/api/update-check").expect(200);
      expect(update.body.data).toMatchObject({
        checked: true,
        updateAvailable: true,
        currentVersion: APP_VERSION,
        latestVersion: "99.0.0",
        releaseUrl: "https://github.com/musnows/Scriverse/releases/tag/v99.0.0"
      });
      expect(update.body.data.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(update.body.data.nextCheckAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    } finally {
      await releaseRuntime.close();
    }
  });

  it("缓存带版本静态资源并保持页面和接口不可缓存", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const versionedApplication = await request(runtime.app).get("/app.js?v=asset-version").expect(200);
    const cachedApplication = await request(runtime.app).get("/app.js?v=asset-version")
      .set("If-None-Match", String(versionedApplication.headers.etag))
      .expect(304);
    const unversionedApplication = await request(runtime.app).get("/app.js").expect(200);
    const versionedVendor = await request(runtime.app).get("/vendor/vditor/dist/index.min.js?v=3.11.2").expect(200);
    const health = await request(runtime.app).get("/api/health").expect(200);

    expect(page.headers["cache-control"]).toBe("no-store");
    expect(versionedApplication.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(cachedApplication.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(versionedVendor.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(unversionedApplication.headers["cache-control"]).toBe("public, max-age=3600, must-revalidate");
    expect(health.headers["cache-control"]).toBe("no-store");
  });
});
