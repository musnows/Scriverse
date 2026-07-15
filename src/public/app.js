import { buildRelationshipGraph, createGalaxyRenderer, renderRelationshipMindMap } from "/relationship-graph.js?v=20260714-no-edge-focus-ring";
import { collapseExcessBlankLines, formatDateTime, normalizeParagraphSpacing } from "/text-formatting.js?v=20260713-saved-at-seconds";
import { renderMarkdown } from "/markdown.js?v=20260712-chat-markdown";
import { applyAiMention, buildAiReferenceScope, findAiMention, listAiMentionOptions } from "/ai-mentions.js?v=20260713-at-references";
import { shouldShowAiQuickActions } from "/ai-conversation.js?v=20260713-quick-actions";
import { calculateLineNumberRowHeight, calculateLineNumberRowTop, calculateLineNumberTextOffset, calculateLineNumberTop } from "/line-number-layout.js?v=20260713-row-box-alignment";
import { MODEL_PURPOSE_OPTIONS, modelFormValues, modelOptionLabel, modelPayload } from "/model-config.js?v=20260713-model-purpose-picker";
import { shouldSendAiPrompt } from "/ai-prompt-keyboard.js?v=20260713-enter-to-send";
import { estimateAiMessageTokens, formatAiMessageMeta } from "/ai-message-meta.js?v=20260713-persisted-output-tokens";
import { formatAiMessageTime } from "/ai-message-time.js?v=20260713-cross-day-time";
import { formatAiContextUsageTooltip } from "/ai-context-meter.js?v=20260713-hover-usage";
import { copyAiRawMarkdown } from "/ai-message-actions.js?v=20260713-copy-raw-markdown";
import { THEME_STORAGE_KEY, nextTheme, normalizeTheme, themeToggleLabel } from "/theme.js?v=20260713-dark-mode";
import { buildCharacterDetails, buildCharacterSections, buildCharacterState, characterStateEntries, normalizeCharacterDetails, normalizeCharacterSections } from "/character-profile.js?v=20260713-character-editor";
import { characterVersionSourceLabel, describeCharacterVersionChanges } from "/character-version.js?v=20260713-character-history";
import { VERSIONED_ENTITY_LABELS, entityVersionSnapshotSummary, entityVersionSourceLabel } from "/entity-version.js?v=20260714-all-knowledge-history";
import { parsePageRoute, serializePageRoute } from "/page-route.js?v=20260714-refresh-restore";

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
  includeBookSummary: false,
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

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const platformDocumentTitle = "叙界 · 小说 AI 创作工作台";
const panelLayoutStorageKey = "ai-novel-panel-layout-v1";
const panelLayoutDefaults = Object.freeze({ leftWidth: 280, aiWidth: 360, leftCollapsed: false, aiCollapsed: false });
let restoringPageRoute = true;
let memberDialogWork = null;

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
let chapterAutoSaveTimer = null;
let chapterSaveInFlight = null;
let lastSavedChapterSnapshot = null;
let moduleNavExpanded = false;
const chapterAutoSaveDelay = 800;
let aiMentionMatch = null;
let settingsReturnContext = null;
let characterEditorItem = null;
let characterEditorVersions = [];
let entityHistoryContext = null;

function setModuleNavExpanded(expanded) {
  moduleNavExpanded = expanded;
  $("#module-more-button").textContent = expanded ? "收起" : "更多";
  $("#module-more-button").setAttribute("aria-expanded", String(expanded));
  $("#module-nav").querySelectorAll(".module-nav-secondary").forEach((button) => button.classList.toggle("hidden", !expanded));
}

function syncChapterLineNumberScroll() {
  const input = $("#chapter-content");
  const inner = $("#chapter-line-numbers-inner");
  if (!input || !inner) return;
  inner.style.transform = `translateY(${-input.scrollTop}px)`;
  inner.dataset.scrollTop = String(input.scrollTop);
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

function renderAiReferences() {
  const host = $("#ai-references");
  host.replaceChildren();
  host.classList.toggle("hidden", state.aiReferences.length === 0);
  for (const reference of state.aiReferences) {
    const chip = document.createElement("span");
    chip.className = "ai-reference-chip";
    const label = document.createElement("span");
    label.textContent = `${reference.kind === "character" ? "角色" : "设定"} · ${reference.name}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `移除引用 ${reference.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.aiReferences = state.aiReferences.filter((item) => !(item.kind === reference.kind && item.id === reference.id));
      renderAiReferences();
    });
    chip.append(label, remove);
    host.append(chip);
  }
  scheduleAiContextUsage();
}

function renderBookSummaryReference() {
  const button = $("#ai-book-summary-reference");
  button.setAttribute("aria-pressed", String(state.includeBookSummary));
  button.classList.toggle("is-active", state.includeBookSummary);
  button.textContent = state.includeBookSummary ? "已引用全书概要" : "引用全书概要";
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

function setAiHistoryVisible(visible) {
  $("#ai-history-panel").classList.toggle("hidden", !visible);
  $("#ai-history-toggle").setAttribute("aria-expanded", String(visible));
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
  if (!state.work) return;
  state.aiConversations = await api(`/api/works/${state.work.id}/ai-conversations`);
  renderAiConversationHistory();
  if (openLatest && state.aiConversations.length) await openAiConversation(state.aiConversations[0].id, false);
  else {
    const current = state.aiConversations.find((conversation) => conversation.id === state.aiConversationId);
    if (current) $("#ai-conversation-title").textContent = current.title;
  }
}

async function openAiConversation(conversationId, hideHistory = true) {
  const conversation = await api(`/api/ai-conversations/${conversationId}`);
  state.aiConversationId = conversation.id;
  state.aiPromptSent = conversation.messages.some((message) => message.role === "user");
  $("#ai-conversation-title").textContent = conversation.title;
  resetAiFeed();
  for (const message of conversation.messages) appendMessage(message.role, message.content, message.citations, message.createdAt, message.metadata, message.id);
  state.aiCitations = [];
  state.aiReferences = [];
  state.includeBookSummary = false;
  $("#ai-prompt").value = "";
  renderAiCitations();
  renderAiReferences();
  renderBookSummaryReference();
  renderAiQuickActions();
  renderAiConversationHistory();
  if (hideHistory) setAiHistoryVisible(false);
}

async function createNewAiConversation() {
  if (!state.work) return;
  const conversation = await api(`/api/works/${state.work.id}/ai-conversations`, { method: "POST", body: {} });
  state.aiConversationId = conversation.id;
  state.aiPromptSent = false;
  $("#ai-conversation-title").textContent = conversation.title;
  resetAiFeed();
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

function hideAiMentionMenu() {
  aiMentionMatch = null;
  $("#ai-mention-menu").classList.add("hidden");
}

function syncAiReferencesWithPrompt() {
  const prompt = $("#ai-prompt");
  const activeReferences = state.aiReferences.filter((reference) => prompt.value.includes(reference.token));
  if (activeReferences.length !== state.aiReferences.length) {
    state.aiReferences = activeReferences;
    renderAiReferences();
  }
}

function updateAiMentionMenu() {
  syncAiReferencesWithPrompt();
  const prompt = $("#ai-prompt");
  const match = findAiMention(prompt.value, prompt.selectionStart);
  if (!match) return hideAiMentionMenu();
  aiMentionMatch = match;
  const menu = $("#ai-mention-menu");
  const options = listAiMentionOptions(state.characters, state.settings, match.query);
  menu.innerHTML = options.length
    ? options.map((item) => `<button class="ai-mention-option" type="button" role="option" data-ai-reference-kind="${esc(item.kind)}" data-ai-reference-id="${esc(item.id)}" data-ai-reference-name="${esc(item.name)}"><small>${esc(item.kindLabel)}</small><strong>${esc(item.name)}</strong></button>`).join("")
    : '<p class="ai-mention-empty">没有匹配的角色或设定</p>';
  menu.classList.remove("hidden");
}

function selectAiMention(button) {
  if (!aiMentionMatch) return;
  const prompt = $("#ai-prompt");
  const result = applyAiMention(prompt.value, aiMentionMatch, button.dataset.aiReferenceName);
  const reference = {
    kind: button.dataset.aiReferenceKind,
    id: button.dataset.aiReferenceId,
    name: button.dataset.aiReferenceName,
    token: result.token
  };
  if (!state.aiReferences.some((item) => item.kind === reference.kind && item.id === reference.id)) state.aiReferences.push(reference);
  prompt.value = result.text;
  prompt.focus();
  prompt.setSelectionRange(result.cursor, result.cursor);
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

async function api(path, options = {}) {
  const method = String(options.method ?? "GET").toUpperCase();
  const headers = { ...(options.headers ?? {}) };
  if (state.csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method)) headers["X-CSRF-Token"] = state.csrfToken;
  if (!(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(path, options.body instanceof FormData ? { ...options, headers } : {
    ...options,
    headers,
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
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

function selectAuthMode(mode) {
  const login = mode === "login";
  $("#auth-login-tab").setAttribute("aria-selected", String(login));
  $("#auth-register-tab").setAttribute("aria-selected", String(!login));
  $("#login-form").classList.toggle("hidden", !login);
  $("#register-form").classList.toggle("hidden", login);
  $("#auth-error").textContent = "";
  refreshAuthCaptcha(login ? "login" : "register").catch(() => {});
}

async function refreshAuthCaptcha(target = "login") {
  const response = await fetch("/api/auth/captcha", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("无法加载验证码");
  const challenge = (await response.json()).data;
  const prefix = target === "register" ? "register" : "login";
  $(`#${prefix}-captcha-id`).value = challenge.captchaId;
  $(`#${prefix}-captcha-image`).src = challenge.imageDataUrl;
  const answerInput = $(`#${prefix}-form`).querySelector('input[name="captchaAnswer"]');
  if (answerInput) answerInput.value = "";
}

function showAuth(setupRequired, registrationOpen = true) {
  document.body.classList.add("auth-pending");
  $("#auth-view").classList.remove("hidden");
  $("#auth-title").textContent = setupRequired ? "创建首个管理员账户" : "登录后继续创作";
  $("#auth-description").textContent = setupRequired
    ? "这是首次启动。首个注册用户会成为系统管理员，并接管现有作品。"
    : "你的作品、协作权限和每一次修改都会绑定到账户。";
  const canRegister = setupRequired || registrationOpen;
  $("#auth-register-tab").classList.toggle("hidden", !canRegister);
  selectAuthMode(setupRequired ? "register" : "login");
}

function applyAuthenticatedUser(session) {
  state.user = session.user;
  state.csrfToken = session.csrfToken;
  $("#account-name").textContent = session.user.displayName;
  $("#account-avatar").textContent = Array.from(session.user.displayName)[0] ?? "作";
  $("#account-menu-name").textContent = `${session.user.displayName} · @${session.user.username}`;
  $("#account-menu-role").textContent = session.user.role === "admin" ? "系统管理员" : "普通用户";
  $("#auth-view").classList.add("hidden");
  document.body.classList.remove("auth-pending");
}

async function initializeAuthentication() {
  const response = await fetch("/api/auth/session", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("无法读取登录状态");
  const session = (await response.json()).data;
  if (!session.authenticated) {
    showAuth(session.setupRequired, session.registrationOpen !== false);
    return false;
  }
  applyAuthenticatedUser(session);
  return true;
}

function toast(message, type = "info") {
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.textContent = message;
  $("#toast-region").append(element);
  setTimeout(() => element.remove(), 3600);
}

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
  if (!state.chapter) return;
  cancelChapterAutoSave();
  setSaveState("等待自动保存", true);
  chapterAutoSaveTimer = setTimeout(() => {
    chapterAutoSaveTimer = null;
    persistChapter({ automatic: true });
  }, delay);
}

async function persistChapter({ automatic = false } = {}) {
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

function confirmDiscardChanges(message = "当前章节有未保存修改，继续将丢弃这些修改。是否继续？") {
  if (!state.dirty) return true;
  return window.confirm(message);
}

function updateDocumentTitle(work = null) {
  const workTitle = String(work?.title ?? "").trim();
  document.title = workTitle ? `${workTitle} · 叙界` : platformDocumentTitle;
}

async function loadWorks(preferredId) {
  state.works = await api("/api/works");
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
  state.works = await api("/api/works");
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
      state.module = route.view === "module" ? route.module : "editor";
      await selectWork(requestedWork.id);
    }

    if (route.view === "editor") {
      const chapterExists = state.work?.volumes.some((volume) => volume.chapters.some((chapter) => chapter.id === route.chapterId));
      if (route.chapterId && chapterExists && state.chapter?.id !== route.chapterId) await selectChapter(route.chapterId);
      return;
    }
    if (route.view === "module") return;
    if (route.view === "welcome") {
      showWelcome(true);
      return;
    }
    if (route.view === "settings") {
      showSettingsHub();
      settingsReturnContext = restoredSettingsReturnContext(route);
      renderSettingsHub();
      return;
    }
    if (route.view === "platform-ai") {
      await showPlatformAi();
      settingsReturnContext = restoredSettingsReturnContext(route);
    }
  } finally {
    restoringPageRoute = false;
    replacePageRoute(currentPageRoute());
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
  const isAdmin = state.user?.role === "admin";
  $("#platform-ai-button").classList.toggle("hidden", !isAdmin);
  $("#user-management-button").classList.toggle("hidden", !isAdmin);
  $("#collaboration-button").disabled = !canManageWork;
  $("#top-search-button").disabled = !hasWork;
  $("#export-button").disabled = !hasWork;
  $("#settings-return").textContent = settingsReturnContext?.view === "shelf" || !hasWork ? "返回书架" : "返回当前作品";
  $("#settings-work-note").textContent = hasWork
    ? `当前作品：《${state.work.title}》。导出将作用于这部作品。`
    : "当前未选择作品；打开作品后可使用导出。";
}

function renderUsers(users) {
  const currentUserId = state.user?.userId;
  $("#users-list").innerHTML = users.map((user) => `<article class="access-row" data-user-row="${esc(user.userId)}">
    <div><strong>${esc(user.displayName)} · @${esc(user.username)}</strong><small>${user.userId === currentUserId ? "当前账户 · " : ""}${user.status === "active" ? "账户可用" : "账户已停用"}</small></div>
    <select data-user-role="${esc(user.userId)}" aria-label="${esc(user.displayName)}的角色" ${user.userId === currentUserId ? "disabled" : ""}><option value="user" ${user.role === "user" ? "selected" : ""}>普通用户</option><option value="admin" ${user.role === "admin" ? "selected" : ""}>系统管理员</option></select>
    <button type="button" data-user-status="${esc(user.userId)}" ${user.userId === currentUserId ? "disabled" : ""}>${user.status === "active" ? "停用" : "启用"}</button>
  </article>`).join("");
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
  try { renderUsers(await api("/api/users")); }
  catch (error) { $("#users-dialog").close(); toast(error.message, "error"); }
}

function renderMembers(members) {
  const work = memberDialogWork ?? state.work;
  const canManage = ["admin", "owner"].includes(String(work?.accessRole));
  $("#members-list").innerHTML = members.map((member) => `<article class="access-row">
    <div><strong>${esc(member.displayName)} · @${esc(member.username)}</strong><small>${member.role === "owner" ? "作品创建者" : "协作者"}${member.status === "disabled" ? " · 已停用" : ""}</small></div>
    <span>${member.role === "owner" ? "所有者" : "可编辑"}</span>
    ${member.role === "owner" || !canManage ? "<span></span>" : `<button type="button" data-remove-member="${esc(member.userId)}">移除</button>`}
  </article>`).join("");
  $("#members-list").querySelectorAll("[data-remove-member]").forEach((button) => button.addEventListener("click", async () => {
    if (!work) return;
    try {
      const updated = await api(`/api/works/${encodeURIComponent(work.id)}/members/${encodeURIComponent(button.dataset.removeMember)}`, { method: "DELETE" });
      renderMembers(updated);
      await fillMemberCandidates(updated);
      toast("协作者已移除");
    } catch (error) { toast(error.message, "error"); }
  }));
}

async function fillMemberCandidates(members) {
  const directory = await api("/api/users/directory");
  const memberIds = new Set(members.map((member) => member.userId));
  const candidates = directory.filter((user) => !memberIds.has(user.userId));
  $("#member-user-select").innerHTML = candidates.length
    ? `<option value="">选择用户</option>${candidates.map((user) => `<option value="${esc(user.userId)}">${esc(user.displayName)} · @${esc(user.username)}</option>`).join("")}`
    : '<option value="">没有可邀请的用户</option>';
  $("#member-user-select").disabled = !candidates.length;
}

async function openMembersDialog(targetWork = state.work) {
  if (!targetWork) return;
  memberDialogWork = targetWork;
  const canManage = ["admin", "owner"].includes(String(targetWork.accessRole));
  $("#members-dialog-eyebrow").textContent = `作品权限 · 《${targetWork.title}》`;
  $("#members-dialog-title").textContent = "可访问人";
  $("#members-list").innerHTML = '<p class="empty-state">正在读取成员……</p>';
  $("#member-invite-form").classList.toggle("hidden", !canManage);
  $("#members-dialog").showModal();
  try {
    const members = await api(`/api/works/${encodeURIComponent(targetWork.id)}/members`);
    renderMembers(members);
    if (canManage) await fillMemberCandidates(members);
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
    if (character) openCharacterDialog(character);
    return;
  }
  if (result.type === "setting") {
    await showModule("settings");
    const setting = await api(`/api/settings/${encodeURIComponent(result.id)}`);
    openSettingDialog(setting);
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

function showSettingsHub() {
  const alreadyInSettings = !$("#settings-hub-view").classList.contains("hidden") || !$("#platform-ai-view").classList.contains("hidden");
  if (!alreadyInSettings) {
    if (state.dirty && !confirmDiscardChanges("当前章节有未保存修改，进入设置将放弃本地修改。是否继续？")) return false;
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
  if (state.dirty && !confirmDiscardChanges("当前章节有未保存修改，进入平台 AI 管理将放弃本地修改。是否继续？")) return false;
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
        <span class="book-info"><strong>${esc(work.title)}</strong><small>${esc(work.author || "未署名")} · ${work.chapterCount} 章 · ${work.wordCount} 字</small><span>${esc(work.description || "尚未填写作品简介")}</span><em class="book-access-badge">${work.accessRole === "editor" ? "协作作品" : work.accessRole === "admin" ? "管理员访问" : "我的作品"}</em></span>
      </button>
      <button class="book-card-settings" type="button" data-edit-work="${esc(work.id)}" aria-label="作品设置" title="作品设置">设置</button>
    </article>`).join("")}
    <button class="book-card book-add-card" id="book-add-card" type="button" aria-label="新建作品" data-testid="book-add-card"><span>＋</span><strong>新建作品</strong><small>从零开始或导入 TXT / DOCX</small></button>`;
  shelf.querySelectorAll("[data-open-work]").forEach((button) => button.addEventListener("click", () => selectWork(button.dataset.openWork)));
  shelf.querySelectorAll("[data-edit-work]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    openWorkSettingsDialog(state.works.find((work) => work.id === button.dataset.editWork));
  }));
  $("#book-add-card").addEventListener("click", openWorkDialog);
}

async function selectWork(workId) {
  const discarding = state.work?.id !== workId && state.dirty;
  if (discarding && !confirmDiscardChanges()) return false;
  const nextWork = await api(`/api/works/${workId}`);
  if (state.work?.id !== nextWork.id) {
    state.aiCitations = [];
    state.aiReferences = [];
    state.includeBookSummary = false;
    state.aiPromptSent = false;
    state.aiConversationId = null;
    state.aiConversations = [];
    renderAiCitations();
    renderAiReferences();
    renderBookSummaryReference();
    renderAiQuickActions();
    resetAiFeed();
    $("#ai-conversation-title").textContent = "新对话";
    renderAiConversationHistory();
  }
  if (discarding) setSaveState("就绪");
  $("#app").classList.remove("shelf-mode");
  $("#shelf-view").classList.add("hidden");
  $("#platform-ai-view").classList.add("hidden");
  $("#settings-hub-view").classList.add("hidden");
  $("#settings-button").removeAttribute("aria-current");
  settingsReturnContext = null;
  state.work = nextWork;
  state.chapter = null;
  updateDocumentTitle(state.work);
  $("#work-meta").textContent = `${state.work.title}${state.work.author ? ` · ${state.work.author}` : ""} · ${state.work.wordCount} 字`;
  $("#top-search-button").disabled = false;
  renderTree();
  await loadModels();
  await loadAiReferences();
  await loadAiConversations();
  const firstChapter = state.work.volumes.flatMap((volume) => volume.chapters)[0];
  if (state.module === "editor" && firstChapter) await selectChapter(firstChapter.id);
  else if (state.module === "editor") showWelcome(true);
  else await showModule(state.module);
  return true;
}

function renderTree() {
  if (!state.work) return;
  const count = state.work.volumes.reduce((total, volume) => total + volume.chapters.length, 0);
  $("#chapter-count").textContent = `${count} 章`;
  $("#novel-tree").classList.remove("empty-copy");
  $("#novel-tree").innerHTML = state.work.volumes.map((volume) => `
    <div class="volume-node ${state.collapsedVolumeIds.has(volume.id) ? "is-collapsed" : ""}" data-volume-id="${esc(volume.id)}">
      <button class="volume-title" type="button" data-volume-toggle="${esc(volume.id)}" aria-expanded="${state.collapsedVolumeIds.has(volume.id) ? "false" : "true"}" title="左键折叠，右键设置分卷"><span>${esc(volume.title)}</span><span>${volume.chapters.length} 章</span></button>
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
      event.preventDefault();
      openVolumeDialog(state.work.volumes.find((volume) => volume.id === button.dataset.volumeToggle));
    });
  });
  $("#novel-tree").querySelectorAll("[data-chapter-id]").forEach((button) => {
    button.addEventListener("click", () => selectChapter(button.dataset.chapterId));
    button.addEventListener("contextmenu", (event) => {
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
  if (state.chapter?.id !== chapterId && !confirmDiscardChanges("当前章节有未保存修改，仍要切换吗？")) return;
  cancelChapterAutoSave();
  state.chapter = await api(`/api/chapters/${chapterId}`);
  lastSavedChapterSnapshot = { chapterId: state.chapter.id, title: state.chapter.title, content: state.chapter.content };
  state.module = "editor";
  markActiveModule("editor");
  $("#welcome-view").classList.add("hidden");
  $("#module-view").classList.add("hidden");
  $("#editor-view").classList.remove("hidden");
  const volume = state.work.volumes.find((item) => item.id === state.chapter.volumeId);
  $("#chapter-path").textContent = `${volume?.title ?? "正文"} / 保存于 ${formatDateTime(state.chapter.updatedAt)}`;
  $("#chapter-title").value = state.chapter.title;
  const normalizedContent = normalizeParagraphSpacing(state.chapter.content);
  const spacingChanged = normalizedContent !== state.chapter.content;
  $("#chapter-content").value = normalizedContent;
  clearChapterLineSelection();
  scheduleChapterLineNumbers();
  $("#chapter-insight").classList.add("hidden");
  updateChapterStats();
  if (spacingChanged) scheduleChapterAutoSave(120);
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
  tasks: ["增量分析", "分析任务", "正文变化后只重算受影响的章节与知识对象。", "新建任务"],
  "ai-settings": ["书籍提示词", "本书 AI 设置", "本书系统提示词会追加在内置提示词和平台全局提示词之后；任务默认模型只作用于当前作品。", "保存设置"]
};

async function showModule(module) {
  if (!state.work) return showWelcome();
  if (module !== "editor" && state.module === "editor" && !confirmDiscardChanges()) return;
  if (module !== "editor" && state.module === "editor" && state.dirty) setSaveState("已放弃修改");
  state.module = module;
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
  $("#module-create-button").classList.toggle("hidden", module === "ai-settings");
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

async function renderSettings() {
  const records = await api(`/api/works/${state.work.id}/settings`);
  $("#module-content").innerHTML = records.length ? `<div class="card-grid">${records.map((item) => `
    <article class="record-card"><small>${esc(item.category)} · ${item.locked ? "已锁定" : esc(item.status)}</small>
    <h3>${esc(item.title)}</h3><p>${esc(item.content)}</p>
    <div class="card-actions"><button data-edit-setting="${esc(item.id)}">编辑</button><button data-entity-history="setting" data-entity-id="${esc(item.id)}" data-entity-title="${esc(item.title)}">版本历史</button></div></article>`).join("")}</div>`
    : emptyModule("还没有世界观设定", "新建规则、地点、组织、科技或创作约束。AI 提取的候选也会进入这里。");
  $("#module-content").querySelectorAll("[data-edit-setting]").forEach((button) => button.addEventListener("click", () => openSettingDialog(records.find((item) => item.id === button.dataset.editSetting))));
  bindEntityHistoryButtons(async () => { await renderSettings(); await loadAiReferences(); });
}

async function renderCharacters() {
  [state.characters, state.races, state.organizations] = await Promise.all([
    api(`/api/works/${state.work.id}/characters`),
    api(`/api/works/${state.work.id}/races`),
    api(`/api/works/${state.work.id}/organizations`)
  ]);
  $("#module-content").innerHTML = state.characters.length ? `<div class="card-grid">${state.characters.map((item) => {
    const details = normalizeCharacterDetails(item.attributes?.details);
    const sections = normalizeCharacterSections(item.profile?.sections);
    return `
    <article class="record-card character-card" data-open-character="${esc(item.id)}" role="button" tabindex="0" aria-label="查看角色 ${esc(item.name)}"><small>${item.lockedFields.length ? `锁定 ${item.lockedFields.length} 项` : esc(item.visibility)}</small>
    <h3>${esc(item.name)}</h3><div>${item.aliases.map((alias) => `<span class="pill">${esc(alias)}</span>`).join("")}</div>
    ${item.species ? `<div class="character-species"><b>种族</b><span class="pill">${esc(item.species)}</span></div>` : ""}
    ${item.attributes?.identity ? `<p class="character-identity">${esc(item.attributes.identity)}</p>` : ""}
    ${details.length ? `<dl class="character-detail-list">${details.slice(0, 4).map((detail) => `<div><dt>${esc(detail.label)}</dt><dd>${esc(detail.value)}</dd></div>`).join("")}</dl>` : ""}
    <div class="organization-links"><b>所属组织</b>${(item.organizations ?? []).length ? item.organizations.map((organization) => `<span class="pill organization-pill">${esc(organization.name)}</span>`).join("") : '<span class="organization-empty">未加入组织</span>'}</div>
    ${item.profile?.summary ? `<p class="character-summary">${esc(item.profile.summary)}</p>` : `<p>${esc(Object.entries(item.currentState).map(([key, value]) => `${key}：${value}`).join("\n") || "尚未记录当前状态")}</p>`}
    ${sections.length ? `<small class="character-section-count">${sections.length} 个设定章节</small>` : ""}
    <div class="card-actions"><button data-edit-character="${esc(item.id)}">编辑</button></div></article>`;
  }).join("")}</div>`
    : emptyModule("还没有角色档案", "创建主要人物，并维护别名、身份、动机和当前状态。");
  $("#module-content").querySelectorAll("[data-open-character]").forEach((card) => {
    const open = () => openCharacterDialog(state.characters.find((item) => item.id === card.dataset.openCharacter));
    card.addEventListener("click", (event) => { if (!event.target.closest("button")) open(); });
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
  });
  $("#module-content").querySelectorAll("[data-edit-character]").forEach((button) => button.addEventListener("click", () => openCharacterDialog(state.characters.find((item) => item.id === button.dataset.editCharacter))));
}

async function renderRaces() {
  [state.races, state.characters] = await Promise.all([
    api(`/api/works/${state.work.id}/races`),
    api(`/api/works/${state.work.id}/characters`)
  ]);
  $("#module-content").innerHTML = state.races.length ? `<div class="card-grid race-grid">${state.races.map((item) => `
    <article class="record-card race-card"><small>${item.memberIds.length} 位角色 · ${item.settings.length} 条共同设定</small>
      <h3>${esc(item.name)}</h3><p>${esc(item.description || "尚未填写种族简介")}</p>
      <div class="race-settings">${item.settings.map((setting) => `<span class="pill">${esc(setting)}</span>`).join("") || '<span class="pill">暂无共同设定</span>'}</div>
      <p class="race-members">角色：${item.members.length ? item.members.map((member) => esc(member.name)).join("、") : "暂无绑定角色"}</p>
      <div class="card-actions"><button data-edit-race="${esc(item.id)}">编辑</button><button data-entity-history="race" data-entity-id="${esc(item.id)}" data-entity-title="${esc(item.name)}">版本历史</button></div>
    </article>`).join("")}</div>` : emptyModule("还没有种族档案", "先创建种族及共同设定，之后角色编辑器才能选择该种族。");
  $("#module-content").querySelectorAll("[data-edit-race]").forEach((button) => button.addEventListener("click", () => openRaceDialog(state.races.find((item) => item.id === button.dataset.editRace))));
  bindEntityHistoryButtons(async () => { await renderRaces(); await loadAiReferences(); });
}

async function renderOrganizations() {
  [state.organizations, state.characters] = await Promise.all([
    api(`/api/works/${state.work.id}/organizations`),
    api(`/api/works/${state.work.id}/characters`)
  ]);
  $("#module-content").innerHTML = state.organizations.length ? `<div class="card-grid organization-grid">${state.organizations.map((item) => `
    <article class="record-card organization-card"><small>${item.memberIds.length} 位成员 · ${item.settings.length} 条设定</small>
      <h3>${esc(item.name)}</h3><p>${esc(item.description || "尚未填写组织简介")}</p>
      <div class="organization-settings">${item.settings.map((setting) => `<span class="pill">${esc(setting)}</span>`).join("") || '<span class="pill">暂无组织设定</span>'}</div>
      <p class="organization-members">成员：${item.members.length ? item.members.map((member) => esc(member.name)).join("、") : "暂无绑定角色"}</p>
      <div class="card-actions"><button data-edit-organization="${esc(item.id)}">编辑</button><button data-entity-history="organization" data-entity-id="${esc(item.id)}" data-entity-title="${esc(item.name)}">版本历史</button></div>
    </article>`).join("")}</div>` : emptyModule("还没有组织", "创建国家、机构、阵营或团队，并维护组织设定与成员。");
  $("#module-content").querySelectorAll("[data-edit-organization]").forEach((button) => button.addEventListener("click", () => openOrganizationDialog(state.organizations.find((item) => item.id === button.dataset.editOrganization))));
  bindEntityHistoryButtons(async () => { await renderOrganizations(); await loadAiReferences(); });
}

async function renderTimeline() {
  const [events, tracks] = await Promise.all([
    api(`/api/works/${state.work.id}/timeline`),
    api(`/api/works/${state.work.id}/timeline-tracks`)
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
      await api(`/api/works/${state.work.id}/timeline/merge`, { method: "POST", body: { eventIds, name: form.get("name"), description: form.get("description") || undefined } });
      await renderTimeline();
    }, "保留参与者与证据");
  });
}

async function renderOutlines() {
  const currentChapterId = state.chapter?.id;
  const [outlines, foreshadows] = await Promise.all([
    api(`/api/works/${state.work.id}/outlines`),
    api(`/api/works/${state.work.id}/foreshadows?status=all${currentChapterId ? `&currentChapterId=${encodeURIComponent(currentChapterId)}` : ""}`)
  ]);
  const unresolved = foreshadows.filter((item) => item.unresolved);
  const overdue = unresolved.filter((item) => item.overdue);
  const navButton = $("#module-nav [data-module=outlines]");
  navButton.textContent = unresolved.length ? `大纲与伏笔 · ${unresolved.length}` : "大纲与伏笔";
  const foreshadowHtml = foreshadows.length ? `<div class="card-grid foreshadow-grid">${foreshadows.map((item) => `
    <article class="record-card foreshadow-card ${item.overdue ? "is-overdue" : ""}">
      <small>${esc(item.importance)} · ${esc(item.status)}${item.overdue ? " · 已逾期" : ""}</small>
      <h3>${esc(item.title)}</h3><p>${esc(item.description || "暂无说明")}</p>
      <div class="foreshadow-links">${item.occurrences.length ? item.occurrences.map((link) => `<span class="pill">${esc({ setup: "埋设", reminder: "提醒", payoff: "回收" }[link.role] ?? link.role)} · ${esc(link.volumeTitle)} / ${esc(link.chapterTitle)}</span>`).join("") : '<span class="pill">尚未关联章节</span>'}</div>
      <div class="card-actions"><button data-edit-foreshadow="${esc(item.id)}">编辑伏笔</button><button data-entity-history="foreshadow" data-entity-id="${esc(item.id)}" data-entity-title="${esc(item.title)}">版本历史</button></div>
    </article>`).join("")}</div>` : emptyModule("还没有伏笔", "创建伏笔并关联埋设、提醒与回收章节，未回收项会持续显示。\n");
  const outlineHtml = outlines.length ? `<div class="outline-list">${outlines.map((item) => `
    <article class="outline-row ${item.status === "completed" ? "is-complete" : ""}">
      <div><small>${esc(item.volumeTitle)} · ${esc(item.status)}</small><h3>${esc(item.chapterTitle)}</h3></div>
      <div><b>目标</b><p>${esc(item.goal || "未填写")}</p></div>
      <div><b>冲突</b><p>${esc(item.conflict || "未填写")}</p></div>
      <div><b>转折</b><p>${esc(item.turningPoint || "未填写")}</p></div>
      <div class="outline-actions">${item.unresolvedForeshadowCount ? `<span>${item.unresolvedForeshadowCount} 个未回收伏笔</span>` : ""}<button data-edit-outline="${esc(item.chapterId)}">编辑</button><button data-entity-history="chapter-outline" data-entity-id="${esc(item.chapterId)}" data-entity-title="${esc(item.chapterTitle)}">版本历史</button></div>
    </article>`).join("")}</div>` : emptyModule("还没有章节", "先创建章节，再为每章维护目标、冲突和转折。\n");
  $("#module-content").innerHTML = `<div class="outline-summary"><article><strong>${outlines.length}</strong><span>章节规划</span></article><article><strong>${unresolved.length}</strong><span>未回收伏笔</span></article><article class="${overdue.length ? "danger-text" : ""}"><strong>${overdue.length}</strong><span>已逾期</span></article></div><section class="planning-section"><div class="section-title"><div><span class="eyebrow">伏笔追踪</span><h2>尚未回收与历史伏笔</h2></div></div>${foreshadowHtml}</section><section class="planning-section"><div class="section-title"><div><span class="eyebrow">逐章规划</span><h2>章节目标、冲突与转折</h2></div></div>${outlineHtml}</section>`;
  $("#module-content").querySelectorAll("[data-edit-outline]").forEach((button) => button.addEventListener("click", () => openOutlineDialog(outlines.find((item) => item.chapterId === button.dataset.editOutline))));
  $("#module-content").querySelectorAll("[data-edit-foreshadow]").forEach((button) => button.addEventListener("click", () => openForeshadowDialog(foreshadows.find((item) => item.id === button.dataset.editForeshadow))));
  bindEntityHistoryButtons(renderOutlines);
}

async function renderRelationships() {
  state.characters = await api(`/api/works/${state.work.id}/characters`);
  const relationships = await api(`/api/works/${state.work.id}/relationships`);
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
  const reviews = await api(`/api/works/${state.work.id}/reviews`);
  $("#module-content").innerHTML = reviews.length ? `<div class="card-grid">${reviews.map((item) => `
    <article class="record-card"><small>${esc(item.itemType)} · ${esc(item.severity)} · ${esc(item.status)}</small><h3>${esc(item.title)}</h3>
    <p>${esc(item.description)}${item.suggestion ? `\n建议：${esc(item.suggestion)}` : ""}</p>
    ${item.status === "pending" ? `<div class="card-actions"><button data-review-status="fixed" data-review-id="${esc(item.id)}">标为已修复</button><button data-review-status="ignored" data-review-id="${esc(item.id)}">忽略</button></div>` : ""}</article>`).join("")}</div>`
    : emptyModule("没有待审核事项", "候选设定、冲突与低置信度结论会集中显示在这里。");
  $("#module-content").querySelectorAll("[data-review-id]").forEach((button) => button.addEventListener("click", async () => {
    await api(`/api/reviews/${button.dataset.reviewId}`, { method: "PATCH", body: { status: button.dataset.reviewStatus } });
    await renderReviews();
  }));
}

async function renderTasks() {
  const [tasks, settings] = await Promise.all([
    api(`/api/works/${state.work.id}/tasks`),
    api(`/api/works/${state.work.id}/ai-settings`)
  ]);
  const pendingCount = tasks.filter((item) => item.status === "pending").length;
  const runningCount = tasks.filter((item) => item.status === "running").length;
  $("#module-content").innerHTML = `
    <section class="task-auto-run-panel" aria-labelledby="task-auto-run-title">
      <div class="task-auto-run-copy">
        <strong id="task-auto-run-title">自动运行</strong>
        <small>开启后按并发上限消化 pending 任务；每一轮最多自动认领「单次上限」个，跑完需再点「再跑一批」。</small>
      </div>
      <div class="task-auto-run-controls">
        <label class="checkbox-field"><input id="task-auto-run-enabled" type="checkbox" ${settings.autoRunEnabled ? "checked" : ""}><span>启用自动运行</span></label>
        <label>并发上限<input id="task-auto-run-concurrency" type="number" min="1" max="8" value="${esc(String(settings.autoRunConcurrency ?? 2))}"></label>
        <label>单次上限<input id="task-auto-run-batch-limit" type="number" min="1" max="200" value="${esc(String(settings.autoRunBatchLimit ?? 20))}"></label>
        <button id="task-auto-run-save" class="primary-button" type="button">保存并生效</button>
        <button id="task-auto-run-continue" class="ghost-button" type="button" ${settings.autoRunEnabled ? "" : "disabled"}>再跑一批</button>
      </div>
      <p class="task-auto-run-meta">当前待执行 ${pendingCount} 个 · 运行中 ${runningCount} 个</p>
    </section>
    ${tasks.length ? `<table class="table-list task-table"><thead><tr><th>任务</th><th>范围</th><th>状态</th><th>进度</th><th>操作</th></tr></thead><tbody>${tasks.map((item) => `
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
    </tr>`).join("")}</tbody></table>` : emptyModule("还没有分析任务", "保存正文时会自动创建受影响章节的待分析任务，也可手动创建全书任务。")}`;

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
        ? `自动运行已开启：并发 ${updated.autoRunConcurrency}，本轮最多 ${updated.autoRunBatchLimit} 个`
        : "自动运行已关闭");
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
      toast(`已开始新一轮自动运行，待执行 ${result.pendingCount} 个`);
      await renderTasks();
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
    }
  });

  const taskById = new Map(tasks.map((item) => [item.id, item]));
  $("#module-content").querySelectorAll("[data-task-detail]").forEach((button) => button.addEventListener("click", () => {
    openTaskDetailDialog(taskById.get(button.dataset.taskDetail));
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
    "分析任务",
    { submitLabel: "关闭", wide: true });
}

function renderProviderCards(providers, models) {
  return providers.length ? `<div class="card-grid provider-card-grid">${providers.map((provider) => `
    <article class="record-card provider-card"><small>平台级 · ${esc(provider.status)} · ${esc(provider.connectionStatus)}</small><h3>${esc(provider.name)}</h3>
    <p>${esc(provider.baseUrl)}\n密钥：${esc(provider.apiKey)}\n并发：${provider.concurrencyLimit} · RPM：${provider.rpmLimit} · max_tokens：${provider.maxTokens ?? 32000}${provider.lastError ? `\n错误：${esc(provider.lastError)}` : ""}</p>
    <div class="provider-models">${models.filter((model) => model.providerId === provider.id).map((model) => `<button class="pill model-pill" type="button" data-edit-model="${esc(model.id)}" aria-label="编辑模型 ${esc(model.displayName)}">${esc(model.displayName)} · ${model.enabled ? "启用" : "停用"} · 上下文 ${Number(model.contextWindow ?? 128000).toLocaleString("zh-CN")} Token · max_tokens ${Number(model.preset?.max_tokens ?? 32000).toLocaleString("zh-CN")}</button>`).join("")}</div>
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
  host.innerHTML = `<section class="config-section"><div class="config-section-header"><div><h2>本书系统提示词</h2><p>会追加在内置系统提示词和平台全局系统提示词之后，只影响《${esc(state.work.title)}》的 AI 请求。</p></div></div><div class="field-label"><textarea id="work-system-prompt" rows="8" aria-label="本书系统提示词" placeholder="例如：叙事使用第三人称，哥斯拉不得离开地球。">${esc(settings.systemPrompt)}</textarea></div><div class="card-actions"><button id="save-work-system-prompt" class="primary-button">保存本书提示词</button></div></section>${renderTaskDefaults(models, providers, taskDefaults)}`;
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
  if (!state.work) return;
  state.models = await api(`/api/works/${state.work.id}/models`);
  const select = $("#ai-model");
  select.innerHTML = state.models.length
    ? state.models.map((model) => `<option value="${esc(model.id)}" ${model.enabled ? "" : "disabled"}>${esc(modelOptionLabel(model))}</option>`).join("")
    : '<option value="">请先配置模型</option>';
  scheduleAiContextUsage();
}

let aiContextUsageTimer = null;
let aiContextUsageRequest = 0;

function currentAiRequestScope() {
  if (!state.work || !state.chapter) return null;
  const taskType = $("#ai-task").value;
  const scopeType = $("#ai-scope").value;
  const selection = $("#chapter-content").value.slice($("#chapter-content").selectionStart, $("#chapter-content").selectionEnd);
  const volume = state.work.volumes.find((item) => item.id === state.chapter.volumeId);
  const scope = scopeType === "book" ? { type: "book" }
    : scopeType === "volume" ? { type: "volume", volumeId: volume?.id }
    : scopeType === "selection" ? { type: "selection", chapterId: state.chapter.id, selection }
    : { type: "chapter", chapterId: state.chapter.id, ...(taskType === "polish" ? { selection } : {}) };
  Object.assign(scope, buildAiReferenceScope(state.aiReferences));
  if (state.includeBookSummary) scope.includeBookSummary = true;
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
  if (!requestScope || !modelId || ((requestScope.scope.type === "selection" || requestScope.taskType === "polish") && !requestScope.selection)) {
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
        instruction: $("#ai-prompt").value,
        citations
      }
    });
    if (requestId === aiContextUsageRequest) setAiContextMeter(usage);
  } catch {
    if (requestId === aiContextUsageRequest) setAiContextMeter(null);
  }
}

async function loadAiReferences() {
  if (!state.work) return;
  [state.characters, state.settings] = await Promise.all([
    api(`/api/works/${state.work.id}/characters`),
    api(`/api/works/${state.work.id}/settings`)
  ]);
}

function field(name, label, type = "text", value = "", options = []) {
  if (type === "textarea") return `<label>${esc(label)}<textarea name="${esc(name)}">${esc(value)}</textarea></label>`;
  if (type === "item-list") {
    const values = Array.isArray(value) && value.length ? value : [""];
    return `<div class="form-field item-list-field"><span>${esc(label)}</span><div class="item-list-rows" data-item-list-rows data-name="${esc(name)}" data-label="${esc(label)}">${values.map((item) => `<div class="item-list-row"><input name="${esc(name)}" value="${esc(item)}" aria-label="${esc(label)}"><button type="button" data-item-list-remove aria-label="删除此条">删除</button></div>`).join("")}</div><button class="item-list-add" type="button" data-item-list-add>添加一条</button></div>`;
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

function openDialog(title, fields, onSubmit, eyebrow = "新增", options = {}) {
  $("#dialog-title").textContent = title;
  $("#dialog-eyebrow").textContent = eyebrow;
  $("#dialog-fields").innerHTML = fields;
  $("#dialog-submit").textContent = options.submitLabel ?? "保存";
  $("#form-dialog").classList.toggle("wide-dialog", Boolean(options.wide));
  bindDynamicListControls($("#dialog-fields"));
  const form = $("#dynamic-form");
  form.onsubmit = async (event) => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    const submit = $("#dialog-submit");
    submit.disabled = true;
    try {
      await onSubmit(new FormData(form));
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
      state.works = await api("/api/works");
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
  const accessField = `<section class="work-access-field" aria-labelledby="work-access-title">
    <div><strong id="work-access-title">可访问人</strong><small>作品创建者和受邀协作者可以访问并共同编辑这部作品。</small></div>
    ${canManageAccess ? '<button id="work-access-manage" class="ghost-button" type="button">添加或管理可访问人</button>' : '<small>仅作品创建者或系统管理员可以调整访问权限。</small>'}
  </section>`;
  openDialog("作品信息",
    workCoverFieldHtml(work) + field("title", "作品名称", "text", work.title) + field("author", "作者", "text", work.author) + field("description", "简介", "textarea", work.description) + accessField,
    async (form) => {
      await api(`/api/works/${work.id}`, { method: "PATCH", body: { title: form.get("title"), author: form.get("author"), description: form.get("description") } });
      state.works = await api("/api/works");
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
  $("#work-access-manage")?.addEventListener("click", () => {
    $("#form-dialog").close();
    openMembersDialog(work);
  });
}

async function openChapterDialog() {
  if (!state.work) return openWorkDialog();
  if (!state.work.volumes.length) {
    await api(`/api/works/${state.work.id}/volumes`, { method: "POST", body: { title: "正文", kind: "main" } });
    state.work = await api(`/api/works/${state.work.id}`);
    renderTree();
  }
  openDialog("新建章节", field("title", "章节标题") + field("volumeId", "所属卷", "select", state.work.volumes[0].id, state.work.volumes.map((volume) => [volume.id, volume.title])) + field("chapterType", "章节类型", "select", "正文", chapterTypes.map((value) => [value, value])), async (form) => {
    const chapter = await api(`/api/works/${state.work.id}/chapters`, { method: "POST", body: { title: form.get("title"), volumeId: form.get("volumeId"), chapterType: form.get("chapterType"), content: "" } });
    state.work = await api(`/api/works/${state.work.id}`);
    await selectChapter(chapter.id);
  });
}

function openVolumeDialog(item) {
  if (!state.work) return openWorkDialog();
  const kindOptions = [["main", "正文卷"], ["prequel", "前传"], ["extra", "番外"], ["epilogue", "后记"], ["appendix", "附录"]];
  openDialog(item ? "编辑分卷" : "新建分卷",
    field("title", "分卷名称", "text", item?.title) +
    field("kind", "分卷类型", "select", item?.kind ?? "main", kindOptions) +
    field("description", "分卷简介", "textarea", item?.description) +
    field("keywords", "分卷关键词（逐条填写）", "item-list", item?.keywords ?? []),
    async (form) => {
      const body = {
        title: form.get("title"),
        kind: form.get("kind"),
        description: form.get("description"),
        keywords: form.getAll("keywords").map((value) => String(value).trim()).filter(Boolean)
      };
      await api(item ? `/api/volumes/${item.id}` : `/api/works/${state.work.id}/volumes`, { method: item ? "PATCH" : "POST", body });
      state.work = await api(`/api/works/${state.work.id}`);
      renderTree();
      toast(item ? "分卷设置已保存" : "分卷已创建");
    }, "分卷设置");
}

function openSettingDialog(item) {
  openDialog(item ? "编辑设定" : "新建设定",
    field("title", "标题", "text", item?.title) +
    field("category", "分类", "select", item?.category ?? "世界规则", [["世界规则", "世界规则"], ["历史与年代", "历史与年代"], ["地点与地图", "地点与地图"], ["组织与阵营", "组织与阵营"], ["物种与族群", "物种与族群"], ["科技与物品", "科技与物品"], ["术语与称谓", "术语与称谓"], ["创作约束", "创作约束"]]) +
    field("content", "设定说明", "textarea", item?.content) + field("locked", "锁定为 AI 硬约束", "checkbox", item?.locked),
    async (form) => {
      const body = { title: form.get("title"), category: form.get("category"), content: form.get("content"), locked: form.get("locked") === "on", status: form.get("locked") === "on" ? "confirmed" : (item?.status ?? "draft") };
      await api(item ? `/api/settings/${item.id}` : `/api/works/${state.work.id}/settings`, { method: item ? "PATCH" : "POST", body });
      await renderSettings();
      await loadAiReferences();
    }, item ? "人工修正" : "作者事实");
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

function renderCharacterEditorFields(item) {
  const raceOptions = [["", "未指定"], ...state.races.map((race) => [race.id, race.name])];
  const organizationOptions = state.organizations.map((organization) => [organization.id, organization.name]);
  const chapterOptions = [["", "未指定"], ...(state.work?.volumes ?? []).flatMap((volume) => volume.chapters.map((chapter) => [chapter.id, `${volume.title} / ${chapter.title}`]))];
  const stateEntries = characterStateEntries(item?.currentState ?? {});
  $("#character-editor-fields").innerHTML = [
    characterEditorSection("basic", "基础资料", "用于检索、去重和建立人物在作品中的基本归属。",
      field("name", "标准名", "text", item?.name) +
      field("aliases", "别名", "item-list", item?.aliases ?? []) +
      (state.races.length
        ? field("raceId", "种族", "select", item?.raceId ?? "", raceOptions)
        : '<div class="character-editor-empty-field"><b>种族</b><span>尚未创建种族，请先在“种族”模块建立档案。</span></div>') +
      (organizationOptions.length
        ? field("organizationIds", "所属组织（可多选）", "chips", item?.organizationIds ?? [], organizationOptions)
        : '<div class="character-editor-empty-field"><b>所属组织</b><span>尚未创建组织，可稍后在“组织”模块中补充。</span></div>') +
      field("visibility", "可见范围", "select", item?.visibility ?? "author", [["author", "仅作者"], ["collaborators", "协作者"], ["public", "公开"]]) +
      field("firstChapterId", "首次登场章节", "select", item?.firstChapterId ?? "", chapterOptions)),
    characterEditorSection("profile", "人物档案", "记录人物定位、行为动力和便于创作时快速理解的简介。",
      field("identity", "身份与定位", "text", item?.attributes?.identity) +
      field("motivation", "核心动机", "textarea", item?.profile?.motivation) +
      field("summary", "人物简介", "textarea", item?.profile?.summary)),
    characterEditorSection("settings", "扩展设定", "可用短属性和 Markdown 长章节承载形态、能力、生态、经历与研究记录。",
      field("details", "扩展属性", "key-value-list", item?.attributes?.details) +
      field("sections", "设定章节", "section-list", item?.profile?.sections)),
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
      field("lockedFields", "锁定字段", "item-list", item?.lockedFields ?? []))
  ].join("");
  const name = $("#character-editor-fields [name='name']");
  if (name) name.required = true;
  bindDynamicListControls($("#character-editor-fields"));
  activateCharacterEditorTab("basic");
}

function collectCharacterBody(form) {
  const item = characterEditorItem;
  return {
    name: String(form.get("name") ?? "").trim(),
    aliases: form.getAll("aliases").map((value) => String(value).trim()).filter(Boolean),
    raceId: form.get("raceId") || null,
    organizationIds: form.getAll("organizationIds").map(String),
    attributes: {
      ...(item?.attributes ?? {}),
      identity: String(form.get("identity") ?? "").trim(),
      details: buildCharacterDetails(form.getAll("detailLabel"), form.getAll("detailValue"))
    },
    profile: {
      ...(item?.profile ?? {}),
      motivation: String(form.get("motivation") ?? "").trim(),
      summary: String(form.get("summary") ?? "").trim(),
      sections: buildCharacterSections(form.getAll("sectionTitle"), form.getAll("sectionContent"))
    },
    currentState: buildCharacterState(form.getAll("stateKey"), form.getAll("stateValue"), item?.currentState ?? {}),
    lockedFields: form.getAll("lockedFields").map((value) => String(value).trim()).filter(Boolean),
    visibility: String(form.get("visibility") ?? "author"),
    firstChapterId: form.get("firstChapterId") || null,
    changeNote: String(form.get("changeNote") ?? "").trim()
  };
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

async function openCharacterDialog(item) {
  [state.races, state.organizations] = await Promise.all([
    api(`/api/works/${state.work.id}/races`),
    api(`/api/works/${state.work.id}/organizations`)
  ]);
  characterEditorItem = item ?? null;
  characterEditorVersions = [];
  $("#character-editor-eyebrow").textContent = item ? "人物主档案" : "建立人物档案";
  $("#character-editor-title").textContent = item?.name || "新建角色";
  $("#character-editor-version").textContent = item ? `v${item.versionNo}` : "新档案";
  $("#character-change-note").value = "";
  $("#character-editor-submit").textContent = item ? "保存新版本" : "创建人物档案";
  $("#character-history-button").disabled = !item;
  $("#character-history-button").title = item ? "查看、比较和回滚历史版本" : "创建人物档案后即可查看版本历史";
  setCharacterHistoryVisible(false);
  renderCharacterEditorFields(item);
  document.querySelectorAll("[data-character-editor-tab]").forEach((button) => {
    button.onclick = () => activateCharacterEditorTab(button.dataset.characterEditorTab);
  });
  const dialog = $("#character-editor-dialog");
  const form = $("#character-editor-form");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const submit = $("#character-editor-submit");
    submit.disabled = true;
    try {
      const body = collectCharacterBody(new FormData(form));
      if (!body.name) throw new Error("请填写角色标准名");
      const wasEditing = Boolean(characterEditorItem);
      const previousVersion = characterEditorItem?.versionNo;
      if (!wasEditing) delete body.changeNote;
      const saved = await api(wasEditing ? `/api/characters/${characterEditorItem.id}` : `/api/works/${state.work.id}/characters`, { method: wasEditing ? "PATCH" : "POST", body });
      dialog.close();
      await Promise.all([renderCharacters(), loadAiReferences()]);
      toast(!wasEditing ? "人物档案已创建" : saved.versionNo === previousVersion ? "没有检测到人物档案变更" : `人物档案已保存为 v${saved.versionNo}`);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      submit.disabled = false;
    }
  };
  dialog.showModal();
}

async function openRaceDialog(item) {
  state.characters = await api(`/api/works/${state.work.id}/characters`);
  const memberOptions = state.characters.map((character) => [character.id, `${character.name}${character.aliases.length ? `（${character.aliases.join("、")}）` : ""}`]);
  openDialog(item ? "编辑种族" : "新建种族",
    field("name", "种族名称", "text", item?.name) +
    field("description", "种族简介", "textarea", item?.description) +
    field("settings", "种族共同设定（逐条填写）", "item-list", item?.settings ?? []) +
    (memberOptions.length ? field("memberIds", "属于该种族的角色（可多选）", "chips", item?.memberIds ?? [], memberOptions) : ""),
    async (form) => {
      const settings = form.getAll("settings").map((value) => String(value).trim()).filter(Boolean);
      const body = { name: form.get("name"), description: form.get("description"), settings, memberIds: form.getAll("memberIds").map(String) };
      await api(item ? `/api/races/${item.id}` : `/api/works/${state.work.id}/races`, { method: item ? "PATCH" : "POST", body });
      await renderRaces();
      await loadAiReferences();
    }, item ? "种族档案" : "作品内种族");
}

async function openOrganizationDialog(item) {
  state.characters = await api(`/api/works/${state.work.id}/characters`);
  const memberOptions = state.characters.map((character) => [character.id, `${character.name}${character.aliases.length ? `（${character.aliases.join("、")}）` : ""}`]);
  openDialog(item ? "编辑组织" : "新建组织",
    field("name", "组织名称", "text", item?.name) +
    field("description", "组织简介", "textarea", item?.description) +
    field("settings", "组织设定（逐条填写）", "item-list", item?.settings ?? []) +
    (memberOptions.length ? field("memberIds", "组织成员（可多选）", "chips", item?.memberIds ?? [], memberOptions) : ""),
    async (form) => {
      const settings = form.getAll("settings").map((value) => String(value).trim()).filter(Boolean);
      const body = { name: form.get("name"), description: form.get("description"), settings, memberIds: form.getAll("memberIds").map(String) };
      await api(item ? `/api/organizations/${item.id}` : `/api/works/${state.work.id}/organizations`, { method: item ? "PATCH" : "POST", body });
      await renderOrganizations();
      await loadAiReferences();
    }, item ? "组织档案" : "世界内组织");
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
    const body = { trackId: form.get("trackId") || null, name: form.get("name"), timeLabel: form.get("timeLabel"), timeSort: rawSort ? Number(rawSort) : null, eventType: form.get("eventType"), location: form.get("location"), description: form.get("description"), status: item?.status ?? "confirmed" };
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
        goal: form.get("goal"), conflict: form.get("conflict"), turningPoint: form.get("turningPoint"), notes: form.get("notes"), status: form.get("status")
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
        plannedPayoffChapterId: form.get("payoffChapterId") || null, resolutionNote: form.get("resolutionNote"), occurrences
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
    ] } });
    await renderTimeline();
  }, "原证据同步保留");
}

async function openRelationshipDialog(item) {
  state.characters = await api(`/api/works/${state.work.id}/characters`);
  if (state.characters.length < 2) return toast("至少需要两个角色才能创建关系", "error");
  const options = state.characters.map((item) => [item.id, item.name]);
  openDialog(item ? "编辑人物关系" : "新建人物关系", field("from", "起点人物", "select", item?.fromCharacterId ?? options[0][0], options) + field("to", "终点人物", "select", item?.toCharacterId ?? options[1][0], options) + field("category", "关系大类", "select", item?.category ?? "social", [["family", "亲属"], ["social", "社交"], ["emotional", "情感"], ["conflict", "冲突"], ["uncertain", "未确定"]]) + field("subtype", "关系子类", "text", item?.subtype) + field("keywords", "关系关键词（用逗号分隔）", "text", item?.keywords?.join("、") ?? "") + field("confidence", "置信度（0-1）", "number", item?.confidence ?? "1") + field("directed", "有方向性", "checkbox", item?.directed ?? false), async (form) => {
    const keywords = String(form.get("keywords") ?? "").split(/[,，、；;]/u).map((value) => value.trim()).filter(Boolean);
    await api(item ? `/api/relationships/${item.id}` : `/api/works/${state.work.id}/relationships`, { method: item ? "PATCH" : "POST", body: { fromCharacterId: form.get("from"), toCharacterId: form.get("to"), category: form.get("category"), subtype: form.get("subtype"), keywords, confidence: Number(form.get("confidence")), directed: form.get("directed") === "on", confirmationStatus: item?.confirmationStatus ?? "confirmed" } });
    await renderRelationships();
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
  openDialog("新建分析任务", field("taskType", "任务类型", "select", "chapter-analysis", [["chapter-analysis", "章节理解"], ["character-extraction", "全书角色抽取"], ["timeline-analysis", "时间轴抽取"], ["relationship-analysis", "全书人物关系分析"], ["consistency-check", "一致性校对"], ["book-analysis", "全书分析"]]) + field("scopeType", "范围", "select", "chapter", [["chapter", "指定章节"], ["book", "全书"]]) + field("chapterId", "章节", "select", chapterOptions[0]?.[0] ?? "", chapterOptions), async (form) => {
    const scope = form.get("scopeType") === "book" ? { type: "book" } : { type: "chapter", chapterId: form.get("chapterId") };
    await api(`/api/works/${state.work.id}/tasks`, { method: "POST", body: { taskType: form.get("taskType"), scope } });
    await renderTasks();
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
  openDialog(item ? "编辑模型" : "添加模型", field("displayName", "显示名称", "text", values.displayName) + field("modelId", "模型标识符", "text", values.modelId) + field("purposes", "支持用途（可多选）", "chips", values.purposes, MODEL_PURPOSE_OPTIONS) + field("contextWindow", "模型上下文总量（Token）", "number", values.contextWindow) + field("temperature", "默认温度", "number", values.temperature) + field("maxTokens", "默认 max_tokens", "number", values.maxTokens) + field("enabled", "启用模型", "checkbox", values.enabled), async (form) => {
    const body = modelPayload({ displayName: form.get("displayName"), modelId: form.get("modelId"), purposes: form.getAll("purposes"), contextWindow: form.get("contextWindow"), temperature: form.get("temperature"), maxTokens: form.get("maxTokens"), enabled: form.get("enabled") === "on" }, item?.preset);
    await api(item ? `/api/models/${item.id}` : `/api/providers/${providerId}/models`, { method: item ? "PATCH" : "POST", body });
    await renderPlatformAiConfig();
    await loadModels();
  }, item ? "模型配置" : "供应商模型");
}

async function sendAi() {
  if (!state.work || !state.chapter) return toast("请先选择章节", "error");
  const modelId = $("#ai-model").value;
  if (!modelId) return toast("请先在 AI 管理中配置并选择模型", "error");
  const instruction = $("#ai-prompt").value.trim();
  if (!instruction) return toast("请输入指令", "error");
  const requestScope = currentAiRequestScope();
  if (!requestScope) return toast("请先选择章节", "error");
  const { taskType, scope, selection } = requestScope;
  if ((scope.type === "selection" || taskType === "polish") && !selection) return toast("请先在正文中选中一段文本", "error");
  const citations = state.aiCitations.map(({ chapterId, chapterTitle, startLine, endLine, text }) => ({ chapterId, chapterTitle, startLine, endLine, text }));
  let persistedUserMessage;
  try {
    persistedUserMessage = await persistAiConversationMessage("user", instruction, citations);
  } catch (error) {
    return toast(`对话记录创建失败：${error.message}`, "error");
  }
  state.aiPromptSent = true;
  renderAiQuickActions();
  appendMessage("user", instruction, citations, persistedUserMessage.createdAt, {}, persistedUserMessage.id);
  $("#ai-send").disabled = true;
  $("#ai-send").textContent = "发送中";
  try {
    let assistantContent = "";
    let assistantMessage;
    let assistantMetadata = {};
    let suggestion = null;
    if (taskType === "chat") {
      const streamed = await streamChat({ instruction, scope, modelId, citations });
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
    $("#ai-prompt").value = "";
    state.aiCitations = [];
    state.aiReferences = [];
    state.includeBookSummary = false;
    renderAiCitations();
    renderAiReferences();
    renderBookSummaryReference();
    scheduleAiContextUsage();
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
  const content = message.querySelector(".message-body");
  const meta = message.querySelector(".message-meta");
  let streamedText = "";
  let generatedMetadata = {};
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
        streamedText += payload.delta ?? "";
        content.innerHTML = renderMarkdown(streamedText);
        meta.textContent = `已接收 ${Array.from(streamedText).length} 字`;
        $("#ai-feed").scrollTop = $("#ai-feed").scrollHeight;
      } else if (eventName === "complete") {
        message.classList.remove("is-streaming");
        message.querySelector(".message-heading > span").textContent = "助手";
        generatedMetadata = { modelDisplayName: payload.model?.displayName, outputTokens: payload.outputTokens };
        meta.textContent = formatAiMessageMeta(payload.model?.displayName, payload.outputTokens);
        attachAssistantCopyAction(message, streamedText);
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
    meta.textContent = "生成中断";
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
  $("#ai-feed").scrollTop = $("#ai-feed").scrollHeight;
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
  $("#ai-feed").scrollTop = $("#ai-feed").scrollHeight;
  return message;
}

async function showVersions() {
  if (!state.chapter) return;
  const versions = await api(`/api/chapters/${state.chapter.id}/versions`);
  $("#versions-list").innerHTML = versions.map((version) => `<div class="version-row"><div><b>v${version.versionNo}</b><small>${esc(version.source)} · ${esc(version.actor || "历史数据")}</small></div><p>${esc(version.content.slice(0, 300) || "空白章节")}</p><button class="ghost-button" data-restore-version="${version.versionNo}">恢复</button></div>`).join("");
  $("#versions-list").querySelectorAll("[data-restore-version]").forEach((button) => button.addEventListener("click", async () => {
    if (!window.confirm(`将版本 v${button.dataset.restoreVersion} 恢复为一个新的保存版本？`)) return;
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

async function showChapterInsight() {
  if (!state.chapter) return;
  const panel = $("#chapter-insight");
  const insights = await api(`/api/chapters/${state.chapter.id}/insights`);
  const insight = insights.find((item) => item.chapterVersion === state.chapter.versionNo) ?? insights[0];
  panel.classList.remove("hidden");
  if (!insight) {
    panel.innerHTML = "<strong>尚无章节概览</strong>请在“分析任务”中运行章节理解，完成后可在此查看结果。";
    return;
  }
  const eventNames = insight.events.map((event) => typeof event === "string" ? event : (event.name ?? event.description ?? "未命名事件"));
  const stale = insight.chapterVersion !== state.chapter.versionNo ? `；基于旧版本 v${insight.chapterVersion}` : "";
  panel.innerHTML = `<strong>章节概览${esc(stale)}</strong>${esc(insight.summary || "暂无梗概")}${eventNames.length ? `<br><strong>事件</strong>${esc(eventNames.join("；"))}` : ""}${insight.uncertainties.length ? `<br><strong>待确认</strong>${esc(insight.uncertainties.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("；"))}` : ""}`;
}

$("#home-button").addEventListener("click", () => {
  if (!confirmDiscardChanges()) return;
  loadWorks().catch((error) => toast(error.message, "error"));
});
$("#settings-button").addEventListener("click", showSettingsHub);
$("#account-button").addEventListener("click", () => {
  const expanded = $("#account-menu").classList.toggle("hidden") === false;
  $("#account-button").setAttribute("aria-expanded", String(expanded));
});
$("#account-settings-button").addEventListener("click", () => {
  $("#account-menu").classList.add("hidden");
  $("#account-button").setAttribute("aria-expanded", "false");
  $("#profile-display-name").value = state.user?.displayName ?? "";
  $("#password-form").reset();
  $("#account-dialog").showModal();
});
$("#account-dialog-close").addEventListener("click", () => $("#account-dialog").close());
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
  try {
    await api("/api/auth/password", { method: "PATCH", body: { currentPassword: form.get("currentPassword"), newPassword: form.get("newPassword") } });
    event.currentTarget.reset();
    toast("密码已更新，其他设备的会话已退出");
  } catch (error) { toast(error.message, "error"); }
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
    refreshAuthCaptcha("login").catch(() => {});
  }
});
$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  $("#auth-error").textContent = "";
  try {
    await api("/api/auth/register", {
      method: "POST",
      body: {
        username: form.get("username"),
        displayName: form.get("displayName"),
        password: form.get("password"),
        captchaId: form.get("captchaId"),
        captchaAnswer: form.get("captchaAnswer")
      }
    });
    window.location.reload();
  } catch (error) {
    $("#auth-error").textContent = error.message;
    refreshAuthCaptcha("register").catch(() => {});
  }
});
$("#settings-return").addEventListener("click", () => returnFromSettings().catch((error) => toast(error.message, "error")));
$("#platform-ai-button").addEventListener("click", () => showPlatformAi().catch((error) => toast(error.message, "error")));
$("#user-management-button").addEventListener("click", openUsersDialog);
$("#collaboration-button").addEventListener("click", () => openMembersDialog());
$("#users-dialog-close").addEventListener("click", () => $("#users-dialog").close());
$("#members-dialog-close").addEventListener("click", () => $("#members-dialog").close());
$("#members-dialog").addEventListener("close", () => { memberDialogWork = null; });
$("#member-invite-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const userId = $("#member-user-select").value;
  const work = memberDialogWork ?? state.work;
  if (!work || !userId) return;
  try {
    const members = await api(`/api/works/${encodeURIComponent(work.id)}/members`, { method: "POST", body: { userId } });
    renderMembers(members);
    await fillMemberCandidates(members);
    toast("协作者已邀请");
  } catch (error) { toast(error.message, "error"); }
});
$("#platform-new-provider").addEventListener("click", () => openProviderDialog());
$("#shelf-new-work").addEventListener("click", openWorkDialog);
$("#welcome-new-work").addEventListener("click", () => state.work ? openChapterDialog() : openWorkDialog());
$("#new-chapter-button").addEventListener("click", openChapterDialog);
$("#save-button").addEventListener("click", saveChapter);
$("#tidy-blank-lines-button").addEventListener("click", tidyChapterBlankLines);
$("#new-volume-button").addEventListener("click", () => openVolumeDialog());
$("#insight-button").addEventListener("click", () => showChapterInsight().catch((error) => toast(error.message, "error")));
$("#versions-button").addEventListener("click", showVersions);
$("#versions-close").addEventListener("click", () => $("#versions-dialog").close());
$("#entity-history-close").addEventListener("click", () => $("#entity-history-dialog").close());
$("#character-editor-close").addEventListener("click", () => $("#character-editor-dialog").close());
$("#character-editor-cancel").addEventListener("click", () => $("#character-editor-dialog").close());
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
$("#module-create-button").addEventListener("click", () => ({ settings: openSettingDialog, characters: openCharacterDialog, races: openRaceDialog, organizations: openOrganizationDialog, timeline: openTimelineDialog, outlines: openForeshadowDialog, relationships: openRelationshipDialog, reviews: openReviewDialog, tasks: openTaskDialog })[state.module]?.());
$("#ai-prompt").addEventListener("input", () => {
  updateAiMentionMenu();
  scheduleAiContextUsage();
});
$("#ai-model").addEventListener("change", scheduleAiContextUsage);
$("#ai-task").addEventListener("change", scheduleAiContextUsage);
$("#ai-scope").addEventListener("change", scheduleAiContextUsage);
$("#ai-book-summary-reference").addEventListener("click", () => {
  state.includeBookSummary = !state.includeBookSummary;
  renderBookSummaryReference();
  scheduleAiContextUsage();
});
$("#ai-mention-menu").addEventListener("click", (event) => {
  const button = event.target.closest("[data-ai-reference-id]");
  if (button) selectAiMention(button);
});
$("#import-file").addEventListener("change", async (event) => {
  if (!state.work || !event.target.files[0]) return;
  if (!confirmDiscardChanges("导入会替换当前作品目录，未保存修改将丢失。是否继续？")) {
    event.target.value = "";
    return;
  }
  const body = new FormData();
  body.append("file", event.target.files[0]);
  try {
    const result = await api(`/api/works/${state.work.id}/import`, { method: "POST", body });
    setSaveState("已导入");
    state.work = result.tree;
    renderTree();
    toast(result.warnings.length ? `导入完成：${result.warnings.join("；")}` : "导入完成");
    const first = state.work.volumes.flatMap((volume) => volume.chapters)[0];
    if (first) await selectChapter(first.id);
  } catch (error) { toast(error.message, "error"); }
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
    state.works = await api("/api/works");
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
$("#ai-history-toggle").addEventListener("click", () => {
  setAiHistoryVisible($("#ai-history-panel").classList.contains("hidden"));
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
  $("#ai-prompt").value = button.dataset.prompt;
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
window.addEventListener("beforeunload", (event) => { if (state.dirty) event.preventDefault(); });

initializePage().catch((error) => {
  restoringPageRoute = false;
  showShelf();
  toast(`系统初始化失败：${error.message}`, "error");
});
