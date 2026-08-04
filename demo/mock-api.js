import { analysisTasks, works as sourceWorks } from "./data.js";
import { buildBrowserAiMessages, createBrowserAiStore, normalizeProviderBaseUrl, publicProvider, requestBrowserAi, testBrowserAiModel, testBrowserAiProvider } from "./browser-ai.js";
import { DEMO_CREDENTIALS as demoCredentials, isValidDemoLogin } from "./demo-auth.js";
import { DEMO_COVER_VERSIONS, DEMO_VERSION } from "./demo-version.js";

const now = "2026-07-25T10:00:00.000Z";
const nativeFetch = window.fetch.bind(window);
const browserAiStore = createBrowserAiStore(window.localStorage);
const demoAuthStorageKey = "scriverse-demo-authenticated";
const demoUser = Object.freeze({
  userId: "demo-user",
  username: demoCredentials.username,
  displayName: "体验作者",
  role: "admin",
  status: "active",
  onboardingCompleted: true,
  avatarUrl: null
});

function installDemoLoginHint() {
  const mount = () => {
    if (document.querySelector("#demo-login-hint")) return;
    const description = document.querySelector("#auth-description");
    if (!description) return;
    const hint = document.createElement("p");
    hint.id = "demo-login-hint";
    hint.className = "auth-security-hint";
    hint.textContent = `演示账号：${demoCredentials.username}　密码：${demoCredentials.password}`;
    description.insertAdjacentElement("afterend", hint);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
}

installDemoLoginHint();

function installDemoFooterNotice() {
  const mount = () => {
    document.querySelectorAll("[data-product-footer]").forEach((footer) => {
      if (footer.querySelector(".demo-product-footer-notice")) return;
      const notice = document.createElement("span");
      notice.className = "product-footer-development demo-product-footer-notice";
      notice.textContent = "演示站";
      footer.append(notice);
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
}

installDemoFooterNotice();

function installBrowserAiNotice() {
  const mount = () => {
    const host = document.querySelector("#platform-ai-content");
    if (!host?.children.length || host.querySelector(".demo-browser-ai-notice")) return;
    const section = document.createElement("section");
    section.className = "config-section demo-browser-ai-notice";
    const header = document.createElement("div");
    header.className = "config-section-header";
    const copy = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = "演示站前端直连模式";
    const description = document.createElement("p");
    description.textContent = "供应商、模型和 API Key 仅保存在当前浏览器。AI 请求由浏览器直接发往你配置的 OpenAI 兼容接口，不经过演示站服务器；演示站服务器不会接收、记录或存储 API Key。请仅在可信设备上使用，并确认服务商支持浏览器跨域请求（CORS）。";
    copy.append(title, description);
    header.append(copy);
    section.append(header);
    host.prepend(section);
  };
  const observe = () => {
    mount();
    new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observe, { once: true });
  else observe();
}

installBrowserAiNotice();

const wordCount = (text) => Array.from(String(text ?? "").replace(/\s/gu, "")).length;
const page = (items, url) => {
  const pageNumber = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const limit = Math.max(1, Number(url.searchParams.get("limit") ?? 50));
  const start = (pageNumber - 1) * limit;
  const values = items.slice(start, start + limit);
  return { items: values, page: pageNumber, limit, hasMore: start + limit < items.length, nextPage: start + limit < items.length ? pageNumber + 1 : null };
};

function buildWork(source) {
  const id = source.id;
  const chapters = source.chapters.map((chapter) => ({
    id: `${id}-${chapter.id}`,
    workId: id,
    volumeId: "",
    title: chapter.title,
    content: chapter.content,
    chapterType: "正文",
    order: chapter.number,
    sortOrder: 0,
    wordCount: wordCount(chapter.content),
    versionNo: chapter.version,
    excludedFromAnalysis: false,
    analysisStatus: "completed",
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    versions: []
  }));
  const volumes = source.volumes.map((volume, index) => {
    const volumeId = `${id}-volume-${index + 1}`;
    const volumeChapters = chapters.filter((chapter) => chapter.order >= volume.range[0] && chapter.order <= volume.range[1]);
    volumeChapters.forEach((chapter, chapterIndex) => {
      chapter.volumeId = volumeId;
      chapter.sortOrder = chapterIndex;
      chapter.versions = [{
        id: `${chapter.id}-version-${chapter.versionNo}`,
        chapterId: chapter.id,
        versionNo: chapter.versionNo,
        title: chapter.title,
        content: chapter.content,
        source: "manual",
        changeNote: "演示站预制正文",
        actor: "体验作者",
        createdAt: now
      }];
    });
    return { id: volumeId, workId: id, title: volume.name, kind: "main", order: index + 1, sortOrder: index, versionNo: 1, chapters: volumeChapters };
  });
  const races = source.races.map((race, index) => ({
    id: `${id}-race-${index + 1}`,
    workId: id,
    name: race.name,
    description: race.traits,
    parentId: null,
    parentName: race.parent,
    path: [race.name],
    settings: [{ title: "族群概况", value: `${race.population}。${race.traits}` }],
    effectiveSettings: [{ title: "族群概况", value: `${race.population}。${race.traits}`, inherited: false, sourceRaceName: race.name }],
    memberIds: [],
    members: [],
    versionNo: 1
  }));
  races.forEach((race) => {
    const parent = races.find((candidate) => candidate.name === race.parentName);
    race.parentId = parent?.id ?? null;
    race.path = parent ? [parent.name, race.name] : [race.name];
  });
  const organizations = source.organizations.map((organization, index) => ({
    id: `${id}-organization-${index + 1}`,
    workId: id,
    name: organization.name,
    description: organization.stance,
    settings: [`类型：${organization.type}`, `规模：${organization.members} 人`],
    settingsSections: [{ id: `${id}-organization-${index + 1}-section`, title: "组织立场", contentMarkdown: organization.stance }],
    memberIds: [],
    members: [],
    versionNo: 1
  }));
  const characters = source.characters.map((character) => {
    const race = races.find((item) => item.name === character.race) ?? null;
    const organization = organizations.find((item) => item.name === character.org) ?? null;
    const item = {
      id: `${id}-character-${character.id}`,
      workId: id,
      name: character.name,
      aliases: character.tags,
      code: "",
      species: character.race,
      raceId: race?.id ?? null,
      race,
      attributes: { identity: character.role, details: [{ label: "年龄", value: character.age }] },
      currentState: { 身份: character.role, 所属: character.org },
      profile: { summary: character.detail },
      organizations: organization ? [{ id: organization.id, name: organization.name }] : [],
      lockedFields: [],
      profileSectionCount: 0,
      versionNo: 1,
      createdAt: now,
      updatedAt: now
    };
    if (race) {
      race.memberIds.push(item.id);
      race.members.push({ id: item.id, name: item.name });
    }
    if (organization) {
      organization.memberIds.push(item.id);
      organization.members.push({ id: item.id, name: item.name });
    }
    return item;
  });
  const settings = source.settings.map((setting, index) => ({
    id: `${id}-setting-${index + 1}`,
    workId: id,
    category: setting.type,
    title: setting.title,
    content: setting.content,
    status: "confirmed",
    locked: setting.locked,
    versionNo: 1,
    createdAt: now,
    updatedAt: now
  }));
  const trackNames = [...new Set(source.timeline.map((item) => item.track))];
  const timelineTracks = trackNames.map((name, index) => ({ id: `${id}-track-${index + 1}`, workId: id, name, description: `${name}相关的大事件`, sortOrder: index + 1, versionNo: 1 }));
  const timeline = source.timeline.map((event, index) => ({
    id: `${id}-event-${index + 1}`,
    workId: id,
    trackId: timelineTracks.find((track) => track.name === event.track)?.id ?? null,
    name: event.title,
    timeLabel: event.date,
    description: `发生于${event.chapter}，推动${event.track}发展。`,
    location: "",
    status: "confirmed",
    sortOrder: index + 1,
    participantIds: [],
    evidence: [],
    versionNo: 1
  }));
  const outlines = chapters.map((chapter, index) => ({
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    volumeTitle: volumes.find((volume) => volume.id === chapter.volumeId)?.title ?? "正文",
    goal: source.chapters[index].summary,
    conflict: source.chapters[index].content.split("\n\n")[1] ?? "",
    turningPoint: source.chapters[index].content.split("\n\n")[2] ?? "",
    status: index < chapters.length - 2 ? "completed" : "planned",
    unresolvedForeshadowCount: index === chapters.length - 1 ? 1 : 0,
    versionNo: 1
  }));
  const foreshadows = source.outlines.map((item, index) => ({
    id: `${id}-foreshadow-${index + 1}`,
    workId: id,
    title: item.title,
    description: item.note,
    importance: item.type === "主线" ? "critical" : "major",
    status: item.status === "已回收" ? "resolved" : "planted",
    unresolved: item.status !== "已回收",
    overdue: false,
    occurrences: [],
    versionNo: 1
  }));
  const characterBySourceId = new Map(source.characters.map((character, index) => [character.id, characters[index]]));
  const relationships = source.relations.map((relationship, index) => ({
    id: `${id}-relationship-${index + 1}`,
    workId: id,
    fromCharacterId: characterBySourceId.get(relationship.from)?.id,
    toCharacterId: characterBySourceId.get(relationship.to)?.id,
    category: ({ "亲属": "family", "情感": "emotional", "冲突": "conflict", "社交": "social" })[relationship.kind] ?? "uncertain",
    subtype: relationship.label,
    keywords: [relationship.label],
    directed: false,
    confidence: 0.93,
    confirmationStatus: "confirmed",
    evidence: [{ chapterId: chapters[0].id, quote: relationship.evidence }],
    versionNo: 1
  }));
  const tasks = analysisTasks.map((task, index) => ({
    id: `${id}-task-${index + 1}`,
    workId: id,
    taskType: ["consistency-check", "relationship-analysis", "book-analysis", "chapter-analysis"][index] ?? "book-analysis",
    scope: { type: "book" },
    scopeSummary: "全书",
    status: task.status === "排队中" ? "pending" : "completed",
    progress: task.status === "排队中" ? 0 : 100,
    result: { summary: task.result },
    failures: [],
    createdAt: now,
    updatedAt: now
  }));
  const chapterAnnotations = chapters.slice(0, 3).map((chapter, index) => {
    const lines = chapter.content.replace(/\r\n?/gu, "\n").split("\n");
    const startLine = Math.min(lines.length, index + 1);
    const endLine = Math.min(lines.length, startLine + (index === 1 ? 1 : 0));
    return {
      id: `${id}-chapter-annotation-${index + 1}`,
      workId: id,
      chapterId: chapter.id,
      kind: index === 1 ? "todo" : "note",
      startLine,
      endLine,
      quote: lines.slice(startLine - 1, endLine).join("\n"),
      note: ["确认这里的时间线与前一章衔接。", "补充角色进入场景时的动作。", "这句氛围很好，可以在后文形成呼应。"][index],
      status: index === 2 ? "resolved" : "open",
      versionNo: 1,
      actor: demoUser.displayName,
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    };
  });
  const wordTotal = chapters.reduce((total, chapter) => total + chapter.wordCount, 0);
  return {
    id,
    title: source.title,
    author: source.author,
    description: source.synopsis,
    accessRole: "owner",
    modulePermissions: null,
    coverUrl: `/demo-covers/${id}.webp?v=${encodeURIComponent(DEMO_COVER_VERSIONS[id] ?? "0")}`,
    chapterCount: chapters.length,
    wordCount: wordTotal,
    versionNo: 1,
    createdAt: now,
    updatedAt: now,
    volumes,
    chapters,
    characters,
    settings,
    races,
    organizations,
    timelineTracks,
    timeline,
    outlines,
    foreshadows,
    relationships,
    reviews: [],
    tasks,
    chapterAnnotations,
    relationshipSearchIndex: {
      workId: id,
      status: "ready",
      generation: 1,
      queuedSourceCount: 0,
      queuedSources: [],
      indexedSourceCount: settings.length + characters.length + organizations.length + timeline.length + relationships.length,
      indexedParagraphCount: chapters.reduce((total, chapter) => total + chapter.content.replace(/\r\n?/gu, "\n").split(/\n{2,}/u).length, 0),
      error: "",
      updatedAt: now
    },
    auditLogs: [
      { id: `${id}-audit-work`, action: "work.created", entityType: "work", entityId: id, actor: "体验作者", userId: "demo-user", detail: {}, createdAt: now },
      { id: `${id}-audit-import`, action: "work.imported", entityType: "work", entityId: id, actor: "体验作者", userId: "demo-user", detail: { chapters: chapters.length }, createdAt: now }
    ],
    writingGoal: { dailyGoal: 1000, targetTotal: 100000, deadline: null, updatedAt: null }
  };
}

const works = sourceWorks.map(buildWork);
const findWork = (id) => works.find((work) => work.id === id);
const allChapters = (includeDeleted = false) => works.flatMap((work) => work.chapters.filter((chapter) => includeDeleted || !chapter.deletedAt));
const success = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify({ data }), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" }
});
const failure = (message, status = 404) => new Response(JSON.stringify({ error: { message } }), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" }
});
const bodyOf = async (init) => {
  if (!init?.body || init.body instanceof FormData) return {};
  try { return JSON.parse(String(init.body)); } catch { return {}; }
};

function findChapterRecord(chapterId, includeDeleted = false) {
  for (const work of works) {
    const chapter = work.chapters.find((item) => item.id === chapterId && (includeDeleted || !item.deletedAt));
    if (chapter) return { work, chapter };
  }
  return null;
}

function syncWorkChapters(work) {
  for (const volume of work.volumes) {
    volume.chapters = work.chapters
      .filter((chapter) => !chapter.deletedAt && chapter.volumeId === volume.id)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
    volume.chapters.forEach((chapter, index) => { chapter.sortOrder = index; });
  }
  const active = work.chapters.filter((chapter) => !chapter.deletedAt);
  work.chapterCount = active.length;
  work.wordCount = active.reduce((total, chapter) => total + chapter.wordCount, 0);
  work.updatedAt = new Date().toISOString();
}

function workView(work) {
  return {
    ...work,
    chapters: work.chapters.filter((chapter) => !chapter.deletedAt),
    volumes: work.volumes.map((volume) => ({ ...volume, chapters: [...volume.chapters] }))
  };
}

function recordAudit(work, action, entityType, entityId, detail = {}) {
  work.auditLogs.unshift({
    id: demoId("audit"),
    action,
    entityType,
    entityId,
    actor: demoUser.displayName,
    userId: demoUser.userId,
    detail,
    createdAt: new Date().toISOString()
  });
}

function recordChapterVersion(chapter, source, changeNote) {
  chapter.versions.unshift({
    id: demoId("chapter-version"),
    chapterId: chapter.id,
    versionNo: chapter.versionNo,
    title: chapter.title,
    content: chapter.content,
    source,
    changeNote,
    actor: demoUser.displayName,
    createdAt: new Date().toISOString()
  });
}

function moveChapter(work, chapter, volumeId, requestedSortOrder) {
  const targetVolume = work.volumes.find((volume) => volume.id === volumeId);
  if (!targetVolume) return false;
  const sourceVolumeId = chapter.volumeId;
  for (const volume of work.volumes) {
    volume.chapters = volume.chapters.filter((item) => item.id !== chapter.id);
  }
  const targetChapters = work.chapters
    .filter((item) => !item.deletedAt && item.id !== chapter.id && item.volumeId === volumeId)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  const targetIndex = Math.min(Math.max(0, Number(requestedSortOrder) || 0), targetChapters.length);
  targetChapters.splice(targetIndex, 0, chapter);
  chapter.volumeId = volumeId;
  chapter.versionNo += 1;
  chapter.analysisStatus = "expired";
  chapter.updatedAt = new Date().toISOString();
  targetChapters.forEach((item, index) => { item.sortOrder = index; });
  syncWorkChapters(work);
  recordChapterVersion(chapter, "manual", sourceVolumeId === volumeId ? "调整章节顺序" : "移动章节分卷");
  recordAudit(work, "chapter.moved", "chapter", chapter.id, { volumeId, sortOrder: targetIndex, fromVolumeId: sourceVolumeId, versionNo: chapter.versionNo });
  return true;
}

function softDeleteChapter(work, chapter, batch = false) {
  chapter.versionNo += 1;
  chapter.deletedAt = new Date().toISOString();
  chapter.updatedAt = chapter.deletedAt;
  recordChapterVersion(chapter, "delete", batch ? "批量删除章节（可恢复）" : "删除章节");
  recordAudit(work, "chapter.deleted", "chapter", chapter.id, { versionNo: chapter.versionNo, batch, recoverable: true });
  syncWorkChapters(work);
}

function permanentlyDeleteChapter(work, chapter) {
  const detail = {
    title: chapter.title,
    volumeId: chapter.volumeId,
    versionNo: chapter.versionNo,
    recoverable: false
  };
  work.chapters = work.chapters.filter((item) => item.id !== chapter.id);
  work.chapterAnnotations = work.chapterAnnotations.filter((annotation) => annotation.chapterId !== chapter.id);
  work.outlines = work.outlines.filter((outline) => outline.chapterId !== chapter.id);
  for (const item of [...work.timeline, ...work.relationships]) {
    if (Array.isArray(item.evidence)) item.evidence = item.evidence.filter((evidence) => evidence.chapterId !== chapter.id);
  }
  for (const foreshadow of work.foreshadows) {
    if (Array.isArray(foreshadow.occurrences)) foreshadow.occurrences = foreshadow.occurrences.filter((occurrence) => occurrence.chapterId !== chapter.id);
  }
  recordAudit(work, "chapter.purged", "chapter", chapter.id, detail);
  syncWorkChapters(work);
}

function writingProgress(work) {
  const currentWords = work.wordCount;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const trend = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - 29 + index);
    const isToday = index === 29;
    return { date: date.toISOString().slice(0, 10), words: isToday ? currentWords : 0, delta: isToday ? currentWords : 0 };
  });
  return {
    goal: { ...work.writingGoal },
    currentWords,
    todayWords: currentWords,
    dailyCompletion: work.writingGoal.dailyGoal > 0 ? Math.min(1, currentWords / work.writingGoal.dailyGoal) : 0,
    totalCompletion: work.writingGoal.targetTotal > 0 ? Math.min(1, currentWords / work.writingGoal.targetTotal) : 0,
    trend
  };
}

const demoId = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const defaultWorkAiSettings = () => ({ systemPrompt: "", bookSummaryContextPercent: 20, contextCompactThreshold: 80, agentTools: [], autoRunEnabled: false, autoRunConcurrency: 2, autoRunBatchLimit: 20 });
const minimumModelContextWindow = 32_768;
const modelWithProvider = (model, providers) => {
  const provider = providers.find((item) => item.id === model.providerId);
  return { ...model, providerName: provider?.name ?? "未找到供应商", providerStatus: provider?.status ?? "disabled", providerConnectionStatus: provider?.connectionStatus ?? "untested" };
};

function contextUsage(model, conversation = null) {
  const contextWindow = Math.max(minimumModelContextWindow, Number(model?.contextWindow ?? 128_000));
  const systemPromptTokens = 320;
  const functionTokens = 180;
  const skillsTokens = 0;
  const contextTokens = 1_200;
  const conversationTokens = (conversation?.messages ?? []).reduce((total, message) => total + Math.ceil(Array.from(String(message.content ?? "")).length / 2), 0);
  const conversationBudgetTokens = Math.max(1, Math.floor(contextWindow * 0.45));
  const outputReserveTokens = Math.min(32_000, Number(model?.preset?.max_tokens ?? 32_000));
  const inputTokens = systemPromptTokens + functionTokens + contextTokens + conversationTokens;
  const occupiedTokens = inputTokens + outputReserveTokens;
  return {
    inputTokens,
    outputTokens: 0,
    totalTokens: inputTokens,
    contextTokens,
    conversationTokens,
    conversationBudgetTokens,
    outputReserveTokens,
    contextWindow,
    usagePercent: Math.min(100, Math.round(occupiedTokens / contextWindow * 100)),
    conversationUsagePercent: Math.min(100, Math.round(conversationTokens / conversationBudgetTokens * 100)),
    compactThreshold: 80,
    tokenDistribution: { systemPromptTokens, functionTokens, skillsTokens, contextTokens: contextTokens + conversationTokens }
  };
}

function conversationSummaries(state, workId) {
  return [...(state.conversations[workId] ?? [])]
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .map(({ messages, ...conversation }) => ({ ...conversation, messageCount: messages.length }));
}

function findConversation(state, conversationId) {
  return Object.values(state.conversations).flat().find((item) => item.id === conversationId);
}

function createConversationRecord(workId, title = "新对话") {
  const createdAt = new Date().toISOString();
  return { id: demoId("conversation"), workId, title, messages: [], createdAt, updatedAt: createdAt, contextWarningPending: false, compactedMessageCount: 0, hasCompactedSummary: false };
}

function conversationSummary(conversation) {
  const { messages, ...summary } = conversation;
  return { ...summary, messageCount: messages.length, preview: messages.at(-1)?.content ?? "" };
}

function appendConversationMessage(conversation, { role, content, citations = [], metadata = {} }) {
  const createdAt = new Date().toISOString();
  const message = { id: demoId("message"), conversationId: conversation.id, role, content: String(content ?? ""), citations, metadata, createdAt };
  conversation.messages.push(message);
  conversation.updatedAt = createdAt;
  if (conversation.title === "新对话" && role === "user") conversation.title = Array.from(message.content.replace(/\s+/gu, " ").trim()).slice(0, 15).join("") || "新对话";
  return message;
}

function demoTokenUsage(workId = null, includeWorks = false) {
  const state = browserAiStore.read();
  const targetWorks = workId ? works.filter((work) => work.id === workId) : works;
  const workRows = targetWorks.map((work) => {
    const messages = (state.conversations[work.id] ?? []).flatMap((conversation) => conversation.messages ?? []);
    const inputTokens = messages.filter((message) => message.role === "user").reduce((total, message) => total + Math.ceil(Array.from(String(message.content ?? "")).length / 2), 0);
    const outputTokens = messages.filter((message) => message.role === "assistant").reduce((total, message) => total + Number(message.metadata?.outputTokens ?? Math.ceil(Array.from(String(message.content ?? "")).length / 2)), 0);
    const timestamps = messages.map((message) => String(message.createdAt ?? "")).filter(Boolean).sort();
    return {
      workId: work.id,
      workTitle: work.title,
      totalTokens: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      cachedInputTokens: 0,
      cacheEligibleInputTokens: 0,
      cacheHitRate: null,
      requestCount: messages.filter((message) => message.role === "assistant").length,
      estimatedRequestCount: messages.filter((message) => message.role === "assistant").length,
      firstUsedAt: timestamps[0] ?? null,
      lastUsedAt: timestamps.at(-1) ?? null
    };
  });
  const summary = workRows.reduce((total, row) => ({
    ...total,
    totalTokens: total.totalTokens + row.totalTokens,
    inputTokens: total.inputTokens + row.inputTokens,
    outputTokens: total.outputTokens + row.outputTokens,
    requestCount: total.requestCount + row.requestCount,
    estimatedRequestCount: total.estimatedRequestCount + row.estimatedRequestCount,
    firstUsedAt: [total.firstUsedAt, row.firstUsedAt].filter(Boolean).sort()[0] ?? null,
    lastUsedAt: [total.lastUsedAt, row.lastUsedAt].filter(Boolean).sort().at(-1) ?? null
  }), { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheEligibleInputTokens: 0, cacheHitRate: null, requestCount: 0, estimatedRequestCount: 0, firstUsedAt: null, lastUsedAt: null });
  const dailyByDate = new Map();
  for (const work of targetWorks) {
    for (const conversation of state.conversations[work.id] ?? []) {
      for (const message of conversation.messages ?? []) {
        const date = String(message.createdAt ?? new Date().toISOString()).slice(0, 10);
        const row = dailyByDate.get(date) ?? { date, totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheEligibleInputTokens: 0, cacheHitRate: null, requestCount: 0, estimatedRequestCount: 0 };
        const tokens = Number(message.metadata?.outputTokens ?? Math.ceil(Array.from(String(message.content ?? "")).length / 2));
        if (message.role === "assistant") {
          row.outputTokens += tokens;
          row.requestCount += 1;
          row.estimatedRequestCount += 1;
        } else if (message.role === "user") {
          row.inputTokens += tokens;
        }
        row.totalTokens += tokens;
        dailyByDate.set(date, row);
      }
    }
  }
  return { summary, daily: [...dailyByDate.values()].sort((left, right) => left.date.localeCompare(right.date)), ...(includeWorks ? { works: workRows.sort((left, right) => right.totalTokens - left.totalTokens || left.workTitle.localeCompare(right.workTitle, "zh-CN")) } : {}), timezoneOffset: 0 };
}

async function runBrowserAi(body, workId) {
  const state = browserAiStore.read();
  const model = state.models.find((item) => item.id === body.modelId);
  if (!model?.enabled) throw new Error("所选模型不存在或未启用");
  const provider = state.providers.find((item) => item.id === model.providerId);
  if (!provider || provider.status !== "enabled" || !provider.apiKey) throw new Error("模型供应商未启用或缺少 API Key");
  const work = findWork(workId);
  if (!work) throw new Error("未找到作品");
  const conversation = body.conversationId ? findConversation(state, body.conversationId) : null;
  const settings = { ...defaultWorkAiSettings(), ...(state.workSettings[workId] ?? {}) };
  const messages = buildBrowserAiMessages({
    work: workView(work),
    scope: body.scope,
    instruction: String(body.instruction ?? ""),
    platformPrompt: state.platformSettings.systemPrompt,
    workPrompt: settings.systemPrompt,
    conversationMessages: conversation?.messages ?? [],
    citations: body.citations ?? []
  });
  const result = await requestBrowserAi({ fetchImpl: nativeFetch, provider, model, messages });
  return { ...result, model: modelWithProvider(model, state.providers) };
}

async function runBrowserChat(body, workId) {
  let conversationId = "";
  let contextConversation;
  let userMessage = null;
  browserAiStore.update((state) => {
    let conversation = body.conversationId ? findConversation(state, body.conversationId) : null;
    if (!conversation) {
      conversation = createConversationRecord(workId);
      state.conversations[workId] = [conversation, ...(state.conversations[workId] ?? [])];
    }
    conversationId = conversation.id;
    contextConversation = conversationSummary(conversation);
    if (!body.currentMessageId) {
      userMessage = appendConversationMessage(conversation, { role: "user", content: body.instruction, citations: body.citations ?? [] });
    }
  });
  const result = await runBrowserAi({ ...body, conversationId }, workId);
  let assistantMessage;
  let completedConversation;
  browserAiStore.update((state) => {
    const conversation = findConversation(state, conversationId);
    if (!conversation) return;
    assistantMessage = appendConversationMessage(conversation, {
      role: "assistant",
      content: result.content,
      metadata: { modelDisplayName: result.model.displayName, outputTokens: result.outputTokens }
    });
    completedConversation = conversation;
  });
  return {
    ...result,
    conversationId,
    contextConversation,
    userMessage,
    assistantMessage,
    conversationTitle: completedConversation?.title ?? "新对话",
    contextUsage: contextUsage(result.model, completedConversation)
  };
}

function aiStreamResponse(result) {
  const outputTokens = result.outputTokens || Math.max(1, Math.ceil(Array.from(result.content).length / 2));
  const events = [
    `event: context\ndata: ${JSON.stringify({ action: "ready", usage: result.contextUsage, conversation: result.contextConversation })}`,
    ...(result.userMessage ? [`event: user_message\ndata: ${JSON.stringify({ message: result.userMessage })}`] : []),
    `event: delta\ndata: ${JSON.stringify({ delta: result.content })}`,
    `event: complete\ndata: ${JSON.stringify({ model: { id: result.model.id, displayName: result.model.displayName }, outputTokens, toolCalls: [], processSteps: [], contextUsage: result.contextUsage, conversationId: result.conversationId, conversationTitle: result.conversationTitle, messageId: result.assistantMessage?.id, messageCreatedAt: result.assistantMessage?.createdAt })}`
  ];
  return new Response(`${events.join("\n\n")}\n\n`, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });
}

async function mockApi(input, init = {}) {
  const requestUrl = typeof input === "string" ? input : input.url;
  const url = new URL(requestUrl, window.location.origin);
  if (!url.pathname.startsWith("/api/")) return nativeFetch(input, init);
  const method = String(init.method ?? (typeof input === "string" ? "GET" : input.method) ?? "GET").toUpperCase();
  const path = url.pathname;

  if (path === "/api/health") return success({ ok: true, version: DEMO_VERSION, development: false });
  if (path === "/api/ui-settings" || path === "/api/platform/ui-settings") return success({ toastPosition: "bottom-right" });
  if (path === "/api/auth/captcha") {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="52" viewBox="0 0 160 52"><rect width="160" height="52" rx="8" fill="#f2ebe3"/><path d="M8 38 152 12M12 10l138 32" stroke="#a96350" stroke-opacity=".22"/><text x="80" y="35" text-anchor="middle" font-family="monospace" font-size="27" font-weight="700" letter-spacing="8" fill="#5b3028">2468</text></svg>`;
    return success({ captchaId: "demo-captcha", imageDataUrl: `data:image/svg+xml;base64,${btoa(svg)}` });
  }
  if (path === "/api/auth/login" && method === "POST") {
    const body = await bodyOf(init);
    if (!isValidDemoLogin(body)) return failure("演示账号、密码或验证码不正确", 401);
    sessionStorage.setItem(demoAuthStorageKey, "true");
    return success(demoUser);
  }
  if (path === "/api/auth/session" && method === "DELETE") {
    sessionStorage.removeItem(demoAuthStorageKey);
    return success(null, 204);
  }
  if (path === "/api/auth/session") {
    const authenticated = sessionStorage.getItem(demoAuthStorageKey) === "true";
    return success(authenticated
      ? { authenticated: true, csrfToken: "demo-csrf-token", user: demoUser }
      : { authenticated: false, setupRequired: false, registrationOpen: false });
  }
  if (path === "/api/auth/register") return failure("Demo 不开放注册，请使用页面提供的演示账号", 403);
  if (sessionStorage.getItem(demoAuthStorageKey) !== "true") return failure("请先登录演示账号", 401);
  if (path === "/api/auth/api-key") return success({ configured: false });
  if (path === "/api/auth/onboarding/complete") return success(demoUser);
  if (path === "/api/platform/ai/providers") {
    if (method === "GET") return success(browserAiStore.read().providers.map(publicProvider));
    const body = await bodyOf(init);
    const provider = {
      id: demoId("provider"),
      name: String(body.name ?? "").trim(),
      protocol: body.protocol === "anthropic-messages"
        ? "anthropic-messages"
        : body.protocol === "google-vertex"
          ? "google-vertex"
          : "openai-chat-completions",
      baseUrl: normalizeProviderBaseUrl(body.baseUrl),
      apiKey: String(body.apiKey ?? "").trim(),
      concurrencyLimit: Number(body.concurrencyLimit ?? 10),
      rpmLimit: Number(body.rpmLimit ?? 10),
      maxTokens: Number(body.maxTokens ?? 32000),
      note: String(body.note ?? ""),
      status: body.status === "disabled" ? "disabled" : "enabled",
      connectionStatus: "unchecked",
      lastError: null
    };
    browserAiStore.update((state) => { state.providers.push(provider); });
    return success(publicProvider(provider), 201);
  }
  if (path === "/api/platform/ai/models") {
    const state = browserAiStore.read();
    return success(state.models.map((model) => modelWithProvider(model, state.providers)));
  }
  if (path === "/api/platform/ai/settings") {
    const state = browserAiStore.read();
    if (method === "GET") return success(state.platformSettings);
    const body = await bodyOf(init);
    browserAiStore.update((current) => { current.platformSettings = { ...current.platformSettings, ...body }; });
    return success({ ...state.platformSettings, ...body });
  }
  if (path === "/api/platform/ai/usage") return success(demoTokenUsage(null, true));
  let match = path.match(/^\/api\/providers\/([^/]+)$/u);
  if (match) {
    const providerId = decodeURIComponent(match[1]);
    const body = await bodyOf(init);
    let updated;
    browserAiStore.update((state) => {
      const provider = state.providers.find((item) => item.id === providerId);
      if (!provider) return;
      const connectionChanged = body.baseUrl !== undefined || String(body.apiKey ?? "").trim();
      Object.assign(provider, body, body.baseUrl !== undefined ? { baseUrl: normalizeProviderBaseUrl(body.baseUrl) } : {}, String(body.apiKey ?? "").trim() ? { apiKey: String(body.apiKey).trim() } : {});
      if (connectionChanged) Object.assign(provider, { connectionStatus: "unchecked", lastError: null });
      updated = provider;
    });
    return updated ? success(publicProvider(updated)) : failure("未找到 AI 供应商");
  }
  match = path.match(/^\/api\/providers\/([^/]+)\/test$/u);
  if (match) {
    const providerId = decodeURIComponent(match[1]);
    const provider = browserAiStore.read().providers.find((item) => item.id === providerId);
    if (!provider) return failure("未找到 AI 供应商");
    try {
      const result = await testBrowserAiProvider({ fetchImpl: nativeFetch, provider });
      browserAiStore.update((state) => { Object.assign(state.providers.find((item) => item.id === providerId), { connectionStatus: "success", lastError: null }); });
      return success({ ...result, provider: publicProvider(browserAiStore.read().providers.find((item) => item.id === providerId)) });
    } catch (error) {
      const message = error instanceof TypeError ? "浏览器无法直连该地址，请确认服务商支持 CORS" : error.message;
      browserAiStore.update((state) => { Object.assign(state.providers.find((item) => item.id === providerId), { connectionStatus: "failed", lastError: message }); });
      return success({ ok: false, error: message });
    }
  }
  match = path.match(/^\/api\/providers\/([^/]+)\/models$/u);
  if (match) {
    const providerId = decodeURIComponent(match[1]);
    const body = await bodyOf(init);
    const state = browserAiStore.read();
    if (!state.providers.some((item) => item.id === providerId)) return failure("未找到 AI 供应商");
    if (Number(body.contextWindow ?? 128_000) < minimumModelContextWindow) return failure("模型上下文不能低于 32768 Token", 400);
    const model = { id: demoId("model"), providerId, displayName: String(body.displayName ?? "").trim(), modelId: String(body.modelId ?? "").trim(), purposes: body.purposes ?? ["chat"], contextWindow: Number(body.contextWindow ?? 128000), preset: body.preset ?? { temperature: 0.7, max_tokens: 32000 }, thinkingEnabled: body.thinkingEnabled !== false, enabled: body.enabled !== false };
    browserAiStore.update((current) => { current.models.push(model); });
    return success(modelWithProvider(model, state.providers), 201);
  }
  match = path.match(/^\/api\/models\/([^/]+)$/u);
  if (match) {
    const modelId = decodeURIComponent(match[1]);
    const body = await bodyOf(init);
    if (body.contextWindow !== undefined && Number(body.contextWindow) < minimumModelContextWindow) return failure("模型上下文不能低于 32768 Token", 400);
    let updated;
    browserAiStore.update((state) => {
      const model = state.models.find((item) => item.id === modelId);
      if (!model) return;
      Object.assign(model, body);
      updated = modelWithProvider(model, state.providers);
    });
    return updated ? success(updated) : failure("未找到模型");
  }
  match = path.match(/^\/api\/models\/([^/]+)\/test$/u);
  if (match) {
    const modelId = decodeURIComponent(match[1]);
    const state = browserAiStore.read();
    const model = state.models.find((item) => item.id === modelId);
    const provider = state.providers.find((item) => item.id === model?.providerId);
    if (!model) return failure("未找到模型");
    if (!provider) return failure("未找到 AI 供应商");
    try {
      const result = await testBrowserAiModel({ fetchImpl: nativeFetch, provider, model });
      browserAiStore.update((current) => { Object.assign(current.providers.find((item) => item.id === provider.id), { connectionStatus: "success", lastError: null }); });
      const current = browserAiStore.read();
      return success({ ...result, model: modelWithProvider(model, current.providers), provider: publicProvider(current.providers.find((item) => item.id === provider.id)) });
    } catch (error) {
      const message = error instanceof TypeError ? "浏览器无法直连该地址，请确认服务商支持 CORS" : error.message;
      browserAiStore.update((current) => { Object.assign(current.providers.find((item) => item.id === provider.id), { connectionStatus: "failed", lastError: message }); });
      return success({ ok: false, error: message, model: modelWithProvider(model, browserAiStore.read().providers) });
    }
  }
  match = path.match(/^\/api\/works\/([^/]+)\/models$/u);
  if (match) {
    const state = browserAiStore.read();
    return success(state.models.map((model) => modelWithProvider(model, state.providers)).filter((model) => model.enabled && model.providerStatus === "enabled"));
  }
  match = path.match(/^\/api\/works\/([^/]+)\/ai-settings$/u);
  if (match) {
    const workId = decodeURIComponent(match[1]);
    const body = await bodyOf(init);
    const settings = { ...defaultWorkAiSettings(), ...(browserAiStore.read().workSettings[workId] ?? {}) };
    if (method === "GET") return success(settings);
    browserAiStore.update((state) => { state.workSettings[workId] = { ...settings, ...body }; });
    return success({ ...settings, ...body });
  }
  match = path.match(/^\/api\/works\/([^/]+)\/ai-settings\/usage$/u);
  if (match) {
    const workId = decodeURIComponent(match[1]);
    if (!findWork(workId)) return failure("未找到作品");
    return success(demoTokenUsage(workId));
  }
  match = path.match(/^\/api\/works\/([^/]+)\/task-defaults$/u);
  if (match) {
    const workId = decodeURIComponent(match[1]);
    const state = browserAiStore.read();
    return success(Object.entries(state.taskDefaults[workId] ?? {}).flatMap(([taskType, modelId]) => {
      const model = state.models.find((item) => item.id === modelId);
      return model ? [{ taskType, model: modelWithProvider(model, state.providers) }] : [];
    }));
  }
  match = path.match(/^\/api\/works\/([^/]+)\/task-defaults\/([^/]+)$/u);
  if (match) {
    const workId = decodeURIComponent(match[1]);
    const taskType = decodeURIComponent(match[2]);
    const body = await bodyOf(init);
    browserAiStore.update((state) => { state.taskDefaults[workId] = { ...(state.taskDefaults[workId] ?? {}), [taskType]: body.modelId }; });
    return success({ taskType, modelId: body.modelId });
  }
  match = path.match(/^\/api\/works\/([^/]+)\/ai-settings\/relationship-search-index(?:\/(sync|rebuild))?$/u);
  if (match) {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    const action = match[2];
    if (!action || method === "GET") return success({ ...work.relationshipSearchIndex });
    if (action === "sync" && work.relationshipSearchIndex.queuedSourceCount === 0) return success({ ...work.relationshipSearchIndex }, 202);
    const queuedSources = action === "rebuild"
      ? [
          { sourceType: "chapter", count: work.chapters.filter((chapter) => !chapter.deletedAt).length, oldestQueuedAt: new Date().toISOString() },
          { sourceType: "setting", count: work.settings.length, oldestQueuedAt: new Date().toISOString() }
        ].filter((item) => item.count > 0)
      : work.relationshipSearchIndex.queuedSources;
    work.relationshipSearchIndex = {
      ...work.relationshipSearchIndex,
      status: "queued",
      queuedSources,
      queuedSourceCount: queuedSources.reduce((total, item) => total + item.count, 0),
      updatedAt: new Date().toISOString()
    };
    window.setTimeout(() => {
      work.relationshipSearchIndex = {
        ...work.relationshipSearchIndex,
        status: "ready",
        generation: work.relationshipSearchIndex.generation + 1,
        queuedSourceCount: 0,
        queuedSources: [],
        updatedAt: new Date().toISOString()
      };
    }, 80);
    return success({ ...work.relationshipSearchIndex }, 202);
  }
  match = path.match(/^\/api\/works\/([^/]+)\/ai-conversations$/u);
  if (match) {
    const workId = decodeURIComponent(match[1]);
    if (method === "GET") return success(page(conversationSummaries(browserAiStore.read(), workId), url));
    const conversation = createConversationRecord(workId);
    browserAiStore.update((state) => { state.conversations[workId] = [conversation, ...(state.conversations[workId] ?? [])]; });
    return success(conversationSummary(conversation), 201);
  }
  match = path.match(/^\/api\/ai-conversations\/([^/]+)$/u);
  if (match) {
    const conversation = findConversation(browserAiStore.read(), decodeURIComponent(match[1]));
    return conversation ? success(conversation) : failure("未找到 AI 对话");
  }
  match = path.match(/^\/api\/ai-conversations\/([^/]+)\/messages$/u);
  if (match) {
    const conversationId = decodeURIComponent(match[1]);
    const body = await bodyOf(init);
    let message;
    let found = false;
    browserAiStore.update((state) => {
      const conversation = findConversation(state, conversationId);
      if (!conversation) return;
      message = appendConversationMessage(conversation, body);
      found = true;
    });
    return found ? success(message, 201) : failure("未找到 AI 对话");
  }
  match = path.match(/^\/api\/ai-conversations\/([^/]+)\/fork$/u);
  if (match) {
    const sourceId = decodeURIComponent(match[1]);
    const body = await bodyOf(init);
    let forked;
    browserAiStore.update((state) => {
      const source = findConversation(state, sourceId);
      if (!source) return;
      const boundary = source.messages.findIndex((message) => message.id === body.messageId);
      if (boundary < 0) return;
      forked = createConversationRecord(source.workId, String(body.title ?? `${source.title}（分支）`));
      forked.messages = source.messages.slice(0, boundary + 1).map((message) => ({ ...message, id: demoId("message"), conversationId: forked.id }));
      forked.updatedAt = forked.messages.at(-1)?.createdAt ?? forked.createdAt;
      state.conversations[source.workId] = [forked, ...(state.conversations[source.workId] ?? [])];
    });
    return forked ? success(conversationSummary(forked), 201) : failure("未找到可分支的对话消息");
  }
  match = path.match(/^\/api\/ai-conversations\/([^/]+)\/context\/prepare$/u);
  if (match) {
    const conversation = findConversation(browserAiStore.read(), decodeURIComponent(match[1]));
    if (!conversation) return failure("未找到 AI 对话");
    const body = await bodyOf(init);
    const model = browserAiStore.read().models.find((item) => item.id === body.modelId);
    return success({ action: "ready", usage: contextUsage(model, conversation) });
  }
  match = path.match(/^\/api\/ai-conversations\/([^/]+)\/compact$/u);
  if (match) {
    const conversationId = decodeURIComponent(match[1]);
    const body = await bodyOf(init);
    let compacted;
    browserAiStore.update((state) => {
      const conversation = findConversation(state, conversationId);
      if (!conversation) return;
      const compactedMessageCount = Math.max(0, conversation.messages.length - 4);
      const changed = compactedMessageCount > Number(conversation.compactedMessageCount ?? 0);
      conversation.compactedMessageCount = Math.max(Number(conversation.compactedMessageCount ?? 0), compactedMessageCount);
      conversation.hasCompactedSummary = conversation.compactedMessageCount > 0;
      conversation.contextWarningPending = false;
      const model = state.models.find((item) => item.id === body.modelId);
      compacted = { changed, compactedMessageCount: conversation.compactedMessageCount, usage: contextUsage(model, conversation) };
    });
    return compacted ? success(compacted) : failure("未找到 AI 对话");
  }
  match = path.match(/^\/api\/works\/([^/]+)\/ai-context-usage$/u);
  if (match) {
    const body = await bodyOf(init);
    const state = browserAiStore.read();
    const model = state.models.find((item) => item.id === body.modelId);
    const conversation = body.conversationId ? findConversation(state, body.conversationId) : null;
    return success(contextUsage(model, conversation));
  }
  match = path.match(/^\/api\/works\/([^/]+)\/chat\/stream$/u);
  if (match) {
    try {
      return aiStreamResponse(await runBrowserChat(await bodyOf(init), decodeURIComponent(match[1])));
    } catch (error) {
      const message = error instanceof TypeError ? "浏览器直连失败，请确认接口地址、网络与 CORS 配置" : error.message;
      return failure(message, 502);
    }
  }
  match = path.match(/^\/api\/works\/([^/]+)\/suggestions$/u);
  if (match) {
    try {
      const body = await bodyOf(init);
      const result = await runBrowserAi(body, decodeURIComponent(match[1]));
      const chapter = allChapters().find((item) => item.id === body.scope?.chapterId);
      const conversation = body.conversationId ? findConversation(browserAiStore.read(), body.conversationId) : null;
      return success({ id: demoId("suggestion"), content: result.content, action: "note", chapterVersion: chapter?.versionNo ?? 1, outputTokens: result.outputTokens || Math.max(1, Math.ceil(Array.from(result.content).length / 2)), model: { id: result.model.id, displayName: result.model.displayName }, contextUsage: contextUsage(result.model, conversation) }, 201);
    } catch (error) {
      const message = error instanceof TypeError ? "浏览器直连失败，请确认接口地址、网络与 CORS 配置" : error.message;
      return failure(message, 502);
    }
  }
  match = path.match(/^\/api\/works\/([^/]+)\/deleted-chapters$/u);
  if (match) {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    return success(work.chapters.filter((chapter) => chapter.deletedAt).sort((left, right) => String(right.deletedAt).localeCompare(String(left.deletedAt))).map((chapter) => ({
      id: chapter.id,
      workId: work.id,
      volumeId: chapter.volumeId,
      volumeTitle: work.volumes.find((volume) => volume.id === chapter.volumeId)?.title ?? "原分卷",
      title: chapter.title,
      contentPreview: chapter.content.slice(0, 240),
      wordCount: chapter.wordCount,
      versionNo: chapter.versionNo,
      actor: demoUser.displayName,
      deletedAt: chapter.deletedAt
    })));
  }
  match = path.match(/^\/api\/works\/([^/]+)\/audit-logs$/u);
  if (match) {
    const work = findWork(decodeURIComponent(match[1]));
    return work ? success(page(work.auditLogs, url)) : failure("未找到作品");
  }
  match = path.match(/^\/api\/works\/([^/]+)\/chapter-annotations$/u);
  if (match) {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    const annotations = work.chapterAnnotations
      .filter((annotation) => !annotation.deletedAt && work.chapters.some((chapter) => chapter.id === annotation.chapterId && !chapter.deletedAt))
      .map((annotation) => {
        const chapter = work.chapters.find((item) => item.id === annotation.chapterId);
        const volume = work.volumes.find((item) => item.id === chapter?.volumeId);
        return { ...annotation, chapterTitle: chapter?.title ?? "未找到章节", volumeTitle: volume?.title ?? "正文" };
      })
      .sort((left, right) => Number(left.status === "resolved") - Number(right.status === "resolved") || String(right.createdAt).localeCompare(String(left.createdAt)));
    return success(page(annotations, url));
  }
  match = path.match(/^\/api\/works\/([^/]+)\/writing-progress$/u);
  if (match) {
    const work = findWork(decodeURIComponent(match[1]));
    return work ? success(writingProgress(work)) : failure("未找到作品");
  }
  match = path.match(/^\/api\/works\/([^/]+)\/writing-goal$/u);
  if (match && method === "PUT") {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    const body = await bodyOf(init);
    work.writingGoal = {
      dailyGoal: Number(body.dailyGoal ?? 0),
      targetTotal: Number(body.targetTotal ?? 0),
      deadline: body.deadline ?? null,
      updatedAt: new Date().toISOString()
    };
    recordAudit(work, "work.writing_goal.updated", "work", work.id, work.writingGoal);
    return success(writingProgress(work));
  }
  match = path.match(/^\/api\/works\/([^/]+)\/chapters\/batch$/u);
  if (match && method === "POST") {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    const body = await bodyOf(init);
    const selected = (body.chapters ?? []).map((input) => ({ input, chapter: work.chapters.find((chapter) => chapter.id === input.id && !chapter.deletedAt) }));
    if (!selected.length || selected.some(({ input, chapter }) => !chapter || chapter.versionNo !== Number(input.expectedVersionNo))) return failure("章节版本已变化，请刷新后重试", 409);
    if (body.action?.type === "move") {
      const targetCount = work.chapters.filter((item) => !item.deletedAt && item.volumeId === body.action.volumeId && !selected.some((entry) => entry.chapter?.id === item.id)).length;
      for (const [index, { chapter }] of selected.entries()) {
        if (!moveChapter(work, chapter, body.action.volumeId, targetCount + index)) return failure("未找到目标分卷");
      }
    } else if (body.action?.type === "setType") {
      for (const { chapter } of selected) {
        chapter.chapterType = body.action.chapterType;
        chapter.analysisStatus = "expired";
        chapter.updatedAt = new Date().toISOString();
        recordAudit(work, "chapter.saved", "chapter", chapter.id, { chapterType: chapter.chapterType, batch: true });
      }
    } else if (body.action?.type === "setAnalysisExclusion") {
      for (const { chapter } of selected) {
        chapter.excludedFromAnalysis = Boolean(body.action.excludedFromAnalysis);
        chapter.updatedAt = new Date().toISOString();
        recordAudit(work, "chapter.saved", "chapter", chapter.id, { excludedFromAnalysis: chapter.excludedFromAnalysis, batch: true });
      }
    } else if (body.action?.type === "delete") {
      for (const { chapter } of selected) softDeleteChapter(work, chapter, true);
    } else return failure("不支持的批量操作", 400);
    syncWorkChapters(work);
    return success({ processed: selected.length, action: body.action.type });
  }
  match = path.match(/^\/api\/chapters\/([^/]+)\/move$/u);
  if (match && method === "POST") {
    const found = findChapterRecord(decodeURIComponent(match[1]));
    if (!found) return failure("未找到章节");
    const body = await bodyOf(init);
    if (found.chapter.versionNo !== Number(body.expectedVersionNo)) return failure("章节版本已变化，请刷新后重试", 409);
    return moveChapter(found.work, found.chapter, body.volumeId, body.sortOrder) ? success(found.chapter) : failure("未找到目标分卷");
  }
  match = path.match(/^\/api\/chapters\/([^/]+)\/restore$/u);
  if (match && method === "POST") {
    const found = findChapterRecord(decodeURIComponent(match[1]), true);
    if (!found?.chapter.deletedAt) return failure("未找到已删除章节");
    const body = await bodyOf(init);
    if (found.chapter.versionNo !== Number(body.expectedVersionNo)) return failure("章节版本已变化，请刷新后重试", 409);
    found.chapter.deletedAt = null;
    found.chapter.versionNo += 1;
    found.chapter.updatedAt = new Date().toISOString();
    syncWorkChapters(found.work);
    recordChapterVersion(found.chapter, "restore", `恢复至 v${Number(body.versionNo)}`);
    recordAudit(found.work, "chapter.restored", "chapter", found.chapter.id, { versionNo: found.chapter.versionNo, fromVersion: Number(body.versionNo) });
    return success(found.chapter);
  }
  match = path.match(/^\/api\/chapters\/([^/]+)\/permanent$/u);
  if (match && method === "DELETE") {
    const found = findChapterRecord(decodeURIComponent(match[1]), true);
    if (!found) return failure("未找到章节");
    if (!found.chapter.deletedAt) return failure("仅回收站中的章节可以彻底删除", 409);
    const body = await bodyOf(init);
    if (body.expectedVersionNo !== undefined && found.chapter.versionNo !== Number(body.expectedVersionNo)) return failure("章节版本已变化，请刷新后重试", 409);
    permanentlyDeleteChapter(found.work, found.chapter);
    return success(null, 204);
  }
  match = path.match(/^\/api\/chapters\/([^/]+)\/versions$/u);
  if (match) {
    const found = findChapterRecord(decodeURIComponent(match[1]), true);
    return found ? success(found.chapter.versions) : failure("未找到章节");
  }
  match = path.match(/^\/api\/chapters\/([^/]+)\/annotations$/u);
  if (match) {
    const found = findChapterRecord(decodeURIComponent(match[1]));
    if (!found) return failure("未找到章节");
    if (method === "GET") return success(found.work.chapterAnnotations.filter((annotation) => annotation.chapterId === found.chapter.id && !annotation.deletedAt));
    const body = await bodyOf(init);
    const lines = found.chapter.content.replace(/\r\n?/gu, "\n").split("\n");
    const startLine = Number(body.startLine);
    const endLine = Number(body.endLine);
    if (startLine < 1 || endLine < startLine || endLine > lines.length) return failure("批注行号超出当前正文范围", 400);
    const timestamp = new Date().toISOString();
    const annotation = {
      id: demoId("chapter-annotation"),
      workId: found.work.id,
      chapterId: found.chapter.id,
      kind: body.kind === "todo" ? "todo" : "note",
      startLine,
      endLine,
      quote: lines.slice(startLine - 1, endLine).join("\n"),
      note: String(body.note ?? "").trim(),
      status: "open",
      versionNo: 1,
      actor: demoUser.displayName,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null
    };
    found.work.chapterAnnotations.push(annotation);
    recordAudit(found.work, "chapter.annotation.created", "chapter-annotation", annotation.id, { chapterId: found.chapter.id, kind: annotation.kind, startLine, endLine });
    return success(annotation, 201);
  }
  match = path.match(/^\/api\/chapter-annotations\/([^/]+)$/u);
  if (match) {
    const annotationId = decodeURIComponent(match[1]);
    const work = works.find((item) => item.chapterAnnotations.some((annotation) => annotation.id === annotationId));
    const annotation = work?.chapterAnnotations.find((item) => item.id === annotationId && !item.deletedAt);
    if (!work || !annotation) return failure("未找到章节批注");
    const body = await bodyOf(init);
    if (annotation.versionNo !== Number(body.expectedVersionNo)) return failure("批注版本已变化，请刷新后重试", 409);
    annotation.versionNo += 1;
    annotation.updatedAt = new Date().toISOString();
    if (method === "DELETE") {
      annotation.deletedAt = annotation.updatedAt;
      recordAudit(work, "chapter.annotation.deleted", "chapter-annotation", annotation.id, { versionNo: annotation.versionNo, recoverable: true });
      return success(null, 204);
    }
    if (typeof body.note === "string") annotation.note = body.note.trim();
    if (body.status === "open" || body.status === "resolved") annotation.status = body.status;
    recordAudit(work, "chapter.annotation.updated", "chapter-annotation", annotation.id, { status: annotation.status, versionNo: annotation.versionNo });
    return success(annotation);
  }
  match = path.match(/^\/api\/volumes\/([^/]+)\/chapters$/u);
  if (match) {
    const volumeId = decodeURIComponent(match[1]);
    const work = works.find((item) => item.volumes.some((volume) => volume.id === volumeId));
    const volume = work?.volumes.find((item) => item.id === volumeId);
    return volume ? success(page(volume.chapters.filter((chapter) => !chapter.deletedAt), url)) : failure("未找到分卷");
  }
  match = path.match(/^\/api\/works\/([^/]+)\/volumes$/u);
  if (match && method === "POST") {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    const body = await bodyOf(init);
    const timestamp = new Date().toISOString();
    const volume = {
      id: demoId("volume"),
      workId: work.id,
      title: String(body.title ?? "新分卷").trim(),
      kind: body.kind ?? "main",
      description: String(body.description ?? ""),
      keywords: body.keywords ?? [],
      order: work.volumes.length + 1,
      sortOrder: work.volumes.length,
      versionNo: 1,
      chapters: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    work.volumes.push(volume);
    recordAudit(work, "volume.created", "volume", volume.id);
    return success(volume, 201);
  }
  match = path.match(/^\/api\/works\/([^/]+)\/chapters$/u);
  if (match && method === "POST") {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    const body = await bodyOf(init);
    const volume = work.volumes.find((item) => item.id === body.volumeId);
    if (!volume) return failure("未找到目标分卷");
    const timestamp = new Date().toISOString();
    const chapter = {
      id: demoId("chapter"),
      workId: work.id,
      volumeId: volume.id,
      title: String(body.title ?? "新章节").trim(),
      content: String(body.content ?? ""),
      chapterType: body.chapterType ?? "正文",
      order: work.chapters.length + 1,
      sortOrder: volume.chapters.length,
      wordCount: wordCount(body.content),
      versionNo: 1,
      excludedFromAnalysis: false,
      analysisStatus: "pending",
      deletedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      versions: []
    };
    recordChapterVersion(chapter, "manual", "创建章节");
    work.chapters.push(chapter);
    syncWorkChapters(work);
    recordAudit(work, "chapter.created", "chapter", chapter.id);
    return success(chapter, 201);
  }
  match = path.match(/^\/api\/volumes\/([^/]+)$/u);
  if (match) {
    const volumeId = decodeURIComponent(match[1]);
    const work = works.find((item) => item.volumes.some((volume) => volume.id === volumeId));
    const volume = work?.volumes.find((item) => item.id === volumeId);
    if (!work || !volume) return failure("未找到分卷");
    if (method === "DELETE") {
      if (work.chapters.some((chapter) => chapter.volumeId === volumeId && !chapter.deletedAt)) return failure("分卷中仍有章节，无法删除", 409);
      if (work.chapters.some((chapter) => chapter.volumeId === volumeId && chapter.deletedAt)) return failure("分卷回收站中仍有章节，请先恢复并移动这些章节后再删除分卷", 409);
      work.volumes = work.volumes.filter((item) => item.id !== volumeId);
      recordAudit(work, "volume.deleted", "volume", volumeId, { versionNo: volume.versionNo });
      return success(null, 204);
    }
    if (method === "PATCH") {
      const body = await bodyOf(init);
      if (typeof body.title === "string") volume.title = body.title.trim();
      if (typeof body.kind === "string") volume.kind = body.kind;
      if (typeof body.description === "string") volume.description = body.description;
      if (Array.isArray(body.keywords)) volume.keywords = body.keywords;
      volume.versionNo += 1;
      volume.updatedAt = new Date().toISOString();
      recordAudit(work, "volume.updated", "volume", volume.id, { versionNo: volume.versionNo });
    }
    return success(volume);
  }
  if (path === "/api/works" && method === "GET") return success(page(works.map(({ chapters, characters, settings, races, organizations, timelineTracks, timeline, outlines, foreshadows, relationships, reviews, tasks, chapterAnnotations, auditLogs, writingGoal, ...work }) => work), url));
  if (path === "/api/users") return success(page([], url));
  if (path === "/api/users/directory") return success([]);
  match = path.match(/^\/api\/works\/([^/]+)$/u);
  if (match) {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    return success(workView(work));
  }
  match = path.match(/^\/api\/chapters\/([^/]+)$/u);
  if (match) {
    const found = findChapterRecord(decodeURIComponent(match[1]));
    if (!found) return failure("未找到章节");
    const { work, chapter } = found;
    if (method === "DELETE") {
      const body = await bodyOf(init);
      if (body.expectedVersionNo !== undefined && chapter.versionNo !== Number(body.expectedVersionNo)) return failure("章节版本已变化，请刷新后重试", 409);
      softDeleteChapter(work, chapter);
      return success(null, 204);
    }
    if (method === "PATCH") {
      const body = await bodyOf(init);
      if (body.expectedVersionNo !== undefined && chapter.versionNo !== Number(body.expectedVersionNo)) return failure("章节版本已变化，请刷新后重试", 409);
      if (typeof body.title === "string") chapter.title = body.title;
      if (typeof body.content === "string") chapter.content = body.content;
      if (typeof body.chapterType === "string") chapter.chapterType = body.chapterType;
      if (typeof body.excludedFromAnalysis === "boolean") chapter.excludedFromAnalysis = body.excludedFromAnalysis;
      chapter.wordCount = wordCount(chapter.content);
      chapter.versionNo += 1;
      chapter.updatedAt = new Date().toISOString();
      recordChapterVersion(chapter, "manual", "保存正文");
      recordAudit(work, "chapter.saved", "chapter", chapter.id, { versionNo: chapter.versionNo });
      syncWorkChapters(work);
    }
    return success(chapter);
  }
  match = path.match(/^\/api\/works\/([^/]+)\/(settings|characters|races|organizations|timeline-tracks|timeline|outlines|foreshadows|relationships|reviews|tasks|ai-conversations)$/u);
  if (match) {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    const key = ({ "timeline-tracks": "timelineTracks", "ai-conversations": "aiConversations" })[match[2]] ?? match[2];
    if (match[2] === "races") {
      const scope = url.searchParams.get("scope");
      if (scope === "roots") return success({ items: work.races.filter((race) => !race.parentId), total: work.races.length });
      if (scope === "descendants") return success(work.races.filter((race) => race.parentId));
      if (!url.searchParams.has("page") && !url.searchParams.has("limit")) return success(work.races);
    }
    return success(page(work[key] ?? [], url));
  }
  match = path.match(/^\/api\/works\/([^/]+)\/presence$/u);
  if (match) return success([]);
  match = path.match(/^\/api\/works\/([^/]+)\/(models)$/u);
  if (match) return success([]);
  match = path.match(/^\/api\/works\/([^/]+)\/(ai-settings)$/u);
  if (match) return success({ systemPrompt: "", bookSummaryContextPercent: 20, contextCompactThreshold: 80, agentTools: [], autoRunEnabled: false, autoRunConcurrency: 2, autoRunBatchLimit: 20 });
  match = path.match(/^\/api\/works\/([^/]+)\/(task-defaults)$/u);
  if (match) return success([]);
  match = path.match(/^\/api\/works\/([^/]+)\/search$/u);
  if (match) {
    const work = findWork(decodeURIComponent(match[1]));
    const query = String(url.searchParams.get("q") ?? "").toLowerCase();
    if (!work) return failure("未找到作品");
    const results = [
      ...work.chapters.map((item) => ({ type: "chapter", id: item.id, title: item.title, snippet: item.content.slice(0, 120) })),
      ...work.characters.map((item) => ({ type: "character", id: item.id, title: item.name, snippet: item.profile.summary })),
      ...work.settings.map((item) => ({ type: "setting", id: item.id, title: item.title, snippet: item.content }))
    ].filter((item) => `${item.title} ${item.snippet}`.toLowerCase().includes(query));
    return success(results);
  }
  match = path.match(/^\/api\/characters\/([^/]+)$/u);
  if (match) {
    const character = works.flatMap((work) => work.characters).find((item) => item.id === decodeURIComponent(match[1]));
    return character ? success(character) : failure("未找到角色");
  }
  match = path.match(/^\/api\/settings\/([^/]+)$/u);
  if (match) {
    const setting = works.flatMap((work) => work.settings).find((item) => item.id === decodeURIComponent(match[1]));
    return setting ? success(setting) : failure("未找到设定");
  }
  match = path.match(/^\/api\/tasks\/([^/]+)$/u);
  if (match) {
    const task = works.flatMap((work) => work.tasks).find((item) => item.id === decodeURIComponent(match[1]));
    return task ? success({ ...task, scopeDetails: [{ type: "book" }] }) : failure("未找到任务");
  }
  if (/^\/api\/entity-versions\//u.test(path)) return success([]);
  if (/^\/api\/characters\/[^/]+\/(sections|versions)$/u.test(path)) return success([]);
  if (/^\/api\/works\/[^/]+\/members$/u.test(path)) return success([{ userId: "demo-user", username: "demo", displayName: "体验作者", role: "owner", status: "active", permissions: null }]);

  if (method !== "GET") return success({ demo: true });
  return failure(`Demo 尚未预制接口：${path}`);
}

window.fetch = mockApi;
