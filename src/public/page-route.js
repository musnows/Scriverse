export const RESTORABLE_MODULES = Object.freeze([
  "drafts",
  "settings",
  "characters",
  "races",
  "organizations",
  "timeline",
  "comments",
  "outlines",
  "relationships",
  "reviews",
  "tasks",
  "ai-settings"
]);

const moduleSet = new Set(RESTORABLE_MODULES);
const returnViewSet = new Set(["shelf", "im", "editor", "module", "welcome"]);
const entityEditorSet = new Set(["setting", "character", "race", "organization"]);

function value(params, key) {
  return String(params.get(key) ?? "").trim();
}

function appendReturnContext(params, route) {
  const returnView = returnViewSet.has(route.returnView) ? route.returnView : "";
  if (!returnView) return;
  params.set("from", returnView);
  if (returnView === "module" && moduleSet.has(route.returnModule)) params.set("fromModule", route.returnModule);
  if (returnView === "editor" && route.returnChapterId) params.set("fromChapter", String(route.returnChapterId));
}

export function serializePageRoute(route = {}) {
  const params = new URLSearchParams();
  const view = String(route.view ?? "shelf");
  const workId = String(route.workId ?? "").trim();

  if (view === "login") {
    params.set("view", "login");
  } else if (view === "im") {
    params.set("view", "im");
  } else if (view === "editor" && workId) {
    params.set("view", "editor");
    params.set("work", workId);
    if (route.chapterId) params.set("chapter", String(route.chapterId));
  } else if (view === "reader" && workId) {
    params.set("view", "reader");
    params.set("work", workId);
    if (route.chapterId) params.set("chapter", String(route.chapterId));
  } else if (view === "module" && workId && moduleSet.has(route.module)) {
    params.set("view", "module");
    params.set("work", workId);
    params.set("module", route.module);
  } else if (view === "entity-editor" && workId && entityEditorSet.has(route.entity)) {
    params.set("view", "entity-editor");
    params.set("work", workId);
    params.set("entity", route.entity);
    if (route.entityId) params.set("id", String(route.entityId));
    if (route.entityMode === "read") params.set("mode", "read");
  } else if (view === "welcome" && workId) {
    params.set("view", "welcome");
    params.set("work", workId);
  } else if (view === "settings" || view === "platform-ai" || view === "platform-usage" || (view === "work-audit" && workId)) {
    params.set("view", view);
    if (workId) params.set("work", workId);
    appendReturnContext(params, route);
  } else {
    params.set("view", "shelf");
  }

  return `#${params.toString()}`;
}

export function parsePageRoute(hash = "") {
  const params = new URLSearchParams(String(hash).replace(/^#/, ""));
  const view = value(params, "view");
  const workId = value(params, "work");

  if (view === "login") return { view: "login" };
  if (view === "im") return { view: "im" };

  if (view === "editor" && workId) {
    const chapterId = value(params, "chapter");
    return { view, workId, chapterId: chapterId || null };
  }
  if (view === "reader" && workId) {
    const chapterId = value(params, "chapter");
    return { view, workId, chapterId: chapterId || null };
  }
  if (view === "module" && workId) {
    const module = value(params, "module");
    return moduleSet.has(module) ? { view, workId, module } : { view: "shelf" };
  }
  if (view === "entity-editor" && workId) {
    const entity = value(params, "entity");
    if (!entityEditorSet.has(entity)) return { view: "shelf" };
    const entityId = value(params, "id");
    const entityMode = value(params, "mode") === "read" ? "read" : "edit";
    return { view, workId, entity, entityId: entityId || null, entityMode };
  }
  if (view === "welcome" && workId) return { view, workId };
  if (view === "settings" || view === "platform-ai" || view === "platform-usage" || (view === "work-audit" && workId)) {
    const route = { view, workId: workId || null };
    const returnView = value(params, "from");
    if (returnViewSet.has(returnView)) route.returnView = returnView;
    const returnModule = value(params, "fromModule");
    if (returnView === "module" && moduleSet.has(returnModule)) route.returnModule = returnModule;
    const returnChapterId = value(params, "fromChapter");
    if (returnView === "editor" && returnChapterId) route.returnChapterId = returnChapterId;
    return route;
  }
  return { view: "shelf" };
}

// 地址里要能区分作品、模块、章节和实体。阅读/编辑模式、设置返回来源不算另一次页面跳转。
export function pageLocationKey(route = {}) {
  const parsed = route.view ? route : { view: "shelf" };
  const view = String(parsed.view ?? "shelf");
  const workId = String(parsed.workId ?? "");
  if (view === "login" || view === "shelf" || view === "im") return view;
  if (view === "editor" || view === "reader") return `${view}\u001f${workId}\u001f${String(parsed.chapterId ?? "")}`;
  if (view === "module") return `module\u001f${workId}\u001f${String(parsed.module ?? "")}`;
  if (view === "entity-editor") return `entity\u001f${workId}\u001f${String(parsed.entity ?? "")}\u001f${String(parsed.entityId ?? "")}`;
  if (view === "welcome") return `welcome\u001f${workId}`;
  if (view === "settings" || view === "platform-ai" || view === "platform-usage" || view === "work-audit") return `${view}\u001f${workId}`;
  return "shelf";
}

export function historyActionForRouteChange(currentHash = "", nextRoute = {}) {
  const next = parsePageRoute(serializePageRoute(nextRoute));
  const current = parsePageRoute(currentHash);
  if (pageLocationKey(current) === pageLocationKey(next)) return "replace";
  if (
    current.view === "entity-editor"
    && next.view === "entity-editor"
    && current.workId === next.workId
    && current.entity === next.entity
    && !current.entityId
    && next.entityId
  ) return "replace";
  return "push";
}

// 模块列表是异步加载的。加载结束时如果用户已经打开章节或其他模块，就不能再提交旧地址。
export function shouldCommitModuleRoute(navigationToken, currentToken, moduleName, activeModule) {
  return navigationToken === currentToken && String(moduleName) === String(activeModule);
}
