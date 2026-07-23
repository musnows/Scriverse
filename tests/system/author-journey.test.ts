import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createRuntime } from "../../src/app.js";

describe("作者完整创作流程", () => {
  let runtime: Runtime;
  let mockServer: ReturnType<typeof createServer>;
  let baseUrl: string;
  const receivedBodies: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    mockServer = createServer(async (incoming: IncomingMessage, outgoing: ServerResponse) => {
      if (incoming.url === "/v1/models") {
        outgoing.writeHead(200, { "Content-Type": "application/json" });
        outgoing.end(JSON.stringify({ data: [{ id: "system-novel-model" }] }));
        return;
      }
      if (incoming.url === "/v1/chat/completions" && incoming.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        receivedBodies.push(body);
        const messages = body.messages as Array<{ content: string }>;
        const prompt = messages[1]?.content ?? "";
        let content = "舱门关闭，林舟望向逐渐远去的北港。";
        if (prompt.includes("检查下面的续写候选")) {
          content = "[]";
        } else if (prompt.includes("抽取大事件候选")) {
          content = JSON.stringify([{ name: "北港启航", description: "林舟驾驶飞船离开北港。", eventType: "离别", timeLabel: "启航日", timeSort: 1, location: "北港", impactScope: "personal", chapterIds: [], participantIds: [], evidence: [{ quote: "飞船驶离北港" }] }]);
        } else if (prompt.includes("小说人物关系抽取器")) {
          const chapters = [...prompt.matchAll(/<CHAPTER id="([^"]+)" title="([^"]+)">/gu)];
          content = JSON.stringify([{ fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "旧友", directed: false, currentStatus: "active", timeRange: { start: "第一卷" }, confidence: 0.82, evidence: chapters.map((match, index) => ({ chapterId: match[1], chapterTitle: match[2], quote: index === 0 ? "林舟想起沈星的警告" : "沈星仍保存着林舟的旧信", contextType: "current", supports: "两人保持长期联系" })) }]);
        }
        if (body.stream === true) {
          outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
          outgoing.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "舱门关闭，" } }] })}\n\n`);
          await new Promise((resolve) => setTimeout(resolve, 8));
          outgoing.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "飞船离开北港。" }, finish_reason: "stop" }] })}\n\n`);
          outgoing.end("data: [DONE]\n\n");
          return;
        }
        outgoing.writeHead(200, { "Content-Type": "application/json" });
        outgoing.end(JSON.stringify({ choices: [{ message: { content } }] }));
        return;
      }
      outgoing.writeHead(404).end();
    });
    mockServer.listen(0, "127.0.0.1");
    await once(mockServer, "listening");
    const address = mockServer.address();
    if (!address || typeof address === "string") throw new Error("Mock server failed to start");
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "system-test-master-secret-with-enough-length",
      disableUserAuth: true,
      serveUi: true
    });
  });

  afterAll(async () => {
    runtime.close();
    mockServer.close();
    await once(mockServer, "close");
  });

  it("正文编辑区在章节概览隐藏时仍占满剩余高度", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    expect(page.text).toContain('<div class="editor-body">');
    expect(page.text).toContain('id="chapter-line-numbers"');
    expect(page.text).toContain('id="toggle-whitespace-button"');
    expect(page.text).toContain('id="chapter-whitespace-overlay"');
    expect(page.text).toContain('id="new-volume-button"');
    expect(application.text).toContain("选择第 ${index + 1} 行");
    expect(page.text).toContain('id="left-panel-resize"');
    expect(page.text).toContain('id="ai-panel-resize"');
    expect(page.text).toContain('<div class="panel-heading">');
    expect(page.text).toContain('<div class="ai-heading">');
    expect(styles.text).toContain(".editor-view { container-name: editor-workspace; container-type: inline-size; display: grid; grid-template-rows: auto minmax(0, 1fr); height: 100%; }");
    expect(styles.text).toContain("@container editor-workspace (max-width: 720px)");
    expect(styles.text).toContain(".chapter-stats { display: none; }");
    expect(styles.text).toContain(".editor-body { display: flex; min-height: 0; flex-direction: column; }");
    expect(styles.text).toContain(".chapter-editor-frame { position: relative; display: grid;");
    expect(application.text).toContain("function renderChapterLineNumbers()");
    expect(application.text).toContain("syncChapterLineNumberScroll");
    expect(application.text).toContain("function renderChapterWhitespaceMarkers(input, style)");
    expect(application.text).toContain('/whitespace-visualization.js?v=20260718-visible-whitespace');
    expect(application.text).toContain("function setupPanelResize(handle, side)");
    expect(application.text).toContain("function ensureAiPanelExpanded()");
    expect(styles.text).toContain(".app-shell.left-panel-collapsed");
    expect(styles.text).toContain(".app-shell.left-panel-collapsed .panel-heading");
    expect(styles.text).toContain(".app-shell.ai-panel-collapsed .ai-heading");
    expect(application.text).toContain("function addSelectedLinesAsCitation()");
    expect(application.text).toContain("input.setSelectionRange(selection.startOffset, selection.startOffset)");
    expect(application.text).toContain('addEventListener("contextmenu"');
    expect(application.text).toContain("state.aiCitations.map");
    expect(application.text).toContain('addEventListener("pointermove"');
    expect(styles.text).toContain(".chapter-line-number.is-line-selected");
    expect(styles.text).toContain(".chapter-line-number.is-line-selected::after");
    expect(styles.text).toContain(".chapter-space-marker::after");
    expect(styles.text).toContain(".chapter-space-marker.tab::after");
    expect(styles.text).toContain("width: 100vw; height: 100%");
    expect(styles.text).toContain("grid-template-columns: 38px minmax(0, 1fr)");
    expect(styles.text).toContain("width: 100%; min-height: 0; margin: 0;");
    expect(styles.text).toContain("font-variant-numeric: tabular-nums; text-align: center");
    expect(styles.text).toContain("font-size: clamp(11px, calc(var(--editor-font-size) * .72), 14px); line-height: 1.2");
    expect(styles.text).toContain("align-items: flex-start; justify-content: center");
    expect(styles.text).toContain("grid-template-columns: minmax(0, 1fr) max-content");
    expect(styles.text).toContain("overflow-wrap: anywhere; line-height: 1.45; white-space: normal");
    expect(page.text).toContain('id="ai-citations"');
    expect(page.text).toContain('id="line-citation-menu"');
  });

  it("作品切换和新建只保留在书架首页", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    expect(page.text).not.toContain('id="work-picker"');
    expect(page.text).not.toContain('id="new-work-button"');
    expect(page.text).toContain('id="shelf-new-work"');
    expect(application.text).toContain('id="book-add-card"');
    expect(application.text).not.toContain('$("#work-picker")');
  });

  it("全站使用黑体与等宽英文并提供可持久化显示和明暗主题", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const theme = await request(runtime.app).get("/theme.js").expect(200);
    await request(runtime.app).get("/theme-init.js").expect(200);
    expect(page.text).toContain('id="appearance-button"');
    expect(page.text).toContain('id="appearance-dialog"');
    expect(page.text).toContain('id="theme-toggle"');
    expect(page.text).toContain('theme-icon-moon');
    expect(page.text).toContain('theme-icon-sun');
    expect(page.text).toContain("英文字体（仅等宽）");
    expect(styles.text).toContain('--font-cjk: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Heiti SC";');
    expect(styles.text).toContain('--font-latin: "SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono";');
    expect(styles.text).toContain("--editor-line-height: 1.55;");
    expect(styles.text.replaceAll("sans-serif", "").toLowerCase()).not.toContain("serif");
    expect(application.text).toContain('const typographyStorageKey = "ai-novel-typography-v1";');
    expect(application.text).toContain("localStorage.setItem(typographyStorageKey");
    expect(styles.text).toContain(':root[data-theme="dark"]');
    expect(theme.text).toContain('THEME_STORAGE_KEY = "scriverse-color-theme-v1"');
  });

  it("首次登录展示指向真实控件的聚光灯导览", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);
    expect(page.text).toContain('id="onboarding-dialog"');
    expect(page.text).toContain('data-testid="first-use-onboarding"');
    expect(page.text).toContain('id="onboarding-menu-button"');
    expect(page.text).toContain('id="onboarding-spotlight"');
    expect(page.text).toContain('id="onboarding-popover"');
    expect(page.text).not.toContain("data-onboarding-step");
    expect(application.text).toContain("const shelfOnboardingSteps = [");
    expect(application.text).toContain("const workspaceOnboardingSteps = [");
    expect(application.text).toContain("function positionOnboardingElements()");
    expect(application.text).toContain('selector: "#new-chapter-button"');
    expect(application.text).toContain('selector: ".quick-actions button[data-task=\\"continue\\"]"');
    expect(application.text).toContain("function scheduleFirstUseOnboarding()");
    expect(application.text).toContain('api("/api/auth/onboarding/complete", { method: "POST", body: {} })');
    expect(application.text).toContain('addEventListener("cancel"');
    expect(application.text).toContain('event.key === "Escape"');
    expect(styles.text).toContain(".onboarding-dialog {");
    expect(styles.text).toContain(".onboarding-spotlight {");
    expect(styles.text).toContain("0 0 0 9999px rgba(20,18,16,.7)");
    expect(styles.text).toContain('.onboarding-popover[data-placement="right"]::before');
  });

  it("复杂人物使用分区编辑器并提供版本历史与回滚入口", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);
    await request(runtime.app).get("/character-version.js").expect(200);
    expect(page.text).toContain('id="entity-editor-view"');
    expect(page.text).toContain('id="setting-editor-form"');
    expect(page.text).toContain('id="character-editor-form"');
    expect(page.text).toContain('id="knowledge-editor-form"');
    expect(page.text).toContain('id="character-history-button"');
    expect(page.text.match(/data-character-editor-tab=/gu)).toHaveLength(5);
    expect(page.text).toContain('data-character-editor-tab="relationships"');
    expect(page.text).toContain("保存新版本");
    expect(application.text).toContain("function renderCharacterEditorFields(item)");
    expect(application.text).toContain("function openSettingEditor(item = null)");
    expect(application.text).toContain("function openCharacterEditor(item = null)");
    expect(application.text).toContain("function renderKnowledgeEditorFields(kind, item, memberOptions, parentOptions)");
    expect(application.text).toContain("async function openKnowledgeEditor(kind, item)");
    expect(application.text).toContain("async function openOrganizationDialog(item)");
    expect(application.text).toContain("function renderCharacterEditorRelationships()");
    expect(application.text).toContain("refreshRelationshipSurfaces");
    expect(application.text).toContain("data-character-relationship-edit");
    expect(application.text).toContain('field("keywords", "关系关键词", "keyword-chips"');
    expect(application.text).toContain("splitRelationshipKeywordInput");
    expect(application.text).toContain('form.getAll("keywords")');
    expect(application.text).toContain("function renderCharacterHistory()");
    expect(application.text).toContain("/versions`");
    expect(application.text).toContain("/restore`");
    expect(application.text).toContain("buildCharacterState(form.getAll");
    expect(application.text).toContain("function openEntityMergeDialog(");
    expect(application.text).toContain("data-merge-character");
    expect(application.text).toContain("data-delete-character");
    expect(application.text).toContain("data-merge-race");
    expect(application.text).toContain("data-delete-race");
    expect(application.text).toContain("data-merge-organization");
    expect(application.text).toContain("data-delete-organization");
    expect(application.text).toContain("/merge`");
    expect(styles.text).toContain(".character-editor-workspace");
    expect(styles.text).toContain(".entity-editor-view");
    expect(styles.text).toContain("#setting-editor-form { display: grid; grid-template-rows: auto minmax(0, 1fr);");
    expect(styles.text).toContain("#knowledge-editor-form { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }");
    expect(styles.text).toContain('.setting-markdown-compose > div[role="region"], .markdown-editor-compose > div[role="region"]');
    expect(styles.text).toContain(".setting-editor-title-input");
    expect(styles.text).toContain(".setting-editor-header-fields");
    expect(styles.text).toContain(".character-relationship-row");
    expect(styles.text).toContain(".keyword-chip-editor");
    expect(styles.text).toContain(".character-version-card");
    expect(styles.text).toContain(".card-actions .danger-button");
    expect(styles.text).toContain(".merge-dialog-note");
  });

  it("首屏书架、大纲伏笔、续写守卫和关系银河图资源完整可达", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const analysisTypes = await request(runtime.app).get("/analysis-types.js").expect(200);
    const modelConfig = await request(runtime.app).get("/model-config.js").expect(200);
    const graph = await request(runtime.app).get("/relationship-graph.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);
    const workPermissions = await request(runtime.app).get("/work-permissions.js").expect(200);
    const markdown = await request(runtime.app).get("/markdown.js").expect(200);
    const icon = await request(runtime.app).get("/icon.svg").expect(200).expect("Content-Type", /svg/u);
    const manifest = await request(runtime.app).get("/site.webmanifest").expect(200);
    expect(page.text).toContain('id="shelf-view"');
    expect(page.text).toContain('id="platform-ai-view"');
    expect(page.text).toContain('id="platform-ai-button"');
    expect(page.text).toContain('rel="icon" href="/icon.svg?v=20260712"');
    expect(page.text).toContain('rel="manifest" href="/site.webmanifest"');
    expect(page.text).toContain('/app.js?v=20260723-module-layout-toggle');
    expect(page.text).toContain('/styles.css?v=20260723-module-layout-toggle');
    expect(application.text).toContain('/relationship-graph.js?v=20260721-release-0.3.6');
    expect(graph.text).toContain('path.setAttribute("marker-end", `url(#${arrowMarkerId})`)');
    expect(graph.text).toContain("assignRelationshipEdgeCurves(graph.edges)");
    expect(graph.text).toContain('statuses.push("待确认")');
    expect(graph.text).toContain('selection.endpointNames.join(selection.directed ? " → " : " ↔ ")');
    expect(application.text).toContain('/race-hierarchy.js?v=20260721-race-hierarchy');
    expect(graph.text).toContain('fullscreen.className = "ghost-button relationship-galaxy-button"');
    expect(graph.text).toContain('class="relationship-galaxy-icon"');
    expect(graph.text).toContain('aria-label", "全屏银河图"');
    expect(styles.text).toContain(".relationship-galaxy-icon {");
    expect(page.text).toContain('id="avatar-file"');
    expect(page.text).toContain('id="profile-avatar-preview"');
    expect(page.text).toContain('id="avatar-upload-button"');
    expect(page.text).toContain('id="avatar-remove-button"');
    expect(application.text).toContain('api("/api/auth/avatar", { method: "PUT", body })');
    expect(application.text).toContain('api("/api/auth/avatar", { method: "DELETE" })');
    expect(application.text).toContain("function renderUserAvatar(element, user)");
    expect(styles.text).toContain(".profile-avatar-preview");
    expect(page.text).toContain('id="api-key-reset-button"');
    expect(page.text).toContain("新 Key 仅显示一次");
    expect(application.text).toContain('api("/api/auth/api-key/reset"');
    expect(application.text).toContain('/analysis-types.js?v=20260721-analysis-descriptions');
    expect(analysisTypes.text).toContain('label: "世界观分析"');
    expect(analysisTypes.text).toContain('desc: "归纳正文中的自然、社会、历史、科技、文化等世界观维度，同时标出冲突和证据不足之处。"');
    expect(styles.text).toContain(".analysis-type-description");
    expect(application.text).toContain('data-setting-status="confirmed"');
    expect(application.text).toContain('review: "已完成"');
    expect(application.text).not.toContain('review: "待审核"');
    expect(application.text).toContain('"分析已完成"');
    expect(application.text).not.toContain("结果进入审核状态");
    expect(styles.text).toContain("--toast-bg:");
    expect(styles.text).toContain(":root[data-theme=\"dark\"]");
    expect(styles.text).toContain("background: var(--toast-bg)");
    expect(page.text).toContain('id="platform-ui-settings-button" class="settings-hub-card hidden"');
    expect(page.text).toContain('id="platform-ui-settings-dialog"');
    expect(page.text).toContain('data-position="bottom-right"');
    expect(application.text).toContain('api("/api/ui-settings")');
    expect(application.text).toContain('api("/api/platform/ui-settings"');
    expect(styles.text).toContain('.toast-region[data-position="top-right"]');
    expect(styles.text).toContain('.toast-region[data-position="bottom-right"]');
    expect(styles.text).not.toContain(".task-table .task-id");
    expect(application.text).not.toContain("<th>ID</th><th>任务</th>");
    expect(page.text).toContain('id="top-search-button"');
    expect(page.text).toContain('id="user-management-button" class="settings-hub-card hidden"');
    expect(page.text).toContain('id="search-dialog"');
    expect(page.text).not.toContain('id="search-button"');
    expect(page.text).toContain('class="prompt-composer"');
    expect(page.text).toContain('class="ai-send-button"');
    expect(page.text).toContain('id="ai-context-meter"');
    expect(application.text).toContain("function scheduleChapterAutoSave(delay = chapterAutoSaveDelay)");
    expect(application.text).toContain('source: automatic ? "auto" : "manual"');
    expect(markdown.text).toContain("export function renderMarkdown");
    expect(markdown.text).toContain("safeLinkTarget");
    expect(markdown.text).toContain("renderMarkdownTable");
    expect(application.text).toContain('/markdown.js?v=20260722-inline-code');
    expect(application.text).toContain('/character-markdown.js?v=20260723-clipboard-images');
    expect(application.text).toContain('Mac Command+V 或 Windows、Linux Ctrl+V');
    expect(page.text).toContain('id="character-section-editor-view"');
    expect(page.text).toContain('id="knowledge-section-editor-view"');
    expect(application.text).toContain('id="character-section-markdown"');
    expect(application.text).toContain("attachment://${attachment.id}");
    expect(application.text).toContain("read_character_sections");
    expect(styles.text).toContain(".message-body .markdown-table-scroll");
    expect(styles.text).toContain(".character-markdown-compose");
    expect(styles.text).toContain("#character-section-editor-view");
    expect(styles.text).toContain("#knowledge-section-editor-view");
    expect(styles.text).toContain("scrollbar-gutter: stable");
    expect(styles.text).toContain("white-space: nowrap");
    expect(icon.body.toString("utf8")).toContain("一本展开的书与一颗星");
    expect(manifest.body.short_name).toBe("叙界");
    expect(page.text).toContain('data-testid="book-shelf"');
    expect(application.text).toContain('data-testid="book-add-card"');
    expect(application.text).toContain('id="work-access-title">成员权限</strong>');
    expect(application.text).toContain('id="work-access-manage"');
    expect(application.text).toContain('按成员配置</span><span>按模块授权</span><span>读写分离</span>');
    expect(page.text).toContain('id="member-user-select"');
    expect(page.text).toContain('id="member-permission-fieldset"');
    expect(page.text).toContain('id="member-permission-grid"');
    expect(page.text).toContain('data-permission-preset="read"');
    expect(application.text).toContain('data-member-permission=');
    expect(application.text).toContain('body: existing ? { permissions } : { userId, permissions }');
    expect(application.text).toContain('/work-permissions.js?v=20260722-module-permissions');
    expect(workPermissions.text).toContain('label: "AI 对话与分析"');
    expect(workPermissions.text).toContain('export function canWriteUiModule');
    expect(application.text).toContain('classList.toggle("view-only-mode", viewOnly)');
    expect(application.text).toContain('classList.toggle("prose-hidden-mode", proseHidden)');
    expect(application.text).toContain('classList.toggle("permission-hidden", !canReadModule(item.uiModule))');
    expect(application.text).toContain('$("#module-nav [data-work-settings]").classList.toggle("permission-hidden"');
    expect(application.text).toContain('$(".ai-panel").classList.toggle("permission-hidden", aiHidden)');
    expect(styles.text).toContain("body.work-viewer-mode [data-edit-setting]");
    expect(styles.text).toContain("body.work-viewer-mode [data-merge-review]");
    expect(application.text).toContain('item.status === "pending" && canResolveReview');
    expect(application.text).toContain('canReadCharacters ? apiAllPages');
    expect(application.text).toContain('const canReadAggregate = hasWork && canReadAggregateContent()');
    expect(styles.text).toContain(".app-shell.prose-read-only-mode:not(.shelf-mode) #new-chapter-button");
    expect(styles.text).toContain(".member-permission-grid");
    expect(styles.text).toContain(".work-access-options");
    expect(application.text).toContain('class="book-card-settings"');
    expect(application.text).toContain("function workCoverFieldHtml(work)");
    expect(application.text).toContain('id="work-cover-upload"');
    expect(application.text).not.toContain("book-card-actions");
    expect(application.text).not.toContain("本书追加系统提示词");
    expect(application.text).toContain('aria-label="本书系统提示词"');
    expect(application.text).toContain("modelOptionLabel({ ...model, providerName: model.providerName || provider?.name })");
    expect(application.text).not.toContain("${esc(model.displayName)} · ${esc(model.modelId)}");
    expect(application.text).toContain("function openTaskDetailDialog(task)");
    expect(application.text).toContain('id="task-auto-run-enabled"');
    expect(application.text).toContain("自动执行待分析任务");
    expect(application.text).toContain("不会自动创建人物关系、世界观或其他分析");
    expect(application.text).toContain("同时运行上限");
    expect(application.text).toContain("每轮任务上限");
    expect(application.text).toContain("开始下一轮");
    expect(application.text).not.toContain("消化 pending 任务");
    expect(application.text).toContain("/tasks/auto-run");
    expect(styles.text).toContain(".task-auto-run-panel");
    expect(application.text).toContain("memberDialogWork ?? state.work");
    expect(application.text).toContain('const platformDocumentTitle = "叙界 · 小说 AI 创作工作台"');
    expect(application.text).toContain('document.title = workTitle ? `${workTitle} · 叙界` : platformDocumentTitle');
    expect(application.text).toContain("updateDocumentTitle(state.work)");
    expect(page.text).toContain('data-module="outlines"');
    expect(page.text).toContain('<span class="nav-label">大纲与伏笔</span>');
    expect(page.text).toContain('<button class="ai-analysis-entry" type="button" data-module="tasks">');
    expect(page.text).toContain('</svg>AI 分析</button>');
    expect(page.text).toContain('id="module-more-button"');
    expect(page.text).toContain('<span class="nav-label">更多</span>');
    expect(page.text.match(/class="module-nav-secondary hidden"/gu)).toHaveLength(4);
    expect(page.text).toContain('</svg>种族</button>');
    expect(page.text.match(/class="nav-icon"/gu)).toHaveLength(13);
    expect(page.text).toContain('data-module="ai-settings"');
    expect(page.text).toContain('data-work-settings');
    expect(page.text).toContain(">作品设置</button>");
    expect(application.text).toContain('button.hasAttribute("data-work-settings")');
    expect(application.text).toContain("openWorkSettingsDialog(work)");
    expect(application.text).toContain('tasks: ["AI 深度分析", "AI 分析中心"');
    expect(application.text).toContain('openDialog("开始 AI 分析"');
    expect(application.text).toContain('selector: "[data-module=\\"tasks\\"]"');
    expect(styles.text).toContain(".module-nav .ai-analysis-entry");
    expect(page.text).toContain('data-testid="relationship-fullscreen"');
    expect(page.text).toContain('data-testid="relationship-map-expanded"');
    expect(page.text).toContain('class="relationship-map-floating-close"');
    expect(page.text).not.toContain('id="relationship-map-dialog-title"');
    expect(page.text).toContain('data-testid="chapter-type-menu"');
    expect(application.text).toContain("async function renderOutlines()");
    expect(application.text).toContain("function setModuleNavExpanded(expanded)");
    expect(application.text).toContain('data-testid="timeline-kanban"');
    expect(application.text).toContain("function openTimelineTrackDialog(item)");
    expect(styles.text).toContain(".timeline-kanban { display: grid; grid-auto-flow: column;");
    expect(application.text).toContain("async function streamChat(body)");
    expect(application.text).toContain("content.innerHTML = renderMarkdown(streamedText)");
    expect(application.text).toContain('class="message-body"');
    expect(styles.text).toContain(".message-body h1, .message-body h2");
    expect(styles.text).toContain(".prompt-composer-actions { position: absolute; right: 8px; bottom: 8px;");
    expect(styles.text).toContain(".account-menu button { min-height: 30px; padding: 6px 9px; border: 1px solid var(--line);");
    expect(styles.text).toContain("font-size: 10px; }");
    expect(styles.text).toContain(".account-menu button:hover, .account-menu button:focus-visible");
    expect(styles.text).toContain(".book-info > span { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.4; }");
    expect(styles.text).not.toContain("-webkit-box-orient: vertical; min-height: 2.8em;");
    expect(styles.text).toContain(".config-section:first-child { margin-top: 0; padding-top: 0; border-top: 0; }");
    expect(styles.text).toContain(".book-card-settings {");
    expect(styles.text).toContain("padding: 2px 6px;");
    expect(styles.text).toContain(".left-panel { border-right: 1px solid var(--line); padding: 18px 14px 16px; overflow-y: auto; }");
    expect(styles.text).toContain(".left-actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; margin: 0 0 15px; }");
    expect(application.text).toContain('$("#ai-send").textContent = "发送中"');
    expect(application.text).toContain('content: normalizeParagraphSpacing($("#chapter-content").value)');
    expect(application.text).toContain("collapseChapterInputBlankLines(event.currentTarget)");
    expect(application.text).toContain("function openVolumeDialog(item)");
    expect(application.text).toContain('field("keywords", "分卷关键词（逐条填写）", "item-list"');
    expect(application.text).not.toContain("data-edit-volume");
    expect(application.text).toContain('title="左键折叠，右键设置分卷"');
    expect(application.text).toContain('button.dataset.volumeToggle));');
    expect(application.text).toContain('class="record-card character-card" data-open-character');
    expect(application.text).toContain("所属组织");
    expect(application.text).toContain('card.addEventListener("keydown"');
    expect(page.text).toContain('data-module="races"');
    expect(application.text).toContain("async function renderRaces()");
    expect(application.text).toContain("async function openRaceDialog(item)");
    expect(application.text).toContain('field("parentRaceId", "父种族", "select"');
    expect(application.text).toContain('class="race-tree-node" open');
    expect(application.text).toContain('field("raceId", "种族", "select"');
    expect(application.text).not.toContain('field("species", "种族", "text"');
    expect(application.text).toContain('field("memberIds", isRace ? "属于该种族的角色（可多选）" : "组织成员（可多选）", "chips"');
    expect(application.text).toContain('field("organizationIds", "所属组织（可多选）", "chips"');
    expect(application.text).toContain('input.setAttribute("aria-label", rows.dataset.label || "列表项目")');
    expect(application.text).toContain('Number(chapter.wordCount ?? 0).toLocaleString("zh-CN")}</small>');
    expect(application.text).toContain('<span>${volume.chapters.length} 章</span>');
    expect(application.text).toContain("function renderKnowledgeMarkdownSections()");
    expect(application.text).toContain("data-knowledge-section-create");
    expect(application.text).toContain("function openKnowledgeSectionEditor");
    expect(application.text).toContain('data.getAll("memberIds")');
    expect(styles.text).toContain(".chip-picker { display: flex; flex-wrap: wrap;");
    expect(styles.text).toContain(".relationship-map-expanded-host .relationship-map-toolbar { padding-right: 72px; }");
    expect(styles.text).toContain(".relationship-map-expanded-host .relationship-mindmap { height: calc(100% - 67px); min-height: 0; }");
    expect(application.text).toContain('field("maxTokens", "最大输出 Token 数", "number", item?.maxTokens ?? 32000)');
    expect(application.text).toContain('field("contextWindow", "模型上下文总量（Token）", "number", values.contextWindow)');
    expect(application.text).toContain('field("thinkingEnabled", "开启 Thinking（供应商需支持 thinking 参数）", "checkbox", values.thinkingEnabled)');
    expect(modelConfig.text).toContain("contextWindow: model?.contextWindow ?? 128000");
    expect(modelConfig.text).toContain("thinkingEnabled: model?.thinkingEnabled ?? true");
    expect(modelConfig.text).toContain("maxTokens: model?.preset?.max_tokens ?? 32000");
    expect(application.text).toContain('async function renderPlatformAiConfig()');
    expect(application.text).toContain('async function renderBookAiSettings()');
    expect(application.text).toContain('function scheduleAiContextUsage()');
    expect(application.text).toContain('addEventListener("contextmenu"');
    expect(application.text).toContain("collapsedVolumeIds");
    expect(application.text).toContain('data-testid="continuation-guard"');
    expect(graph.text).toContain("export function buildRelationshipGraph");
    expect(graph.text).toContain("export function formatRelationshipLabel");
    expect(graph.text).toContain("export function groupRelationshipDetailsByCharacterName");
    expect(graph.text).toContain("export function layoutRelationshipNetwork");
    expect(graph.text).toContain('viewport.dataset.testid = "relationship-network"');
    expect(graph.text).toContain('viewport.dataset.interaction = "dragging"');
    expect(graph.text).toContain("highlightedKeywords.push(fullLabel)");
    expect(graph.text).toContain("const label = fullLabel.length > 42");
    expect(graph.text).toContain("export function createGalaxyRenderer");
    expect(graph.text).toContain("export function createGalaxyStarfield");
    expect(graph.text).toContain("export function projectGalaxyPoint");
    expect(graph.text).toContain("export function getGalaxyNodeFocusCamera");
    expect(graph.text).toContain("focusCameraOnNode(node)");
    expect(graph.text).toContain("duration: 650");
    expect(graph.text).toContain('shell.dataset.sceneDimension = "3"');
    expect(graph.text).toContain("export const GALAXY_ROTATION_RADIANS_PER_MS = 0.000012");
    expect(graph.text).toContain("camera.yaw += elapsed * GALAXY_ROTATION_RADIANS_PER_MS");
    expect(page.text).toContain('data-testid="galaxy-3d-starfield"');
    expect(page.text).toContain('data-testid="galaxy-3d-relationships"');
    expect(graph.text).toContain('expand.dataset.testid = "relationship-map-expand"');
    expect(graph.text).toContain("viewport.dataset.draggedNodeId = node.id");
    expect(graph.text).toContain("viewport.dataset.graphScale = viewScale.toFixed(3)");
    expect(graph.text).toContain("expanded: Object.freeze({ width: 1600, height: 900");
    expect(graph.text).toContain("repulsionStrength: 22800");
    expect(graph.text).toContain("viewport.dataset.layoutWidth = String(layout.width)");
    expect(graph.text).toContain('edgeDetail.className = "mind-edge-detail hidden"');
    expect(styles.text).toContain(".mind-edge-detail { position: absolute;");
    expect(graph.text).toContain('viewport.addEventListener("wheel"');
    expect(graph.text).toContain('button.addEventListener("pointermove"');
    expect(graph.text).toContain("shell.dataset.draggedNodeId = node.id");
    expect(graph.text).toContain("Math.sqrt(node.degree / maxDegree)");
    expect(graph.text).toContain("export function getGalaxyNodeAppearance");
    expect(graph.text).toContain('button.dataset.relationshipTier = appearance.tier');
    expect(graph.text).toContain('button.dataset.celestialType = appearance.celestialType');
    expect(graph.text).not.toContain('button.title = `${node.degree} 条关系');
    expect(graph.text).toContain('button.style.setProperty("--node-color", appearance.color)');
    expect(graph.text).toContain("getGalaxyNodeDepthOpacity(point.depth)");
    expect(graph.text).toContain("initialNodePositions");
    expect(styles.text).toContain(".book-shelf");
    expect(styles.text).toContain(".galaxy-dialog");
    expect(styles.text).toContain(".galaxy-shell.is-rotating-camera");
    expect(styles.text).toContain("grid-template-rows: var(--node-size) auto");
    expect(styles.text).toContain("--node-color");
    expect(styles.text).toContain("--node-brightness");
    expect(styles.text).toContain('[data-celestial-type="ringed"]');
    expect(application.text).toContain('id="create-character-audit-task"');
    expect(application.text).toContain("data-merge-review");
    expect(application.text).toContain("data-keep-characters-separate");
    expect(styles.text).toContain(".character-duplicate-pair");
  });

  it("从导入作品到采纳续写、抽取时间轴并安全导出", async () => {
    await request(runtime.app).get("/api/health").expect(200);
    const page = await request(runtime.app).get("/").expect(200).expect("Content-Type", /html/u);
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");

    const work = await request(runtime.app).post("/api/works").send({ title: "星际纪元", author: "作者" }).expect(201);
    const workId = work.body.data.id;
    const imported = await request(runtime.app).post(`/api/works/${workId}/import`)
      .attach("file", Buffer.from("第一卷 启航\n第一章 北港\n飞船停在北港。林舟检查跃迁引擎。林舟想起沈星的警告。\n第二章 旧信\n沈星仍保存着林舟的旧信。"), "星际纪元.txt")
      .expect(201);
    expect(JSON.stringify(imported.body)).not.toContain("飞船停在北港。");
    const directory = await request(runtime.app).get(`/api/works/${workId}`).expect(200);
    const chapterId = directory.body.data.volumes[0].chapters[0].id;

    await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "跃迁冷却规则",
      category: "世界规则",
      content: "飞船每次跃迁后必须冷却十二小时。",
      status: "confirmed",
      locked: true
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "林舟",
      attributes: { species: "人类" },
      currentState: { location: "北港" },
      lockedFields: ["species", "location"]
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "沈星",
      aliases: ["沈博士"],
      currentState: { location: "主星" }
    }).expect(201);

    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "系统测试模型服务",
      baseUrl,
      apiKey: "sk-system-test-secret",
      status: "enabled"
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "长篇创作模型",
      modelId: "system-novel-model",
      purposes: ["创作续写", "时间轴分析"]
    }).expect(201);

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "用一句话描述离港",
      scope: { type: "chapter", chapterId },
      modelId: model.body.data.id
    }).expect(200).expect("Content-Type", /text\/event-stream/u);
    expect(streamed.text).toContain('event: delta\ndata: {"delta":"舱门关闭，林舟望向逐渐远去的北港。"}');
    expect(streamed.text).toContain("event: complete");

    const suggestion = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "continue",
      instruction: "续写离港场景，不能让飞船立即再次跃迁。",
      scope: { type: "chapter", chapterId },
      modelId: model.body.data.id
    }).expect(201);
    const beforeAccept = await request(runtime.app).get(`/api/chapters/${chapterId}`).expect(200);
    expect(beforeAccept.body.data.versionNo).toBe(1);
    expect(beforeAccept.body.data.content).not.toContain("舱门关闭");

    const accepted = await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/accept`).send({}).expect(200);
    expect(accepted.body.data.chapter.versionNo).toBe(2);
    expect(accepted.body.data.chapter.content).toContain("舱门关闭");

    const timelineTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "timeline-analysis",
      scope: { type: "book" }
    }).expect(201);
    const completedTask = await request(runtime.app).post(`/api/tasks/${timelineTask.body.data.id}/run`).send({ modelId: model.body.data.id }).expect(200);
    expect(completedTask.body.data).toMatchObject({ status: "review", progress: 100 });
    expect(completedTask.body.data.result.candidateCount).toBe(1);

    const timeline = await request(runtime.app).get(`/api/works/${workId}/timeline`).expect(200);
    expect(timeline.body.data[0]).toMatchObject({ name: "北港启航", status: "candidate" });

    const relationshipTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "book" }
    }).expect(201);
    const relationshipResult = await request(runtime.app).post(`/api/tasks/${relationshipTask.body.data.id}/run`).send({ modelId: model.body.data.id }).expect(200);
    expect(relationshipResult.body.data.result.candidateCount).toBe(1);
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data[0]).toMatchObject({ category: "social", subtype: "朋友", confidence: 0.82, confirmationStatus: "pending" });
    expect(relationships.body.data[0].evidence).toHaveLength(2);

    const search = await request(runtime.app).get(`/api/works/${workId}/search?q=${encodeURIComponent("北港")}`).expect(200);
    expect(search.body.data.some((item: { type: string }) => item.type === "chapter")).toBe(true);

    const exported = await request(runtime.app).get(`/api/works/${workId}/export?format=json`).expect(200);
    const serialized = JSON.stringify(exported.body);
    expect(serialized).toContain("北港启航");
    expect(serialized).not.toContain("sk-system-test-secret");
    expect(serialized).not.toContain("encrypted_key");

    const modelRequest = receivedBodies.find((body) => JSON.stringify(body).includes("续写离港场景"));
    expect(JSON.stringify(modelRequest)).toContain("飞船每次跃迁后必须冷却十二小时");
    expect(JSON.stringify(modelRequest)).toContain("species=人类");
  }, 20_000);
});
