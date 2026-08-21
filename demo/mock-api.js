import { analysisTasks, works as sourceWorks } from "./data.js";
import { buildBrowserAiMessages, createBrowserAiStore, normalizeProviderBaseUrl, publicProvider, requestBrowserAi, testBrowserAiModel, testBrowserAiProvider } from "./browser-ai.js";
import { DEMO_CREDENTIALS as demoCredentials, isValidDemoLogin } from "./demo-auth.js";

let DEMO_VERSION = "test";
let DEMO_COVER_VERSIONS = {};
try {
  ({ DEMO_COVER_VERSIONS, DEMO_VERSION } = await import("./demo-version.js"));
} catch (error) {
  if (typeof process === "undefined") throw error;
}

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
let demoUserState = { ...demoUser };
let demoApiKey = null;
let demoUiSettings = { toastPosition: "bottom-right" };
let demoBackupEncryption = { enabled: false, keyConfiguredAt: null };
let demoBackupEncryptionConfirmationToken = null;
let demoBackupTargets = [];
let demoBackupRuns = [];
let demoBackupRunSequence = 0;
const demoAttachmentBlobs = new Map();
const demoCharacterAvatarBlobs = new Map();
let demoActiveWorkId = sourceWorks[0]?.id ?? null;
let demoActiveVolumeId = sourceWorks[0]?.volumes?.[0] ? `${sourceWorks[0].id}-volume-1` : null;
const demoDirectoryUsers = [
  { userId: "demo-editor", username: "demo-editor", displayName: "演示协作者", role: "writer", status: "active", avatarUrl: null }
];
const demoAiProtocolOptions = Object.freeze([
  { value: "openai-chat-completions", label: "OpenAI Chat Completions", defaultBaseUrl: "https://api.openai.com/v1", credentialKind: "api-key", supportsMultimodal: true, supportsMaxCompletionTokens: true },
  { value: "openai-responses", label: "OpenAI Responses", defaultBaseUrl: "https://api.openai.com/v1", credentialKind: "api-key", supportsMultimodal: true, supportsMaxCompletionTokens: false },
  { value: "anthropic-messages", label: "Anthropic Messages", defaultBaseUrl: "https://api.anthropic.com", credentialKind: "api-key", supportsMultimodal: true, supportsMaxCompletionTokens: false },
  { value: "google-vertex", label: "Google Vertex", defaultBaseUrl: "https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/endpoints/openapi", credentialKind: "service-account-json", supportsMultimodal: true, supportsMaxCompletionTokens: true }
]);

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
    description.textContent = "供应商、模型和 API Key 仅保存在当前浏览器。AI 请求由浏览器直接发往你配置的 OpenAI 或 Anthropic 接口，不经过演示站服务器；演示站服务器不会接收、记录或存储 API Key。请仅在可信设备上使用，并确认服务商支持浏览器跨域请求（CORS）。Google Vertex 需要服务端 OAuth，演示站不支持浏览器直连。";
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

function installDemoBackupNotice() {
  const mount = () => {
    for (const host of [document.querySelector("#s3-backup-dialog .s3-backup-body"), document.querySelector("#s3-backup-target-form .dialog-fields")]) {
      if (!host || host.querySelector(".demo-backup-notice")) continue;
      const notice = document.createElement("p");
      notice.className = "s3-backup-encryption-warning demo-backup-notice";
      notice.textContent = "演示站仅在当前页面内模拟 S3 配置与备份结果，不会保存或上传 AK、SK，也不会向任何 S3 服务发起外部请求。请勿输入真实凭据。";
      host.prepend(notice);
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
}

installDemoBackupNotice();

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
    return { id: volumeId, workId: id, title: volume.name, kind: "main", order: index + 1, sortOrder: index, storyOrder: index, versionNo: 1, deletedAt: null, chapters: volumeChapters, versions: [] };
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
    settingsMarkdown: `## 族群概况\n\n${race.population}。${race.traits}`,
    settingsSections: [{ id: `${id}-race-${index + 1}-section`, title: "族群概况", contentMarkdown: `${race.population}。${race.traits}`, summary: "", sortOrder: 0 }],
    memberIds: [],
    members: [],
    isExtinct: false,
    versions: [],
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
    isDissolved: false,
    versions: [],
    versionNo: 1
  }));
  const characters = source.characters.map((character, index) => {
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
      profileSections: [],
      organizations: organization ? [{ id: organization.id, name: organization.name }] : [],
      lockedFields: [],
      gender: index % 3 === 0 ? "female" : index % 3 === 1 ? "male" : "unknown",
      isDead: character.tags.some((tag) => /(?:死亡|人格副本|失踪者)/u.test(tag)),
      versions: [],
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
    tags: [],
    evidence: [],
    scope: {},
    authorNote: "",
    versions: [],
    versionNo: 1,
    createdAt: now,
    updatedAt: now
  }));
  const trackNames = [...new Set(source.timeline.map((item) => item.track))];
  const timelineTracks = trackNames.map((name, index) => ({ id: `${id}-track-${index + 1}`, workId: id, name, description: `${name}相关的大事件`, sortOrder: index + 1, versions: [], versionNo: 1 }));
  const timeline = source.timeline.map((event, index) => ({
    id: `${id}-event-${index + 1}`,
    workId: id,
    trackId: timelineTracks.find((track) => track.name === event.track)?.id ?? null,
    name: event.title,
    timeLabel: event.date,
    description: `发生于${event.chapter}，推动${event.track}发展。`,
    location: "",
    status: "confirmed",
    eventType: "other",
    timeSort: index + 1,
    sortOrder: index + 1,
    chapterIds: [],
    participantIds: [],
    causes: [],
    impactScope: "personal",
    evidence: [],
    versions: [],
    versionNo: 1
  }));
  const outlines = chapters.map((chapter, index) => ({
    id: `${id}-outline-${index + 1}`,
    workId: id,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    volumeTitle: volumes.find((volume) => volume.id === chapter.volumeId)?.title ?? "正文",
    goal: source.chapters[index].summary,
    conflict: source.chapters[index].content.split("\n\n")[1] ?? "",
    turningPoint: source.chapters[index].content.split("\n\n")[2] ?? "",
    status: index < chapters.length - 2 ? "completed" : "planned",
    unresolvedForeshadowCount: index === chapters.length - 1 ? 1 : 0,
    notes: "",
    versions: [],
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
    plannedPayoffChapterId: index === source.outlines.length - 1 ? chapters.at(-1)?.id ?? null : null,
    resolutionNote: item.status === "已回收" ? item.note : "",
    occurrences: [{
      id: `${id}-foreshadow-${index + 1}-occurrence`,
      chapterId: chapters[Math.min(chapters.length - 1, index + 1)]?.id ?? null,
      role: item.status === "已回收" ? "payoff" : "reminder",
      note: item.note
    }],
    versions: [],
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
    currentStatus: "active",
    timeRange: {},
    locked: false,
    evidence: [{ chapterId: chapters[0].id, quote: relationship.evidence }],
    versions: [],
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
    trace: { calls: [], processSteps: [] },
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
  const drafts = [
    {
      id: `${id}-draft-1`,
      workId: id,
      draftType: "prose",
      volumeId: volumes[0]?.id ?? null,
      volumeTitle: volumes[0]?.title ?? null,
      settingModule: null,
      title: "下一章的开场画面",
      content: `记录一个还没有定稿的开场方向：${chapters[0]?.title ?? "第一章"}之后，先让角色面对一个无法解释的细节。`,
      versionNo: 1,
      createdAt: now,
      updatedAt: now,
      versions: []
    },
    {
      id: `${id}-draft-2`,
      workId: id,
      draftType: "setting",
      volumeId: null,
      volumeTitle: null,
      settingModule: "settings",
      title: "待确认的世界规则",
      content: "这条规则需要在正文证据足够后再写入正式设定库。",
      versionNo: 1,
      createdAt: now,
      updatedAt: now,
      versions: []
    }
  ];
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
    deletedAt: null,
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
    drafts,
    relationships,
    reviews: [],
    tasks,
    suggestions: [],
    fileVersions: [],
    attachments: [],
    members: [{ userId: demoUser.userId, username: demoUser.username, displayName: demoUser.displayName, role: "owner", status: "active", permissions: null }],
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
const findWork = (id) => works.find((work) => work.id === id && !work.deletedAt);
const findDeletedWork = (id) => works.find((work) => work.id === id && work.deletedAt);
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
const formValue = (init, key, fallback = "") => String(init?.body?.get?.(key) ?? fallback);
const formFile = (init) => init?.body?.get?.("file");
const escapeXml = (value) => String(value ?? "").replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);

const resourceCollectionKeys = Object.freeze({
  settings: "settings",
  characters: "characters",
  races: "races",
  organizations: "organizations",
  "timeline-tracks": "timelineTracks",
  timeline: "timeline",
  relationships: "relationships",
  foreshadows: "foreshadows",
  reviews: "reviews",
  drafts: "drafts"
});

function snapshotEntity(item) {
  const { versions, ...snapshot } = item;
  return JSON.parse(JSON.stringify(snapshot));
}

function entityVersion(item, source = "manual", changeNote = "") {
  return {
    id: demoId("entity-version"),
    versionNo: Number(item.versionNo ?? 1),
    snapshot: snapshotEntity(item),
    source,
    changeNote,
    actor: demoUser.displayName,
    createdAt: String(item.updatedAt ?? new Date().toISOString())
  };
}

function ensureEntityHistory(item) {
  if (!Array.isArray(item.versions)) item.versions = [];
  if (!item.versions.length) item.versions.push(entityVersion(item, "create", "演示站预制版本"));
  return item.versions;
}

function bumpEntity(work, item, entityType, changeNote = "更新创作资料", source = "manual") {
  ensureEntityHistory(item);
  item.versionNo = Number(item.versionNo ?? 1) + 1;
  item.updatedAt = new Date().toISOString();
  item.versions.unshift(entityVersion(item, source, changeNote));
  recordAudit(work, `${entityType}.updated`, entityType, String(item.id), { versionNo: item.versionNo, source });
  return item;
}

function resourceCollection(work, resource) {
  const key = resourceCollectionKeys[resource];
  return key ? work[key] : null;
}

function findResourceRecord(resourceId, includeDeleted = false) {
  for (const work of works) {
    for (const resource of Object.keys(resourceCollectionKeys)) {
      const collection = resourceCollection(work, resource) ?? [];
      const item = collection.find((candidate) => String(candidate.id) === String(resourceId));
      if (item && (includeDeleted || !item.deletedAt)) return { work, resource, item };
    }
  }
  return null;
}

function listEntityVersions(entityType, entityId) {
  const found = findResourceRecord(entityId, true);
  if (!found) return [];
  const versions = ensureEntityHistory(found.item);
  return versions.map((version) => ({ ...version, snapshot: snapshotEntity(version.snapshot ?? found.item) }));
}

function createDraft(work, body) {
  const timestamp = new Date().toISOString();
  const draftType = body.draftType === "setting" ? "setting" : "prose";
  const volume = draftType === "prose" ? work.volumes.find((item) => item.id === body.volumeId) : null;
  const draft = {
    id: demoId("draft"),
    workId: work.id,
    draftType,
    volumeId: volume?.id ?? null,
    volumeTitle: volume?.title ?? null,
    settingModule: draftType === "setting" ? body.settingModule ?? null : null,
    title: String(body.title ?? "新想法").trim() || "新想法",
    content: String(body.content ?? ""),
    versionNo: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    versions: []
  };
  ensureEntityHistory(draft);
  work.drafts.unshift(draft);
  recordAudit(work, "draft.created", "draft", draft.id, { draftType });
  return draft;
}

function draftView(draft, includeContent = true) {
  const { versions, content, ...rest } = draft;
  return includeContent ? { ...rest, content } : { ...rest, contentPreview: content.replace(/\s+/gu, " ").trim().slice(0, 320) };
}

function findCharacterSection(sectionId) {
  for (const work of works) {
    for (const character of work.characters) {
      const section = (character.profileSections ?? []).find((item) => item.id === sectionId);
      if (section) return { work, character, section };
    }
  }
  return null;
}

function createEmptyWork(body) {
  const timestamp = new Date().toISOString();
  const work = {
    id: demoId("work"),
    title: String(body.title ?? "未命名作品").trim() || "未命名作品",
    author: String(body.author ?? demoUserState.displayName),
    description: String(body.description ?? ""),
    language: String(body.language ?? "zh-CN"),
    tags: Array.isArray(body.tags) ? body.tags : [],
    accessRole: "owner",
    modulePermissions: null,
    coverUrl: null,
    chapterCount: 0,
    wordCount: 0,
    versionNo: 1,
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    volumes: [],
    chapters: [],
    characters: [],
    settings: [],
    races: [],
    organizations: [],
    timelineTracks: [],
    timeline: [],
    outlines: [],
    foreshadows: [],
    drafts: [],
    relationships: [],
    reviews: [],
    tasks: [],
    suggestions: [],
    chapterAnnotations: [],
    fileVersions: [],
    attachments: [],
    members: [{ userId: demoUser.userId, username: demoUser.username, displayName: demoUser.displayName, role: "owner", status: "active", permissions: null }],
    relationshipSearchIndex: {
      workId: "",
      status: "ready",
      generation: 1,
      queuedSourceCount: 0,
      queuedSources: [],
      indexedSourceCount: 0,
      indexedParagraphCount: 0,
      error: "",
      updatedAt: timestamp
    },
    auditLogs: [],
    writingGoal: { dailyGoal: 0, targetTotal: 0, deadline: null, updatedAt: null }
  };
  work.relationshipSearchIndex.workId = work.id;
  ensureEntityHistory(work);
  recordAudit(work, "work.created", "work", work.id);
  return work;
}

function createResourceRecord(work, resource, body) {
  const timestamp = new Date().toISOString();
  const idPrefix = resource === "timeline-tracks" ? "timeline-track" : resource === "timeline" ? "timeline-event" : resource.slice(0, -1);
  const item = {
    id: demoId(idPrefix),
    workId: work.id,
    versionNo: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    versions: []
  };
  if (resource === "characters") Object.assign(item, {
    name: String(body.name ?? "新角色").trim() || "新角色",
    aliases: Array.isArray(body.aliases) ? body.aliases : [],
    code: String(body.code ?? ""),
    species: String(body.species ?? ""),
    raceId: body.raceId ?? null,
    race: null,
    attributes: body.attributes ?? {},
    currentState: body.currentState ?? {},
    profile: body.profile ?? { summary: "" },
    profileSections: [],
    organizations: [],
    organizationIds: Array.isArray(body.organizationIds) ? body.organizationIds : [],
    lockedFields: Array.isArray(body.lockedFields) ? body.lockedFields : [],
    mergedIntoCharacterId: null,
    gender: ["male", "female", "none"].includes(body.gender) ? body.gender : "unknown",
    isDead: Boolean(body.isDead),
    profileSectionCount: 0
  });
  if (resource === "races") Object.assign(item, {
    name: String(body.name ?? "新种族").trim() || "新种族",
    description: String(body.description ?? ""),
    parentId: body.parentRaceId ?? null,
    parentName: null,
    path: [],
    settings: Array.isArray(body.settings) ? body.settings : [],
    settingsMarkdown: String(body.settingsMarkdown ?? ""),
    settingsSections: Array.isArray(body.settingsSections) ? body.settingsSections : [],
    effectiveSettings: [],
    memberIds: Array.isArray(body.memberIds) ? body.memberIds : [],
    members: [],
    isExtinct: Boolean(body.isExtinct)
  });
  if (resource === "organizations") Object.assign(item, {
    name: String(body.name ?? "新组织").trim() || "新组织",
    description: String(body.description ?? ""),
    settings: Array.isArray(body.settings) ? body.settings : [],
    settingsMarkdown: String(body.settingsMarkdown ?? ""),
    settingsSections: Array.isArray(body.settingsSections) ? body.settingsSections : [],
    memberIds: Array.isArray(body.memberIds) ? body.memberIds : [],
    members: [],
    isDissolved: Boolean(body.isDissolved)
  });
  if (resource === "timeline-tracks") Object.assign(item, {
    name: String(body.name ?? "新时间轴").trim() || "新时间轴",
    description: String(body.description ?? ""),
    sortOrder: Number(body.sortOrder ?? work.timelineTracks.length + 1)
  });
  if (resource === "timeline") Object.assign(item, {
    trackId: body.trackId ?? null,
    name: String(body.name ?? "新事件").trim() || "新事件",
    description: String(body.description ?? ""),
    eventType: String(body.eventType ?? "other"),
    timeLabel: String(body.timeLabel ?? "时间待定"),
    timeSort: body.timeSort === null || body.timeSort === undefined ? null : Number(body.timeSort),
    chapterIds: Array.isArray(body.chapterIds) ? body.chapterIds : [],
    participantIds: Array.isArray(body.participantIds) ? body.participantIds : [],
    location: String(body.location ?? ""),
    causes: Array.isArray(body.causes) ? body.causes : [],
    impactScope: String(body.impactScope ?? "personal"),
    evidence: Array.isArray(body.evidence) ? body.evidence : [],
    status: String(body.status ?? "pending")
  });
  if (resource === "relationships") Object.assign(item, {
    fromCharacterId: body.fromCharacterId,
    toCharacterId: body.toCharacterId,
    category: String(body.category ?? "uncertain"),
    subtype: String(body.subtype ?? ""),
    keywords: Array.isArray(body.keywords) ? body.keywords : [],
    directed: Boolean(body.directed),
    currentStatus: String(body.currentStatus ?? "active"),
    timeRange: body.timeRange ?? {},
    confidence: Number(body.confidence ?? 0.5),
    evidence: Array.isArray(body.evidence) ? body.evidence : [],
    confirmationStatus: String(body.confirmationStatus ?? "confirmed"),
    locked: Boolean(body.locked)
  });
  if (resource === "foreshadows") Object.assign(item, {
    title: String(body.title ?? "新伏笔").trim() || "新伏笔",
    description: String(body.description ?? ""),
    importance: String(body.importance ?? "minor"),
    status: String(body.status ?? "planted"),
    unresolved: !["resolved", "abandoned"].includes(body.status),
    overdue: false,
    plannedPayoffChapterId: body.plannedPayoffChapterId ?? null,
    resolutionNote: String(body.resolutionNote ?? ""),
    occurrences: Array.isArray(body.occurrences) ? body.occurrences : []
  });
  if (resource === "reviews") Object.assign(item, {
    title: String(body.title ?? "新审核项").trim() || "新审核项",
    itemType: String(body.itemType ?? "consistency"),
    dedupeKey: String(body.dedupeKey ?? ""),
    severity: String(body.severity ?? "medium"),
    description: String(body.description ?? ""),
    suggestion: String(body.suggestion ?? ""),
    status: "pending",
    evidence: Array.isArray(body.evidence) ? body.evidence : [],
    entityRefs: Array.isArray(body.entityRefs) ? body.entityRefs : [],
    resolutionNote: ""
  });
  ensureEntityHistory(item);
  return item;
}

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
      .filter((chapter) => !volume.deletedAt && !chapter.deletedAt && chapter.volumeId === volume.id)
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
    volumes: work.volumes.filter((volume) => !volume.deletedAt).map((volume) => ({ ...volume, chapters: [...volume.chapters] }))
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

for (const work of works) {
  ensureEntityHistory(work);
  for (const volume of work.volumes) ensureEntityHistory(volume);
  for (const chapter of work.chapters) ensureEntityHistory(chapter);
  for (const collection of [work.characters, work.settings, work.races, work.organizations, work.timelineTracks, work.timeline, work.outlines, work.foreshadows, work.relationships, work.reviews, work.drafts]) {
    for (const item of collection) ensureEntityHistory(item);
  }
}

const defaultWorkAiSettings = (workId = null) => ({
  ...(workId ? { workId } : {}),
  systemPrompt: "",
  dailyTokenQuota: null,
  monthlyTokenQuota: null,
  autoRunEnabled: false,
  autoRunConcurrency: 2,
  autoRunBatchLimit: 20,
  autoRunDailyTaskLimit: 0,
  autoRunFailureThreshold: 3,
  autoRunPaused: false,
  autoRunPauseReason: "",
  autoRunResumeAt: null,
  autoRunConsecutiveFailures: 0,
  bookSummaryContextPercent: 50,
  contextCompactThreshold: 85,
  agentToolCallLimit: 12,
  agentToolCallGlobalMultiplier: 3,
  agentTools: [],
  imageToolModelId: null,
  alwaysIncludeSettingInfo: false,
  titleGenerationModelId: null,
  updatedAt: null
});
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
    .sort((left, right) => Number(right.isFavorite === true) - Number(left.isFavorite === true)
      || String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .map(({ messages, ...conversation }) => ({ ...conversation, messageCount: messages.length }));
}

function findConversation(state, conversationId) {
  return Object.values(state.conversations).flat().find((item) => item.id === conversationId);
}

function createConversationRecord(workId, title = "新对话") {
  const createdAt = new Date().toISOString();
  return {
    id: demoId("conversation"),
    workId,
    title,
    messages: [],
    taskType: "chat",
    contextScope: { type: "none" },
    roleplayCharacter: null,
    roleplayUserCharacter: null,
    isFavorite: false,
    agentTools: null,
    createdAt,
    updatedAt: createdAt,
    contextWarningPending: false,
    compactedMessageCount: 0,
    hasCompactedSummary: false
  };
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

function findSuggestion(suggestionId) {
  for (const work of works) {
    const suggestion = work.suggestions.find((item) => item.id === suggestionId);
    if (suggestion) return { work, suggestion };
  }
  return null;
}

function makeSuggestion(work, body, result) {
  const chapterId = body.scope?.chapterId ?? null;
  const chapter = chapterId ? work.chapters.find((item) => item.id === chapterId && !item.deletedAt) : null;
  const taskType = String(body.taskType ?? "chat");
  return {
    id: demoId("suggestion"),
    workId: work.id,
    taskType,
    instruction: String(body.instruction ?? ""),
    scope: body.scope ?? { type: "none" },
    chapterId: chapter?.id ?? null,
    chapterVersion: chapter?.versionNo ?? null,
    sourceText: String(body.scope?.selection ?? body.scope?.selectedText ?? body.scope?.sourceText ?? ""),
    action: taskType === "continue" ? "append" : taskType === "polish" ? "replace" : "note",
    content: result.content,
    status: "pending",
    guard: null,
    model: { id: result.model.id, displayName: result.model.displayName },
    provider: result.model.providerName,
    outputTokens: result.outputTokens || Math.max(1, Math.ceil(Array.from(result.content).length / 2)),
    contextUsage: result.contextUsage ?? contextUsage(result.model),
    toolCalls: result.toolCalls ?? [],
    processSteps: result.processSteps ?? [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    decidedAt: null
  };
}

function createDemoAttachment(work, init, module) {
  const file = init?.body?.get?.("file");
  const fileName = String(file?.name ?? "附件").replace(/[\\/\r\n]/gu, "_").slice(0, 240) || "附件";
  const mimeType = String(file?.type ?? "application/octet-stream").slice(0, 120);
  const attachment = {
    id: demoId("attachment"),
    workId: work.id,
    module: String(module ?? "settings"),
    fileName,
    originalName: fileName,
    mimeType,
    storedMimeType: mimeType,
    byteLength: Number(file?.size ?? 0),
    sha256: "demo-attachment",
    deduplicated: false,
    contentUrl: `/api/attachments/demo/content`,
    createdAt: new Date().toISOString()
  };
  attachment.contentUrl = `/api/attachments/${encodeURIComponent(attachment.id)}/content`;
  if (file instanceof Blob) demoAttachmentBlobs.set(attachment.id, file);
  work.attachments.push(attachment);
  recordAudit(work, "attachment.created", "attachment", attachment.id, { module: attachment.module, fileName });
  return attachment;
}

function findVersionTarget(entityType, entityId) {
  if (entityType === "work") {
    const work = findWork(entityId);
    return work ? { work, item: work, resource: "work" } : null;
  }
  if (entityType === "volume") {
    for (const work of works) {
      const item = work.volumes.find((candidate) => candidate.id === entityId);
      if (item) return { work, item, resource: "volume" };
    }
  }
  if (entityType === "chapter") {
    const found = findChapterRecord(entityId, true);
    return found ? { work: found.work, item: found.chapter, resource: "chapter" } : null;
  }
  if (entityType === "chapter-outline") {
    for (const work of works) {
      const item = work.outlines.find((candidate) => candidate.chapterId === entityId || candidate.id === entityId);
      if (item) return { work, item, resource: "chapter-outline" };
    }
  }
  if (entityType === "character-section") {
    const found = findCharacterSection(entityId);
    return found ? { work: found.work, item: found.section, resource: "character-section" } : null;
  }
  const resourceByEntity = {
    setting: "settings",
    character: "characters",
    race: "races",
    organization: "organizations",
    "timeline-track": "timeline-tracks",
    "timeline-event": "timeline",
    relationship: "relationships",
    foreshadow: "foreshadows",
    review: "reviews",
    draft: "drafts"
  };
  const found = findResourceRecord(entityId, true);
  const expectedResource = resourceByEntity[entityType] ?? entityType;
  return found && found.resource === expectedResource
    ? { ...found, resource: entityType }
    : null;
}

function entityHistory(entityType, entityId) {
  const target = findVersionTarget(entityType, entityId);
  if (!target) return null;
  const versions = ensureEntityHistory(target.item);
  return { ...target, versions: versions.map((version) => ({
    ...version,
    snapshot: snapshotEntity(version.snapshot ?? (target.resource === "chapter"
      ? { ...target.item, title: version.title, content: version.content, versionNo: version.versionNo }
      : target.item))
  })) };
}

function restoreEntityVersion(target, versionNo) {
  const version = target.versions.find((item) => Number(item.versionNo) === Number(versionNo));
  if (!version) return null;
  Object.assign(target.item, version.snapshot ?? { title: version.title, content: version.content });
  if (target.resource === "chapter") {
    target.item.wordCount = wordCount(target.item.content);
    syncWorkChapters(target.work);
    target.item.versionNo = Number(target.item.versionNo ?? 1) + 1;
    target.item.updatedAt = new Date().toISOString();
    recordChapterVersion(target.item, "restore", `恢复至 v${versionNo}`);
    recordAudit(target.work, "chapter.restored", "chapter", target.item.id, { versionNo: target.item.versionNo, fromVersion: Number(versionNo) });
    return target.item;
  }
  bumpEntity(target.work, target.item, target.resource, `恢复至 v${versionNo}`, "restore");
  return target.item;
}

function demoUsagePricing(row) {
  const cachedInputTokens = Math.min(Number(row.inputTokens ?? 0), Math.floor(Number(row.inputTokens ?? 0) * 0.15));
  const cacheEligibleInputTokens = Number(row.inputTokens ?? 0);
  const cacheWriteInputTokens = 0;
  const directInputTokens = Math.max(0, Number(row.inputTokens ?? 0) - cachedInputTokens);
  return {
    ...row,
    cachedInputTokens,
    cacheReadInputTokens: cachedInputTokens,
    cacheWriteInputTokens,
    cacheEligibleInputTokens,
    directInputTokens,
    cacheHitRate: cacheEligibleInputTokens > 0 ? cachedInputTokens / cacheEligibleInputTokens * 100 : null,
    estimatedCost: directInputTokens * 0.0000005 + cachedInputTokens * 0.0000001 + Number(row.outputTokens ?? 0) * 0.0000015,
    pricingAvailable: true,
    pricedModelCount: Number(row.requestCount ?? 0) > 0 ? 1 : 0,
    unpricedModelCount: 0
  };
}

function demoTokenUsage(workId = null, includeWorks = false) {
  const state = browserAiStore.read();
  const targetWorks = workId ? works.filter((work) => work.id === workId) : works;
  const workRows = targetWorks.map((work) => {
    const messages = (state.conversations[work.id] ?? []).flatMap((conversation) => conversation.messages ?? []);
    const inputTokens = messages.filter((message) => message.role === "user").reduce((total, message) => total + Math.ceil(Array.from(String(message.content ?? "")).length / 2), 0);
    const outputTokens = messages.filter((message) => message.role === "assistant").reduce((total, message) => total + Number(message.metadata?.outputTokens ?? Math.ceil(Array.from(String(message.content ?? "")).length / 2)), 0);
    const timestamps = messages.map((message) => String(message.createdAt ?? "")).filter(Boolean).sort();
    return demoUsagePricing({
      workId: work.id,
      workTitle: work.title,
      totalTokens: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      requestCount: messages.filter((message) => message.role === "assistant").length,
      estimatedRequestCount: messages.filter((message) => message.role === "assistant").length,
      firstUsedAt: timestamps[0] ?? null,
      lastUsedAt: timestamps.at(-1) ?? null
    });
  });
  const summary = workRows.reduce((total, row) => ({
    ...total,
    totalTokens: total.totalTokens + row.totalTokens,
    inputTokens: total.inputTokens + row.inputTokens,
    outputTokens: total.outputTokens + row.outputTokens,
    cachedInputTokens: total.cachedInputTokens + row.cachedInputTokens,
    cacheReadInputTokens: total.cacheReadInputTokens + row.cacheReadInputTokens,
    cacheWriteInputTokens: total.cacheWriteInputTokens + row.cacheWriteInputTokens,
    cacheEligibleInputTokens: total.cacheEligibleInputTokens + row.cacheEligibleInputTokens,
    directInputTokens: total.directInputTokens + row.directInputTokens,
    estimatedCost: total.estimatedCost + row.estimatedCost,
    pricedModelCount: total.pricedModelCount + row.pricedModelCount,
    unpricedModelCount: 0,
    requestCount: total.requestCount + row.requestCount,
    estimatedRequestCount: total.estimatedRequestCount + row.estimatedRequestCount,
    firstUsedAt: [total.firstUsedAt, row.firstUsedAt].filter(Boolean).sort()[0] ?? null,
    lastUsedAt: [total.lastUsedAt, row.lastUsedAt].filter(Boolean).sort().at(-1) ?? null
  }), { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, cacheEligibleInputTokens: 0, directInputTokens: 0, estimatedCost: 0, pricedModelCount: 0, unpricedModelCount: 0, pricingAvailable: true, requestCount: 0, estimatedRequestCount: 0, firstUsedAt: null, lastUsedAt: null });
  summary.cacheHitRate = summary.cacheEligibleInputTokens > 0 ? summary.cachedInputTokens / summary.cacheEligibleInputTokens * 100 : null;
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
  const daily = [...dailyByDate.values()].map(demoUsagePricing).sort((left, right) => left.date.localeCompare(right.date));
  const quotaSettings = workId ? { ...defaultWorkAiSettings(workId), ...(state.workSettings[workId] ?? {}) } : null;
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const usedTokens = daily.find((row) => row.date === today)?.totalTokens ?? 0;
  const monthlyUsedTokens = daily.filter((row) => row.date.startsWith(month)).reduce((total, row) => total + row.totalTokens, 0);
  const dailyTokenQuota = quotaSettings?.dailyTokenQuota ?? null;
  const monthlyTokenQuota = quotaSettings?.monthlyTokenQuota ?? null;
  const quota = workId ? {
    dailyTokenQuota,
    usedTokens,
    remainingTokens: dailyTokenQuota === null ? null : Math.max(0, Number(dailyTokenQuota) - usedTokens),
    reached: dailyTokenQuota !== null && usedTokens >= Number(dailyTokenQuota),
    monthlyTokenQuota,
    monthlyUsedTokens,
    monthlyRemainingTokens: monthlyTokenQuota === null ? null : Math.max(0, Number(monthlyTokenQuota) - monthlyUsedTokens),
    monthlyReached: monthlyTokenQuota !== null && monthlyUsedTokens >= Number(monthlyTokenQuota),
    timezone: "UTC"
  } : undefined;
  return { summary, daily, ...(quota ? { quota } : {}), ...(includeWorks ? { works: workRows.sort((left, right) => right.totalTokens - left.totalTokens || left.workTitle.localeCompare(right.workTitle, "zh-CN")) } : {}), timezoneOffset: 0 };
}

async function demoBrowserImageAttachments(attachmentIds = []) {
  const output = [];
  for (const attachmentId of [...new Set(attachmentIds.map(String))].slice(0, 48)) {
    const record = works.flatMap((work) => work.attachments).find((attachment) => attachment.id === attachmentId);
    const blob = demoAttachmentBlobs.get(attachmentId);
    if (!record || !blob || !/^image\/(?:png|jpe?g)$/u.test(record.storedMimeType)) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    output.push({ id: attachmentId, mimeType: record.storedMimeType, dataUrl: `data:${record.storedMimeType};base64,${btoa(binary)}` });
  }
  return output;
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
  const settings = { ...defaultWorkAiSettings(workId), ...(state.workSettings[workId] ?? {}) };
  const messages = buildBrowserAiMessages({
    work: workView(work),
    scope: body.scope,
    instruction: String(body.instruction ?? ""),
    platformPrompt: state.platformSettings.systemPrompt,
    workPrompt: settings.systemPrompt,
    conversationMessages: conversation?.messages ?? [],
    citations: body.citations ?? [],
    roleplayCharacter: conversation?.roleplayCharacter ?? null,
    roleplayUserCharacter: conversation?.roleplayUserCharacter ?? null
  });
  const historicalImageAttachmentIds = (conversation?.messages ?? []).slice(-12)
    .flatMap((message) => message.metadata?.chatImageAttachmentIds ?? []);
  const imageAttachments = await demoBrowserImageAttachments([...historicalImageAttachmentIds, ...(body.imageAttachmentIds ?? [])]);
  const result = await requestBrowserAi({ fetchImpl: nativeFetch, provider, model, messages, imageAttachments });
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
      userMessage = appendConversationMessage(conversation, {
        role: "user",
        content: body.instruction,
        citations: body.citations ?? [],
        metadata: { modelId: body.modelId, chatImageAttachmentIds: [...new Set((body.imageAttachmentIds ?? []).map(String))].slice(0, 4) }
      });
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

function demoBackupRootPrefix(basePath = "") {
  const normalized = String(basePath).trim().replace(/^\/+|\/+$/gu, "").replace(/\/{2,}/gu, "/");
  return normalized ? `${normalized}/scriverse` : "scriverse";
}

function demoBackupTarget(body, current = null) {
  const timestamp = new Date().toISOString();
  const basePath = String(body.basePath ?? current?.basePath ?? "").trim();
  return {
    id: current?.id ?? demoId("backup-target"),
    name: String(body.name ?? current?.name ?? "演示 S3 目标").trim() || "演示 S3 目标",
    endpoint: String(body.endpoint ?? current?.endpoint ?? "https://s3.example.invalid").trim(),
    region: String(body.region ?? current?.region ?? "us-east-1").trim() || "us-east-1",
    bucket: String(body.bucket ?? current?.bucket ?? "scriverse-demo").trim(),
    basePath,
    rootPrefix: demoBackupRootPrefix(basePath),
    forcePathStyle: body.forcePathStyle === undefined ? current?.forcePathStyle ?? true : Boolean(body.forcePathStyle),
    enabled: body.enabled === undefined ? current?.enabled ?? false : Boolean(body.enabled),
    backupImages: body.backupImages === undefined ? current?.backupImages ?? true : Boolean(body.backupImages),
    scheduleTime: String(body.scheduleTime ?? current?.scheduleTime ?? "03:00"),
    retentionCount: Math.min(365, Math.max(1, Number(body.retentionCount ?? current?.retentionCount ?? 7))),
    sortOrder: current?.sortOrder ?? demoBackupTargets.length,
    credentialsConfigured: true,
    lastStartedAt: current?.lastStartedAt ?? null,
    lastSuccessAt: current?.lastSuccessAt ?? null,
    lastFailureAt: current?.lastFailureAt ?? null,
    lastError: current?.lastError ?? null,
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

function demoRecycleBinExpiresAt(deletedAt) {
  const expiresAt = new Date(deletedAt);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + 30);
  return expiresAt.toISOString();
}

function demoOutlineBoard(work, url) {
  const filters = {
    query: String(url.searchParams.get("q") ?? "").trim(),
    volumeId: String(url.searchParams.get("volumeId") ?? ""),
    outlineStatus: String(url.searchParams.get("outlineStatus") ?? "all"),
    foreshadowStatus: String(url.searchParams.get("foreshadowStatus") ?? "all"),
    sort: String(url.searchParams.get("sort") ?? "tree")
  };
  const activeVolumes = work.volumes.filter((volume) => !volume.deletedAt).sort((left, right) => Number(left.sortOrder) - Number(right.sortOrder));
  const outlineByChapter = new Map(work.outlines.map((outline) => [outline.chapterId, outline]));
  const foreshadowsForChapter = (chapterId) => work.foreshadows.flatMap((foreshadow) => {
    const roles = [...new Set((foreshadow.occurrences ?? []).filter((occurrence) => occurrence.chapterId === chapterId).map((occurrence) => occurrence.role).filter(Boolean))];
    const plannedPayoff = foreshadow.plannedPayoffChapterId === chapterId;
    return roles.length || plannedPayoff ? [{ id: foreshadow.id, title: foreshadow.title, status: foreshadow.status, importance: foreshadow.importance, roles, plannedPayoff }] : [];
  });
  const candidates = activeVolumes.flatMap((volume) => work.chapters
    .filter((chapter) => !chapter.deletedAt && chapter.volumeId === volume.id)
    .map((chapter) => ({ volume, chapter, outline: outlineByChapter.get(chapter.id) ?? null, foreshadows: foreshadowsForChapter(chapter.id) })))
    .filter(({ volume, chapter, outline, foreshadows }) => {
      if (filters.volumeId && volume.id !== filters.volumeId) return false;
      if (filters.outlineStatus === "empty" ? outline : filters.outlineStatus !== "all" && outline?.status !== filters.outlineStatus) return false;
      if (filters.foreshadowStatus === "none" && foreshadows.length) return false;
      if (filters.foreshadowStatus === "unresolved" && !foreshadows.some((item) => ["planned", "planted"].includes(item.status))) return false;
      if (["resolved", "abandoned"].includes(filters.foreshadowStatus) && !foreshadows.some((item) => item.status === filters.foreshadowStatus)) return false;
      if (!filters.query) return true;
      return [chapter.title, chapter.chapterType, outline?.goal, outline?.conflict, outline?.turningPoint, outline?.notes, ...foreshadows.map((item) => item.title)]
        .some((value) => String(value ?? "").toLocaleLowerCase("zh-CN").includes(filters.query.toLocaleLowerCase("zh-CN")));
    });
  const outlineRank = (outline) => outline ? ({ draft: 1, ready: 2, completed: 3 })[outline.status] ?? 1 : 0;
  candidates.sort((left, right) => Number(left.volume.sortOrder) - Number(right.volume.sortOrder)
    || (filters.sort === "status" ? outlineRank(left.outline) - outlineRank(right.outline) : 0)
    || (filters.sort === "foreshadows" ? Number(right.foreshadows.some((item) => ["planned", "planted"].includes(item.status))) - Number(left.foreshadows.some((item) => ["planned", "planted"].includes(item.status))) : 0)
    || (filters.sort === "title" ? left.chapter.title.localeCompare(right.chapter.title, "zh-CN") : 0)
    || Number(left.chapter.sortOrder) - Number(right.chapter.sortOrder));
  const paged = page(candidates, url);
  const filteredCountByVolume = new Map(activeVolumes.map((volume) => [volume.id, candidates.filter((item) => item.volume.id === volume.id).length]));
  const volumeOptions = activeVolumes.map((volume) => ({ id: volume.id, title: volume.title, sortOrder: volume.sortOrder, chapterCount: work.chapters.filter((chapter) => !chapter.deletedAt && chapter.volumeId === volume.id).length, filteredChapterCount: filteredCountByVolume.get(volume.id) ?? 0 }));
  const volumes = volumeOptions.flatMap((volume) => {
    const chapters = paged.items.filter((item) => item.volume.id === volume.id).map(({ chapter, outline, foreshadows }) => ({
      id: chapter.id,
      title: chapter.title,
      chapterType: chapter.chapterType,
      sortOrder: chapter.sortOrder,
      outline: outline ? {
        goal: String(outline.goal ?? "").slice(0, 600),
        conflict: String(outline.conflict ?? "").slice(0, 600),
        turningPoint: String(outline.turningPoint ?? "").slice(0, 600),
        notes: String(outline.notes ?? "").slice(0, 600),
        status: outline.status ?? "draft",
        truncated: [outline.goal, outline.conflict, outline.turningPoint, outline.notes].some((value) => String(value ?? "").length > 600),
        updatedAt: outline.updatedAt ?? null
      } : null,
      foreshadows
    }));
    const includeEmpty = paged.page === 1 && volume.chapterCount === 0 && (!filters.volumeId || filters.volumeId === volume.id) && (!filters.query || filters.volumeId === volume.id);
    return chapters.length || includeEmpty ? [{ ...volume, chapters }] : [];
  });
  const activeChapters = work.chapters.filter((chapter) => !chapter.deletedAt && activeVolumes.some((volume) => volume.id === chapter.volumeId));
  return {
    workId: work.id,
    volumes,
    volumeOptions,
    filters,
    page: paged.page,
    limit: paged.limit,
    itemCount: paged.items.length,
    total: candidates.length,
    pageCount: Math.ceil(candidates.length / paged.limit),
    hasMore: paged.hasMore,
    nextPage: paged.nextPage,
    stats: {
      chapterCount: activeChapters.length,
      outlinedChapterCount: activeChapters.filter((chapter) => outlineByChapter.has(chapter.id)).length,
      foreshadowCount: work.foreshadows.length,
      unresolvedForeshadowCount: work.foreshadows.filter((item) => ["planned", "planted"].includes(item.status)).length
    }
  };
}

function demoForeshadowReminders(work, chapter) {
  return work.foreshadows.flatMap((foreshadow) => {
    const occurrence = (foreshadow.occurrences ?? []).find((item) => item.chapterId === chapter.id && ["reminder", "payoff"].includes(item.role));
    if (!occurrence || !["planned", "planted"].includes(foreshadow.status)) return [];
    return [{
      foreshadowId: foreshadow.id,
      occurrenceId: occurrence.id,
      title: foreshadow.title,
      description: foreshadow.description,
      role: occurrence.role,
      note: occurrence.note ?? "",
      importance: foreshadow.importance,
      status: foreshadow.status,
      versionNo: foreshadow.versionNo
    }];
  });
}

function demoGlobalReplace(work, body) {
  const find = String(body.find ?? "");
  const replacement = String(body.replacement ?? "");
  const scope = ["prose", "settings", "prose-and-settings"].includes(body.scope) ? body.scope : "prose";
  const volumeId = body.volumeId ? String(body.volumeId) : null;
  let chapterCount = 0;
  let settingCount = 0;
  let totalMatches = 0;
  const operationId = demoId("global-replace");
  if (scope !== "settings") {
    for (const chapter of work.chapters.filter((item) => !item.deletedAt && (!volumeId || item.volumeId === volumeId))) {
      const matches = find ? chapter.content.split(find).length - 1 : 0;
      if (!matches) continue;
      chapter.content = chapter.content.replaceAll(find, replacement);
      chapter.wordCount = wordCount(chapter.content);
      chapter.versionNo += 1;
      chapter.updatedAt = new Date().toISOString();
      recordChapterVersion(chapter, "global-replace", operationId);
      chapterCount += 1;
      totalMatches += matches;
    }
  }
  if (scope !== "prose") {
    for (const setting of work.settings) {
      const matches = find ? setting.content.split(find).length - 1 : 0;
      if (!matches) continue;
      setting.content = setting.content.replaceAll(find, replacement);
      bumpEntity(work, setting, "setting", "全局替换设定库", "global-replace");
      settingCount += 1;
      totalMatches += matches;
    }
  }
  syncWorkChapters(work);
  if (totalMatches) recordAudit(work, "work.global-replace", "work", work.id, { operationId, scope, volumeId, chapterCount, settingCount, totalMatches });
  return { operationId, scope, volumeId, chapterCount, settingCount, totalMatches, processedModules: scope === "prose-and-settings" ? ["prose", "settings"] : [scope], skippedModules: [], work: workView(work) };
}

const demoTextEncoder = new TextEncoder();
const demoCrcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  return crc >>> 0;
});

function demoCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = demoCrcTable[(crc ^ byte) & 0xff] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

function demoZipArchive(files) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  const numberBytes = (value, size) => Array.from({ length: size }, (_, index) => value >>> index * 8 & 0xff);
  for (const file of files) {
    const name = demoTextEncoder.encode(file.name);
    const content = typeof file.content === "string" ? demoTextEncoder.encode(file.content) : file.content;
    const crc = demoCrc32(content);
    const localHeader = new Uint8Array([
      ...numberBytes(0x04034b50, 4), ...numberBytes(20, 2), 0, 8, 0, 0, 0, 0, 0, 0,
      ...numberBytes(crc, 4), ...numberBytes(content.length, 4), ...numberBytes(content.length, 4),
      ...numberBytes(name.length, 2), 0, 0, ...name
    ]);
    const centralHeader = new Uint8Array([
      ...numberBytes(0x02014b50, 4), ...numberBytes(20, 2), ...numberBytes(20, 2), 0, 8, 0, 0, 0, 0, 0, 0,
      ...numberBytes(crc, 4), ...numberBytes(content.length, 4), ...numberBytes(content.length, 4),
      ...numberBytes(name.length, 2), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...numberBytes(localOffset, 4), ...name
    ]);
    localParts.push(localHeader, content);
    centralParts.push(centralHeader);
    localOffset += localHeader.length + content.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array([
    ...numberBytes(0x06054b50, 4), 0, 0, 0, 0,
    ...numberBytes(files.length, 2), ...numberBytes(files.length, 2),
    ...numberBytes(centralSize, 4), ...numberBytes(localOffset, 4), 0, 0
  ]);
  const output = new Uint8Array(localOffset + centralSize + end.length);
  let offset = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function demoManuscriptFiles(work, volumeId = null) {
  const volumes = work.volumes.filter((volume) => !volume.deletedAt && (!volumeId || volume.id === volumeId));
  return volumes.flatMap((volume) => work.chapters
    .filter((chapter) => !chapter.deletedAt && chapter.volumeId === volume.id)
    .sort((left, right) => Number(left.sortOrder) - Number(right.sortOrder))
    .map((chapter) => ({ volume, chapter })));
}

function demoExportArtifact(work, format = "markdown", volumeId = null) {
  const records = demoManuscriptFiles(work, volumeId);
  const baseName = String(volumeId ? work.volumes.find((volume) => volume.id === volumeId)?.title : work.title).replace(/[\\/:*?"<>|]/gu, "_") || "Scriverse-Demo";
  if (format === "markdown") {
    const files = records.map(({ volume, chapter }, index) => ({
      name: `${String(index + 1).padStart(3, "0")}-${chapter.title.replace(/[\\/:*?"<>|]/gu, "_")}.md`,
      content: `# ${chapter.title}\n\n> ${volume.title}\n\n${chapter.content}\n`
    }));
    return { bytes: demoZipArchive(files), mimeType: "application/zip", fileName: `${baseName}.markdown.zip` };
  }
  if (format === "docx") {
    const paragraphs = records.flatMap(({ volume, chapter }) => [
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${escapeXml(volume.title)} · ${escapeXml(chapter.title)}</w:t></w:r></w:p>`,
      ...String(chapter.content).split(/\n+/u).filter(Boolean).map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`)
    ]).join("");
    return {
      bytes: demoZipArchive([
        { name: "[Content_Types].xml", content: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
        { name: "_rels/.rels", content: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
        { name: "word/document.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>` }
      ]),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      fileName: `${baseName}.docx`
    };
  }
  const chapterFiles = records.map(({ volume, chapter }, index) => ({
    name: `OEBPS/chapter-${index + 1}.xhtml`,
    content: `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escapeXml(chapter.title)}</title></head><body><h1>${escapeXml(volume.title)} · ${escapeXml(chapter.title)}</h1>${String(chapter.content).split(/\n+/u).filter(Boolean).map((line) => `<p>${escapeXml(line)}</p>`).join("")}</body></html>`
  }));
  const manifest = chapterFiles.map((_, index) => `<item id="chapter-${index + 1}" href="chapter-${index + 1}.xhtml" media-type="application/xhtml+xml"/>`).join("");
  const spine = chapterFiles.map((_, index) => `<itemref idref="chapter-${index + 1}"/>`).join("");
  return {
    bytes: demoZipArchive([
      { name: "mimetype", content: "application/epub+zip" },
      { name: "META-INF/container.xml", content: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
      { name: "OEBPS/content.opf", content: `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${escapeXml(work.id)}</dc:identifier><dc:title>${escapeXml(baseName)}</dc:title><dc:language>zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest}</manifest><spine>${spine}</spine></package>` },
      { name: "OEBPS/nav.xhtml", content: `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escapeXml(baseName)}</title></head><body><nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol>${records.map(({ chapter }, index) => `<li><a href="chapter-${index + 1}.xhtml">${escapeXml(chapter.title)}</a></li>`).join("")}</ol></nav></body></html>` },
      ...chapterFiles
    ]),
    mimeType: "application/epub+zip",
    fileName: `${baseName}.epub`
  };
}

function demoArtifactResponse(artifact, method = "GET") {
  return new Response(method === "HEAD" ? null : artifact.bytes, {
    status: method === "HEAD" ? 204 : 200,
    headers: { "content-type": artifact.mimeType, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}` }
  });
}

function downloadDemoArtifact(artifact) {
  const objectUrl = URL.createObjectURL(new Blob([artifact.bytes], { type: artifact.mimeType }));
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = artifact.fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

function installDemoExportAdapter() {
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const workTrigger = target?.closest?.("[data-open-work], [data-edit-work]");
    const volumeTrigger = target?.closest?.("[data-volume-detail], [data-volume-toggle]");
    if (workTrigger) demoActiveWorkId = workTrigger.dataset.openWork ?? workTrigger.dataset.editWork ?? demoActiveWorkId;
    if (volumeTrigger) demoActiveVolumeId = volumeTrigger.dataset.volumeDetail ?? volumeTrigger.dataset.volumeToggle ?? demoActiveVolumeId;
    const formatTrigger = target?.closest?.("[data-export-format]");
    const volumeExportTrigger = target?.closest?.("[data-dialog-volume-export]");
    if (!formatTrigger && !volumeExportTrigger) return;
    const work = findWork(demoActiveWorkId);
    const volume = work?.volumes.find((item) => item.id === demoActiveVolumeId && !item.deletedAt);
    if (!work || volumeExportTrigger && !volume) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const format = volumeExportTrigger ? "epub" : ["docx", "epub"].includes(formatTrigger.dataset.exportFormat) ? formatTrigger.dataset.exportFormat : "markdown";
    downloadDemoArtifact(demoExportArtifact(work, format, volumeExportTrigger ? volume.id : null));
    document.querySelector("#manuscript-export-menu")?.classList.add("hidden");
  }, true);
}

installDemoExportAdapter();

async function mockApi(input, init = {}) {
  const requestUrl = typeof input === "string" ? input : input.url;
  const url = new URL(requestUrl, window.location.origin);
  if (!url.pathname.startsWith("/api/")) return nativeFetch(input, init);
  const method = String(init.method ?? (typeof input === "string" ? "GET" : input.method) ?? "GET").toUpperCase();
  const path = url.pathname;
  let match;

  if (path === "/api/health") return success({ ok: true, version: DEMO_VERSION, development: false });
  if (path === "/api/update-check") return success({ enabled: false, checked: false, updateAvailable: false, latestVersion: null, releaseUrl: null, nextCheckAt: null });
  if (path === "/api/ui-settings" || path === "/api/platform/ui-settings") {
    if (method === "PATCH") {
      const body = await bodyOf(init);
      demoUiSettings = { ...demoUiSettings, ...body };
    }
    return success(demoUiSettings);
  }
  if (path === "/api/auth/captcha") {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="52" viewBox="0 0 160 52"><rect width="160" height="52" rx="8" fill="#f2ebe3"/><path d="M8 38 152 12M12 10l138 32" stroke="#a96350" stroke-opacity=".22"/><text x="80" y="35" text-anchor="middle" font-family="monospace" font-size="27" font-weight="700" letter-spacing="8" fill="#5b3028">2468</text></svg>`;
    return success({ captchaId: "demo-captcha", imageDataUrl: `data:image/svg+xml;base64,${btoa(svg)}` });
  }
  if (path === "/api/auth/login" && method === "POST") {
    const body = await bodyOf(init);
    if (!isValidDemoLogin(body)) return failure("演示账号、密码或验证码不正确", 401);
    sessionStorage.setItem(demoAuthStorageKey, "true");
    return success(demoUserState);
  }
  if (path === "/api/auth/session" && method === "DELETE") {
    sessionStorage.removeItem(demoAuthStorageKey);
    return success(null, 204);
  }
  if (path === "/api/auth/session") {
    const authenticated = sessionStorage.getItem(demoAuthStorageKey) === "true";
    return success(authenticated
      ? { authenticated: true, csrfToken: "demo-csrf-token", user: demoUserState }
      : { authenticated: false, setupRequired: false, registrationOpen: false });
  }
  if (path === "/api/auth/register") return failure("Demo 不开放注册，请使用页面提供的演示账号", 403);
  if (sessionStorage.getItem(demoAuthStorageKey) !== "true") return failure("请先登录演示账号", 401);
  if (path === "/api/cli/session") return failure("Demo 仅支持网页演示账号登录，请不要使用 API Key", 401);
  if (path === "/api/auth/profile" && method === "PATCH") {
    const body = await bodyOf(init);
    demoUserState = { ...demoUserState, displayName: String(body.displayName ?? demoUserState.displayName).trim() || demoUserState.displayName };
    return success(demoUserState);
  }
  if (path === "/api/auth/avatar") {
    if (method === "DELETE") {
      demoUserState = { ...demoUserState, avatarUrl: null };
      return success(demoUserState);
    }
    if (method === "PUT") {
      demoUserState = { ...demoUserState, avatarUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96'%3E%3Crect width='96' height='96' rx='24' fill='%23c86a52'/%3E%3Ctext x='48' y='62' text-anchor='middle' font-size='44' fill='white'%3E体%3C/text%3E%3C/svg%3E" };
      return success(demoUserState);
    }
  }
  if (path === "/api/auth/password" && method === "PATCH") return success(null, 204);
  if (path === "/api/auth/api-key") return success(demoApiKey ? { configured: true, prefix: demoApiKey.slice(0, 12) } : { configured: false });
  if (path === "/api/auth/api-key/reset" && method === "POST") {
    demoApiKey = `scrv_demo_${crypto.randomUUID().replaceAll("-", "")}`;
    return success({ apiKey: demoApiKey, prefix: demoApiKey.slice(0, 12) });
  }
  if (path === "/api/auth/onboarding/complete") return success(demoUserState);
  if (path === "/api/users" && method === "GET") {
    const users = [{ ...demoUserState }, ...demoDirectoryUsers].map((user) => ({ ...user, role: user.role ?? "writer" }));
    return success(page(users, url));
  }
  if (path === "/api/users/directory" && method === "GET") {
    const query = String(url.searchParams.get("q") ?? "").trim().toLowerCase();
    const users = [{ ...demoUserState }, ...demoDirectoryUsers].filter((user) => !query || `${user.username} ${user.displayName}`.toLowerCase().includes(query));
    return success(url.searchParams.has("page") || url.searchParams.has("limit") ? page(users, url) : users);
  }
  match = path.match(/^\/api\/user-avatars\/([^/]+)$/u);
  if (match && method === "GET") {
    const userId = decodeURIComponent(match[1]);
    const user = [{ ...demoUserState }, ...demoDirectoryUsers].find((item) => item.userId === userId);
    if (!user) return failure("未找到用户头像");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="24" fill="#c86a52"/><text x="48" y="62" text-anchor="middle" font-size="44" fill="white">${escapeXml(user.displayName.slice(0, 1))}</text></svg>`;
    return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "private, max-age=3600" } });
  }
  match = path.match(/^\/api\/users\/([^/]+)$/u);
  if (match && method === "PATCH") {
    const userId = decodeURIComponent(match[1]);
    const body = await bodyOf(init);
    if (userId === demoUserState.userId) {
      demoUserState = { ...demoUserState, ...(body.role ? { role: body.role } : {}), ...(body.status ? { status: body.status } : {}) };
      return success(demoUserState);
    }
    const user = demoDirectoryUsers.find((item) => item.userId === userId);
    if (!user) return failure("未找到用户");
    Object.assign(user, body);
    return success(user);
  }
  match = path.match(/^\/api\/works\/([^/]+)\/presence$/u);
  if (match && method === "POST") {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    const body = await bodyOf(init);
    const participants = (work.members ?? [{ userId: demoUserState.userId, username: demoUserState.username, displayName: demoUserState.displayName, role: "owner", status: "active", permissions: null }])
      .filter((member) => member.status !== "disabled")
      .map((member) => ({
        ...member,
        avatarUrl: member.avatarUrl ?? null,
        clientId: member.userId === demoUserState.userId ? body.clientId ?? "demo-client" : `demo-client-${member.userId}`,
        page: body.page ?? { kind: "welcome", key: "welcome", label: "作品首页" },
        lastSeenAt: new Date().toISOString()
      }));
    return success({ participants, recentChanges: [] });
  }
  match = path.match(/^\/api\/works\/([^/]+)\/members$/u);
  if (match) {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    work.members ??= [{ userId: demoUserState.userId, username: demoUserState.username, displayName: demoUserState.displayName, role: "owner", status: "active", permissions: null }];
    if (method === "GET") return url.searchParams.has("page") || url.searchParams.has("limit") ? success(page(work.members, url)) : success(work.members);
    if (method === "POST") {
      const body = await bodyOf(init);
      const user = [{ ...demoUserState }, ...demoDirectoryUsers].find((item) => item.userId === body.userId);
      if (!user) return failure("未找到要添加的用户");
      if (!work.members.some((member) => member.userId === user.userId)) work.members.push({ ...user, permissions: body.permissions ?? null, role: body.role ?? "writer" });
      return success(work.members, 201);
    }
  }
  match = path.match(/^\/api\/works\/([^/]+)\/members\/([^/]+)$/u);
  if (match) {
    const work = findWork(decodeURIComponent(match[1]));
    const userId = decodeURIComponent(match[2]);
    if (!work) return failure("未找到作品");
    const member = work.members?.find((item) => item.userId === userId);
    if (!member) return failure("未找到作品成员");
    if (method === "PATCH") {
      Object.assign(member, await bodyOf(init));
      return success(work.members);
    }
    if (method === "DELETE") {
      if (userId === demoUserState.userId) return failure("作品所有者不能移除", 409);
      work.members = work.members.filter((item) => item.userId !== userId);
      return success(work.members);
    }
  }
  if (path === "/api/platform/ai/protocols") return success(demoAiProtocolOptions);
  if (path === "/api/platform/ai-conversations" && method === "GET") {
    const query = String(url.searchParams.get("q") ?? "").trim().toLocaleLowerCase("zh-CN");
    const workId = String(url.searchParams.get("workId") ?? "");
    const records = Object.values(browserAiStore.read().conversations).flatMap((conversations) => conversations).map((conversation) => {
      const work = findWork(conversation.workId) ?? findDeletedWork(conversation.workId);
      return {
        ...conversationSummary(conversation),
        creator: { userId: demoUser.userId, username: demoUser.username, displayName: demoUser.displayName },
        work: work ? { id: work.id, title: work.title, deleted: Boolean(work.deletedAt) } : null
      };
    }).filter((conversation) => (!workId || conversation.workId === workId)
      && (!query || `${conversation.title} ${conversation.preview} ${conversation.work?.title ?? ""}`.toLocaleLowerCase("zh-CN").includes(query)))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    return success(page(records, url));
  }
  if (path === "/api/platform/backups/encryption") {
    if (method === "GET") return success({ ...demoBackupEncryption });
    const body = await bodyOf(init);
    if (body.enabled !== true) {
      demoBackupEncryption = { ...demoBackupEncryption, enabled: false };
      demoBackupEncryptionConfirmationToken = null;
      return success({ ...demoBackupEncryption });
    }
    if (demoBackupEncryption.keyConfiguredAt) {
      demoBackupEncryption = { ...demoBackupEncryption, enabled: true };
      return success({ ...demoBackupEncryption });
    }
    demoBackupEncryptionConfirmationToken = crypto.randomUUID();
    return success({
      ...demoBackupEncryption,
      key: "SCRIVERSE-DEMO-BACKUP-KEY-NOT-FOR-RESTORE",
      confirmationToken: demoBackupEncryptionConfirmationToken
    });
  }
  if (path === "/api/platform/backups/encryption/confirm" && method === "POST") {
    const body = await bodyOf(init);
    if (!demoBackupEncryptionConfirmationToken || body.confirmationToken !== demoBackupEncryptionConfirmationToken) return failure("演示备份加密确认已失效", 409);
    demoBackupEncryptionConfirmationToken = null;
    demoBackupEncryption = { enabled: true, keyConfiguredAt: new Date().toISOString() };
    return success({ ...demoBackupEncryption });
  }
  if (path === "/api/platform/backups/targets") {
    if (method === "GET") return success(demoBackupTargets.map((target) => ({ ...target })));
    const body = await bodyOf(init);
    const target = demoBackupTarget(body);
    demoBackupTargets.push(target);
    return success({ ...target }, 201);
  }
  match = path.match(/^\/api\/platform\/backups\/targets\/([^/]+)$/u);
  if (match) {
    const targetId = decodeURIComponent(match[1]);
    const targetIndex = demoBackupTargets.findIndex((target) => target.id === targetId);
    if (targetIndex < 0) return failure("未找到演示备份目标");
    if (method === "DELETE") {
      demoBackupTargets.splice(targetIndex, 1);
      return success(null, 204);
    }
    const body = await bodyOf(init);
    demoBackupTargets[targetIndex] = demoBackupTarget(body, demoBackupTargets[targetIndex]);
    return success({ ...demoBackupTargets[targetIndex] });
  }
  if (path === "/api/platform/backups/runs" && method === "GET") {
    const afterSequence = Number(url.searchParams.get("afterSequence"));
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 30)));
    const items = Number.isInteger(afterSequence) && afterSequence >= 0
      ? demoBackupRuns.filter((run) => run.sequence > afterSequence).sort((left, right) => left.sequence - right.sequence).slice(0, limit)
      : demoBackupRuns.slice(0, limit);
    return success({ items: items.map((run) => ({ ...run })), latestSequence: demoBackupRunSequence });
  }
  if (path === "/api/platform/backups/run" && method === "POST") {
    const body = await bodyOf(init);
    const requestedIds = Array.isArray(body.targetIds)
      ? body.targetIds.map(String)
      : demoBackupTargets.filter((target) => target.enabled).map((target) => target.id);
    const acceptedTargetIds = [];
    const skippedTargetIds = [];
    for (const targetId of requestedIds) {
      const target = demoBackupTargets.find((item) => item.id === targetId);
      if (!target) {
        skippedTargetIds.push(targetId);
        continue;
      }
      const timestamp = new Date().toISOString();
      target.lastStartedAt = timestamp;
      target.lastSuccessAt = timestamp;
      target.lastFailureAt = null;
      target.lastError = null;
      target.updatedAt = timestamp;
      demoBackupRunSequence += 1;
      demoBackupRuns.unshift({
        sequence: demoBackupRunSequence,
        id: demoId("backup-run"),
        targetId: target.id,
        targetName: target.name,
        trigger: "manual",
        status: "succeeded",
        databaseKey: `${target.rootPrefix}/db/demo.snapshot`,
        imagesUploaded: target.backupImages ? 2 : 0,
        imagesSkipped: target.backupImages ? 2 : 0,
        databasesDeleted: 0,
        errorMessage: null,
        serverResponse: { simulated: true, externalRequestSent: false },
        startedAt: timestamp,
        finishedAt: timestamp
      });
      acceptedTargetIds.push(target.id);
    }
    return success({ acceptedTargetIds, skippedTargetIds, queuedAt: new Date().toISOString(), simulated: true }, 202);
  }
  if (path === "/api/platform/ai/providers") {
    if (method === "GET") {
      const providers = browserAiStore.read().providers.map(publicProvider);
      return url.searchParams.has("page") || url.searchParams.has("limit") ? success(page(providers, url)) : success(providers);
    }
    const body = await bodyOf(init);
    const provider = {
      id: demoId("provider"),
      name: String(body.name ?? "").trim(),
      protocol: demoAiProtocolOptions.some((option) => option.value === body.protocol) ? body.protocol : "openai-chat-completions",
      baseUrl: normalizeProviderBaseUrl(body.baseUrl),
      apiKey: String(body.apiKey ?? "").trim(),
      concurrencyLimit: Number(body.concurrencyLimit ?? 10),
      rpmLimit: Number(body.rpmLimit ?? 10),
      maxTokens: Number(body.maxTokens ?? 32000),
      maxTokensParameter: body.maxTokensParameter ?? "max_tokens",
      thinkingType: body.thinkingType ?? "enabled",
      dailyTokenQuota: body.dailyTokenQuota ?? null,
      monthlyTokenQuota: body.monthlyTokenQuota ?? null,
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
    const models = state.models.map((model) => modelWithProvider(model, state.providers));
    return success(url.searchParams.has("page") || url.searchParams.has("limit") ? page(models, url) : models);
  }
  if (path === "/api/platform/ai/settings") {
    if (method === "GET") return success({ imageToolModelId: null, updatedAt: null, ...browserAiStore.read().platformSettings });
    const body = await bodyOf(init);
    let updated;
    browserAiStore.update((current) => {
      current.platformSettings = { ...current.platformSettings, ...body, updatedAt: new Date().toISOString() };
      updated = current.platformSettings;
    });
    return success(updated);
  }
  if (path === "/api/platform/ai/usage") return success(demoTokenUsage(null, true));
  if (path === "/api/platform/ai/usage/pricing/refresh" && method === "POST") {
    return success({ refreshed: true, pricingAvailable: true, modelCount: Math.max(1, browserAiStore.read().models.length), simulated: true });
  }
  match = path.match(/^\/api\/works\/([^/]+)\/providers$/u);
  if (match) {
    if (!findWork(decodeURIComponent(match[1]))) return failure("未找到作品");
    if (method === "GET") return success(browserAiStore.read().providers.map(publicProvider));
    if (method === "POST") {
      const body = await bodyOf(init);
      const provider = {
        id: demoId("provider"),
        name: String(body.name ?? "").trim(),
        protocol: body.protocol ?? "openai-chat-completions",
        baseUrl: normalizeProviderBaseUrl(body.baseUrl),
        apiKey: String(body.apiKey ?? "").trim(),
        concurrencyLimit: Number(body.concurrencyLimit ?? 10),
        rpmLimit: Number(body.rpmLimit ?? 10),
        maxTokens: Number(body.maxTokens ?? 32000),
        maxTokensParameter: body.maxTokensParameter ?? "max_tokens",
        thinkingType: body.thinkingType ?? "enabled",
        dailyTokenQuota: body.dailyTokenQuota ?? null,
        monthlyTokenQuota: body.monthlyTokenQuota ?? null,
        note: String(body.note ?? ""),
        status: body.status === "enabled" ? "enabled" : "disabled",
        connectionStatus: "unchecked",
        lastError: null
      };
      browserAiStore.update((state) => { state.providers.push(provider); });
      return success(publicProvider(provider), 201);
    }
  }
  match = path.match(/^\/api\/providers\/([^/]+)$/u);
  if (match) {
    const providerId = decodeURIComponent(match[1]);
    const current = browserAiStore.read().providers.find((item) => item.id === providerId);
    if (method === "GET") return current ? success(publicProvider(current)) : failure("未找到 AI 供应商");
    if (method === "DELETE") {
      if (!current) return failure("未找到 AI 供应商");
      browserAiStore.update((state) => {
        state.providers = state.providers.filter((item) => item.id !== providerId);
        state.models = state.models.filter((item) => item.providerId !== providerId);
      });
      return success(null, 204);
    }
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
    const state = browserAiStore.read();
    if (!state.providers.some((item) => item.id === providerId)) return failure("未找到 AI 供应商");
    if (method === "GET") {
      const models = state.models.filter((item) => item.providerId === providerId).map((model) => modelWithProvider(model, state.providers));
      return url.searchParams.has("page") || url.searchParams.has("limit") ? success(page(models, url)) : success(models);
    }
    const body = await bodyOf(init);
    if (Number(body.contextWindow ?? 128_000) < minimumModelContextWindow) return failure("模型上下文不能低于 32768 Token", 400);
    const model = { id: demoId("model"), providerId, displayName: String(body.displayName ?? "").trim(), modelId: String(body.modelId ?? "").trim(), purposes: body.purposes ?? ["chat"], contextNote: String(body.contextNote ?? ""), contextWindow: Number(body.contextWindow ?? 128000), outputNote: String(body.outputNote ?? ""), preset: body.preset ?? { temperature: 0.7, max_tokens: 32000 }, thinkingEnabled: body.thinkingEnabled !== false, thinkingEffort: ["low", "medium", "high", "xhigh", "max"].includes(body.thinkingEffort) ? body.thinkingEffort : "default", multimodalEnabled: Boolean(body.multimodalEnabled), imageToolDefault: Boolean(body.imageToolDefault), enabled: body.enabled !== false, note: String(body.note ?? "") };
    browserAiStore.update((current) => { current.models.push(model); });
    return success(modelWithProvider(model, state.providers), 201);
  }
  match = path.match(/^\/api\/models\/([^/]+)$/u);
  if (match) {
    const modelId = decodeURIComponent(match[1]);
    const existing = browserAiStore.read().models.find((item) => item.id === modelId);
    if (method === "GET") return existing ? success(modelWithProvider(existing, browserAiStore.read().providers)) : failure("未找到模型");
    if (method === "DELETE") {
      if (!existing) return failure("未找到模型");
      browserAiStore.update((state) => { state.models = state.models.filter((item) => item.id !== modelId); });
      return success(null, 204);
    }
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
    if (!findWork(workId)) return failure("未找到作品");
    const settings = { ...defaultWorkAiSettings(workId), ...(browserAiStore.read().workSettings[workId] ?? {}) };
    if (method === "GET") return success(settings);
    const updated = { ...settings, ...body, workId, updatedAt: new Date().toISOString() };
    browserAiStore.update((state) => { state.workSettings[workId] = updated; });
    return success(updated);
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
    const body = await bodyOf(init);
    const conversation = createConversationRecord(workId);
    if (["chat", "roleplay", "continue", "polish"].includes(body.taskType)) conversation.taskType = body.taskType;
    browserAiStore.update((state) => { state.conversations[workId] = [conversation, ...(state.conversations[workId] ?? [])]; });
    return success(conversationSummary(conversation), 201);
  }
  match = path.match(/^\/api\/ai-conversations\/([^/]+)$/u);
  if (match) {
    const conversationId = decodeURIComponent(match[1]);
    const conversation = findConversation(browserAiStore.read(), conversationId);
    if (!conversation) return failure("未找到 AI 对话");
    if (method === "DELETE") {
      if (conversation.isFavorite === true) return failure("收藏的对话不能清理，请先取消收藏", 409);
      browserAiStore.update((state) => {
        state.conversations[conversation.workId] = (state.conversations[conversation.workId] ?? []).filter((item) => item.id !== conversationId);
      });
      return success({ deleted: true });
    }
    return success(conversation);
  }
  match = path.match(/^\/api\/ai-conversations\/([^/]+)\/export$/u);
  if (match && method === "GET") {
    const conversation = findConversation(browserAiStore.read(), decodeURIComponent(match[1]));
    if (!conversation) return failure("未找到 AI 对话");
    const work = findWork(conversation.workId) ?? findDeletedWork(conversation.workId);
    const markdown = [`# ${conversation.title}`, "", `- 作品：${work?.title ?? "未知作品"}`, `- 会话 ID：${conversation.id}`, "", ...(conversation.messages ?? []).flatMap((message) => [`## ${message.role === "assistant" ? "Agent" : "作者"}`, "", message.content, ""])].join("\n");
    return new Response(markdown, { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${conversation.title || "AI 对话"}.md`)}` } });
  }
  match = path.match(/^\/api\/ai-conversations\/([^/]+)\/favorite$/u);
  if (match && method === "PATCH") {
    const conversationId = decodeURIComponent(match[1]);
    const body = await bodyOf(init);
    let updated;
    browserAiStore.update((state) => {
      const conversation = findConversation(state, conversationId);
      if (!conversation) return;
      conversation.isFavorite = body.isFavorite === true;
      conversation.updatedAt = new Date().toISOString();
      updated = conversationSummary(conversation);
    });
    return updated ? success(updated) : failure("未找到 AI 对话");
  }
  match = path.match(/^\/api\/ai-conversations\/([^/]+)\/(task-type|context-scope|roleplay)$/u);
  if (match && method === "PATCH") {
    const conversationId = decodeURIComponent(match[1]);
    const action = match[2];
    const body = await bodyOf(init);
    const selectedCharacter = body.characterId ? works.flatMap((work) => work.characters).find((item) => item.id === body.characterId) : null;
    const selectedUserCharacter = body.userCharacterId ? works.flatMap((work) => work.characters).find((item) => item.id === body.userCharacterId) : null;
    if (action === "roleplay" && body.characterId && !selectedCharacter) return failure("未找到要扮演的角色", 400);
    if (action === "roleplay" && body.userCharacterId && !selectedUserCharacter) return failure("未找到对话者扮演的角色", 400);
    if (selectedCharacter && selectedUserCharacter && selectedCharacter.id === selectedUserCharacter.id) return failure("双方不能扮演同一个角色", 400);
    let updated;
    browserAiStore.update((state) => {
      const conversation = findConversation(state, conversationId);
      if (!conversation) return;
      if (action === "task-type" && ["chat", "roleplay", "continue", "polish"].includes(body.taskType)) {
        conversation.taskType = body.taskType;
        if (body.taskType !== "roleplay") {
          conversation.roleplayCharacter = null;
          conversation.roleplayUserCharacter = null;
          conversation.agentTools = null;
        }
      }
      if (action === "context-scope" && body.scope && typeof body.scope === "object") conversation.contextScope = body.scope;
      if (action === "roleplay") {
        const characterView = (character) => character ? {
          id: character.id,
          name: character.name,
          code: character.code ?? "",
          gender: character.gender ?? "unknown",
          isDead: character.isDead === true,
          profile: character.profile ?? {},
          currentState: character.currentState ?? {}
        } : null;
        conversation.roleplayCharacter = characterView(selectedCharacter);
        conversation.roleplayUserCharacter = characterView(selectedUserCharacter);
        conversation.agentTools = selectedCharacter ? ["recall_self", "recall_relationship", "recall_story", "calculate_time"] : null;
        conversation.taskType = selectedCharacter ? "roleplay" : (conversation.taskType === "roleplay" ? "chat" : conversation.taskType);
      }
      conversation.updatedAt = new Date().toISOString();
      updated = conversationSummary(conversation);
    });
    return updated ? success(updated) : failure("未找到 AI 对话");
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
      forked.taskType = source.taskType;
      forked.contextScope = structuredClone(source.contextScope);
      forked.roleplayCharacter = structuredClone(source.roleplayCharacter);
      forked.roleplayUserCharacter = structuredClone(source.roleplayUserCharacter ?? null);
      forked.agentTools = structuredClone(source.agentTools);
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
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    if (method === "GET") {
      const status = url.searchParams.get("status");
      const suggestions = work.suggestions.filter((item) => !status || item.status === status);
      return url.searchParams.has("page") || url.searchParams.has("limit") ? success(page(suggestions, url)) : success(suggestions);
    }
    try {
      const body = await bodyOf(init);
      const result = await runBrowserAi(body, decodeURIComponent(match[1]));
      const conversation = body.conversationId ? findConversation(browserAiStore.read(), body.conversationId) : null;
      const suggestion = makeSuggestion(work, body, { ...result, contextUsage: contextUsage(result.model, conversation) });
      work.suggestions.unshift(suggestion);
      recordAudit(work, "suggestion.created", "ai-suggestion", suggestion.id, { taskType: suggestion.taskType });
      return success(suggestion, 201);
    } catch (error) {
      const message = error instanceof TypeError ? "浏览器直连失败，请确认接口地址、网络与 CORS 配置" : error.message;
      return failure(message, 502);
    }
  }
  match = path.match(/^\/api\/suggestions\/([^/]+)(?:\/(guards|guard|accept|reject))?$/u);
  if (match) {
    const found = findSuggestion(decodeURIComponent(match[1]));
    if (!found) return failure("未找到 AI 建议");
    const { work, suggestion } = found;
    const action = match[2];
    if (!action && method === "GET") return success(suggestion);
    if (action === "guards" && method === "GET") return success(suggestion.guard ? [suggestion.guard] : []);
    if (action === "guard" && method === "POST") {
      const body = await bodyOf(init);
      const chapter = suggestion.chapterId ? work.chapters.find((item) => item.id === suggestion.chapterId) : null;
      if (suggestion.taskType !== "continue" || !chapter) return failure("只有续写建议可以运行一致性守卫", 409);
      suggestion.guard = {
        id: demoId("guard"), suggestionId: suggestion.id, callId: null, chapterVersion: chapter.versionNo,
        content: String(body.content ?? suggestion.content), status: "clear", issues: [], contextRefs: [], createdAt: new Date().toISOString()
      };
      suggestion.updatedAt = new Date().toISOString();
      return success(suggestion.guard, 201);
    }
    if (action === "accept" && method === "POST") {
      if (suggestion.status !== "pending") return failure("该建议已经处理", 409);
      if (!suggestion.chapterId || suggestion.action === "note") return failure("问答或分析类建议不能直接写入正文", 409);
      const chapter = work.chapters.find((item) => item.id === suggestion.chapterId && !item.deletedAt);
      if (!chapter) return failure("未找到建议对应章节");
      if (chapter.versionNo !== suggestion.chapterVersion) return failure("正文版本已变化，请重新生成建议", 409);
      const body = await bodyOf(init);
      const content = String(body.content ?? suggestion.content).trim();
      if (suggestion.taskType === "continue" && (!suggestion.guard || suggestion.guard.status !== "clear" || suggestion.guard.chapterVersion !== chapter.versionNo || suggestion.guard.content !== content)) return failure("续写建议尚未完成一致性检查", 409);
      const nextContent = suggestion.action === "append"
        ? `${String(chapter.content).trimEnd()}\n\n${content}`.trim()
        : String(chapter.content).replace(String(suggestion.sourceText), content);
      if (suggestion.action === "replace" && nextContent === chapter.content) return failure("原选中文本已不存在，请重新生成建议", 409);
      chapter.content = nextContent;
      chapter.wordCount = wordCount(nextContent);
      chapter.versionNo += 1;
      chapter.updatedAt = new Date().toISOString();
      recordChapterVersion(chapter, "ai-suggestion", suggestion.id);
      suggestion.status = "accepted";
      suggestion.content = content;
      suggestion.decidedAt = chapter.updatedAt;
      suggestion.updatedAt = chapter.updatedAt;
      syncWorkChapters(work);
      recordAudit(work, "suggestion.accepted", "ai-suggestion", suggestion.id, { chapterId: chapter.id });
      return success({ suggestion, chapter });
    }
    if (action === "reject" && method === "POST") {
      if (suggestion.status !== "pending") return failure("该建议已经处理", 409);
      suggestion.status = "rejected";
      suggestion.decidedAt = new Date().toISOString();
      suggestion.updatedAt = suggestion.decidedAt;
      recordAudit(work, "suggestion.rejected", "ai-suggestion", suggestion.id);
      return success(suggestion);
    }
  }
  match = path.match(/^\/api\/works\/([^/]+)\/drafts$/u);
  if (match) {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    if (method === "GET") {
      const draftType = url.searchParams.get("draftType");
      const includeContent = url.searchParams.get("includeContent") === "true";
      const drafts = work.drafts
        .filter((draft) => !draft.deletedAt && (!draftType || draft.draftType === draftType))
        .map((draft) => draftView(draft, includeContent));
      return success(url.searchParams.has("page") || url.searchParams.has("limit") ? page(drafts, url) : drafts);
    }
    if (method === "POST") return success(createDraft(work, await bodyOf(init)), 201);
  }
  match = path.match(/^\/api\/drafts\/([^/]+)$/u);
  if (match) {
    const found = findResourceRecord(decodeURIComponent(match[1]), true);
    if (!found || found.resource !== "drafts") return failure("未找到想法");
    const draft = found.item;
    if (method === "GET") return success(draftView(draft, true));
    const body = await bodyOf(init);
    if (body.expectedVersionNo !== undefined && Number(body.expectedVersionNo) !== Number(draft.versionNo)) return failure("想法版本已变化，请刷新后重试", 409);
    if (method === "DELETE") {
      ensureEntityHistory(draft);
      found.work.drafts = found.work.drafts.filter((item) => item.id !== draft.id);
      recordAudit(found.work, "draft.deleted", "draft", draft.id, { versionNo: draft.versionNo });
      return success(null, 204);
    }
    if (method === "PATCH") {
      for (const key of ["title", "content", "settingModule"]) {
        if (body[key] !== undefined) draft[key] = key === "title" ? String(body[key]).trim() : body[key];
      }
      if (body.draftType === "prose" || body.draftType === "setting") draft.draftType = body.draftType;
      if (body.volumeId !== undefined) {
        const volume = found.work.volumes.find((item) => item.id === body.volumeId);
        draft.volumeId = volume?.id ?? null;
        draft.volumeTitle = volume?.title ?? null;
      }
      bumpEntity(found.work, draft, "draft", body.changeNote || "更新创作想法");
      return success(draftView(draft, true));
    }
  }
  match = path.match(/^\/api\/works\/([^/]+)\/settings\/context$/u);
  if (match && method === "GET") {
    const work = findWork(decodeURIComponent(match[1]));
    return work ? success(work.settings) : failure("未找到作品");
  }
  match = path.match(/^\/api\/works\/([^/]+)\/settings$/u);
  if (match) {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    if (method === "GET") return success(url.searchParams.has("page") || url.searchParams.has("limit") ? page(work.settings, url) : work.settings);
    if (method === "POST") {
      const body = await bodyOf(init);
      const timestamp = new Date().toISOString();
      const setting = {
        id: demoId("setting"),
        workId: work.id,
        title: String(body.title ?? "新设定").trim() || "新设定",
        category: String(body.category ?? "其他"),
        content: String(body.content ?? ""),
        tags: Array.isArray(body.tags) ? body.tags : [],
        status: ["draft", "pending", "confirmed", "deprecated"].includes(body.status) ? body.status : "draft",
        locked: Boolean(body.locked),
        evidence: Array.isArray(body.evidence) ? body.evidence : [],
        scope: body.scope && typeof body.scope === "object" ? body.scope : {},
        authorNote: String(body.authorNote ?? ""),
        versionNo: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        versions: []
      };
      ensureEntityHistory(setting);
      work.settings.unshift(setting);
      recordAudit(work, "setting.created", "setting", setting.id);
      return success(setting, 201);
    }
  }
  match = path.match(/^\/api\/settings\/([^/]+)$/u);
  if (match) {
    const found = findResourceRecord(decodeURIComponent(match[1]), true);
    if (!found || found.resource !== "settings") return failure("未找到设定");
    const setting = found.item;
    if (method === "GET") return success(setting);
    const body = await bodyOf(init);
    if (body.expectedVersionNo !== undefined && Number(body.expectedVersionNo) !== Number(setting.versionNo)) return failure("设定版本已变化，请刷新后重试", 409);
    if (method === "DELETE") {
      ensureEntityHistory(setting);
      found.work.settings = found.work.settings.filter((item) => item.id !== setting.id);
      recordAudit(found.work, "setting.deleted", "setting", setting.id, { versionNo: setting.versionNo });
      return success(null, 204);
    }
    if (method === "PATCH") {
      for (const key of ["title", "category", "content", "status", "authorNote"]) if (body[key] !== undefined) setting[key] = String(body[key]);
      for (const key of ["tags", "evidence"]) if (Array.isArray(body[key])) setting[key] = body[key];
      if (body.locked !== undefined) setting.locked = Boolean(body.locked);
      if (body.scope && typeof body.scope === "object") setting.scope = body.scope;
      bumpEntity(found.work, setting, "setting", body.changeNote || "更新世界观设定");
      return success(setting);
    }
  }
  match = path.match(/^\/api\/chapters\/([^/]+)\/outline$/u);
  if (match) {
    const found = findChapterRecord(decodeURIComponent(match[1]), true);
    if (!found) return failure("未找到章节");
    const outline = found.work.outlines.find((item) => item.chapterId === found.chapter.id);
    if (method === "GET") return success(outline ?? null);
    const body = await bodyOf(init);
    if (method === "DELETE") {
      if (outline) {
        ensureEntityHistory(outline);
        found.work.outlines = found.work.outlines.filter((item) => item.chapterId !== found.chapter.id);
        recordAudit(found.work, "outline.deleted", "chapter-outline", found.chapter.id);
      }
      return success(null, 204);
    }
    if (method === "PUT") {
      const current = outline ?? {
        chapterId: found.chapter.id,
        workId: found.work.id,
        chapterTitle: found.chapter.title,
        volumeId: found.chapter.volumeId,
        volumeTitle: found.work.volumes.find((item) => item.id === found.chapter.volumeId)?.title ?? "正文",
        versionNo: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        versions: []
      };
      if (body.expectedVersionNo !== undefined && outline && Number(body.expectedVersionNo) !== Number(current.versionNo)) return failure("大纲版本已变化，请刷新后重试", 409);
      Object.assign(current, {
        goal: String(body.goal ?? current.goal ?? ""),
        conflict: String(body.conflict ?? current.conflict ?? ""),
        turningPoint: String(body.turningPoint ?? current.turningPoint ?? ""),
        notes: String(body.notes ?? current.notes ?? ""),
        status: String(body.status ?? current.status ?? "draft")
      });
      if (outline) bumpEntity(found.work, current, "chapter-outline", body.changeNote || "更新章节大纲");
      else ensureEntityHistory(current);
      if (!outline) found.work.outlines.push(current);
      recordAudit(found.work, outline ? "outline.updated" : "outline.created", "chapter-outline", current.chapterId);
      return success(current);
    }
  }
  match = path.match(/^\/api\/works\/([^/]+)\/outline-board$/u);
  if (match && method === "GET") {
    const work = findWork(decodeURIComponent(match[1]));
    return work ? success(demoOutlineBoard(work, url)) : failure("未找到作品");
  }
  match = path.match(/^\/api\/works\/([^/]+)\/chapters\/([^/]+)\/foreshadow-reminders(?:\/([^/]+)\/resolve)?$/u);
  if (match) {
    const work = findWork(decodeURIComponent(match[1]));
    const chapter = work?.chapters.find((item) => item.id === decodeURIComponent(match[2]) && !item.deletedAt);
    if (!work || !chapter) return failure("未找到作品或章节");
    if (!match[3] && method === "GET") return success(demoForeshadowReminders(work, chapter));
    if (match[3] && method === "POST") {
      const foreshadow = work.foreshadows.find((item) => item.id === decodeURIComponent(match[3]));
      const reminder = demoForeshadowReminders(work, chapter).find((item) => item.foreshadowId === foreshadow?.id);
      if (!foreshadow || !reminder) return failure("未找到当前章节的伏笔提醒");
      const body = await bodyOf(init);
      if (body.expectedVersionNo !== undefined && Number(body.expectedVersionNo) !== Number(foreshadow.versionNo)) return failure("伏笔版本已变化，请刷新后重试", 409);
      foreshadow.status = "resolved";
      foreshadow.unresolved = false;
      foreshadow.resolutionNote = `在《${chapter.title}》中标记已回收`;
      bumpEntity(work, foreshadow, "foreshadow", "在编辑器标记伏笔已回收");
      return success({ ...reminder, status: foreshadow.status, versionNo: foreshadow.versionNo });
    }
  }
  match = path.match(/^\/api\/chapters\/([^/]+)\/insights$/u);
  if (match && method === "GET") {
    const found = findChapterRecord(decodeURIComponent(match[1]), true);
    if (!found) return failure("未找到章节");
    return success(found.chapter.insights ?? []);
  }
  if (path === "/api/recycle-bin/works" && method === "GET") {
    return success({
      retentionDays: 30,
      works: works.filter((work) => work.deletedAt).sort((left, right) => String(right.deletedAt).localeCompare(String(left.deletedAt))).map((work) => ({
        id: work.id,
        title: work.title,
        author: work.author,
        description: work.description,
        versionNo: work.versionNo,
        volumeCount: work.volumes.length,
        chapterCount: work.chapters.length,
        deletedAt: work.deletedAt,
        expiresAt: demoRecycleBinExpiresAt(work.deletedAt),
        actor: demoUser.displayName
      }))
    });
  }
  match = path.match(/^\/api\/recycle-bin\/works\/([^/]+)\/restore$/u);
  if (match && method === "POST") {
    const work = findDeletedWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到回收站作品");
    const body = await bodyOf(init);
    if (body.expectedVersionNo !== undefined && Number(body.expectedVersionNo) !== Number(work.versionNo)) return failure("作品版本已变化，请刷新后重试", 409);
    work.deletedAt = null;
    work.versionNo += 1;
    work.updatedAt = new Date().toISOString();
    recordAudit(work, "work.restored", "work", work.id, { versionNo: work.versionNo, fromRecycleBin: true });
    return success(workView(work));
  }
  match = path.match(/^\/api\/recycle-bin\/works\/([^/]+)\/permanent$/u);
  if (match && method === "DELETE") {
    const work = findDeletedWork(decodeURIComponent(match[1]));
    if (!work) return failure("仅回收站中的作品可以彻底删除", 409);
    const body = await bodyOf(init);
    if (body.expectedVersionNo !== undefined && Number(body.expectedVersionNo) !== Number(work.versionNo)) return failure("作品版本已变化，请刷新后重试", 409);
    for (const attachment of work.attachments) demoAttachmentBlobs.delete(attachment.id);
    for (const character of work.characters) demoCharacterAvatarBlobs.delete(character.id);
    works.splice(works.indexOf(work), 1);
    browserAiStore.update((state) => {
      delete state.conversations[work.id];
      delete state.workSettings[work.id];
      delete state.taskDefaults[work.id];
    });
    return success(null, 204);
  }
  if (path === "/api/works/import" && method === "POST") {
    const file = formFile(init);
    const fileName = String(file?.name ?? "未命名作品.txt").replace(/\.(?:txt|docx)$/iu, "").trim() || "未命名作品";
    const work = createEmptyWork({
      title: formValue(init, "title", fileName),
      author: formValue(init, "author", demoUserState.displayName),
      description: formValue(init, "description")
    });
    const volume = {
      id: demoId("volume"), workId: work.id, title: "正文", kind: "main", description: "", keywords: [], order: 1, sortOrder: 0, storyOrder: 0, versionNo: 1, deletedAt: null, chapters: [], versions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    ensureEntityHistory(volume);
    const content = file?.text ? await file.text() : "";
    const chapter = {
      id: demoId("chapter"), workId: work.id, volumeId: volume.id, title: "第一章", content: content.slice(0, 500_000), chapterType: "正文", order: 1, sortOrder: 0, wordCount: wordCount(content), versionNo: 1, excludedFromAnalysis: false, analysisStatus: "pending", deletedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), versions: []
    };
    recordChapterVersion(chapter, "import", `导入文件：${fileName}`);
    volume.chapters = [chapter];
    work.volumes = [volume];
    work.chapters = [chapter];
    syncWorkChapters(work);
    works.unshift(work);
    return success({ work: workView(work), warnings: [], firstImportedChapterId: chapter.id }, 201);
  }
  if (path === "/api/works" && method === "POST") {
    const work = createEmptyWork(await bodyOf(init));
    works.unshift(work);
    return success(workView(work), 201);
  }
  match = path.match(/^\/api\/works\/([^/]+)\/import$/u);
  if (match && method === "POST") {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    const file = formFile(init);
    const fileName = String(file?.name ?? "导入文件.txt");
    const mode = formValue(init, "mode", "overwrite");
    const content = file?.text ? await file.text() : "";
    if (mode === "overwrite") {
      work.chapters = [];
      for (const volume of work.volumes) volume.chapters = [];
    }
    let volume = work.volumes.find((item) => item.kind === "main") ?? work.volumes[0];
    if (!volume) {
      volume = { id: demoId("volume"), workId: work.id, title: "正文", kind: "main", description: "", keywords: [], order: 1, sortOrder: 0, storyOrder: 0, versionNo: 1, deletedAt: null, chapters: [], versions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      ensureEntityHistory(volume);
      work.volumes.push(volume);
    }
    const chapter = {
      id: demoId("chapter"), workId: work.id, volumeId: volume.id, title: mode === "append" ? `导入章节 ${work.chapters.length + 1}` : "第一章", content: content.slice(0, 500_000), chapterType: "正文", order: work.chapters.length + 1, sortOrder: volume.chapters.length, wordCount: wordCount(content), versionNo: 1, excludedFromAnalysis: false, analysisStatus: "pending", deletedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), versions: []
    };
    recordChapterVersion(chapter, "import", `导入文件：${fileName}`);
    work.chapters.push(chapter);
    syncWorkChapters(work);
    recordAudit(work, "work.imported", "work", work.id, { fileName, mode, chapters: 1 });
    return success({ tree: workView(work), warnings: [], firstImportedChapterId: chapter.id }, 201);
  }
  match = path.match(/^\/api\/works\/([^/]+)\/file-versions$/u);
  if (match && method === "GET") {
    const work = findWork(decodeURIComponent(match[1]));
    return work ? success(url.searchParams.has("page") || url.searchParams.has("limit") ? page(work.fileVersions, url) : work.fileVersions) : failure("未找到作品");
  }
  match = path.match(/^\/api\/works\/([^/]+)\/file-versions\/([^/]+)\/restore$/u);
  if (match && method === "POST") {
    const work = findWork(decodeURIComponent(match[1]));
    const fileVersion = work?.fileVersions.find((item) => item.id === decodeURIComponent(match[2]));
    return fileVersion ? success(workView(work)) : failure("未找到导入快照");
  }
  match = path.match(/^\/api\/works\/([^/]+)\/cover$/u);
  if (match) {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    if (method === "DELETE") {
      work.coverUrl = null;
      return success(workView(work));
    }
    if (method === "PUT") {
      work.coverUrl = `/demo-covers/${work.id}.webp?v=${encodeURIComponent(DEMO_COVER_VERSIONS[work.id] ?? "0")}`;
      return success(workView(work));
    }
    if (method === "GET") return success({ coverUrl: work.coverUrl });
  }
  match = path.match(/^\/api\/works\/([^/]+)\/attachments$/u);
  if (match) {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    if (method === "GET") {
      const module = url.searchParams.get("module");
      const attachments = work.attachments.filter((item) => !module || item.module === module);
      return success(url.searchParams.has("page") || url.searchParams.has("limit") ? page(attachments, url) : attachments);
    }
    if (method === "POST") return success(createDemoAttachment(work, init, url.searchParams.get("module")), 201);
  }
  match = path.match(/^\/api\/attachments\/([^/]+)\/content$/u);
  if (match && method === "GET") {
    const attachmentId = decodeURIComponent(match[1]);
    const found = works.flatMap((work) => work.attachments.map((attachment) => ({ work, attachment }))).find(({ attachment }) => attachment.id === attachmentId);
    if (!found) return failure("未找到附件");
    const blob = demoAttachmentBlobs.get(attachmentId);
    if (blob) return new Response(blob, { headers: { "content-type": found.attachment.storedMimeType, "cache-control": "private, max-age=3600" } });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#eadfd3"/><text x="320" y="190" text-anchor="middle" fill="#6b4a3e" font-family="sans-serif" font-size="24">${escapeXml(found.attachment.fileName)}</text></svg>`;
    return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "private, max-age=3600" } });
  }
  match = path.match(/^\/api\/attachments\/([^/]+)$/u);
  if (match && method === "DELETE") {
    const attachmentId = decodeURIComponent(match[1]);
    const found = works.flatMap((work) => work.attachments.map((attachment) => ({ work, attachment }))).find(({ attachment }) => attachment.id === attachmentId);
    if (!found) return failure("未找到附件");
    found.work.attachments = found.work.attachments.filter((attachment) => attachment.id !== attachmentId);
    demoAttachmentBlobs.delete(attachmentId);
    recordAudit(found.work, "attachment.deleted", "attachment", attachmentId);
    return success(null, 204);
  }
  match = path.match(/^\/api\/works\/([^/]+)\/ai-calls$/u);
  if (match && method === "GET") {
    const work = findWork(decodeURIComponent(match[1]));
    return work ? success([]) : failure("未找到作品");
  }
  match = path.match(/^\/api\/works\/([^/]+)\/export$/u);
  if (match && (method === "GET" || method === "HEAD")) {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    const format = ["docx", "epub"].includes(url.searchParams.get("format")) ? url.searchParams.get("format") : "markdown";
    return demoArtifactResponse(demoExportArtifact(work, format), method);
  }
  match = path.match(/^\/api\/works\/([^/]+)\/replace$/u);
  if (match && method === "POST") {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    const body = await bodyOf(init);
    if (!String(body.find ?? "")) return failure("查找内容不能为空", 400);
    return success(demoGlobalReplace(work, body));
  }
  match = path.match(/^\/api\/works\/([^/]+)$/u);
  if (match) {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    demoActiveWorkId = work.id;
    if (method === "GET") return success(url.searchParams.get("directory") === "volumes"
      ? { id: work.id, title: work.title, author: work.author, wordCount: work.wordCount, chapterCount: work.chapterCount, versionNo: work.versionNo, volumes: work.volumes.filter((volume) => !volume.deletedAt).map((volume) => ({ ...volume, chapters: [] })) }
      : workView(work));
    if (method === "PATCH") {
      const body = await bodyOf(init);
      if (body.expectedVersionNo !== undefined && Number(body.expectedVersionNo) !== Number(work.versionNo)) return failure("作品版本已变化，请刷新后重试", 409);
      for (const key of ["title", "author", "description", "language"]) if (body[key] !== undefined) work[key] = String(body[key]);
      if (Array.isArray(body.tags)) work.tags = body.tags;
      work.versionNo += 1;
      work.updatedAt = new Date().toISOString();
      recordAudit(work, "work.updated", "work", work.id, { fields: Object.keys(body), versionNo: work.versionNo });
      return success(workView(work));
    }
    if (method === "DELETE") {
      const body = await bodyOf(init);
      if (body.expectedVersionNo !== undefined && Number(body.expectedVersionNo) !== Number(work.versionNo)) return failure("作品版本已变化，请刷新后重试", 409);
      work.versionNo += 1;
      work.deletedAt = new Date().toISOString();
      work.updatedAt = work.deletedAt;
      recordAudit(work, "work.deleted", "work", work.id, { versionNo: work.versionNo, recoverable: true, expiresAt: demoRecycleBinExpiresAt(work.deletedAt) });
      return success(null, 204);
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
    return work ? success(url.searchParams.has("page") || url.searchParams.has("limit") ? page(work.auditLogs, url) : work.auditLogs) : failure("未找到作品");
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
    return success(url.searchParams.has("page") || url.searchParams.has("limit") ? page(annotations, url) : annotations);
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
  match = path.match(/^\/api\/chapters\/([^/]+)\/annotation-counts$/u);
  if (match && method === "GET") {
    const found = findChapterRecord(decodeURIComponent(match[1]));
    if (!found) return failure("未找到章节");
    const counts = new Map();
    for (const annotation of found.work.chapterAnnotations.filter((item) => item.chapterId === found.chapter.id && !item.deletedAt)) {
      for (let line = Number(annotation.startLine); line <= Number(annotation.endLine); line += 1) {
        counts.set(line, (counts.get(line) ?? 0) + 1);
      }
    }
    return success([...counts.entries()].sort(([left], [right]) => left - right).map(([line, count]) => ({ line, count })));
  }
  match = path.match(/^\/api\/chapters\/([^/]+)\/annotations$/u);
  if (match) {
    const found = findChapterRecord(decodeURIComponent(match[1]));
    if (!found) return failure("未找到章节");
    if (method === "GET") {
      const line = Number(url.searchParams.get("line"));
      return success(found.work.chapterAnnotations.filter((annotation) => annotation.chapterId === found.chapter.id
        && !annotation.deletedAt
        && (!Number.isInteger(line) || line < 1 || Number(annotation.startLine) <= line && Number(annotation.endLine) >= line)));
    }
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
  match = path.match(/^\/api\/characters\/([^/]+)\/sections$/u);
  if (match) {
    const found = findResourceRecord(decodeURIComponent(match[1]), true);
    if (!found || found.resource !== "characters") return failure("未找到角色");
    if (method === "GET") {
      const sections = found.item.profileSections ?? [];
      return url.searchParams.has("page") || url.searchParams.has("limit") ? success(page(sections, url)) : success(sections);
    }
    if (method === "POST") {
      const body = await bodyOf(init);
      const timestamp = new Date().toISOString();
      const section = {
        id: demoId("character-section"),
        workId: found.work.id,
        characterId: found.item.id,
        sectionType: String(body.sectionType ?? "other"),
        title: String(body.title ?? "新档案章节").trim() || "新档案章节",
        summary: String(body.summary ?? ""),
        contentMarkdown: String(body.contentMarkdown ?? ""),
        versionNo: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        versions: []
      };
      ensureEntityHistory(section);
      found.item.profileSections = [...(found.item.profileSections ?? []), section];
      found.item.profileSectionCount = found.item.profileSections.length;
      recordAudit(found.work, "character-section.created", "character-section", section.id, { characterId: found.item.id });
      return success(section, 201);
    }
  }
  match = path.match(/^\/api\/character-sections\/([^/]+)(?:\/(versions|restore))?$/u);
  if (match) {
    const found = findCharacterSection(decodeURIComponent(match[1]));
    if (!found) return failure("未找到人物档案章节");
    const action = match[2];
    if (action === "versions" && method === "GET") return success(ensureEntityHistory(found.section));
    if (action === "restore" && method === "POST") {
      const body = await bodyOf(init);
      const version = ensureEntityHistory(found.section).find((item) => Number(item.versionNo) === Number(body.versionNo));
      if (!version) return failure("未找到人物档案章节版本");
      Object.assign(found.section, version.snapshot ?? {});
      bumpEntity(found.work, found.section, "character-section", `恢复至 v${body.versionNo}`, "restore");
      return success(found.section);
    }
    if (method === "GET") return success(found.section);
    const body = await bodyOf(init);
    if (body.expectedVersionNo !== undefined && Number(body.expectedVersionNo) !== Number(found.section.versionNo)) return failure("人物档案章节版本已变化，请刷新后重试", 409);
    if (method === "DELETE") {
      found.character.profileSections = found.character.profileSections.filter((item) => item.id !== found.section.id);
      found.character.profileSectionCount = found.character.profileSections.length;
      recordAudit(found.work, "character-section.deleted", "character-section", found.section.id);
      return success(null, 204);
    }
    if (method === "PATCH") {
      for (const key of ["sectionType", "title", "summary", "contentMarkdown"]) if (body[key] !== undefined) found.section[key] = String(body[key]);
      bumpEntity(found.work, found.section, "character-section", body.changeNote || "更新人物档案章节");
      return success(found.section);
    }
  }
  match = path.match(/^\/api\/characters\/([^/]+)\/avatar$/u);
  if (match) {
    const found = findResourceRecord(decodeURIComponent(match[1]), true);
    if (!found || found.resource !== "characters") return failure("未找到角色");
    if (method === "PUT") {
      const file = formFile(init);
      if (!(file instanceof Blob) || !/^image\/(?:png|jpe?g|webp)$/u.test(file.type)) return failure("请选择 PNG、JPEG 或 WebP 角色头像", 415);
      demoCharacterAvatarBlobs.set(found.item.id, file);
      found.item.avatarUrl = `/api/characters/${encodeURIComponent(found.item.id)}/avatar?v=${Number(found.item.versionNo ?? 1) + 1}`;
      bumpEntity(found.work, found.item, "character", "更新角色头像");
      return success(found.item);
    }
    if (method === "DELETE") {
      demoCharacterAvatarBlobs.delete(found.item.id);
      found.item.avatarUrl = null;
      bumpEntity(found.work, found.item, "character", "移除角色头像");
      return success(found.item);
    }
    if (method === "GET") {
      const blob = demoCharacterAvatarBlobs.get(found.item.id);
      if (!blob) return failure("角色头像不存在");
      return new Response(blob, { headers: { "content-type": blob.type, "cache-control": "private, max-age=31536000, immutable" } });
    }
  }
  match = path.match(/^\/api\/works\/([^/]+)\/tasks(?:\/relationship-source-preview)?$/u);
  if (match) {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    if (path.endsWith("/relationship-source-preview") && method === "POST") {
      const body = await bodyOf(init);
      const characterIds = body.scope?.characterIds ?? [];
      const characters = work.characters.filter((item) => characterIds.includes(item.id));
      const sources = [
        ...work.chapters.filter((chapter) => !chapter.deletedAt).slice(0, 8).map((chapter) => ({ sourceType: "chapter", sourceId: chapter.id, version: String(chapter.versionNo), title: chapter.title, characterCount: chapter.content.length, matchType: "range" })),
        ...work.settings.slice(0, 8).map((setting) => ({ sourceType: "setting", sourceId: setting.id, version: String(setting.versionNo), title: setting.title, characterCount: setting.content.length, matchType: "range" }))
      ];
      return success({ sourceCount: sources.length, chapterCount: sources.filter((item) => item.sourceType === "chapter").length, settingCount: sources.filter((item) => item.sourceType === "setting").length, totalCharacters: sources.reduce((total, item) => total + item.characterCount, 0), estimatedBatchCount: Math.max(1, Math.ceil(sources.length / 8)), characters: characters.map((item) => ({ id: item.id, name: item.name })), sources });
    }
    if (method === "GET") return success(page(work.tasks, url));
    if (method === "POST") {
      const body = await bodyOf(init);
      const timestamp = new Date().toISOString();
      const task = {
        id: demoId("task"),
        workId: work.id,
        model: body.modelId ? { id: body.modelId, displayName: "演示模型", modelId: body.modelId } : null,
        taskType: String(body.taskType ?? "book-analysis"),
        scope: body.scope ?? { type: "book" },
        scopeSummary: body.scope?.type === "settings" ? "仅设定集" : body.scope?.chapterId ? "指定章节" : "全书",
        scopeDetails: [],
        status: "pending",
        progress: 0,
        result: null,
        failures: [],
        sourceVersions: {},
        attemptCount: 0,
        nextAttemptAt: null,
        lastAttemptAt: null,
        trace: { calls: [], processSteps: [] },
        createdAt: timestamp,
        updatedAt: timestamp
      };
      work.tasks.unshift(task);
      recordAudit(work, "task.created", "analysis-task", task.id, { taskType: task.taskType });
      return success(task, 201);
    }
  }
  match = path.match(/^\/api\/tasks\/([^/]+)\/character-extraction\/(preview|apply)$/u);
  if (match) {
    const taskId = decodeURIComponent(match[1]);
    const found = works.map((work) => ({ work, task: work.tasks.find((item) => item.id === taskId) })).find((value) => value.task);
    if (!found) return failure("未找到分析任务");
    found.task.characterExtractionPreview ??= {
      status: "pending",
      totalCount: 2,
      previewToken: demoId("character-preview"),
      items: [
        {
          candidateId: `${taskId}-candidate-1`,
          name: found.work.characters[0]?.name ?? "演示角色",
          aliases: ["分析候选别名"],
          species: found.work.characters[0]?.species ?? "",
          identity: "从正文中提取的身份摘要",
          stableCharacterId: found.work.characters[0]?.id ?? null,
          suggestedAction: found.work.characters[0] ? "merge" : "create",
          matchCandidates: found.work.characters[0] ? [{ characterId: found.work.characters[0].id, name: found.work.characters[0].name, versionNo: found.work.characters[0].versionNo, matchType: "stable" }] : [],
          conflicts: found.work.characters[0] ? ["已有非空档案字段会保持不变"] : []
        },
        {
          candidateId: `${taskId}-candidate-2`,
          name: "新发现角色",
          aliases: ["新人"],
          species: "",
          identity: "待作者确认的新角色",
          suggestedAction: "create",
          matchCandidates: [],
          conflicts: []
        }
      ]
    };
    if (match[2] === "preview" && method === "GET") return success(found.task.characterExtractionPreview);
    if (match[2] === "apply" && method === "POST") {
      const body = await bodyOf(init);
      if (body.previewToken !== found.task.characterExtractionPreview.previewToken) return failure("角色候选预览已过期，请重新加载", 409);
      if (found.task.characterExtractionApplied?.previewToken === body.previewToken) return success(found.task.characterExtractionApplied.result);
      const items = [];
      for (const selection of Array.isArray(body.selections) ? body.selections : []) {
        const candidate = found.task.characterExtractionPreview.items.find((item) => item.candidateId === selection.candidateId);
        if (!candidate) continue;
        if (selection.action === "skip") {
          items.push({ candidateId: candidate.candidateId, status: "skipped", characterId: null, addedAliases: [], conflicts: [] });
          continue;
        }
        if (selection.action === "merge") {
          const character = found.work.characters.find((item) => item.id === selection.targetCharacterId);
          if (!character) return failure("未找到要合并的角色", 400);
          const aliases = [...new Set((selection.aliases ?? []).map(String).filter((alias) => alias && alias !== character.name && !(character.aliases ?? []).includes(alias)))];
          character.aliases = [...(character.aliases ?? []), ...aliases];
          bumpEntity(found.work, character, "character", "应用角色抽取候选", "ai-task");
          items.push({ candidateId: candidate.candidateId, status: "merged", characterId: character.id, addedAliases: aliases, conflicts: [] });
          continue;
        }
        const character = createResourceRecord(found.work, "characters", selection);
        found.work.characters.unshift(character);
        recordAudit(found.work, "character.created", "character", character.id, { taskId });
        items.push({ candidateId: candidate.candidateId, status: "created", characterId: character.id, addedAliases: character.aliases, conflicts: [] });
      }
      const result = {
        status: "applied",
        totalCount: items.length,
        createdCount: items.filter((item) => item.status === "created").length,
        mergedCount: items.filter((item) => item.status === "merged").length,
        unchangedCount: 0,
        skippedCount: items.filter((item) => item.status === "skipped").length,
        characterIds: items.map((item) => item.characterId).filter(Boolean),
        items
      };
      found.task.characterExtractionPreview.status = "applied";
      found.task.characterExtractionApplied = { previewToken: body.previewToken, result };
      return success(result);
    }
  }
  match = path.match(/^\/api\/tasks\/([^/]+)(?:\/(detail|result|trace|run|rerun|cancel|relationship-changes\/(apply|discard)))?(?:\/calls\/([^/]+))?$/u);
  if (match) {
    const taskId = decodeURIComponent(match[1]);
    const found = works.map((work) => ({ work, task: work.tasks.find((item) => item.id === taskId) })).find((value) => value.task);
    if (!found) return failure("未找到分析任务");
    const { work, task } = found;
    const action = match[2];
    if (!action && method === "GET") return success({ ...task, scopeDetails: task.scopeDetails ?? [] });
    if (action === "detail" && method === "GET") return success({ ...task, scopeDetails: task.scopeDetails ?? [] });
    if (action === "result" && method === "GET") return success({ taskId: task.id, result: task.result });
    if (action === "trace" && method === "GET" && !match[4]) return success(task.trace ?? { calls: [], processSteps: [] });
    if (action === "trace" && method === "GET" && match[4]) return success((task.trace?.calls ?? []).find((item) => item.id === decodeURIComponent(match[4])) ?? { id: decodeURIComponent(match[4]), status: "completed", input: {}, output: {} });
    if (action === "run" && method === "POST") {
      task.status = "completed";
      task.progress = 100;
      task.attemptCount = Number(task.attemptCount ?? 0) + 1;
      task.lastAttemptAt = new Date().toISOString();
      task.result = task.result ?? { summary: "演示站已完成一次分析，结果可在任务详情中查看。" };
      task.updatedAt = new Date().toISOString();
      return success(task);
    }
    if (action === "rerun" && method === "POST") {
      const rerun = { ...task, id: demoId("task"), status: "pending", progress: 0, attemptCount: 0, result: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      work.tasks.unshift(rerun);
      return success(rerun, 201);
    }
    if (action === "cancel" && method === "POST") {
      task.status = "cancelled";
      task.updatedAt = new Date().toISOString();
      return success(task);
    }
    if (action === "relationship-changes/apply" || action === "relationship-changes/discard") return success(task);
  }
  match = path.match(/^\/api\/works\/([^/]+)\/tasks\/auto-run$/u);
  if (match && method === "POST") {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    for (const task of work.tasks.filter((item) => item.status === "pending")) {
      task.status = "completed";
      task.progress = 100;
      task.result = task.result ?? { summary: "演示站自动执行已完成。" };
      task.updatedAt = new Date().toISOString();
    }
    return success(work.tasks);
  }
  match = path.match(/^\/api\/works\/([^/]+)\/(characters|races|organizations|timeline-tracks|timeline|relationships|foreshadows|reviews)$/u);
  if (match) {
    const work = findWork(decodeURIComponent(match[1]));
    const resource = match[2];
    const collection = work ? resourceCollection(work, resource) : null;
    if (!work || !collection) return failure("未找到作品");
    if (method === "GET") {
      let items = collection.filter((item) => !item.deletedAt);
      if (resource === "characters" && url.searchParams.get("includeMerged") !== "1") items = items.filter((item) => !item.mergedIntoCharacterId);
      if (resource === "races" && url.searchParams.get("scope")) {
        const scope = url.searchParams.get("scope");
        const filtered = items.filter((item) => scope === "roots" ? !item.parentId : Boolean(item.parentId));
        return scope === "roots" ? success({ items: filtered, total: items.length }) : success(filtered);
      }
      if (resource === "foreshadows") {
        const status = url.searchParams.get("status") ?? "all";
        if (status === "resolved") items = items.filter((item) => item.status === "resolved");
        if (status === "unresolved") items = items.filter((item) => item.status !== "resolved");
        const currentChapterId = url.searchParams.get("currentChapterId");
        if (currentChapterId) items = items.filter((item) => (item.occurrences ?? []).some((occurrence) => occurrence.chapterId === currentChapterId));
      }
      if (resource === "reviews" && url.searchParams.get("status")) items = items.filter((item) => item.status === url.searchParams.get("status"));
      if (resource === "relationships") items = items.filter((item) => Number(item.confidence ?? 0) >= Number(url.searchParams.get("minimumConfidence") ?? url.searchParams.get("minConfidence") ?? 0));
      if (!url.searchParams.has("page") && !url.searchParams.has("limit")) return success(items);
      return success(page(items, url));
    }
    if (method === "POST") {
      const item = createResourceRecord(work, resource, await bodyOf(init));
      collection.unshift(item);
      recordAudit(work, `${resource}.created`, resource, item.id);
      return success(item, 201);
    }
  }
  match = path.match(/^\/api\/(characters|races|organizations|timeline-tracks|timeline|relationships|foreshadows|reviews)\/([^/]+)$/u);
  if (match) {
    const resource = match[1];
    const found = findResourceRecord(decodeURIComponent(match[2]), true);
    if (!found || found.resource !== resource) return failure("未找到创作资料");
    const item = found.item;
    if (method === "GET") return success(item);
    const body = await bodyOf(init);
    if (body.expectedVersionNo !== undefined && Number(body.expectedVersionNo) !== Number(item.versionNo)) return failure("创作资料版本已变化，请刷新后重试", 409);
    if (method === "DELETE") {
      ensureEntityHistory(item);
      const collection = resourceCollection(found.work, resource);
      collection.splice(collection.indexOf(item), 1);
      recordAudit(found.work, `${resource}.deleted`, resource, item.id, { versionNo: item.versionNo });
      return success(null, 204);
    }
    if (method === "PATCH") {
      const ignoredKeys = new Set(["id", "workId", "versionNo", "expectedVersionNo", "changeNote", "createdAt", "updatedAt"]);
      for (const [key, value] of Object.entries(body)) if (!ignoredKeys.has(key)) item[key] = value;
      if (resource === "foreshadows") item.unresolved = !["resolved", "abandoned"].includes(item.status);
      bumpEntity(found.work, item, resource === "timeline-tracks" ? "timeline-track" : resource === "timeline" ? "timeline-event" : resource.slice(0, -1), body.changeNote || "更新创作资料");
      return success(item);
    }
  }
  match = path.match(/^\/api\/(characters|races|organizations)\/([^/]+)\/merge$/u);
  if (match && method === "POST") {
    const resource = match[1];
    const found = findResourceRecord(decodeURIComponent(match[2]), true);
    if (!found || found.resource !== resource) return failure("未找到待合并档案");
    const body = await bodyOf(init);
    const targetId = body.targetCharacterId ?? body.targetRaceId ?? body.targetOrganizationId;
    const target = findResourceRecord(targetId, true);
    if (!target || target.resource !== resource || target.work.id !== found.work.id) return failure("未找到目标档案");
    if (resource === "characters") {
      target.item.aliases = [...new Set([...(target.item.aliases ?? []), found.item.name, ...(found.item.aliases ?? [])])];
      target.item.organizations = [...(target.item.organizations ?? []), ...(found.item.organizations ?? [])];
      target.item.profile = { ...(found.item.profile ?? {}), ...(target.item.profile ?? {}) };
      found.item.mergedIntoCharacterId = target.item.id;
    } else {
      target.item.description = [target.item.description, found.item.description].filter(Boolean).join("\n\n");
      target.item.settings = [...(target.item.settings ?? []), ...(found.item.settings ?? [])];
      target.item.settingsSections = [...(target.item.settingsSections ?? []), ...(found.item.settingsSections ?? [])];
      target.item.memberIds = [...new Set([...(target.item.memberIds ?? []), ...(found.item.memberIds ?? [])])];
      found.item.mergedIntoId = target.item.id;
    }
    bumpEntity(found.work, target.item, resource === "characters" ? "character" : resource === "races" ? "race" : "organization", "合并创作资料", "merge");
    const collection = resourceCollection(found.work, resource);
    collection.splice(collection.indexOf(found.item), 1);
    recordAudit(found.work, `${resource}.merged`, resource, found.item.id, { targetId: target.item.id });
    return success({ target: target.item, source: found.item });
  }
  match = path.match(/^\/api\/reviews\/([^/]+)\/character-resolution$/u);
  if (match && method === "POST") {
    const reviewFound = findResourceRecord(decodeURIComponent(match[1]), true);
    if (!reviewFound || reviewFound.resource !== "reviews") return failure("未找到审核项");
    const body = await bodyOf(init);
    if (body.action === "keep-separate") {
      reviewFound.item.status = "resolved";
      reviewFound.item.resolutionNote = "已确认保持角色独立";
      bumpEntity(reviewFound.work, reviewFound.item, "review", "确认角色保持独立", "manual");
      return success(reviewFound.item);
    }
    if (body.action === "merge") {
      const source = reviewFound.work.characters.find((item) => item.id === body.sourceCharacterId);
      const target = reviewFound.work.characters.find((item) => item.id === body.targetCharacterId);
      if (!source || !target) return failure("未找到待合并角色");
      target.aliases = [...new Set([...(target.aliases ?? []), source.name, ...(source.aliases ?? [])])];
      target.profile = { ...(source.profile ?? {}), ...(target.profile ?? {}) };
      source.mergedIntoCharacterId = target.id;
      bumpEntity(reviewFound.work, target, "character", "处理审核项并合并角色", "merge");
      reviewFound.item.status = "resolved";
      reviewFound.item.resolutionNote = `已合并至 ${target.name}`;
      bumpEntity(reviewFound.work, reviewFound.item, "review", "完成角色重复审核", "manual");
      return success({ target, source, review: reviewFound.item });
    }
    return failure("不支持的审核处理动作", 400);
  }
  match = path.match(/^\/api\/works\/([^/]+)\/timeline\/merge$/u);
  if (match && method === "POST") {
    const work = findWork(decodeURIComponent(match[1]));
    const body = await bodyOf(init);
    const selected = (body.eventIds ?? []).map((id) => work?.timeline.find((item) => item.id === id)).filter(Boolean);
    if (!work || selected.length < 2) return failure("合并时间事件至少需要选择两项", 400);
    const merged = createResourceRecord(work, "timeline", {
      ...body,
      trackId: selected.every((item) => item.trackId === selected[0].trackId) ? selected[0].trackId : null,
      description: body.description ?? selected.map((item) => item.description).filter(Boolean).join("\n"),
      timeLabel: body.timeLabel ?? selected[0].timeLabel,
      timeSort: body.timeSort ?? Math.min(...selected.map((item) => Number(item.timeSort)).filter(Number.isFinite)),
      chapterIds: [...new Set(selected.flatMap((item) => item.chapterIds ?? []))],
      participantIds: [...new Set(selected.flatMap((item) => item.participantIds ?? []))],
      evidence: [...new Set(selected.flatMap((item) => item.evidence ?? []).map((item) => JSON.stringify(item)))].map((item) => JSON.parse(item)),
      status: selected.every((item) => item.status === "confirmed") ? "confirmed" : "pending"
    });
    work.timeline = [merged, ...work.timeline.filter((item) => !selected.includes(item))];
    selected.forEach((item) => recordAudit(work, "timeline.deleted", "timeline-event", item.id, { mergedInto: merged.id }));
    recordAudit(work, "timeline.merged", "timeline-event", merged.id, { sourceIds: selected.map((item) => item.id) });
    return success({ merged, deleted: selected });
  }
  match = path.match(/^\/api\/timeline\/([^/]+)\/split$/u);
  if (match && method === "POST") {
    const found = findResourceRecord(decodeURIComponent(match[1]), true);
    const body = await bodyOf(init);
    if (!found || found.resource !== "timeline") return failure("未找到时间事件");
    if (!Array.isArray(body.parts) || body.parts.length < 2) return failure("拆分时间事件至少需要两项", 400);
    const created = body.parts.map((part) => createResourceRecord(found.work, "timeline", { ...found.item, ...part, id: undefined }));
    found.work.timeline = [
      ...created,
      ...found.work.timeline.filter((item) => item.id !== found.item.id)
    ];
    recordAudit(found.work, "timeline.split", "timeline-event", found.item.id, { createdIds: created.map((item) => item.id) });
    return success({ source: found.item, created });
  }
  match = path.match(/^\/api\/foreshadows\/([^/]+)\/occurrences$/u);
  if (match && method === "POST") {
    const found = findResourceRecord(decodeURIComponent(match[1]), true);
    if (!found || found.resource !== "foreshadows") return failure("未找到伏笔");
    const occurrence = { id: demoId("foreshadow-occurrence"), ...await bodyOf(init) };
    found.item.occurrences = [...(found.item.occurrences ?? []), occurrence];
    bumpEntity(found.work, found.item, "foreshadow", "添加伏笔章节记录");
    return success(occurrence, 201);
  }
  match = path.match(/^\/api\/foreshadow-occurrences\/([^/]+)$/u);
  if (match && (method === "PATCH" || method === "DELETE")) {
    const occurrenceId = decodeURIComponent(match[1]);
    const found = works.map((work) => ({ work, item: work.foreshadows.find((foreshadow) => (foreshadow.occurrences ?? []).some((item) => item.id === occurrenceId)) })).find((value) => value.item);
    const foreshadow = found?.item;
    const work = found?.work;
    if (!work || !foreshadow) return failure("未找到伏笔记录");
    if (method === "DELETE") foreshadow.occurrences = foreshadow.occurrences.filter((item) => item.id !== occurrenceId);
    else Object.assign(foreshadow.occurrences.find((item) => item.id === occurrenceId), await bodyOf(init));
    bumpEntity(work, foreshadow, "foreshadow", method === "DELETE" ? "删除伏笔章节记录" : "更新伏笔章节记录");
    return success(foreshadow);
  }
  match = path.match(/^\/api\/volumes\/([^/]+)\/chapters$/u);
  if (match) {
    const volumeId = decodeURIComponent(match[1]);
    const work = works.find((item) => item.volumes.some((volume) => volume.id === volumeId));
    const volume = work?.volumes.find((item) => item.id === volumeId);
    const chapters = volume?.chapters.filter((chapter) => !chapter.deletedAt) ?? [];
    return volume ? success(url.searchParams.has("page") || url.searchParams.has("limit") ? page(chapters, url) : chapters) : failure("未找到分卷");
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
      storyOrder: Number.isInteger(Number(body.storyOrder)) ? Number(body.storyOrder) : work.volumes.length,
      versionNo: 1,
      deletedAt: null,
      chapters: [],
      versions: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    ensureEntityHistory(volume);
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
  match = path.match(/^\/api\/volumes\/([^/]+)\/export$/u);
  if (match && (method === "GET" || method === "HEAD")) {
    const volumeId = decodeURIComponent(match[1]);
    const work = works.find((item) => item.volumes.some((volume) => volume.id === volumeId && !volume.deletedAt));
    if (!work) return failure("未找到分卷");
    return demoArtifactResponse(demoExportArtifact(work, "epub", volumeId), method);
  }
  match = path.match(/^\/api\/volumes\/([^/]+)\/(restore|permanent)$/u);
  if (match) {
    const volumeId = decodeURIComponent(match[1]);
    const work = works.find((item) => item.volumes.some((volume) => volume.id === volumeId));
    const volume = work?.volumes.find((item) => item.id === volumeId);
    if (!work || !volume?.deletedAt) return failure("未找到已删除分卷");
    const body = await bodyOf(init);
    if (body.expectedVersionNo !== undefined && Number(body.expectedVersionNo) !== Number(volume.versionNo)) return failure("分卷版本已变化，请刷新后重试", 409);
    if (match[2] === "restore" && method === "POST") {
      volume.deletedAt = null;
      bumpEntity(work, volume, "volume", "从回收站恢复分卷", "restore");
      for (const chapter of work.chapters.filter((item) => item.deletedViaVolumeId === volume.id)) {
        chapter.deletedAt = null;
        chapter.deletedViaVolumeId = null;
        chapter.versionNo += 1;
        chapter.updatedAt = new Date().toISOString();
        recordChapterVersion(chapter, "restore", "随分卷从回收站恢复");
      }
      syncWorkChapters(work);
      return success(volume);
    }
    if (match[2] === "permanent" && method === "DELETE") {
      for (const chapter of [...work.chapters.filter((item) => item.volumeId === volume.id)]) permanentlyDeleteChapter(work, chapter);
      work.volumes = work.volumes.filter((item) => item.id !== volume.id);
      recordAudit(work, "volume.purged", "volume", volume.id, { title: volume.title, recoverable: false });
      syncWorkChapters(work);
      return success(null, 204);
    }
  }
  match = path.match(/^\/api\/volumes\/([^/]+)$/u);
  if (match) {
    const volumeId = decodeURIComponent(match[1]);
    const work = works.find((item) => item.volumes.some((volume) => volume.id === volumeId));
    const volume = work?.volumes.find((item) => item.id === volumeId);
    if (!work || !volume) return failure("未找到分卷");
    if (method === "DELETE") {
      const body = await bodyOf(init);
      if (body.expectedVersionNo !== undefined && Number(body.expectedVersionNo) !== Number(volume.versionNo)) return failure("分卷版本已变化，请刷新后重试", 409);
      const timestamp = new Date().toISOString();
      volume.versionNo += 1;
      volume.deletedAt = timestamp;
      volume.updatedAt = timestamp;
      ensureEntityHistory(volume).unshift(entityVersion(volume, "delete", "删除分卷（可恢复）"));
      for (const chapter of work.chapters.filter((item) => item.volumeId === volumeId && !item.deletedAt)) {
        chapter.versionNo += 1;
        chapter.deletedAt = timestamp;
        chapter.deletedViaVolumeId = volumeId;
        chapter.updatedAt = timestamp;
        recordChapterVersion(chapter, "delete", "随分卷移入回收站");
      }
      syncWorkChapters(work);
      recordAudit(work, "volume.deleted", "volume", volumeId, { versionNo: volume.versionNo, recoverable: true });
      return success(null, 204);
    }
    if (method === "PATCH") {
      const body = await bodyOf(init);
      if (body.expectedVersionNo !== undefined && Number(body.expectedVersionNo) !== Number(volume.versionNo)) return failure("分卷版本已变化，请刷新后重试", 409);
      if (typeof body.title === "string") volume.title = body.title.trim();
      if (typeof body.kind === "string") volume.kind = body.kind;
      if (typeof body.description === "string") volume.description = body.description;
      if (Array.isArray(body.keywords)) volume.keywords = body.keywords;
      if (Number.isInteger(Number(body.storyOrder))) volume.storyOrder = Number(body.storyOrder);
      bumpEntity(work, volume, "volume", body.changeNote || "更新分卷");
    }
    return success(volume);
  }
  match = path.match(/^\/api\/works\/([^/]+)\/recycle-bin$/u);
  if (match && method === "GET") {
    const work = findWork(decodeURIComponent(match[1]));
    if (!work) return failure("未找到作品");
    return success({
      retentionDays: 30,
      volumes: work.volumes.filter((volume) => volume.deletedAt).map((volume) => ({
        id: volume.id,
        workId: work.id,
        title: volume.title,
        description: volume.description ?? "",
        chapterCount: work.chapters.filter((chapter) => chapter.volumeId === volume.id).length,
        versionNo: volume.versionNo,
        actor: demoUser.displayName,
        deletedAt: volume.deletedAt,
        expiresAt: demoRecycleBinExpiresAt(volume.deletedAt)
      })),
      chapters: work.chapters.filter((chapter) => chapter.deletedAt && !chapter.deletedViaVolumeId).map((chapter) => ({
        id: chapter.id,
        workId: work.id,
        volumeId: chapter.volumeId,
        volumeTitle: work.volumes.find((volume) => volume.id === chapter.volumeId)?.title ?? "原分卷",
        title: chapter.title,
        contentPreview: chapter.content.slice(0, 240),
        wordCount: chapter.wordCount,
        versionNo: chapter.versionNo,
        actor: demoUser.displayName,
        deletedAt: chapter.deletedAt,
        expiresAt: demoRecycleBinExpiresAt(chapter.deletedAt)
      }))
    });
  }
  if (path === "/api/works" && method === "GET") {
    const items = works.filter((work) => !work.deletedAt).map(({ chapters, characters, settings, races, organizations, timelineTracks, timeline, outlines, foreshadows, drafts, relationships, reviews, tasks, suggestions, fileVersions, attachments, members, chapterAnnotations, auditLogs, writingGoal, deletedAt, ...work }) => work);
    return success(url.searchParams.has("page") || url.searchParams.has("limit") ? page(items, url) : items);
  }
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
    const items = work[key] ?? [];
    return success(url.searchParams.has("page") || url.searchParams.has("limit") ? page(items, url) : items);
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
    const requestedType = url.searchParams.get("type");
    const resultLimit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
    if (!work) return failure("未找到作品");
    if (!query) return success([]);
    const matches = [];
    const add = (type, item, title, snippet, subtitle = "") => {
      const text = `${title} ${snippet} ${subtitle}`;
      if (requestedType && requestedType !== type) return;
      if (!text.toLowerCase().includes(query)) return;
      const titleHit = String(title).toLowerCase().includes(query);
      const lineIndex = type === "chapter" ? String(item.content ?? "").split(/\r?\n/u).findIndex((line) => line.toLowerCase().includes(query)) : -1;
      const line = lineIndex >= 0 ? lineIndex + 1 : undefined;
      matches.push({ type, id: item.id, title: String(title), snippet: String(snippet).slice(0, 180), subtitle: subtitle || undefined, score: titleHit ? 1 : 0.5, matchKinds: [titleHit ? "metadata" : "exact"], ...(line ? { startLine: line, endLine: line } : {}) });
    };
    work.chapters.filter((item) => !item.deletedAt).forEach((item) => add("chapter", item, item.title, item.content));
    work.settings.forEach((item) => add("setting", item, item.title, item.content, item.category));
    work.characters.forEach((item) => add("character", item, item.name, item.profile?.summary ?? "", item.species));
    work.races.forEach((item) => add("race", item, item.name, item.description));
    work.organizations.forEach((item) => add("organization", item, item.name, item.description));
    work.timelineTracks.forEach((item) => add("timeline-track", item, item.name, item.description));
    work.timeline.forEach((item) => add("timeline-event", item, item.name, item.description, item.timeLabel));
    work.relationships.forEach((item) => {
      const from = work.characters.find((character) => character.id === item.fromCharacterId)?.name ?? "未知角色";
      const to = work.characters.find((character) => character.id === item.toCharacterId)?.name ?? "未知角色";
      add("relationship", item, `${from} · ${item.subtype || item.category} · ${to}`, (item.keywords ?? []).join("、"), item.currentStatus);
    });
    work.outlines.forEach((item) => add("chapter-outline", item, item.chapterTitle, [item.goal, item.conflict, item.turningPoint, item.notes].filter(Boolean).join("\n"), item.volumeTitle));
    work.foreshadows.forEach((item) => add("foreshadow", item, item.title, item.description, item.status));
    work.reviews.forEach((item) => add("review", item, item.title, item.description, item.severity));
    if (!requestedType || requestedType === "agent-history") {
      for (const conversation of browserAiStore.read().conversations[work.id] ?? []) {
        for (const message of conversation.messages ?? []) {
          add("agent-history", { id: message.id }, conversation.title, message.content, message.role === "assistant" ? "Agent 回复" : "作者指令");
          const latest = matches.at(-1);
          if (latest?.type === "agent-history" && latest.id === message.id) Object.assign(latest, { conversationId: conversation.id, messageId: message.id });
        }
      }
    }
    return success(matches.slice(0, resultLimit));
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
  match = path.match(/^\/api\/entity-versions\/([^/]+)\/([^/]+)(?:\/restore)?$/u);
  if (match) {
    const entityType = decodeURIComponent(match[1]);
    const entityId = decodeURIComponent(match[2]);
    const target = entityHistory(entityType, entityId);
    if (!target) return failure("未找到版本记录");
    if (path.endsWith("/restore") && method === "POST") {
      const body = await bodyOf(init);
      if (body.expectedVersionNo !== undefined && Number(body.expectedVersionNo) !== Number(target.item.versionNo)) return failure("当前版本已变化，请刷新后重试", 409);
      const restored = restoreEntityVersion(target, Number(body.versionNo));
      return restored ? success(restored) : failure("未找到指定版本");
    }
    return success(target.versions);
  }
  match = path.match(/^\/api\/characters\/([^/]+)\/(versions|restore)$/u);
  if (match) {
    const target = entityHistory("character", decodeURIComponent(match[1]));
    if (!target) return failure("未找到角色");
    if (match[2] === "versions" && method === "GET") return success(target.versions);
    if (match[2] === "restore" && method === "POST") {
      const body = await bodyOf(init);
      if (body.expectedVersionNo !== undefined && Number(body.expectedVersionNo) !== Number(target.item.versionNo)) return failure("角色版本已变化，请刷新后重试", 409);
      const restored = restoreEntityVersion(target, Number(body.versionNo));
      return restored ? success(restored) : failure("未找到角色版本");
    }
  }

  if (method !== "GET") return success({ demo: true });
  return failure(`Demo 尚未预制接口：${path}`);
}

function installDemoUploadAdapter() {
  class DemoUploadRequest {
    constructor() {
      this.upload = new EventTarget();
      this.events = new EventTarget();
      this.headers = {};
      this.status = 0;
      this.responseText = "";
      this.aborted = false;
    }

    addEventListener(...args) { this.events.addEventListener(...args); }
    removeEventListener(...args) { this.events.removeEventListener(...args); }
    open(method, path) {
      this.method = String(method ?? "GET").toUpperCase();
      this.path = String(path ?? "");
    }
    setRequestHeader(name, value) { this.headers[String(name)] = String(value); }
    abort() {
      if (this.aborted) return;
      this.aborted = true;
      this.controller?.abort();
      this.events.dispatchEvent(new Event("abort"));
    }
    async send(body) {
      this.controller = new AbortController();
      const progress = (loaded, total) => {
        const event = new Event("progress");
        Object.defineProperties(event, {
          lengthComputable: { value: total > 0 },
          loaded: { value: loaded },
          total: { value: total }
        });
        this.upload.dispatchEvent(event);
      };
      const total = body instanceof FormData ? [...body.values()].reduce((size, value) => size + (value instanceof Blob ? value.size : String(value).length), 0) : 0;
      progress(0, total);
      try {
        const response = await window.fetch(this.path, { method: this.method, headers: this.headers, body, signal: this.controller.signal });
        if (this.aborted) return;
        this.status = response.status;
        this.responseText = await response.text();
        progress(total, total);
        this.events.dispatchEvent(new Event("load"));
      } catch {
        if (!this.aborted) this.events.dispatchEvent(new Event("error"));
      }
    }
  }
  window.XMLHttpRequest = DemoUploadRequest;
}

window.fetch = mockApi;
installDemoUploadAdapter();
