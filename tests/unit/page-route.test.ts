import { describe, expect, it } from "vitest";
import { parsePageRoute, serializePageRoute } from "../../src/public/page-route.js";

describe("页面刷新路由", () => {
  it("往返保存作品模块与当前章节", () => {
    const moduleHash = serializePageRoute({ view: "module", workId: "work / 1", module: "races" });
    expect(parsePageRoute(moduleHash)).toEqual({ view: "module", workId: "work / 1", module: "races" });

    const editorHash = serializePageRoute({ view: "editor", workId: "work-1", chapterId: "chapter-18" });
    expect(parsePageRoute(editorHash)).toEqual({ view: "editor", workId: "work-1", chapterId: "chapter-18" });
  });

  it("保存设置页面及其返回位置", () => {
    const hash = serializePageRoute({
      view: "settings",
      workId: "work-1",
      returnView: "module",
      returnModule: "relationships"
    });
    expect(parsePageRoute(hash)).toEqual({
      view: "settings",
      workId: "work-1",
      returnView: "module",
      returnModule: "relationships"
    });
  });

  it("往返保存登录页路由", () => {
    expect(serializePageRoute({ view: "login" })).toBe("#view=login");
    expect(parsePageRoute("#view=login")).toEqual({ view: "login" });
  });

  it("拒绝未知模块和不完整作品地址", () => {
    expect(parsePageRoute("#view=module&work=work-1&module=unknown")).toEqual({ view: "shelf" });
    expect(parsePageRoute("#view=editor&chapter=chapter-1")).toEqual({ view: "shelf" });
    expect(serializePageRoute({ view: "module", workId: "work-1", module: "unknown" })).toBe("#view=shelf");
  });
});
