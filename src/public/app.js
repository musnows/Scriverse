import { buildRelationshipGraph, createGalaxyRenderer, renderRelationshipMindMap } from "/relationship-graph.js?v=20260721-release-0.3.6";
import { collapseExcessBlankLines, formatDateTime, normalizeParagraphSpacing } from "/text-formatting.js?v=20260713-saved-at-seconds";
import { renderMarkdown } from "/markdown.js?v=20260722-inline-code";
import { buildAiReferenceScope, findAiMention, listAiMentionOptions } from "/ai-mentions.js?v=20260716-chapter-references";
import { shouldShowAiQuickActions } from "/ai-conversation.js?v=20260713-quick-actions";
import { calculateLineNumberRowHeight, calculateLineNumberRowTop, calculateLineNumberTextOffset, calculateLineNumberTop } from "/line-number-layout.js?v=20260713-row-box-alignment";
import { MODEL_PURPOSE_OPTIONS, modelFormValues, modelOptionLabel, modelPayload } from "/model-config.js?v=20260718-thinking-toggle";
import { shouldSendAiPrompt } from "/ai-prompt-keyboard.js?v=20260713-enter-to-send";
import { estimateAiMessageTokens, formatAiMessageMeta } from "/ai-message-meta.js?v=20260713-persisted-output-tokens";
import { formatAiMessageTime } from "/ai-message-time.js?v=20260713-cross-day-time";
import { formatAiContextUsageTooltip } from "/ai-context-meter.js?v=20260718-layered-context";
import { copyAiRawMarkdown } from "/ai-message-actions.js?v=20260713-copy-raw-markdown";
import { THEME_STORAGE_KEY, nextTheme, normalizeTheme, themeToggleLabel } from "/theme.js?v=20260713-dark-mode";
import { buildCharacterDetails, buildCharacterState, characterStateEntries, normalizeCharacterDetails, normalizeCharacterSections } from "/character-profile.js?v=20260713-character-editor";
import { characterVersionSourceLabel, describeCharacterVersionChanges } from "/character-version.js?v=20260713-character-history";
import { VERSIONED_ENTITY_LABELS, entityVersionSnapshotSummary, entityVersionSourceLabel } from "/entity-version.js?v=20260714-all-knowledge-history";
import { parsePageRoute, serializePageRoute } from "/page-route.js?v=20260723-knowledge-editor-page";
import { splitRelationshipKeywordInput, splitRelationshipKeywords, uniqueRelationshipKeywords } from "/relationship-keywords.js?v=20260720-relationship-keyword-chips";
import { tokenizeVisibleSpaces } from "/whitespace-visualization.js?v=20260718-visible-whitespace";
import { buildRaceForest, eligibleRaceParents, racePathLabel } from "/race-hierarchy.js?v=20260721-race-hierarchy";
import { ANALYSIS_TYPES, analysisTypeDescription } from "/analysis-types.js?v=20260721-analysis-descriptions";
import { WORK_PERMISSION_MODULES, canReadUiModule, canWriteUiModule, emptyModulePermissions, firstReadableUiModule, normalizeModulePermissions, permissionSummary } from "/work-permissions.js?v=20260722-module-permissions";
import { MODULE_LAYOUT_STORAGE_KEY, LEGACY_SETTINGS_LAYOUT_STORAGE_KEY, normalizeModuleLayout, moduleLayoutLabel } from "/module-layout.js?v=20260723-module-layout-toggle";

const state = {
  user: null,
  csrfToken: null,
  works: [],
  work: null,
  chapter: null,
  module: "editor",
  models: [],
  characters: [],
  races: [],
  organizations: [],
  timelineTracks: [],
  aiCitations: [],
  aiReferences: [],
  aiPromptSent: false,
  aiConversationId: null,
  aiConversations: [],
  aiLastMessageAt: null,
  settings: [],
  dirty: false,
  pendingImportMeta: null,
  pendingCoverWorkId: null,
  relationshipGraph: null,
  galaxy: null,
  relationshipMindMap: null,
  relationshipExpandedMap: null,
  collapsedVolumeIds: new Set(),
  contextChapterId: null
};

const chapterTypes = ["正文", "设定", "作者的话", "其他"];

const taskTypeLabels = MODEL_PURPOSE_OPTIONS;
const analysisTaskTypeLabels = new Map([
  ...MODEL_PURPOSE_OPTIONS,
  ["character-extraction", "全书角色抽取"],
  ["character-summary", "全书角色抽取"],
  ["character-identity-audit", "AI 角色查重"],
  ["worldview-analysis", "世界观分析"],
  ["setting-extraction", "设定抽取"],
  ["structure", "结构分析"],
  ["report-update", "报告更新"]
]);

function analysisTaskTypeLabel(taskType) {
  return analysisTaskTypeLabels.get(String(taskType)) ?? String(taskType);
}

function analysisTaskStatusLabel(status) {
  return ({
    pending: "待执行",
    running: "运行中",
    review: "已完成",
    completed: "已完成",
    partial: "部分失败",
    expired: "已过期",
    cancelled: "已取消"
  })[String(status)] ?? String(status);
}

function canEditWork(work = state.work) {
  return WORK_PERMISSION_MODULES.some((item) => canWriteUiModule(work, item.uiModule));
}

function canEditProse(work = state.work) {
  return canWriteUiModule(work, "editor");
}

function canReplaceProse(work = state.work) {
  return WORK_PERMISSION_MODULES
    .filter((item) => item.id !== "ai-settings")
    .every((item) => canWriteUiModule(work, item.uiModule));
}

function canManageWork(work = state.work) {
  return ["admin", "owner"].includes(String(work?.accessRole));
}

function canEditModule(module, work = state.work) {
  return canWriteUiModule(work, module);
}

function canReadModule(module, work = state.work) {
  return canReadUiModule(work, module);
}

function canReadAggregateContent(work = state.work) {
  return ["editor", "settings", "characters", "races", "organizations", "timeline", "relationships", "outlines"]
    .every((module) => canReadModule(module, work));
}

function applyWorkAccessMode() {
  const viewOnly = Boolean(state.work) && !canEditWork();
  const proseReadOnly = Boolean(state.work) && !canEditProse();
  const proseHidden = Boolean(state.work) && !canReadModule("editor");
  const aiHidden = Boolean(state.work) && !canReadModule("tasks");
  const aiReadOnly = Boolean(state.work) && !canEditModule("tasks");
  const moduleReadOnly = Boolean(state.work) && !canEditModule(state.module);
  $("#app").classList.toggle("view-only-mode", viewOnly);
  $("#app").classList.toggle("prose-read-only-mode", proseReadOnly);
  $("#app").classList.toggle("prose-hidden-mode", proseHidden);
  $("#app").classList.toggle("ai-hidden-mode", aiHidden);
  document.body.classList.toggle("work-viewer-mode", moduleReadOnly);
  for (const item of WORK_PERMISSION_MODULES) {
    const button = $(`#module-nav [data-module="${item.uiModule}"]`);
    if (button) button.classList.toggle("permission-hidden", !canReadModule(item.uiModule));
  }
  $("#module-nav [data-work-settings]").classList.toggle("permission-hidden", Boolean(state.work) && !canManageWork());
  $("#new-volume-button").classList.toggle("permission-hidden", Boolean(state.work) && proseReadOnly);
  $("#welcome-new-work").classList.toggle("permission-hidden", Boolean(state.work) && proseReadOnly);
  $("#import-file-button").setAttribute("aria-disabled", String(proseReadOnly));
  $("#import-file-button").setAttribute("title", proseReadOnly ? "当前权限不能导入正文" : "导入 TXT / DOCX");
  $("#import-file").disabled = proseReadOnly;
  $(".ai-panel").classList.toggle("permission-hidden", aiHidden);
  $("#chapter-title").readOnly = proseReadOnly;
  $("#chapter-content").readOnly = proseReadOnly;
  $("#chapter-title").setAttribute("aria-readonly", String(proseReadOnly));
  $("#chapter-content").setAttribute("aria-readonly", String(proseReadOnly));
  $("#ai-prompt").readOnly = aiReadOnly;
  $("#ai-prompt").setAttribute("aria-readonly", String(aiReadOnly));
  $("#ai-send").classList.toggle("permission-hidden", aiReadOnly);
  if (proseReadOnly) {
    cancelChapterAutoSave();
    state.dirty = false;
  }
}

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const maximumAvatarFileSize = 5 * 1024 * 1024;

function userAvatarInitial(user) {
  return Array.from(String(user?.displayName || user?.username || "作"))[0] ?? "作";
}

function userAvatarHtml(user, extraClass = "") {
  const image = user?.avatarUrl
    ? `<img src="${esc(user.avatarUrl)}" alt="" loading="lazy" decoding="async" data-user-avatar-image>`
    : "";
  return `<span class="user-avatar ${esc(extraClass)}" aria-hidden="true"><span class="user-avatar-fallback">${esc(userAvatarInitial(user))}</span>${image}</span>`;
}

function bindUserAvatarFallbacks(root) {
  root.querySelectorAll("[data-user-avatar-image]").forEach((image) => {
    image.addEventListener("error", () => image.remove(), { once: true });
  });
}

function renderUserAvatar(element, user) {
  element.replaceChildren();
  const fallback = document.createElement("span");
  fallback.className = "user-avatar-fallback";
  fallback.textContent = userAvatarInitial(user);
  element.append(fallback);
  if (!user?.avatarUrl) return;
  const image = document.createElement("img");
  image.alt = "";
  image.decoding = "async";
  image.src = user.avatarUrl;
  image.addEventListener("error", () => image.remove(), { once: true });
  element.append(image);
}

function renderProfileAvatar() {
  renderUserAvatar($("#profile-avatar-preview"), state.user);
  $("#avatar-upload-button").textContent = state.user?.avatarUrl ? "更换头像" : "上传头像";
  $("#avatar-remove-button").classList.toggle("hidden", !state.user?.avatarUrl);
}
const platformDocumentTitle = "叙界 · 小说 AI 创作工作台";
const panelLayoutStorageKey = "ai-novel-panel-layout-v1";
const panelLayoutDefaults = Object.freeze({ leftWidth: 280, aiWidth: 360, leftCollapsed: false, aiCollapsed: false });
let restoringPageRoute = true;
let memberDialogWork = null;
let memberDialogMembers = [];
let memberDialogDirectory = [];
let onboardingStep = 0;
let onboardingAutoScheduled = false;
let onboardingPositionFrame = null;
let onboardingSteps = [];
let loadedAiModelsWorkId = null;
let loadedAiReferencesWorkId = null;
let loadedAiConversationsWorkId = null;
let aiModelsLoadPromise = null;
let aiModelsLoadWorkId = null;
let aiReferencesLoadPromise = null;
let aiReferencesLoadWorkId = null;
let aiConversationsLoadPromise = null;
let aiConversationsLoadWorkId = null;
let workScopedUiGeneration = 0;
let importHistoryRecords = [];
let importHistoryNextPage = null;
let importHistoryRequestId = 0;

const shelfOnboardingSteps = [
  { selector: "#home-button", eyebrow: "作品入口", title: "这里是你的创作书架", description: "点击左上角的叙界标志，可以随时回到书架，在不同作品之间切换。", placement: "bottom" },
  { selector: "#shelf-new-work", eyebrow: "开始创作", title: "创建一部新作品", description: "从空白作品开始搭建分卷、章节和世界设定。", placement: "bottom" },
  { selector: "#book-add-card", eyebrow: "导入或新建", title: "从书架添加作品", description: "这个卡片同样可以创建作品，也支持在进入工作台后导入 TXT 或 DOCX 稿件。", placement: "right" },
  { selector: "[data-open-work]", eyebrow: "继续写作", title: "打开已有作品", description: "每部作品都有独立的正文、知识库、AI 上下文与协作权限。", placement: "right" },
  { selector: "#theme-toggle", eyebrow: "显示偏好", title: "切换白天或黑夜模式", description: "主题和字体设置只保存在当前设备，不会影响其他协作者。", placement: "bottom" },
  { selector: "#settings-button", eyebrow: "工作台设置", title: "集中管理创作环境", description: "进入设置后可以管理 AI、显示偏好、作品协作与导出。", placement: "bottom" },
  { selector: "#account-button", eyebrow: "账户", title: "管理个人账户", description: "这里可以修改账户资料、退出登录，并随时重新打开功能导览。", placement: "bottom" }
];

const workspaceOnboardingSteps = [
  { selector: "#home-button", eyebrow: "作品入口", title: "随时返回书架", description: "点击叙界标志返回书架，切换作品或创建新的故事世界。", placement: "bottom" },
  { selector: ".file-button", eyebrow: "稿件导入", title: "导入 TXT 或 DOCX", description: "已有稿件可以直接导入，系统会解析分卷与章节结构。", placement: "right" },
  { selector: "[data-new-chapter-volume]", eyebrow: "正文结构", title: "新建章节", description: "使用分卷和章节组织长篇正文，章节会自动保存并保留版本。", placement: "right" },
  { selector: "#versions-button", eyebrow: "版本安全", title: "查看章节版本", description: "每次保存都会生成可恢复版本，误改内容时可以随时回溯。", placement: "bottom" },
  { selector: "[data-module=\"characters\"]", eyebrow: "作品知识", title: "维护角色与世界资料", description: "角色、种族、组织、设定和时间线共同构成 AI 可引用的作品知识。", placement: "right" },
  { selector: "[data-module=\"outlines\"]", eyebrow: "创作规划", title: "跟踪大纲与伏笔", description: "记录剧情目标、冲突、转折和伏笔回收，避免长线遗漏。", placement: "right" },
  { selector: "[data-module=\"tasks\"]", eyebrow: "AI 分析中心", title: "从这里理解整部小说", description: "运行人物、关系、世界观、设定、事件和一致性分析，并查看每次分析的结果与进度。", placement: "right" },
  { selector: "#top-search-button", eyebrow: "全文检索", title: "搜索整部作品", description: "一次检索正文、角色、设定、种族与组织，快速定位创作依据。", placement: "bottom" },
  { selector: ".quick-actions button[data-task=\"continue\"]", eyebrow: "AI 快捷指令", title: "让创作助手基于正文工作", description: "总结、续写、剧情方向和冲突检查都以已保存内容为依据。", placement: "left" },
  { selector: "#ai-send", eyebrow: "AI 对话", title: "发送你的创作要求", description: "选择上下文范围与模型后发送任务。AI 结果默认只是建议，不会直接覆盖正文。", placement: "left" },
  { selector: "#settings-button", eyebrow: "工作台设置", title: "管理 AI、协作与导出", description: "供应商、显示偏好、作品成员和 Markdown 导出都集中在这里。", placement: "bottom" },
  { selector: "#account-button", eyebrow: "账户", title: "管理账户并重看导览", description: "账户菜单保存个人设置入口，也可以随时重新打开这套功能导览。", placement: "bottom" }
];

function hasCompletedOnboarding() {
  return state.user?.onboardingCompleted === true;
}

function persistOnboardingCompletion() {
  if (!state.user || state.user.onboardingCompleted) return;
  state.user = { ...state.user, onboardingCompleted: true };
  api("/api/auth/onboarding/complete", { method: "POST", body: {} })
    .then((user) => { state.user = user; })
    .catch(() => { state.user = { ...state.user, onboardingCompleted: false }; });
}

function isOnboardingTargetVisible(target) {
  if (!target) return false;
  const style = window.getComputedStyle(target);
  const rect = target.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0
    && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0
    && rect.left < window.innerWidth && rect.top < window.innerHeight;
}

function currentOnboardingSteps() {
  const candidates = $("#app").classList.contains("shelf-mode") ? shelfOnboardingSteps : workspaceOnboardingSteps;
  return candidates.filter((step) => isOnboardingTargetVisible(document.querySelector(step.selector)));
}

function onboardingPlacementCoordinates(placement, targetRect, popoverRect, gap) {
  if (placement === "right") return { left: targetRect.right + gap, top: targetRect.top + (targetRect.height - popoverRect.height) / 2 };
  if (placement === "left") return { left: targetRect.left - popoverRect.width - gap, top: targetRect.top + (targetRect.height - popoverRect.height) / 2 };
  if (placement === "top") return { left: targetRect.left + (targetRect.width - popoverRect.width) / 2, top: targetRect.top - popoverRect.height - gap };
  return { left: targetRect.left + (targetRect.width - popoverRect.width) / 2, top: targetRect.bottom + gap };
}

function onboardingPlacementFits(placement, targetRect, popoverRect, gap, margin) {
  if (placement === "right") return targetRect.right + gap + popoverRect.width <= window.innerWidth - margin;
  if (placement === "left") return targetRect.left - gap - popoverRect.width >= margin;
  if (placement === "top") return targetRect.top - gap - popoverRect.height >= margin;
  return targetRect.bottom + gap + popoverRect.height <= window.innerHeight - margin;
}

function positionOnboardingElements() {
  onboardingPositionFrame = null;
  const dialog = $("#onboarding-dialog");
  const step = onboardingSteps[onboardingStep];
  if (!dialog.open || !step) return;
  const target = document.querySelector(step.selector);
  if (!isOnboardingTargetVisible(target)) return;
  const padding = 7;
  const targetBox = target.getBoundingClientRect();
  const targetRect = {
    left: Math.max(0, targetBox.left - padding),
    top: Math.max(0, targetBox.top - padding),
    right: Math.min(window.innerWidth, targetBox.right + padding),
    bottom: Math.min(window.innerHeight, targetBox.bottom + padding)
  };
  targetRect.width = targetRect.right - targetRect.left;
  targetRect.height = targetRect.bottom - targetRect.top;
  const spotlight = $("#onboarding-spotlight");
  spotlight.style.left = `${targetRect.left}px`;
  spotlight.style.top = `${targetRect.top}px`;
  spotlight.style.width = `${targetRect.width}px`;
  spotlight.style.height = `${targetRect.height}px`;

  const popover = $("#onboarding-popover");
  popover.style.visibility = "hidden";
  popover.style.left = "0px";
  popover.style.top = "0px";
  const popoverRect = popover.getBoundingClientRect();
  const gap = 18;
  const margin = 14;
  const placements = [step.placement, "right", "left", "bottom", "top"].filter((placement, index, values) => values.indexOf(placement) === index);
  const placement = placements.find((candidate) => onboardingPlacementFits(candidate, targetRect, popoverRect, gap, margin)) ?? step.placement;
  const coordinates = onboardingPlacementCoordinates(placement, targetRect, popoverRect, gap);
  const left = Math.max(margin, Math.min(window.innerWidth - popoverRect.width - margin, coordinates.left));
  const top = Math.max(margin, Math.min(window.innerHeight - popoverRect.height - margin, coordinates.top));
  const arrowOffset = placement === "left" || placement === "right"
    ? targetRect.top + targetRect.height / 2 - top
    : targetRect.left + targetRect.width / 2 - left;
  const maximumArrowOffset = (placement === "left" || placement === "right" ? popoverRect.height : popoverRect.width) - 26;
  popover.dataset.placement = placement;
  popover.style.setProperty("--onboarding-arrow-offset", `${Math.max(26, Math.min(maximumArrowOffset, arrowOffset))}px`);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.style.visibility = "visible";
}

function scheduleOnboardingPosition() {
  if (!$("#onboarding-dialog").open) return;
  if (onboardingPositionFrame !== null) return;
  onboardingPositionFrame = window.requestAnimationFrame(positionOnboardingElements);
}

function refreshOnboardingForViewport() {
  const dialog = $("#onboarding-dialog");
  if (!dialog.open) return;
  if (onboardingPositionFrame !== null) window.cancelAnimationFrame(onboardingPositionFrame);
  onboardingPositionFrame = window.requestAnimationFrame(() => {
    onboardingPositionFrame = null;
    const currentSelector = onboardingSteps[onboardingStep]?.selector;
    const refreshedSteps = currentOnboardingSteps();
    if (!refreshedSteps.length) return;
    onboardingSteps = refreshedSteps;
    const preservedStep = onboardingSteps.findIndex((step) => step.selector === currentSelector);
    renderOnboardingStep(preservedStep >= 0 ? preservedStep : 0);
  });
}

function renderOnboardingStep(step, focusTitle = false) {
  const lastStep = Math.max(0, onboardingSteps.length - 1);
  onboardingStep = Math.max(0, Math.min(lastStep, Number(step) || 0));
  const current = onboardingSteps[onboardingStep];
  if (!current) return;
  $("#onboarding-progress").textContent = `第 ${onboardingStep + 1} 步，共 ${onboardingSteps.length} 步`;
  $("#onboarding-eyebrow").textContent = current.eyebrow;
  $("#onboarding-dialog-title").textContent = current.title;
  $("#onboarding-dialog-description").textContent = current.description;
  $("#onboarding-previous").disabled = onboardingStep === 0;
  $("#onboarding-next").textContent = onboardingStep === lastStep ? "完成导览" : "下一步";
  $("#onboarding-dialog").dataset.step = String(onboardingStep + 1);
  $("#onboarding-dialog").dataset.target = current.selector;
  document.querySelector(current.selector)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  scheduleOnboardingPosition();
  if (focusTitle) $("#onboarding-dialog-title").focus();
}

function openOnboarding(force = false) {
  const dialog = $("#onboarding-dialog");
  if (!force && hasCompletedOnboarding()) return;
  onboardingSteps = currentOnboardingSteps();
  if (!onboardingSteps.length) return;
  onboardingStep = 0;
  if (!dialog.open) dialog.showModal();
  renderOnboardingStep(0);
  window.requestAnimationFrame(() => $("#onboarding-dialog-title").focus());
}

function completeOnboarding() {
  persistOnboardingCompletion();
  if (onboardingPositionFrame !== null) window.cancelAnimationFrame(onboardingPositionFrame);
  onboardingPositionFrame = null;
  if ($("#onboarding-dialog").open) $("#onboarding-dialog").close();
}

function scheduleFirstUseOnboarding() {
  if (onboardingAutoScheduled || hasCompletedOnboarding()) return;
  onboardingAutoScheduled = true;
  window.requestAnimationFrame(() => {
    onboardingAutoScheduled = false;
    if (state.user && !document.body.classList.contains("auth-pending")) openOnboarding();
  });
}

function settingsRouteContext() {
  const context = settingsReturnContext ?? {};
  return {
    returnView: context.view,
    returnModule: context.module,
    returnChapterId: context.chapterId
  };
}

function replacePageRoute(route) {
  if (restoringPageRoute) return;
  const hash = serializePageRoute(route);
  if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
}

function currentPageRoute() {
  const workId = state.work?.id ?? null;
  if (!$("#entity-editor-view").classList.contains("hidden") && workId && entityEditorType) {
    const entityId = entityEditorType === "setting" ? settingEditorItem?.id : entityEditorType === "character" ? characterEditorItem?.id : knowledgeEditorItem?.id;
    return { view: "entity-editor", workId, entity: entityEditorType, entityId: entityId ?? null };
  }
  if (!$("#settings-hub-view").classList.contains("hidden")) return { view: "settings", workId, ...settingsRouteContext() };
  if (!$("#platform-ai-view").classList.contains("hidden")) return { view: "platform-ai", workId, ...settingsRouteContext() };
  if (!$("#shelf-view").classList.contains("hidden")) return { view: "shelf" };
  if (!workId) return { view: "shelf" };
  if (!$("#editor-view").classList.contains("hidden")) return { view: "editor", workId, chapterId: state.chapter?.id ?? null };
  if (!$("#module-view").classList.contains("hidden")) return { view: "module", workId, module: state.module };
  return { view: "welcome", workId };
}

function loadPanelLayout() {
  try {
    const stored = JSON.parse(localStorage.getItem(panelLayoutStorageKey) ?? "{}");
    return {
      leftWidth: Math.round(Math.max(180, Math.min(520, Number(stored.leftWidth) || panelLayoutDefaults.leftWidth))),
      aiWidth: Math.round(Math.max(260, Math.min(600, Number(stored.aiWidth) || panelLayoutDefaults.aiWidth))),
      leftCollapsed: Boolean(stored.leftCollapsed),
      aiCollapsed: Boolean(stored.aiCollapsed)
    };
  } catch {
    return { ...panelLayoutDefaults };
  }
}

let panelLayout = loadPanelLayout();

function constrainPanelLayout() {
  const minimumMainWidth = 480;
  if (!panelLayout.leftCollapsed) {
    const available = window.innerWidth - (panelLayout.aiCollapsed ? 42 : panelLayout.aiWidth) - minimumMainWidth;
    panelLayout.leftWidth = Math.max(180, Math.min(520, available, panelLayout.leftWidth));
  }
  if (!panelLayout.aiCollapsed) {
    const available = window.innerWidth - (panelLayout.leftCollapsed ? 42 : panelLayout.leftWidth) - minimumMainWidth;
    panelLayout.aiWidth = Math.max(260, Math.min(600, available, panelLayout.aiWidth));
  }
}

function applyPanelLayout(persist = false) {
  constrainPanelLayout();
  const app = $("#app");
  app.style.setProperty("--left-panel-width", `${panelLayout.leftWidth}px`);
  app.style.setProperty("--ai-panel-width", `${panelLayout.aiWidth}px`);
  app.classList.toggle("left-panel-collapsed", panelLayout.leftCollapsed);
  app.classList.toggle("ai-panel-collapsed", panelLayout.aiCollapsed);
  $("#left-panel-toggle").textContent = panelLayout.leftCollapsed ? "›" : "‹";
  $("#left-panel-toggle").setAttribute("aria-expanded", String(!panelLayout.leftCollapsed));
  $("#left-panel-toggle").setAttribute("aria-label", panelLayout.leftCollapsed ? "展开作品侧栏" : "收起作品侧栏");
  $("#ai-panel-toggle").textContent = panelLayout.aiCollapsed ? "‹" : "›";
  $("#ai-panel-toggle").setAttribute("aria-expanded", String(!panelLayout.aiCollapsed));
  $("#ai-panel-toggle").setAttribute("aria-label", panelLayout.aiCollapsed ? "展开创作助手" : "收起创作助手");
  scheduleChapterLineNumbers();
  if (persist) {
    try { localStorage.setItem(panelLayoutStorageKey, JSON.stringify(panelLayout)); } catch { /* 浏览器禁用存储时仅保留当前布局 */ }
  }
}

function ensureAiPanelExpanded() {
  if (!panelLayout.aiCollapsed) return;
  panelLayout.aiCollapsed = false;
  applyPanelLayout(true);
}

function setupPanelResize(handle, side) {
  let resize = null;
  const updateWidth = (width) => {
    if (side === "left") panelLayout.leftWidth = width;
    else panelLayout.aiWidth = width;
    applyPanelLayout();
  };
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (side === "left" ? panelLayout.leftCollapsed : panelLayout.aiCollapsed)) return;
    resize = { pointerId: event.pointerId, startX: event.clientX, startWidth: side === "left" ? panelLayout.leftWidth : panelLayout.aiWidth };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("is-panel-resizing");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!resize || event.pointerId !== resize.pointerId) return;
    updateWidth(resize.startWidth + (event.clientX - resize.startX) * (side === "left" ? 1 : -1));
  });
  const finish = (event) => {
    if (!resize || event.pointerId !== resize.pointerId) return;
    resize = null;
    document.body.classList.remove("is-panel-resizing");
    applyPanelLayout(true);
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  handle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const current = side === "left" ? panelLayout.leftWidth : panelLayout.aiWidth;
    updateWidth(current + direction * 12 * (side === "left" ? 1 : -1));
    applyPanelLayout(true);
  });
}

let chapterLineNumberFrame = null;
let chapterLineSelection = null;
let chapterLineDrag = null;
let chapterWhitespaceVisible = true;
let chapterAutoSaveTimer = null;
let chapterSaveInFlight = null;
let lastSavedChapterSnapshot = null;
let moduleNavExpanded = false;
const chapterAutoSaveDelay = 800;
let aiMentionMatch = null;
let aiMentionRange = null;
let settingsReturnContext = null;
let entityEditorType = null;
let entityEditorDirty = false;
let settingEditorItem = null;
let characterEditorItem = null;
let knowledgeEditorItem = null;
let knowledgeEditorKind = null;
let knowledgeEditorSections = [];
let knowledgeSectionEditorIndex = null;
let knowledgeSectionEditorDirty = false;
let characterEditorVersions = [];
let characterEditorRelationships = [];
let characterEditorRelationshipsLoading = false;
let characterEditorSections = [];
let characterSectionPendingAttachments = [];
let markdownEditorPendingAttachments = [];
let characterSectionEditorDirty = false;
let settingEditorVditor = null;
let knowledgeSectionVditor = null;
let characterSectionVditor = null;
let entityHistoryContext = null;

function showEntityEditorPage(type) {
  entityEditorType = type;
  entityEditorDirty = false;
  characterSectionEditorDirty = false;
  knowledgeSectionEditorDirty = false;
  $("#entity-editor-view").classList.remove("hidden");
  $("#setting-editor-form").classList.toggle("hidden", type !== "setting");
  $("#character-editor-form").classList.toggle("hidden", type !== "character");
  $("#knowledge-editor-form").classList.toggle("hidden", !["race", "organization"].includes(type));
  $("#character-section-editor-view").classList.add("hidden");
  $("#knowledge-section-editor-view").classList.add("hidden");
  $("#app").inert = true;
  document.body.classList.add("entity-editor-open");
  replacePageRoute(currentPageRoute());
}

function markEntityEditorDirty() {
  const module = entityEditorType === "setting" ? "settings" : entityEditorType === "character" ? "characters" : entityEditorType === "race" ? "races" : "organizations";
  if (entityEditorType && canEditModule(module)) entityEditorDirty = true;
}

async function confirmEntityEditorDiscard(message) {
  if (!entityEditorDirty) return true;
  return confirmToast(message ?? "当前资料有未保存修改，返回列表将丢弃这些修改。是否继续？", {
    title: "放弃未保存修改",
    confirmLabel: "放弃并继续",
    cancelLabel: "继续编辑"
  });
}

async function closeEntityEditor({ force = false } = {}) {
  if (!$("#character-section-editor-view").classList.contains("hidden")) return closeCharacterSectionEditor({ force });
  if (!$("#knowledge-section-editor-view").classList.contains("hidden")) return closeKnowledgeSectionEditor({ force });
  if (!force && !(await confirmEntityEditorDiscard())) return false;
  await discardPendingCharacterAttachments();
  await discardPendingMarkdownAttachments();
  destroyVditorEditor(settingEditorVditor);
  settingEditorVditor = null;
  const module = entityEditorType === "setting" ? "settings" : entityEditorType === "character" ? "characters" : entityEditorType === "race" ? "races" : "organizations";
  entityEditorType = null;
  entityEditorDirty = false;
  settingEditorItem = null;
  characterEditorItem = null;
  knowledgeEditorItem = null;
  knowledgeEditorKind = null;
  knowledgeEditorSections = [];
  knowledgeSectionEditorIndex = null;
  knowledgeSectionEditorDirty = false;
  $("#entity-editor-view").classList.add("hidden");
  $("#setting-editor-form").classList.add("hidden");
  $("#character-editor-form").classList.add("hidden");
  $("#knowledge-editor-form").classList.add("hidden");
  $("#knowledge-section-editor-view").classList.add("hidden");
  $("#app").inert = false;
  document.body.classList.remove("entity-editor-open");
  await showModule(module);
  return true;
}

function setModuleNavExpanded(expanded) {
  moduleNavExpanded = expanded;
  $("#module-more-button .nav-label").textContent = expanded ? "收起" : "更多";
  $("#module-more-button").setAttribute("aria-expanded", String(expanded));
  $("#module-nav").querySelectorAll(".module-nav-secondary").forEach((button) => button.classList.toggle("hidden", !expanded));
}

function syncChapterLineNumberScroll() {
  const input = $("#chapter-content");
  const inner = $("#chapter-line-numbers-inner");
  const whitespace = $("#chapter-whitespace-inner");
  if (!input || !inner) return;
  inner.style.transform = `translateY(${-input.scrollTop}px)`;
  inner.dataset.scrollTop = String(input.scrollTop);
  if (whitespace) {
    whitespace.style.transform = `translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`;
    whitespace.dataset.scrollTop = String(input.scrollTop);
  }
}

function renderChapterWhitespaceMarkers(input, style) {
  const overlay = $("#chapter-whitespace-overlay");
  const inner = $("#chapter-whitespace-inner");
  const button = $("#toggle-whitespace-button");
  if (!overlay || !inner || !button) return;
  overlay.classList.toggle("is-visible", chapterWhitespaceVisible);
  button.setAttribute("aria-pressed", String(chapterWhitespaceVisible));
  button.textContent = chapterWhitespaceVisible ? "隐藏空白符" : "显示空白符";
  if (!chapterWhitespaceVisible) {
    inner.replaceChildren();
    return;
  }
  Object.assign(inner.style, {
    width: `${input.clientWidth}px`,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    tabSize: style.tabSize,
    padding: style.padding,
    overflowWrap: style.overflowWrap,
    wordBreak: style.wordBreak
  });
  const fragment = document.createDocumentFragment();
  for (const token of tokenizeVisibleSpaces(input.value.replace(/\r\n?/gu, "\n"))) {
    if (token.type === "text") {
      fragment.append(document.createTextNode(token.text));
      continue;
    }
    const marker = document.createElement("span");
    marker.className = `chapter-space-marker ${token.type}`;
    marker.textContent = token.text;
    marker.dataset.spaceType = token.type;
    fragment.append(marker);
  }
  inner.replaceChildren(fragment);
}

function renderChapterLineNumbers() {
  const input = $("#chapter-content");
  const inner = $("#chapter-line-numbers-inner");
  const measure = $("#chapter-line-measure");
  if (!input || !inner || !measure || input.clientWidth === 0) return;
  const style = getComputedStyle(input);
  const contentWidth = Math.max(1, input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.55;
  const numberStyle = getComputedStyle($("#chapter-line-numbers"));
  const numberLineHeight = parseFloat(numberStyle.lineHeight) || parseFloat(numberStyle.fontSize) * 1.2;
  inner.style.top = `${calculateLineNumberTop(parseFloat(style.paddingTop), lineHeight, numberLineHeight)}px`;
  const numberTextOffset = calculateLineNumberTextOffset(lineHeight, numberLineHeight);
  Object.assign(measure.style, {
    width: `${contentWidth}px`,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    tabSize: style.tabSize
  });
  const lines = input.value.replace(/\r\n?/gu, "\n").split("\n");
  const measureRows = lines.map((line) => {
    const row = document.createElement("div");
    row.textContent = line || "\u200b";
    return row;
  });
  measure.replaceChildren(...measureRows);
  const measureRect = measure.getBoundingClientRect();
  const numbers = document.createDocumentFragment();
  measureRows.forEach((row, index) => {
    const number = document.createElement("button");
    number.type = "button";
    number.className = "chapter-line-number";
    number.textContent = String(index + 1);
    number.dataset.lineIndex = String(index);
    number.setAttribute("aria-label", `选择第 ${index + 1} 行`);
    number.tabIndex = -1;
    const selected = chapterLineSelection && index >= chapterLineSelection.start && index <= chapterLineSelection.end;
    if (selected) {
      number.classList.add("is-line-selected");
      number.setAttribute("aria-pressed", "true");
    }
    const rowRect = row.getBoundingClientRect();
    const rowHeight = calculateLineNumberRowHeight(lineHeight, rowRect.height);
    number.style.top = `${calculateLineNumberRowTop(measureRect.top, rowRect.top)}px`;
    number.style.height = `${rowHeight}px`;
    number.style.paddingTop = `${numberTextOffset}px`;
    numbers.append(number);
  });
  inner.replaceChildren(numbers);
  inner.style.height = `${measureRect.height}px`;
  inner.dataset.lineCount = String(lines.length);
  measure.replaceChildren();
  renderChapterWhitespaceMarkers(input, style);
  syncChapterLineNumberScroll();
}

function scheduleChapterLineNumbers() {
  if (chapterLineNumberFrame !== null) return;
  chapterLineNumberFrame = requestAnimationFrame(() => {
    chapterLineNumberFrame = null;
    renderChapterLineNumbers();
  });
}

function collapseChapterInputBlankLines(input) {
  const value = input.value;
  const normalized = collapseExcessBlankLines(value);
  if (normalized === value) return false;
  const selectionStart = input.selectionStart ?? value.length;
  const selectionEnd = input.selectionEnd ?? selectionStart;
  const nextStart = collapseExcessBlankLines(value.slice(0, selectionStart)).length;
  const nextEnd = collapseExcessBlankLines(value.slice(0, selectionEnd)).length;
  input.value = normalized;
  input.setSelectionRange(nextStart, nextEnd);
  return true;
}

function lineIndexAtPointer(clientY) {
  const rows = [...$("#chapter-line-numbers-inner").querySelectorAll(".chapter-line-number")];
  if (!rows.length) return 0;
  for (let index = 0; index < rows.length; index += 1) {
    if (clientY < rows[index].getBoundingClientRect().bottom) return index;
  }
  return rows.length - 1;
}

function paintChapterLineSelection(anchor, focus) {
  const start = Math.min(anchor, focus);
  const end = Math.max(anchor, focus);
  chapterLineSelection = { start, end };
  $("#chapter-line-numbers-inner").querySelectorAll(".chapter-line-number").forEach((row) => {
    const selected = Number(row.dataset.lineIndex) >= start && Number(row.dataset.lineIndex) <= end;
    row.classList.toggle("is-line-selected", selected);
    row.setAttribute("aria-pressed", String(selected));
  });
}

function selectedChapterLinePayload(start, end) {
  const input = $("#chapter-content");
  const lines = input.value.replace(/\r\n?/gu, "\n").split("\n");
  const safeStart = Math.max(0, Math.min(start, lines.length - 1));
  const safeEnd = Math.max(safeStart, Math.min(end, lines.length - 1));
  const text = lines.slice(safeStart, safeEnd + 1).join("\n");
  const startOffset = lines.slice(0, safeStart).reduce((length, line) => length + line.length + 1, 0);
  return { safeStart, safeEnd, text, startOffset };
}

function selectChapterLines(start, end) {
  const input = $("#chapter-content");
  const selection = selectedChapterLinePayload(start, end);
  input.focus({ preventScroll: true });
  input.setSelectionRange(selection.startOffset, selection.startOffset);
  return selection;
}

function renderAiCitations() {
  const host = $("#ai-citations");
  host.replaceChildren();
  host.classList.toggle("hidden", state.aiCitations.length === 0);
  for (const citation of state.aiCitations) {
    const card = document.createElement("article");
    card.className = "ai-citation-card";
    const main = document.createElement("button");
    main.type = "button";
    main.className = "ai-citation-main";
    const source = document.createElement("strong");
    source.textContent = citation.chapterTitle;
    const range = document.createElement("small");
    range.textContent = citation.startLine === citation.endLine ? `第 ${citation.startLine} 行` : `第 ${citation.startLine}-${citation.endLine} 行`;
    const excerpt = document.createElement("span");
    excerpt.textContent = citation.text.replace(/\s+/gu, " ").trim() || "空白行";
    main.append(source, range, excerpt);
    main.addEventListener("click", () => card.classList.toggle("is-expanded"));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ai-citation-remove";
    remove.setAttribute("aria-label", `移除 ${citation.chapterTitle} 第 ${citation.startLine}-${citation.endLine} 行引用`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.aiCitations = state.aiCitations.filter((item) => item.id !== citation.id);
      renderAiCitations();
    });
    const fullText = document.createElement("pre");
    fullText.textContent = citation.text || "（空白行）";
    card.append(main, remove, fullText);
    host.append(card);
  }
  scheduleAiContextUsage();
}

function aiReferenceKey(reference) {
  return `${reference.kind}:${reference.id}`;
}

function aiReferenceKindLabel(reference) {
  return ({ character: "角色", setting: "设定", chapter: "章节" })[reference.kind] ?? "引用";
}

function createAiReferenceChip(reference) {
  const chip = document.createElement("span");
  chip.className = "ai-prompt-reference";
  chip.contentEditable = "false";
  chip.dataset.aiReferenceKey = aiReferenceKey(reference);
  chip.setAttribute("role", "group");
  chip.setAttribute("aria-label", `已引用${aiReferenceKindLabel(reference)} ${reference.name}`);
  const label = document.createElement("span");
  label.textContent = `${aiReferenceKindLabel(reference)} · ${reference.name}`;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.setAttribute("aria-label", `移除引用 ${reference.name}`);
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    state.aiReferences = state.aiReferences.filter((item) => aiReferenceKey(item) !== aiReferenceKey(reference));
    renderAiReferences();
    $("#ai-prompt").focus();
  });
  chip.append(label, remove);
  return chip;
}

function renderAiReferences() {
  const prompt = $("#ai-prompt");
  const references = new Map(state.aiReferences.map((reference) => [aiReferenceKey(reference), reference]));
  prompt.querySelectorAll("[data-ai-reference-key]").forEach((chip) => {
    if (!references.has(chip.dataset.aiReferenceKey)) chip.remove();
  });
  const rendered = new Set([...prompt.querySelectorAll("[data-ai-reference-key]")].map((chip) => chip.dataset.aiReferenceKey));
  for (const reference of state.aiReferences) {
    if (rendered.has(aiReferenceKey(reference))) continue;
    prompt.append(createAiReferenceChip(reference), document.createTextNode(" "));
  }
  scheduleAiContextUsage();
}

function renderAiQuickActions() {
  const quickActions = $(".quick-actions");
  const visible = shouldShowAiQuickActions(state.aiPromptSent);
  quickActions.classList.toggle("hidden", !visible);
  quickActions.setAttribute("aria-hidden", String(!visible));
}

function attachMessageHeading(message, label, createdAt = new Date().toISOString()) {
  const timestamp = createdAt || new Date().toISOString();
  const previousCreatedAt = state.aiLastMessageAt;
  const heading = document.createElement("span");
  heading.className = "message-heading";
  const role = document.createElement("span");
  role.textContent = label;
  const time = document.createElement("time");
  time.dateTime = timestamp;
  time.textContent = formatAiMessageTime(timestamp, previousCreatedAt);
  heading.append(role, time);
  message.prepend(heading);
  message.dataset.createdAt = timestamp;
  message.dataset.previousCreatedAt = previousCreatedAt ?? "";
  state.aiLastMessageAt = timestamp;
  return heading;
}

function updateMessageCreatedAt(message, createdAt) {
  if (!message || !createdAt) return;
  const time = message.querySelector(".message-heading time");
  if (!time) return;
  time.dateTime = createdAt;
  time.textContent = formatAiMessageTime(createdAt, message.dataset.previousCreatedAt || null);
  message.dataset.createdAt = createdAt;
  if (message === $("#ai-feed").lastElementChild) state.aiLastMessageAt = createdAt;
}

function resetAiFeed() {
  state.aiLastMessageAt = null;
  $("#ai-feed").innerHTML = '<div class="assistant-message"><span class="message-heading"><span>助手</span></span><div class="message-body"><p>选择章节和模型后，可以问答、续写或校对。所有引用都基于已保存正文。</p></div></div>';
}

function renderMessageCardActions(message) {
  let actions = message.querySelector(".message-card-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "message-card-actions";
    message.append(actions);
  }
  actions.replaceChildren();
  if (Object.hasOwn(message.dataset, "rawMarkdown")) {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "message-copy-button";
    copy.setAttribute("aria-label", "复制 AI 原始 Markdown");
    copy.innerHTML = '<svg class="message-action-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg><span>复制</span>';
    const copyLabel = copy.querySelector("span");
    copy.addEventListener("click", async () => {
      try {
        await copyAiRawMarkdown(message.dataset.rawMarkdown);
        copyLabel.textContent = "已复制";
        window.setTimeout(() => { copyLabel.textContent = "复制"; }, 1200);
      } catch (error) {
        toast(error.message, "error");
      }
    });
    actions.append(copy);
  }
  if (message.dataset.messageId && message.classList.contains("assistant-message")) {
    const fork = document.createElement("button");
    fork.type = "button";
    fork.className = "message-fork-button";
    fork.setAttribute("aria-label", "从此消息 Fork 新对话");
    fork.innerHTML = '<svg class="message-action-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7v2a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4V7M12 13v4"/></svg><span>分支</span>';
    fork.addEventListener("click", async () => {
      fork.disabled = true;
      try {
        const conversation = await api(`/api/ai-conversations/${state.aiConversationId}/fork`, { method: "POST", body: { messageId: message.dataset.messageId } });
        await loadAiConversations(false);
        await openAiConversation(conversation.id);
        toast("已从所选消息创建分支对话");
      } catch (error) {
        fork.disabled = false;
        toast(error.message, "error");
      }
    });
    actions.append(fork);
  }
  const copyAction = actions.querySelector(".message-copy-button");
  if (copyAction) actions.append(copyAction);
  message.classList.toggle("has-message-actions", actions.childElementCount > 0);
}

function attachAssistantCopyAction(message, rawMarkdown) {
  message.dataset.rawMarkdown = String(rawMarkdown ?? "");
  renderMessageCardActions(message);
}

function attachMessageIdentity(message, messageId) {
  if (!messageId) return;
  message.dataset.messageId = messageId;
  renderMessageCardActions(message);
}

const AI_TOOL_DISPLAY_NAMES = {
  story_index: "作品目录与章节概要",
  read_chapters: "读取章节",
  grep: "查询正文关键字",
  query_story_knowledge: "查询作品知识",
  read_character_sections: "读取人物 Markdown 章节"
};

const AI_TOOL_DESCRIPTIONS = {
  story_index: "分页读取当前作品的卷章目录和章节概要。",
  read_chapters: "读取指定章节的概要、正文或两者。",
  grep: "查询正文关键字所在的完整段落及章节信息。",
  query_story_knowledge: "按关键词查询设定、人物、组织、时间线等作品知识。",
  read_character_sections: "读取指定人物 Markdown 档案章节的摘要或原文。"
};

let aiFeedScrollFrame = null;

function scrollAiFeedToBottom() {
  const feed = $("#ai-feed");
  feed.scrollTop = feed.scrollHeight;
  if (aiFeedScrollFrame !== null) window.cancelAnimationFrame(aiFeedScrollFrame);
  aiFeedScrollFrame = window.requestAnimationFrame(() => {
    feed.scrollTop = feed.scrollHeight;
    aiFeedScrollFrame = null;
  });
}

function formatAiToolCallTime(value) {
  if (!value) return "历史记录未保存";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间记录无效";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function openAiToolCallDetail(toolCall) {
  const name = String(toolCall?.name ?? "unknown");
  const status = toolCall?.status === "failed" ? "调用失败" : "调用成功";
  const calledAt = String(toolCall?.calledAt ?? "");
  $("#ai-tool-call-status").textContent = status;
  $("#ai-tool-call-title").textContent = `${AI_TOOL_DISPLAY_NAMES[name] ?? name} · ${name}`;
  $("#ai-tool-call-name").textContent = name;
  $("#ai-tool-call-description").textContent = AI_TOOL_DESCRIPTIONS[name] ?? "未登记此工具函数的用途说明。";
  const time = $("#ai-tool-call-time");
  time.textContent = formatAiToolCallTime(calledAt);
  if (calledAt && !Number.isNaN(new Date(calledAt).getTime())) time.dateTime = new Date(calledAt).toISOString();
  else time.removeAttribute("datetime");
  $("#ai-tool-call-arguments").textContent = JSON.stringify(toolCall?.arguments ?? {}, null, 2);
  $("#ai-tool-call-result").textContent = JSON.stringify(toolCall?.result ?? {}, null, 2);
  $("#ai-tool-call-dialog").showModal();
}

function createAiToolCallButton(toolCall) {
  const name = String(toolCall?.name ?? "unknown");
  const button = document.createElement("button");
  button.type = "button";
  button.className = `ai-tool-call-summary${toolCall?.status === "failed" ? " is-failed" : ""}`;
  button.setAttribute("aria-haspopup", "dialog");
  button.textContent = toolCall?.status === "failed" ? `调用 ${name} 工具失败` : `调用了 ${name} 工具`;
  button.title = AI_TOOL_DISPLAY_NAMES[name] ?? name;
  button.addEventListener("click", () => openAiToolCallDetail(toolCall));
  return button;
}

function aiToolProcessStep(toolCall, round = 1) {
  const normalizedToolCall = { ...toolCall };
  delete normalizedToolCall.round;
  return {
    id: `tool-${String(toolCall?.id ?? "unknown")}`,
    type: "tool",
    round: Number(round) || 1,
    toolCall: normalizedToolCall,
    createdAt: toolCall?.calledAt ?? new Date().toISOString()
  };
}

function formatAiProcessDuration(value) {
  const durationMs = Number(value);
  if (!Number.isFinite(durationMs) || durationMs < 0) return "";
  const totalSeconds = durationMs / 1000;
  if (totalSeconds < 60) return `${Math.max(0.1, totalSeconds).toFixed(1)} 秒`;
  const roundedSeconds = Math.round(totalSeconds);
  const hours = Math.floor(roundedSeconds / 3600);
  const minutes = Math.floor((roundedSeconds % 3600) / 60);
  const seconds = roundedSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分 ${seconds} 秒`;
  return `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒`;
}

function resolveAiProcessDuration(metadata, steps, completedAt) {
  const storedDuration = Number(metadata?.processDurationMs);
  if (Number.isFinite(storedDuration) && storedDuration >= 0) return storedDuration;
  const completedTime = new Date(completedAt ?? "").getTime();
  if (!Number.isFinite(completedTime)) return null;
  const startedTimes = steps
    .map((step) => new Date(step?.createdAt ?? "").getTime())
    .filter((value) => Number.isFinite(value));
  if (!startedTimes.length) return null;
  return Math.max(0, completedTime - Math.min(...startedTimes));
}

function renderAiProcessSteps(message, steps, completed, durationMs = null) {
  message.querySelector(".ai-process-details")?.remove();
  if (!Array.isArray(steps) || !steps.length) return;
  const details = document.createElement("details");
  details.className = "ai-process-details";
  details.open = !completed;
  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.textContent = completed ? "思考与执行过程" : "正在思考与执行";
  const status = document.createElement("small");
  const duration = durationMs === null || durationMs === undefined ? "" : formatAiProcessDuration(durationMs);
  status.textContent = `${steps.length} 个步骤${duration ? ` · 耗时 ${duration}` : ""}`;
  summary.append(title, status);
  const list = document.createElement("div");
  list.className = "ai-process-list";
  for (const step of steps) {
    if (step?.type === "tool" && step.toolCall) {
      const tool = document.createElement("section");
      tool.className = "ai-process-step ai-process-tool-step";
      const label = document.createElement("small");
      label.textContent = `第 ${Number(step.round) || 1} 轮 · 工具调用`;
      tool.append(label, createAiToolCallButton(step.toolCall));
      list.append(tool);
      continue;
    }
    if (!step?.content || !["thinking", "intermediate"].includes(step.type)) continue;
    const section = document.createElement("section");
    section.className = `ai-process-step ai-process-${step.type}-step`;
    const label = document.createElement("small");
    label.textContent = `第 ${Number(step.round) || 1} 轮 · ${step.type === "thinking" ? "Thinking" : "中间输出"}`;
    const body = document.createElement("div");
    body.className = "message-body ai-process-step-body";
    body.innerHTML = renderMarkdown(step.content);
    section.append(label, body);
    list.append(section);
  }
  details.append(summary, list);
  const body = message.querySelector(".message-body");
  if (body) body.before(details);
  else message.append(details);
}

function renderAiToolCalls(message, toolCalls, completed = false) {
  renderAiProcessSteps(message, (Array.isArray(toolCalls) ? toolCalls : []).map((toolCall) => aiToolProcessStep(toolCall)), completed);
}

function setAiHistoryVisible(visible) {
  const dialog = $("#ai-history-dialog");
  if (visible && !dialog.open) dialog.showModal();
  else if (!visible && dialog.open) dialog.close();
  $("#ai-history-toggle").setAttribute("aria-expanded", String(dialog.open));
}

function renderAiConversationHistory() {
  const host = $("#ai-history-list");
  host.replaceChildren();
  if (!state.aiConversations.length) {
    host.innerHTML = '<p class="ai-history-empty">还没有历史对话</p>';
    return;
  }
  for (const conversation of state.aiConversations) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `ai-history-item${conversation.id === state.aiConversationId ? " is-active" : ""}`;
    button.dataset.aiConversationId = conversation.id;
    const title = document.createElement("strong");
    title.textContent = conversation.title;
    const meta = document.createElement("small");
    meta.textContent = `${conversation.messageCount} 条 · ${formatDateTime(conversation.updatedAt)}`;
    button.append(title, meta);
    button.addEventListener("click", () => openAiConversation(conversation.id));
    host.append(button);
  }
}

async function loadAiConversations(openLatest = true) {
  const workId = state.work?.id;
  if (!workId) return;
  const generation = workScopedUiGeneration;
  const conversations = (await apiPage(`/api/works/${workId}/ai-conversations`)).items;
  if (state.work?.id !== workId || generation !== workScopedUiGeneration) return;
  state.aiConversations = conversations;
  loadedAiConversationsWorkId = workId;
  renderAiConversationHistory();
  if (openLatest && state.aiConversations.length) await openAiConversation(state.aiConversations[0].id, false);
  else {
    const current = state.aiConversations.find((conversation) => conversation.id === state.aiConversationId);
    if (current) $("#ai-conversation-title").textContent = current.title;
  }
}

async function ensureAiConversationsLoaded() {
  const workId = state.work?.id;
  if (!workId || loadedAiConversationsWorkId === workId) return;
  if (aiConversationsLoadPromise && aiConversationsLoadWorkId === workId) return aiConversationsLoadPromise;
  aiConversationsLoadWorkId = workId;
  aiConversationsLoadPromise = loadAiConversations(false);
  try {
    await aiConversationsLoadPromise;
  } finally {
    if (aiConversationsLoadWorkId === workId) {
      aiConversationsLoadPromise = null;
      aiConversationsLoadWorkId = null;
    }
  }
}

async function openAiConversation(conversationId, hideHistory = true) {
  const conversation = await api(`/api/ai-conversations/${conversationId}?page=1&limit=100`);
  state.aiConversationId = conversation.id;
  state.aiPromptSent = conversation.messages.some((message) => message.role === "user");
  $("#ai-conversation-title").textContent = conversation.title;
  resetAiFeed();
  for (const message of conversation.messages) appendMessage(message.role, message.content, message.citations, message.createdAt, message.metadata, message.id);
  state.aiCitations = [];
  state.aiReferences = [];
  setAiPromptText("");
  renderAiCitations();
  renderAiReferences();
  renderAiQuickActions();
  renderAiConversationHistory();
  if (conversation.contextWarningPending) showAiContextWarning();
  else hideAiContextWarning();
  if (hideHistory) setAiHistoryVisible(false);
}

async function createNewAiConversation() {
  if (!state.work) return;
  const conversation = await api(`/api/works/${state.work.id}/ai-conversations`, { method: "POST", body: {} });
  state.aiConversationId = conversation.id;
  state.aiPromptSent = false;
  $("#ai-conversation-title").textContent = conversation.title;
  resetAiFeed();
  hideAiContextWarning();
  renderAiQuickActions();
  setAiHistoryVisible(false);
  await loadAiConversations(false);
}

async function ensureAiConversation() {
  if (state.aiConversationId) return state.aiConversationId;
  await createNewAiConversation();
  return state.aiConversationId;
}

async function persistAiConversationMessage(role, content, citations = [], metadata = {}) {
  const conversationId = await ensureAiConversation();
  if (!conversationId) throw new Error("无法创建 AI 对话");
  const message = await api(`/api/ai-conversations/${conversationId}/messages`, { method: "POST", body: { role, content, citations, metadata } });
  await loadAiConversations(false);
  return message;
}

function promptTextFromNode(node, root = node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element)) return "";
  if (node.matches("[data-ai-reference-key]")) return "";
  if (node.tagName === "BR") return "\n";
  const text = [...node.childNodes].map((child) => promptTextFromNode(child, root)).join("");
  return node !== root && ["DIV", "P"].includes(node.tagName) ? `${text}\n` : text;
}

function aiPromptText() {
  return promptTextFromNode($("#ai-prompt")).replace(/\n$/u, "");
}

function setAiPromptText(value) {
  const prompt = $("#ai-prompt");
  prompt.replaceChildren();
  if (value) prompt.append(document.createTextNode(value));
  renderAiReferences();
}

function clearAiPromptComposer() {
  state.aiCitations = [];
  state.aiReferences = [];
  setAiPromptText("");
  renderAiCitations();
  hideAiMentionMenu();
}

function aiPromptTextBeforeCursor() {
  const prompt = $("#ai-prompt");
  const selection = window.getSelection();
  if (!selection?.rangeCount || !prompt.contains(selection.anchorNode)) return aiPromptText();
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(prompt);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  const fragment = document.createElement("div");
  fragment.append(range.cloneContents());
  return promptTextFromNode(fragment).replace(/\n$/u, "");
}

function hideAiMentionMenu() {
  aiMentionMatch = null;
  aiMentionRange = null;
  $("#ai-mention-menu").classList.add("hidden");
}

function syncAiReferencesWithPrompt() {
  const prompt = $("#ai-prompt");
  const activeKeys = new Set([...prompt.querySelectorAll("[data-ai-reference-key]")].map((chip) => chip.dataset.aiReferenceKey));
  const activeReferences = state.aiReferences.filter((reference) => activeKeys.has(aiReferenceKey(reference)));
  if (activeReferences.length !== state.aiReferences.length) {
    state.aiReferences = activeReferences;
    renderAiReferences();
  }
}

function updateAiMentionMenu() {
  syncAiReferencesWithPrompt();
  const prompt = $("#ai-prompt");
  const match = findAiMention(aiPromptTextBeforeCursor());
  if (!match) return hideAiMentionMenu();
  const selection = window.getSelection();
  if (!selection?.rangeCount || !prompt.contains(selection.anchorNode)) return hideAiMentionMenu();
  aiMentionMatch = match;
  aiMentionRange = selection.getRangeAt(0).cloneRange();
  const menu = $("#ai-mention-menu");
  const chapters = state.work?.volumes.flatMap((volume) => volume.chapters.map((chapter) => ({
    ...chapter,
    volumeTitle: volume.title
  }))) ?? [];
  const options = listAiMentionOptions(state.characters, state.settings, chapters, match.query);
  menu.innerHTML = options.length
    ? options.map((item) => `<button class="ai-mention-option" type="button" role="option" data-ai-reference-kind="${esc(item.kind)}" data-ai-reference-id="${esc(item.id)}" data-ai-reference-name="${esc(item.name)}"><small>${esc(item.kindLabel)}</small><strong>${esc(item.name)}</strong></button>`).join("")
    : '<p class="ai-mention-empty">没有匹配的角色、设定或章节</p>';
  menu.classList.remove("hidden");
}

function selectAiMention(button) {
  if (!aiMentionMatch || !aiMentionRange) return;
  const prompt = $("#ai-prompt");
  const reference = {
    kind: button.dataset.aiReferenceKind,
    id: button.dataset.aiReferenceId,
    name: button.dataset.aiReferenceName
  };
  const range = aiMentionRange.cloneRange();
  const textNode = range.startContainer;
  const localText = textNode.nodeType === Node.TEXT_NODE ? textNode.textContent?.slice(0, range.startOffset) ?? "" : "";
  const localMention = findAiMention(localText);
  if (!localMention) return hideAiMentionMenu();
  range.setStart(textNode, localMention.start);
  range.deleteContents();
  const spacer = document.createTextNode(" ");
  range.insertNode(spacer);
  if (!state.aiReferences.some((item) => aiReferenceKey(item) === aiReferenceKey(reference))) {
    state.aiReferences.push(reference);
    range.insertNode(createAiReferenceChip(reference));
  }
  const selection = window.getSelection();
  selection?.removeAllRanges();
  range.setStartAfter(spacer);
  range.collapse(true);
  selection?.addRange(range);
  prompt.focus();
  renderAiReferences();
  hideAiMentionMenu();
}

function addSelectedLinesAsCitation() {
  if (!state.chapter || !chapterLineSelection) return;
  const selection = selectedChapterLinePayload(chapterLineSelection.start, chapterLineSelection.end);
  const citation = {
    id: `${state.chapter.id}:${selection.safeStart}:${selection.safeEnd}`,
    chapterId: state.chapter.id,
    chapterTitle: state.chapter.title,
    startLine: selection.safeStart + 1,
    endLine: selection.safeEnd + 1,
    text: selection.text
  };
  const existing = state.aiCitations.findIndex((item) => item.id === citation.id);
  if (existing < 0 && state.aiCitations.length >= 20) return toast("一次最多添加 20 条正文引用", "error");
  if (existing >= 0) state.aiCitations.splice(existing, 1, citation);
  else state.aiCitations.push(citation);
  ensureAiPanelExpanded();
  renderAiCitations();
  closeLineCitationMenu();
  toast(`已引用《${citation.chapterTitle}》第 ${citation.startLine}${citation.startLine === citation.endLine ? "" : `-${citation.endLine}`} 行`);
}

function closeLineCitationMenu() {
  $("#line-citation-menu").classList.add("hidden");
}

function showLineCitationMenu(event, lineIndex) {
  event.preventDefault();
  if (!chapterLineSelection || lineIndex < chapterLineSelection.start || lineIndex > chapterLineSelection.end) {
    paintChapterLineSelection(lineIndex, lineIndex);
    selectChapterLines(lineIndex, lineIndex);
  }
  const menu = $("#line-citation-menu");
  const { start, end } = chapterLineSelection;
  $("#line-citation-label").textContent = start === end ? `第 ${start + 1} 行` : `第 ${start + 1}-${end + 1} 行`;
  menu.classList.remove("hidden");
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`;
}

function clearChapterLineSelection() {
  chapterLineSelection = null;
  $("#chapter-line-numbers-inner")?.querySelectorAll(".is-line-selected").forEach((row) => {
    row.classList.remove("is-line-selected");
    row.setAttribute("aria-pressed", "false");
  });
}

const typographyStorageKey = "ai-novel-typography-v1";
const typographyDefaults = Object.freeze({ cjkFont: "system", latinFont: "system", fontSize: 17, density: "balanced" });
const cjkFontStacks = {
  system: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Heiti SC"',
  pingfang: '"PingFang SC", "Heiti SC", "Microsoft YaHei", "Noto Sans CJK SC"',
  heiti: '"Heiti SC", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"',
  yahei: '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Heiti SC"',
  "noto-sans": '"Noto Sans CJK SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei"'
};
const latinFontStacks = {
  system: '"SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono"',
  "sf-mono": '"SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono"',
  menlo: 'Menlo, Monaco, Consolas, "Liberation Mono", "SFMono-Regular"',
  monaco: 'Monaco, Menlo, Consolas, "Liberation Mono", "SFMono-Regular"',
  consolas: 'Consolas, "Liberation Mono", Menlo, Monaco, "SFMono-Regular"'
};
const typographyFontSizes = [15, 16, 17, 18, 20];
const densityLineHeights = { compact: 1.4, balanced: 1.55, relaxed: 1.75 };

function normalizeTypographySettings(input) {
  const value = input && typeof input === "object" ? input : {};
  const fontSize = Number(value.fontSize);
  return {
    cjkFont: Object.hasOwn(cjkFontStacks, value.cjkFont) ? value.cjkFont : typographyDefaults.cjkFont,
    latinFont: Object.hasOwn(latinFontStacks, value.latinFont) ? value.latinFont : typographyDefaults.latinFont,
    fontSize: typographyFontSizes.includes(fontSize) ? fontSize : typographyDefaults.fontSize,
    density: Object.hasOwn(densityLineHeights, value.density) ? value.density : typographyDefaults.density
  };
}

function loadTypographySettings() {
  try {
    return normalizeTypographySettings(JSON.parse(localStorage.getItem(typographyStorageKey) ?? "{}"));
  } catch {
    return { ...typographyDefaults };
  }
}

let typographySettings = loadTypographySettings();

function currentColorTheme() {
  return normalizeTheme(document.documentElement.dataset.theme, window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
}

function applyColorTheme(theme) {
  const normalized = normalizeTheme(theme);
  const root = document.documentElement;
  root.dataset.theme = normalized;
  root.style.colorScheme = normalized;
  const label = themeToggleLabel(normalized);
  const button = $("#theme-toggle");
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.setAttribute("aria-pressed", String(normalized === "dark"));
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = normalized === "dark" ? "#171714" : "#8b3d2c";
  [settingEditorVditor, knowledgeSectionVditor, characterSectionVditor].forEach((editor) => editor?.setTheme(normalized === "dark" ? "dark" : "classic"));
}

function saveColorTheme(theme) {
  const normalized = normalizeTheme(theme);
  applyColorTheme(normalized);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}

function applyTypographySettings(settings) {
  const normalized = normalizeTypographySettings(settings);
  const root = document.documentElement;
  root.style.setProperty("--font-cjk", cjkFontStacks[normalized.cjkFont]);
  root.style.setProperty("--font-latin", latinFontStacks[normalized.latinFont]);
  root.style.setProperty("--editor-font-size", `${normalized.fontSize}px`);
  root.style.setProperty("--editor-line-height", String(densityLineHeights[normalized.density]));
  root.dataset.cjkFont = normalized.cjkFont;
  root.dataset.latinFont = normalized.latinFont;
  root.dataset.fontSize = String(normalized.fontSize);
  root.dataset.density = normalized.density;
  scheduleChapterLineNumbers();
}

function saveTypographySettings(settings) {
  typographySettings = normalizeTypographySettings(settings);
  applyTypographySettings(typographySettings);
  try {
    localStorage.setItem(typographyStorageKey, JSON.stringify(typographySettings));
    return true;
  } catch {
    return false;
  }
}

function fillAppearanceForm(settings) {
  const normalized = normalizeTypographySettings(settings);
  $("#appearance-cjk-font").value = normalized.cjkFont;
  $("#appearance-latin-font").value = normalized.latinFont;
  $("#appearance-font-size").value = String(normalized.fontSize);
  $("#appearance-density").value = normalized.density;
}

function readAppearanceForm() {
  const form = new FormData($("#appearance-form"));
  return normalizeTypographySettings({
    cjkFont: form.get("cjkFont"),
    latinFont: form.get("latinFont"),
    fontSize: form.get("fontSize"),
    density: form.get("density")
  });
}

function renderTypographyPreview() {
  const settings = readAppearanceForm();
  const preview = $("#font-preview");
  preview.style.fontFamily = `${latinFontStacks[settings.latinFont]}, ${cjkFontStacks[settings.cjkFont]}, monospace, sans-serif`;
  preview.style.fontSize = `${settings.fontSize}px`;
  preview.style.lineHeight = String(densityLineHeights[settings.density]);
}

function openAppearanceDialog() {
  fillAppearanceForm(typographySettings);
  renderTypographyPreview();
  $("#appearance-dialog").showModal();
}

applyTypographySettings(typographySettings);
applyColorTheme(currentColorTheme());
applyPanelLayout();

function optimisticVersionForPath(path) {
  const normalizedPath = String(path).split("?")[0];
  const find = (items, id) => items.find((item) => String(item?.id ?? item?.chapterId ?? "") === id)?.versionNo;
  const workMatch = normalizedPath.match(/^\/api\/works\/([^/]+)(?:\/(?:cover|import|file-versions\/[^/]+\/restore))?$/u);
  if (workMatch) {
    const workId = decodeURIComponent(workMatch[1]);
    return state.works.find((item) => item.id === workId)?.versionNo ?? (state.work?.id === workId ? state.work.versionNo : undefined);
  }
  const resourceMatch = normalizedPath.match(/^\/api\/(volumes|chapters|settings|races|organizations|timeline-tracks|timeline|relationships|foreshadows|characters|character-sections)\/([^/]+)(?:\/(?:restore|move|split))?$/u);
  if (resourceMatch) {
    const resourceId = decodeURIComponent(resourceMatch[2]);
    const collection = {
      settings: state.settings,
      races: state.races,
      organizations: state.organizations,
      "timeline-tracks": state.timelineTracks,
      characters: state.characters
    }[resourceMatch[1]] ?? [];
    if (resourceMatch[1] === "chapters" && state.chapter?.id === resourceId) return state.chapter.versionNo;
    if (resourceMatch[1] === "volumes") return find(state.work?.volumes ?? [], resourceId);
    if (resourceMatch[1] === "character-sections") return find(characterEditorSections, resourceId);
    if (resourceMatch[1] === "characters" && characterEditorItem?.id === resourceId) return characterEditorItem.versionNo;
    return find(collection, resourceId);
  }
  const outlineMatch = normalizedPath.match(/^\/api\/chapters\/([^/]+)\/outline$/u);
  if (outlineMatch) return find(state.outlines ?? [], decodeURIComponent(outlineMatch[1]));
  const entityRestoreMatch = normalizedPath.match(/^\/api\/entity-versions\/(work|volume|setting|race|organization|timeline-track|timeline-event|relationship|chapter-outline|foreshadow)\/([^/]+)\/restore$/u);
  if (entityRestoreMatch) {
    const entityType = entityRestoreMatch[1];
    const entityId = decodeURIComponent(entityRestoreMatch[2]);
    if (entityType === "work") return state.works.find((item) => item.id === entityId)?.versionNo ?? (state.work?.id === entityId ? state.work.versionNo : undefined);
    if (entityType === "volume") return find(state.work?.volumes ?? [], entityId);
    if (entityType === "chapter-outline") return find(state.outlines ?? [], entityId);
    const collection = {
      setting: state.settings,
      race: state.races,
      organization: state.organizations,
      "timeline-track": state.timelineTracks
    }[entityType] ?? [];
    return find(collection, entityId);
  }
  return undefined;
}

function attachOptimisticVersion(path, method, body) {
  if (!["PATCH", "PUT", "DELETE", "POST"].includes(method)) return body;
  if (body instanceof FormData) {
    if (!body.has("expectedVersionNo")) {
      const versionNo = optimisticVersionForPath(path);
      if (Number.isInteger(versionNo) && versionNo > 0) body.append("expectedVersionNo", String(versionNo));
    }
    return body;
  }
  const currentBody = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  if (currentBody.expectedVersionNo !== undefined) return currentBody;
  const versionNo = optimisticVersionForPath(path);
  return Number.isInteger(versionNo) && versionNo > 0 ? { ...currentBody, expectedVersionNo: versionNo } : body;
}

async function api(path, options = {}) {
  const method = String(options.method ?? "GET").toUpperCase();
  const body = attachOptimisticVersion(path, method, options.body);
  const headers = { ...(options.headers ?? {}) };
  if (state.csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method)) headers["X-CSRF-Token"] = state.csrfToken;
  if (!(body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(path, body instanceof FormData ? { ...options, body, headers } : {
    ...options,
    headers,
    body: body && typeof body !== "string" ? JSON.stringify(body) : body
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: { message: `请求失败：${response.status}` } }));
    if (response.status === 401 && !path.startsWith("/api/auth/")) showAuth(false);
    throw new Error(payload.error?.message ?? `请求失败：${response.status}`);
  }
  if (response.status === 204) return null;
  const payload = await response.json();
  return payload.data;
}

async function apiPage(path, page = 1, limit = 50) {
  const separator = path.includes("?") ? "&" : "?";
  const result = await api(`${path}${separator}page=${page}&limit=${limit}`);
  if (Array.isArray(result)) return { items: result, page, limit, hasMore: false, nextPage: null };
  return result;
}

async function apiAllPages(path, limit = 100) {
  const items = [];
  let page = 1;
  while (true) {
    const result = await apiPage(path, page, limit);
    items.push(...(result.items ?? []));
    if (!result.hasMore || !result.nextPage) return items;
    page = result.nextPage;
  }
}

function selectAuthMode(mode) {
  const registerTab = $("#auth-register-tab");
  const login = mode === "login" || registerTab.disabled;
  $("#auth-login-tab").setAttribute("aria-selected", String(login));
  registerTab.setAttribute("aria-selected", String(!login));
  $("#login-form").classList.toggle("hidden", !login);
  $("#register-form").classList.toggle("hidden", login);
  $("#auth-error").textContent = "";
  // 验证码默认不加载，等用户点击“点击显示验证码”按钮后再请求，避免首屏空白等待
  resetAuthCaptcha(login ? "login" : "register");
}

function resetAuthCaptcha(target = "login") {
  const prefix = target === "register" ? "register" : "login";
  const image = $(`#${prefix}-captcha-image`);
  image.hidden = true;
  image.removeAttribute("src");
  $(`#${prefix}-captcha-placeholder`).hidden = false;
  $(`#${prefix}-captcha-id`).value = "";
  const answerInput = $(`#${prefix}-form`).querySelector('input[name="captchaAnswer"]');
  if (answerInput) answerInput.value = "";
}

async function refreshAuthCaptcha(target = "login") {
  const response = await fetch("/api/auth/captcha", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("无法加载验证码");
  const challenge = (await response.json()).data;
  const prefix = target === "register" ? "register" : "login";
  $(`#${prefix}-captcha-id`).value = challenge.captchaId;
  const image = $(`#${prefix}-captcha-image`);
  image.src = challenge.imageDataUrl;
  image.hidden = false;
  $(`#${prefix}-captcha-placeholder`).hidden = true;
  const answerInput = $(`#${prefix}-form`).querySelector('input[name="captchaAnswer"]');
  if (answerInput) answerInput.value = "";
}

function showAuth(setupRequired, registrationOpen = false) {
  document.body.classList.add("auth-pending");
  $("#auth-view").classList.remove("hidden");
  const canRegister = registrationOpen === true;
  $("#auth-title").textContent = setupRequired
    ? canRegister ? "创建首个管理员账户" : "注册已禁用"
    : "登录后继续创作";
  $("#auth-description").textContent = setupRequired
    ? canRegister
      ? "这是首次启动。首个注册用户会成为系统管理员，并接管现有作品。"
      : "请将 APP_ALLOW_REGISTRATION 设置为 true 后创建首个管理员账户。"
    : "你的作品、协作权限和每一次修改都会绑定到账户。";
  const registerTab = $("#auth-register-tab");
  registerTab.disabled = !canRegister;
  registerTab.setAttribute("aria-disabled", String(!canRegister));
  registerTab.textContent = canRegister ? "注册" : "注册已禁用";
  selectAuthMode(setupRequired && canRegister ? "register" : "login");
}

function applyAuthenticatedUser(session) {
  state.user = session.user;
  state.csrfToken = session.csrfToken;
  $("#account-name").textContent = session.user.displayName;
  renderUserAvatar($("#account-avatar"), session.user);
  $("#account-menu-name").textContent = `${session.user.displayName} · @${session.user.username}`;
  $("#account-menu-role").textContent = session.user.role === "admin" ? "系统管理员" : "普通用户";
  $("#auth-view").classList.add("hidden");
  document.documentElement.classList.remove("login-route");
  // 注意：auth-pending 由 initializePage 路由完成后才移除，
  // 避免会话确认后、目标视图渲染前露出无内容的编辑器外壳
}

function applyPlatformUiSettings(settings) {
  const position = settings?.toastPosition === "top-right" ? "top-right" : "bottom-right";
  $("#toast-region").dataset.position = position;
}

async function loadPlatformUiSettings() {
  try {
    applyPlatformUiSettings(await api("/api/ui-settings"));
  } catch {
    applyPlatformUiSettings({ toastPosition: "bottom-right" });
  }
}

async function initializeAuthentication() {
  const route = parsePageRoute(window.location.hash);
  const response = await fetch("/api/auth/session", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("无法读取登录状态");
  const session = (await response.json()).data;
  if (!session.authenticated) {
    // 未登录时一律转到登录页路由；登录页本身则保持原样
    if (route.view !== "login") window.history.replaceState(null, "", serializePageRoute({ view: "login" }));
    showAuth(session.setupRequired, session.registrationOpen === true);
    return false;
  }
  // 已登录却停在登录页路由时，回到书架首页
  if (route.view === "login") window.history.replaceState(null, "", serializePageRoute({ view: "shelf" }));
  applyAuthenticatedUser(session);
  await loadPlatformUiSettings();
  return true;
}

function raiseToastRegion() {
  const region = $("#toast-region");
  if (typeof region.showPopover !== "function") return;
  if (region.matches(":popover-open")) region.hidePopover();
  region.showPopover();
}

function toast(message, type = "info") {
  const region = $("#toast-region");
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.textContent = message;
  region.append(element);
  raiseToastRegion();
  setTimeout(() => {
    element.remove();
    if (!region.childElementCount && typeof region.hidePopover === "function" && region.matches(":popover-open")) {
      region.hidePopover();
    }
  }, 3600);
}

function confirmToast(message, { title = "请再次确认", confirmLabel = "确认", cancelLabel = "取消" } = {}) {
  const region = $("#toast-region");
  const element = document.createElement("section");
  element.className = "toast toast-confirmation";
  element.setAttribute("role", "alertdialog");
  element.setAttribute("aria-label", title);
  const heading = document.createElement("strong");
  heading.textContent = title;
  const description = document.createElement("p");
  description.textContent = message;
  const actions = document.createElement("div");
  actions.className = "toast-confirmation-actions";
  const cancel = document.createElement("button");
  cancel.className = "ghost-button";
  cancel.type = "button";
  cancel.textContent = cancelLabel;
  const confirm = document.createElement("button");
  confirm.className = "primary-button";
  confirm.type = "button";
  confirm.textContent = confirmLabel;
  actions.append(cancel, confirm);
  element.append(heading, description, actions);
  region.append(element);
  raiseToastRegion();
  cancel.focus();
  return new Promise((resolve) => {
    const finish = (confirmed) => {
      element.remove();
      if (!region.childElementCount && typeof region.hidePopover === "function" && region.matches(":popover-open")) region.hidePopover();
      resolve(confirmed);
    };
    cancel.addEventListener("click", () => finish(false), { once: true });
    confirm.addEventListener("click", () => finish(true), { once: true });
    element.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      finish(false);
    });
  });
}

document.addEventListener("toggle", (event) => {
  const target = event.target;
  if (target instanceof HTMLDialogElement && target.open && $("#toast-region").childElementCount) {
    raiseToastRegion();
  }
}, true);

function setSaveState(text, dirty = false) {
  state.dirty = dirty;
  $("#save-state").textContent = text;
  $("#save-state").style.color = dirty ? "var(--accent)" : "var(--green)";
}

function chapterDraftSnapshot() {
  if (!state.chapter) return null;
  return {
    chapterId: state.chapter.id,
    title: $("#chapter-title").value.trim(),
    content: normalizeParagraphSpacing($("#chapter-content").value)
  };
}

function sameChapterSnapshot(left, right) {
  return Boolean(left && right && left.chapterId === right.chapterId && left.title === right.title && left.content === right.content);
}

function cancelChapterAutoSave() {
  if (chapterAutoSaveTimer !== null) clearTimeout(chapterAutoSaveTimer);
  chapterAutoSaveTimer = null;
}

function scheduleChapterAutoSave(delay = chapterAutoSaveDelay) {
  if (!state.chapter || !canEditProse()) return;
  cancelChapterAutoSave();
  setSaveState("等待自动保存", true);
  chapterAutoSaveTimer = setTimeout(() => {
    chapterAutoSaveTimer = null;
    persistChapter({ automatic: true });
  }, delay);
}

async function persistChapter({ automatic = false } = {}) {
  if (!canEditProse()) return null;
  if (!state.chapter) {
    if (!automatic) toast("请先选择章节", "error");
    return null;
  }
  cancelChapterAutoSave();
  if (chapterSaveInFlight) {
    await chapterSaveInFlight;
    const pendingDraft = chapterDraftSnapshot();
    if (!sameChapterSnapshot(pendingDraft, lastSavedChapterSnapshot)) return persistChapter({ automatic });
    return state.chapter;
  }
  const draft = chapterDraftSnapshot();
  if (!draft?.title) {
    setSaveState("标题不能为空", true);
    if (!automatic) toast("章节标题不能为空", "error");
    return null;
  }
  const input = $("#chapter-content");
  if (input.value !== draft.content) {
    input.value = draft.content;
    scheduleChapterLineNumbers();
  }
  if (sameChapterSnapshot(draft, lastSavedChapterSnapshot)) {
    setSaveState(automatic ? "已自动保存" : "已保存");
    return state.chapter;
  }
  setSaveState(automatic ? "自动保存中" : "保存中", true);
  const workId = state.work.id;
  const request = (async () => {
    const chapter = await api(`/api/chapters/${draft.chapterId}`, {
      method: "PATCH",
      body: { title: draft.title, content: draft.content, source: automatic ? "auto" : "manual" }
    });
    const work = await api(`/api/works/${workId}`);
    return { chapter, work };
  })();
  chapterSaveInFlight = request;
  try {
    const saved = await request;
    if (state.work?.id !== workId || state.chapter?.id !== draft.chapterId) return saved.chapter;
    state.chapter = saved.chapter;
    state.work = saved.work;
    lastSavedChapterSnapshot = draft;
    renderTree();
    updateChapterStats();
    const currentDraft = chapterDraftSnapshot();
    if (sameChapterSnapshot(currentDraft, draft)) {
      setSaveState(automatic ? "已自动保存" : "已保存");
      if (!automatic) toast(`正文已保存为 v${state.chapter.versionNo}`);
    } else {
      scheduleChapterAutoSave(250);
    }
    return state.chapter;
  } catch (error) {
    if (state.chapter?.id === draft.chapterId) setSaveState("自动保存失败", true);
    toast(error.message, "error");
    return null;
  } finally {
    if (chapterSaveInFlight === request) chapterSaveInFlight = null;
  }
}

async function confirmDiscardChanges(message = "当前章节有未保存修改，继续将丢弃这些修改。是否继续？") {
  if (!state.dirty) return true;
  return confirmToast(message, {
    title: "放弃未保存修改",
    confirmLabel: "放弃并继续",
    cancelLabel: "继续编辑"
  });
}

function chooseExistingWorkImportMode(file) {
  const dialog = $("#import-mode-dialog");
  const form = dialog.querySelector("form");
  const confirm = $("#import-mode-confirm");
  const canOverwrite = canReplaceProse();
  $("#import-mode-file-summary").textContent = `文件：${file.name}；当前作品：《${state.work.title}》`;
  $("#import-mode-unsaved-warning").classList.toggle("hidden", !state.dirty);
  form.reset();
  $("#import-mode-overwrite").disabled = !canOverwrite;
  $("#import-mode-overwrite-permission").classList.toggle("hidden", canOverwrite);
  confirm.disabled = true;
  form.onchange = () => { confirm.disabled = !form.querySelector('input[name="importMode"]:checked'); };
  dialog.returnValue = "cancel";
  dialog.showModal();
  $("#import-mode-dialog-title").focus();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      const mode = form.querySelector('input[name="importMode"]:checked')?.value;
      resolve(dialog.returnValue === "confirm" && ["append", "overwrite"].includes(mode) ? mode : null);
    }, { once: true });
  });
}

function updateDocumentTitle(work = null) {
  const workTitle = String(work?.title ?? "").trim();
  document.title = workTitle ? `${workTitle} · 叙界` : platformDocumentTitle;
}

async function loadWorks(preferredId) {
  state.works = (await apiPage("/api/works")).items;
  if (preferredId) {
    await selectWork(preferredId);
    return;
  }
  showShelf();
}

function restoredSettingsReturnContext(route) {
  if (route.returnView === "module" && route.returnModule) return { view: "module", module: route.returnModule };
  if (route.returnView === "editor" && route.returnChapterId) return { view: "editor", chapterId: route.returnChapterId };
  if (route.returnView === "welcome") return { view: "welcome" };
  if (route.returnView === "shelf") return { view: "shelf" };
  if (state.work && state.chapter) return { view: "editor", chapterId: state.chapter.id };
  if (state.work) return { view: "welcome" };
  return { view: "shelf" };
}

async function initializePage() {
  if (!(await initializeAuthentication())) {
    restoringPageRoute = false;
    return;
  }
  const route = parsePageRoute(window.location.hash);
  state.works = (await apiPage("/api/works")).items;
  try {
    if (route.view === "shelf") {
      showShelf();
      return;
    }

    const requestedWork = route.workId ? state.works.find((work) => work.id === route.workId) : null;
    if (route.workId && !requestedWork) {
      showShelf();
      return;
    }

    if (requestedWork) {
      state.module = route.view === "module"
        ? route.module
        : route.view === "entity-editor"
          ? ({ setting: "settings", character: "characters", race: "races", organization: "organizations" }[route.entity] ?? "characters")
          : "editor";
      await selectWork(requestedWork.id, route.view === "editor" ? route.chapterId : null);
    }

    if (route.view === "editor") {
      if (route.chapterId && state.chapter?.id !== route.chapterId) await selectChapter(route.chapterId);
      return;
    }
    if (route.view === "module") return;
    if (route.view === "entity-editor") {
      const records = route.entity === "setting" ? state.settings : route.entity === "character" ? state.characters : route.entity === "race" ? state.races : state.organizations;
      const item = route.entityId ? records.find((record) => record.id === route.entityId) : null;
      if (route.entityId && !item) {
        toast(({ setting: "未找到要编辑的设定", character: "未找到要编辑的角色", race: "未找到要编辑的种族", organization: "未找到要编辑的组织" }[route.entity] ?? "未找到要编辑的档案"), "error");
        return;
      }
      if (route.entity === "setting") openSettingEditor(item);
      else if (route.entity === "character") await openCharacterEditor(item);
      else if (route.entity === "race") await openRaceDialog(item);
      else if (route.entity === "organization") await openOrganizationDialog(item);
      return;
    }
    if (route.view === "welcome") {
      showWelcome(true);
      return;
    }
    if (route.view === "settings") {
      await showSettingsHub();
      settingsReturnContext = restoredSettingsReturnContext(route);
      renderSettingsHub();
      return;
    }
    if (route.view === "platform-ai") {
      await showPlatformAi();
      settingsReturnContext = restoredSettingsReturnContext(route);
    }
  } finally {
    document.body.classList.remove("auth-pending");
    restoringPageRoute = false;
    replacePageRoute(currentPageRoute());
    scheduleFirstUseOnboarding();
  }
}

function showShelf() {
  state.dirty = false;
  settingsReturnContext = null;
  updateDocumentTitle();
  $("#app").classList.add("shelf-mode");
  $("#shelf-view").classList.remove("hidden");
  $("#platform-ai-view").classList.add("hidden");
  $("#settings-hub-view").classList.add("hidden");
  $("#welcome-view").classList.add("hidden");
  $("#editor-view").classList.add("hidden");
  $("#module-view").classList.add("hidden");
  $("#work-meta").textContent = `${state.works.length} 部作品`;
  $("#settings-button").removeAttribute("aria-current");
  $("#top-search-button").disabled = true;
  setSaveState("书架");
  renderShelf();
  replacePageRoute({ view: "shelf" });
}

function captureSettingsReturnContext() {
  if (!$("#shelf-view").classList.contains("hidden")) return { view: "shelf" };
  if (!$("#editor-view").classList.contains("hidden")) return { view: "editor", chapterId: state.chapter?.id ?? null };
  if (!$("#module-view").classList.contains("hidden")) return { view: "module", module: state.module };
  if (!$("#welcome-view").classList.contains("hidden")) return { view: "welcome" };
  return { view: state.work ? "editor" : "shelf", chapterId: state.chapter?.id ?? null };
}

function renderSettingsHub() {
  const hasWork = Boolean(state.work);
  const canManageWork = hasWork && ["admin", "owner"].includes(String(state.work.accessRole));
  const canReadAggregate = hasWork && canReadAggregateContent();
  const isAdmin = state.user?.role === "admin";
  $("#platform-ai-button").classList.toggle("hidden", !isAdmin);
  $("#user-management-button").classList.toggle("hidden", !isAdmin);
  $("#platform-ui-settings-button").classList.toggle("hidden", !isAdmin);
  $("#collaboration-button").disabled = !canManageWork;
  $("#top-search-button").disabled = !canReadAggregate;
  $("#export-button").disabled = !canReadAggregate;
  $("#settings-return").textContent = settingsReturnContext?.view === "shelf" || !hasWork ? "返回书架" : "返回当前作品";
  $("#settings-work-note").textContent = hasWork
    ? `当前作品：《${state.work.title}》。导出将作用于这部作品。`
    : "当前未选择作品；打开作品后可使用导出。";
}

function renderUsers(users) {
  const currentUserId = state.user?.userId;
  $("#users-list").innerHTML = users.map((user) => `<article class="access-row" data-user-row="${esc(user.userId)}">
    <div class="access-person">${userAvatarHtml(user, "access-avatar")}<div class="access-person-copy"><strong>${esc(user.displayName)} · @${esc(user.username)}</strong><small>${user.userId === currentUserId ? "当前账户 · " : ""}${user.status === "active" ? "账户可用" : "账户已停用"}</small></div></div>
    <select data-user-role="${esc(user.userId)}" aria-label="${esc(user.displayName)}的角色" ${user.userId === currentUserId ? "disabled" : ""}><option value="user" ${user.role === "user" ? "selected" : ""}>普通用户</option><option value="admin" ${user.role === "admin" ? "selected" : ""}>系统管理员</option></select>
    <button type="button" data-user-status="${esc(user.userId)}" ${user.userId === currentUserId ? "disabled" : ""}>${user.status === "active" ? "停用" : "启用"}</button>
  </article>`).join("");
  bindUserAvatarFallbacks($("#users-list"));
  $("#users-list").querySelectorAll("[data-user-role]").forEach((select) => select.addEventListener("change", async () => {
    try {
      const updated = await api(`/api/users/${encodeURIComponent(select.dataset.userRole)}`, { method: "PATCH", body: { role: select.value } });
      const usersAfterUpdate = users.map((item) => item.userId === updated.userId ? updated : item);
      renderUsers(usersAfterUpdate);
      toast("用户角色已更新");
    } catch (error) {
      select.value = users.find((item) => item.userId === select.dataset.userRole)?.role ?? "user";
      toast(error.message, "error");
    }
  }));
  $("#users-list").querySelectorAll("[data-user-status]").forEach((button) => button.addEventListener("click", async () => {
    const existing = users.find((item) => item.userId === button.dataset.userStatus);
    if (!existing) return;
    try {
      const updated = await api(`/api/users/${encodeURIComponent(existing.userId)}`, { method: "PATCH", body: { status: existing.status === "active" ? "disabled" : "active" } });
      renderUsers(users.map((item) => item.userId === updated.userId ? updated : item));
      toast("账户状态已更新");
    } catch (error) { toast(error.message, "error"); }
  }));
}

async function openUsersDialog() {
  if (state.user?.role !== "admin") {
    toast("需要系统管理员权限", "error");
    return;
  }
  $("#users-list").innerHTML = '<p class="empty-state">正在读取用户……</p>';
  $("#users-dialog").showModal();
  try { renderUsers((await apiPage("/api/users")).items); }
  catch (error) { $("#users-dialog").close(); toast(error.message, "error"); }
}

async function openPlatformUiSettingsDialog() {
  if (state.user?.role !== "admin") {
    toast("需要系统管理员权限", "error");
    return;
  }
  try {
    const settings = await api("/api/platform/ui-settings");
    $("#toast-position").value = settings.toastPosition === "top-right" ? "top-right" : "bottom-right";
    $("#platform-ui-settings-dialog").showModal();
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderMemberPermissionGrid(value) {
  const permissions = normalizeModulePermissions(value, "custom");
  $("#member-permission-grid").innerHTML = WORK_PERMISSION_MODULES.map((item) => `<label class="member-permission-row">
    <span>${esc(item.label)}</span>
    <select data-member-permission="${esc(item.id)}" aria-label="${esc(item.label)}权限">
      <option value="none" ${permissions[item.id] === "none" ? "selected" : ""}>无权限</option>
      <option value="read" ${permissions[item.id] === "read" ? "selected" : ""}>只读</option>
      <option value="write" ${permissions[item.id] === "write" ? "selected" : ""}>可编辑</option>
    </select>
  </label>`).join("");
}

function selectedMemberPermissions() {
  const permissions = emptyModulePermissions();
  $("#member-permission-grid").querySelectorAll("[data-member-permission]").forEach((select) => {
    permissions[select.dataset.memberPermission] = select.value;
  });
  return permissions;
}

function selectMemberForConfiguration(userId) {
  const fieldset = $("#member-permission-fieldset");
  const member = memberDialogMembers.find((item) => item.userId === userId);
  fieldset.disabled = !userId;
  renderMemberPermissionGrid(member?.permissions ?? emptyModulePermissions());
  $("#member-permission-submit").textContent = member ? "更新模块权限" : "添加成员并保存";
}

function renderMemberSelector(selectedUserId = "") {
  const ownerIds = new Set(memberDialogMembers.filter((member) => member.role === "owner").map((member) => member.userId));
  const people = new Map(memberDialogDirectory.map((user) => [user.userId, user]));
  for (const member of memberDialogMembers) if (member.role !== "owner") people.set(member.userId, member);
  const options = [...people.values()].filter((user) => !ownerIds.has(user.userId));
  $("#member-user-select").innerHTML = options.length
    ? `<option value="">选择用户</option>${options.map((user) => {
      const existing = memberDialogMembers.some((member) => member.userId === user.userId && member.role !== "owner");
      return `<option value="${esc(user.userId)}" ${selectedUserId === user.userId ? "selected" : ""}>${esc(user.displayName)} · @${esc(user.username)}${existing ? " · 已加入" : ""}</option>`;
    }).join("")}`
    : '<option value="">没有可配置的用户</option>';
  $("#member-user-select").disabled = !options.length;
  selectMemberForConfiguration(selectedUserId);
}

function renderMembers(members) {
  memberDialogMembers = members;
  const work = memberDialogWork ?? state.work;
  const canManage = ["admin", "owner"].includes(String(work?.accessRole));
  $("#members-list").innerHTML = members.map((member) => {
    const descriptionId = `member-role-summary-${member.userId}`;
    return `<article class="access-row">
      <div class="access-person">${userAvatarHtml(member, "access-avatar")}<div class="access-person-copy"><strong>${esc(member.displayName)} · @${esc(member.username)}</strong><small id="${esc(descriptionId)}">${member.role === "owner" ? "作品创建者 · 拥有全部模块管理权限" : esc(permissionSummary(member.permissions))}${member.status === "disabled" ? " · 已停用" : ""}</small></div></div>
      ${member.role === "owner" || !canManage ? "<span></span>" : `<button type="button" data-configure-member="${esc(member.userId)}" aria-describedby="${esc(descriptionId)}">配置权限</button>`}
      ${member.role === "owner" || !canManage ? "<span></span>" : `<button type="button" data-remove-member="${esc(member.userId)}">移除</button>`}
    </article>`;
  }).join("");
  bindUserAvatarFallbacks($("#members-list"));
  $("#members-list").querySelectorAll("[data-configure-member]").forEach((button) => button.addEventListener("click", () => {
    $("#member-user-select").value = button.dataset.configureMember;
    selectMemberForConfiguration(button.dataset.configureMember);
    $("#member-user-select").focus();
  }));
  $("#members-list").querySelectorAll("[data-remove-member]").forEach((button) => button.addEventListener("click", async () => {
    if (!work) return;
    try {
      const updated = await api(`/api/works/${encodeURIComponent(work.id)}/members/${encodeURIComponent(button.dataset.removeMember)}`, { method: "DELETE" });
      renderMembers(updated);
      renderMemberSelector();
      toast("协作者已移除");
    } catch (error) { toast(error.message, "error"); }
  }));
}

async function openMembersDialog(targetWork = state.work) {
  if (!targetWork) return;
  memberDialogWork = targetWork;
  const canManage = ["admin", "owner"].includes(String(targetWork.accessRole));
  $("#members-dialog-eyebrow").textContent = `作品权限 · 《${targetWork.title}》`;
  $("#members-dialog-title").textContent = "成员模块权限";
  $("#members-list").innerHTML = '<p class="empty-state">正在读取成员……</p>';
  $("#member-permission-form").classList.toggle("hidden", !canManage);
  memberDialogMembers = [];
  memberDialogDirectory = [];
  renderMemberPermissionGrid(emptyModulePermissions());
  $("#member-permission-fieldset").disabled = true;
  $("#members-dialog").showModal();
  try {
    const [members, directory] = await Promise.all([
      api(`/api/works/${encodeURIComponent(targetWork.id)}/members`),
      canManage ? api("/api/users/directory") : Promise.resolve([])
    ]);
    memberDialogDirectory = directory;
    renderMembers(members);
    if (canManage) renderMemberSelector();
  } catch (error) { $("#members-dialog").close(); toast(error.message, "error"); }
}

const searchResultTypeLabels = {
  chapter: "章节",
  setting: "设定",
  character: "角色",
  race: "种族",
  organization: "组织"
};

async function openSearchDialog() {
  if (!state.work) {
    toast("请先打开一部作品", "error");
    return;
  }
  $("#search-dialog .eyebrow").textContent = `当前作品 · 《${state.work.title}》`;
  $("#search-query").value = "";
  $("#search-results").innerHTML = '<p class="search-results-empty">输入关键词后开始检索。</p>';
  $("#search-dialog").showModal();
  queueMicrotask(() => $("#search-query").focus());
}

function renderSearchResults(results) {
  if (!results.length) {
    $("#search-results").innerHTML = '<p class="search-results-status">未找到相关内容。</p>';
    return;
  }
  $("#search-results").innerHTML = results.map((item) => `
    <button type="button" class="search-result" data-search-type="${esc(item.type)}" data-search-id="${esc(item.id)}">
      <div class="search-result-meta"><span>${esc(searchResultTypeLabels[item.type] ?? item.type)}</span><strong>${esc(item.title)}</strong></div>
      <p>${esc(item.snippet || "无摘要")}</p>
    </button>`).join("");
  $("#search-results").querySelectorAll(".search-result").forEach((button) => {
    button.addEventListener("click", () => {
      openSearchResult({ type: button.dataset.searchType, id: button.dataset.searchId })
        .catch((error) => toast(error.message, "error"));
    });
  });
}

async function runWorkSearch() {
  if (!state.work) throw new Error("请先打开一部作品");
  const query = $("#search-query").value.trim();
  if (!query) {
    $("#search-results").innerHTML = '<p class="search-results-empty">请输入关键词。</p>';
    return;
  }
  $("#search-results").innerHTML = '<p class="search-results-status">正在检索……</p>';
  const results = await api(`/api/works/${encodeURIComponent(state.work.id)}/search?q=${encodeURIComponent(query)}`);
  renderSearchResults(results);
}

async function openSearchResult(result) {
  $("#search-dialog").close();
  const inSettings = !$("#settings-hub-view").classList.contains("hidden") || !$("#platform-ai-view").classList.contains("hidden");
  if (inSettings) await returnFromSettings();
  if (result.type === "chapter") {
    await selectChapter(result.id);
    return;
  }
  if (result.type === "character") {
    await showModule("characters");
    const character = state.characters.find((item) => item.id === result.id);
    if (character) openCharacterEditor(character);
    return;
  }
  if (result.type === "setting") {
    await showModule("settings");
    const setting = await api(`/api/settings/${encodeURIComponent(result.id)}`);
    openSettingEditor(setting);
    return;
  }
  if (result.type === "race") {
    await showModule("races");
    const race = state.races.find((item) => item.id === result.id);
    if (race) openRaceDialog(race);
    return;
  }
  if (result.type === "organization") {
    await showModule("organizations");
    const organization = state.organizations.find((item) => item.id === result.id);
    if (organization) openOrganizationDialog(organization);
  }
}

async function showSettingsHub() {
  const alreadyInSettings = !$("#settings-hub-view").classList.contains("hidden") || !$("#platform-ai-view").classList.contains("hidden");
  if (!alreadyInSettings) {
    if (state.dirty && !(await confirmDiscardChanges("当前章节有未保存修改，进入设置将放弃本地修改。是否继续？"))) return false;
    settingsReturnContext = captureSettingsReturnContext();
    state.dirty = false;
  }
  updateDocumentTitle(state.work);
  $("#app").classList.add("shelf-mode");
  $("#shelf-view").classList.add("hidden");
  $("#platform-ai-view").classList.add("hidden");
  $("#settings-hub-view").classList.remove("hidden");
  $("#welcome-view").classList.add("hidden");
  $("#editor-view").classList.add("hidden");
  $("#module-view").classList.add("hidden");
  $("#work-meta").textContent = "设置中心";
  $("#settings-button").setAttribute("aria-current", "page");
  setSaveState("设置");
  renderSettingsHub();
  replacePageRoute({ view: "settings", workId: state.work?.id ?? null, ...settingsRouteContext() });
  return true;
}

async function returnFromSettings() {
  const context = settingsReturnContext ?? { view: "shelf" };
  settingsReturnContext = null;
  $("#settings-button").removeAttribute("aria-current");
  $("#settings-hub-view").classList.add("hidden");
  $("#platform-ai-view").classList.add("hidden");
  if (context.view === "shelf" || !state.work) return showShelf();
  $("#app").classList.remove("shelf-mode");
  $("#shelf-view").classList.add("hidden");
  updateDocumentTitle(state.work);
  $("#work-meta").textContent = `${state.work.title}${state.work.author ? ` · ${state.work.author}` : ""} · ${state.work.wordCount} 字`;
  if (context.view === "module") return showModule(context.module);
  if (context.view === "editor" && context.chapterId) return selectChapter(context.chapterId);
  return showWelcome(true);
}

async function showPlatformAi() {
  if (state.dirty && !(await confirmDiscardChanges("当前章节有未保存修改，进入平台 AI 管理将放弃本地修改。是否继续？"))) return false;
  state.dirty = false;
  updateDocumentTitle();
  $("#app").classList.add("shelf-mode");
  $("#shelf-view").classList.add("hidden");
  $("#platform-ai-view").classList.remove("hidden");
  $("#settings-hub-view").classList.add("hidden");
  $("#welcome-view").classList.add("hidden");
  $("#editor-view").classList.add("hidden");
  $("#module-view").classList.add("hidden");
  $("#work-meta").textContent = "平台 AI 管理";
  $("#settings-button").setAttribute("aria-current", "page");
  setSaveState("平台 AI");
  await renderPlatformAiConfig();
  replacePageRoute({ view: "platform-ai", workId: state.work?.id ?? null, ...settingsRouteContext() });
  return true;
}

function renderShelf() {
  const shelf = $("#book-shelf");
  shelf.innerHTML = `${state.works.map((work) => `
    <article class="book-card" data-work-card="${esc(work.id)}">
      <button class="book-open" type="button" data-open-work="${esc(work.id)}" aria-label="打开 ${esc(work.title)}">
        <span class="book-cover ${work.coverUrl ? "has-cover" : ""}">
          <span class="book-cover-fallback">${esc(Array.from(work.title)[0] ?? "书")}</span>
          ${work.coverUrl ? `<img src="${esc(work.coverUrl)}" alt="${esc(work.title)} 封面">` : ""}
        </span>
        <span class="book-info"><strong>${esc(work.title)}</strong><small>${esc(work.author || "未署名")} · ${work.chapterCount} 章 · ${work.wordCount} 字</small><span>${esc(work.description || "尚未填写作品简介")}</span><em class="book-access-badge">${work.accessRole === "viewer" ? "全部只读" : work.accessRole === "settings-editor" ? "设定协作" : work.accessRole === "editor" ? "全部可编辑" : work.accessRole === "custom" ? "自定义权限" : work.accessRole === "admin" ? "管理员访问" : "我的作品"}</em></span>
      </button>
      ${canManageWork(work) ? `<button class="book-card-settings" type="button" data-edit-work="${esc(work.id)}" aria-label="作品设置" title="作品设置">设置</button>` : ""}
    </article>`).join("")}
    <button class="book-card book-add-card" id="book-add-card" type="button" aria-label="新建作品" data-testid="book-add-card"><span>＋</span><strong>新建作品</strong><small>从零开始或导入 TXT / DOCX</small></button>`;
  shelf.querySelectorAll("[data-open-work]").forEach((button) => button.addEventListener("click", () => selectWork(button.dataset.openWork)));
  shelf.querySelectorAll("[data-edit-work]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    openWorkSettingsDialog(state.works.find((work) => work.id === button.dataset.editWork));
  }));
  $("#book-add-card").addEventListener("click", openWorkDialog);
}

function resetWorkScopedUiCaches() {
  workScopedUiGeneration += 1;
  loadedAiModelsWorkId = null;
  loadedAiReferencesWorkId = null;
  loadedAiConversationsWorkId = null;
  aiModelsLoadPromise = null;
  aiModelsLoadWorkId = null;
  aiReferencesLoadPromise = null;
  aiReferencesLoadWorkId = null;
  aiConversationsLoadPromise = null;
  aiConversationsLoadWorkId = null;
  state.models = [];
  state.characters = [];
  state.settings = [];
  state.collapsedVolumeIds.clear();
  lastSavedChapterSnapshot = null;
  if (aiContextUsageTimer !== null) clearTimeout(aiContextUsageTimer);
  aiContextUsageTimer = null;
  aiContextUsageRequest += 1;
  state.aiCitations = [];
  state.aiReferences = [];
  state.aiPromptSent = false;
  state.aiConversationId = null;
  state.aiConversations = [];
  renderAiCitations();
  renderAiReferences();
  renderAiQuickActions();
  resetAiFeed();
  $("#ai-conversation-title").textContent = "新对话";
  $("#ai-model").innerHTML = '<option value="">使用创作助手时加载模型</option>';
  setAiContextMeter(null);
  renderAiConversationHistory();
}

async function selectWork(workId, preferredChapterId = null) {
  const discarding = state.work?.id !== workId && state.dirty;
  if (discarding && !(await confirmDiscardChanges())) return false;
  const nextWork = await api(`/api/works/${workId}?page=1&limit=100`);
  if (state.work?.id !== nextWork.id) resetWorkScopedUiCaches();
  if (discarding) setSaveState("就绪");
  $("#app").classList.remove("shelf-mode");
  $("#shelf-view").classList.add("hidden");
  $("#platform-ai-view").classList.add("hidden");
  $("#settings-hub-view").classList.add("hidden");
  $("#settings-button").removeAttribute("aria-current");
  settingsReturnContext = null;
  state.work = nextWork;
  state.chapter = null;
  if (!canReadModule(state.module)) state.module = firstReadableUiModule(state.work) ?? "editor";
  applyWorkAccessMode();
  updateDocumentTitle(state.work);
  $("#work-meta").textContent = `${state.work.title}${state.work.author ? ` · ${state.work.author}` : ""} · ${state.work.wordCount} 字`;
  $("#top-search-button").disabled = !canReadAggregateContent();
  renderTree();
  const chapters = state.work.volumes.flatMap((volume) => volume.chapters);
  const targetChapter = chapters.find((chapter) => chapter.id === preferredChapterId) ?? chapters[0];
  if (state.module === "editor" && preferredChapterId) await selectChapter(preferredChapterId);
  else if (state.module === "editor" && targetChapter) await selectChapter(targetChapter.id);
  else if (state.module === "editor" && canReadModule("editor")) showWelcome(true);
  else if (!canReadModule(state.module)) showWelcome(true);
  else await showModule(state.module);
  return true;
}

function renderTree() {
  if (!state.work) return;
  const count = state.work.volumes.reduce((total, volume) => total + volume.chapters.length, 0);
  const proseEditable = canEditProse();
  $("#chapter-count").textContent = `${count} 章`;
  $("#novel-tree").classList.remove("empty-copy");
  $("#novel-tree").innerHTML = state.work.volumes.map((volume) => `
    <div class="volume-node ${state.collapsedVolumeIds.has(volume.id) ? "is-collapsed" : ""}" data-volume-id="${esc(volume.id)}">
      <div class="volume-title">
        <button class="volume-toggle" type="button" data-volume-toggle="${esc(volume.id)}" aria-expanded="${state.collapsedVolumeIds.has(volume.id) ? "false" : "true"}" title="左键折叠，右键设置分卷"><span>${esc(volume.title)}</span><span>${volume.chapters.length} 章</span></button>
        ${proseEditable ? `<button class="add-button chapter-add-button" type="button" data-new-chapter-volume="${esc(volume.id)}" aria-label="在“${esc(volume.title)}”中新建章节" title="在“${esc(volume.title)}”中新建章节">+</button>` : ""}
      </div>
      <div class="volume-chapters">
      ${volume.chapters.map((chapter) => `
        <button class="chapter-node ${state.chapter?.id === chapter.id ? "active" : ""}" type="button" data-chapter-id="${esc(chapter.id)}">
          <span>${esc(chapter.title)}</span><span class="chapter-node-meta">${chapter.chapterType && chapter.chapterType !== "正文" ? `<em class="chapter-type-badge">${esc(chapter.chapterType)}</em>` : ""}<small>${Number(chapter.wordCount ?? 0).toLocaleString("zh-CN")}</small></span>
        </button>`).join("")}
      </div>
    </div>`).join("");
  $("#novel-tree").querySelectorAll("[data-volume-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const volumeId = button.dataset.volumeToggle;
      if (state.collapsedVolumeIds.has(volumeId)) state.collapsedVolumeIds.delete(volumeId);
      else state.collapsedVolumeIds.add(volumeId);
      renderTree();
    });
    button.addEventListener("contextmenu", (event) => {
      if (!canEditProse()) return;
      event.preventDefault();
      openVolumeDialog(state.work.volumes.find((volume) => volume.id === button.dataset.volumeToggle));
    });
  });
  $("#novel-tree").querySelectorAll("[data-new-chapter-volume]").forEach((button) => {
    button.addEventListener("click", () => openChapterDialog(button.dataset.newChapterVolume));
  });
  $("#novel-tree").querySelectorAll("[data-chapter-id]").forEach((button) => {
    button.addEventListener("click", () => selectChapter(button.dataset.chapterId));
    button.addEventListener("contextmenu", (event) => {
      if (!canEditProse()) return;
      event.preventDefault();
      openChapterTypeMenu(button.dataset.chapterId, event.clientX, event.clientY);
    });
  });
}

function closeChapterTypeMenu() {
  state.contextChapterId = null;
  $("#chapter-type-menu").classList.add("hidden");
}

function openChapterTypeMenu(chapterId, clientX, clientY) {
  const chapter = state.work?.volumes.flatMap((volume) => volume.chapters).find((item) => item.id === chapterId);
  if (!chapter) return;
  state.contextChapterId = chapterId;
  const menu = $("#chapter-type-menu");
  menu.querySelector("strong").textContent = `标记“${chapter.title}”`;
  menu.querySelectorAll("[data-chapter-type]").forEach((button) => {
    button.classList.toggle("active", button.dataset.chapterType === (chapter.chapterType || "正文"));
    button.setAttribute("aria-checked", String(button.classList.contains("active")));
  });
  menu.classList.remove("hidden");
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - rect.height - 8))}px`;
}

async function selectChapter(chapterId) {
  if (state.chapter?.id !== chapterId && !(await confirmDiscardChanges("当前章节有未保存修改，仍要切换吗？"))) return;
  cancelChapterAutoSave();
  state.chapter = await api(`/api/chapters/${chapterId}`);
  lastSavedChapterSnapshot = { chapterId: state.chapter.id, title: state.chapter.title, content: state.chapter.content };
  state.module = "editor";
  applyWorkAccessMode();
  markActiveModule("editor");
  $("#welcome-view").classList.add("hidden");
  $("#module-view").classList.add("hidden");
  $("#editor-view").classList.remove("hidden");
  const volume = state.work.volumes.find((item) => item.id === state.chapter.volumeId);
  const chapterPath = `${volume?.title ?? "正文"} / 保存于 ${formatDateTime(state.chapter.updatedAt)}`;
  $("#chapter-path").textContent = chapterPath;
  $("#chapter-path").title = chapterPath;
  $("#chapter-title").value = state.chapter.title;
  const normalizedContent = normalizeParagraphSpacing(state.chapter.content);
  const spacingChanged = normalizedContent !== state.chapter.content;
  $("#chapter-content").value = normalizedContent;
  clearChapterLineSelection();
  scheduleChapterLineNumbers();
  $("#chapter-insight").classList.add("hidden");
  updateChapterStats();
  if (!canEditProse()) setSaveState("正文只读");
  else if (spacingChanged) scheduleChapterAutoSave(120);
  else setSaveState("已保存");
  renderTree();
  replacePageRoute({ view: "editor", workId: state.work.id, chapterId: state.chapter.id });
}

function updateChapterStats() {
  if (!state.chapter) return;
  const text = $("#chapter-content").value;
  const count = Array.from(text.replace(/\s/g, "")).length;
  $("#chapter-stats").textContent = `${count} 字 · v${state.chapter.versionNo}`;
}

async function saveChapter() {
  return persistChapter({ automatic: false });
}

function tidyChapterBlankLines() {
  if (!state.chapter) return toast("请先选择章节", "error");
  const input = $("#chapter-content");
  const normalized = normalizeParagraphSpacing(input.value);
  if (normalized === input.value) return toast("正文空行已经符合要求");
  input.value = normalized;
  scheduleChapterLineNumbers();
  updateChapterStats();
  scheduleChapterAutoSave(120);
  toast("已整理空行：段与段之间保留 1 个空行");
}

function showWelcome(hasWork = false) {
  $("#editor-view").classList.add("hidden");
  $("#module-view").classList.add("hidden");
  $("#welcome-view").classList.remove("hidden");
  $("#welcome-view h1").innerHTML = hasWork ? "故事已经就位，<br>从新章节继续。" : "把长篇故事的每条线索，<br>留在作者掌控之中。";
  $("#welcome-new-work").textContent = hasWork ? "新建章节" : "创建第一部作品";
  replacePageRoute(hasWork && state.work ? { view: "welcome", workId: state.work.id } : { view: "shelf" });
}

function markActiveModule(module) {
  $("#module-nav").querySelectorAll("button").forEach((button) => button.classList.toggle("active", button.dataset.module === module));
}

const moduleMeta = {
  settings: ["世界事实", "世界观与设定库", "锁定的设定会成为 AI 续写与校对的硬约束。", "新建设定"],
  characters: ["人物档案", "角色与人物属性", "维护别名、属性、当前状态及不可被 AI 覆盖的字段。", "新建角色"],
  races: ["物种档案", "种族与共同设定", "先维护种族档案，再由角色选择引用；角色不能临时填写种族。", "新建种族"],
  organizations: ["世界阵营", "组织与成员", "维护组织简介、设定清单，并将角色绑定到所属组织。", "新建组织"],
  timeline: ["剧情脉络", "大事件时间轴", "候选事件经作者确认后，才进入正式时间线。", "新建事件"],
  outlines: ["创作规划", "大纲与伏笔", "为每章维护目标、冲突与转折，并持续提醒尚未回收的伏笔。", "新建伏笔"],
  relationships: ["跨章证据", "人物关系", "记录关系方向、阶段、置信度与原文依据。", "新建关系"],
  reviews: ["作者决策", "审核队列", "集中处理冲突、候选设定、低置信度关系和时间问题。", "新增审核项"],
  tasks: ["AI 深度分析", "AI 分析中心", "对全书或指定章节运行人物关系、世界观、设定、事件与一致性分析。", "开始 AI 分析"],
  "ai-settings": ["书籍提示词", "本书 AI 设置", "本书系统提示词会追加在内置提示词和平台全局提示词之后；任务默认模型只作用于当前作品。", "保存设置"]
};

async function showModule(module) {
  if (!state.work) return showWelcome();
  if (!canReadModule(module)) {
    const fallback = firstReadableUiModule(state.work);
    if (!fallback) {
      showWelcome(true);
      return toast("当前账户尚未获授权访问任何作品模块", "error");
    }
    module = fallback;
  }
  if (module !== "editor" && state.module === "editor" && !(await confirmDiscardChanges())) return;
  if (module !== "editor" && state.module === "editor" && state.dirty) setSaveState("已放弃修改");
  state.module = module;
  applyWorkAccessMode();
  markActiveModule(module);
  if (module === "editor") {
    if (state.chapter) await selectChapter(state.chapter.id);
    else {
      const first = state.work.volumes.flatMap((volume) => volume.chapters)[0];
      if (first) await selectChapter(first.id);
      else showWelcome(true);
    }
    return;
  }
  $("#welcome-view").classList.add("hidden");
  $("#editor-view").classList.add("hidden");
  $("#module-view").classList.remove("hidden");
  const meta = moduleMeta[module];
  $("#module-eyebrow").textContent = meta[0];
  $("#module-title").textContent = meta[1];
  $("#module-description").textContent = meta[2];
  $("#module-create-button").textContent = meta[3];
  $("#module-create-button").classList.toggle("hidden", module === "ai-settings" || !canEditModule(module));
  $("#module-content").innerHTML = '<div class="empty-state">正在载入……</div>';
  try {
    if (module === "settings") await renderSettings();
    if (module === "characters") await renderCharacters();
    if (module === "races") await renderRaces();
    if (module === "organizations") await renderOrganizations();
    if (module === "timeline") await renderTimeline();
    if (module === "outlines") await renderOutlines();
    if (module === "relationships") await renderRelationships();
    if (module === "reviews") await renderReviews();
    if (module === "tasks") await renderTasks();
    if (module === "ai-settings") await renderBookAiSettings();
  } catch (error) {
    $("#module-content").innerHTML = `<div class="empty-state"><b>载入失败</b>${esc(error.message)}</div>`;
  }
  replacePageRoute({ view: "module", workId: state.work.id, module });
}

function emptyModule(title, description) {
  return `<div class="empty-state"><b>${esc(title)}</b>${esc(description)}</div>`;
}

function renderEntityHistory(versions) {
  const host = $("#entity-history-list");
  if (!versions.length) {
    host.innerHTML = '<p class="entity-history-empty">还没有可用的历史版本。</p>';
    return;
  }
  host.innerHTML = versions.map((version, index) => `<article class="entity-version-card${index === 0 ? " is-current" : ""}" data-entity-version="${version.versionNo}">
    <header><strong>v${version.versionNo}</strong><span>${esc(entityVersionSourceLabel(version.source))}</span></header>
    <time>${esc(formatDateTime(version.createdAt))} · ${esc(version.actor || "历史数据")}</time>
    <p>${esc(version.changeNote || entityVersionSnapshotSummary(entityHistoryContext.type, version.snapshot))}</p>
    <small>${esc(entityVersionSnapshotSummary(entityHistoryContext.type, version.snapshot))}</small>
    ${index === 0 ? '<button type="button" disabled>当前版本</button>' : `<button type="button" data-entity-version-restore="${version.versionNo}">回滚到此版本</button>`}
  </article>`).join("");
  host.querySelectorAll("[data-entity-version-restore]").forEach((button) => button.addEventListener("click", async () => {
    const versionNo = Number(button.dataset.entityVersionRestore);
    if (button.dataset.confirmed !== "true") {
      host.querySelectorAll("[data-entity-version-restore]").forEach((other) => {
        other.dataset.confirmed = "false";
        other.classList.remove("is-confirming");
        other.textContent = "回滚到此版本";
      });
      button.dataset.confirmed = "true";
      button.classList.add("is-confirming");
      button.textContent = `确认回滚至 v${versionNo}`;
      window.setTimeout(() => {
        if (!button.isConnected || button.dataset.confirmed !== "true") return;
        button.dataset.confirmed = "false";
        button.classList.remove("is-confirming");
        button.textContent = "回滚到此版本";
      }, 5000);
      return;
    }
    button.disabled = true;
    try {
      const restored = await api(`/api/entity-versions/${encodeURIComponent(entityHistoryContext.type)}/${encodeURIComponent(entityHistoryContext.entityId)}/restore`, { method: "POST", body: { versionNo } });
      await entityHistoryContext.refresh();
      const versionsAfterRestore = await api(`/api/entity-versions/${encodeURIComponent(entityHistoryContext.type)}/${encodeURIComponent(entityHistoryContext.entityId)}`);
      renderEntityHistory(versionsAfterRestore);
      toast(`已回滚至 v${versionNo}，并生成 v${restored.versionNo}`);
    } catch (error) {
      button.disabled = false;
      toast(error.message, "error");
    }
  }));
}

async function openEntityHistory(type, entityId, title, refresh) {
  entityHistoryContext = { type, entityId, refresh };
  $("#entity-history-eyebrow").textContent = VERSIONED_ENTITY_LABELS[type] ?? "创作资料";
  $("#entity-history-title").textContent = `${title} · 版本历史`;
  $("#entity-history-list").innerHTML = '<p class="entity-history-empty">正在读取版本历史…</p>';
  $("#entity-history-dialog").showModal();
  try {
    renderEntityHistory(await api(`/api/entity-versions/${encodeURIComponent(type)}/${encodeURIComponent(entityId)}`));
  } catch (error) {
    $("#entity-history-dialog").close();
    toast(error.message, "error");
  }
}

function bindEntityHistoryButtons(refresh) {
  $("#module-content").querySelectorAll("[data-entity-history]").forEach((button) => button.addEventListener("click", () => {
    openEntityHistory(button.dataset.entityHistory, button.dataset.entityId, button.dataset.entityTitle, refresh);
  }));
}

function openEntityMergeDialog({ typeLabel, source, candidates, endpoint, body, refresh, impact }) {
  const targetOptions = candidates
    .filter((candidate) => candidate.id !== source.id)
    .map((candidate) => [candidate.id, candidate.name]);
  openDialog(`合并${typeLabel}`,
    `<p class="merge-dialog-note">“${esc(source.name)}”将合并到所选档案，目标档案会保留。${esc(impact)}</p>` +
    field("targetId", `目标${typeLabel}`, "select", targetOptions[0]?.[0] ?? "", targetOptions),
    async (form) => {
      const target = candidates.find((candidate) => candidate.id === form.get("targetId"));
      if (!target) throw new Error(`请选择目标${typeLabel}`);
      await api(endpoint(source), { method: "POST", body: body(target) });
      await refresh();
      await loadAiReferences();
      toast(`已将“${source.name}”合并到“${target.name}”`);
    }, "人工资料管理", { submitLabel: "确认合并" });
}

async function deleteManagedEntity({ typeLabel, item, endpoint, refresh, warning = "" }) {
  const message = warning
    ? `确认删除${typeLabel}“${item.name}”吗？\n${warning}`
    : `确认删除${typeLabel}“${item.name}”吗？`;
  if (!(await confirmToast(message, { title: `删除${typeLabel}`, confirmLabel: "确认删除" }))) return;
  try {
    await api(endpoint(item), { method: "DELETE" });
    await refresh();
    await loadAiReferences();
    toast(`已删除${typeLabel}“${item.name}”`);
  } catch (error) {
    toast(error.message, "error");
  }
}

function readModuleLayout() {
  try {
    const stored = localStorage.getItem(MODULE_LAYOUT_STORAGE_KEY) ?? localStorage.getItem(LEGACY_SETTINGS_LAYOUT_STORAGE_KEY);
    return normalizeModuleLayout(stored);
  } catch {
    return "cards";
  }
}

function saveModuleLayout(layout) {
  const normalized = normalizeModuleLayout(layout);
  try {
    localStorage.setItem(MODULE_LAYOUT_STORAGE_KEY, normalized);
  } catch {
    /* 浏览器禁用存储时仅保留当前会话选择 */
  }
  return normalized;
}

function moduleRowPreview(text, max = 180) {
  const preview = String(text ?? "").replace(/\s+/g, " ").trim();
  return preview.length > max ? `${preview.slice(0, max)}…` : preview;
}

function renderModuleLayoutToggle(layout, ariaLabel = "列表样式") {
  return `<div class="module-layout-toolbar">
    <div class="module-layout-toggle" role="group" aria-label="${esc(ariaLabel)}">
      <button type="button" data-module-layout="cards" aria-pressed="${layout === "cards"}">卡片</button>
      <button type="button" data-module-layout="rows" aria-pressed="${layout === "rows"}">列表</button>
    </div>
    <span class="module-layout-hint">当前：${esc(moduleLayoutLabel(layout))}</span>
  </div>`;
}

function bindModuleLayoutToggle(refresh) {
  $("#module-content").querySelectorAll("[data-module-layout]").forEach((button) => button.addEventListener("click", async () => {
    saveModuleLayout(button.dataset.moduleLayout);
    await refresh();
  }));
}

function settingRecordActions(item) {
  return `${item.status === "pending" ? `<button data-setting-status="confirmed" data-setting-id="${esc(item.id)}">确认候选</button><button data-setting-status="deprecated" data-setting-id="${esc(item.id)}">弃用</button>` : ""}<button data-edit-setting="${esc(item.id)}">编辑</button><button data-entity-history="setting" data-entity-id="${esc(item.id)}" data-entity-title="${esc(item.title)}">版本历史</button>`;
}

function renderSettingCards(records) {
  return `<div class="card-grid">${records.map((item) => `
    <article class="record-card"><small>${esc(item.category)} · ${item.locked ? "已锁定" : esc(item.status)}</small>
    <h3>${esc(item.title)}</h3><div class="record-markdown-preview message-body">${renderMarkdown(item.content) || '<p class="markdown-editor-empty">暂无正文</p>'}</div>
    <div class="card-actions">${settingRecordActions(item)}</div></article>`).join("")}</div>`;
}

function renderSettingRows(records) {
  return `<div class="module-row-list">${records.map((item) => {
    const preview = moduleRowPreview(item.content);
    return `
    <article class="record-card module-row"><small>${esc(item.category)} · ${item.locked ? "已锁定" : esc(item.status)}</small>
    <h3>${esc(item.title)}</h3><p class="module-row-preview" title="${esc(preview)}">${esc(preview)}</p>
    <div class="card-actions">${settingRecordActions(item)}</div></article>`;
  }).join("")}</div>`;
}

async function renderSettings() {
  const records = (await apiPage(`/api/works/${state.work.id}/settings`)).items;
  state.settings = records;
  const layout = readModuleLayout();
  $("#module-content").innerHTML = records.length
    ? `${renderModuleLayoutToggle(layout, "设定列表样式")}${layout === "rows" ? renderSettingRows(records) : renderSettingCards(records)}`
    : emptyModule("还没有世界观设定", "新建规则、地点、组织、科技或创作约束。AI 提取的候选也会进入这里。");
  bindModuleLayoutToggle(renderSettings);
  $("#module-content").querySelectorAll("[data-setting-status]").forEach((button) => button.addEventListener("click", async () => {
    await api(`/api/settings/${button.dataset.settingId}`, { method: "PATCH", body: { status: button.dataset.settingStatus, changeNote: button.dataset.settingStatus === "confirmed" ? "确认 AI 设定候选" : "弃用 AI 设定候选" } });
    await renderSettings();
    await loadAiReferences();
  }));
  $("#module-content").querySelectorAll("[data-edit-setting]").forEach((button) => button.addEventListener("click", () => openSettingEditor(records.find((item) => item.id === button.dataset.editSetting))));
  bindEntityHistoryButtons(async () => { await renderSettings(); await loadAiReferences(); });
}

async function renderCharacters() {
  [state.characters, state.races, state.organizations] = await Promise.all([
    apiPage(`/api/works/${state.work.id}/characters`).then((result) => result.items),
    canReadModule("races") ? apiAllPages(`/api/works/${state.work.id}/races`) : Promise.resolve([]),
    canReadModule("organizations") ? apiAllPages(`/api/works/${state.work.id}/organizations`) : Promise.resolve([])
  ]);
  const layout = readModuleLayout();
  const characterActions = (item) => `<button data-edit-character="${esc(item.id)}">编辑</button>${canEditModule("characters") && state.characters.length > 1 ? `<button data-merge-character="${esc(item.id)}">合并</button>` : ""}${canEditModule("characters") ? `<button class="danger-button" data-delete-character="${esc(item.id)}">删除</button>` : ""}`;
  const characterCards = () => `<div class="card-grid">${state.characters.map((item) => {
    const details = normalizeCharacterDetails(item.attributes?.details);
    return `
    <article class="record-card character-card" data-open-character="${esc(item.id)}" role="button" tabindex="0" aria-label="查看角色 ${esc(item.name)}"><small>${item.lockedFields.length ? `锁定 ${item.lockedFields.length} 项` : esc(item.visibility)}</small>
    <h3>${esc(item.name)}</h3><div>${item.aliases.map((alias) => `<span class="pill">${esc(alias)}</span>`).join("")}</div>
    ${item.species ? `<div class="character-species"><b>种族</b><span class="pill">${esc(racePathLabel(item.race) || item.species)}</span></div>` : ""}
    ${item.attributes?.identity ? `<p class="character-identity">${esc(item.attributes.identity)}</p>` : ""}
    ${details.length ? `<dl class="character-detail-list">${details.slice(0, 4).map((detail) => `<div><dt>${esc(detail.label)}</dt><dd>${esc(detail.value)}</dd></div>`).join("")}</dl>` : ""}
    <div class="organization-links"><b>所属组织</b>${(item.organizations ?? []).length ? item.organizations.map((organization) => `<span class="pill organization-pill">${esc(organization.name)}</span>`).join("") : '<span class="organization-empty">未加入组织</span>'}</div>
    ${item.profile?.summary ? `<p class="character-summary">${esc(item.profile.summary)}</p>` : `<p>${esc(Object.entries(item.currentState).map(([key, value]) => `${key}：${value}`).join("\n") || "尚未记录当前状态")}</p>`}
    ${item.profileSectionCount ? `<small class="character-section-count">${item.profileSectionCount} 个设定章节</small>` : ""}
    <div class="card-actions">${characterActions(item)}</div></article>`;
  }).join("")}</div>`;
  const characterRows = () => `<div class="module-row-list">${state.characters.map((item) => {
    const preview = moduleRowPreview(item.profile?.summary || item.attributes?.identity || Object.entries(item.currentState).map(([key, value]) => `${key}：${value}`).join(" ") || "尚未记录当前状态");
    const meta = [
      item.species ? (racePathLabel(item.race) || item.species) : "",
      ...(item.aliases ?? []).slice(0, 3),
      (item.organizations ?? []).length ? (item.organizations ?? []).map((organization) => organization.name).join("、") : ""
    ].filter(Boolean).join(" · ");
    const line = meta ? `${meta} · ${preview}` : preview;
    return `
    <article class="record-card module-row character-card" data-open-character="${esc(item.id)}" role="button" tabindex="0" aria-label="查看角色 ${esc(item.name)}">
      <small>${item.lockedFields.length ? `锁定 ${item.lockedFields.length} 项` : esc(item.visibility)}</small>
      <h3>${esc(item.name)}</h3>
      <p class="module-row-preview" title="${esc(line)}">${esc(line)}</p>
      <div class="card-actions">${characterActions(item)}</div>
    </article>`;
  }).join("")}</div>`;
  const auditPanel = canEditModule("tasks") ? `<section class="character-audit-panel"><div><strong>角色身份确认</strong><small>让 AI 查询角色档案并搜索正文，找出可能被误建成两个档案的同一角色。AI 只提交审核建议，不会自动合并。</small></div><button id="create-character-audit-task" class="ghost-button" type="button" ${state.characters.length < 2 ? "disabled" : ""}>AI 角色查重</button></section>` : "";
  $("#module-content").innerHTML = auditPanel + (state.characters.length
    ? `${renderModuleLayoutToggle(layout, "角色列表样式")}${layout === "rows" ? characterRows() : characterCards()}`
    : emptyModule("还没有角色档案", "创建主要人物，并维护别名、身份、动机和当前状态。"));
  bindModuleLayoutToggle(renderCharacters);
  $("#create-character-audit-task")?.addEventListener("click", async () => {
    const button = $("#create-character-audit-task");
    button.disabled = true;
    try {
      await api(`/api/works/${state.work.id}/tasks`, { method: "POST", body: { taskType: "character-identity-audit", scope: { type: "book" } } });
      toast("角色查重任务已加入分析队列");
      await showModule("tasks");
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
    }
  });
  $("#module-content").querySelectorAll("[data-open-character]").forEach((card) => {
    const open = () => openCharacterEditor(state.characters.find((item) => item.id === card.dataset.openCharacter));
    card.addEventListener("click", (event) => { if (!event.target.closest("button")) open(); });
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
  });
  $("#module-content").querySelectorAll("[data-edit-character]").forEach((button) => button.addEventListener("click", () => openCharacterEditor(state.characters.find((item) => item.id === button.dataset.editCharacter))));
  $("#module-content").querySelectorAll("[data-merge-character]").forEach((button) => button.addEventListener("click", () => {
    const source = state.characters.find((item) => item.id === button.dataset.mergeCharacter);
    if (!source) return;
    openEntityMergeDialog({
      typeLabel: "角色",
      source,
      candidates: state.characters,
      endpoint: (item) => `/api/characters/${encodeURIComponent(item.id)}/merge`,
      body: (target) => ({
        targetCharacterId: target.id,
        expectedTargetVersionNo: target.versionNo,
        expectedSourceVersionNo: source.versionNo
      }),
      refresh: renderCharacters,
      impact: "来源角色的别名、组织、档案章节、时间线与人物关系会迁移到目标角色。"
    });
  }));
  $("#module-content").querySelectorAll("[data-delete-character]").forEach((button) => button.addEventListener("click", () => {
    const item = state.characters.find((character) => character.id === button.dataset.deleteCharacter);
    if (!item) return;
    void deleteManagedEntity({
      typeLabel: "角色",
      item,
      endpoint: (character) => `/api/characters/${encodeURIComponent(character.id)}`,
      refresh: renderCharacters,
      warning: "相关人物关系会删除，时间线中的参与者引用会移除。"
    });
  }));
}

async function renderRaces() {
  [state.races, state.characters] = await Promise.all([
    apiAllPages(`/api/works/${state.work.id}/races`),
    canReadModule("characters") ? apiAllPages(`/api/works/${state.work.id}/characters`) : Promise.resolve([])
  ]);
  const layout = readModuleLayout();
  const raceActions = (item) => `<button data-edit-race="${esc(item.id)}">编辑</button><button data-entity-history="race" data-entity-id="${esc(item.id)}" data-entity-title="${esc(item.name)}">版本历史</button>${canEditModule("races") && state.races.length > 1 ? `<button data-merge-race="${esc(item.id)}">合并</button>` : ""}${canEditModule("races") ? `<button class="danger-button" data-delete-race="${esc(item.id)}">删除</button>` : ""}`;
  const renderRaceNode = (item) => `<details class="race-tree-node" open data-race-node="${esc(item.id)}">
    <summary><span>${esc(item.name)}</span><small>${item.children.length} 个直接子种族</small></summary>
    <div class="race-tree-branch">
      <article class="record-card race-card"><small>${item.memberIds.length} 位直接角色 · ${item.settings.length ? "已填写共同设定" : "暂无共同设定"}</small>
        <div class="race-path" aria-label="种族路径">${esc(racePathLabel(item))}</div>
        <p>${esc(item.description || "尚未填写种族简介")}</p>
        <div class="race-settings">${item.effectiveSettings.length ? item.effectiveSettings.map((setting) => `<section class="knowledge-markdown-block${setting.inherited ? " inherited" : ""}"><div class="knowledge-markdown-block-heading"><h4>${esc(setting.title || "未命名章节")}</h4><small>${esc(setting.inherited ? `继承自 ${setting.sourceRaceName}` : `定义于 ${setting.sourceRaceName}`)}</small></div><div class="message-body">${renderMarkdown(setting.value) || '<p class="markdown-editor-empty">暂无内容</p>'}</div></section>`).join("") : '<span class="pill">暂无共同设定</span>'}</div>
        <p class="race-members">直接角色：${item.members.length ? item.members.map((member) => esc(member.name)).join("、") : "暂无绑定角色"}</p>
        <div class="card-actions">${raceActions(item)}</div>
      </article>
      ${item.children.length ? `<div class="race-tree-children">${item.children.map(renderRaceNode).join("")}</div>` : ""}
    </div>
  </details>`;
  const raceRows = () => `<div class="module-row-list">${state.races.map((item) => {
    const preview = moduleRowPreview(item.description || "尚未填写种族简介");
    const meta = `${item.memberIds.length} 位直接角色 · ${item.settings.length ? "已填写共同设定" : "暂无共同设定"}`;
    return `
    <article class="record-card module-row race-card">
      <small>${esc(meta)}</small>
      <h3>${esc(item.name)}<span class="module-row-path">${esc(racePathLabel(item))}</span></h3>
      <p class="module-row-preview" title="${esc(preview)}">${esc(preview)}${item.members.length ? ` · ${esc(item.members.map((member) => member.name).join("、"))}` : ""}</p>
      <div class="card-actions">${raceActions(item)}</div>
    </article>`;
  }).join("")}</div>`;
  $("#module-content").innerHTML = state.races.length
    ? `${renderModuleLayoutToggle(layout, "种族列表样式")}${layout === "rows" ? raceRows() : `<section class="race-tree" aria-label="种族层级">${buildRaceForest(state.races).map(renderRaceNode).join("")}</section>`}`
    : emptyModule("还没有种族档案", "先创建种族及共同设定，之后角色编辑器才能选择该种族。");
  bindModuleLayoutToggle(renderRaces);
  $("#module-content").querySelectorAll("[data-edit-race]").forEach((button) => button.addEventListener("click", () => openRaceDialog(state.races.find((item) => item.id === button.dataset.editRace))));
  $("#module-content").querySelectorAll("[data-merge-race]").forEach((button) => button.addEventListener("click", () => {
    const source = state.races.find((item) => item.id === button.dataset.mergeRace);
    if (!source) return;
    openEntityMergeDialog({
      typeLabel: "种族",
      source,
      candidates: state.races,
      endpoint: (item) => `/api/races/${encodeURIComponent(item.id)}/merge`,
      body: (target) => ({ targetRaceId: target.id }),
      refresh: renderRaces,
      impact: "来源种族的角色、子种族、简介与共同设定会迁移到目标种族。"
    });
  }));
  $("#module-content").querySelectorAll("[data-delete-race]").forEach((button) => button.addEventListener("click", () => {
    const item = state.races.find((race) => race.id === button.dataset.deleteRace);
    if (!item) return;
    void deleteManagedEntity({
      typeLabel: "种族",
      item,
      endpoint: (race) => `/api/races/${encodeURIComponent(race.id)}`,
      refresh: renderRaces,
      warning: "已绑定角色将变为未指定种族；有子种族时需先迁移或合并。"
    });
  }));
  bindEntityHistoryButtons(async () => { await renderRaces(); await loadAiReferences(); });
}

async function renderOrganizations() {
  [state.organizations, state.characters] = await Promise.all([
    apiAllPages(`/api/works/${state.work.id}/organizations`),
    canReadModule("characters") ? apiAllPages(`/api/works/${state.work.id}/characters`) : Promise.resolve([])
  ]);
  const layout = readModuleLayout();
  const organizationActions = (item) => `<button data-edit-organization="${esc(item.id)}">编辑</button><button data-entity-history="organization" data-entity-id="${esc(item.id)}" data-entity-title="${esc(item.name)}">版本历史</button>${canEditModule("organizations") && state.organizations.length > 1 ? `<button data-merge-organization="${esc(item.id)}">合并</button>` : ""}${canEditModule("organizations") ? `<button class="danger-button" data-delete-organization="${esc(item.id)}">删除</button>` : ""}`;
  const organizationCards = () => `<div class="card-grid organization-grid">${state.organizations.map((item) => `
    <article class="record-card organization-card"><small>${item.memberIds.length} 位成员 · ${item.settings.length ? "已填写组织设定" : "暂无组织设定"}</small>
      <h3>${esc(item.name)}</h3><p>${esc(item.description || "尚未填写组织简介")}</p>
      <div class="organization-settings">${item.settingsSections?.length ? item.settingsSections.map((section) => `<article class="knowledge-markdown-block"><div class="knowledge-markdown-block-heading"><h4>${esc(section.title || "未命名章节")}</h4></div><div class="message-body">${renderMarkdown(section.contentMarkdown) || '<p class="markdown-editor-empty">暂无内容</p>'}</div></article>`).join("") : '<span class="pill">暂无组织设定</span>'}</div>
      <p class="organization-members">成员：${item.members.length ? item.members.map((member) => esc(member.name)).join("、") : "暂无绑定角色"}</p>
      <div class="card-actions">${organizationActions(item)}</div>
    </article>`).join("")}</div>`;
  const organizationRows = () => `<div class="module-row-list">${state.organizations.map((item) => {
    const preview = moduleRowPreview(item.description || "尚未填写组织简介");
    const members = item.members.length ? item.members.map((member) => member.name).join("、") : "暂无绑定角色";
    return `
    <article class="record-card module-row organization-card">
      <small>${item.memberIds.length} 位成员 · ${item.settings.length ? "已填写组织设定" : "暂无组织设定"}</small>
      <h3>${esc(item.name)}</h3>
      <p class="module-row-preview" title="${esc(`${preview} · 成员：${members}`)}">${esc(preview)} · ${esc(members)}</p>
      <div class="card-actions">${organizationActions(item)}</div>
    </article>`;
  }).join("")}</div>`;
  $("#module-content").innerHTML = state.organizations.length
    ? `${renderModuleLayoutToggle(layout, "组织列表样式")}${layout === "rows" ? organizationRows() : organizationCards()}`
    : emptyModule("还没有组织", "创建国家、机构、阵营或团队，并维护组织设定与成员。");
  bindModuleLayoutToggle(renderOrganizations);
  $("#module-content").querySelectorAll("[data-edit-organization]").forEach((button) => button.addEventListener("click", () => openOrganizationDialog(state.organizations.find((item) => item.id === button.dataset.editOrganization))));
  $("#module-content").querySelectorAll("[data-merge-organization]").forEach((button) => button.addEventListener("click", () => {
    const source = state.organizations.find((item) => item.id === button.dataset.mergeOrganization);
    if (!source) return;
    openEntityMergeDialog({
      typeLabel: "组织",
      source,
      candidates: state.organizations,
      endpoint: (item) => `/api/organizations/${encodeURIComponent(item.id)}/merge`,
      body: (target) => ({ targetOrganizationId: target.id }),
      refresh: renderOrganizations,
      impact: "来源组织的成员、简介与组织设定会迁移到目标组织。"
    });
  }));
  $("#module-content").querySelectorAll("[data-delete-organization]").forEach((button) => button.addEventListener("click", () => {
    const item = state.organizations.find((organization) => organization.id === button.dataset.deleteOrganization);
    if (!item) return;
    void deleteManagedEntity({
      typeLabel: "组织",
      item,
      endpoint: (organization) => `/api/organizations/${encodeURIComponent(organization.id)}`,
      refresh: renderOrganizations,
      warning: "角色与该组织的成员关系会一并移除。"
    });
  }));
  bindEntityHistoryButtons(async () => { await renderOrganizations(); await loadAiReferences(); });
}

async function renderTimeline() {
  const [events, tracks] = await Promise.all([
    apiPage(`/api/works/${state.work.id}/timeline`).then((result) => result.items),
    apiAllPages(`/api/works/${state.work.id}/timeline-tracks`)
  ]);
  state.timelineTracks = tracks;
  const lanes = [...tracks, { id: "", name: "未分组时间轴", description: "尚未归入独立大事件的时间节点。", sortOrder: Number.MAX_SAFE_INTEGER }];
  const eventCard = (item) => `<article class="timeline-kanban-card"><div class="timeline-card-meta"><input type="checkbox" data-event-select="${esc(item.id)}" aria-label="选择 ${esc(item.name)}"><small>${esc(item.timeLabel)} · ${esc(item.status)}</small></div><h4>${esc(item.name)}</h4><p>${esc(item.description || "暂无说明")}</p>${item.location ? `<span>地点：${esc(item.location)}</span>` : ""}<div class="card-actions"><button data-edit-event="${esc(item.id)}">编辑与排序</button><button data-split-event="${esc(item.id)}">拆分</button><button data-entity-history="timeline-event" data-entity-id="${esc(item.id)}" data-entity-title="${esc(item.name)}">版本历史</button></div></article>`;
  $("#module-content").innerHTML = `<div class="timeline-tools"><button id="create-timeline-track" class="primary-button" type="button">新建独立时间轴</button>${events.length > 1 ? '<button id="merge-events" class="ghost-button" type="button">合并所选事件</button>' : ""}</div><div class="timeline-kanban" data-testid="timeline-kanban">${lanes.map((track) => {
    const laneEvents = events.filter((item) => (item.trackId ?? "") === track.id);
    return `<section class="timeline-lane" data-track-id="${esc(track.id)}"><header><div><small>${laneEvents.length} 个节点</small><h3>${esc(track.name)}</h3></div>${track.id ? `<div class="timeline-track-actions"><button class="timeline-track-menu" data-edit-timeline-track="${esc(track.id)}" type="button">编辑</button><button class="timeline-track-menu" data-entity-history="timeline-track" data-entity-id="${esc(track.id)}" data-entity-title="${esc(track.name)}" type="button">历史</button></div>` : ""}</header><p class="timeline-track-description">${esc(track.description || "暂无说明")}</p><div class="timeline-lane-events">${laneEvents.map(eventCard).join("") || '<div class="timeline-lane-empty">还没有时间节点</div>'}</div><button class="timeline-add-event" data-add-event-track="${esc(track.id)}" type="button">添加事件</button></section>`;
  }).join("")}</div>`;
  $("#create-timeline-track").addEventListener("click", () => openTimelineTrackDialog());
  $("#module-content").querySelectorAll("[data-edit-timeline-track]").forEach((button) => button.addEventListener("click", () => openTimelineTrackDialog(tracks.find((track) => track.id === button.dataset.editTimelineTrack))));
  $("#module-content").querySelectorAll("[data-add-event-track]").forEach((button) => button.addEventListener("click", () => openTimelineDialog(null, button.dataset.addEventTrack || null)));
  $("#module-content").querySelectorAll("[data-edit-event]").forEach((button) => button.addEventListener("click", () => openTimelineDialog(events.find((item) => item.id === button.dataset.editEvent))));
  $("#module-content").querySelectorAll("[data-split-event]").forEach((button) => button.addEventListener("click", () => openTimelineSplitDialog(events.find((item) => item.id === button.dataset.splitEvent))));
  bindEntityHistoryButtons(renderTimeline);
  $("#merge-events")?.addEventListener("click", () => {
    const eventIds = [...$("#module-content").querySelectorAll("[data-event-select]:checked")].map((input) => input.dataset.eventSelect);
    if (eventIds.length < 2) return toast("请至少选择两个时间事件", "error");
    openDialog("合并时间事件", field("name", "合并后的事件名称") + field("description", "合并说明（留空则拼接原说明）", "textarea"), async (form) => {
      await api(`/api/works/${state.work.id}/timeline/merge`, { method: "POST", body: {
        eventIds,
        name: form.get("name"),
        description: form.get("description") || undefined,
        expectedVersionNos: Object.fromEntries(eventIds.map((eventId) => [eventId, Number(events.find((event) => event.id === eventId)?.versionNo)]))
      } });
      await renderTimeline();
    }, "保留参与者与证据");
  });
}

async function renderOutlines() {
  const currentChapterId = state.chapter?.id;
  const [outlines, foreshadows] = await Promise.all([
    apiPage(`/api/works/${state.work.id}/outlines`).then((result) => result.items),
    apiPage(`/api/works/${state.work.id}/foreshadows?status=all${currentChapterId ? `&currentChapterId=${encodeURIComponent(currentChapterId)}` : ""}`).then((result) => result.items)
  ]);
  const layout = readModuleLayout();
  const unresolved = foreshadows.filter((item) => item.unresolved);
  const overdue = unresolved.filter((item) => item.overdue);
  const navButton = $("#module-nav [data-module=outlines] .nav-label");
  if (navButton) navButton.textContent = unresolved.length ? `大纲与伏笔 · ${unresolved.length}` : "大纲与伏笔";
  const foreshadowActions = (item) => `<button data-edit-foreshadow="${esc(item.id)}">编辑伏笔</button><button data-entity-history="foreshadow" data-entity-id="${esc(item.id)}" data-entity-title="${esc(item.title)}">版本历史</button>`;
  const foreshadowCards = () => `<div class="card-grid foreshadow-grid">${foreshadows.map((item) => `
    <article class="record-card foreshadow-card ${item.overdue ? "is-overdue" : ""}">
      <small>${esc(item.importance)} · ${esc(item.status)}${item.overdue ? " · 已逾期" : ""}</small>
      <h3>${esc(item.title)}</h3><p>${esc(item.description || "暂无说明")}</p>
      <div class="foreshadow-links">${item.occurrences.length ? item.occurrences.map((link) => `<span class="pill">${esc({ setup: "埋设", reminder: "提醒", payoff: "回收" }[link.role] ?? link.role)} · ${esc(link.volumeTitle)} / ${esc(link.chapterTitle)}</span>`).join("") : '<span class="pill">尚未关联章节</span>'}</div>
      <div class="card-actions">${foreshadowActions(item)}</div>
    </article>`).join("")}</div>`;
  const foreshadowRows = () => `<div class="module-row-list">${foreshadows.map((item) => {
    const preview = moduleRowPreview(item.description || "暂无说明");
    const links = item.occurrences.length
      ? item.occurrences.map((link) => `${({ setup: "埋设", reminder: "提醒", payoff: "回收" }[link.role] ?? link.role)} · ${link.volumeTitle} / ${link.chapterTitle}`).join("；")
      : "尚未关联章节";
    return `
    <article class="record-card module-row foreshadow-card ${item.overdue ? "is-overdue" : ""}">
      <small>${esc(item.importance)} · ${esc(item.status)}${item.overdue ? " · 已逾期" : ""}</small>
      <h3>${esc(item.title)}</h3>
      <p class="module-row-preview" title="${esc(`${preview} · ${links}`)}">${esc(preview)} · ${esc(links)}</p>
      <div class="card-actions">${foreshadowActions(item)}</div>
    </article>`;
  }).join("")}</div>`;
  const foreshadowHtml = foreshadows.length
    ? `${renderModuleLayoutToggle(layout, "伏笔列表样式")}${layout === "rows" ? foreshadowRows() : foreshadowCards()}`
    : emptyModule("还没有伏笔", "创建伏笔并关联埋设、提醒与回收章节，未回收项会持续显示。\n");
  const outlineHtml = outlines.length ? `<div class="outline-list">${outlines.map((item) => `
    <article class="outline-row ${item.status === "completed" ? "is-complete" : ""}">
      <div><small>${esc(item.volumeTitle)} · ${esc(item.status)}</small><h3>${esc(item.chapterTitle)}</h3></div>
      <div><b>目标</b><p>${esc(item.goal || "未填写")}</p></div>
      <div><b>冲突</b><p>${esc(item.conflict || "未填写")}</p></div>
      <div><b>转折</b><p>${esc(item.turningPoint || "未填写")}</p></div>
      <div class="outline-actions">${item.unresolvedForeshadowCount ? `<span>${item.unresolvedForeshadowCount} 个未回收伏笔</span>` : ""}<button data-edit-outline="${esc(item.chapterId)}">编辑</button><button data-entity-history="chapter-outline" data-entity-id="${esc(item.chapterId)}" data-entity-title="${esc(item.chapterTitle)}">版本历史</button></div>
    </article>`).join("")}</div>` : emptyModule("还没有章节", "先创建章节，再为每章维护目标、冲突和转折。\n");
  $("#module-content").innerHTML = `<div class="outline-summary"><article><strong>${outlines.length}</strong><span>章节规划</span></article><article><strong>${unresolved.length}</strong><span>未回收伏笔</span></article><article class="${overdue.length ? "danger-text" : ""}"><strong>${overdue.length}</strong><span>已逾期</span></article></div><section class="planning-section"><div class="section-title"><div><span class="eyebrow">伏笔追踪</span><h2>尚未回收与历史伏笔</h2></div></div>${foreshadowHtml}</section><section class="planning-section"><div class="section-title"><div><span class="eyebrow">逐章规划</span><h2>章节目标、冲突与转折</h2></div></div>${outlineHtml}</section>`;
  bindModuleLayoutToggle(renderOutlines);
  $("#module-content").querySelectorAll("[data-edit-outline]").forEach((button) => button.addEventListener("click", () => openOutlineDialog(outlines.find((item) => item.chapterId === button.dataset.editOutline))));
  $("#module-content").querySelectorAll("[data-edit-foreshadow]").forEach((button) => button.addEventListener("click", () => openForeshadowDialog(foreshadows.find((item) => item.id === button.dataset.editForeshadow))));
  bindEntityHistoryButtons(renderOutlines);
}

async function renderRelationships() {
  state.characters = canReadModule("characters") ? await apiAllPages(`/api/works/${state.work.id}/characters`) : [];
  const relationships = (await apiPage(`/api/works/${state.work.id}/relationships`)).items;
  const nameOf = (id) => state.characters.find((item) => item.id === id)?.name ?? "未知角色";
  state.galaxy?.destroy();
  state.relationshipExpandedMap?.destroy?.();
  if ($("#relationship-map-dialog").open) $("#relationship-map-dialog").close();
  const graph = buildRelationshipGraph(state.characters, relationships);
  state.relationshipGraph = graph;
  $("#module-content").innerHTML = `<div id="relationship-map-host"></div>${relationships.length ? `<table class="table-list relationship-table"><thead><tr><th>人物</th><th>关系</th><th>关键词</th><th>证据</th><th>置信度</th><th>状态</th><th>操作</th></tr></thead><tbody>${relationships.map((item) => `
    <tr><td>${esc(nameOf(item.fromCharacterId))} ${item.directed ? "→" : "—"} ${esc(nameOf(item.toCharacterId))}</td>
    <td>${esc(item.category)} / ${esc(item.subtype || "未细分")}</td><td>${(item.keywords ?? []).map((keyword) => `<span class="pill relationship-keyword">${esc(keyword)}</span>`).join("") || "—"}</td><td>${item.evidence.length} 条</td><td>${Math.round(item.confidence * 100)}%</td><td>${esc(item.confirmationStatus)}</td><td class="relationship-actions"><button data-edit-relationship="${esc(item.id)}">编辑</button><button data-entity-history="relationship" data-entity-id="${esc(item.id)}" data-entity-title="${esc(`${nameOf(item.fromCharacterId)} / ${nameOf(item.toCharacterId)}`)}">历史</button></td></tr>`).join("")}</tbody></table>` : '<div class="relationship-empty-note">尚无关系边；孤立角色仍显示在力导向图谱中。可人工新建关系，或运行全书人物关系分析。</div>'}`;
  const openGalaxy = () => {
    state.galaxy?.destroy();
    state.galaxy = createGalaxyRenderer($("#relationship-galaxy-dialog"), graph, { workId: state.work.id });
    state.galaxy.open();
  };
  const openExpanded = () => {
    state.relationshipExpandedMap?.destroy?.();
    state.relationshipExpandedMap = renderRelationshipMindMap($("#relationship-map-expanded-host"), graph, {
      expanded: true,
      onOpenGalaxy: openGalaxy
    });
    $("#relationship-map-dialog").showModal();
  };
  state.relationshipMindMap?.destroy?.();
  state.relationshipMindMap = renderRelationshipMindMap($("#relationship-map-host"), graph, { onOpenGalaxy: openGalaxy, onOpenExpanded: openExpanded });
  $("#module-content").querySelectorAll("[data-edit-relationship]").forEach((button) => button.addEventListener("click", () => openRelationshipDialog(relationships.find((item) => item.id === button.dataset.editRelationship))));
  bindEntityHistoryButtons(async () => { await renderRelationships(); await loadAiReferences(); });
}

async function renderReviews() {
  const canReadCharacters = canReadModule("characters");
  const canResolveReview = canEditModule("reviews");
  const canMergeCharacters = canResolveReview
    && ["characters", "races", "organizations", "timeline", "relationships"].every((module) => canEditModule(module));
  const [reviews, characters] = await Promise.all([
    apiPage(`/api/works/${state.work.id}/reviews`).then((result) => result.items),
    canReadCharacters ? apiAllPages(`/api/works/${state.work.id}/characters?includeMerged=1`) : Promise.resolve([])
  ]);
  const characterById = new Map(characters.map((character) => [character.id, character]));
  const duplicateCard = (item) => {
    const refs = (item.entityRefs ?? []).filter((reference) => reference?.type === "character" && characterById.has(reference.id));
    const sides = refs.map((reference) => ({ reference, character: characterById.get(reference.id) }));
    const sideHtml = sides.map(({ character }) => `<section><strong>${esc(character.name)}</strong><small>v${esc(String(character.versionNo))} · ${esc(character.species || "种族未知")}</small><div>${character.aliases.map((alias) => `<span class="pill">${esc(alias)}</span>`).join("") || '<span class="organization-empty">无别名</span>'}</div><p>${esc(character.attributes?.identity || character.profile?.summary || "尚未记录身份说明")}</p></section>`).join("");
    const evidenceHtml = (item.evidence ?? []).map((evidence) => `<li><strong>${esc(evidence.chapterTitle || evidence.chapterId || "原文")}</strong><q>${esc(evidence.quote || "")}</q>${evidence.supports ? `<small>${esc(evidence.supports)}</small>` : ""}</li>`).join("");
    const mergeActions = item.status === "pending" && sides.length === 2 && canMergeCharacters ? `
      <button data-merge-review="${esc(item.id)}" data-merge-target="${esc(sides[0].character.id)}" data-merge-source="${esc(sides[1].character.id)}" data-target-version="${esc(String(sides[0].reference.versionNo))}" data-source-version="${esc(String(sides[1].reference.versionNo))}">合并为 ${esc(sides[0].character.name)}</button>
      <button data-merge-review="${esc(item.id)}" data-merge-target="${esc(sides[1].character.id)}" data-merge-source="${esc(sides[0].character.id)}" data-target-version="${esc(String(sides[1].reference.versionNo))}" data-source-version="${esc(String(sides[0].reference.versionNo))}">合并为 ${esc(sides[1].character.name)}</button>` : "";
    const keepSeparateAction = item.status === "pending" && canResolveReview
      ? `<button data-keep-characters-separate="${esc(item.id)}">确认是不同角色</button>`
      : "";
    const actions = mergeActions || keepSeparateAction
      ? `<div class="card-actions character-duplicate-actions">${mergeActions}${keepSeparateAction}</div>`
      : "";
    return `<article class="record-card character-duplicate-review"><small>角色查重 · ${esc(item.severity)} · ${esc(item.status)}</small><h3>${esc(item.title)}</h3><div class="character-duplicate-pair">${sideHtml}</div><p>${esc(item.description)}${item.suggestion ? `\n建议：${esc(item.suggestion)}` : ""}</p>${evidenceHtml ? `<ul class="character-duplicate-evidence">${evidenceHtml}</ul>` : ""}${actions}${item.resolutionNote ? `<p class="review-resolution-note">处理结果：${esc(item.resolutionNote)}</p>` : ""}</article>`;
  };
  const layout = readModuleLayout();
  const reviewCard = (item) => item.itemType === "character-duplicate" ? duplicateCard(item) : `
    <article class="record-card"><small>${esc(item.itemType)} · ${esc(item.severity)} · ${esc(item.status)}</small><h3>${esc(item.title)}</h3>
    <p>${esc(item.description)}${item.suggestion ? `\n建议：${esc(item.suggestion)}` : ""}</p>
    ${item.status === "pending" && canResolveReview ? `<div class="card-actions"><button data-review-status="fixed" data-review-id="${esc(item.id)}">标为已修复</button><button data-review-status="ignored" data-review-id="${esc(item.id)}">忽略</button></div>` : ""}</article>`;
  const reviewRow = (item) => {
    if (item.itemType === "character-duplicate") {
      return `<div class="module-row-span">${duplicateCard(item)}</div>`;
    }
    const preview = moduleRowPreview(`${item.description || ""}${item.suggestion ? ` 建议：${item.suggestion}` : ""}`);
    return `
    <article class="record-card module-row">
      <small>${esc(item.itemType)} · ${esc(item.severity)} · ${esc(item.status)}</small>
      <h3>${esc(item.title)}</h3>
      <p class="module-row-preview" title="${esc(preview)}">${esc(preview)}</p>
      <div class="card-actions">${item.status === "pending" && canResolveReview ? `<button data-review-status="fixed" data-review-id="${esc(item.id)}">标为已修复</button><button data-review-status="ignored" data-review-id="${esc(item.id)}">忽略</button>` : ""}</div>
    </article>`;
  };
  $("#module-content").innerHTML = reviews.length
    ? `${renderModuleLayoutToggle(layout, "审核列表样式")}${layout === "rows" ? `<div class="module-row-list">${reviews.map(reviewRow).join("")}</div>` : `<div class="card-grid">${reviews.map(reviewCard).join("")}</div>`}`
    : emptyModule("没有待审核事项", "候选设定、冲突与低置信度结论会集中显示在这里。");
  bindModuleLayoutToggle(renderReviews);
  $("#module-content").querySelectorAll("[data-review-id]").forEach((button) => button.addEventListener("click", async () => {
    await api(`/api/reviews/${button.dataset.reviewId}`, { method: "PATCH", body: { status: button.dataset.reviewStatus } });
    await renderReviews();
  }));
  $("#module-content").querySelectorAll("[data-merge-review]").forEach((button) => button.addEventListener("click", async () => {
    const target = characterById.get(button.dataset.mergeTarget);
    const source = characterById.get(button.dataset.mergeSource);
    if (!target || !source || !(await confirmToast(
      `确认把“${source.name}”合并到“${target.name}”？来源角色的别名、组织、时间线和关系会迁移到目标角色。`,
      { title: "确认合并角色", confirmLabel: "确认合并" }
    ))) return;
    button.disabled = true;
    try {
      await api(`/api/reviews/${button.dataset.mergeReview}/character-resolution`, { method: "POST", body: {
        action: "merge",
        targetCharacterId: target.id,
        sourceCharacterId: source.id,
        expectedTargetVersionNo: Number(button.dataset.targetVersion),
        expectedSourceVersionNo: Number(button.dataset.sourceVersion)
      } });
      toast(`已将“${source.name}”合并到“${target.name}”`);
      await renderReviews();
      await loadAiReferences();
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
    }
  }));
  $("#module-content").querySelectorAll("[data-keep-characters-separate]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api(`/api/reviews/${button.dataset.keepCharactersSeparate}/character-resolution`, { method: "POST", body: { action: "keep-separate" } });
      toast("已确认这两个档案属于不同角色");
      await renderReviews();
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
    }
  }));
}

async function renderTasks() {
  const [tasks, settings] = await Promise.all([
    apiPage(`/api/works/${state.work.id}/tasks?view=summary`).then((result) => result.items),
    canReadModule("ai-settings")
      ? api(`/api/works/${state.work.id}/ai-settings`)
      : Promise.resolve({ autoRunEnabled: false, autoRunConcurrency: 2, autoRunBatchLimit: 20 })
  ]);
  const canConfigureAutoRun = canEditModule("tasks") && canEditModule("ai-settings");
  const pendingCount = tasks.filter((item) => item.status === "pending").length;
  const runningCount = tasks.filter((item) => item.status === "running").length;
  $("#module-content").innerHTML = `
    <section class="task-auto-run-panel ${canConfigureAutoRun ? "" : "hidden"}" aria-labelledby="task-auto-run-title">
      <div class="task-auto-run-copy">
        <strong id="task-auto-run-title">自动执行待分析任务</strong>
        <small>只执行已经进入“待执行”队列的任务，不会自动创建人物关系、世界观或其他分析。</small>
        <small>每轮最多启动「每轮任务上限」个，同时运行数量不超过「同时运行上限」；剩余任务需点击“开始下一轮”。</small>
      </div>
      <div class="task-auto-run-controls">
        <label class="checkbox-field"><input id="task-auto-run-enabled" type="checkbox" ${settings.autoRunEnabled ? "checked" : ""}><span>自动执行待分析任务</span></label>
        <label>同时运行上限<input id="task-auto-run-concurrency" type="number" min="1" max="8" value="${esc(String(settings.autoRunConcurrency ?? 2))}"></label>
        <label>每轮任务上限<input id="task-auto-run-batch-limit" type="number" min="1" max="200" value="${esc(String(settings.autoRunBatchLimit ?? 20))}"></label>
        <button id="task-auto-run-save" class="primary-button" type="button">保存并生效</button>
        <button id="task-auto-run-continue" class="ghost-button" type="button" ${settings.autoRunEnabled ? "" : "disabled"}>开始下一轮</button>
      </div>
      <p class="task-auto-run-meta">待执行队列 ${pendingCount} 个 · 正在运行 ${runningCount} 个</p>
    </section>
    ${tasks.length ? `<table class="table-list task-table"><thead><tr><th>分析类型</th><th>范围</th><th>状态</th><th>进度</th><th>操作</th></tr></thead><tbody>${tasks.map((item) => `
    <tr>
      <td>${esc(analysisTaskTypeLabel(item.taskType))}<br><small>${esc(item.taskType)}</small></td>
      <td>${esc(item.scopeSummary || item.scope?.type || "book")}</td>
      <td>${esc(analysisTaskStatusLabel(item.status))}</td>
      <td>${Number(item.progress ?? 0)}%</td>
      <td class="task-row-actions">
        <button class="ghost-button" type="button" data-task-detail="${esc(item.id)}">详情</button>
        ${item.status === "pending" ? `<button class="ghost-button" type="button" data-run-task="${esc(item.id)}">运行</button>` : ""}
        ${item.status === "pending" || item.status === "running" ? `<button class="ghost-button" type="button" data-cancel-task="${esc(item.id)}">取消</button>` : ""}
      </td>
    </tr>`).join("")}</tbody></table>` : emptyModule("还没有 AI 分析记录", "点击“开始 AI 分析”，可分析指定章节或整部作品。")}`;

  $("#task-auto-run-save")?.addEventListener("click", async () => {
    const button = $("#task-auto-run-save");
    button.disabled = true;
    try {
      const updated = await api(`/api/works/${state.work.id}/ai-settings`, {
        method: "PATCH",
        body: {
          autoRunEnabled: $("#task-auto-run-enabled").checked,
          autoRunConcurrency: Number($("#task-auto-run-concurrency").value),
          autoRunBatchLimit: Number($("#task-auto-run-batch-limit").value)
        }
      });
      toast(updated.autoRunEnabled
        ? `自动执行已开启：同时最多 ${updated.autoRunConcurrency} 个，每轮最多 ${updated.autoRunBatchLimit} 个`
        : "自动执行已关闭");
      await renderTasks();
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
    }
  });
  $("#task-auto-run-continue")?.addEventListener("click", async () => {
    const button = $("#task-auto-run-continue");
    button.disabled = true;
    try {
      const result = await api(`/api/works/${state.work.id}/tasks/auto-run`, { method: "POST", body: {} });
      toast(`已开始下一轮，队列中还有 ${result.pendingCount} 个待执行任务`);
      await renderTasks();
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
    }
  });

  $("#module-content").querySelectorAll("[data-task-detail]").forEach((button) => button.addEventListener("click", () => {
    if (button.disabled) return;
    button.disabled = true;
    api(`/api/tasks/${encodeURIComponent(button.dataset.taskDetail)}`)
      .then((task) => openTaskDetailDialog(task))
      .catch((error) => toast(error.message, "error"))
      .finally(() => { button.disabled = false; });
  }));
  $("#module-content").querySelectorAll("[data-run-task]").forEach((button) => button.addEventListener("click", async () => {
    const workId = state.work.id;
    try {
      button.disabled = true;
      button.textContent = "运行中";
      const cancel = button.parentElement.querySelector("[data-cancel-task]");
      if (cancel) cancel.textContent = "取消运行";
      const completed = await api(`/api/tasks/${button.dataset.runTask}/run`, { method: "POST", body: { modelId: $("#ai-model").value || undefined } });
      toast(completed.status === "cancelled" ? "分析任务已取消" : completed.status === "expired" ? "正文已变化，本次分析已过期" : "分析已完成");
      if (state.module === "tasks" && state.work?.id === workId) await renderTasks();
    } catch (error) {
      toast(error.message, "error");
      if (state.module === "tasks" && state.work?.id === workId) await renderTasks();
    }
  }));
  $("#module-content").querySelectorAll("[data-cancel-task]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api(`/api/tasks/${button.dataset.cancelTask}/cancel`, { method: "POST", body: {} });
      toast("分析任务已取消");
      if (state.module === "tasks") await renderTasks();
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
    }
  }));
}

function openTaskDetailDialog(task) {
  if (!task) return;
  const details = Array.isArray(task.scopeDetails) ? task.scopeDetails : [];
  const detailHtml = details.map((item) => {
    if (item.type === "chapter") {
      if (item.missing) return `<li>章节已删除（${esc(item.chapterId)}）</li>`;
      return `<li>${esc(item.volumeTitle)} · ${esc(item.title)}<br><small>ID ${esc(item.chapterId)} · v${esc(String(item.versionNo))}</small></li>`;
    }
    if (item.type === "volume") {
      if (item.missing) return `<li>分卷已删除（${esc(item.volumeId)}）</li>`;
      const chapters = Array.isArray(item.chapters) ? item.chapters : [];
      return `<li>分卷 · ${esc(item.title)}（${chapters.length} 章）
        <ul>${chapters.slice(0, 30).map((chapter) => `<li>${esc(chapter.title)} · v${esc(String(chapter.versionNo))}</li>`).join("")}${chapters.length > 30 ? "<li>……</li>" : ""}</ul>
      </li>`;
    }
    if (item.type === "book") return "<li>全书</li>";
    return `<li>${esc(JSON.stringify(item))}</li>`;
  }).join("") || "<li>无范围详情</li>";
  const failures = Array.isArray(task.failures) ? task.failures : [];
  const failureHtml = failures.length
    ? `<ul>${failures.map((item) => `<li>${esc(item.message || JSON.stringify(item))}</li>`).join("")}</ul>`
    : "<p>无</p>";
  const resultPreview = task.result && Object.keys(task.result).length
    ? `<pre class="task-detail-result">${esc(JSON.stringify(task.result, null, 2).slice(0, 2000))}</pre>`
    : "<p>尚无结果</p>";
  openDialog("任务详情",
    `<div class="task-detail">
      <p><strong>任务 ID</strong><br><code>${esc(task.id)}</code></p>
      <p><strong>类型</strong> ${esc(analysisTaskTypeLabel(task.taskType))}（${esc(task.taskType)}）</p>
      <p><strong>状态</strong> ${esc(analysisTaskStatusLabel(task.status))} · 进度 ${Number(task.progress ?? 0)}%</p>
      <p><strong>范围摘要</strong> ${esc(task.scopeSummary || "未指定")}</p>
      <div><strong>范围详情</strong><ul>${detailHtml}</ul></div>
      <div><strong>失败信息</strong>${failureHtml}</div>
      <div><strong>结果摘要</strong>${resultPreview}</div>
      <p><small>创建于 ${esc(formatDateTime(task.createdAt))} · 更新于 ${esc(formatDateTime(task.updatedAt))}</small></p>
    </div>`,
    async () => undefined,
    "AI 分析详情",
    { submitLabel: "关闭", wide: true });
}

function renderProviderCards(providers, models) {
  return providers.length ? `<div class="card-grid provider-card-grid">${providers.map((provider) => `
    <article class="record-card provider-card"><small>平台级 · ${esc(provider.status)} · ${esc(provider.connectionStatus)}</small><h3>${esc(provider.name)}</h3>
    <p>${esc(provider.baseUrl)}\n密钥：${esc(provider.apiKey)}\n并发：${provider.concurrencyLimit} · RPM：${provider.rpmLimit} · max_tokens：${provider.maxTokens ?? 32000}${provider.lastError ? `\n错误：${esc(provider.lastError)}` : ""}</p>
    <div class="provider-models">${models.filter((model) => model.providerId === provider.id).map((model) => `<button class="pill model-pill" type="button" data-edit-model="${esc(model.id)}" aria-label="编辑模型 ${esc(model.displayName)}">${esc(model.displayName)} · ${model.enabled ? "启用" : "停用"} · Thinking ${model.thinkingEnabled ? "开启" : "关闭"} · 上下文 ${Number(model.contextWindow ?? 128000).toLocaleString("zh-CN")} Token · max_tokens ${Number(model.preset?.max_tokens ?? 32000).toLocaleString("zh-CN")}</button>`).join("")}</div>
    <div class="card-actions"><button data-edit-provider="${esc(provider.id)}">编辑配置</button><button data-test-provider="${esc(provider.id)}">测试连接</button><button data-add-model="${esc(provider.id)}">添加模型</button></div></article>`).join("")}</div>`
    : emptyModule("尚未配置 AI 供应商", "添加 OpenAI Chat Completions 兼容地址和密钥，测试成功后再添加模型。");
}

function bindPlatformProviderActions(host, providers, models) {
  host.querySelectorAll("[data-test-provider]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "测试中";
    const result = await api(`/api/providers/${button.dataset.testProvider}/test`, { method: "POST", body: {} });
    toast(result.ok ? "连接测试成功" : `连接失败：${result.error}`, result.ok ? "info" : "error");
    await renderPlatformAiConfig();
    await loadModels();
  }));
  host.querySelectorAll("[data-add-model]").forEach((button) => button.addEventListener("click", () => openModelDialog(button.dataset.addModel)));
  host.querySelectorAll("[data-edit-model]").forEach((button) => button.addEventListener("click", () => openModelDialog(undefined, models.find((model) => model.id === button.dataset.editModel))));
  host.querySelectorAll("[data-edit-provider]").forEach((button) => button.addEventListener("click", () => openProviderDialog(providers.find((provider) => provider.id === button.dataset.editProvider))));
}

function renderTaskDefaults(models, providers, taskDefaults) {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const defaultModelByTask = new Map(taskDefaults.map((item) => [item.taskType, item.model.id]));
  return models.length ? `<section class="config-section">
    <div class="config-section-header"><div><h2>本书任务默认模型</h2><p>选择平台模型作为当前作品的默认模型；所有请求都会携带 max_tokens，默认值为 32000。</p></div></div>
    <table class="table-list"><thead><tr><th>任务能力</th><th>默认模型</th></tr></thead><tbody>${taskTypeLabels.map(([taskType, label]) => {
      const currentModelId = defaultModelByTask.get(taskType) ?? "";
      return `<tr><td>${esc(label)}<br><small>${esc(taskType)}</small></td><td><select class="default-model-select" data-task-default="${esc(taskType)}">
        <option value="" disabled ${currentModelId ? "" : "selected"}>请选择模型</option>
        ${models.map((model) => {
          const provider = providerById.get(model.providerId);
          const available = model.enabled && provider?.status === "enabled" && provider?.connectionStatus === "success";
          return `<option value="${esc(model.id)}" ${model.id === currentModelId ? "selected" : ""} ${available || model.id === currentModelId ? "" : "disabled"}>${esc(modelOptionLabel({ ...model, providerName: model.providerName || provider?.name }))}</option>`;
        }).join("")}
      </select></td></tr>`;
    }).join("")}</tbody></table>
  </section>` : emptyModule("尚未配置平台模型", "请先在平台 AI 管理中添加并测试供应商模型。");
}

async function renderPlatformAiConfig() {
  const [providers, models, settings] = await Promise.all([
    api("/api/platform/ai/providers"),
    api("/api/platform/ai/models"),
    api("/api/platform/ai/settings")
  ]);
  const host = $("#platform-ai-content");
  host.innerHTML = `<section class="config-section platform-system-prompt-section"><div class="config-section-header"><div><h2>平台全局系统提示词</h2><p>会追加在内置系统提示词之后，并在所有作品的专属提示词之前发送给模型。</p></div></div><div class="field-label"><textarea id="platform-system-prompt" rows="7" aria-label="全局系统提示词" placeholder="例如：默认使用简体中文，避免代替作者做最终决定。">${esc(settings.systemPrompt)}</textarea></div><div class="card-actions"><button id="save-platform-system-prompt" class="primary-button">保存全局提示词</button></div></section>${renderProviderCards(providers, models)}`;
  $("#save-platform-system-prompt").addEventListener("click", async () => {
    const button = $("#save-platform-system-prompt");
    button.disabled = true;
    try {
      await api("/api/platform/ai/settings", { method: "PATCH", body: { systemPrompt: $("#platform-system-prompt").value } });
      toast("平台全局系统提示词已保存");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });
  bindPlatformProviderActions(host, providers, models);
}

async function renderBookAiSettings() {
  const [settings, providers, models, taskDefaults] = await Promise.all([
    api(`/api/works/${state.work.id}/ai-settings`),
    api("/api/platform/ai/providers"),
    api(`/api/works/${state.work.id}/models`),
    api(`/api/works/${state.work.id}/task-defaults`)
  ]);
  const host = $("#module-content");
  const agentTools = new Set(settings.agentTools ?? ["story_index", "read_chapters", "grep", "query_story_knowledge", "read_character_sections"]);
  host.innerHTML = `<section class="config-section"><div class="config-section-header"><div><h2>本书系统提示词</h2><p>会追加在内置系统提示词和平台全局系统提示词之后，只影响《${esc(state.work.title)}》的 AI 请求。</p></div></div><div class="field-label"><textarea id="work-system-prompt" rows="8" aria-label="本书系统提示词" placeholder="例如：叙事使用第三人称，哥斯拉不得离开地球。">${esc(settings.systemPrompt)}</textarea></div><div class="card-actions"><button id="save-work-system-prompt" class="primary-button">保存本书提示词</button></div></section><section class="config-section"><div class="config-section-header"><div><h2>全书概要引用配额</h2><p>引用全书概要时按分卷保留覆盖，并优先加入与当前问题相关的章节概要；该比例控制概要可使用的上下文预算。</p></div></div><div class="field-label"><label class="book-summary-context-percent-field">上下文占比（%）<input id="book-summary-context-percent" type="number" min="1" max="90" value="${esc(String(settings.bookSummaryContextPercent ?? 50))}" aria-label="全书概要引用上下文占比"></label></div><div class="card-actions"><button id="save-book-summary-context-percent" class="primary-button">保存概要配额</button></div></section><section class="config-section"><div class="config-section-header"><div><h2>对话长期记忆</h2><p>对话历史使用独立预算；达到阈值时先提醒，继续发送会把较早消息整理成带来源的结构化长期记忆，并尽量保留最近八条原文。</p></div></div><div class="field-label"><label class="context-compact-threshold-field">整理提醒阈值（%）<input id="context-compact-threshold" type="number" min="50" max="90" value="${esc(String(settings.contextCompactThreshold ?? 85))}" aria-label="对话长期记忆整理提醒阈值"></label></div><div class="card-actions"><button id="save-context-compact-threshold" class="primary-button">保存整理阈值</button></div></section><section class="config-section"><div class="config-section-header"><div><h2>AI 查询工具</h2><p>工具默认可用，作为已有上下文的补充。关闭后模型不会看到对应能力；所有工具只读且有数量、篇幅与调用轮次限制。</p></div></div><div class="ai-agent-tools"><label><input name="agent-tool" type="checkbox" value="story_index" ${agentTools.has("story_index") ? "checked" : ""}><span><strong>作品目录与章节概要</strong><small>分页获取卷章、章节 ID 和当前概要，不返回正文。</small></span></label><label><input name="agent-tool" type="checkbox" value="read_chapters" ${agentTools.has("read_chapters") ? "checked" : ""}><span><strong>读取章节</strong><small>按章节 ID 获取概要或正文，每次最多 3 章。</small></span></label><label><input name="agent-tool" type="checkbox" value="query_story_knowledge" ${agentTools.has("query_story_knowledge") ? "checked" : ""}><span><strong>查询作品知识</strong><small>按关键词查询设定、人物、组织、时间线、关系、大纲和伏笔。</small></span></label></div><div class="card-actions"><button id="save-agent-tools" class="primary-button">保存工具设置</button></div></section>${renderTaskDefaults(models, providers, taskDefaults)}`;
  host.querySelector('input[name="agent-tool"][value="query_story_knowledge"]').closest("label").insertAdjacentHTML(
    "beforebegin",
    `<label><input name="agent-tool" type="checkbox" value="grep" ${agentTools.has("grep") ? "checked" : ""}><span><strong>查询正文关键字</strong><small>从段落索引查询关键字，默认返回前 20 条完整段落和章节信息。</small></span></label>`
  );
  host.querySelector('input[name="agent-tool"][value="query_story_knowledge"]').closest("label").insertAdjacentHTML(
    "afterend",
    `<label><input name="agent-tool" type="checkbox" value="read_character_sections" ${agentTools.has("read_character_sections") ? "checked" : ""}><span><strong>读取人物 Markdown 章节</strong><small>根据知识查询返回的章节 ID 精读人物背景、能力与经历原文。</small></span></label>`
  );
  if (!canEditModule("ai-settings")) {
    host.querySelectorAll("textarea, input, select").forEach((control) => { control.disabled = true; });
    host.querySelectorAll(".primary-button").forEach((button) => button.classList.add("permission-hidden"));
  }
  $("#save-work-system-prompt").addEventListener("click", async () => {
    const button = $("#save-work-system-prompt");
    button.disabled = true;
    try {
      await api(`/api/works/${state.work.id}/ai-settings`, { method: "PATCH", body: { systemPrompt: $("#work-system-prompt").value } });
      toast("本书系统提示词已保存");
      scheduleAiContextUsage();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });
  $("#save-book-summary-context-percent").addEventListener("click", async () => {
    const button = $("#save-book-summary-context-percent");
    button.disabled = true;
    try {
      await api(`/api/works/${state.work.id}/ai-settings`, { method: "PATCH", body: { bookSummaryContextPercent: Number($("#book-summary-context-percent").value) } });
      toast("全书概要引用配额已保存");
      scheduleAiContextUsage();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });
  $("#save-context-compact-threshold").addEventListener("click", async () => {
    const button = $("#save-context-compact-threshold");
    button.disabled = true;
    try {
      await api(`/api/works/${state.work.id}/ai-settings`, { method: "PATCH", body: { contextCompactThreshold: Number($("#context-compact-threshold").value) } });
      toast("对话长期记忆整理阈值已保存");
      scheduleAiContextUsage();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });
  $("#save-agent-tools").addEventListener("click", async () => {
    const button = $("#save-agent-tools");
    button.disabled = true;
    try {
      const agentTools = [...host.querySelectorAll('input[name="agent-tool"]:checked')].map((input) => input.value);
      await api(`/api/works/${state.work.id}/ai-settings`, { method: "PATCH", body: { agentTools } });
      toast("AI 查询工具设置已保存");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });
  host.querySelectorAll("[data-task-default]").forEach((select) => select.addEventListener("change", async () => {
    select.disabled = true;
    try {
      await api(`/api/works/${state.work.id}/task-defaults/${select.dataset.taskDefault}`, { method: "PUT", body: { modelId: select.value } });
      toast("默认模型已更新");
    } catch (error) {
      toast(error.message, "error");
    }
    await renderBookAiSettings();
    await loadModels();
  }));
}

async function loadModels() {
  const workId = state.work?.id;
  if (!workId) return;
  const generation = workScopedUiGeneration;
  const models = await api(`/api/works/${workId}/models`);
  if (state.work?.id !== workId || generation !== workScopedUiGeneration) return;
  state.models = models;
  loadedAiModelsWorkId = workId;
  const select = $("#ai-model");
  select.innerHTML = state.models.length
    ? state.models.map((model) => `<option value="${esc(model.id)}" ${model.enabled ? "" : "disabled"}>${esc(modelOptionLabel(model))}</option>`).join("")
    : '<option value="">请先配置模型</option>';
  scheduleAiContextUsage();
}

async function ensureAiModelsLoaded() {
  const workId = state.work?.id;
  if (!workId || loadedAiModelsWorkId === workId) return;
  if (aiModelsLoadPromise && aiModelsLoadWorkId === workId) return aiModelsLoadPromise;
  const select = $("#ai-model");
  select.innerHTML = '<option value="">正在加载模型……</option>';
  aiModelsLoadWorkId = workId;
  aiModelsLoadPromise = loadModels();
  try {
    await aiModelsLoadPromise;
  } catch (error) {
    if (state.work?.id === workId) select.innerHTML = '<option value="">模型加载失败，点击重试</option>';
    throw error;
  } finally {
    if (aiModelsLoadWorkId === workId) {
      aiModelsLoadPromise = null;
      aiModelsLoadWorkId = null;
    }
  }
}

let aiContextUsageTimer = null;
let aiContextUsageRequest = 0;

function currentAiRequestScope() {
  if (!state.work) return null;
  const taskType = $("#ai-task").value;
  const scopeType = $("#ai-scope").value;
  const requiresChapter = taskType === "polish" || taskType === "continue" || scopeType !== "none";
  if (requiresChapter && !state.chapter) return null;
  const selection = state.chapter ? $("#chapter-content").value.slice($("#chapter-content").selectionStart, $("#chapter-content").selectionEnd) : "";
  const volume = state.chapter ? state.work.volumes.find((item) => item.id === state.chapter.volumeId) : null;
  const includeBookSummary = scopeType === "chapter-summary";
  const scope = taskType === "polish" ? { type: "chapter", chapterId: state.chapter?.id, selection }
    : scopeType === "none" ? { type: "none", ...(taskType === "continue" && state.chapter ? { chapterId: state.chapter.id } : {}) }
    : scopeType === "book" ? { type: "book" }
    : scopeType === "volume" ? { type: "volume", volumeId: volume?.id }
    : { type: "chapter", chapterId: state.chapter?.id };
  Object.assign(scope, buildAiReferenceScope(state.aiReferences));
  if (includeBookSummary) scope.includeBookSummary = true;
  return { taskType, scope, selection };
}

function setAiContextMeter(usage) {
  const meter = $("#ai-context-meter");
  const value = meter.querySelector("b");
  if (!usage) {
    meter.classList.add("is-empty");
    meter.classList.remove("is-warning", "is-danger");
    meter.style.setProperty("--context-usage", "0");
    value.textContent = "—";
    const tooltip = formatAiContextUsageTooltip(null);
    meter.dataset.tooltip = tooltip;
    meter.setAttribute("aria-label", tooltip);
    return;
  }
  const percent = Math.max(0, Math.min(100, Number(usage.usagePercent) || 0));
  meter.classList.remove("is-empty");
  meter.classList.toggle("is-warning", percent >= 70 && percent < 90);
  meter.classList.toggle("is-danger", percent >= 90);
  meter.style.setProperty("--context-usage", String(percent));
  value.textContent = `${percent}%`;
  const tooltip = formatAiContextUsageTooltip(usage);
  meter.dataset.tooltip = tooltip;
  meter.setAttribute("aria-label", `当前上下文用量：${tooltip}`);
}

function showAiContextWarning(usage = null) {
  const percent = Math.max(0, Math.round(Number(usage?.conversationUsagePercent) || 0));
  const threshold = Math.max(50, Math.min(90, Number(usage?.compactThreshold) || 85));
  $("#ai-context-warning-title").textContent = percent ? `对话历史已使用 ${percent}% 的独立预算` : "对话历史接近整理阈值";
  $("#ai-context-warning-message").textContent = `已达到 ${threshold}% 的长期记忆整理阈值。现在可整理较早对话或新开对话；若继续发送，系统会先生成带来源的结构化长期记忆。作品正文超限不会触发此操作。`;
  $("#ai-context-warning").classList.remove("hidden");
}

function hideAiContextWarning() {
  $("#ai-context-warning").classList.add("hidden");
}

async function prepareAiConversationContext({ instruction, scope, modelId, citations }) {
  const conversationId = await ensureAiConversation();
  const prepared = await api(`/api/ai-conversations/${conversationId}/context/prepare`, {
    method: "POST",
    body: { instruction, scope, modelId, citations }
  });
  setAiContextMeter(prepared.usage);
  if (prepared.action === "warn") {
    showAiContextWarning(prepared.usage);
    return false;
  }
  hideAiContextWarning();
  if (prepared.action === "compacted") toast("已自动整理较早对话为长期记忆并继续发送");
  return true;
}

function scheduleAiContextUsage() {
  if (aiContextUsageTimer !== null) clearTimeout(aiContextUsageTimer);
  aiContextUsageTimer = setTimeout(() => {
    aiContextUsageTimer = null;
    void refreshAiContextUsage();
  }, 260);
}

async function refreshAiContextUsage() {
  const requestScope = currentAiRequestScope();
  const modelId = $("#ai-model").value;
  if (!requestScope || !modelId || (requestScope.taskType === "polish" && !requestScope.selection)) {
    setAiContextMeter(null);
    return;
  }
  const requestId = ++aiContextUsageRequest;
  try {
    const citations = state.aiCitations.map(({ chapterId, chapterTitle, startLine, endLine, text }) => ({ chapterId, chapterTitle, startLine, endLine, text }));
    const usage = await api(`/api/works/${state.work.id}/ai-context-usage`, {
      method: "POST",
      body: {
        modelId,
        taskType: requestScope.taskType,
        scope: requestScope.scope,
        instruction: aiPromptText(),
        citations,
        conversationId: state.aiConversationId || undefined
      }
    });
    if (requestId === aiContextUsageRequest) setAiContextMeter(usage);
  } catch {
    if (requestId === aiContextUsageRequest) setAiContextMeter(null);
  }
}

async function loadAiReferences() {
  const workId = state.work?.id;
  if (!workId) return;
  const generation = workScopedUiGeneration;
  const [characters, settings] = await Promise.all([
    canReadModule("characters") ? apiAllPages(`/api/works/${workId}/characters`) : Promise.resolve([]),
    canReadModule("settings") ? apiAllPages(`/api/works/${workId}/settings`) : Promise.resolve([])
  ]);
  if (state.work?.id !== workId || generation !== workScopedUiGeneration) return;
  state.characters = characters;
  state.settings = settings;
  loadedAiReferencesWorkId = workId;
}

async function ensureAiReferencesLoaded() {
  const workId = state.work?.id;
  if (!workId || loadedAiReferencesWorkId === workId) return;
  if (aiReferencesLoadPromise && aiReferencesLoadWorkId === workId) return aiReferencesLoadPromise;
  aiReferencesLoadWorkId = workId;
  aiReferencesLoadPromise = loadAiReferences();
  try {
    await aiReferencesLoadPromise;
  } finally {
    if (aiReferencesLoadWorkId === workId) {
      aiReferencesLoadPromise = null;
      aiReferencesLoadWorkId = null;
    }
  }
}

function field(name, label, type = "text", value = "", options = []) {
  if (type === "textarea") return `<label>${esc(label)}<textarea name="${esc(name)}">${esc(value)}</textarea></label>`;
  if (type === "markdown") return `<div class="form-field markdown-editor-field" data-vditor-editor-field><div class="vditor-editor-host" data-vditor-editor data-placeholder="${esc(options.placeholder ?? `在这里编辑${label}`)}" aria-label="Markdown 编辑器"></div><textarea class="hidden" name="${esc(name)}" data-vditor-value maxlength="200000" aria-label="Markdown 原文">${esc(value)}</textarea></div>`;
  if (type === "item-list") {
    const values = Array.isArray(value) && value.length ? value : [""];
    return `<div class="form-field item-list-field"><span>${esc(label)}</span><div class="item-list-rows" data-item-list-rows data-name="${esc(name)}" data-label="${esc(label)}">${values.map((item) => `<div class="item-list-row"><input name="${esc(name)}" value="${esc(item)}" aria-label="${esc(label)}"><button type="button" data-item-list-remove aria-label="删除此条">删除</button></div>`).join("")}</div><button class="item-list-add" type="button" data-item-list-add>添加一条</button></div>`;
  }
  if (type === "keyword-chips") {
    const values = uniqueRelationshipKeywords(Array.isArray(value) ? value : []);
    const chips = values.map((keyword) => `<span class="keyword-chip" data-keyword-chip><span>${esc(keyword)}</span><input type="hidden" name="${esc(name)}" value="${esc(keyword)}" data-keyword-value><button type="button" data-keyword-chip-remove aria-label="删除关键词：${esc(keyword)}">×</button></span>`).join("");
    return `<div class="form-field keyword-chip-field" data-keyword-chips data-name="${esc(name)}"><span>${esc(label)}</span><div class="keyword-chip-editor" role="group" aria-label="${esc(label)}">${chips}<input type="text" data-keyword-input aria-label="${esc(label)}" placeholder="输入后按回车添加，逗号可批量添加" autocomplete="off"></div><small>输入关键词后按回车添加；也可用逗号一次添加多个。</small></div>`;
  }
  if (type === "key-value-list") {
    const config = Array.isArray(options) ? {} : options;
    const keyName = config.keyName ?? "detailLabel";
    const valueName = config.valueName ?? "detailValue";
    const keyPlaceholder = config.keyPlaceholder ?? "字段名，如身高";
    const valuePlaceholder = config.valuePlaceholder ?? "字段值，如119.786米";
    const keyAriaLabel = config.keyAriaLabel ?? "扩展属性名称";
    const valueAriaLabel = config.valueAriaLabel ?? "扩展属性内容";
    const removeLabel = config.removeLabel ?? "删除此扩展属性";
    const addLabel = config.addLabel ?? "添加属性";
    const values = normalizeCharacterDetails(value);
    const rows = values.length ? values : [{ label: "", value: "" }];
    return `<div class="form-field structured-list-field character-profile-detail-list"><span>${esc(label)}</span><div class="structured-list-rows" data-structured-list-rows data-kind="key-value">${rows.map((item) => `<div class="structured-list-row key-value-list-row"><input name="${esc(keyName)}" value="${esc(item.label)}" placeholder="${esc(keyPlaceholder)}" aria-label="${esc(keyAriaLabel)}"><input name="${esc(valueName)}" value="${esc(item.value)}" placeholder="${esc(valuePlaceholder)}" aria-label="${esc(valueAriaLabel)}"><button type="button" data-structured-list-remove aria-label="${esc(removeLabel)}">删除</button></div>`).join("")}</div><button class="item-list-add" type="button" data-structured-list-add>${esc(addLabel)}</button></div>`;
  }
  if (type === "section-list") {
    const values = normalizeCharacterSections(value);
    const rows = values.length ? values : [{ title: "", content: "" }];
    return `<div class="form-field structured-list-field character-profile-section-list"><span>${esc(label)}</span><small>适合记录能力、形态、生态、历史事件、传说和研究版本等长篇内容。</small><div class="structured-list-rows" data-structured-list-rows data-kind="section">${rows.map((item) => `<div class="structured-list-row section-list-row"><input name="sectionTitle" value="${esc(item.title)}" placeholder="章节标题，如能力与特征" aria-label="设定章节标题"><textarea name="sectionContent" placeholder="章节内容，支持 Markdown" aria-label="设定章节内容">${esc(item.content)}</textarea><button type="button" data-structured-list-remove aria-label="删除此设定章节">删除</button></div>`).join("")}</div><button class="item-list-add" type="button" data-structured-list-add>添加设定章节</button></div>`;
  }
  if (type === "select") return `<label>${esc(label)}<select name="${esc(name)}">${options.map(([key, text]) => `<option value="${esc(key)}" ${key === value ? "selected" : ""}>${esc(text)}</option>`).join("")}</select></label>`;
  if (type === "multiselect") {
    const selected = new Set((Array.isArray(value) ? value : []).map(String));
    return `<label>${esc(label)}<select name="${esc(name)}" multiple size="${Math.min(8, Math.max(3, options.length))}">${options.map(([key, text]) => `<option value="${esc(key)}" ${selected.has(String(key)) ? "selected" : ""}>${esc(text)}</option>`).join("")}</select></label>`;
  }
  if (type === "chips") {
    const selected = new Set((Array.isArray(value) ? value : []).map(String));
    return `<div class="form-field chip-field"><span>${esc(label)}</span><div class="chip-picker" role="group" aria-label="${esc(label)}">${options.map(([key, text]) => `<label class="member-chip"><input type="checkbox" name="${esc(name)}" value="${esc(key)}" ${selected.has(String(key)) ? "checked" : ""}><span>${esc(text)}</span></label>`).join("")}</div></div>`;
  }
  if (type === "checkbox") return `<label class="checkbox-field"><input name="${esc(name)}" type="checkbox" ${value ? "checked" : ""}><span>${esc(label)}</span></label>`;
  return `<label>${esc(label)}<input name="${esc(name)}" type="${esc(type)}" value="${esc(value)}" ${type === "password" ? 'autocomplete="new-password"' : ""} ${type === "number" ? 'step="any"' : ""}></label>`;
}

function knowledgeSectionTitleFromMarkdown(content, index) {
  return String(content).match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/mu)?.[1]?.trim() || `设定 ${index + 1}`;
}

function normalizeKnowledgeEditorSections(item) {
  const sections = Array.isArray(item?.settingsSections)
    ? item.settingsSections.map((section, index) => ({
      title: String(section.title ?? "").trim() || knowledgeSectionTitleFromMarkdown(section.contentMarkdown ?? "", index),
      contentMarkdown: String(section.contentMarkdown ?? section.content ?? ""),
      summary: String(section.summary ?? ""),
      sortOrder: Number.isFinite(Number(section.sortOrder)) ? Number(section.sortOrder) : index
    }))
    : [];
  if (sections.length > 0) return sections;
  const legacy = String(item?.settingsMarkdown ?? (Array.isArray(item?.settings) ? item.settings.join("\n\n") : ""));
  return legacy.trim() ? [{ title: knowledgeSectionTitleFromMarkdown(legacy, 0), contentMarkdown: legacy, summary: "", sortOrder: 0 }] : [];
}

function knowledgeSectionPreviewText(section) {
  const content = String(section.contentMarkdown ?? "").replace(/!\[[^\]]*\]\([^)]*\)/gu, "图片").replace(/[`*_>#-]/gu, "").replace(/\s+/gu, " ").trim();
  return content ? `${content.slice(0, 180)}${content.length > 180 ? "…" : ""}` : "暂无正文内容";
}

function renderKnowledgeMarkdownSections() {
  const host = $("#knowledge-markdown-sections");
  if (!host) return;
  const label = knowledgeEditorKind === "race" ? "种族" : "组织";
  const canEdit = canEditModule(knowledgeEditorKind === "race" ? "races" : "organizations");
  const sections = Array.isArray(knowledgeEditorSections) ? knowledgeEditorSections : [];
  host.innerHTML = `<div class="knowledge-markdown-list-toolbar"><div><b>${label} Markdown 设定</b><span>将每条设定单独保存为章节，需要编辑时打开大编辑器。</span></div>${canEdit ? '<button type="button" class="ghost-button" data-knowledge-section-create>新建设定</button>' : ""}</div>${sections.length ? `<div class="knowledge-markdown-list">${sections.map((section, index) => `<article class="knowledge-markdown-section" data-knowledge-section-index="${index}"><header><div><span>设定 ${index + 1}</span><h4>${esc(section.title || `未命名设定 ${index + 1}`)}</h4>${section.summary ? `<p>${esc(section.summary)}</p>` : ""}</div><div>${canEdit ? `<button type="button" data-knowledge-section-edit="${index}">编辑</button><button type="button" data-knowledge-section-delete="${index}">删除</button>` : ""}</div></header><p class="knowledge-section-card-preview">${esc(knowledgeSectionPreviewText(section))}</p></article>`).join("")}</div>` : '<p class="knowledge-markdown-empty">还没有 Markdown 设定，点击“新建设定”开始记录。</p>'}`;
  host.querySelector("[data-knowledge-section-create]")?.addEventListener("click", () => void openKnowledgeSectionEditor());
  host.querySelectorAll("[data-knowledge-section-edit]").forEach((button) => button.addEventListener("click", () => void openKnowledgeSectionEditor(Number(button.dataset.knowledgeSectionEdit))));
  host.querySelectorAll("[data-knowledge-section-delete]").forEach((button) => button.addEventListener("click", async () => {
    const index = Number(button.dataset.knowledgeSectionDelete);
    const section = knowledgeEditorSections[index];
    if (!section || !(await confirmToast(
      `确定删除“${section.title || `设定 ${index + 1}`}”吗？`,
      { title: "删除设定", confirmLabel: "确认删除" }
    ))) return;
    knowledgeEditorSections.splice(index, 1);
    knowledgeEditorSections.forEach((item, sortOrder) => { item.sortOrder = sortOrder; });
    markEntityEditorDirty();
    renderKnowledgeMarkdownSections();
  }));
}

function bindDynamicListControls(container) {
  container.querySelectorAll("[data-item-list-add]").forEach((button) => button.addEventListener("click", () => {
    const rows = button.previousElementSibling;
    const row = document.createElement("div");
    row.className = "item-list-row";
    const input = document.createElement("input");
    input.name = rows.dataset.name;
    input.setAttribute("aria-label", rows.dataset.label || "列表项目");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.itemListRemove = "";
    remove.setAttribute("aria-label", "删除此条");
    remove.textContent = "删除";
    row.append(input, remove);
    rows.append(row);
    input.focus();
  }));
  container.querySelectorAll("[data-structured-list-add]").forEach((button) => button.addEventListener("click", () => {
    const rows = button.previousElementSibling;
    const row = rows.lastElementChild.cloneNode(true);
    row.querySelectorAll("input, textarea").forEach((control) => { control.value = ""; });
    rows.append(row);
    row.querySelector("input").focus();
  }));
  container.onclick = (event) => {
    const remove = event.target.closest("[data-item-list-remove], [data-structured-list-remove]");
    if (!remove) return;
    const row = remove.closest(".item-list-row, .structured-list-row");
    const rows = row.parentElement;
    if (rows.children.length === 1) row.querySelectorAll("input, textarea").forEach((control) => { control.value = ""; });
    else row.remove();
  };
}

function appendRelationshipKeywordChips(editor, values) {
  const input = editor.querySelector("[data-keyword-input]");
  if (!input) return;
  const existing = new Set([...editor.querySelectorAll("[data-keyword-value]")].map((control) => String(control.value).toLocaleLowerCase("zh-CN")));
  const name = editor.dataset.name || "keywords";
  for (const keyword of uniqueRelationshipKeywords(values)) {
    const key = keyword.toLocaleLowerCase("zh-CN");
    if (existing.has(key)) continue;
    existing.add(key);
    input.insertAdjacentHTML("beforebegin", `<span class="keyword-chip" data-keyword-chip><span>${esc(keyword)}</span><input type="hidden" name="${esc(name)}" value="${esc(keyword)}" data-keyword-value><button type="button" data-keyword-chip-remove aria-label="删除关键词：${esc(keyword)}">×</button></span>`);
  }
}

function commitRelationshipKeywordInput(editor) {
  const input = editor.querySelector("[data-keyword-input]");
  if (!input) return;
  appendRelationshipKeywordChips(editor, splitRelationshipKeywords(input.value));
  input.value = "";
}

function bindRelationshipKeywordControls(container) {
  container.querySelectorAll("[data-keyword-chips]").forEach((editor) => {
    const input = editor.querySelector("[data-keyword-input]");
    if (!input) return;
    input.addEventListener("keydown", (event) => {
      if (event.isComposing || event.key !== "Enter") return;
      event.preventDefault();
      commitRelationshipKeywordInput(editor);
    });
    input.addEventListener("input", () => {
      const { completed, remainder } = splitRelationshipKeywordInput(input.value);
      if (!completed.length) return;
      appendRelationshipKeywordChips(editor, completed);
      input.value = remainder;
    });
    editor.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-keyword-chip-remove]");
      if (!remove) return;
      remove.closest("[data-keyword-chip]")?.remove();
    });
  });
}

function commitRelationshipKeywordInputs(container) {
  container.querySelectorAll("[data-keyword-chips]").forEach(commitRelationshipKeywordInput);
}

function openDialog(title, fields, onSubmit, eyebrow = "新增", options = {}) {
  void discardPendingMarkdownAttachments();
  $("#dialog-title").textContent = title;
  $("#dialog-eyebrow").textContent = eyebrow;
  $("#dialog-fields").innerHTML = fields;
  $("#dialog-submit").textContent = options.submitLabel ?? "保存";
  $("#form-dialog").classList.toggle("wide-dialog", Boolean(options.wide));
  bindDynamicListControls($("#dialog-fields"));
  bindRelationshipKeywordControls($("#dialog-fields"));
  bindVditorEditors($("#dialog-fields"));
  const form = $("#dynamic-form");
  form.onsubmit = async (event) => {
    if (event.submitter?.value === "cancel") {
      void discardPendingMarkdownAttachments();
      return;
    }
    event.preventDefault();
    const submit = $("#dialog-submit");
    submit.disabled = true;
    try {
      commitRelationshipKeywordInputs(form);
      await onSubmit(new FormData(form));
      const markdown = [...form.querySelectorAll("[data-vditor-value]")].map((textarea) => textarea.value).join("\n\n");
      await cleanupPendingMarkdownAttachments(markdown);
      $("#form-dialog").close();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      submit.disabled = false;
    }
  };
  $("#form-dialog").showModal();
}

function openWorkDialog() {
  openDialog("创建作品",
    field("method", "创建方式", "select", "blank", [["blank", "从零新建"], ["import", "导入 TXT / DOCX 新建"]]) +
    field("title", "作品名称（导入时可留空）") + field("author", "作者") + field("description", "简介", "textarea"),
    async (form) => {
      const metadata = { title: String(form.get("title") ?? "").trim(), author: form.get("author"), description: form.get("description") };
      if (form.get("method") === "import") {
        state.pendingImportMeta = metadata;
        $("#new-import-file").click();
        return;
      }
      if (!metadata.title) throw new Error("从零新建时必须填写作品名称");
      const work = await api("/api/works", { method: "POST", body: metadata });
      toast("作品已创建");
      await loadWorks(work.id);
    }, "新的世界");
}

function workCoverFieldHtml(work) {
  return `<section class="work-cover-field" aria-labelledby="work-cover-title">
    <div class="work-cover-copy">
      <strong id="work-cover-title">封面</strong>
      <small>用于书架展示。支持 PNG、JPEG、WebP。</small>
    </div>
    <div class="work-cover-preview ${work.coverUrl ? "has-cover" : ""}" aria-hidden="${work.coverUrl ? "false" : "true"}">
      ${work.coverUrl ? `<img src="${esc(work.coverUrl)}" alt="${esc(work.title)} 封面预览">` : "<span>暂无封面</span>"}
    </div>
    <div class="work-cover-actions">
      <button id="work-cover-upload" class="ghost-button" type="button">${work.coverUrl ? "更换封面" : "设置封面"}</button>
      ${work.coverUrl ? '<button id="work-cover-remove" class="ghost-button" type="button">移除封面</button>' : ""}
    </div>
  </section>`;
}

function bindWorkCoverControls(work) {
  $("#work-cover-upload")?.addEventListener("click", () => {
    state.pendingCoverWorkId = work.id;
    $("#cover-file").click();
  });
  $("#work-cover-remove")?.addEventListener("click", async () => {
    try {
      await api(`/api/works/${work.id}/cover`, { method: "DELETE" });
      state.works = (await apiPage("/api/works")).items;
      const updated = state.works.find((item) => item.id === work.id) ?? { ...work, coverUrl: null };
      Object.assign(work, updated);
      const coverField = $("#dialog-fields")?.querySelector(".work-cover-field");
      if (coverField) {
        coverField.outerHTML = workCoverFieldHtml(work);
        bindWorkCoverControls(work);
      }
      renderShelf();
      toast("封面已移除");
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

function openWorkSettingsDialog(work) {
  if (!work) return;
  const canManageAccess = ["admin", "owner"].includes(String(work.accessRole));
  const isCurrentWork = state.work?.id === work.id;
  const canOpenImportHistory = isCurrentWork && canReplaceProse(work);
  const importHistoryAction = isCurrentWork
    ? canOpenImportHistory ? "查看导入历史" : "需要完整编辑权限"
    : "打开作品后可用";
  const accessField = `<section class="work-access-field" aria-labelledby="work-access-title">
    <div><strong id="work-access-title">成员权限</strong><small>选择成员后，可为每个作品模块单独设置无权限、只读或可编辑。</small><div class="work-access-options" aria-label="成员权限配置方式"><span>按成员配置</span><span>按模块授权</span><span>读写分离</span></div></div>
    ${canManageAccess ? '<button id="work-access-manage" class="ghost-button" type="button">配置成员权限</button>' : '<small>仅作品创建者或系统管理员可以调整访问权限。</small>'}
  </section>`;
  const importHistoryField = `<section class="work-access-field" aria-labelledby="import-history-settings-title">
    <div><strong id="import-history-settings-title">正文导入历史</strong><small>查看导入前快照并恢复被覆盖的分卷、章节标题和正文；大纲、伏笔等章节关联资料不在快照中。</small></div>
    <button id="import-history-button" class="ghost-button" type="button" aria-controls="import-history-dialog" aria-haspopup="dialog" ${canOpenImportHistory ? "" : "disabled"}>${importHistoryAction}</button>
  </section>`;
  openDialog("作品信息",
    workCoverFieldHtml(work) + field("title", "作品名称", "text", work.title) + field("author", "作者", "text", work.author) + field("description", "简介", "textarea", work.description) + accessField + importHistoryField,
    async (form) => {
      await api(`/api/works/${work.id}`, { method: "PATCH", body: { title: form.get("title"), author: form.get("author"), description: form.get("description") } });
      state.works = (await apiPage("/api/works")).items;
      const updated = state.works.find((item) => item.id === work.id);
      if (updated) Object.assign(work, updated);
      if (state.work?.id === work.id) {
        state.work.title = String(form.get("title") ?? state.work.title);
        state.work.author = String(form.get("author") ?? state.work.author);
        state.work.description = String(form.get("description") ?? state.work.description);
        if (updated?.coverUrl !== undefined) state.work.coverUrl = updated.coverUrl;
        updateDocumentTitle(state.work);
        $("#work-meta").textContent = `${state.work.title}${state.work.author ? ` · ${state.work.author}` : ""} · ${state.work.wordCount} 字`;
      }
      renderShelf();
      toast("作品信息已保存");
    }, "作品设置");
  bindWorkCoverControls(work);
  $("#import-history-button")?.addEventListener("click", () => {
    $("#form-dialog").close();
    void openImportHistory();
  });
  $("#work-access-manage")?.addEventListener("click", () => {
    $("#form-dialog").close();
    openMembersDialog(work);
  });
}

async function openChapterDialog(volumeId = null) {
  if (!state.work) return openWorkDialog();
  if (!canEditProse()) return toast("当前权限只能编辑设定资料，正文为只读", "error");
  if (!state.work.volumes.length) {
    await api(`/api/works/${state.work.id}/volumes`, { method: "POST", body: { title: "正文", kind: "main" } });
    state.work = await api(`/api/works/${state.work.id}`);
    renderTree();
  }
  const selectedVolumeId = state.work.volumes.some((volume) => volume.id === volumeId) ? volumeId : state.work.volumes[0].id;
  openDialog("新建章节", field("title", "章节标题") + field("volumeId", "所属卷", "select", selectedVolumeId, state.work.volumes.map((volume) => [volume.id, volume.title])) + field("chapterType", "章节类型", "select", "正文", chapterTypes.map((value) => [value, value])), async (form) => {
    const chapter = await api(`/api/works/${state.work.id}/chapters`, { method: "POST", body: { title: form.get("title"), volumeId: form.get("volumeId"), chapterType: form.get("chapterType"), content: "" } });
    state.work = await api(`/api/works/${state.work.id}`);
    await selectChapter(chapter.id);
  });
}

function openVolumeDialog(item) {
  if (!state.work) return openWorkDialog();
  if (!canEditProse()) return toast("当前权限只能编辑设定资料，不能修改分卷", "error");
  const kindOptions = [["main", "正文卷"], ["prequel", "前传"], ["extra", "番外"], ["epilogue", "后记"], ["appendix", "附录"]];
  openDialog(item ? "编辑分卷" : "新建分卷",
    field("title", "分卷名称", "text", item?.title) +
    field("kind", "分卷类型", "select", item?.kind ?? "main", kindOptions) +
    field("description", "分卷简介", "textarea", item?.description) +
    field("keywords", "分卷关键词", "keyword-chips", item?.keywords ?? []),
    async (form) => {
      const body = {
        title: form.get("title"),
        kind: form.get("kind"),
        description: form.get("description"),
        keywords: uniqueRelationshipKeywords(form.getAll("keywords").map(String))
      };
      await api(item ? `/api/volumes/${item.id}` : `/api/works/${state.work.id}/volumes`, { method: item ? "PATCH" : "POST", body });
      state.work = await api(`/api/works/${state.work.id}`);
      renderTree();
      toast(item ? "分卷设置已保存" : "分卷已创建");
    }, "分卷设置");
}

function openSettingEditor(item = null) {
  destroyVditorEditor(settingEditorVditor);
  settingEditorVditor = null;
  settingEditorItem = item;
  $("#setting-editor-eyebrow").textContent = item ? "人工修正" : "作者事实";
  $("#setting-editor-name").value = item?.title ?? "";
  $("#setting-editor-category").value = item?.category ?? "世界规则";
  $("#setting-editor-locked").checked = Boolean(item?.locked);
  $("#setting-editor-body").value = item?.content ?? "";
  $("#setting-change-note").value = "";
  $("#setting-change-note-field").classList.toggle("hidden", !item);
  $("#setting-editor-submit").textContent = item ? "保存新版本" : "创建设定";
  const viewOnly = !canEditModule("settings");
  $("#setting-editor-form").querySelectorAll("input, textarea").forEach((control) => { control.readOnly = viewOnly; });
  $("#setting-editor-form").querySelectorAll("select, input[type='checkbox']").forEach((control) => { control.disabled = viewOnly; });
  $("#setting-editor-submit").classList.toggle("hidden", viewOnly);
  $("#setting-editor-form").onsubmit = async (event) => {
    event.preventDefault();
    if (!canEditModule("settings")) return;
    const form = new FormData(event.currentTarget);
    const submit = $("#setting-editor-submit");
    submit.disabled = true;
    try {
      const title = String(form.get("title") ?? "").trim();
      if (!title) {
        toast("请填写设定标题", "error");
        $("#setting-editor-name").focus();
        return;
      }
      const content = String(form.get("content") ?? "");
      if (!content.trim()) {
        toast("请填写设定正文", "error");
        $("#setting-editor-body").focus();
        return;
      }
      const locked = form.get("locked") === "on";
      const body = {
        title,
        category: String(form.get("category") ?? "世界规则"),
        content,
        locked,
        status: locked ? "confirmed" : (item?.status ?? "draft"),
        ...(item ? { changeNote: String(form.get("changeNote") ?? "").trim() } : {})
      };
      await api(item ? `/api/settings/${item.id}` : `/api/works/${state.work.id}/settings`, { method: item ? "PATCH" : "POST", body });
      await cleanupPendingMarkdownAttachments(body.content);
      entityEditorDirty = false;
      await loadAiReferences();
      await closeEntityEditor({ force: true });
      toast(item ? "设定新版本已保存" : "设定已创建");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      submit.disabled = false;
    }
  };
  showEntityEditorPage("setting");
  settingEditorVditor = createVditorEditor($("#setting-editor-markdown"), item?.content ?? "", {
    onInput: (markdown) => { $("#setting-editor-body").value = markdown; markEntityEditorDirty(); },
    readOnly: viewOnly
  });
  $("#setting-editor-name").focus();
}

function characterEditorSection(key, title, description, content) {
  return `<section class="character-editor-section${key === "basic" ? "" : " hidden"}" data-character-editor-panel="${esc(key)}" role="tabpanel">
    <header><div><span class="eyebrow">${esc(title)}</span><h3>${esc(title)}</h3></div><p>${esc(description)}</p></header>
    <div class="character-editor-section-fields">${content}</div>
  </section>`;
}

function activateCharacterEditorTab(key) {
  document.querySelectorAll("[data-character-editor-tab]").forEach((button) => {
    const active = button.dataset.characterEditorTab === key;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll("[data-character-editor-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.characterEditorPanel !== key));
}

function setCharacterHistoryVisible(visible) {
  const panel = $("#character-history-panel");
  const workspace = panel.closest(".character-editor-workspace");
  panel.classList.toggle("hidden", !visible);
  workspace.classList.toggle("history-open", visible);
  $("#character-history-button").setAttribute("aria-expanded", String(visible));
}

const relationshipCategoryLabels = {
  family: "亲属",
  social: "社交",
  emotional: "情感",
  conflict: "冲突",
  uncertain: "未确定"
};

function renderCharacterEditorRelationships() {
  const host = $("#character-editor-relationships");
  if (!host) return;
  if (!characterEditorItem?.id) {
    host.innerHTML = '<div class="character-editor-empty-field"><b>人物关系</b><span>保存人物档案后即可添加与其他人物的关系。</span></div>';
    return;
  }
  if (characterEditorRelationshipsLoading) {
    host.innerHTML = '<p class="character-relationship-status">正在读取人物关系……</p>';
    return;
  }
  const characterId = String(characterEditorItem.id);
  const nameOf = (id) => state.characters.find((character) => character.id === id)?.name ?? "未知角色";
  const rows = characterEditorRelationships.map((relationship) => {
    const isSource = relationship.fromCharacterId === characterId;
    const otherCharacterId = isSource ? relationship.toCharacterId : relationship.fromCharacterId;
    const direction = relationship.directed ? (isSource ? "→" : "←") : "↔";
    const category = relationshipCategoryLabels[relationship.category] ?? relationship.category;
    const relationLabel = [category, relationship.subtype].filter(Boolean).join(" · ") || "未细分";
    const keywords = Array.isArray(relationship.keywords) ? relationship.keywords : [];
    return `<article class="character-relationship-row">
      <div class="character-relationship-heading"><div><strong>${esc(nameOf(otherCharacterId))}</strong><span>${direction} ${esc(relationLabel)}</span></div>${canEditModule("relationships") ? `<button type="button" data-character-relationship-edit="${esc(relationship.id)}">编辑关系</button>` : ""}</div>
      <div class="character-relationship-keywords"><small>关系关键词</small><div>${keywords.map((keyword) => `<span class="pill relationship-keyword">${esc(keyword)}</span>`).join("") || '<span class="character-relationship-empty-keywords">未填写关键词</span>'}</div></div>
    </article>`;
  }).join("");
  host.innerHTML = `<div class="character-relationship-toolbar"><p>与 ${esc(characterEditorItem.name)} 有关的其他人物及关系关键词。</p>${canEditModule("relationships") ? '<button type="button" class="ghost-button" data-character-relationship-create>新建关系</button>' : ""}</div>${rows || '<p class="character-relationship-status">暂未记录与其他人物的关系。</p>'}`;
  host.querySelectorAll("[data-character-relationship-edit]").forEach((button) => button.addEventListener("click", () => {
    const relationship = characterEditorRelationships.find((item) => item.id === button.dataset.characterRelationshipEdit);
    if (relationship) void openRelationshipDialog(relationship, { characterId });
  }));
  host.querySelector("[data-character-relationship-create]")?.addEventListener("click", () => void openRelationshipDialog(null, { characterId }));
}

async function loadCharacterEditorRelationships(characterId) {
  const workId = state.work?.id;
  if (!workId || characterEditorItem?.id !== characterId) return;
  characterEditorRelationshipsLoading = true;
  renderCharacterEditorRelationships();
  let loaded = false;
  try {
    const [characters, relationships] = await Promise.all([
      apiAllPages(`/api/works/${workId}/characters`),
      apiAllPages(`/api/works/${workId}/relationships`)
    ]);
    if (state.work?.id !== workId || characterEditorItem?.id !== characterId) return;
    state.characters = characters;
    characterEditorRelationships = relationships.filter((relationship) => relationship.fromCharacterId === characterId || relationship.toCharacterId === characterId);
    loaded = true;
  } catch (error) {
    if (state.work?.id === workId && characterEditorItem?.id === characterId) {
      $("#character-editor-relationships").innerHTML = `<p class="character-relationship-status">关系载入失败：${esc(error.message)}</p>`;
    }
  } finally {
    if (state.work?.id === workId && characterEditorItem?.id === characterId) {
      characterEditorRelationshipsLoading = false;
      if (loaded) renderCharacterEditorRelationships();
    }
  }
}

async function refreshRelationshipSurfaces(characterId = null) {
  const tasks = [];
  if (state.module === "relationships") tasks.push(renderRelationships());
  if (characterId && entityEditorType === "character" && !$("#entity-editor-view").classList.contains("hidden") && characterEditorItem?.id === characterId) {
    tasks.push(loadCharacterEditorRelationships(characterId));
  }
  await Promise.all(tasks);
}

const characterSectionTypeLabels = {
  overview: "基本档案",
  appearance: "外貌与生理",
  abilities: "能力与弱点",
  personality: "性格与行为",
  ecology: "生态",
  background: "背景故事",
  history: "经历记录",
  legends: "相关传说",
  research: "研究记录",
  notes: "作者备注",
  custom: "自定义章节"
};

async function discardPendingCharacterAttachments() {
  const pending = characterSectionPendingAttachments.splice(0);
  await Promise.all(pending.map(async (attachmentId) => {
    try { await api(`/api/attachments/${attachmentId}`, { method: "DELETE" }); } catch { /* 已被引用的附件由正常引用生命周期管理。 */ }
  }));
}

async function discardPendingMarkdownAttachments() {
  const pending = markdownEditorPendingAttachments.splice(0);
  await Promise.all(pending.map(async (attachmentId) => {
    try { await api(`/api/attachments/${attachmentId}`, { method: "DELETE" }); } catch { /* 已被引用的附件由正常引用生命周期管理。 */ }
  }));
}

async function cleanupPendingMarkdownAttachments(contentMarkdown) {
  const referenced = new Set([...String(contentMarkdown).matchAll(/attachment:\/\/([A-Za-z0-9_-]{1,300})/gu)].map((match) => String(match[1])));
  const pending = markdownEditorPendingAttachments.splice(0);
  await Promise.all(pending.filter((attachmentId) => !referenced.has(attachmentId)).map((attachmentId) => api(`/api/attachments/${attachmentId}`, { method: "DELETE" }).catch(() => null)));
}

function markdownImageLabel(file, fallback = "图片附件") {
  return String(file?.name ?? "").replace(/[\[\]\r\n]/gu, "").trim() || fallback;
}

async function uploadMarkdownAttachment(file) {
  const body = new FormData();
  body.append("file", file);
  const attachment = await api(`/api/works/${state.work.id}/attachments`, { method: "POST", body });
  if (!attachment.deduplicated) markdownEditorPendingAttachments.push(String(attachment.id));
  return { attachment, imageLabel: markdownImageLabel(file) };
}

function createVditorUploadHandler(uploadAttachment, getEditor) {
  return async (files) => {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    const insertions = [];
    for (const file of files) {
      try {
        const { attachment, imageLabel } = await uploadAttachment(file);
        insertions.push(`![${imageLabel}](attachment://${attachment.id})`);
      } catch (error) {
        toast(error.message, "error");
      }
    }
    const editor = getEditor();
    if (editor && insertions.length > 0) {
      if (range && editor.vditor?.element?.contains(range.startContainer)) {
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      editor.insertMD(insertions.join("\n\n"));
      normalizeVditorAttachmentImages(editor);
    }
    return null;
  };
}

function createVditorEditor(host, value, { onInput = () => {}, uploadAttachment = uploadMarkdownAttachment, placeholder = "", readOnly = false } = {}) {
  if (!window.Vditor) {
    toast("Markdown 编辑器资源加载失败，请刷新页面后重试", "error");
    return null;
  }
  ensureVditorIconScript();
  let editor = null;
  editor = new window.Vditor(host, {
    cdn: "/vendor/vditor",
    lang: "zh_CN",
    theme: currentColorTheme() === "dark" ? "dark" : "classic",
    mode: "ir",
    value: String(value ?? ""),
    height: "100%",
    minHeight: 260,
    placeholder,
    preview: { transform: transformVditorPreview },
    cache: { enable: false },
    toolbar: ["headings", "bold", "italic", "strike", "|", "line", "quote", "list", "ordered-list", "check", "|", "code", "inline-code", "link", "table", "upload", "|", "undo", "redo", "edit-mode", "fullscreen"],
    upload: {
      accept: "image/*",
      max: 10 * 1024 * 1024,
      multiple: true,
      handler: createVditorUploadHandler(uploadAttachment, () => editor)
    },
    input: (markdown) => {
      normalizeVditorAttachmentImages(editor);
      onInput(markdown);
    },
    after: () => {
      normalizeVditorAttachmentImages(editor);
      if (readOnly) editor?.disabled();
    }
  });
  const attachmentObserver = new MutationObserver(() => normalizeVditorAttachmentImages(editor));
  attachmentObserver.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
  editor.__attachmentObserver = attachmentObserver;
  host.__vditor = editor;
  if (readOnly) editor.disabled();
  return editor;
}

function transformVditorPreview(html) {
  return String(html ?? "").replace(/(<img\b[^>]*\bsrc\s*=\s*)(["'])attachment:\/\/([A-Za-z0-9_-]{1,300})\2/giu, (_match, prefix, quote, attachmentId) => `${prefix}${quote}/api/attachments/${encodeURIComponent(attachmentId)}/content${quote}`);
}

function normalizeVditorAttachmentImages(editor) {
  const root = editor?.vditor?.element;
  if (!root) return;
  root.querySelectorAll('img[src^="attachment://"]').forEach((image) => {
    const target = image.getAttribute("src")?.trim() ?? "";
    const attachment = target.match(/^attachment:\/\/([A-Za-z0-9_-]{1,300})$/u);
    if (attachment) image.setAttribute("src", `/api/attachments/${encodeURIComponent(attachment[1])}/content`);
  });
}

function ensureVditorIconScript() {
  if (document.getElementById("vditorIconScript")) return;
  const script = document.createElement("script");
  script.id = "vditorIconScript";
  script.src = "/vendor/vditor/dist/js/icons/ant.js?v=3.11.2";
  document.body.appendChild(script);
}

function destroyVditorEditor(editor) {
  if (!editor) return;
  editor.__attachmentObserver?.disconnect();
  const host = editor.vditor?.element;
  editor.destroy();
  if (host) delete host.__vditor;
}

function bindVditorEditors(container) {
  container.querySelectorAll("[data-vditor-editor]").forEach((host) => {
    const valueField = host.parentElement?.querySelector("[data-vditor-value]");
    const editor = createVditorEditor(host, valueField?.value ?? "", {
      onInput: (markdown) => {
        if (valueField) valueField.value = markdown;
        markEntityEditorDirty();
      },
      placeholder: "",
      readOnly: Boolean(valueField?.readOnly)
    });
  });
}

function characterSectionImageLabel(file, fallback = "图片附件") {
  return String(file?.name ?? "").replace(/[\[\]\r\n]/gu, "").trim() || fallback;
}

async function uploadCharacterSectionAttachment(file) {
  const body = new FormData();
  body.append("file", file);
  const attachment = await api(`/api/works/${state.work.id}/attachments`, { method: "POST", body });
  if (!attachment.deduplicated) characterSectionPendingAttachments.push(String(attachment.id));
  return {
    attachment,
    imageLabel: characterSectionImageLabel(file)
  };
}

async function closeCharacterSectionEditor({ force = false } = {}) {
  if (!force && characterSectionEditorDirty && !(await confirmToast(
    "当前 Markdown 章节有未保存修改，返回人物档案将丢弃这些修改。是否继续？",
    { title: "放弃未保存修改", confirmLabel: "放弃并继续", cancelLabel: "继续编辑" }
  ))) return false;
  destroyVditorEditor(characterSectionVditor);
  characterSectionVditor = null;
  await discardPendingCharacterAttachments();
  characterSectionEditorDirty = false;
  $("#character-section-editor-view").classList.add("hidden");
  $("#character-editor-form").classList.remove("hidden");
  $("#character-section-editor-host").innerHTML = "";
  replacePageRoute(currentPageRoute());
  return true;
}

function knowledgeSectionEditorHtml(section = null) {
  const label = knowledgeEditorKind === "race" ? "种族" : "组织";
  return `<div class="character-section-editor-shell knowledge-section-editor-shell">
    <header class="character-section-editor-header">
      <div><span class="eyebrow">${label} Markdown 设定</span><h2 id="knowledge-section-editor-title">${section ? `编辑“${esc(section.title)}”` : "新建设定"}</h2></div>
      <button class="entity-editor-back" type="button" data-knowledge-section-edit-close>返回设定列表</button>
    </header>
    <section class="character-markdown-editor" aria-label="${section ? "编辑" : "新建"}${label} Markdown 设定">
      <div class="character-markdown-editor-meta">
        <label>设定标题<input id="knowledge-section-title" maxlength="200" value="${esc(section?.title ?? "")}" placeholder="例如：组织章程、种族特征" required></label>
      </div>
      <div id="knowledge-section-markdown" class="vditor-editor-host" data-vditor-editor aria-label="Markdown 编辑器"></div>
      <div class="character-markdown-editor-footer">
        <div class="character-markdown-editor-actions"><button type="button" data-knowledge-section-edit-cancel>取消</button><button type="button" class="primary-button" data-knowledge-section-edit-save>${section ? "保存设定" : "添加设定"}</button></div>
      </div>
    </section>
  </div>`;
}

async function closeKnowledgeSectionEditor({ force = false } = {}) {
  if (!force && knowledgeSectionEditorDirty && !(await confirmToast(
    "当前 Markdown 设定有未保存修改，返回设定列表将丢弃这些修改。是否继续？",
    { title: "放弃未保存修改", confirmLabel: "放弃并继续", cancelLabel: "继续编辑" }
  ))) return false;
  destroyVditorEditor(knowledgeSectionVditor);
  knowledgeSectionVditor = null;
  knowledgeSectionEditorDirty = false;
  knowledgeSectionEditorIndex = null;
  $("#knowledge-section-editor-view").classList.add("hidden");
  $("#knowledge-editor-form").classList.remove("hidden");
  $("#knowledge-section-editor-host").innerHTML = "";
  renderKnowledgeMarkdownSections();
  replacePageRoute(currentPageRoute());
  return true;
}

async function openKnowledgeSectionEditor(index = null) {
  if (!canEditModule(knowledgeEditorKind === "race" ? "races" : "organizations")) return;
  destroyVditorEditor(knowledgeSectionVditor);
  knowledgeSectionVditor = null;
  const section = Number.isInteger(index) ? knowledgeEditorSections[index] : null;
  if (Number.isInteger(index) && !section) return;
  knowledgeSectionEditorIndex = Number.isInteger(index) ? index : null;
  knowledgeSectionEditorDirty = false;
  const host = $("#knowledge-section-editor-host");
  host.innerHTML = knowledgeSectionEditorHtml(section);
  $("#knowledge-editor-form").classList.add("hidden");
  $("#knowledge-section-editor-view").classList.remove("hidden");
  const titleInput = $("#knowledge-section-title");
  host.querySelectorAll("input, textarea").forEach((control) => control.addEventListener("input", () => { knowledgeSectionEditorDirty = true; }));
  knowledgeSectionVditor = createVditorEditor($("#knowledge-section-markdown"), section?.contentMarkdown ?? "", {
    onInput: () => { knowledgeSectionEditorDirty = true; }
  });
  host.querySelector("[data-knowledge-section-edit-close]").addEventListener("click", () => void closeKnowledgeSectionEditor());
  host.querySelector("[data-knowledge-section-edit-cancel]").addEventListener("click", () => void closeKnowledgeSectionEditor());
  host.querySelector("[data-knowledge-section-edit-save]").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const wasEditing = knowledgeSectionEditorIndex !== null;
    const title = titleInput.value.trim();
    if (!title) {
      toast("请填写设定标题", "error");
      titleInput.focus();
      return;
    }
    button.disabled = true;
    const nextSection = { title, contentMarkdown: knowledgeSectionVditor?.getValue() ?? "", summary: String(section?.summary ?? ""), sortOrder: knowledgeSectionEditorIndex ?? knowledgeEditorSections.length };
    if (knowledgeSectionEditorIndex === null) knowledgeEditorSections.push(nextSection);
    else knowledgeEditorSections[knowledgeSectionEditorIndex] = nextSection;
    knowledgeEditorSections.forEach((item, sortOrder) => { item.sortOrder = sortOrder; });
    markEntityEditorDirty();
    await closeKnowledgeSectionEditor({ force: true });
    toast(wasEditing ? "设定已更新" : "设定已添加");
  });
  titleInput.focus();
}

function characterSectionEditorHtml(section = null) {
  const options = Object.entries(characterSectionTypeLabels).map(([value, label]) => `<option value="${value}" ${section?.sectionType === value ? "selected" : ""}>${esc(label)}</option>`).join("");
  return `<div class="character-section-editor-shell">
    <header class="character-section-editor-header">
      <div><span class="eyebrow">人物 Markdown 档案</span><h2 id="character-section-editor-title">${section ? `编辑“${esc(section.title)}”` : "新建档案章节"}</h2></div>
      <button class="entity-editor-back" type="button" data-character-section-edit-close>返回人物档案</button>
    </header>
    <section class="character-markdown-editor" aria-label="${section ? "编辑" : "新建"}人物 Markdown 章节">
    <div class="character-markdown-editor-meta">
      <label>章节类型<select id="character-section-type">${options}</select></label>
      <label>章节标题<input id="character-section-title" maxlength="200" value="${esc(section?.title ?? "")}" placeholder="例如：背景故事" required></label>
      <label class="character-markdown-summary-field">章节摘要<textarea id="character-section-summary" maxlength="20000" placeholder="用于角色列表和 AI 快速定位，不会替代正文">${esc(section?.summary ?? "")}</textarea></label>
    </div>
    <div id="character-section-markdown" class="vditor-editor-host" data-vditor-editor aria-label="Markdown 编辑器"></div>
    <div class="character-markdown-editor-footer">
      <label class="character-markdown-change-note">版本说明<input id="character-section-change-note" maxlength="500" placeholder="可选，例如：补充远古时期经历"></label>
      <div class="character-markdown-editor-actions"><button type="button" data-character-section-edit-cancel>取消</button><button type="button" class="primary-button" data-character-section-edit-save>${section ? "保存章节版本" : "创建章节"}</button></div>
    </div>
    </section>
  </div>`;
}

async function openCharacterSectionEditor(section = null) {
  await discardPendingCharacterAttachments();
  destroyVditorEditor(characterSectionVditor);
  characterSectionVditor = null;
  const host = $("#character-section-editor-host");
  host.innerHTML = characterSectionEditorHtml(section);
  characterSectionEditorDirty = false;
  $("#character-editor-form").classList.add("hidden");
  $("#character-section-editor-view").classList.remove("hidden");
  host.querySelectorAll("input, textarea, select").forEach((control) => control.addEventListener("input", () => { characterSectionEditorDirty = true; }));
  characterSectionVditor = createVditorEditor($("#character-section-markdown"), section?.contentMarkdown ?? "", {
    uploadAttachment: uploadCharacterSectionAttachment,
    onInput: () => { characterSectionEditorDirty = true; }
  });
  host.querySelector("[data-character-section-edit-close]").addEventListener("click", () => void closeCharacterSectionEditor());
  host.querySelector("[data-character-section-edit-cancel]").addEventListener("click", () => void closeCharacterSectionEditor());
  host.querySelector("[data-character-section-edit-save]").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const title = $("#character-section-title").value.trim();
    if (!title) {
      toast("请填写章节标题", "error");
      $("#character-section-title").focus();
      return;
    }
    button.disabled = true;
    const contentMarkdown = characterSectionVditor?.getValue() ?? "";
    try {
      const saved = await api(section ? `/api/character-sections/${section.id}` : `/api/characters/${characterEditorItem.id}/sections`, {
        method: section ? "PATCH" : "POST",
        body: {
          sectionType: $("#character-section-type").value,
          title,
          summary: $("#character-section-summary").value.trim(),
          contentMarkdown,
          ...(section ? { changeNote: $("#character-section-change-note").value.trim() } : {})
        }
      });
      const referenced = new Set([...contentMarkdown.matchAll(/attachment:\/\/([A-Za-z0-9_-]+)/gu)].map((match) => String(match[1])));
      const unused = characterSectionPendingAttachments.filter((attachmentId) => !referenced.has(attachmentId));
      characterSectionPendingAttachments = [];
      await Promise.all(unused.map((attachmentId) => api(`/api/attachments/${attachmentId}`, { method: "DELETE" }).catch(() => null)));
      characterEditorSections = await api(`/api/characters/${characterEditorItem.id}/sections`);
      renderCharacterMarkdownSections();
      await Promise.all([renderCharacters(), loadAiReferences()]);
      characterSectionEditorDirty = false;
      await closeCharacterSectionEditor({ force: true });
      toast(section ? `“${saved.title}”已保存为 v${saved.versionNo}` : `已创建“${saved.title}”`);
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
    }
  });
}

async function showCharacterSectionVersions(sectionId) {
  const host = document.querySelector(`[data-character-section-versions-host="${CSS.escape(sectionId)}"]`);
  if (!host) return;
  host.innerHTML = '<p class="character-markdown-status">正在读取章节版本……</p>';
  try {
    const versions = await api(`/api/character-sections/${sectionId}/versions`);
    host.innerHTML = `<div class="character-markdown-version-list">${versions.map((version) => `<article><div><strong>v${version.versionNo}</strong><time>${esc(formatDateTime(version.createdAt))}</time></div><p>${esc(version.changeNote || "未填写版本说明")}</p>${version.versionNo === characterEditorSections.find((item) => item.id === sectionId)?.versionNo ? '<button type="button" disabled>当前版本</button>' : `<button type="button" data-character-section-restore="${version.versionNo}">恢复此版本</button>`}</article>`).join("")}</div>`;
    host.querySelectorAll("[data-character-section-restore]").forEach((button) => button.addEventListener("click", async () => {
      button.disabled = true;
      try {
      await api(`/api/character-sections/${sectionId}/restore`, { method: "POST", body: { versionNo: Number(button.dataset.characterSectionRestore) } });
        characterEditorSections = await api(`/api/characters/${characterEditorItem.id}/sections`);
        renderCharacterMarkdownSections();
        await Promise.all([renderCharacters(), loadAiReferences()]);
        toast("人物 Markdown 章节已恢复");
      } catch (error) {
        button.disabled = false;
        toast(error.message, "error");
      }
    }));
  } catch (error) {
    host.innerHTML = `<p class="character-markdown-status">版本载入失败：${esc(error.message)}</p>`;
  }
}

function renderCharacterMarkdownSections() {
  const host = $("#character-markdown-sections");
  if (!host) return;
  if (!characterEditorItem?.id) {
    host.innerHTML = '<div class="character-editor-empty-field"><b>Markdown 档案章节</b><span>创建人物档案后即可添加背景故事、能力、经历和研究记录。</span></div>';
    return;
  }
  const toolbar = `<div class="character-markdown-list-toolbar"><div><b>Markdown 档案章节</b><span>长篇内容独立保存、渲染、检索和版本管理。</span></div>${canEditModule("characters") ? '<button type="button" class="primary-button" data-character-section-create>新建章节</button>' : ""}</div>`;
  const sections = characterEditorSections.map((section) => `<article class="character-markdown-section">
    <header><div><span>${esc(characterSectionTypeLabels[section.sectionType] ?? section.sectionType)}</span><h4>${esc(section.title)}</h4>${section.summary ? `<p>${esc(section.summary)}</p>` : ""}</div><div>${canEditModule("characters") ? `<button type="button" data-character-section-edit="${esc(section.id)}">编辑</button>` : ""}<button type="button" data-character-section-versions="${esc(section.id)}">版本</button>${canEditModule("characters") ? `<button type="button" data-character-section-delete="${esc(section.id)}">删除</button>` : ""}</div></header>
    <div class="character-markdown-document message-body">${renderMarkdown(section.contentMarkdown) || '<p class="character-markdown-empty">本章节暂无正文。</p>'}</div>
    <div data-character-section-versions-host="${esc(section.id)}"></div>
  </article>`).join("");
  host.innerHTML = `${toolbar}${sections || '<p class="character-markdown-status">还没有 Markdown 档案章节。</p>'}`;
  host.querySelector("[data-character-section-create]")?.addEventListener("click", () => void openCharacterSectionEditor());
  host.querySelectorAll("[data-character-section-edit]").forEach((button) => button.addEventListener("click", () => {
    const section = characterEditorSections.find((item) => item.id === button.dataset.characterSectionEdit);
    if (section) void openCharacterSectionEditor(section);
  }));
  host.querySelectorAll("[data-character-section-versions]").forEach((button) => button.addEventListener("click", () => void showCharacterSectionVersions(button.dataset.characterSectionVersions)));
  host.querySelectorAll("[data-character-section-delete]").forEach((button) => button.addEventListener("click", async () => {
    if (button.dataset.confirmed !== "true") {
      button.dataset.confirmed = "true";
      button.textContent = "确认删除";
      window.setTimeout(() => {
        if (button.isConnected && button.dataset.confirmed === "true") {
          button.dataset.confirmed = "false";
          button.textContent = "删除";
        }
      }, 5000);
      return;
    }
    button.disabled = true;
    try {
      await api(`/api/character-sections/${button.dataset.characterSectionDelete}`, { method: "DELETE" });
      characterEditorSections = await api(`/api/characters/${characterEditorItem.id}/sections`);
      renderCharacterMarkdownSections();
      await Promise.all([renderCharacters(), loadAiReferences()]);
      toast("人物 Markdown 章节已删除");
    } catch (error) {
      button.disabled = false;
      toast(error.message, "error");
    }
  }));
}

async function loadCharacterMarkdownSections(characterId) {
  characterEditorSections = [];
  renderCharacterMarkdownSections();
  try {
    characterEditorSections = await api(`/api/characters/${characterId}/sections`);
    if (characterEditorItem?.id === characterId) renderCharacterMarkdownSections();
  } catch (error) {
    const host = $("#character-markdown-sections");
    if (host && characterEditorItem?.id === characterId) host.innerHTML = `<p class="character-markdown-status">章节载入失败：${esc(error.message)}</p>`;
  }
}

function renderCharacterEditorFields(item) {
  const raceOptions = [["", "未指定"], ...state.races.map((race) => [race.id, racePathLabel(race)])];
  const organizationOptions = state.organizations.map((organization) => [organization.id, organization.name]);
  const chapterOptions = [["", "未指定"], ...(state.work?.volumes ?? []).flatMap((volume) => volume.chapters.map((chapter) => [chapter.id, `${volume.title} / ${chapter.title}`]))];
  const stateEntries = characterStateEntries(item?.currentState ?? {});
  $("#character-editor-fields").innerHTML = [
    characterEditorSection("basic", "基础资料", "用于检索、去重和建立人物在作品中的基本归属。",
      field("name", "标准名", "text", item?.name) +
      field("aliases", "别名", "item-list", item?.aliases ?? []) +
      (!canReadModule("races")
        ? '<div class="character-editor-empty-field"><b>种族</b><span>当前账户没有种族模块读取权限，原有绑定不会被修改。</span></div>'
        : state.races.length
        ? field("raceId", "种族", "select", item?.raceId ?? "", raceOptions)
        : '<div class="character-editor-empty-field"><b>种族</b><span>尚未创建种族，请先在“种族”模块建立档案。</span></div>') +
      (!canReadModule("organizations")
        ? '<div class="character-editor-empty-field"><b>所属组织</b><span>当前账户没有组织模块读取权限，原有绑定不会被修改。</span></div>'
        : organizationOptions.length
        ? field("organizationIds", "所属组织（可多选）", "chips", item?.organizationIds ?? [], organizationOptions)
        : '<div class="character-editor-empty-field"><b>所属组织</b><span>尚未创建组织，可稍后在“组织”模块中补充。</span></div>') +
      field("visibility", "可见范围", "select", item?.visibility ?? "author", [["author", "仅作者"], ["collaborators", "协作者"], ["public", "公开"]]) +
      (canReadModule("editor")
        ? field("firstChapterId", "首次登场章节", "select", item?.firstChapterId ?? "", chapterOptions)
        : '<div class="character-editor-empty-field"><b>首次登场章节</b><span>当前账户没有正文读取权限，原有绑定不会被修改。</span></div>')),
    characterEditorSection("profile", "人物档案", "记录人物定位、行为动力和便于创作时快速理解的简介。",
      field("identity", "身份与定位", "text", item?.attributes?.identity) +
      field("motivation", "核心动机", "textarea", item?.profile?.motivation) +
      field("summary", "人物简介", "textarea", item?.profile?.summary)),
    characterEditorSection("settings", "扩展设定", "可用短属性和 Markdown 长章节承载形态、能力、生态、经历与研究记录。",
      field("details", "扩展属性", "key-value-list", item?.attributes?.details) +
      '<div id="character-markdown-sections" class="character-markdown-sections"></div>'),
    characterEditorSection("state", "状态与约束", "维护任意当前状态，并明确禁止 AI 自行覆盖的字段。",
      field("currentState", "当前状态", "key-value-list", stateEntries, {
        keyName: "stateKey",
        valueName: "stateValue",
        keyPlaceholder: "状态字段，如 location",
        valuePlaceholder: "当前值，如 地球",
        keyAriaLabel: "状态字段名称",
        valueAriaLabel: "状态字段内容",
        removeLabel: "删除此状态字段",
        addLabel: "添加状态"
      }) +
      '<p class="character-editor-field-help">未修改的数字、布尔值、数组和对象会保留原有数据类型；被修改的值会按文本保存。</p>' +
      field("lockedFields", "锁定字段", "item-list", item?.lockedFields ?? [])),
    characterEditorSection("relationships", "人物关系", "查看与其他人物的关系及关键词；编辑入口与“关系”面板共用同一份关系数据。",
      '<div id="character-editor-relationships" class="character-editor-relationships-field"></div>')
  ].join("");
  const name = $("#character-editor-fields [name='name']");
  if (name) name.required = true;
  bindDynamicListControls($("#character-editor-fields"));
  renderCharacterEditorRelationships();
  renderCharacterMarkdownSections();
  activateCharacterEditorTab("basic");
}

function collectCharacterBody(form) {
  const item = characterEditorItem;
  const profile = { ...(item?.profile ?? {}) };
  delete profile.sections;
  const body = {
    name: String(form.get("name") ?? "").trim(),
    aliases: form.getAll("aliases").map((value) => String(value).trim()).filter(Boolean),
    attributes: {
      ...(item?.attributes ?? {}),
      identity: String(form.get("identity") ?? "").trim(),
      details: buildCharacterDetails(form.getAll("detailLabel"), form.getAll("detailValue"))
    },
    profile: {
      ...profile,
      motivation: String(form.get("motivation") ?? "").trim(),
      summary: String(form.get("summary") ?? "").trim()
    },
    currentState: buildCharacterState(form.getAll("stateKey"), form.getAll("stateValue"), item?.currentState ?? {}),
    lockedFields: form.getAll("lockedFields").map((value) => String(value).trim()).filter(Boolean),
    visibility: String(form.get("visibility") ?? "author"),
    changeNote: String(form.get("changeNote") ?? "").trim()
  };
  if (canReadModule("races")) body.raceId = form.get("raceId") || null;
  if (canReadModule("organizations")) body.organizationIds = form.getAll("organizationIds").map(String);
  if (canReadModule("editor")) body.firstChapterId = form.get("firstChapterId") || null;
  return body;
}

function renderCharacterHistory() {
  const host = $("#character-history-list");
  if (!characterEditorVersions.length) {
    host.innerHTML = '<p class="character-history-empty">还没有可用的历史版本。</p>';
    return;
  }
  host.innerHTML = characterEditorVersions.map((version, index) => {
    const previous = characterEditorVersions[index + 1];
    const changes = describeCharacterVersionChanges(version.snapshot, previous?.snapshot);
    const isCurrent = version.versionNo === characterEditorItem?.versionNo;
    return `<article class="character-version-card${isCurrent ? " is-current" : ""}" data-character-version="${version.versionNo}">
      <div class="character-version-card-heading"><div><strong>v${version.versionNo}</strong><span>${esc(characterVersionSourceLabel(version.source))}</span></div><time>${esc(formatDateTime(version.createdAt))} · ${esc(version.actor || "历史数据")}</time></div>
      <p>${esc(version.changeNote || "未填写版本说明")}</p>
      <div class="character-version-changes">${changes.map((change) => `<span>${esc(change)}</span>`).join("")}</div>
      ${isCurrent ? '<button type="button" disabled>当前版本</button>' : `<button type="button" data-character-restore="${version.versionNo}">回滚到此版本</button>`}
    </article>`;
  }).join("");
  host.querySelectorAll("[data-character-restore]").forEach((button) => button.addEventListener("click", async () => {
    const versionNo = Number(button.dataset.characterRestore);
    if (button.dataset.confirmed !== "true") {
      host.querySelectorAll("[data-character-restore]").forEach((other) => {
        other.dataset.confirmed = "false";
        other.classList.remove("is-confirming");
        other.textContent = "回滚到此版本";
      });
      button.dataset.confirmed = "true";
      button.classList.add("is-confirming");
      button.textContent = `确认回滚至 v${versionNo}`;
      window.setTimeout(() => {
        if (!button.isConnected || button.dataset.confirmed !== "true") return;
        button.dataset.confirmed = "false";
        button.classList.remove("is-confirming");
        button.textContent = "回滚到此版本";
      }, 5000);
      return;
    }
    button.disabled = true;
    try {
      const restored = await api(`/api/characters/${characterEditorItem.id}/restore`, { method: "POST", body: { versionNo } });
      characterEditorItem = restored;
      renderCharacterEditorFields(restored);
      $("#character-editor-title").textContent = restored.name;
      $("#character-editor-version").textContent = `v${restored.versionNo}`;
      $("#character-change-note").value = "";
      await Promise.all([renderCharacters(), loadAiReferences()]);
      await showCharacterHistory();
      toast(`已回滚至 v${versionNo}，并生成 v${restored.versionNo}`);
    } catch (error) {
      button.disabled = false;
      toast(error.message, "error");
    }
  }));
}

async function showCharacterHistory() {
  if (!characterEditorItem?.id) return;
  setCharacterHistoryVisible(true);
  $("#character-history-list").innerHTML = '<p class="character-history-empty">正在读取版本历史…</p>';
  try {
    characterEditorVersions = await api(`/api/characters/${characterEditorItem.id}/versions`);
    renderCharacterHistory();
  } catch (error) {
    setCharacterHistoryVisible(false);
    toast(error.message, "error");
  }
}

async function openCharacterEditor(item = null) {
  [state.races, state.organizations] = await Promise.all([
    canReadModule("races") ? apiAllPages(`/api/works/${state.work.id}/races`) : Promise.resolve([]),
    canReadModule("organizations") ? apiAllPages(`/api/works/${state.work.id}/organizations`) : Promise.resolve([])
  ]);
  characterEditorItem = item ?? null;
  characterEditorVersions = [];
  characterEditorRelationships = [];
  characterEditorRelationshipsLoading = Boolean(item);
  characterEditorSections = [];
  $("#character-editor-eyebrow").textContent = item ? "人物主档案" : "建立人物档案";
  $("#character-editor-title").textContent = item?.name || "新建角色";
  $("#character-editor-version").textContent = item ? `v${item.versionNo}` : "新档案";
  $("#character-change-note").value = "";
  $("#character-editor-submit").textContent = item ? "保存新版本" : "创建人物档案";
  $("#character-history-button").disabled = !item;
  $("#character-history-button").title = item ? "查看、比较和回滚历史版本" : "创建人物档案后即可查看版本历史";
  setCharacterHistoryVisible(false);
  renderCharacterEditorFields(item);
  const viewOnly = !canEditModule("characters");
  if (viewOnly) {
    $("#character-editor-eyebrow").textContent = "人物档案";
    $("#character-editor-fields").querySelectorAll("input, textarea").forEach((control) => { control.readOnly = true; });
    $("#character-editor-fields").querySelectorAll("select, input[type='checkbox']").forEach((control) => { control.disabled = true; });
  }
  $("#character-change-note").readOnly = viewOnly;
  $("#character-editor-submit").classList.toggle("hidden", viewOnly);
  document.querySelectorAll("[data-character-editor-tab]").forEach((button) => {
    button.onclick = () => activateCharacterEditorTab(button.dataset.characterEditorTab);
  });
  const relationshipTab = document.querySelector("[data-character-editor-tab='relationships']");
  relationshipTab.disabled = !item || !canReadModule("relationships");
  relationshipTab.title = !canReadModule("relationships") ? "当前账户没有关系模块读取权限" : item ? "查看和编辑人物关系" : "创建人物档案后即可维护人物关系";
  const form = $("#character-editor-form");
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!canEditModule("characters")) return;
    const submit = $("#character-editor-submit");
    submit.disabled = true;
    try {
      const body = collectCharacterBody(new FormData(form));
      if (!body.name) throw new Error("请填写角色标准名");
      const wasEditing = Boolean(characterEditorItem);
      const previousVersion = characterEditorItem?.versionNo;
      if (!wasEditing) delete body.changeNote;
      const saved = await api(wasEditing ? `/api/characters/${characterEditorItem.id}` : `/api/works/${state.work.id}/characters`, { method: wasEditing ? "PATCH" : "POST", body });
      entityEditorDirty = false;
      await loadAiReferences();
      await closeEntityEditor({ force: true });
      toast(!wasEditing ? "人物档案已创建" : saved.versionNo === previousVersion ? "没有检测到人物档案变更" : `人物档案已保存为 v${saved.versionNo}`);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      submit.disabled = false;
    }
  };
  showEntityEditorPage("character");
  if (item) {
    if (canReadModule("relationships")) void loadCharacterEditorRelationships(item.id);
    void loadCharacterMarkdownSections(item.id);
  }
}

function knowledgeEditorSection(key, title, description, content) {
  return `<section class="character-editor-section${key === "basic" ? "" : " hidden"}" data-knowledge-editor-panel="${esc(key)}" role="tabpanel"><header><div><span class="eyebrow">${esc(title)}</span><h3>${esc(title)}</h3></div>${description ? `<p>${esc(description)}</p>` : ""}</header><div class="character-editor-section-fields">${content}</div></section>`;
}

function activateKnowledgeEditorTab(key) {
  document.querySelectorAll("[data-knowledge-editor-tab]").forEach((button) => {
    const active = button.dataset.knowledgeEditorTab === key;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll("[data-knowledge-editor-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.knowledgeEditorPanel !== key));
}

function renderKnowledgeEditorFields(kind, item, memberOptions, parentOptions) {
  const isRace = kind === "race";
  const label = isRace ? "种族" : "组织";
  const title = isRace ? "种族共同设定" : "组织设定";
  const tabs = isRace
    ? [["basic", "基础资料", "名称、层级与简介"], ["settings", "共同设定", "Markdown 设定章节"], ["members", "种族成员", "角色归属"]]
    : [["basic", "基础资料", "名称与简介"], ["settings", "组织设定", "Markdown 设定章节"], ["members", "组织成员", "角色归属"]];
  $("#knowledge-editor-nav").innerHTML = tabs.map(([key, tabTitle, description], index) => `<button type="button" role="tab" data-knowledge-editor-tab="${key}" aria-selected="${index === 0}" tabindex="${index === 0 ? "0" : "-1"}">${tabTitle}<small>${description}</small></button>`).join("");
  const basicFields = field("name", `${label}名称`, "text", item?.name, []) + (isRace ? field("parentRaceId", "父种族", "select", item?.parentRaceId ?? "", parentOptions) : "") + field("description", `${label}简介`, "textarea", item?.description, []);
  const memberField = memberOptions.length
    ? field("memberIds", isRace ? "属于该种族的角色（可多选）" : "组织成员（可多选）", "chips", item?.memberIds ?? [], memberOptions)
    : `<div class="character-editor-empty-field"><strong>${isRace ? "种族成员" : "组织成员"}</strong><span>当前还没有可绑定的角色。</span></div>`;
  $("#knowledge-editor-fields").innerHTML = knowledgeEditorSection("basic", "基础资料", isRace ? "先定义名称、层级和简介，再补充共同设定。" : "先定义组织名称和简介，再补充完整的组织设定。", basicFields)
    + knowledgeEditorSection("settings", title, "", '<div id="knowledge-markdown-sections" class="knowledge-markdown-sections"></div>')
    + knowledgeEditorSection("members", isRace ? "种族成员" : "组织成员", "成员关系会同步到角色档案中。", memberField);
  document.querySelectorAll("[data-knowledge-editor-tab]").forEach((button) => {
    button.onclick = () => activateKnowledgeEditorTab(button.dataset.knowledgeEditorTab);
  });
  renderKnowledgeMarkdownSections();
  activateKnowledgeEditorTab("basic");
}

async function openKnowledgeEditor(kind, item) {
  await discardPendingMarkdownAttachments();
  state.characters = canReadModule("characters") ? await apiAllPages(`/api/works/${state.work.id}/characters`) : [];
  const memberOptions = state.characters.map((character) => [character.id, `${character.name}${character.aliases.length ? `（${character.aliases.join("、")}）` : ""}`]);
  const isRace = kind === "race";
  const module = isRace ? "races" : "organizations";
  const label = isRace ? "种族" : "组织";
  const parentOptions = isRace
    ? [["", "无（根种族）"], ...eligibleRaceParents(state.races, item?.id)
      .sort((left, right) => racePathLabel(left).localeCompare(racePathLabel(right), "zh-CN"))
      .map((race) => [race.id, racePathLabel(race)])]
    : [];
  knowledgeEditorItem = item ?? null;
  knowledgeEditorKind = kind;
  knowledgeEditorSections = normalizeKnowledgeEditorSections(item);
  knowledgeSectionEditorIndex = null;
  knowledgeSectionEditorDirty = false;
  $("#knowledge-editor-eyebrow").textContent = item ? `${label}档案` : `建立${label}档案`;
  $("#knowledge-editor-title").textContent = item?.name || `新建${label}`;
  $("#knowledge-editor-version").textContent = item ? `v${item.versionNo ?? 1}` : "新档案";
  $("#knowledge-editor-header-note").textContent = isRace ? "层级、共同设定与角色归属" : "简介、组织设定与成员归属";
  $("#knowledge-editor-footer-note").textContent = `保存${label}档案后返回${isRace ? "种族" : "组织"}列表。`;
  $("#knowledge-editor-submit").textContent = item ? `保存${label}档案` : `创建${label}档案`;
  renderKnowledgeEditorFields(kind, item, memberOptions, parentOptions);
  const viewOnly = !canEditModule(module);
  if (viewOnly) {
    $("#knowledge-editor-eyebrow").textContent = `${label}档案`;
    $("#knowledge-editor-fields").querySelectorAll("input, textarea").forEach((control) => { control.readOnly = true; });
    $("#knowledge-editor-fields").querySelectorAll("select, input[type='checkbox']").forEach((control) => { control.disabled = true; });
  }
  $("#knowledge-editor-submit").classList.toggle("hidden", viewOnly);
  const form = $("#knowledge-editor-form");
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!canEditModule(module)) return;
    const submit = $("#knowledge-editor-submit");
    submit.disabled = true;
    try {
      const data = new FormData(form);
      const name = String(data.get("name") ?? "").trim();
      if (!name) throw new Error(`请填写${label}名称`);
      const settingsSections = knowledgeEditorSections
        .map((section, index) => ({ title: String(section.title ?? "").trim(), contentMarkdown: String(section.contentMarkdown ?? ""), summary: String(section.summary ?? "").trim(), sortOrder: index }))
        .filter((section) => section.title || section.contentMarkdown.trim());
      const untitled = settingsSections.findIndex((section) => !section.title);
      if (untitled >= 0) throw new Error(`请填写第 ${untitled + 1} 条 Markdown 设定的标题`);
      const settingsMarkdown = settingsSections.map((section) => section.contentMarkdown).join("\n\n");
      const body = isRace
        ? { name, parentRaceId: data.get("parentRaceId") || null, description: data.get("description"), settingsMarkdown, settingsSections }
        : { name, description: data.get("description"), settingsMarkdown, settingsSections };
      if (canReadModule("characters")) body.memberIds = data.getAll("memberIds").map(String);
      const wasEditing = Boolean(knowledgeEditorItem);
      await api(wasEditing ? `/api/${module}/${knowledgeEditorItem.id}` : `/api/works/${state.work.id}/${module}`, { method: wasEditing ? "PATCH" : "POST", body });
      await cleanupPendingMarkdownAttachments(settingsMarkdown);
      entityEditorDirty = false;
      await loadAiReferences();
      await closeEntityEditor({ force: true });
      toast(wasEditing ? `${label}档案已保存` : `${label}档案已创建`);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      submit.disabled = false;
    }
  };
  showEntityEditorPage(kind);
  $("#knowledge-editor-fields").querySelector("input:not([type='checkbox']), textarea")?.focus();
}

async function openRaceDialog(item) {
  await openKnowledgeEditor("race", item);
}

async function openOrganizationDialog(item) {
  await openKnowledgeEditor("organization", item);
}

function openTimelineTrackDialog(item) {
  openDialog(item ? "编辑独立时间轴" : "新建独立时间轴", field("name", "时间轴名称", "text", item?.name) + field("description", "时间轴简介", "textarea", item?.description) + field("sortOrder", "看板排序", "number", item?.sortOrder ?? state.timelineTracks.length), async (form) => {
    await api(item ? `/api/timeline-tracks/${item.id}` : `/api/works/${state.work.id}/timeline-tracks`, { method: item ? "PATCH" : "POST", body: { name: form.get("name"), description: form.get("description"), sortOrder: Number(form.get("sortOrder")) } });
    await renderTimeline();
  }, item ? "大事件分组" : "多线叙事");
}

function openTimelineDialog(item, preferredTrackId = null) {
  const trackOptions = [["", "未分组"], ...state.timelineTracks.map((track) => [track.id, track.name])];
  openDialog(item ? "编辑大事件" : "新建大事件", field("trackId", "所属独立时间轴", "select", item?.trackId ?? preferredTrackId ?? "", trackOptions) + field("name", "事件名称", "text", item?.name) + field("timeLabel", "时间描述", "text", item?.timeLabel ?? "时间待定") + field("timeSort", "排序值（留空表示时间待定）", "number", item?.timeSort ?? "") + field("eventType", "事件类型", "text", item?.eventType ?? "other") + field("location", "地点", "text", item?.location) + field("description", "事件简述", "textarea", item?.description), async (form) => {
    const rawSort = String(form.get("timeSort") ?? "").trim();
    const body = { trackId: form.get("trackId") || null, name: form.get("name"), timeLabel: form.get("timeLabel"), timeSort: rawSort ? Number(rawSort) : null, eventType: form.get("eventType"), location: form.get("location"), description: form.get("description"), status: item?.status ?? "confirmed", ...(item ? { expectedVersionNo: item.versionNo } : {}) };
    await api(item ? `/api/timeline/${item.id}` : `/api/works/${state.work.id}/timeline`, { method: item ? "PATCH" : "POST", body });
    await renderTimeline();
  }, item ? "人工调整" : "作者确认事件");
}

function openOutlineDialog(item) {
  if (!item) return;
  openDialog(`规划：${item.chapterTitle}`,
    field("goal", "本章目标", "textarea", item.goal) +
    field("conflict", "核心冲突", "textarea", item.conflict) +
    field("turningPoint", "关键转折", "textarea", item.turningPoint) +
    field("notes", "补充说明", "textarea", item.notes) +
    field("status", "规划状态", "select", item.status ?? "draft", [["draft", "草稿"], ["ready", "可执行"], ["completed", "已完成"]]),
    async (form) => {
      await api(`/api/chapters/${item.chapterId}/outline`, { method: "PUT", body: {
        goal: form.get("goal"), conflict: form.get("conflict"), turningPoint: form.get("turningPoint"), notes: form.get("notes"), status: form.get("status"), expectedVersionNo: item.versionNo
      } });
      await renderOutlines();
      toast("章节规划已保存");
    }, "章节大纲");
}

function openForeshadowDialog(item) {
  const chapters = state.work.volumes.flatMap((volume) => volume.chapters.map((chapter) => [chapter.id, `${volume.title} / ${chapter.title}`]));
  if (!chapters.length) return toast("请先创建章节", "error");
  const options = [["", "暂不关联"], ...chapters];
  const occurrence = (role) => item?.occurrences?.find((record) => record.role === role);
  const editableOccurrenceIds = new Set(["setup", "reminder", "payoff"].map((role) => occurrence(role)?.id).filter(Boolean));
  const preservedOccurrences = (item?.occurrences ?? [])
    .filter((record) => !editableOccurrenceIds.has(record.id))
    .map((record) => ({ chapterId: record.chapterId, role: record.role, note: record.note, evidence: record.evidence }));
  openDialog(item ? "编辑伏笔" : "新建伏笔",
    field("title", "伏笔名称", "text", item?.title) +
    field("description", "内容与预期作用", "textarea", item?.description) +
    field("importance", "重要程度", "select", item?.importance ?? "medium", [["low", "低"], ["medium", "中"], ["high", "高"]]) +
    field("status", "状态", "select", item?.status ?? "planned", [["planned", "计划中"], ["planted", "已埋设"], ["resolved", "已回收"], ["abandoned", "已放弃"]]) +
    field("setupChapterId", "埋设章节", "select", occurrence("setup")?.chapterId ?? "", options) +
    field("setupNote", "埋设说明", "textarea", occurrence("setup")?.note ?? "") +
    field("reminderChapterId", "提醒章节", "select", occurrence("reminder")?.chapterId ?? "", options) +
    field("reminderNote", "提醒说明", "textarea", occurrence("reminder")?.note ?? "") +
    field("payoffChapterId", "回收章节", "select", occurrence("payoff")?.chapterId ?? item?.plannedPayoffChapterId ?? "", options) +
    field("payoffNote", "回收说明", "textarea", occurrence("payoff")?.note ?? "") +
    field("resolutionNote", "回收结论", "textarea", item?.resolutionNote),
    async (form) => {
      const editedOccurrences = ["setup", "reminder", "payoff"].flatMap((role) => {
        const chapterId = form.get(`${role}ChapterId`);
        if (!chapterId) return [];
        const previous = occurrence(role);
        return [{
          chapterId,
          role,
          note: form.get(`${role}Note`),
          evidence: previous?.chapterId === chapterId ? previous.evidence : []
        }];
      });
      const occurrences = [...preservedOccurrences, ...editedOccurrences];
      const body = {
        title: form.get("title"), description: form.get("description"), importance: form.get("importance"), status: form.get("status"),
        plannedPayoffChapterId: form.get("payoffChapterId") || null, resolutionNote: form.get("resolutionNote"), occurrences,
        ...(item ? { expectedVersionNo: item.versionNo } : {})
      };
      await api(item ? `/api/foreshadows/${item.id}` : `/api/works/${state.work.id}/foreshadows`, { method: item ? "PATCH" : "POST", body });
      await renderOutlines();
      toast(item ? "伏笔已更新" : "伏笔已创建");
    }, item ? "伏笔管理" : "创作线索");
}

function openTimelineSplitDialog(item) {
  openDialog("拆分时间事件", field("firstName", "第一阶段名称", "text", `${item.name}（一）`) + field("firstDescription", "第一阶段说明", "textarea", item.description) + field("secondName", "第二阶段名称", "text", `${item.name}（二）`) + field("secondDescription", "第二阶段说明", "textarea", item.description), async (form) => {
    await api(`/api/timeline/${item.id}/split`, { method: "POST", body: { parts: [
      { name: form.get("firstName"), description: form.get("firstDescription") },
      { name: form.get("secondName"), description: form.get("secondDescription") }
    ], expectedVersionNo: item.versionNo } });
    await renderTimeline();
  }, "原证据同步保留");
}

async function openRelationshipDialog(item, options = {}) {
  if (!canReadModule("characters")) return toast("配置人物关系前需要角色模块读取权限", "error");
  state.characters = await apiAllPages(`/api/works/${state.work.id}/characters`);
  if (state.characters.length < 2) return toast("至少需要两个角色才能创建关系", "error");
  const characterOptions = state.characters.map((item) => [item.id, item.name]);
  const defaultFrom = options.characterId && state.characters.some((character) => character.id === options.characterId) ? options.characterId : characterOptions[0][0];
  const defaultTo = characterOptions.find(([id]) => id !== defaultFrom)?.[0] ?? characterOptions[1][0];
  openDialog(item ? "编辑人物关系" : "新建人物关系", field("from", "起点人物", "select", item?.fromCharacterId ?? defaultFrom, characterOptions) + field("to", "终点人物", "select", item?.toCharacterId ?? defaultTo, characterOptions) + field("category", "关系大类", "select", item?.category ?? "social", [["family", "亲属"], ["social", "社交"], ["emotional", "情感"], ["conflict", "冲突"], ["uncertain", "未确定"]]) + field("subtype", "关系子类", "text", item?.subtype) + field("keywords", "关系关键词", "keyword-chips", item?.keywords ?? []) + field("confidence", "置信度（0-1）", "number", item?.confidence ?? "1") + field("directed", "有方向性", "checkbox", item?.directed ?? false), async (form) => {
    const keywords = uniqueRelationshipKeywords(form.getAll("keywords").map(String));
    await api(item ? `/api/relationships/${item.id}` : `/api/works/${state.work.id}/relationships`, { method: item ? "PATCH" : "POST", body: { fromCharacterId: form.get("from"), toCharacterId: form.get("to"), category: form.get("category"), subtype: form.get("subtype"), keywords, confidence: Number(form.get("confidence")), directed: form.get("directed") === "on", confirmationStatus: item?.confirmationStatus ?? "confirmed", ...(item ? { expectedVersionNo: item.versionNo } : {}) } });
    await refreshRelationshipSurfaces(options.characterId ?? null);
  }, item ? "关系档案" : "人工确认关系");
}

function openReviewDialog() {
  openDialog("新增审核项", field("title", "问题标题") + field("itemType", "问题类型", "text", "consistency") + field("severity", "严重程度", "select", "medium", [["low", "低"], ["medium", "中"], ["high", "高"]]) + field("description", "问题说明", "textarea") + field("suggestion", "可选建议", "textarea"), async (form) => {
    await api(`/api/works/${state.work.id}/reviews`, { method: "POST", body: { title: form.get("title"), itemType: form.get("itemType"), severity: form.get("severity"), description: form.get("description"), suggestion: form.get("suggestion") } });
    await renderReviews();
  });
}

function openTaskDialog() {
  const chapterOptions = state.work.volumes.flatMap((volume) => volume.chapters.map((chapter) => [chapter.id, `${volume.title} / ${chapter.title}`]));
  const defaultTaskType = ANALYSIS_TYPES[0].value;
  const taskTypeField = `<div class="form-field analysis-type-field"><label>分析类型<select name="taskType" aria-describedby="analysis-type-description">${ANALYSIS_TYPES.map(({ value, label }) => `<option value="${esc(value)}" ${value === defaultTaskType ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></label><p id="analysis-type-description" class="analysis-type-description" aria-live="polite">${esc(analysisTypeDescription(defaultTaskType))}</p></div>`;
  openDialog("开始 AI 分析", taskTypeField + field("scopeType", "分析范围", "select", "chapter", [["chapter", "指定章节"], ["book", "全书"]]) + field("chapterId", "章节", "select", chapterOptions[0]?.[0] ?? "", chapterOptions), async (form) => {
    const scope = form.get("taskType") === "character-identity-audit" || form.get("scopeType") === "book" ? { type: "book" } : { type: "chapter", chapterId: form.get("chapterId") };
    await api(`/api/works/${state.work.id}/tasks`, { method: "POST", body: { taskType: form.get("taskType"), scope } });
    await renderTasks();
  });
  const taskTypeSelect = $("#dialog-fields").querySelector('select[name="taskType"]');
  const description = $("#analysis-type-description");
  taskTypeSelect.addEventListener("change", () => {
    description.textContent = analysisTypeDescription(taskTypeSelect.value);
  });
}

function openProviderDialog(item) {
  openDialog(item ? "编辑 AI 供应商" : "新建 AI 供应商", field("name", "显示名称", "text", item?.name) + field("baseUrl", "Chat Completions 基础地址", "url", item?.baseUrl ?? "https://api.openai.com/v1") + field("apiKey", item ? "替换 API 密钥（留空则不变）" : "API 密钥", "password") + field("concurrencyLimit", "最大并发请求数", "number", item?.concurrencyLimit ?? 10) + field("rpmLimit", "每分钟请求上限（RPM）", "number", item?.rpmLimit ?? 10) + field("maxTokens", "最大输出 Token 数", "number", item?.maxTokens ?? 32000) + field("note", "用途备注", "textarea", item?.note) + field("enabled", item ? "启用供应商" : "立即启用", "checkbox", item ? item.status === "enabled" : true), async (form) => {
    const body = { name: form.get("name"), baseUrl: form.get("baseUrl"), concurrencyLimit: Number(form.get("concurrencyLimit")), rpmLimit: Number(form.get("rpmLimit")), maxTokens: Number(form.get("maxTokens")), note: form.get("note"), status: form.get("enabled") === "on" ? "enabled" : "disabled" };
    if (!item || String(form.get("apiKey") ?? "").trim()) body.apiKey = form.get("apiKey");
    await api(item ? `/api/providers/${item.id}` : "/api/platform/ai/providers", { method: item ? "PATCH" : "POST", body });
    await renderPlatformAiConfig();
    await loadModels();
  }, item ? "限流与凭据" : "OpenAI 兼容协议");
}

function openModelDialog(providerId, item = null) {
  const values = modelFormValues(item);
  openDialog(item ? "编辑模型" : "添加模型", field("displayName", "显示名称", "text", values.displayName) + field("modelId", "模型标识符", "text", values.modelId) + field("purposes", "支持用途（可多选）", "chips", values.purposes, MODEL_PURPOSE_OPTIONS) + field("contextWindow", "模型上下文总量（Token）", "number", values.contextWindow) + field("temperature", "默认温度", "number", values.temperature) + field("maxTokens", "默认 max_tokens", "number", values.maxTokens) + field("thinkingEnabled", "开启 Thinking（供应商需支持 thinking 参数）", "checkbox", values.thinkingEnabled) + field("enabled", "启用模型", "checkbox", values.enabled), async (form) => {
    const body = modelPayload({ displayName: form.get("displayName"), modelId: form.get("modelId"), purposes: form.getAll("purposes"), contextWindow: form.get("contextWindow"), temperature: form.get("temperature"), maxTokens: form.get("maxTokens"), thinkingEnabled: form.get("thinkingEnabled") === "on", enabled: form.get("enabled") === "on" }, item?.preset);
    await api(item ? `/api/models/${item.id}` : `/api/providers/${providerId}/models`, { method: item ? "PATCH" : "POST", body });
    await renderPlatformAiConfig();
    await loadModels();
  }, item ? "模型配置" : "供应商模型");
}

async function sendAi() {
  if (!state.work) return toast("请先选择作品", "error");
  try {
    await Promise.all([ensureAiModelsLoaded(), ensureAiConversationsLoaded()]);
  } catch (error) {
    return toast(`创作助手加载失败：${error.message}`, "error");
  }
  const modelId = $("#ai-model").value;
  if (!modelId) return toast("请先在 AI 管理中配置并选择模型", "error");
  const instruction = aiPromptText().trim();
  if (!instruction) return toast("请输入指令", "error");
  const requestScope = currentAiRequestScope();
  if (!requestScope) return toast("请先选择章节", "error");
  const { taskType, scope, selection } = requestScope;
  if (taskType === "polish" && !selection) return toast("请先在正文中选中一段文本", "error");
  const citations = state.aiCitations.map(({ chapterId, chapterTitle, startLine, endLine, text }) => ({ chapterId, chapterTitle, startLine, endLine, text }));
  if (taskType === "chat") {
    $("#ai-send").disabled = true;
    $("#ai-send").textContent = "检查上下文";
    try {
      const mayContinue = await prepareAiConversationContext({ instruction, scope, modelId, citations });
      if (!mayContinue) return;
    } catch (error) {
      toast(`上下文检查失败：${error.message}`, "error");
      return;
    } finally {
      $("#ai-send").disabled = false;
      $("#ai-send").textContent = "发送";
    }
  }
  let persistedUserMessage;
  try {
    persistedUserMessage = await persistAiConversationMessage("user", instruction, citations);
  } catch (error) {
    return toast(`对话记录创建失败：${error.message}`, "error");
  }
  state.aiPromptSent = true;
  renderAiQuickActions();
  appendMessage("user", instruction, citations, persistedUserMessage.createdAt, {}, persistedUserMessage.id);
  clearAiPromptComposer();
  $("#ai-send").disabled = true;
  $("#ai-send").textContent = "发送中";
  try {
    let assistantContent = "";
    let assistantMessage;
    let assistantMetadata = {};
    let suggestion = null;
    if (taskType === "chat") {
      const streamed = await streamChat({ instruction, scope, modelId, citations, conversationId: state.aiConversationId, currentMessageId: persistedUserMessage.id });
      assistantContent = streamed.content;
      assistantMessage = streamed.message;
      assistantMetadata = streamed.metadata;
    } else {
      suggestion = await api(`/api/works/${state.work.id}/suggestions`, { method: "POST", body: { taskType, instruction, scope, modelId, citations } });
      assistantContent = suggestion.content;
      assistantMetadata = { modelDisplayName: suggestion.model?.displayName, outputTokens: suggestion.outputTokens };
    }
    try {
      const persistedAssistantMessage = await persistAiConversationMessage("assistant", assistantContent, [], assistantMetadata);
      if (assistantMessage) {
        updateMessageCreatedAt(assistantMessage, persistedAssistantMessage.createdAt);
        attachMessageIdentity(assistantMessage, persistedAssistantMessage.id);
      } else if (suggestion) appendSuggestion(suggestion, persistedAssistantMessage.createdAt, persistedAssistantMessage.id);
    } catch (error) {
      if (suggestion) appendSuggestion(suggestion);
      toast(`AI 回复已生成，但历史记录保存失败：${error.message}`, "error");
    }
  } catch (error) {
    const failureMessage = `调用失败：${error.message}`;
    let persistedFailureMessage = null;
    try { persistedFailureMessage = await persistAiConversationMessage("assistant", failureMessage); } catch { /* 主请求错误已显示，历史记录保存失败不覆盖原始错误 */ }
    appendMessage("assistant", failureMessage, [], persistedFailureMessage?.createdAt, {}, persistedFailureMessage?.id);
  } finally {
    $("#ai-send").disabled = false;
    $("#ai-send").textContent = "发送";
  }
}

async function streamChat(body) {
  const message = document.createElement("div");
  message.className = "assistant-message is-streaming";
  message.dataset.testid = "ai-stream-message";
  message.innerHTML = '<div class="message-body" data-testid="ai-stream-content" aria-live="polite"></div><div class="message-meta">正在连接模型流……</div>';
  attachMessageHeading(message, "助手 · 正在生成");
  $("#ai-feed").append(message);
  scrollAiFeedToBottom();
  const content = message.querySelector(".message-body");
  const meta = message.querySelector(".message-meta");
  let streamedText = "";
  let generatedMetadata = {};
  let toolCalls = [];
  let processSteps = [];
  let finalAnswerStarted = false;
  const processStartedAt = Date.now();
  const elapsedProcessTime = () => Math.max(0, Date.now() - processStartedAt);
  try {
    const response = await fetch(`/api/works/${state.work.id}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", "X-CSRF-Token": state.csrfToken },
      body: JSON.stringify(body)
    });
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({ error: { message: `请求失败：${response.status}` } }));
      throw new Error(payload.error?.message ?? `请求失败：${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamError = null;
    const consume = (eventText) => {
      let eventName = "message";
      const dataLines = [];
      for (const line of eventText.split(/\r?\n/)) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) return;
      const payload = JSON.parse(dataLines.join("\n"));
      if (eventName === "delta") {
        const firstFinalDelta = streamedText.length === 0;
        streamedText += payload.delta ?? "";
        if (streamedText.length > 0) finalAnswerStarted = true;
        content.innerHTML = renderMarkdown(streamedText);
        if (firstFinalDelta && processSteps.length) renderAiProcessSteps(message, processSteps, true, elapsedProcessTime());
        meta.textContent = `已接收 ${Array.from(streamedText).length} 字`;
        scrollAiFeedToBottom();
      } else if (eventName === "process_step") {
        const step = { ...payload };
        const append = step.append === true;
        delete step.append;
        const existing = append ? processSteps.find((item) => item.id === step.id && item.type === step.type) : null;
        if (existing && typeof step.content === "string") existing.content += step.content;
        else processSteps.push(step);
        renderAiProcessSteps(message, processSteps, finalAnswerStarted, elapsedProcessTime());
        meta.textContent = step.type === "thinking" ? `正在思考 · 第 ${Number(step.round) || 1} 轮` : `正在处理第 ${Number(step.round) || 1} 轮中间结果`;
        scrollAiFeedToBottom();
      } else if (eventName === "tool_call") {
        const toolCall = { ...payload };
        const round = toolCall.round;
        delete toolCall.round;
        toolCalls.push(toolCall);
        processSteps.push(aiToolProcessStep(toolCall, round));
        renderAiProcessSteps(message, processSteps, finalAnswerStarted, elapsedProcessTime());
        meta.textContent = `已调用 ${toolCalls.length} 个工具，正在等待模型处理结果`;
        scrollAiFeedToBottom();
      } else if (eventName === "complete") {
        message.classList.remove("is-streaming");
        message.querySelector(".message-heading > span").textContent = "助手";
        toolCalls = Array.isArray(payload.toolCalls) ? payload.toolCalls : toolCalls;
        processSteps = Array.isArray(payload.processSteps) ? payload.processSteps : processSteps;
        const processDurationMs = elapsedProcessTime();
        generatedMetadata = { modelDisplayName: payload.model?.displayName, outputTokens: payload.outputTokens, toolCalls, processSteps, processDurationMs };
        renderAiProcessSteps(message, processSteps, true, processDurationMs);
        meta.textContent = formatAiMessageMeta(payload.model?.displayName, payload.outputTokens);
        attachAssistantCopyAction(message, streamedText);
        scrollAiFeedToBottom();
      } else if (eventName === "error") {
        streamError = new Error(payload.message ?? "AI 流式调用失败");
      }
    };
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      events.forEach(consume);
      if (chunk.done) break;
    }
    if (buffer.trim()) consume(buffer);
    if (streamError) throw streamError;
    return { content: streamedText, message, metadata: generatedMetadata };
  } catch (error) {
    message.classList.remove("is-streaming");
    message.querySelector(".message-heading > span").textContent = "助手 · 生成中断";
    renderAiProcessSteps(message, processSteps, true, elapsedProcessTime());
    meta.textContent = "生成中断";
    scrollAiFeedToBottom();
    throw error;
  }
}

function appendMessage(role, text, citations = [], createdAt = null, metadata = {}, messageId = null) {
  const message = document.createElement("div");
  message.className = role === "user" ? "user-message" : "assistant-message";
  message.innerHTML = `<div class="message-body">${renderMarkdown(text)}</div>`;
  attachMessageHeading(message, role === "user" ? "作者" : "助手", createdAt ?? undefined);
  if (citations.length) {
    const references = document.createElement("div");
    references.className = "message-citations";
    for (const citation of citations) {
      const reference = document.createElement("span");
      reference.textContent = `${citation.chapterTitle} · L${citation.startLine}${citation.endLine === citation.startLine ? "" : `-L${citation.endLine}`}`;
      references.append(reference);
    }
    message.append(references);
  }
  if (role === "assistant") {
    const processSteps = Array.isArray(metadata?.processSteps) && metadata.processSteps.length
      ? metadata.processSteps
      : (Array.isArray(metadata?.toolCalls) ? metadata.toolCalls : []).map((toolCall) => aiToolProcessStep(toolCall));
    renderAiProcessSteps(message, processSteps, true, resolveAiProcessDuration(metadata, processSteps, createdAt));
  }
  if (role === "assistant" && !text.startsWith("调用失败：")) {
    const selectedModel = state.models.find((model) => model.id === $("#ai-model").value) ?? state.models[0];
    const modelDisplayName = metadata?.modelDisplayName || selectedModel?.displayName || "模型";
    const outputTokens = Number.isFinite(metadata?.outputTokens) ? metadata.outputTokens : estimateAiMessageTokens(text);
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = formatAiMessageMeta(modelDisplayName, outputTokens);
    message.append(meta);
    attachAssistantCopyAction(message, text);
  }
  attachMessageIdentity(message, messageId);
  $("#ai-feed").append(message);
  scrollAiFeedToBottom();
}

function appendSuggestion(suggestion, createdAt = null, messageId = null) {
  const message = document.createElement("div");
  message.className = "assistant-message";
  const applicable = suggestion.action !== "note";
  const guard = suggestion.guard;
  const guardHtml = guard ? `<section class="guard-card ${esc(guard.status)}" data-testid="continuation-guard"><strong>${guard.status === "clear" ? "一致性守卫：未发现冲突" : guard.status === "warning" ? `一致性守卫：发现 ${guard.issues.length} 项风险` : "一致性守卫：检查失败"}</strong>${guard.status === "failed" ? `<p>${esc(guard.failure || "无法完成检查，请谨慎采纳")}</p>` : guard.issues.map((issue) => `<p><b>${esc(issue.severity)} · ${esc(issue.type)}</b> ${esc(issue.title)}${issue.description ? `：${esc(issue.description)}` : ""}</p>`).join("")}</section>` : "";
  message.innerHTML = `<div class="message-body">${renderMarkdown(suggestion.content)}</div><div class="message-meta">${esc(formatAiMessageMeta(suggestion.model?.displayName, suggestion.outputTokens, `基于 v${suggestion.chapterVersion ?? "-"}`))}</div>${guardHtml}${applicable ? '<div class="message-actions"><button data-action="accept">采纳到正文</button><button data-action="reject">拒绝</button></div>' : ""}`;
  attachMessageHeading(message, "助手建议", createdAt ?? undefined);
  attachAssistantCopyAction(message, suggestion.content);
  attachMessageIdentity(message, messageId);
  if (applicable) {
    message.querySelector('[data-action="accept"]').addEventListener("click", async () => {
      try {
        const result = await api(`/api/suggestions/${suggestion.id}/accept`, { method: "POST", body: {} });
        state.chapter = result.chapter;
        lastSavedChapterSnapshot = { chapterId: state.chapter.id, title: state.chapter.title, content: state.chapter.content };
        $("#chapter-content").value = state.chapter.content;
        scheduleChapterLineNumbers();
        updateChapterStats();
        state.work = await api(`/api/works/${state.work.id}`);
        renderTree();
        message.querySelector(".message-actions").innerHTML = "<span>已采纳并生成新版本</span>";
        toast("AI 建议已采纳，正文已生成新版本");
      } catch (error) { toast(error.message, "error"); }
    });
    message.querySelector('[data-action="reject"]').addEventListener("click", async () => {
      await api(`/api/suggestions/${suggestion.id}/reject`, { method: "POST", body: {} });
      message.querySelector(".message-actions").innerHTML = "<span>已拒绝</span>";
    });
  }
  $("#ai-feed").append(message);
  scrollAiFeedToBottom();
  return message;
}

async function showVersions() {
  if (!state.chapter) return;
  const versions = await api(`/api/chapters/${state.chapter.id}/versions`);
  $("#versions-list").innerHTML = versions.map((version) => `<div class="version-row"><div><b>v${version.versionNo}</b><small>${esc(version.source)} · ${esc(version.actor || "历史数据")}</small></div><p>${esc(version.content.slice(0, 300) || "空白章节")}</p>${canEditProse() ? `<button class="ghost-button" data-restore-version="${version.versionNo}">恢复</button>` : ""}</div>`).join("");
  $("#versions-list").querySelectorAll("[data-restore-version]").forEach((button) => button.addEventListener("click", async () => {
    if (!(await confirmToast(
      `将版本 v${button.dataset.restoreVersion} 恢复为一个新的保存版本？`,
      { title: "恢复历史版本", confirmLabel: "确认恢复" }
    ))) return;
    state.chapter = await api(`/api/chapters/${state.chapter.id}/restore`, { method: "POST", body: { versionNo: Number(button.dataset.restoreVersion) } });
    lastSavedChapterSnapshot = { chapterId: state.chapter.id, title: state.chapter.title, content: state.chapter.content };
    $("#chapter-title").value = state.chapter.title;
    $("#chapter-content").value = state.chapter.content;
    scheduleChapterLineNumbers();
    updateChapterStats();
    setSaveState("已保存");
    $("#versions-dialog").close();
    toast("历史内容已恢复为新版本");
  }));
  $("#versions-dialog").showModal();
}

function importHistoryRecordLabel(version) {
  const restorePrefix = "before-restore:";
  if (version.fileType === "snapshot" && version.fileName.startsWith(restorePrefix)) {
    return {
      title: `恢复操作前备份：${version.fileName.slice(restorePrefix.length)}`,
      kind: "自动备份",
      action: "恢复此操作前备份"
    };
  }
  return { title: version.fileName, kind: String(version.fileType).toUpperCase(), action: "恢复到此次导入前" };
}

function renderImportHistory(versions, nextPage = null) {
  const host = $("#import-history-list");
  if (!versions.length) {
    host.innerHTML = '<p class="entity-history-empty">还没有正文导入记录。首次导入后会自动保存导入前快照。</p>';
    return;
  }
  host.innerHTML = versions.map((version) => {
    const label = importHistoryRecordLabel(version);
    return `<article class="entity-version-card import-history-card" data-file-version="${esc(version.id)}">
      <header><strong title="${esc(label.title)}">${esc(label.title)}</strong><span class="import-history-kind">${esc(label.kind)}</span></header>
      <time>${esc(formatDateTime(version.createdAt))} · ${esc(version.actor || "历史数据")}</time>
      <p>${version.fileType === "snapshot" ? "恢复操作执行前自动保存的完整正文。" : "保存的是这次文件导入开始前的完整正文。"}</p>
      <small>自动备份仅包含正文，不能撤销章节关联信息的变化。</small>
      <button type="button" data-file-version-restore="${esc(version.id)}" data-default-label="${esc(label.action)}">${esc(label.action)}</button>
    </article>`;
  }).join("") + (nextPage ? '<button class="import-history-load-more" type="button" data-import-history-load-more>加载更多记录</button>' : "");
  host.querySelectorAll("[data-file-version-restore]").forEach((button) => button.addEventListener("click", async () => {
    if (!state.work || !canReplaceProse()) return;
    const defaultLabel = button.dataset.defaultLabel;
    if (button.dataset.confirmed !== "true") {
      host.querySelectorAll("[data-file-version-restore]").forEach((other) => {
        other.dataset.confirmed = "false";
        other.classList.remove("is-confirming");
        other.textContent = other.dataset.defaultLabel;
      });
      button.dataset.confirmed = "true";
      button.classList.add("is-confirming");
      button.textContent = "再次点击确认恢复";
      window.setTimeout(() => {
        if (!button.isConnected || button.dataset.confirmed !== "true") return;
        button.dataset.confirmed = "false";
        button.classList.remove("is-confirming");
        button.textContent = defaultLabel;
      }, 5000);
      return;
    }
    if (!(await confirmDiscardChanges("当前章节有未保存修改，恢复正文会丢弃这些本地修改。是否继续？"))) return;
    button.disabled = true;
    cancelChapterAutoSave();
    const workId = state.work.id;
    try {
      await api(`/api/works/${encodeURIComponent(workId)}/file-versions/${encodeURIComponent(button.dataset.fileVersionRestore)}/restore`, {
        method: "POST",
        body: { expectedVersionNo: state.work.versionNo }
      });
      state.dirty = false;
      resetWorkScopedUiCaches();
      $("#import-history-dialog").close();
      await loadWorks(workId);
      toast("正文已恢复；恢复前正文已自动备份");
    } catch (error) {
      button.disabled = false;
      button.dataset.confirmed = "false";
      button.classList.remove("is-confirming");
      button.textContent = defaultLabel;
      if (state.dirty) scheduleChapterAutoSave();
      toast(error.message, "error");
    }
  }));
  host.querySelector("[data-import-history-load-more]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "正在加载…";
    try {
      await loadImportHistoryPage(nextPage);
    } catch (error) {
      button.disabled = false;
      button.textContent = "加载更多记录";
      toast(error.message, "error");
    }
  });
}

async function loadImportHistoryPage(page) {
  const workId = state.work?.id;
  if (!workId || !page) return;
  const requestId = ++importHistoryRequestId;
  const result = await apiPage(`/api/works/${encodeURIComponent(workId)}/file-versions`, page, 25);
  if (requestId !== importHistoryRequestId || state.work?.id !== workId || !$("#import-history-dialog").open) return;
  importHistoryRecords = page === 1 ? result.items : [...importHistoryRecords, ...result.items];
  importHistoryNextPage = result.nextPage;
  renderImportHistory(importHistoryRecords, importHistoryNextPage);
}

async function openImportHistory() {
  if (!state.work || !canReplaceProse()) {
    toast("恢复整本正文需要所有受影响模块的编辑权限", "error");
    return;
  }
  importHistoryRecords = [];
  importHistoryNextPage = null;
  importHistoryRequestId += 1;
  $("#import-history-list").innerHTML = '<p class="entity-history-empty">正在读取导入历史…</p>';
  $("#import-history-dialog").showModal();
  try {
    await loadImportHistoryPage(1);
  } catch (error) {
    $("#import-history-dialog").close();
    toast(error.message, "error");
  }
}

async function showChapterInsight() {
  if (!state.chapter) return;
  const panel = $("#chapter-insight");
  const insights = await api(`/api/chapters/${state.chapter.id}/insights`);
  const insight = insights.find((item) => item.chapterVersion === state.chapter.versionNo) ?? insights[0];
  panel.classList.remove("hidden");
  if (!insight) {
    panel.innerHTML = "<strong>尚无章节概览</strong>请在“AI 分析”中运行章节理解，完成后可在此查看结果。";
    return;
  }
  const eventNames = insight.events.map((event) => typeof event === "string" ? event : (event.name ?? event.description ?? "未命名事件"));
  const stale = insight.chapterVersion !== state.chapter.versionNo ? `；基于旧版本 v${insight.chapterVersion}` : "";
  panel.innerHTML = `<strong>章节概览${esc(stale)}</strong>${esc(insight.summary || "暂无梗概")}${eventNames.length ? `<br><strong>事件</strong>${esc(eventNames.join("；"))}` : ""}${insight.uncertainties.length ? `<br><strong>待确认</strong>${esc(insight.uncertainties.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("；"))}` : ""}`;
}

$("#home-button").addEventListener("click", async () => {
  if (!(await confirmDiscardChanges())) return;
  loadWorks().catch((error) => toast(error.message, "error"));
});
$("#settings-button").addEventListener("click", () => {
  void showSettingsHub();
});
$("#account-button").addEventListener("click", () => {
  const expanded = $("#account-menu").classList.toggle("hidden") === false;
  $("#account-button").setAttribute("aria-expanded", String(expanded));
});
$("#onboarding-menu-button").addEventListener("click", () => {
  $("#account-menu").classList.add("hidden");
  $("#account-button").setAttribute("aria-expanded", "false");
  openOnboarding(true);
});
$("#onboarding-skip").addEventListener("click", completeOnboarding);
$("#onboarding-previous").addEventListener("click", () => renderOnboardingStep(onboardingStep - 1, true));
$("#onboarding-next").addEventListener("click", () => {
  const lastStep = onboardingSteps.length - 1;
  if (onboardingStep >= lastStep) completeOnboarding();
  else renderOnboardingStep(onboardingStep + 1, true);
});
$("#onboarding-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  completeOnboarding();
});
$("#onboarding-dialog").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    completeOnboarding();
    return;
  }
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const direction = event.key === "ArrowRight" ? 1 : -1;
  const lastStep = onboardingSteps.length - 1;
  renderOnboardingStep(Math.max(0, Math.min(lastStep, onboardingStep + direction)), true);
});
window.addEventListener("resize", refreshOnboardingForViewport);
document.addEventListener("scroll", scheduleOnboardingPosition, true);
$("#account-settings-button").addEventListener("click", () => {
  $("#account-menu").classList.add("hidden");
  $("#account-button").setAttribute("aria-expanded", "false");
  $("#profile-display-name").value = state.user?.displayName ?? "";
  renderProfileAvatar();
  $("#password-form").reset();
  $("#api-key-result").classList.add("hidden");
  $("#api-key-value").value = "";
  $("#account-dialog").showModal();
  api("/api/auth/api-key").then((status) => {
    $("#api-key-status").textContent = status.configured
      ? `已配置 ${status.prefix}…${status.lastUsedAt ? `，最近使用：${formatDateTime(status.lastUsedAt)}` : "，尚未使用"}`
      : "尚未生成 API Key。";
    $("#api-key-reset-button").textContent = status.configured ? "重置 API Key" : "生成 API Key";
  }).catch((error) => {
    $("#api-key-status").textContent = error.message;
  });
});
$("#account-dialog-close").addEventListener("click", () => $("#account-dialog").close());
$("#avatar-upload-button").addEventListener("click", () => $("#avatar-file").click());
$("#avatar-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > maximumAvatarFileSize) {
    toast("头像文件不能超过 5 MB", "error");
    event.target.value = "";
    return;
  }
  const body = new FormData();
  body.append("file", file);
  $("#avatar-upload-button").disabled = true;
  $("#avatar-remove-button").disabled = true;
  try {
    const updated = await api("/api/auth/avatar", { method: "PUT", body });
    applyAuthenticatedUser({ user: updated, csrfToken: state.csrfToken });
    renderProfileAvatar();
    toast("头像已更新");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    $("#avatar-upload-button").disabled = false;
    $("#avatar-remove-button").disabled = false;
    event.target.value = "";
  }
});
$("#avatar-remove-button").addEventListener("click", async () => {
  if (!state.user?.avatarUrl || !(await confirmToast("确定移除当前头像吗？", { title: "移除头像", confirmLabel: "确认移除" }))) return;
  $("#avatar-upload-button").disabled = true;
  $("#avatar-remove-button").disabled = true;
  try {
    const updated = await api("/api/auth/avatar", { method: "DELETE" });
    applyAuthenticatedUser({ user: updated, csrfToken: state.csrfToken });
    renderProfileAvatar();
    toast("头像已移除");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    $("#avatar-upload-button").disabled = false;
    $("#avatar-remove-button").disabled = false;
  }
});
$("#profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const updated = await api("/api/auth/profile", { method: "PATCH", body: { displayName: form.get("displayName") } });
    state.user = updated;
    applyAuthenticatedUser({ user: updated, csrfToken: state.csrfToken });
    toast("显示名称已更新");
  } catch (error) { toast(error.message, "error"); }
});
$("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const newPassword = String(form.get("newPassword") ?? "");
  const passwordConfirmation = String(form.get("passwordConfirmation") ?? "");
  if (newPassword !== passwordConfirmation) {
    const confirmationInput = $("#password-form input[name='passwordConfirmation']");
    confirmationInput.setCustomValidity("两次输入的密码不一致");
    confirmationInput.reportValidity();
    confirmationInput.focus();
    return;
  }
  try {
    await api("/api/auth/password", { method: "PATCH", body: { currentPassword: form.get("currentPassword"), newPassword, passwordConfirmation } });
    event.currentTarget.reset();
    toast("密码已更新，其他设备的会话已退出");
  } catch (error) { toast(error.message, "error"); }
});
function validatePasswordChangeConfirmation() {
  const newPasswordInput = $("#password-form input[name='newPassword']");
  const confirmationInput = $("#password-form input[name='passwordConfirmation']");
  const matches = !confirmationInput.value || newPasswordInput.value === confirmationInput.value;
  confirmationInput.setCustomValidity(matches ? "" : "两次输入的密码不一致");
  return matches;
}
$("#password-form input[name='newPassword']").addEventListener("input", validatePasswordChangeConfirmation);
$("#password-form input[name='passwordConfirmation']").addEventListener("input", validatePasswordChangeConfirmation);
$("#api-key-reset-button").addEventListener("click", async () => {
  if ($("#api-key-reset-button").textContent.includes("重置") && !(await confirmToast(
    "重置后，所有使用旧 API Key 的 CLI 会立刻退出登录。确定继续吗？",
    { title: "重置 API Key", confirmLabel: "确认重置" }
  ))) return;
  try {
    const result = await api("/api/auth/api-key/reset", { method: "POST", body: {} });
    $("#api-key-status").textContent = `已配置 ${result.prefix}…，尚未使用`;
    $("#api-key-reset-button").textContent = "重置 API Key";
    $("#api-key-value").value = result.apiKey;
    $("#api-key-result").classList.remove("hidden");
    $("#api-key-value").focus();
    $("#api-key-value").select();
    toast("新的 API Key 已生成，请立即保存");
  } catch (error) { toast(error.message, "error"); }
});
$("#api-key-copy-button").addEventListener("click", async () => {
  const value = $("#api-key-value").value;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toast("API Key 已复制");
  } catch {
    $("#api-key-value").focus();
    $("#api-key-value").select();
    toast("无法自动复制，请手动复制", "error");
  }
});
$("#logout-button").addEventListener("click", async () => {
  try {
    await api("/api/auth/session", { method: "DELETE" });
    state.user = null;
    state.csrfToken = null;
    window.location.reload();
  } catch (error) { toast(error.message, "error"); }
});
$("#auth-login-tab").addEventListener("click", () => selectAuthMode("login"));
$("#auth-register-tab").addEventListener("click", () => selectAuthMode("register"));
$("#login-captcha-refresh").addEventListener("click", () => {
  refreshAuthCaptcha("login").catch((error) => { $("#auth-error").textContent = error.message; });
});
$("#register-captcha-refresh").addEventListener("click", () => {
  refreshAuthCaptcha("register").catch((error) => { $("#auth-error").textContent = error.message; });
});
function validatePasswordConfirmation() {
  const passwordInput = $("#register-form input[name='password']");
  const confirmationInput = $("#register-form input[name='passwordConfirmation']");
  const matches = !confirmationInput.value || passwordInput.value === confirmationInput.value;
  confirmationInput.setCustomValidity(matches ? "" : "两次输入的密码不一致");
  return matches;
}
$("#register-form input[name='password']").addEventListener("input", validatePasswordConfirmation);
$("#register-form input[name='passwordConfirmation']").addEventListener("input", validatePasswordConfirmation);
function passwordVisibilityIcon(visible) {
  const eye = '<path d="M2.5 12s3.3-5.5 9.5-5.5S21.5 12 21.5 12 18.2 17.5 12 17.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>';
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${eye}${visible ? '<path d="M3.5 3.5 20.5 20.5"/>' : ""}</svg>`;
}
document.querySelectorAll("[data-password-toggle]").forEach((button) => {
  const input = document.getElementById(button.dataset.passwordToggle ?? "");
  if (!(input instanceof HTMLInputElement)) return;
  button.addEventListener("click", () => {
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    button.innerHTML = passwordVisibilityIcon(visible);
    button.setAttribute("aria-pressed", String(visible));
    const label = `${visible ? "隐藏" : "显示"}${input.name === "passwordConfirmation" ? "确认密码" : "密码"}`;
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
  });
});
$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  $("#auth-error").textContent = "";
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: {
        username: form.get("username"),
        password: form.get("password"),
        captchaId: form.get("captchaId"),
        captchaAnswer: form.get("captchaAnswer")
      }
    });
    window.location.reload();
  } catch (error) {
    $("#auth-error").textContent = error.message;
    // 仅在验证码已显示时自动换一张，未加载过则保持默认隐藏状态
    if (!$("#login-captcha-image").hidden) refreshAuthCaptcha("login").catch(() => {});
  }
});
$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  $("#auth-error").textContent = "";
  if (!validatePasswordConfirmation()) {
    $("#auth-error").textContent = "两次输入的密码不一致，请重新确认。";
    $("#register-form input[name='passwordConfirmation']").focus();
    return;
  }
  try {
    await api("/api/auth/register", {
      method: "POST",
      body: {
        username: form.get("username"),
        password: form.get("password"),
        passwordConfirmation: form.get("passwordConfirmation"),
        captchaId: form.get("captchaId"),
        captchaAnswer: form.get("captchaAnswer")
      }
    });
    window.location.reload();
  } catch (error) {
    $("#auth-error").textContent = error.message;
    // 仅在验证码已显示时自动换一张，未加载过则保持默认隐藏状态
    if (!$("#register-captcha-image").hidden) refreshAuthCaptcha("register").catch(() => {});
  }
});
$("#settings-return").addEventListener("click", () => returnFromSettings().catch((error) => toast(error.message, "error")));
$("#platform-ai-button").addEventListener("click", () => showPlatformAi().catch((error) => toast(error.message, "error")));
$("#user-management-button").addEventListener("click", openUsersDialog);
$("#platform-ui-settings-button").addEventListener("click", openPlatformUiSettingsDialog);
$("#collaboration-button").addEventListener("click", () => openMembersDialog());
$("#users-dialog-close").addEventListener("click", () => $("#users-dialog").close());
$("#platform-ui-settings-close").addEventListener("click", () => $("#platform-ui-settings-dialog").close());
$("#platform-ui-settings-cancel").addEventListener("click", () => $("#platform-ui-settings-dialog").close());
$("#platform-ui-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#platform-ui-settings-save");
  button.disabled = true;
  try {
    const settings = await api("/api/platform/ui-settings", {
      method: "PATCH",
      body: { toastPosition: $("#toast-position").value }
    });
    applyPlatformUiSettings(settings);
    $("#platform-ui-settings-dialog").close();
    toast("界面通知设置已保存");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});
$("#members-dialog-close").addEventListener("click", () => $("#members-dialog").close());
$("#members-dialog").addEventListener("close", () => {
  memberDialogWork = null;
  memberDialogMembers = [];
  memberDialogDirectory = [];
});
$("#member-user-select").addEventListener("change", () => selectMemberForConfiguration($("#member-user-select").value));
$("#member-permission-form").querySelectorAll("[data-permission-preset]").forEach((button) => button.addEventListener("click", () => {
  $("#member-permission-grid").querySelectorAll("[data-member-permission]").forEach((select) => {
    select.value = button.dataset.permissionPreset;
  });
}));
$("#member-permission-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const userId = $("#member-user-select").value;
  const work = memberDialogWork ?? state.work;
  if (!work || !userId) return;
  try {
    const existing = memberDialogMembers.some((member) => member.userId === userId && member.role !== "owner");
    const permissions = selectedMemberPermissions();
    const members = await api(existing
      ? `/api/works/${encodeURIComponent(work.id)}/members/${encodeURIComponent(userId)}`
      : `/api/works/${encodeURIComponent(work.id)}/members`, {
      method: existing ? "PATCH" : "POST",
      body: existing ? { permissions } : { userId, permissions }
    });
    renderMembers(members);
    renderMemberSelector(userId);
    toast(existing ? "成员模块权限已更新" : "成员已添加并保存模块权限");
  } catch (error) { toast(error.message, "error"); }
});
$("#platform-new-provider").addEventListener("click", () => openProviderDialog());
$("#shelf-new-work").addEventListener("click", openWorkDialog);
$("#welcome-new-work").addEventListener("click", () => state.work ? openChapterDialog() : openWorkDialog());
$("#save-button").addEventListener("click", saveChapter);
$("#tidy-blank-lines-button").addEventListener("click", tidyChapterBlankLines);
$("#new-volume-button").addEventListener("click", () => openVolumeDialog());
$("#insight-button").addEventListener("click", () => showChapterInsight().catch((error) => toast(error.message, "error")));
$("#versions-button").addEventListener("click", showVersions);
$("#versions-close").addEventListener("click", () => $("#versions-dialog").close());
$("#import-history-close").addEventListener("click", () => $("#import-history-dialog").close());
$("#entity-history-close").addEventListener("click", () => $("#entity-history-dialog").close());
$("#ai-tool-call-close").addEventListener("click", () => $("#ai-tool-call-dialog").close());
$("#setting-editor-back").addEventListener("click", () => { void closeEntityEditor(); });
$("#character-editor-close").addEventListener("click", () => { void closeEntityEditor(); });
$("#character-editor-cancel").addEventListener("click", () => { void closeEntityEditor(); });
$("#knowledge-editor-close").addEventListener("click", () => { void closeEntityEditor(); });
$("#knowledge-editor-cancel").addEventListener("click", () => { void closeEntityEditor(); });
$("#setting-editor-form").addEventListener("input", markEntityEditorDirty);
$("#setting-editor-form").addEventListener("change", markEntityEditorDirty);
$("#character-editor-form").addEventListener("input", markEntityEditorDirty);
$("#character-editor-form").addEventListener("change", markEntityEditorDirty);
$("#knowledge-editor-form").addEventListener("input", markEntityEditorDirty);
$("#knowledge-editor-form").addEventListener("change", markEntityEditorDirty);
$("#character-editor-fields").addEventListener("click", (event) => {
  if (event.target.closest("[data-item-list-add], [data-structured-list-add], [data-item-list-remove], [data-structured-list-remove]")) markEntityEditorDirty();
});
$("#character-history-button").addEventListener("click", () => {
  if ($("#character-history-panel").classList.contains("hidden")) void showCharacterHistory();
  else setCharacterHistoryVisible(false);
});
$("#character-history-close").addEventListener("click", () => setCharacterHistoryVisible(false));
function cleanupExpandedRelationshipMap() {
  state.relationshipExpandedMap?.destroy?.();
  state.relationshipExpandedMap = null;
}
$("#relationship-map-close").addEventListener("click", () => $("#relationship-map-dialog").close());
$("#relationship-map-dialog").addEventListener("close", cleanupExpandedRelationshipMap);
$("#appearance-button").addEventListener("click", openAppearanceDialog);
$("#theme-toggle").addEventListener("click", () => {
  const theme = nextTheme(currentColorTheme());
  const persisted = saveColorTheme(theme);
  if (!persisted) toast("主题已切换，但当前浏览器无法保存偏好", "error");
});
window.addEventListener("storage", (event) => {
  if (event.key === THEME_STORAGE_KEY) applyColorTheme(normalizeTheme(event.newValue));
});
$("#appearance-reset").addEventListener("click", () => {
  fillAppearanceForm(typographyDefaults);
  renderTypographyPreview();
});
$("#appearance-form").addEventListener("input", renderTypographyPreview);
$("#appearance-form").addEventListener("submit", (event) => {
  if (event.submitter?.value !== "save") return;
  event.preventDefault();
  const persisted = saveTypographySettings(readAppearanceForm());
  $("#appearance-dialog").close();
  toast(persisted ? "显示设置已保存" : "显示设置已应用，但当前浏览器无法保存偏好", persisted ? "info" : "error");
});
$("#chapter-title").addEventListener("input", () => scheduleChapterAutoSave());
$("#chapter-content").addEventListener("input", (event) => {
  if (!event.isComposing) collapseChapterInputBlankLines(event.currentTarget);
  updateChapterStats();
  scheduleChapterAutoSave();
  clearChapterLineSelection();
  scheduleChapterLineNumbers();
  scheduleAiContextUsage();
});
$("#chapter-content").addEventListener("select", scheduleAiContextUsage);
$("#chapter-content").addEventListener("scroll", syncChapterLineNumberScroll);
$("#toggle-whitespace-button").addEventListener("click", () => {
  chapterWhitespaceVisible = !chapterWhitespaceVisible;
  scheduleChapterLineNumbers();
});
$("#chapter-line-numbers-inner").addEventListener("pointerdown", (event) => {
  const row = event.target.closest(".chapter-line-number");
  if (!row || event.button !== 0) return;
  event.preventDefault();
  const anchor = Number(row.dataset.lineIndex);
  chapterLineDrag = { pointerId: event.pointerId, anchor, focus: anchor };
  paintChapterLineSelection(anchor, anchor);
  $("#chapter-line-numbers-inner").setPointerCapture(event.pointerId);
});
$("#chapter-line-numbers-inner").addEventListener("pointermove", (event) => {
  if (!chapterLineDrag || event.pointerId !== chapterLineDrag.pointerId) return;
  chapterLineDrag.focus = lineIndexAtPointer(event.clientY);
  paintChapterLineSelection(chapterLineDrag.anchor, chapterLineDrag.focus);
});
const finishChapterLineDrag = (event) => {
  if (!chapterLineDrag || event.pointerId !== chapterLineDrag.pointerId) return;
  const { anchor, focus, pointerId } = chapterLineDrag;
  chapterLineDrag = null;
  if ($("#chapter-line-numbers-inner").hasPointerCapture(pointerId)) $("#chapter-line-numbers-inner").releasePointerCapture(pointerId);
  selectChapterLines(Math.min(anchor, focus), Math.max(anchor, focus));
};
$("#chapter-line-numbers-inner").addEventListener("pointerup", finishChapterLineDrag);
$("#chapter-line-numbers-inner").addEventListener("pointercancel", finishChapterLineDrag);
$("#chapter-line-numbers-inner").addEventListener("contextmenu", (event) => {
  const row = event.target.closest(".chapter-line-number");
  if (row) showLineCitationMenu(event, Number(row.dataset.lineIndex));
});
$("#add-line-citation").addEventListener("click", addSelectedLinesAsCitation);
$("#left-panel-toggle").addEventListener("click", () => {
  panelLayout.leftCollapsed = !panelLayout.leftCollapsed;
  applyPanelLayout(true);
});
$("#ai-panel-toggle").addEventListener("click", () => {
  panelLayout.aiCollapsed = !panelLayout.aiCollapsed;
  applyPanelLayout(true);
});
setupPanelResize($("#left-panel-resize"), "left");
setupPanelResize($("#ai-panel-resize"), "ai");
if (typeof ResizeObserver !== "undefined") new ResizeObserver(scheduleChapterLineNumbers).observe($("#chapter-content"));
window.addEventListener("resize", () => { applyPanelLayout(); scheduleChapterLineNumbers(); });
$("#module-nav").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || button.id === "module-more-button") return;
  if (button.hasAttribute("data-work-settings")) {
    const work = state.works.find((item) => item.id === state.work?.id) ?? state.work;
    openWorkSettingsDialog(work);
    return;
  }
  if (button.dataset.module) showModule(button.dataset.module);
});
$("#module-more-button").addEventListener("click", () => setModuleNavExpanded(!moduleNavExpanded));
$("#module-create-button").addEventListener("click", () => ({ settings: openSettingEditor, characters: openCharacterEditor, races: openRaceDialog, organizations: openOrganizationDialog, timeline: openTimelineDialog, outlines: openForeshadowDialog, relationships: openRelationshipDialog, reviews: openReviewDialog, tasks: openTaskDialog })[state.module]?.());
$("#ai-prompt").addEventListener("input", async () => {
  updateAiMentionMenu();
  scheduleAiContextUsage();
  if (!findAiMention(aiPromptTextBeforeCursor())) return;
  try {
    await ensureAiReferencesLoaded();
    updateAiMentionMenu();
  } catch (error) {
    toast(`引用数据加载失败：${error.message}`, "error");
  }
});
$("#ai-prompt").addEventListener("focus", () => {
  ensureAiModelsLoaded().catch((error) => toast(`模型加载失败：${error.message}`, "error"));
});
$("#ai-model").addEventListener("focus", () => {
  ensureAiModelsLoaded().catch((error) => toast(`模型加载失败：${error.message}`, "error"));
});
$("#ai-model").addEventListener("change", scheduleAiContextUsage);
$("#ai-task").addEventListener("change", scheduleAiContextUsage);
$("#ai-scope").addEventListener("change", scheduleAiContextUsage);
$("#ai-mention-menu").addEventListener("click", (event) => {
  const button = event.target.closest("[data-ai-reference-id]");
  if (button) selectAiMention(button);
});
$("#import-file-button").addEventListener("click", (event) => {
  if (!state.work || canEditProse()) return;
  event.preventDefault();
  event.stopPropagation();
  $("#import-file").value = "";
  toast("当前权限只能编辑设定资料，不能导入正文", "error");
});
$("#import-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!state.work || !file) return;
  if (!canEditProse()) {
    event.target.value = "";
    toast("当前权限只能编辑设定资料，不能导入正文", "error");
    return;
  }
  const mode = await chooseExistingWorkImportMode(file);
  if (!mode) {
    event.target.value = "";
    return;
  }
  if (mode === "overwrite" && !(await confirmToast(
    `当前选项：覆盖正文。确认后将使用“${file.name}”替换《${state.work.title}》的现有正文目录。`,
    { title: "覆盖正文二次确认", confirmLabel: "确认覆盖" }
  ))) {
    event.target.value = "";
    return;
  }
  cancelChapterAutoSave();
  const body = new FormData();
  body.append("file", file);
  body.append("mode", mode);
  body.append("expectedVersionNo", String(state.work.versionNo));
  try {
    const result = await api(`/api/works/${state.work.id}/import`, { method: "POST", body });
    setSaveState(mode === "append" ? "已追加" : "已覆盖");
    state.work = result.tree;
    renderTree();
    const completion = mode === "append" ? "正文追加完成" : "正文覆盖完成";
    toast(result.warnings.length ? `${completion}：${result.warnings.join("；")}` : completion);
    if (result.firstImportedChapterId) await selectChapter(result.firstImportedChapterId);
  } catch (error) {
    toast(error.message, "error");
    if (state.dirty) scheduleChapterAutoSave();
  }
  event.target.value = "";
});
$("#new-import-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  const metadata = state.pendingImportMeta;
  if (!file || !metadata) return;
  const body = new FormData();
  body.append("file", file);
  body.append("title", metadata.title ?? "");
  body.append("author", metadata.author ?? "");
  body.append("description", metadata.description ?? "");
  try {
    const result = await api("/api/works/import", { method: "POST", body });
    toast(result.warnings.length ? `作品已导入：${result.warnings.join("；")}` : "作品已导入");
    await loadWorks(result.work.id);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.pendingImportMeta = null;
    event.target.value = "";
  }
});
$("#cover-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  const workId = state.pendingCoverWorkId;
  if (!file || !workId) return;
  const body = new FormData();
  body.append("file", file);
  try {
    await api(`/api/works/${workId}/cover`, { method: "PUT", body });
    state.works = (await apiPage("/api/works")).items;
    const updated = state.works.find((item) => item.id === workId);
    const coverField = $("#dialog-fields")?.querySelector(".work-cover-field");
    if (updated && coverField && $("#form-dialog")?.open) {
      coverField.outerHTML = workCoverFieldHtml(updated);
      bindWorkCoverControls(updated);
    }
    renderShelf();
    toast("封面已更新");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.pendingCoverWorkId = null;
    event.target.value = "";
  }
});
$("#chapter-type-menu").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-chapter-type]");
  const chapterId = state.contextChapterId;
  if (!button || !chapterId) return;
  const chapterType = button.dataset.chapterType;
  closeChapterTypeMenu();
  try {
    const updated = await api(`/api/chapters/${chapterId}`, { method: "PATCH", body: { chapterType } });
    for (const volume of state.work.volumes) {
      const chapter = volume.chapters.find((item) => item.id === chapterId);
      if (chapter) chapter.chapterType = updated.chapterType;
    }
    if (state.chapter?.id === chapterId) state.chapter.chapterType = updated.chapterType;
    renderTree();
    toast(`章节类型已标记为“${chapterType}”`);
  } catch (error) {
    toast(error.message, "error");
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("#chapter-type-menu")) closeChapterTypeMenu();
  if (!event.target.closest("#line-citation-menu")) closeLineCitationMenu();
  if (!event.target.closest(".prompt-composer")) hideAiMentionMenu();
  if (!event.target.closest("#account-button") && !event.target.closest("#account-menu")) {
    $("#account-menu").classList.add("hidden");
    $("#account-button").setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeChapterTypeMenu();
    closeLineCitationMenu();
    hideAiMentionMenu();
  }
});
$("#ai-send").addEventListener("click", sendAi);
$("#ai-new-conversation").addEventListener("click", async () => {
  const button = $("#ai-new-conversation");
  button.disabled = true;
  try {
    await createNewAiConversation();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});
$("#ai-context-compact").addEventListener("click", async () => {
  const requestScope = currentAiRequestScope();
  const modelId = $("#ai-model").value;
  if (!requestScope || !modelId) return toast("请先选择章节和模型", "error");
  const button = $("#ai-context-compact");
  button.disabled = true;
  button.textContent = "压缩中";
  try {
    const conversationId = await ensureAiConversation();
    const result = await api(`/api/ai-conversations/${conversationId}/compact`, {
      method: "POST",
      body: { modelId, scope: requestScope.scope }
    });
    hideAiContextWarning();
    toast(result.changed ? `已整理 ${result.compactedMessageCount} 条较早消息为长期记忆` : "当前没有需要整理的较早消息");
    await refreshAiContextUsage();
  } catch (error) {
    toast(`上下文压缩失败：${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = "压缩上下文";
  }
});
$("#ai-context-new-conversation").addEventListener("click", async () => {
  try {
    await createNewAiConversation();
    hideAiContextWarning();
  } catch (error) {
    toast(error.message, "error");
  }
});
$("#ai-context-dismiss").addEventListener("click", hideAiContextWarning);
$("#ai-history-toggle").addEventListener("click", async () => {
  if ($("#ai-history-dialog").open) return setAiHistoryVisible(false);
  try {
    await ensureAiConversationsLoaded();
    setAiHistoryVisible(true);
  } catch (error) {
    toast(`对话历史加载失败：${error.message}`, "error");
  }
});
$("#ai-history-close").addEventListener("click", () => setAiHistoryVisible(false));
$("#ai-history-dialog").addEventListener("close", () => {
  $("#ai-history-toggle").setAttribute("aria-expanded", "false");
});
$("#ai-prompt").addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#ai-mention-menu").classList.contains("hidden")) {
    event.preventDefault();
    hideAiMentionMenu();
    return;
  }
  if (shouldSendAiPrompt(event)) {
    event.preventDefault();
    if (!$("#ai-send").disabled) void sendAi();
  }
});
$(".quick-actions").addEventListener("click", (event) => {
  const button = event.target.closest("[data-task]");
  if (!button) return;
  $("#ai-task").value = button.dataset.task;
  setAiPromptText(button.dataset.prompt);
  $("#ai-prompt").focus();
});
$("#top-search-button").addEventListener("click", () => {
  openSearchDialog().catch((error) => toast(error.message, "error"));
});
$("#search-dialog-close").addEventListener("click", () => $("#search-dialog").close());
$("#search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await runWorkSearch().catch((error) => {
    $("#search-results").innerHTML = `<p class="search-results-status">${esc(error.message)}</p>`;
  });
});
$("#export-button").addEventListener("click", () => {
  if (state.work) window.location.href = `/api/works/${state.work.id}/export?format=markdown`;
});
window.addEventListener("beforeunload", (event) => { if (state.dirty || entityEditorDirty || characterSectionEditorDirty) event.preventDefault(); });

initializePage().catch((error) => {
  restoringPageRoute = false;
  showShelf();
  toast(`系统初始化失败：${error.message}`, "error");
});
