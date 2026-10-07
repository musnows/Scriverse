import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { historyActionForRouteChange, pageLocationKey, parsePageRoute, serializePageRoute, shouldCommitModuleRoute } from "../../src/public/page-route.js";

describe("页面刷新路由", () => {
  it("往返保存作品模块与当前章节", () => {
    const moduleHash = serializePageRoute({ view: "module", workId: "work / 1", module: "races" });
    expect(parsePageRoute(moduleHash)).toEqual({ view: "module", workId: "work / 1", module: "races" });
    const draftsHash = serializePageRoute({ view: "module", workId: "work-1", module: "drafts" });
    expect(parsePageRoute(draftsHash)).toEqual({ view: "module", workId: "work-1", module: "drafts" });
    const commentsHash = serializePageRoute({ view: "module", workId: "work-1", module: "comments" });
    expect(parsePageRoute(commentsHash)).toEqual({ view: "module", workId: "work-1", module: "comments" });

    const editorHash = serializePageRoute({ view: "editor", workId: "work-1", chapterId: "chapter-18" });
    expect(parsePageRoute(editorHash)).toEqual({ view: "editor", workId: "work-1", chapterId: "chapter-18" });

    const readerHash = serializePageRoute({ view: "reader", workId: "work-1", chapterId: "chapter-18" });
    expect(parsePageRoute(readerHash)).toEqual({ view: "reader", workId: "work-1", chapterId: "chapter-18" });
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
    const usageHash = serializePageRoute({
      view: "platform-usage",
      workId: "work-1",
      returnView: "shelf"
    });
    expect(parsePageRoute(usageHash)).toEqual({
      view: "platform-usage",
      workId: "work-1",
      returnView: "shelf"
    });
    const auditHash = serializePageRoute({
      view: "work-audit",
      workId: "work-1",
      returnView: "module",
      returnModule: "timeline"
    });
    expect(parsePageRoute(auditHash)).toEqual({
      view: "work-audit",
      workId: "work-1",
      returnView: "module",
      returnModule: "timeline"
    });
  });

  it("往返保存登录页路由", () => {
    expect(serializePageRoute({ view: "login" })).toBe("#view=login");
    expect(parsePageRoute("#view=login")).toEqual({ view: "login" });
  });

  it("往返保存全局 IM 工作区路由", () => {
    expect(serializePageRoute({ view: "im" })).toBe("#view=im");
    expect(parsePageRoute("#view=im")).toEqual({ view: "im" });
    const settingsHash = serializePageRoute({ view: "settings", workId: "work-1", returnView: "im" });
    expect(parsePageRoute(settingsHash)).toEqual({ view: "settings", workId: "work-1", returnView: "im" });
  });

  it("往返保存设定、角色、种族和组织全屏编辑页", () => {
    const settingHash = serializePageRoute({ view: "entity-editor", workId: "work-1", entity: "setting", entityId: "setting-2", entityMode: "read" });
    expect(parsePageRoute(settingHash)).toEqual({ view: "entity-editor", workId: "work-1", entity: "setting", entityId: "setting-2", entityMode: "read" });

    const characterHash = serializePageRoute({ view: "entity-editor", workId: "work-1", entity: "character" });
    expect(parsePageRoute(characterHash)).toEqual({ view: "entity-editor", workId: "work-1", entity: "character", entityId: null, entityMode: "edit" });

    for (const entity of ["race", "organization"]) {
      const hash = serializePageRoute({ view: "entity-editor", workId: "work-1", entity });
      expect(parsePageRoute(hash)).toEqual({ view: "entity-editor", workId: "work-1", entity, entityId: null, entityMode: "edit" });
    }
  });

  it("把章节切换推进历史，同一页面只替换地址", () => {
    const analysis = "#view=module&work=work-1&module=tasks";
    expect(historyActionForRouteChange(analysis, { view: "editor", workId: "work-1", chapterId: "chapter-40" })).toBe("push");
    expect(pageLocationKey(parsePageRoute(analysis))).not.toBe(pageLocationKey({ view: "editor", workId: "work-1", chapterId: "chapter-40" }));
    const chapter = serializePageRoute({ view: "editor", workId: "work-1", chapterId: "chapter-40" });
    expect(parsePageRoute(chapter)).toEqual({ view: "editor", workId: "work-1", chapterId: "chapter-40" });
    expect(historyActionForRouteChange(chapter, { view: "editor", workId: "work-1", chapterId: "chapter-40" })).toBe("replace");
    expect(historyActionForRouteChange(chapter, { view: "module", workId: "work-1", module: "characters" })).toBe("push");
    expect(historyActionForRouteChange(chapter, { view: "module", workId: "work-1", module: "settings" })).toBe("push");
  });

  it("新建实体获得编号时不额外增加历史记录", () => {
    const creating = serializePageRoute({ view: "entity-editor", workId: "work-1", entity: "character" });
    expect(historyActionForRouteChange(creating, { view: "entity-editor", workId: "work-1", entity: "character", entityId: "character-1" })).toBe("replace");
    expect(historyActionForRouteChange(creating, { view: "entity-editor", workId: "work-1", entity: "setting", entityId: "setting-1" })).toBe("push");
  });

  it("模块加载完成时不能覆盖已经打开的章节", () => {
    expect(shouldCommitModuleRoute(1, 1, "tasks", "tasks")).toBe(true);
    expect(shouldCommitModuleRoute(1, 2, "tasks", "editor")).toBe(false);
    expect(shouldCommitModuleRoute(2, 2, "tasks", "characters")).toBe(false);
    const application = readFileSync(new URL("../../src/public/app.js", import.meta.url), "utf8");
    expect(application).toContain("shouldCommitModuleRoute(navigationToken, pageNavigationToken, module, state.module)");
    expect(application).toContain("historyActionForRouteChange");
    expect(application).toContain('addEventListener("popstate", scheduleHistorySync)');
    expect(application).toContain("beginPageNavigation()");
  });

  it("拒绝未知模块和不完整作品地址", () => {
    expect(parsePageRoute("#view=module&work=work-1&module=unknown")).toEqual({ view: "shelf" });
    expect(parsePageRoute("#view=editor&chapter=chapter-1")).toEqual({ view: "shelf" });
    expect(serializePageRoute({ view: "module", workId: "work-1", module: "unknown" })).toBe("#view=shelf");
    expect(parsePageRoute("#view=entity-editor&work=work-1&entity=unknown")).toEqual({ view: "shelf" });
    expect(parsePageRoute("#view=work-audit")).toEqual({ view: "shelf" });
    expect(serializePageRoute({ view: "work-audit" })).toBe("#view=shelf");
  });
});
