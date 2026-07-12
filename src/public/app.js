import { buildRelationshipGraph, createGalaxyRenderer, renderRelationshipMindMap } from "/relationship-graph.js?v=20260712-galaxy-node-focus";
import { collapseExcessBlankLines, normalizeParagraphSpacing } from "/text-formatting.js?v=20260712-auto-blank-lines";
import { renderMarkdown } from "/markdown.js?v=20260712-chat-markdown";

const state = {
  works: [],
  work: null,
  chapter: null,
  module: "editor",
  models: [],
  characters: [],
  organizations: [],
  timelineTracks: [],
  aiCitations: [],
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

const taskTypeLabels = [
  ["chat", "通用对话"],
  ["continue", "创作续写"],
  ["polish", "文本润色"],
  ["chapter-analysis", "章节理解"],
  ["book-analysis", "全书分析"],
  ["timeline-analysis", "时间轴抽取"],
  ["relationship-analysis", "人物关系分析"],
  ["consistency-check", "一致性校对"]
];

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const platformDocumentTitle = "叙界 · 小说 AI 创作工作台";
const panelLayoutStorageKey = "ai-novel-panel-layout-v1";
const panelLayoutDefaults = Object.freeze({ leftWidth: 280, aiWidth: 360, leftCollapsed: false, aiCollapsed: false });

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
    const rowHeight = Math.max(lineHeight, Math.ceil(row.getBoundingClientRect().height));
    number.style.height = `${rowHeight}px`;
    numbers.append(number);
  });
  inner.replaceChildren(numbers);
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
applyPanelLayout();

async function api(path, options = {}) {
  const response = await fetch(path, options.body instanceof FormData ? options : {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: { message: `请求失败：${response.status}` } }));
    throw new Error(payload.error?.message ?? `请求失败：${response.status}`);
  }
  if (response.status === 204) return null;
  const payload = await response.json();
  return payload.data;
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

function showShelf() {
  state.dirty = false;
  updateDocumentTitle();
  $("#app").classList.add("shelf-mode");
  $("#shelf-view").classList.remove("hidden");
  $("#welcome-view").classList.add("hidden");
  $("#editor-view").classList.add("hidden");
  $("#module-view").classList.add("hidden");
  $("#work-meta").textContent = `${state.works.length} 部作品`;
  setSaveState("书架");
  renderShelf();
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
        <span class="book-info"><strong>${esc(work.title)}</strong><small>${esc(work.author || "未署名")} · ${work.chapterCount} 章 · ${work.wordCount} 字</small><span>${esc(work.description || "尚未填写作品简介")}</span></span>
      </button>
      <div class="book-card-actions"><button type="button" data-cover-work="${esc(work.id)}">设置封面</button><button type="button" data-edit-work="${esc(work.id)}">作品信息</button></div>
    </article>`).join("")}
    <button class="book-card book-add-card" id="book-add-card" type="button" aria-label="新建作品" data-testid="book-add-card"><span>＋</span><strong>新建作品</strong><small>从零开始或导入 TXT / DOCX</small></button>`;
  shelf.querySelectorAll("[data-open-work]").forEach((button) => button.addEventListener("click", () => selectWork(button.dataset.openWork)));
  shelf.querySelectorAll("[data-cover-work]").forEach((button) => button.addEventListener("click", () => {
    state.pendingCoverWorkId = button.dataset.coverWork;
    $("#cover-file").click();
  }));
  shelf.querySelectorAll("[data-edit-work]").forEach((button) => button.addEventListener("click", () => openWorkSettingsDialog(state.works.find((work) => work.id === button.dataset.editWork))));
  $("#book-add-card").addEventListener("click", openWorkDialog);
}

async function selectWork(workId) {
  const discarding = state.work?.id !== workId && state.dirty;
  if (discarding && !confirmDiscardChanges()) return false;
  const nextWork = await api(`/api/works/${workId}`);
  if (state.work?.id !== nextWork.id) {
    state.aiCitations = [];
    renderAiCitations();
  }
  if (discarding) setSaveState("就绪");
  $("#app").classList.remove("shelf-mode");
  $("#shelf-view").classList.add("hidden");
  state.work = nextWork;
  state.chapter = null;
  updateDocumentTitle(state.work);
  $("#work-meta").textContent = `${state.work.title}${state.work.author ? ` · ${state.work.author}` : ""} · ${state.work.wordCount} 字`;
  renderTree();
  await loadModels();
  await loadAiReferences();
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
  $("#chapter-path").textContent = `${volume?.title ?? "正文"} / 保存于 ${formatDate(state.chapter.updatedAt)}`;
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
}

function markActiveModule(module) {
  $("#module-nav").querySelectorAll("button").forEach((button) => button.classList.toggle("active", button.dataset.module === module));
}

const moduleMeta = {
  settings: ["世界事实", "世界观与设定库", "锁定的设定会成为 AI 续写与校对的硬约束。", "新建设定"],
  characters: ["人物档案", "角色与人物属性", "维护别名、属性、当前状态及不可被 AI 覆盖的字段。", "新建角色"],
  organizations: ["世界阵营", "组织与成员", "维护组织简介、设定清单，并将角色绑定到所属组织。", "新建组织"],
  timeline: ["剧情脉络", "大事件时间轴", "候选事件经作者确认后，才进入正式时间线。", "新建事件"],
  outlines: ["创作规划", "大纲与伏笔", "为每章维护目标、冲突与转折，并持续提醒尚未回收的伏笔。", "新建伏笔"],
  relationships: ["跨章证据", "人物关系", "记录关系方向、阶段、置信度与原文依据。", "新建关系"],
  reviews: ["作者决策", "审核队列", "集中处理冲突、候选设定、低置信度关系和时间问题。", "新增审核项"],
  tasks: ["增量分析", "分析任务", "正文变化后只重算受影响的章节与知识对象。", "新建任务"],
  "ai-config": ["模型配置", "AI 供应商管理", "仅接入 OpenAI Chat Completions 兼容服务，密钥只在服务端使用。", "新建供应商"]
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
  $("#module-create-button").classList.toggle("hidden", false);
  $("#module-content").innerHTML = '<div class="empty-state">正在载入……</div>';
  try {
    if (module === "settings") await renderSettings();
    if (module === "characters") await renderCharacters();
    if (module === "organizations") await renderOrganizations();
    if (module === "timeline") await renderTimeline();
    if (module === "outlines") await renderOutlines();
    if (module === "relationships") await renderRelationships();
    if (module === "reviews") await renderReviews();
    if (module === "tasks") await renderTasks();
    if (module === "ai-config") await renderAiConfig();
  } catch (error) {
    $("#module-content").innerHTML = `<div class="empty-state"><b>载入失败</b>${esc(error.message)}</div>`;
  }
}

function emptyModule(title, description) {
  return `<div class="empty-state"><b>${esc(title)}</b>${esc(description)}</div>`;
}

async function renderSettings() {
  const records = await api(`/api/works/${state.work.id}/settings`);
  $("#module-content").innerHTML = records.length ? `<div class="card-grid">${records.map((item) => `
    <article class="record-card"><small>${esc(item.category)} · ${item.locked ? "已锁定" : esc(item.status)}</small>
    <h3>${esc(item.title)}</h3><p>${esc(item.content)}</p>
    <div class="card-actions"><button data-edit-setting="${esc(item.id)}">编辑</button></div></article>`).join("")}</div>`
    : emptyModule("还没有世界观设定", "新建规则、地点、组织、科技或创作约束。AI 提取的候选也会进入这里。");
  $("#module-content").querySelectorAll("[data-edit-setting]").forEach((button) => button.addEventListener("click", () => openSettingDialog(records.find((item) => item.id === button.dataset.editSetting))));
}

async function renderCharacters() {
  [state.characters, state.organizations] = await Promise.all([
    api(`/api/works/${state.work.id}/characters`),
    api(`/api/works/${state.work.id}/organizations`)
  ]);
  $("#module-content").innerHTML = state.characters.length ? `<div class="card-grid">${state.characters.map((item) => `
    <article class="record-card character-card" data-open-character="${esc(item.id)}" role="button" tabindex="0" aria-label="查看角色 ${esc(item.name)}"><small>${item.lockedFields.length ? `锁定 ${item.lockedFields.length} 项` : esc(item.visibility)}</small>
    <h3>${esc(item.name)}</h3><div>${item.aliases.map((alias) => `<span class="pill">${esc(alias)}</span>`).join("")}</div>
    <div class="organization-links"><b>所属组织</b>${(item.organizations ?? []).length ? item.organizations.map((organization) => `<span class="pill organization-pill">${esc(organization.name)}</span>`).join("") : '<span class="organization-empty">未加入组织</span>'}</div>
    <p>${esc(Object.entries(item.currentState).map(([key, value]) => `${key}：${value}`).join("\n") || "尚未记录当前状态")}</p>
    <div class="card-actions"><button data-edit-character="${esc(item.id)}">编辑</button></div></article>`).join("")}</div>`
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
      <div class="card-actions"><button data-edit-organization="${esc(item.id)}">编辑</button></div>
    </article>`).join("")}</div>` : emptyModule("还没有组织", "创建国家、机构、阵营或团队，并维护组织设定与成员。");
  $("#module-content").querySelectorAll("[data-edit-organization]").forEach((button) => button.addEventListener("click", () => openOrganizationDialog(state.organizations.find((item) => item.id === button.dataset.editOrganization))));
}

async function renderTimeline() {
  const [events, tracks] = await Promise.all([
    api(`/api/works/${state.work.id}/timeline`),
    api(`/api/works/${state.work.id}/timeline-tracks`)
  ]);
  state.timelineTracks = tracks;
  const lanes = [...tracks, { id: "", name: "未分组时间轴", description: "尚未归入独立大事件的时间节点。", sortOrder: Number.MAX_SAFE_INTEGER }];
  const eventCard = (item) => `<article class="timeline-kanban-card"><div class="timeline-card-meta"><input type="checkbox" data-event-select="${esc(item.id)}" aria-label="选择 ${esc(item.name)}"><small>${esc(item.timeLabel)} · ${esc(item.status)}</small></div><h4>${esc(item.name)}</h4><p>${esc(item.description || "暂无说明")}</p>${item.location ? `<span>地点：${esc(item.location)}</span>` : ""}<div class="card-actions"><button data-edit-event="${esc(item.id)}">编辑与排序</button><button data-split-event="${esc(item.id)}">拆分</button></div></article>`;
  $("#module-content").innerHTML = `<div class="timeline-tools"><button id="create-timeline-track" class="primary-button" type="button">新建独立时间轴</button>${events.length > 1 ? '<button id="merge-events" class="ghost-button" type="button">合并所选事件</button>' : ""}</div><div class="timeline-kanban" data-testid="timeline-kanban">${lanes.map((track) => {
    const laneEvents = events.filter((item) => (item.trackId ?? "") === track.id);
    return `<section class="timeline-lane" data-track-id="${esc(track.id)}"><header><div><small>${laneEvents.length} 个节点</small><h3>${esc(track.name)}</h3></div>${track.id ? `<button class="timeline-track-menu" data-edit-timeline-track="${esc(track.id)}" type="button">编辑</button>` : ""}</header><p class="timeline-track-description">${esc(track.description || "暂无说明")}</p><div class="timeline-lane-events">${laneEvents.map(eventCard).join("") || '<div class="timeline-lane-empty">还没有时间节点</div>'}</div><button class="timeline-add-event" data-add-event-track="${esc(track.id)}" type="button">添加事件</button></section>`;
  }).join("")}</div>`;
  $("#create-timeline-track").addEventListener("click", () => openTimelineTrackDialog());
  $("#module-content").querySelectorAll("[data-edit-timeline-track]").forEach((button) => button.addEventListener("click", () => openTimelineTrackDialog(tracks.find((track) => track.id === button.dataset.editTimelineTrack))));
  $("#module-content").querySelectorAll("[data-add-event-track]").forEach((button) => button.addEventListener("click", () => openTimelineDialog(null, button.dataset.addEventTrack || null)));
  $("#module-content").querySelectorAll("[data-edit-event]").forEach((button) => button.addEventListener("click", () => openTimelineDialog(events.find((item) => item.id === button.dataset.editEvent))));
  $("#module-content").querySelectorAll("[data-split-event]").forEach((button) => button.addEventListener("click", () => openTimelineSplitDialog(events.find((item) => item.id === button.dataset.splitEvent))));
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
      <div class="card-actions"><button data-edit-foreshadow="${esc(item.id)}">编辑伏笔</button></div>
    </article>`).join("")}</div>` : emptyModule("还没有伏笔", "创建伏笔并关联埋设、提醒与回收章节，未回收项会持续显示。\n");
  const outlineHtml = outlines.length ? `<div class="outline-list">${outlines.map((item) => `
    <article class="outline-row ${item.status === "completed" ? "is-complete" : ""}">
      <div><small>${esc(item.volumeTitle)} · ${esc(item.status)}</small><h3>${esc(item.chapterTitle)}</h3></div>
      <div><b>目标</b><p>${esc(item.goal || "未填写")}</p></div>
      <div><b>冲突</b><p>${esc(item.conflict || "未填写")}</p></div>
      <div><b>转折</b><p>${esc(item.turningPoint || "未填写")}</p></div>
      <div class="outline-actions">${item.unresolvedForeshadowCount ? `<span>${item.unresolvedForeshadowCount} 个未回收伏笔</span>` : ""}<button data-edit-outline="${esc(item.chapterId)}">编辑</button></div>
    </article>`).join("")}</div>` : emptyModule("还没有章节", "先创建章节，再为每章维护目标、冲突和转折。\n");
  $("#module-content").innerHTML = `<div class="outline-summary"><article><strong>${outlines.length}</strong><span>章节规划</span></article><article><strong>${unresolved.length}</strong><span>未回收伏笔</span></article><article class="${overdue.length ? "danger-text" : ""}"><strong>${overdue.length}</strong><span>已逾期</span></article></div><section class="planning-section"><div class="section-title"><div><span class="eyebrow">伏笔追踪</span><h2>尚未回收与历史伏笔</h2></div></div>${foreshadowHtml}</section><section class="planning-section"><div class="section-title"><div><span class="eyebrow">逐章规划</span><h2>章节目标、冲突与转折</h2></div></div>${outlineHtml}</section>`;
  $("#module-content").querySelectorAll("[data-edit-outline]").forEach((button) => button.addEventListener("click", () => openOutlineDialog(outlines.find((item) => item.chapterId === button.dataset.editOutline))));
  $("#module-content").querySelectorAll("[data-edit-foreshadow]").forEach((button) => button.addEventListener("click", () => openForeshadowDialog(foreshadows.find((item) => item.id === button.dataset.editForeshadow))));
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
  $("#module-content").innerHTML = `<div id="relationship-map-host"></div>${relationships.length ? `<table class="table-list relationship-table"><thead><tr><th>人物</th><th>关系</th><th>关键词</th><th>证据</th><th>置信度</th><th>状态</th></tr></thead><tbody>${relationships.map((item) => `
    <tr><td>${esc(nameOf(item.fromCharacterId))} ${item.directed ? "→" : "—"} ${esc(nameOf(item.toCharacterId))}</td>
    <td>${esc(item.category)} / ${esc(item.subtype || "未细分")}</td><td>${(item.keywords ?? []).map((keyword) => `<span class="pill relationship-keyword">${esc(keyword)}</span>`).join("") || "—"}</td><td>${item.evidence.length} 条</td><td>${Math.round(item.confidence * 100)}%</td><td>${esc(item.confirmationStatus)}</td></tr>`).join("")}</tbody></table>` : '<div class="relationship-empty-note">尚无关系边；孤立角色仍显示在思维图中。可人工新建关系，或运行全书人物关系分析。</div>'}`;
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
  const tasks = await api(`/api/works/${state.work.id}/tasks`);
  $("#module-content").innerHTML = tasks.length ? `<table class="table-list"><thead><tr><th>任务</th><th>范围</th><th>状态</th><th>进度</th><th>操作</th></tr></thead><tbody>${tasks.map((item) => `
    <tr><td>${esc(item.taskType)}</td><td>${esc(item.scope.type ?? "book")}</td><td>${esc(item.status)}</td><td>${item.progress}%</td>
    <td>${item.status === "pending" ? `<button class="ghost-button" data-run-task="${esc(item.id)}">运行</button>` : ""}${item.status === "pending" || item.status === "running" ? `<button class="ghost-button" data-cancel-task="${esc(item.id)}">取消</button>` : ""}</td></tr>`).join("")}</tbody></table>`
    : emptyModule("还没有分析任务", "保存正文时会自动创建受影响章节的待分析任务，也可手动创建全书任务。");
  $("#module-content").querySelectorAll("[data-run-task]").forEach((button) => button.addEventListener("click", async () => {
    const workId = state.work.id;
    try {
      button.disabled = true;
      button.textContent = "运行中";
      const cancel = button.parentElement.querySelector("[data-cancel-task]");
      if (cancel) cancel.textContent = "取消运行";
      const completed = await api(`/api/tasks/${button.dataset.runTask}/run`, { method: "POST", body: { modelId: $("#ai-model").value || undefined } });
      toast(completed.status === "cancelled" ? "分析任务已取消" : completed.status === "expired" ? "正文已变化，本次分析已过期" : "分析已完成，结果进入审核状态");
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

async function renderAiConfig() {
  const [providers, models, taskDefaults] = await Promise.all([
    api(`/api/works/${state.work.id}/providers`),
    api(`/api/works/${state.work.id}/models`),
    api(`/api/works/${state.work.id}/task-defaults`)
  ]);
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const defaultModelByTask = new Map(taskDefaults.map((item) => [item.taskType, item.model.id]));
  const providerContent = providers.length ? `<div class="card-grid">${providers.map((provider) => `
    <article class="record-card"><small>${esc(provider.status)} · ${esc(provider.connectionStatus)}</small><h3>${esc(provider.name)}</h3>
    <p>${esc(provider.baseUrl)}\n密钥：${esc(provider.apiKey)}\n并发：${provider.concurrencyLimit} · RPM：${provider.rpmLimit} · max_tokens：${provider.maxTokens ?? 32000}${provider.lastError ? `\n错误：${esc(provider.lastError)}` : ""}</p>
    <div>${models.filter((model) => model.providerId === provider.id).map((model) => `<span class="pill">${esc(model.displayName)} · ${model.enabled ? "启用" : "停用"} · max_tokens ${esc(model.preset?.max_tokens ?? 32000)}</span>`).join("")}</div>
    <div class="card-actions"><button data-edit-provider="${esc(provider.id)}">编辑配置</button><button data-test-provider="${esc(provider.id)}">测试连接</button><button data-add-model="${esc(provider.id)}">添加模型</button></div></article>`).join("")}</div>`
    : emptyModule("尚未配置 AI 供应商", "添加 OpenAI Chat Completions 兼容地址和密钥，测试成功后再添加模型。");
  const defaultsContent = models.length ? `<section class="config-section">
    <div class="config-section-header"><div><h2>任务默认模型</h2><p>未单独指定模型时使用下列配置；所有请求都会携带 max_tokens，默认值为 32000。</p></div></div>
    <table class="table-list"><thead><tr><th>任务能力</th><th>默认模型</th></tr></thead><tbody>${taskTypeLabels.map(([taskType, label]) => {
      const currentModelId = defaultModelByTask.get(taskType) ?? "";
      return `<tr><td>${esc(label)}<br><small>${esc(taskType)}</small></td><td><select class="default-model-select" data-task-default="${esc(taskType)}">
        <option value="" disabled ${currentModelId ? "" : "selected"}>请选择模型</option>
        ${models.map((model) => {
          const provider = providerById.get(model.providerId);
          const available = model.enabled && provider?.status === "enabled" && provider?.connectionStatus === "success";
          return `<option value="${esc(model.id)}" ${model.id === currentModelId ? "selected" : ""} ${available || model.id === currentModelId ? "" : "disabled"}>${esc(model.displayName)} · ${esc(model.modelId)}</option>`;
        }).join("")}
      </select></td></tr>`;
    }).join("")}</tbody></table>
  </section>` : "";
  $("#module-content").innerHTML = `${providerContent}${defaultsContent}`;
  $("#module-content").querySelectorAll("[data-test-provider]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "测试中";
    const result = await api(`/api/providers/${button.dataset.testProvider}/test`, { method: "POST", body: {} });
    toast(result.ok ? "连接测试成功" : `连接失败：${result.error}`, result.ok ? "info" : "error");
    await renderAiConfig();
    await loadModels();
  }));
  $("#module-content").querySelectorAll("[data-add-model]").forEach((button) => button.addEventListener("click", () => openModelDialog(button.dataset.addModel)));
  $("#module-content").querySelectorAll("[data-edit-provider]").forEach((button) => button.addEventListener("click", () => openProviderDialog(providers.find((provider) => provider.id === button.dataset.editProvider))));
  $("#module-content").querySelectorAll("[data-task-default]").forEach((select) => select.addEventListener("change", async () => {
    select.disabled = true;
    try {
      await api(`/api/works/${state.work.id}/task-defaults/${select.dataset.taskDefault}`, { method: "PUT", body: { modelId: select.value } });
      toast("默认模型已更新");
    } catch (error) {
      toast(error.message, "error");
    }
    await renderAiConfig();
  }));
}

async function loadModels() {
  if (!state.work) return;
  state.models = await api(`/api/works/${state.work.id}/models`);
  const select = $("#ai-model");
  select.innerHTML = state.models.length
    ? state.models.map((model) => `<option value="${esc(model.id)}" ${model.enabled ? "" : "disabled"}>${esc(model.displayName)} · ${esc(model.modelId)}</option>`).join("")
    : '<option value="">请先配置模型</option>';
}

async function loadAiReferences() {
  if (!state.work) return;
  [state.characters, state.settings] = await Promise.all([
    api(`/api/works/${state.work.id}/characters`),
    api(`/api/works/${state.work.id}/settings`)
  ]);
  $("#ai-character").innerHTML = '<option value="">附加角色：无</option>' + state.characters.map((item) => `<option value="${esc(item.id)}">角色：${esc(item.name)}</option>`).join("");
  $("#ai-setting").innerHTML = '<option value="">附加设定：无</option>' + state.settings.map((item) => `<option value="${esc(item.id)}">设定：${esc(item.title)}</option>`).join("");
}

function field(name, label, type = "text", value = "", options = []) {
  if (type === "textarea") return `<label>${esc(label)}<textarea name="${esc(name)}">${esc(value)}</textarea></label>`;
  if (type === "item-list") {
    const values = Array.isArray(value) && value.length ? value : [""];
    return `<div class="form-field item-list-field"><span>${esc(label)}</span><div class="item-list-rows" data-item-list-rows data-name="${esc(name)}" data-label="${esc(label)}">${values.map((item) => `<div class="item-list-row"><input name="${esc(name)}" value="${esc(item)}" aria-label="${esc(label)}"><button type="button" data-item-list-remove aria-label="删除此条">删除</button></div>`).join("")}</div><button class="item-list-add" type="button" data-item-list-add>添加一条</button></div>`;
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

function openDialog(title, fields, onSubmit, eyebrow = "新增") {
  $("#dialog-title").textContent = title;
  $("#dialog-eyebrow").textContent = eyebrow;
  $("#dialog-fields").innerHTML = fields;
  $("#dialog-fields").querySelectorAll("[data-item-list-add]").forEach((button) => button.addEventListener("click", () => {
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
  $("#dialog-fields").onclick = (event) => {
    const remove = event.target.closest("[data-item-list-remove]");
    if (!remove) return;
    const row = remove.closest(".item-list-row");
    const rows = row.parentElement;
    if (rows.children.length === 1) row.querySelector("input").value = "";
    else row.remove();
  };
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

function openWorkSettingsDialog(work) {
  if (!work) return;
  openDialog("作品信息",
    field("title", "作品名称", "text", work.title) + field("author", "作者", "text", work.author) + field("description", "简介", "textarea", work.description),
    async (form) => {
      await api(`/api/works/${work.id}`, { method: "PATCH", body: { title: form.get("title"), author: form.get("author"), description: form.get("description") } });
      state.works = await api("/api/works");
      renderShelf();
      toast("作品信息已保存");
    }, "书架设置");
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

async function openCharacterDialog(item) {
  state.organizations = await api(`/api/works/${state.work.id}/organizations`);
  const organizationOptions = state.organizations.map((organization) => [organization.id, organization.name]);
  openDialog(item ? "编辑角色" : "新建角色",
    field("name", "标准名", "text", item?.name) + field("aliases", "别名（用逗号分隔）", "text", item?.aliases?.join(", ")) +
    field("identity", "身份", "text", item?.attributes?.identity) + field("motivation", "动机", "textarea", item?.profile?.motivation) +
    field("location", "当前位置", "text", item?.currentState?.location) +
    (organizationOptions.length ? field("organizationIds", "所属组织（可多选）", "chips", item?.organizationIds ?? [], organizationOptions) : "") +
    field("lockedFields", "锁定字段（用逗号分隔）", "text", item?.lockedFields?.join(", ")),
    async (form) => {
      const split = (value) => String(value ?? "").split(/[,，]/).map((part) => part.trim()).filter(Boolean);
      const body = { name: form.get("name"), aliases: split(form.get("aliases")), organizationIds: form.getAll("organizationIds").map(String), attributes: { ...(item?.attributes ?? {}), identity: form.get("identity") }, profile: { ...(item?.profile ?? {}), motivation: form.get("motivation") }, currentState: { ...(item?.currentState ?? {}), location: form.get("location") }, lockedFields: split(form.get("lockedFields")) };
      await api(item ? `/api/characters/${item.id}` : `/api/works/${state.work.id}/characters`, { method: item ? "PATCH" : "POST", body });
      await renderCharacters();
      await loadAiReferences();
    }, item ? "人工修正" : "人物主档案");
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

async function openRelationshipDialog() {
  state.characters = await api(`/api/works/${state.work.id}/characters`);
  if (state.characters.length < 2) return toast("至少需要两个角色才能创建关系", "error");
  const options = state.characters.map((item) => [item.id, item.name]);
  openDialog("新建人物关系", field("from", "起点人物", "select", options[0][0], options) + field("to", "终点人物", "select", options[1][0], options) + field("category", "关系大类", "select", "social", [["family", "亲属"], ["social", "社交"], ["emotional", "情感"], ["conflict", "冲突"], ["uncertain", "未确定"]]) + field("subtype", "关系子类") + field("keywords", "关系关键词（用逗号分隔）") + field("confidence", "置信度（0-1）", "number", "1") + field("directed", "有方向性", "checkbox", false), async (form) => {
    const keywords = String(form.get("keywords") ?? "").split(/[,，、；;]/u).map((value) => value.trim()).filter(Boolean);
    await api(`/api/works/${state.work.id}/relationships`, { method: "POST", body: { fromCharacterId: form.get("from"), toCharacterId: form.get("to"), category: form.get("category"), subtype: form.get("subtype"), keywords, confidence: Number(form.get("confidence")), directed: form.get("directed") === "on", confirmationStatus: "confirmed" } });
    await renderRelationships();
  }, "人工确认关系");
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
    await api(item ? `/api/providers/${item.id}` : `/api/works/${state.work.id}/providers`, { method: item ? "PATCH" : "POST", body });
    await renderAiConfig();
  }, item ? "限流与凭据" : "OpenAI 兼容协议");
}

function openModelDialog(providerId) {
  openDialog("添加模型", field("displayName", "显示名称") + field("modelId", "模型标识符") + field("purposes", "用途（用逗号分隔）", "text", "通用对话, 创作续写") + field("temperature", "默认温度", "number", "0.7") + field("maxTokens", "默认 max_tokens", "number", "32000") + field("enabled", "启用模型", "checkbox", true), async (form) => {
    await api(`/api/providers/${providerId}/models`, { method: "POST", body: { displayName: form.get("displayName"), modelId: form.get("modelId"), purposes: String(form.get("purposes")).split(/[,，]/).map((value) => value.trim()).filter(Boolean), preset: { temperature: Number(form.get("temperature")), max_tokens: Number(form.get("maxTokens")) }, enabled: form.get("enabled") === "on" } });
    await renderAiConfig();
    await loadModels();
  });
}

async function sendAi() {
  if (!state.work || !state.chapter) return toast("请先选择章节", "error");
  const modelId = $("#ai-model").value;
  if (!modelId) return toast("请先在 AI 管理中配置并选择模型", "error");
  const instruction = $("#ai-prompt").value.trim();
  if (!instruction) return toast("请输入指令", "error");
  const taskType = $("#ai-task").value;
  const scopeType = $("#ai-scope").value;
  const selection = $("#chapter-content").value.slice($("#chapter-content").selectionStart, $("#chapter-content").selectionEnd);
  const volume = state.work.volumes.find((item) => item.id === state.chapter.volumeId);
  const scope = scopeType === "book" ? { type: "book" }
    : scopeType === "volume" ? { type: "volume", volumeId: volume.id }
    : scopeType === "selection" ? { type: "selection", chapterId: state.chapter.id, selection }
    : { type: "chapter", chapterId: state.chapter.id, ...(taskType === "polish" ? { selection } : {}) };
  if ($("#ai-character").value) scope.characterIds = [$("#ai-character").value];
  if ($("#ai-setting").value) scope.settingIds = [$("#ai-setting").value];
  if ((scopeType === "selection" || taskType === "polish") && !selection) return toast("请先在正文中选中一段文本", "error");
  const citations = state.aiCitations.map(({ chapterId, chapterTitle, startLine, endLine, text }) => ({ chapterId, chapterTitle, startLine, endLine, text }));
  appendMessage("user", instruction, citations);
  $("#ai-send").disabled = true;
  $("#ai-send").textContent = "发送中";
  try {
    if (taskType === "chat") await streamChat({ instruction, scope, modelId, citations });
    else {
      const suggestion = await api(`/api/works/${state.work.id}/suggestions`, { method: "POST", body: { taskType, instruction, scope, modelId, citations } });
      appendSuggestion(suggestion);
    }
    $("#ai-prompt").value = "";
    state.aiCitations = [];
    renderAiCitations();
  } catch (error) {
    appendMessage("assistant", `调用失败：${error.message}`);
  } finally {
    $("#ai-send").disabled = false;
    $("#ai-send").textContent = "发送";
  }
}

async function streamChat(body) {
  const message = document.createElement("div");
  message.className = "assistant-message is-streaming";
  message.dataset.testid = "ai-stream-message";
  message.innerHTML = '<span>助手 · 正在生成</span><div class="message-body" data-testid="ai-stream-content" aria-live="polite"></div><div class="message-meta">正在连接模型流……</div>';
  $("#ai-feed").append(message);
  const content = message.querySelector(".message-body");
  const meta = message.querySelector(".message-meta");
  let streamedText = "";
  try {
    const response = await fetch(`/api/works/${state.work.id}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
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
        message.querySelector("span").textContent = "助手";
        meta.textContent = `${payload.provider?.name ?? "AI"} · ${payload.model?.displayName ?? "模型"} · 流式完成`;
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
  } catch (error) {
    message.classList.remove("is-streaming");
    message.querySelector("span").textContent = "助手 · 生成中断";
    meta.textContent = "生成中断";
    throw error;
  }
}

function appendMessage(role, text, citations = []) {
  const message = document.createElement("div");
  message.className = role === "user" ? "user-message" : "assistant-message";
  message.innerHTML = `<span>${role === "user" ? "作者" : "助手"}</span><div class="message-body">${renderMarkdown(text)}</div>`;
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
  $("#ai-feed").append(message);
  $("#ai-feed").scrollTop = $("#ai-feed").scrollHeight;
}

function appendSuggestion(suggestion) {
  const message = document.createElement("div");
  message.className = "assistant-message";
  const applicable = suggestion.action !== "note";
  const guard = suggestion.guard;
  const guardHtml = guard ? `<section class="guard-card ${esc(guard.status)}" data-testid="continuation-guard"><strong>${guard.status === "clear" ? "一致性守卫：未发现冲突" : guard.status === "warning" ? `一致性守卫：发现 ${guard.issues.length} 项风险` : "一致性守卫：检查失败"}</strong>${guard.status === "failed" ? `<p>${esc(guard.failure || "无法完成检查，请谨慎采纳")}</p>` : guard.issues.map((issue) => `<p><b>${esc(issue.severity)} · ${esc(issue.type)}</b> ${esc(issue.title)}${issue.description ? `：${esc(issue.description)}` : ""}</p>`).join("")}</section>` : "";
  message.innerHTML = `<span>助手建议</span><div class="message-body">${renderMarkdown(suggestion.content)}</div><div class="message-meta">${esc(suggestion.provider.name)} · ${esc(suggestion.model.displayName)} · 基于 v${suggestion.chapterVersion ?? "-"}</div>${guardHtml}${applicable ? '<div class="message-actions"><button data-action="accept">采纳到正文</button><button data-action="reject">拒绝</button></div>' : ""}`;
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
}

async function showVersions() {
  if (!state.chapter) return;
  const versions = await api(`/api/chapters/${state.chapter.id}/versions`);
  $("#versions-list").innerHTML = versions.map((version) => `<div class="version-row"><div><b>v${version.versionNo}</b><small>${esc(version.source)}</small></div><p>${esc(version.content.slice(0, 300) || "空白章节")}</p><button class="ghost-button" data-restore-version="${version.versionNo}">恢复</button></div>`).join("");
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
    panel.innerHTML = "<strong>尚无章节概览</strong>请在“分析任务”中运行章节理解，结果会先进入审核状态。";
    return;
  }
  const eventNames = insight.events.map((event) => typeof event === "string" ? event : (event.name ?? event.description ?? "未命名事件"));
  const stale = insight.chapterVersion !== state.chapter.versionNo ? `；基于旧版本 v${insight.chapterVersion}` : "";
  panel.innerHTML = `<strong>章节概览${esc(stale)}</strong>${esc(insight.summary || "暂无梗概")}${eventNames.length ? `<br><strong>事件</strong>${esc(eventNames.join("；"))}` : ""}${insight.uncertainties.length ? `<br><strong>待确认</strong>${esc(insight.uncertainties.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("；"))}` : ""}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

$("#home-button").addEventListener("click", () => {
  if (!confirmDiscardChanges()) return;
  loadWorks().catch((error) => toast(error.message, "error"));
});
$("#shelf-new-work").addEventListener("click", openWorkDialog);
$("#welcome-new-work").addEventListener("click", () => state.work ? openChapterDialog() : openWorkDialog());
$("#new-chapter-button").addEventListener("click", openChapterDialog);
$("#save-button").addEventListener("click", saveChapter);
$("#tidy-blank-lines-button").addEventListener("click", tidyChapterBlankLines);
$("#new-volume-button").addEventListener("click", () => openVolumeDialog());
$("#insight-button").addEventListener("click", () => showChapterInsight().catch((error) => toast(error.message, "error")));
$("#versions-button").addEventListener("click", showVersions);
$("#versions-close").addEventListener("click", () => $("#versions-dialog").close());
function cleanupExpandedRelationshipMap() {
  state.relationshipExpandedMap?.destroy?.();
  state.relationshipExpandedMap = null;
}
$("#relationship-map-close").addEventListener("click", () => $("#relationship-map-dialog").close());
$("#relationship-map-dialog").addEventListener("close", cleanupExpandedRelationshipMap);
$("#appearance-button").addEventListener("click", openAppearanceDialog);
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
});
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
$("#module-nav").addEventListener("click", (event) => event.target.dataset.module && showModule(event.target.dataset.module));
$("#module-more-button").addEventListener("click", () => setModuleNavExpanded(!moduleNavExpanded));
$("#module-create-button").addEventListener("click", () => ({ settings: openSettingDialog, characters: openCharacterDialog, organizations: openOrganizationDialog, timeline: openTimelineDialog, outlines: openForeshadowDialog, relationships: openRelationshipDialog, reviews: openReviewDialog, tasks: openTaskDialog, "ai-config": openProviderDialog })[state.module]?.());
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
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeChapterTypeMenu();
    closeLineCitationMenu();
  }
});
$("#ai-send").addEventListener("click", sendAi);
$("#ai-prompt").addEventListener("keydown", (event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") sendAi(); });
$(".quick-actions").addEventListener("click", (event) => {
  const button = event.target.closest("[data-task]");
  if (!button) return;
  $("#ai-task").value = button.dataset.task;
  $("#ai-prompt").value = button.dataset.prompt;
  $("#ai-prompt").focus();
});
$("#search-button").addEventListener("click", async () => {
  if (!state.work) return;
  const query = window.prompt("搜索正文、设定或角色：");
  if (!query) return;
  const results = await api(`/api/works/${state.work.id}/search?q=${encodeURIComponent(query)}`);
  toast(results.length ? `找到 ${results.length} 条结果：${results.slice(0, 3).map((item) => item.title).join("、")}` : "未找到相关内容");
});
$("#export-button").addEventListener("click", () => {
  if (state.work) window.location.href = `/api/works/${state.work.id}/export?format=markdown`;
});
window.addEventListener("beforeunload", (event) => { if (state.dirty) event.preventDefault(); });

loadWorks().catch((error) => toast(`系统初始化失败：${error.message}`, "error"));
