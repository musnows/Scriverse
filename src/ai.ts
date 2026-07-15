import type { AiMessage, ContextScope, TaskType } from "./domain.js";
import { CredentialVault } from "./credential-vault.js";
import { PLATFORM_AI_WORK_ID, type Row } from "./database.js";
import { AppError, notFound } from "./errors.js";
import { currentRequestActor } from "./request-context.js";
import { fetchSafeAiEndpoint } from "./security.js";
import { Store } from "./store.js";
import { clamp, id, json, maskSecret, normalizeBaseUrl, now } from "./utils.js";
import { z } from "zod";

type ProviderInput = {
  name: string;
  baseUrl: string;
  apiKey: string;
  status?: "enabled" | "disabled";
  note?: string;
  concurrencyLimit?: number;
  rpmLimit?: number;
  maxTokens?: number;
};

type ModelInput = {
  displayName: string;
  modelId: string;
  purposes?: string[];
  contextNote?: string;
  contextWindow?: number;
  outputNote?: string;
  preset?: Record<string, unknown>;
  enabled?: boolean;
  note?: string;
};

type ProviderRow = Row & {
  id: string;
  work_id: string;
  name: string;
  base_url: string;
  encrypted_key: string;
  key_iv: string;
  key_tag: string;
  key_hint: string;
  status: string;
  connection_status: string;
};

type ModelRow = Row & {
  id: string;
  provider_id: string;
  display_name: string;
  model_id: string;
  enabled: number;
};

type GenerateInput = {
  workId: string;
  taskType: TaskType;
  instruction: string;
  scope: ContextScope;
  modelId?: string;
  parameters?: Record<string, unknown>;
  extraSystemPrompt?: string;
  signal?: AbortSignal;
  maxAttempts?: number;
  onToolCall?: (call: AgentToolCallResult) => void;
  conversationId?: string;
  excludeConversationMessageId?: string;
  disableTools?: boolean;
};

type GenerateResult = {
  callId: string;
  content: string;
  outputTokens: number;
  provider: Record<string, unknown>;
  model: Record<string, unknown>;
  context: string;
  toolCalls: AgentToolCallResult[];
};

const allowedParameters = new Set(["temperature", "top_p", "max_tokens", "presence_penalty", "frequency_penalty", "seed"]);
const DEFAULT_MAX_TOKENS = 32_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const AGENT_TOOL_IDS = ["story_index", "read_chapters", "query_story_knowledge"] as const;
type AgentToolId = (typeof AGENT_TOOL_IDS)[number];
type CompletionToolCall = { id: string; type: "function"; function: { name: string; arguments: unknown } };
type CompletionMessage = AiMessage | { role: "assistant"; content: string | null; tool_calls: CompletionToolCall[] } | { role: "tool"; tool_call_id: string; content: string };

export type AgentToolCallResult = {
  id: string;
  name: string;
  arguments: Record<string, unknown> | null;
  status: "completed" | "failed";
  result: Record<string, unknown>;
};

const MAX_AGENT_TOOL_ROUNDS = 6;
const MAX_AGENT_TOOL_CALLS = 12;
const storyIndexArguments = z.object({
  offset: z.number().int().min(0).max(10_000).default(0),
  limit: z.number().int().min(1).max(50).default(20)
}).strict();
const readChaptersArguments = z.object({
  chapterIds: z.array(z.string().min(1).max(200)).min(1).max(3),
  include: z.enum(["summary", "content", "both"]).default("both")
}).strict();
const queryStoryKnowledgeArguments = z.object({
  query: z.string().trim().min(1).max(200),
  categories: z.array(z.enum(["setting", "character", "race", "organization", "timeline", "relationship", "outline", "foreshadow"])).max(8).default([])
}).strict();

const AGENT_TOOL_DEFINITIONS: Record<AgentToolId, Record<string, unknown>> = {
  story_index: {
    type: "function",
    function: {
      name: "story_index",
      description: "按分页列出作品卷章目录和当前章节概要。先用它定位章节 ID；不会返回正文。",
      parameters: { type: "object", properties: { offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false }
    }
  },
  read_chapters: {
    type: "function",
    function: {
      name: "read_chapters",
      description: "读取指定章节的当前正文与章节概要。仅在需要原文证据或精确措辞时使用；每次最多 3 章。",
      parameters: { type: "object", properties: { chapterIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 }, include: { type: "string", enum: ["summary", "content", "both"] } }, required: ["chapterIds"], additionalProperties: false }
    }
  },
  query_story_knowledge: {
    type: "function",
    function: {
      name: "query_story_knowledge",
      description: "按关键词查询作品知识：设定、人物、种族、组织、时间线、关系、大纲和伏笔。结果为简要匹配项；需要正文时再调用 read_chapters。",
      parameters: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 200 }, categories: { type: "array", items: { type: "string", enum: ["setting", "character", "race", "organization", "timeline", "relationship", "outline", "foreshadow"] }, maxItems: 8 } }, required: ["query"], additionalProperties: false }
    }
  }
};

export function estimateAiTokens(value: string): number {
  let wideCharacters = 0;
  let narrowCharacters = 0;
  for (const character of value) {
    if (/[^\u0000-\u00ff]/u.test(character)) wideCharacters += 1;
    else narrowCharacters += 1;
  }
  return Math.max(1, Math.ceil(wideCharacters * 1.1 + narrowCharacters / 4));
}

function truncateBookSummary(value: string, maximumTokens: number): string {
  if (estimateAiTokens(value) <= maximumTokens) return value;
  const notice = "[全书章节概要超过配额，已裁剪较早概要]";
  const prefix = estimateAiTokens(notice) < maximumTokens ? `${notice}\n` : "";
  const remainingTokens = Math.max(1, maximumTokens - estimateAiTokens(prefix));
  let start = 0;
  let end = value.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (estimateAiTokens(value.slice(middle)) > remainingTokens) start = middle + 1;
    else end = middle;
  }
  return `${prefix}${value.slice(start)}`;
}

export function resolveOutputTokens(usage: unknown, content: string): number {
  if (usage && typeof usage === "object") {
    const record = usage as Record<string, unknown>;
    const reported = record.completion_tokens ?? record.output_tokens;
    if (typeof reported === "number" && Number.isFinite(reported)) return Math.max(0, Math.round(reported));
  }
  return estimateAiTokens(content);
}

function normalizeModelPreset(input: Record<string, unknown>): Record<string, unknown> {
  const maxTokens = typeof input.max_tokens === "number" && Number.isFinite(input.max_tokens)
    ? Math.round(clamp(input.max_tokens, 1, 32_768))
    : DEFAULT_MAX_TOKENS;
  return { ...input, max_tokens: maxTokens };
}

function stringValue(row: Row, key: string): string {
  return String(row[key] ?? "");
}

function numberValue(row: Row, key: string): number {
  return Number(row[key] ?? 0);
}

function boolValue(row: Row, key: string): boolean {
  return Number(row[key] ?? 0) === 1;
}

function safeJsonObject(value: string): Record<string, unknown> {
  return json<Record<string, unknown>>(value, {});
}

function extractJson<T>(content: string): T {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u)?.[1];
  try {
    return JSON.parse(fenced ?? trimmed) as T;
  } catch {
    throw new AppError(502, "AI_INVALID_JSON", "AI 返回的分析结果不是有效 JSON", { output: trimmed.slice(0, 500) });
  }
}

const guardIssueTypes = new Set(["character", "location", "time", "world", "outline", "foreshadow"]);
const guardSeverities = new Set(["low", "medium", "high"]);
const unsafeGlobalAliases = new Set([
  "怪兽之王", "怪兽女王", "君王", "女王", "吾王", "博士", "陈博士", "玲博士", "老师", "舰长", "上尉", "司令", "族长",
  "父亲", "母亲", "爸爸", "妈妈", "哥哥", "姐姐", "大哥", "妹妹", "先生", "小姐", "陛下", "尔森"
]);

export function isSafeGlobalAlias(value: string): boolean {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
  if (!normalized || /^[a-z0-9]$/iu.test(normalized)) return false;
  return !unsafeGlobalAliases.has(value.normalize("NFKC").trim());
}

export function canonicalizeRelationshipSubtype(category: string, subtype: string): string {
  const original = subtype.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const key = original.toLocaleLowerCase("zh-CN").replace(/[\s_\-—→/]+/gu, "");
  if (category === "family") {
    if (/parentchild|fatherdaughter|fatherson|motherdaughter|motherson|父母子女|父女|父子|母女|母子/u.test(key)) return "父母子女";
    if (/adopt|收养|养父|养母|养子|养女/u.test(key)) return "收养亲子";
    if (/sister|brother|sibling|姐妹|兄弟|手足/u.test(key)) return "手足";
    if (/uncle|aunt|nephew|niece|叔侄|姑侄|舅甥/u.test(key)) return "叔侄";
  }
  if (category === "social") {
    if (/monarchsubject|subjecttoruler|rulersubject|superiorsubordinate|君王臣属|君臣|臣属君王/u.test(key)) return "君臣";
    if (/mentorstudent|teacherstudent|导师学生|师生/u.test(key)) return "师生";
    if (/colleague|coworker|同事/u.test(key) || /^(?:同僚|共事)$/u.test(key)) return "同事";
    if (/ally|allies|盟友/u.test(key) || /^(?:同盟|联盟)$/u.test(key)) return "盟友";
    if (/friend|friends|朋友|友人/u.test(key) || /^(?:旧友|老友|好友|挚友|战友|搭档|伙伴)$/u.test(key)) return "朋友";
  }
  if (category === "emotional") {
    if (/romanticpartner|romanticpartners|partner|partners|lover|lovers|spouse|夫妻|伴侣|恋人/u.test(key)) return "伴侣";
    if (/admirer|admired|crush|倾慕|单恋|追求/u.test(key)) return "倾慕";
    if (/closebond|亲密羁绊|亲密关系/u.test(key)) return "亲密羁绊";
  }
  if (category === "conflict") {
    if (/enemy|enemies|rival|rivals|宿敌|敌人|死敌/u.test(key)) return "宿敌";
    if (/abuser|victim|施害|受害/u.test(key)) return "施害与受害";
    if (/manipulat|操纵|利用/u.test(key)) return "操纵与被操纵";
  }
  return original;
}

export function canonicalizeRelationshipCategory(category: string, subtype: string): string {
  const key = subtype.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s_\-—→/]+/gu, "");
  if (/parentchild|fatherdaughter|fatherson|motherdaughter|motherson|adopt|sister|brother|sibling|uncle|aunt|nephew|niece|父母子女|父女|父子|母女|母子|收养|养父|养母|养子|养女|姐妹|兄弟|手足|叔侄|姑侄|舅甥/u.test(key)) return "family";
  if (/romanticpartner|partner|lover|spouse|夫妻|伴侣|恋人|admirer|admired|crush|倾慕|单恋|追求|closebond|亲密羁绊|亲密关系/u.test(key)) return "emotional";
  if (/enemy|enemies|rival|宿敌|敌人|死敌|abuser|victim|施害|受害|manipulat|操纵|利用/u.test(key)) return "conflict";
  const simplePeerSocial = /^(?:同事|同僚|共事|盟友|同盟|联盟|朋友|友人|旧友|老友|好友|挚友|战友|搭档|伙伴)$/u.test(key);
  if (/monarchsubject|subjecttoruler|rulersubject|superiorsubordinate|君王臣属|君臣|臣属君王|mentorstudent|teacherstudent|导师学生|师生|colleague|coworker|ally|allies|friend|friends/u.test(key) || simplePeerSocial) return "social";
  return category;
}

function reversesHierarchyDirection(subtype: string): boolean {
  const key = subtype.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s_\-—→/]+/gu, "");
  return /subjecttoruler|subordinatetoruler|臣属君王/u.test(key);
}

function parseGuardIssues(content: string): Array<Record<string, unknown>> {
  const value = extractJson<unknown>(content);
  if (!Array.isArray(value)) throw new AppError(502, "AI_INVALID_JSON", "续写一致性检查结果必须是数组");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AppError(502, "AI_INVALID_GUARD", `续写一致性检查第 ${index + 1} 项不是对象`);
    }
    const issue = item as Record<string, unknown>;
    if (typeof issue.type !== "string" || !guardIssueTypes.has(issue.type)) {
      throw new AppError(502, "AI_INVALID_GUARD", `续写一致性检查第 ${index + 1} 项类型无效`);
    }
    if (typeof issue.severity !== "string" || !guardSeverities.has(issue.severity)) {
      throw new AppError(502, "AI_INVALID_GUARD", `续写一致性检查第 ${index + 1} 项严重程度无效`);
    }
    if (typeof issue.title !== "string" || !issue.title.trim()) {
      throw new AppError(502, "AI_INVALID_GUARD", `续写一致性检查第 ${index + 1} 项缺少标题`);
    }
    return {
      type: issue.type,
      severity: issue.severity,
      title: issue.title.trim(),
      description: typeof issue.description === "string" ? issue.description : "",
      candidateQuote: typeof issue.candidateQuote === "string" ? issue.candidateQuote : "",
      sourceRefs: Array.isArray(issue.sourceRefs) ? issue.sourceRefs : [],
      suggestion: typeof issue.suggestion === "string" ? issue.suggestion : ""
    };
  });
}

function selectRelationshipConstraints(store: Store, workId: string, characterIds: Iterable<string>): Record<string, unknown>[] {
  const selectedCharacterIds = new Set(characterIds);
  return store.listRelationships(workId)
    .filter((relationship) => relationship.confirmationStatus !== "rejected")
    .filter((relationship) => relationship.locked === true || (
      relationship.confirmationStatus === "confirmed"
      && (selectedCharacterIds.has(String(relationship.fromCharacterId)) || selectedCharacterIds.has(String(relationship.toCharacterId)))
    ))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

export class ContextBuilder {
  constructor(private readonly store: Store) {}

  build(workId: string, scope: ContextScope, maximumChars = 60_000, bookSummaryMaximumTokens?: number): string {
    const work = this.store.getWork(workId);
    const constraints: string[] = [`作品：${String(work.title)}\n作者：${String(work.author) || "未填写"}`];
    const contentSections: string[] = [];
    const lockedSettings = this.store.listSettings(workId).filter((item) => item.locked);
    const allCharacters = this.store.listCharacters(workId);
    const lockedCharacters = allCharacters.filter(
      (item) => Array.isArray(item.lockedFields) && item.lockedFields.length > 0
    );
    const organizations = this.store.listOrganizations(workId);
    const relationshipConstraints = selectRelationshipConstraints(this.store, workId, scope.characterIds ?? []);

    if (lockedSettings.length > 0) {
      constraints.push(
        `作者锁定设定（硬约束）：\n${lockedSettings
          .map((item) => `- [${String(item.category)}] ${String(item.title)}：${String(item.content)}`)
          .join("\n")}`
      );
    }
    if (lockedCharacters.length > 0) {
      constraints.push(
        `作者锁定角色属性（硬约束）：\n${lockedCharacters
          .map((item) => {
            const locked = item.lockedFields as string[];
            const attributes = item.attributes as Record<string, unknown>;
            const state = item.currentState as Record<string, unknown>;
            const values = locked.map((key) => {
              const entityValue = item[key];
              const value = entityValue === undefined || entityValue === null || entityValue === "" ? attributes[key] ?? state[key] : entityValue;
              return `${key}=${String(value ?? "未填写")}`;
            }).join("；");
            return `- ${String(item.name)}：${values}`;
          })
          .join("\n")}`
      );
    }
    if (organizations.length > 0) {
      constraints.push(
        `世界内组织：\n${organizations.map((item) => {
          const settings = Array.isArray(item.settings) ? item.settings.map(String).filter(Boolean) : [];
          const members = Array.isArray(item.members)
            ? (item.members as Array<Record<string, unknown>>).map((member) => String(member.name)).filter(Boolean)
            : [];
          return `- ${String(item.name)}：${String(item.description) || "未填写简介"}${settings.length ? `；设定=${settings.join("、")}` : ""}${members.length ? `；成员=${members.join("、")}` : ""}`;
        }).join("\n")}`
      );
    }
    if (relationshipConstraints.length > 0) {
      const characterNameById = new Map(allCharacters.map((character) => [String(character.id), String(character.name)]));
      constraints.push(
        `相关人物关系（创作约束）：\n${relationshipConstraints.map((relationship) => {
          const from = characterNameById.get(String(relationship.fromCharacterId)) ?? "未知角色";
          const to = characterNameById.get(String(relationship.toCharacterId)) ?? "未知角色";
          const keywords = Array.isArray(relationship.keywords) ? relationship.keywords.map(String).filter(Boolean) : [];
          const marker = relationship.directed ? "→" : "—";
          return `- ${from} ${marker} ${to}：[${String(relationship.category)}/${String(relationship.subtype) || "未细分"}]${keywords.length ? ` 关键词=${keywords.join("、")}` : ""}；当前状态=${String(relationship.currentStatus)}${relationship.locked ? "；作者锁定" : "；作者确认"}`;
        }).join("\n")}`
      );
    }

    if (scope.type === "selection") {
      if (!scope.selection) throw new AppError(400, "SELECTION_REQUIRED", "选中文本上下文不能为空");
      contentSections.push(`当前选中文本：\n${scope.selection}`);
      if (scope.chapterId) this.appendChapter(contentSections, workId, scope.chapterId, false);
    } else if (scope.type === "chapter") {
      if (!scope.chapterId) throw new AppError(400, "CHAPTER_REQUIRED", "章节上下文缺少章节标识");
      this.appendPreviousChapterTail(contentSections, workId, scope.chapterId);
      this.appendChapter(contentSections, workId, scope.chapterId, true);
      if (scope.selection) contentSections.push(`当前选中文本（本次修改目标）：\n${scope.selection}`);
    } else if (scope.type === "volume") {
      if (!scope.volumeId) throw new AppError(400, "VOLUME_REQUIRED", "卷上下文缺少卷标识");
      const tree = this.store.getWorkTree(workId);
      const volume = (tree.volumes as Record<string, unknown>[]).find((item) => item.id === scope.volumeId);
      if (!volume) throw notFound("卷");
      const chapters = volume.chapters as Record<string, unknown>[];
      contentSections.push(
        `当前卷：${String(volume.title)}\n${chapters
          .map((chapter) => `\n[${String(chapter.title)} | 版本 ${String(chapter.versionNo)}]\n${String(chapter.content)}`)
          .join("\n")}`
      );
    } else if (scope.type === "book") {
      const tree = this.store.getWorkTree(workId);
      const volumes = tree.volumes as Record<string, unknown>[];
      contentSections.push(
        `全书正文：\n${volumes
          .map((volume) => {
            const chapters = volume.chapters as Record<string, unknown>[];
            return `\n# ${String(volume.title)}\n${chapters
              .map((chapter) => `\n## ${String(chapter.title)} | 版本 ${String(chapter.versionNo)}\n${String(chapter.content)}`)
              .join("\n")}`;
          })
          .join("\n")}`
      );
    }

    if (scope.includeBookSummary) this.appendBookSummary(contentSections, workId, bookSummaryMaximumTokens);

    if (scope.characterIds?.length) {
      const characters = scope.characterIds.map((characterId) => this.store.getCharacter(characterId));
      for (const character of characters) {
        if (character.workId !== workId) throw new AppError(400, "CHARACTER_WORK_MISMATCH", "角色不属于当前作品");
      }
      constraints.push(
        `选定角色：\n${characters
          .map((item) => {
            const attributes = item.attributes as Record<string, unknown>;
            return `- ${String(item.name)}；种族=${String(item.species || attributes.species) || "未填写"}；别名=${JSON.stringify(item.aliases)}；属性=${JSON.stringify(item.attributes)}；当前状态=${JSON.stringify(item.currentState)}；设定=${JSON.stringify(item.profile)}`;
          })
          .join("\n")}`
      );
    }
    if (scope.settingIds?.length) {
      const settings = scope.settingIds.map((settingId) => this.store.getSetting(settingId));
      for (const setting of settings) {
        if (setting.workId !== workId) throw new AppError(400, "SETTING_WORK_MISMATCH", "设定不属于当前作品");
      }
      constraints.push(
        `选定设定：\n${settings.map((item) => `- [${String(item.category)}] ${String(item.title)}：${String(item.content)}`).join("\n")}`
      );
    }

    if (scope.chapterId) this.appendChapterKnowledge(constraints, workId, scope.chapterId);

    const hardContext = constraints.join("\n\n");
    const bodyContext = contentSections.join("\n\n");
    const full = [hardContext, bodyContext].filter(Boolean).join("\n\n");
    if (full.length <= maximumChars) return full;
    if (hardContext.length > maximumChars - 200) {
      throw new AppError(413, "CONSTRAINT_CONTEXT_TOO_LARGE", "锁定设定、相关人物和创作约束超过上下文上限，请精简后重试", {
        maximumChars,
        constraintChars: hardContext.length
      });
    }
    const notice = "[上下文过长，已裁剪较早正文；锁定约束、人物状态、大纲与伏笔保持完整]";
    const remaining = Math.max(0, maximumChars - hardContext.length - notice.length - 4);
    return `${hardContext}\n\n${notice}\n${bodyContext.slice(-remaining)}`;
  }

  private appendChapter(sections: string[], workId: string, chapterId: string, includeContent: boolean): void {
    const chapter = this.store.getChapter(chapterId);
    if (chapter.workId !== workId) throw new AppError(400, "CHAPTER_WORK_MISMATCH", "章节不属于当前作品");
    sections.push(
      includeContent
        ? `当前章节：${String(chapter.title)} | 版本 ${String(chapter.versionNo)}\n${String(chapter.content)}`
        : `所在章节：${String(chapter.title)} | 版本 ${String(chapter.versionNo)}`
    );
  }

  private appendBookSummary(sections: string[], workId: string, maximumTokens?: number): void {
    const insights = this.store.listCurrentChapterInsights(workId);
    if (insights.length === 0) {
      sections.push("全书章节概要：当前没有可用的章节概要。请先运行章节理解任务。");
      return;
    }
    let currentVolume = "";
    const lines = ["全书章节概要（基于各章节当前版本的 AI 概要，不含正文）："];
    for (const insight of insights) {
      if (insight.volumeTitle !== currentVolume) {
        currentVolume = String(insight.volumeTitle);
        lines.push(`\n# ${currentVolume}`);
      }
      lines.push(`- ${String(insight.chapterTitle)}：${String(insight.summary) || "暂无梗概"}`);
    }
    const summary = lines.join("\n");
    sections.push(maximumTokens === undefined ? summary : truncateBookSummary(summary, maximumTokens));
  }

  private appendPreviousChapterTail(sections: string[], workId: string, chapterId: string): void {
    const tree = this.store.getWorkTree(workId);
    const chapters = (tree.volumes as Record<string, unknown>[])
      .flatMap((volume) => volume.chapters as Record<string, unknown>[]);
    const index = chapters.findIndex((chapter) => chapter.id === chapterId);
    if (index <= 0) return;
    const previous = chapters[index - 1];
    if (!previous) return;
    const content = String(previous.content);
    sections.push(`上一章节结尾：${String(previous.title)} | 版本 ${String(previous.versionNo)}\n${content.slice(-5000)}`);
  }

  private appendChapterKnowledge(sections: string[], workId: string, chapterId: string): void {
    const outline = this.store.getChapterOutline(chapterId);
    if (outline) {
      sections.push(
        `当前章大纲（创作约束）：\n目标：${String(outline.goal) || "未填写"}\n冲突：${String(outline.conflict) || "未填写"}\n转折：${String(outline.turningPoint) || "未填写"}\n状态：${String(outline.status)}`
      );
    }
    const foreshadows = this.store.listForeshadows(workId, "unresolved", chapterId).slice(0, 50);
    if (foreshadows.length > 0) {
      sections.push(
        `尚未回收的伏笔（不得擅自遗忘或违背）：\n${foreshadows.map((item) => {
          const linkedHere = (item.occurrences as Record<string, unknown>[]).some((occurrence) => occurrence.chapterId === chapterId);
          const marker = item.plannedPayoffChapterId === chapterId ? "本章计划回收" : linkedHere ? "与本章关联" : "全书未回收";
          return `- [${String(item.importance)} / ${marker}] ${String(item.title)}：${String(item.description)}`;
        }).join("\n")}`
      );
    }
    const timeline = this.store.listTimelineEvents(workId).filter(
      (item) => Array.isArray(item.chapterIds) && item.chapterIds.includes(chapterId)
    );
    if (timeline.length > 0) {
      sections.push(
        `本章关联时间线：\n${timeline.map((item) => `- ${String(item.timeLabel)}｜${String(item.name)}｜地点=${String(item.location) || "未填写"}`).join("\n")}`
      );
    }
  }
}

export class AiManager {
  readonly contextBuilder: ContextBuilder;
  private readonly taskControllers = new Map<string, AbortController>();
  private readonly autoRunBatches = new Map<string, { claimed: number; starting: Set<string> }>();
  private readonly autoRunTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly providerSchedules = new Map<string, {
    active: number;
    starts: number[];
    concurrencyLimit: number;
    rpmLimit: number;
    queue: Array<{
      signal?: AbortSignal;
      run: () => Promise<unknown>;
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
      detachAbort: () => void;
    }>;
    timer: ReturnType<typeof setTimeout> | null;
  }>();

  constructor(
    private readonly store: Store,
    private readonly vault: CredentialVault,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly validateOutboundUrl?: (url: string) => Promise<void>
  ) {
    this.contextBuilder = new ContextBuilder(store);
    this.store.setAnalysisTaskQueuedHandler((workId) => this.scheduleAutoRun(workId));
  }

  resetAutoRunBatch(workId: string): void {
    this.autoRunBatches.set(workId, { claimed: 0, starting: new Set() });
  }

  scheduleAutoRun(workId: string): void {
    try {
      if (!this.store.getWorkAiSettings(workId).autoRunEnabled) return;
    } catch {
      return;
    }
    const existing = this.autoRunTimers.get(workId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.autoRunTimers.delete(workId);
      void this.drainAutoRun(workId);
    }, 0);
    this.autoRunTimers.set(workId, timer);
  }

  startAutoRunBatch(workId: string): Record<string, unknown> {
    this.store.getWork(workId);
    const settings = this.store.getWorkAiSettings(workId);
    if (!settings.autoRunEnabled) {
      throw new AppError(400, "AUTO_RUN_DISABLED", "请先开启分析任务自动运行");
    }
    this.resetAutoRunBatch(workId);
    this.scheduleAutoRun(workId);
    return {
      workId,
      autoRunEnabled: true,
      autoRunConcurrency: settings.autoRunConcurrency,
      autoRunBatchLimit: settings.autoRunBatchLimit,
      pendingCount: this.store.countPendingTasks(workId),
      runningCount: this.store.countRunningTasks(workId)
    };
  }

  dispose(): void {
    for (const timer of this.autoRunTimers.values()) clearTimeout(timer);
    this.autoRunTimers.clear();
    this.autoRunBatches.clear();
    this.store.setAnalysisTaskQueuedHandler(null);
  }

  private getAutoRunBatch(workId: string): { claimed: number; starting: Set<string> } {
    const existing = this.autoRunBatches.get(workId);
    if (existing) return existing;
    const created = { claimed: 0, starting: new Set<string>() };
    this.autoRunBatches.set(workId, created);
    return created;
  }

  private async drainAutoRun(workId: string): Promise<void> {
    try {
      const settings = this.store.getWorkAiSettings(workId);
      if (!settings.autoRunEnabled) return;
      const batch = this.getAutoRunBatch(workId);
      const concurrency = Number(settings.autoRunConcurrency);
      const batchLimit = Number(settings.autoRunBatchLimit);
      while (true) {
        // 只计 DB running：starting 任务会在 runTask 同步阶段立刻标为 running，再加 starting 会重复计数
        const inFlight = this.store.countRunningTasks(workId);
        const remainingClaims = batchLimit - batch.claimed;
        if (inFlight >= concurrency || remainingClaims <= 0) return;
        const candidates = this.store.listOldestPendingTaskIds(workId, remainingClaims)
          .filter((taskId) => !batch.starting.has(taskId) && !this.taskControllers.has(taskId));
        if (!candidates.length) return;
        const taskId = candidates[0];
        if (!taskId) return;
        batch.starting.add(taskId);
        batch.claimed += 1;
        void this.runTask(taskId)
          .catch(() => undefined)
          .finally(() => {
            batch.starting.delete(taskId);
            this.scheduleAutoRun(workId);
          });
      }
    } catch {
      // 数据库已关闭或作品不存在时忽略自动调度
    }
  }

  private outboundFetch(url: string, init: RequestInit): Promise<Awaited<ReturnType<typeof fetch>>> {
    return fetchSafeAiEndpoint(this.fetchImpl, url, init, this.validateOutboundUrl);
  }

  createProvider(input: ProviderInput): Record<string, unknown> {
    const providerId = id("provider");
    const encrypted = this.vault.encrypt(input.apiKey);
    const timestamp = now();
    this.store.db.run(
      `INSERT INTO providers (id, work_id, name, base_url, encrypted_key, key_iv, key_tag, key_hint, status,
       connection_status, concurrency_limit, rpm_limit, max_tokens, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unchecked', ?, ?, ?, ?, ?, ?)`,
      providerId,
      PLATFORM_AI_WORK_ID,
      input.name,
      normalizeBaseUrl(input.baseUrl),
      encrypted.encrypted,
      encrypted.iv,
      encrypted.tag,
      maskSecret(input.apiKey),
      input.status ?? "disabled",
      input.concurrencyLimit ?? 10,
      input.rpmLimit ?? 10,
      input.maxTokens ?? DEFAULT_MAX_TOKENS,
      input.note ?? "",
      timestamp,
      timestamp
    );
    this.store.audit(PLATFORM_AI_WORK_ID, "provider.created", "provider", providerId, { name: input.name, baseUrl: normalizeBaseUrl(input.baseUrl) });
    return this.getProvider(providerId);
  }

  listProviders(): Record<string, unknown>[] {
    return this.store.db.all("SELECT * FROM providers WHERE work_id = ? ORDER BY created_at", PLATFORM_AI_WORK_ID).map((row) => this.mapProvider(row));
  }

  getProvider(providerId: string): Record<string, unknown> {
    return this.mapProvider(this.getProviderRow(providerId));
  }

  updateProvider(providerId: string, input: Partial<ProviderInput>): Record<string, unknown> {
    const row = this.getProviderRow(providerId);
    let encryptedKey = stringValue(row, "encrypted_key");
    let keyIv = stringValue(row, "key_iv");
    let keyTag = stringValue(row, "key_tag");
    let keyHint = stringValue(row, "key_hint");
    let connectionStatus = stringValue(row, "connection_status");
    if (input.apiKey) {
      const encrypted = this.vault.encrypt(input.apiKey);
      encryptedKey = encrypted.encrypted;
      keyIv = encrypted.iv;
      keyTag = encrypted.tag;
      keyHint = maskSecret(input.apiKey);
      connectionStatus = "unchecked";
    }
    if (input.baseUrl && normalizeBaseUrl(input.baseUrl) !== stringValue(row, "base_url")) connectionStatus = "unchecked";
    this.store.db.run(
      `UPDATE providers SET name = ?, base_url = ?, encrypted_key = ?, key_iv = ?, key_tag = ?, key_hint = ?,
       status = ?, connection_status = ?, concurrency_limit = ?, rpm_limit = ?, max_tokens = ?, note = ?, updated_at = ? WHERE id = ?`,
      input.name ?? stringValue(row, "name"),
      input.baseUrl ? normalizeBaseUrl(input.baseUrl) : stringValue(row, "base_url"),
      encryptedKey,
      keyIv,
      keyTag,
      keyHint,
      input.status ?? stringValue(row, "status"),
      connectionStatus,
      input.concurrencyLimit ?? numberValue(row, "concurrency_limit"),
      input.rpmLimit ?? numberValue(row, "rpm_limit"),
      input.maxTokens ?? numberValue(row, "max_tokens"),
      input.note ?? stringValue(row, "note"),
      now(),
      providerId
    );
    this.store.audit(PLATFORM_AI_WORK_ID, "provider.updated", "provider", providerId, {
      fields: Object.keys(input).filter((key) => key !== "apiKey"),
      keyReplaced: Boolean(input.apiKey)
    });
    const schedule = this.providerSchedules.get(providerId);
    if (schedule) {
      schedule.concurrencyLimit = Math.round(clamp((input.concurrencyLimit ?? numberValue(row, "concurrency_limit")) || 10, 1, 100));
      schedule.rpmLimit = Math.round(clamp((input.rpmLimit ?? numberValue(row, "rpm_limit")) || 10, 1, 10_000));
      this.pumpProviderSchedule(providerId);
    }
    return this.getProvider(providerId);
  }

  deleteProvider(providerId: string): void {
    const row = this.getProviderRow(providerId);
    const modelCount = this.store.db.get("SELECT COUNT(*) AS value FROM models WHERE provider_id = ?", providerId);
    const defaultCount = this.store.db.get(
      "SELECT COUNT(*) AS value FROM task_defaults WHERE model_id IN (SELECT id FROM models WHERE provider_id = ?)",
      providerId
    );
    this.store.audit(PLATFORM_AI_WORK_ID, "provider.deleted", "provider", providerId, {
      modelCount: numberValue(modelCount ?? {}, "value"),
      affectedDefaults: numberValue(defaultCount ?? {}, "value")
    });
    this.store.db.run("DELETE FROM providers WHERE id = ?", providerId);
  }

  async testProvider(providerId: string): Promise<Record<string, unknown>> {
    const row = this.getProviderRow(providerId);
    const apiKey = this.decryptKey(row);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const endpoint = `${normalizeBaseUrl(stringValue(row, "base_url"))}/models`;
      const response = await this.outboundFetch(endpoint, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(`HTTP ${response.status}: ${message.slice(0, 300)}`);
      }
      const payload = (await response.json()) as { data?: Array<{ id?: string }> };
      const availableModels = Array.isArray(payload.data) ? payload.data.map((item) => item.id).filter(Boolean) : [];
      const timestamp = now();
      this.store.db.run(
        "UPDATE providers SET connection_status = 'success', last_error = NULL, last_success_at = ?, updated_at = ? WHERE id = ?",
        timestamp,
        timestamp,
        providerId
      );
      return { ok: true, availableModels, provider: this.getProvider(providerId) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "连接失败";
      this.store.db.run(
        "UPDATE providers SET connection_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
        message,
        now(),
        providerId
      );
      return { ok: false, error: message, provider: this.getProvider(providerId) };
    } finally {
      clearTimeout(timeout);
    }
  }

  createModel(providerId: string, input: ModelInput): Record<string, unknown> {
    const provider = this.getProviderRow(providerId);
    const modelId = id("model");
    const timestamp = now();
    this.store.db.run(
      `INSERT INTO models (id, provider_id, display_name, model_id, purposes_json, context_note, context_window, output_note,
       preset_json, enabled, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      modelId,
      providerId,
      input.displayName,
      input.modelId,
      JSON.stringify(input.purposes ?? []),
      input.contextNote ?? "",
      input.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      input.outputNote ?? "",
      JSON.stringify(normalizeModelPreset(input.preset ?? {})),
      (input.enabled ?? true) ? 1 : 0,
      input.note ?? "",
      timestamp,
      timestamp
    );
    this.store.audit(PLATFORM_AI_WORK_ID, "model.created", "model", modelId, { providerId, modelId: input.modelId });
    return this.getModel(modelId);
  }

  listModels(providerId: string): Record<string, unknown>[] {
    this.getProviderRow(providerId);
    return this.store.db.all("SELECT * FROM models WHERE provider_id = ? ORDER BY created_at", providerId).map((row) => this.mapModel(row));
  }

  listPlatformModels(): Record<string, unknown>[] {
    return this.store.db
      .all("SELECT m.*, p.name AS provider_name FROM models m JOIN providers p ON p.id = m.provider_id WHERE p.work_id = ? ORDER BY p.created_at, m.created_at", PLATFORM_AI_WORK_ID)
      .map((row) => ({ ...this.mapModel(row), providerName: stringValue(row, "provider_name") }));
  }

  listWorkModels(workId: string): Record<string, unknown>[] {
    this.store.getWork(workId);
    return this.listPlatformModels();
  }

  getModel(modelId: string): Record<string, unknown> {
    const row = this.getModelRow(modelId);
    return this.mapModel(row);
  }

  updateModel(modelId: string, input: Partial<ModelInput>): Record<string, unknown> {
    const row = this.getModelRow(modelId);
    const preset = normalizeModelPreset(input.preset ?? safeJsonObject(stringValue(row, "preset_json")));
    this.store.db.run(
      `UPDATE models SET display_name = ?, model_id = ?, purposes_json = ?, context_note = ?, context_window = ?, output_note = ?,
       preset_json = ?, enabled = ?, note = ?, updated_at = ? WHERE id = ?`,
      input.displayName ?? stringValue(row, "display_name"),
      input.modelId ?? stringValue(row, "model_id"),
      JSON.stringify(input.purposes ?? json(stringValue(row, "purposes_json"), [])),
      input.contextNote ?? stringValue(row, "context_note"),
      input.contextWindow ?? (numberValue(row, "context_window") || DEFAULT_CONTEXT_WINDOW),
      input.outputNote ?? stringValue(row, "output_note"),
      JSON.stringify(preset),
      (input.enabled ?? boolValue(row, "enabled")) ? 1 : 0,
      input.note ?? stringValue(row, "note"),
      now(),
      modelId
    );
    return this.getModel(modelId);
  }

  deleteModel(modelId: string): void {
    this.getModelRow(modelId);
    this.store.db.run("DELETE FROM models WHERE id = ?", modelId);
  }

  setTaskDefault(workId: string, taskType: TaskType, modelId: string): Record<string, unknown> {
    const model = this.getModelRow(modelId);
    const provider = this.getProviderRow(stringValue(model, "provider_id"));
    if (stringValue(provider, "work_id") !== PLATFORM_AI_WORK_ID) throw new AppError(400, "MODEL_PLATFORM_MISMATCH", "模型不属于平台 AI 配置");
    this.assertAvailable(provider, model);
    this.store.db.run(
      `INSERT INTO task_defaults (work_id, task_type, model_id) VALUES (?, ?, ?)
       ON CONFLICT(work_id, task_type) DO UPDATE SET model_id = excluded.model_id`,
      workId,
      taskType,
      modelId
    );
    return { workId, taskType, model: this.getModel(modelId), provider: this.getProvider(stringValue(model, "provider_id")) };
  }

  listTaskDefaults(workId: string): Record<string, unknown>[] {
    this.store.getWork(workId);
    return this.store.db.all("SELECT * FROM task_defaults WHERE work_id = ? ORDER BY task_type", workId).map((row) => ({
      taskType: stringValue(row, "task_type"),
      model: this.getModel(stringValue(row, "model_id"))
    }));
  }

  async createSuggestion(input: GenerateInput): Promise<Record<string, unknown>> {
    const action = input.taskType === "continue" ? "append" : input.taskType === "polish" ? "replace-selection" : "note";
    if (action === "replace-selection" && !input.scope.selection) {
      throw new AppError(400, "SELECTION_REQUIRED", "润色任务必须提供选中文本");
    }
    const effectiveInput = input.taskType === "continue"
      ? { ...input, scope: this.enrichContinuationScope(input.workId, input.scope, input.instruction) }
      : input;
    const generated = await this.generate(effectiveInput);
    const chapter = effectiveInput.scope.chapterId ? this.store.getChapter(effectiveInput.scope.chapterId) : null;
    const suggestionId = id("suggestion");
    this.store.db.run(
      `INSERT INTO ai_suggestions (id, call_id, work_id, chapter_id, chapter_version, task_type, instruction,
       source_text, content, action, status, created_at, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      suggestionId,
      generated.callId,
      input.workId,
      chapter ? String(chapter.id) : null,
      chapter ? Number(chapter.versionNo) : null,
      input.taskType,
      input.instruction,
      effectiveInput.scope.selection ?? "",
      generated.content,
      action,
      now(),
      currentRequestActor()?.userId ?? null
    );
    if (input.taskType === "continue") await this.runSuggestionGuard(suggestionId);
    return { ...this.getSuggestion(suggestionId), outputTokens: generated.outputTokens, toolCalls: generated.toolCalls };
  }

  async createStreamingChat(
    input: Omit<GenerateInput, "taskType">,
    onDelta: (delta: string) => void
  ): Promise<Record<string, unknown>> {
    const generated = this.enabledAgentTools(input.workId, "chat").length
      ? await this.generate({ ...input, taskType: "chat" })
      : await this.generateStream({ ...input, taskType: "chat" }, onDelta);
    if (this.enabledAgentTools(input.workId, "chat").length) onDelta(generated.content);
    const chapter = input.scope.chapterId ? this.store.getChapter(input.scope.chapterId) : null;
    const suggestionId = id("suggestion");
    this.store.db.run(
      `INSERT INTO ai_suggestions (id, call_id, work_id, chapter_id, chapter_version, task_type, instruction,
       source_text, content, action, status, created_at, created_by_user_id) VALUES (?, ?, ?, ?, ?, 'chat', ?, ?, ?, 'note', 'pending', ?, ?)`,
      suggestionId,
      generated.callId,
      input.workId,
      chapter ? String(chapter.id) : null,
      chapter ? Number(chapter.versionNo) : null,
      input.instruction,
      input.scope.selection ?? "",
      generated.content,
      now(),
      currentRequestActor()?.userId ?? null
    );
    return { ...this.getSuggestion(suggestionId), outputTokens: generated.outputTokens, toolCalls: generated.toolCalls };
  }

  async runSuggestionGuard(suggestionId: string, candidateContent?: string): Promise<Record<string, unknown>> {
    const suggestion = this.getSuggestion(suggestionId);
    if (suggestion.taskType !== "continue" || !suggestion.chapterId) {
      throw new AppError(409, "GUARD_NOT_APPLICABLE", "只有续写建议可以运行一致性守卫");
    }
    const chapter = this.store.getChapter(String(suggestion.chapterId));
    if (chapter.versionNo !== suggestion.chapterVersion) {
      throw new AppError(409, "STALE_SUGGESTION", "正文版本已变化，请重新生成建议");
    }
    const call = this.store.db.get("SELECT model_id, context_scope_json FROM ai_calls WHERE id = ?", String(suggestion.callId));
    if (!call) throw notFound("AI 调用记录");
    const originalScope = json<ContextScope>(stringValue(call, "context_scope_json"), {
      type: "chapter",
      chapterId: String(suggestion.chapterId)
    });
    const scope = this.enrichContinuationScope(String(suggestion.workId), originalScope, String(suggestion.instruction));
    const content = candidateContent ?? String(suggestion.content);
    const contextRefs = this.buildContinuationContextRefs(String(suggestion.workId), String(suggestion.chapterId), scope);
    try {
      const generated = await this.generate({
        workId: String(suggestion.workId),
        taskType: "consistency-check",
        modelId: stringValue(call, "model_id"),
        scope,
        instruction: [
          "检查下面的续写候选是否与提供的上下文冲突。只输出 JSON 数组，没有冲突时输出 []。",
          "每项字段必须为：type（character/location/time/world/outline/foreshadow）、severity（low/medium/high）、title、description、candidateQuote、sourceRefs（数组）、suggestion。",
          "不得把文风偏好当成事实冲突，不得使用 Markdown 代码块。",
          "续写候选：",
          content
        ].join("\n\n"),
        extraSystemPrompt: "你是续写一致性守卫。必须逐项对照人物状态、地点、时间、世界观硬约束、章节大纲和未回收伏笔，输出严格 JSON。"
      });
      const issues = parseGuardIssues(generated.content);
      return this.store.createContinuationGuard({
        suggestionId,
        callId: generated.callId,
        chapterVersion: Number(chapter.versionNo),
        content,
        status: issues.length > 0 ? "warning" : "clear",
        issues,
        contextRefs
      });
    } catch (error) {
      const failure = error instanceof Error ? error.message : "一致性检查失败";
      const callId = error instanceof AppError && error.details && typeof error.details === "object" && "callId" in error.details
        ? String((error.details as Record<string, unknown>).callId)
        : null;
      return this.store.createContinuationGuard({
        suggestionId,
        callId,
        chapterVersion: Number(chapter.versionNo),
        content,
        status: "failed",
        issues: [],
        contextRefs,
        failure
      });
    }
  }

  listSuggestions(workId: string, status?: string): Record<string, unknown>[] {
    this.store.getWork(workId);
    const rows = status
      ? this.store.db.all("SELECT * FROM ai_suggestions WHERE work_id = ? AND status = ? ORDER BY created_at DESC", workId, status)
      : this.store.db.all("SELECT * FROM ai_suggestions WHERE work_id = ? ORDER BY created_at DESC", workId);
    return rows.map((row) => this.mapSuggestion(row));
  }

  getSuggestion(suggestionId: string): Record<string, unknown> {
    const row = this.store.db.get("SELECT * FROM ai_suggestions WHERE id = ?", suggestionId);
    if (!row) throw notFound("AI 建议");
    return this.mapSuggestion(row);
  }

  acceptSuggestion(suggestionId: string, acceptedContent?: string): Record<string, unknown> {
    const suggestion = this.getSuggestion(suggestionId);
    if (suggestion.status !== "pending") throw new AppError(409, "SUGGESTION_DECIDED", "该建议已经处理");
    if (!suggestion.chapterId || suggestion.action === "note") {
      throw new AppError(409, "SUGGESTION_NOT_APPLICABLE", "问答或分析类建议不能直接写入正文");
    }
    const chapter = this.store.getChapter(String(suggestion.chapterId));
    if (chapter.versionNo !== suggestion.chapterVersion) {
      throw new AppError(409, "STALE_SUGGESTION", "正文版本已变化，请重新生成建议", {
        expectedVersion: suggestion.chapterVersion,
        currentVersion: chapter.versionNo
      });
    }
    const content = acceptedContent ?? String(suggestion.content);
    if (suggestion.taskType === "continue") {
      const guard = this.store.getLatestContinuationGuard(suggestionId);
      if (!guard) throw new AppError(409, "GUARD_REQUIRED", "续写建议尚未完成一致性检查");
      if (guard.status === "failed") {
        throw new AppError(409, "GUARD_FAILED", "续写一致性检查失败，请重新运行检查后再采纳");
      }
      if (guard.chapterVersion !== chapter.versionNo || guard.contentHash !== this.store.hashContent(content)) {
        throw new AppError(409, "GUARD_STALE", "续写内容或正文版本已变化，请重新运行一致性检查");
      }
      const call = this.store.db.get("SELECT context_scope_json FROM ai_calls WHERE id = ?", String(suggestion.callId));
      if (!call) throw notFound("AI 调用记录");
      const originalScope = json<ContextScope>(stringValue(call, "context_scope_json"), {
        type: "chapter",
        chapterId: String(suggestion.chapterId)
      });
      const currentScope = this.enrichContinuationScope(String(suggestion.workId), originalScope, String(suggestion.instruction));
      const currentContextRefs = this.buildContinuationContextRefs(String(suggestion.workId), String(suggestion.chapterId), currentScope);
      if (JSON.stringify(guard.contextRefs) !== JSON.stringify(currentContextRefs)) {
        throw new AppError(409, "GUARD_STALE", "人物状态、锁定设定、大纲、伏笔或时间线已变化，请重新运行一致性检查");
      }
    }
    let nextContent: string;
    if (suggestion.action === "append") {
      nextContent = `${String(chapter.content).trimEnd()}\n\n${content.trim()}`.trim();
    } else {
      const sourceText = String(suggestion.sourceText);
      if (!sourceText || !String(chapter.content).includes(sourceText)) {
        throw new AppError(409, "SOURCE_TEXT_CHANGED", "原选中文本已不存在，请重新生成建议");
      }
      nextContent = String(chapter.content).replace(sourceText, content);
    }
    const updated = this.store.saveChapter(String(chapter.id), { content: nextContent }, "ai-suggestion", suggestionId);
    this.store.db.run("UPDATE ai_suggestions SET status = 'accepted', content = ?, decided_at = ?, decided_by_user_id = ? WHERE id = ?", content, now(), currentRequestActor()?.userId ?? null, suggestionId);
    this.store.audit(String(suggestion.workId), "suggestion.accepted", "ai-suggestion", suggestionId, { chapterId: chapter.id });
    return { suggestion: this.getSuggestion(suggestionId), chapter: updated };
  }

  rejectSuggestion(suggestionId: string): Record<string, unknown> {
    const suggestion = this.getSuggestion(suggestionId);
    if (suggestion.status !== "pending") throw new AppError(409, "SUGGESTION_DECIDED", "该建议已经处理");
    this.store.db.run("UPDATE ai_suggestions SET status = 'rejected', decided_at = ?, decided_by_user_id = ? WHERE id = ?", now(), currentRequestActor()?.userId ?? null, suggestionId);
    return this.getSuggestion(suggestionId);
  }

  listCalls(workId: string): Record<string, unknown>[] {
    this.store.getWork(workId);
    return this.store.db.all("SELECT * FROM ai_calls WHERE work_id = ? ORDER BY created_at DESC LIMIT 200", workId).map((row) => ({
      id: stringValue(row, "id"),
      workId: stringValue(row, "work_id"),
      taskType: stringValue(row, "task_type"),
      provider: this.getProvider(stringValue(row, "provider_id")),
      model: this.getModel(stringValue(row, "model_id")),
      contextScope: json(stringValue(row, "context_scope_json"), {}),
      parameters: json(stringValue(row, "parameters_json"), {}),
      status: stringValue(row, "status"),
      failure: row.failure === null ? null : stringValue(row, "failure"),
      inputChars: numberValue(row, "input_chars"),
      outputChars: numberValue(row, "output_chars"),
      createdAt: stringValue(row, "created_at"),
      completedAt: row.completed_at === null ? null : stringValue(row, "completed_at")
    }));
  }

  async runTask(taskId: string, modelId?: string): Promise<Record<string, unknown>> {
    const task = this.store.getTask(taskId);
    const workId = String(task.workId);
    const batch = this.getAutoRunBatch(workId);
    if (task.status !== "pending") throw new AppError(409, "TASK_NOT_PENDING", "只有待执行任务可以运行");
    if (!this.store.isTaskSourceCurrent(taskId)) {
      const expired = this.store.updateTask(taskId, { status: "expired" });
      batch.starting.delete(taskId);
      this.scheduleAutoRun(workId);
      return expired;
    }
    const settings = this.store.getWorkAiSettings(workId);
    // 自动 drain 已在 starting 集合中认领；手动运行在开关开启时计入本轮配额
    if (Boolean(settings.autoRunEnabled) && !batch.starting.has(taskId)) {
      batch.claimed += 1;
    }
    this.store.updateTask(taskId, { status: "running", progress: 5 });
    const taskController = new AbortController();
    this.taskControllers.set(taskId, taskController);
    try {
      const taskType = String(task.taskType);
      const scope = task.scope as ContextScope;
      let result: Record<string, unknown>;
      if (taskType === "chapter-analysis") {
        result = await this.runChapterAnalysis(workId, scope, modelId, taskId);
      } else if (taskType === "character-extraction" || taskType === "character-summary") {
        result = await this.runCharacterExtraction(workId, scope, modelId, taskId);
      } else if (taskType === "timeline-analysis") {
        result = await this.runTimelineAnalysis(workId, scope, modelId, taskId);
      } else if (taskType === "relationship-analysis") {
        result = await this.runRelationshipAnalysis(workId, scope, modelId, taskId);
      } else if (taskType === "consistency-check") {
        result = await this.runConsistencyCheck(workId, scope, modelId, taskId);
      } else {
        const generated = await this.generate({
          workId,
          taskType: taskType === "book-analysis" ? "book-analysis" : "chapter-analysis",
          instruction: "请基于上下文完成分析，给出有原文依据的中文结论。",
          scope,
          signal: taskController.signal,
          ...(modelId ? { modelId } : {})
        });
        result = { content: generated.content, callId: generated.callId };
      }
      if (!this.taskCanCommit(taskId)) return this.store.getTask(taskId);
      return this.store.updateTask(taskId, { status: "review", progress: 100, result });
    } catch (error) {
      if (this.store.getTask(taskId).status !== "running") return this.store.getTask(taskId);
      const message = error instanceof Error ? error.message : "分析失败";
      this.store.updateTask(taskId, { status: "partial", progress: 100, failures: [{ message }] });
      throw error;
    } finally {
      this.taskControllers.delete(taskId);
      batch.starting.delete(taskId);
      this.scheduleAutoRun(workId);
    }
  }

  cancelTask(taskId: string): Record<string, unknown> {
    const task = this.store.cancelTask(taskId);
    this.taskControllers.get(taskId)?.abort(new Error("分析任务已取消"));
    this.taskControllers.delete(taskId);
    this.scheduleAutoRun(String(task.workId));
    return task;
  }

  getContextUsage(input: Pick<GenerateInput, "workId" | "taskType" | "modelId" | "scope" | "instruction" | "conversationId" | "excludeConversationMessageId">): Record<string, unknown> {
    const { model } = this.resolveModel(input.workId, input.taskType, input.modelId);
    const context = this.buildContext(input.workId, input.scope, model);
    const messages = this.buildMessages(input, context);
    const contextWindow = numberValue(model, "context_window") || DEFAULT_CONTEXT_WINDOW;
    const inputTokens = messages.reduce((total, message) => total + estimateAiTokens(message.content), 0);
    const remainingTokens = Math.max(0, contextWindow - inputTokens);
    const threshold = Math.min(90, Math.max(50, Number(this.store.getWorkAiSettings(input.workId).contextCompactThreshold) || 85));
    const conversation = input.conversationId
      ? this.store.getAiConversationContext(input.conversationId, input.workId, input.excludeConversationMessageId)
      : null;
    return {
      modelId: stringValue(model, "id"),
      contextWindow,
      inputTokens,
      remainingTokens,
      usagePercent: Math.min(100, Math.round(inputTokens / contextWindow * 100)),
      compactThreshold: threshold,
      compactRecommended: inputTokens / contextWindow * 100 >= threshold,
      contextWarningPending: conversation?.warningPending ?? false,
      compactedMessageCount: conversation?.compactedMessageCount ?? 0
    };
  }

  async prepareConversationContext(input: Pick<GenerateInput, "workId" | "modelId" | "scope" | "instruction"> & { conversationId: string }): Promise<Record<string, unknown>> {
    const usage = this.getContextUsage({ ...input, taskType: "chat" });
    const conversation = this.store.getAiConversationContext(input.conversationId, input.workId);
    if (!usage.compactRecommended) {
      if (conversation.warningPending) this.store.setAiConversationContextWarning(input.conversationId, false);
      return { action: "ready", usage: { ...usage, contextWarningPending: false } };
    }
    if (!conversation.warningPending) {
      this.store.setAiConversationContextWarning(input.conversationId, true);
      return { action: "warn", usage: { ...usage, contextWarningPending: true } };
    }
    const compaction = await this.compactConversation(input);
    const compactedUsage = this.getContextUsage({ ...input, taskType: "chat" });
    return { action: "compacted", usage: compactedUsage, compaction };
  }

  async compactConversation(input: Pick<GenerateInput, "workId" | "modelId" | "scope"> & { conversationId: string }): Promise<Record<string, unknown>> {
    const conversation = this.store.getAiConversationContext(input.conversationId, input.workId);
    const targetMessageCount = conversation.totalMessageCount <= 2
      ? conversation.totalMessageCount
      : Math.max(conversation.compactedMessageCount, conversation.totalMessageCount - 2);
    const numberToCompact = targetMessageCount - conversation.compactedMessageCount;
    if (numberToCompact <= 0) {
      this.store.setAiConversationContextWarning(input.conversationId, false);
      return {
        conversationId: input.conversationId,
        compactedMessageCount: conversation.compactedMessageCount,
        retainedMessageCount: conversation.totalMessageCount - conversation.compactedMessageCount,
        changed: false
      };
    }
    const transcript = conversation.messages.slice(0, numberToCompact)
      .map((message) => `${message.role === "user" ? "作者" : "助手"}：${message.content}`)
      .join("\n\n");
    const source = [conversation.summary ? `已有摘要：\n${conversation.summary}` : "", `待压缩对话：\n${transcript}`].filter(Boolean).join("\n\n");
    const generated = await this.generate({
      workId: input.workId,
      taskType: "chat",
      instruction: `将下面的历史对话压缩为可供后续创作对话继续使用的中文上下文摘要。保留作者目标、明确事实、决定、限制、未解决问题和重要引用；删除寒暄、重复表达和已经被后文取代的信息。只输出摘要正文。\n\n${source}`,
      scope: { type: "entities" },
      modelId: input.modelId,
      parameters: { temperature: 0.2 },
      extraSystemPrompt: "你正在执行对话上下文压缩。不得调用工具，不得回答原问题，只能生成忠实、紧凑且可继续使用的摘要。",
      disableTools: true
    });
    this.store.saveAiConversationCompaction(input.conversationId, generated.content, targetMessageCount);
    return {
      conversationId: input.conversationId,
      compactedMessageCount: targetMessageCount,
      retainedMessageCount: conversation.totalMessageCount - targetMessageCount,
      summaryTokens: estimateAiTokens(generated.content),
      changed: true
    };
  }

  private buildMessages(input: Pick<GenerateInput, "workId" | "instruction" | "extraSystemPrompt" | "conversationId" | "excludeConversationMessageId">, context: string): AiMessage[] {
    const platformPrompt = String(this.store.getPlatformAiSettings().systemPrompt ?? "").trim();
    const workPrompt = String(this.store.getWorkAiSettings(input.workId).systemPrompt ?? "").trim();
    const systemPrompt = [
      "你是小说作者的创作协作助手。作者锁定的事实是不可违反的硬约束。",
      "只根据提供的正文和设定回答；不确定时明确说明，不得把推测当成事实。",
      "引用事实时注明章节或设定名称。不要声称已经修改正文。",
      platformPrompt ? `平台全局追加系统提示词：\n${platformPrompt}` : "",
      workPrompt ? `本书追加系统提示词：\n${workPrompt}` : "",
      input.extraSystemPrompt ?? ""
    ].filter(Boolean).join("\n\n");
    const conversation = input.conversationId
      ? this.store.getAiConversationContext(input.conversationId, input.workId, input.excludeConversationMessageId)
      : null;
    if (!conversation) {
      return [
        { role: "system", content: systemPrompt },
        { role: "user", content: `上下文如下：\n\n${context}\n\n作者指令：\n${input.instruction}` }
      ];
    }
    const conversationMessages: AiMessage[] = conversation?.messages.map((message) => ({ role: message.role, content: message.content })) ?? [];
    return [
      { role: "system", content: systemPrompt },
      ...(conversation?.summary ? [{ role: "system" as const, content: `较早对话的压缩摘要：\n${conversation.summary}` }] : []),
      { role: "user", content: `本次创作上下文如下：\n\n${context}` },
      ...conversationMessages,
      { role: "user", content: `作者当前指令：\n${input.instruction}` }
    ];
  }

  private buildContext(workId: string, scope: ContextScope, model: ModelRow): string {
    const contextWindow = numberValue(model, "context_window") || DEFAULT_CONTEXT_WINDOW;
    const settings = this.store.getWorkAiSettings(workId);
    const percentage = Math.min(90, Math.max(1, Number(settings.bookSummaryContextPercent) || 50));
    const bookSummaryMaximumTokens = scope.includeBookSummary
      ? Math.max(1, Math.floor(contextWindow * percentage / 100))
      : undefined;
    return this.contextBuilder.build(workId, scope, 60_000, bookSummaryMaximumTokens);
  }

  private enabledAgentTools(workId: string, taskType: TaskType): Record<string, unknown>[] {
    if (taskType !== "chat") return [];
    const enabled = new Set((this.store.getWorkAiSettings(workId).agentTools as unknown[])
      .filter((item): item is AgentToolId => typeof item === "string" && AGENT_TOOL_IDS.includes(item as AgentToolId)));
    return AGENT_TOOL_IDS.filter((toolId) => enabled.has(toolId)).map((toolId) => AGENT_TOOL_DEFINITIONS[toolId]);
  }

  private executeAgentTool(workId: string, toolCall: CompletionToolCall): AgentToolCallResult {
    const name = toolCall.function.name;
    let rawArguments: unknown = toolCall.function.arguments;
    if (typeof rawArguments === "string") {
      try {
        rawArguments = JSON.parse(rawArguments) as unknown;
      } catch {
        return {
          id: toolCall.id,
          name,
          arguments: null,
          status: "failed",
          result: { ok: false, error: { code: "TOOL_ARGUMENTS_INVALID_JSON", message: `Invalid arguments for ${name}: expected a JSON object.` } }
        };
      }
    }
    const suppliedArguments = rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)
      ? rawArguments as Record<string, unknown>
      : null;
    const schema = name === "story_index" ? storyIndexArguments
      : name === "read_chapters" ? readChaptersArguments
      : name === "query_story_knowledge" ? queryStoryKnowledgeArguments
      : null;
    if (!schema) {
      return {
        id: toolCall.id,
        name,
        arguments: suppliedArguments,
        status: "failed",
        result: { ok: false, error: { code: "TOOL_NOT_AVAILABLE", message: `Tool '${name}' is not available for this request.` } }
      };
    }
    const parsed = schema.safeParse(suppliedArguments);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ");
      return {
        id: toolCall.id,
        name,
        arguments: suppliedArguments,
        status: "failed",
        result: { ok: false, error: { code: "TOOL_ARGUMENTS_INVALID", message: `Invalid arguments for ${name}: ${details}` } }
      };
    }
    const args = parsed.data;
    if (name === "story_index") {
      const { offset, limit } = args as z.infer<typeof storyIndexArguments>;
      const tree = this.store.getWorkTree(workId);
      const summaries = new Map(this.store.listCurrentChapterInsights(workId).map((item) => [String(item.chapterId), String(item.summary)]));
      const chapters = (tree.volumes as Record<string, unknown>[]).flatMap((volume) => (volume.chapters as Record<string, unknown>[]).map((chapter) => ({
        id: String(chapter.id), volumeTitle: String(volume.title), title: String(chapter.title), versionNo: Number(chapter.versionNo), summary: summaries.get(String(chapter.id)) ?? ""
      })));
      return { id: toolCall.id, name, arguments: { offset, limit }, status: "completed", result: { ok: true, data: { totalChapters: chapters.length, offset, chapters: chapters.slice(offset, offset + limit), nextOffset: offset + limit < chapters.length ? offset + limit : null } } };
    }
    if (name === "read_chapters") {
      const { chapterIds, include } = args as z.infer<typeof readChaptersArguments>;
      const summaries = new Map(this.store.listCurrentChapterInsights(workId).map((item) => [String(item.chapterId), String(item.summary)]));
      let remainingChars = 36_000;
      const chapters = chapterIds.map((chapterId) => {
        try {
          const chapter = this.store.getChapter(chapterId);
          if (chapter.workId !== workId) return { chapterId, error: { code: "CHAPTER_WORK_MISMATCH", message: "The requested chapter belongs to a different work." } };
          const content = String(chapter.content);
          const excerpt = content.slice(0, Math.max(0, remainingChars));
          remainingChars -= excerpt.length;
          return { chapterId, title: chapter.title, versionNo: chapter.versionNo, ...(include !== "content" ? { summary: summaries.get(chapterId) ?? "" } : {}), ...(include !== "summary" ? { content: excerpt, contentTruncated: excerpt.length < content.length } : {}) };
        } catch {
          return { chapterId, error: { code: "CHAPTER_NOT_FOUND", message: "The requested chapter was not found." } };
        }
      });
      return { id: toolCall.id, name, arguments: { chapterIds, include }, status: "completed", result: { ok: true, data: { chapters, contentLimitChars: 36_000 } } };
    }
    if (name === "query_story_knowledge") {
      const { query, categories: categoryList } = args as z.infer<typeof queryStoryKnowledgeArguments>;
      const categories = new Set<string>(categoryList);
      const allowed = new Set(["setting", "character", "race", "organization", "timeline", "relationship", "outline", "foreshadow"]);
      const matches = this.store.search(workId, query).filter((item) => !categories.size || categories.has(String(item.type))).slice(0, 20);
      const extra = [
        ...this.store.listTimelineEvents(workId).map((item) => ({ type: "timeline", id: item.id, title: item.name, snippet: `${item.description} ${item.timeLabel}` })),
        ...this.store.listRelationships(workId).map((item) => ({ type: "relationship", id: item.id, title: `${item.fromCharacterId} / ${item.toCharacterId}`, snippet: `${item.category} ${item.subtype} ${(item.keywords as string[]).join(" ")}` })),
        ...this.store.listChapterOutlines(workId).map((item) => ({ type: "outline", id: item.chapterId, title: item.chapterTitle, snippet: `${item.goal} ${item.conflict} ${item.turningPoint} ${item.notes}` })),
        ...this.store.listForeshadows(workId).map((item) => ({ type: "foreshadow", id: item.id, title: item.title, snippet: `${item.description} ${item.resolutionNote}` }))
      ].filter((item) => allowed.has(item.type) && (!categories.size || categories.has(item.type)) && `${item.title} ${item.snippet}`.toLocaleLowerCase("zh-CN").includes(query.toLocaleLowerCase("zh-CN"))).slice(0, 20);
      return { id: toolCall.id, name, arguments: { query, categories: categoryList }, status: "completed", result: { ok: true, data: { query, matches: [...matches, ...extra].slice(0, 30) } } };
    }
    throw new Error(`Unhandled agent tool: ${name}`);
  }

  private constrainParametersForContext(model: ModelRow, messages: AiMessage[], parameters: Record<string, unknown>): Record<string, unknown> {
    const contextWindow = numberValue(model, "context_window") || DEFAULT_CONTEXT_WINDOW;
    const inputTokens = messages.reduce((total, message) => total + estimateAiTokens(message.content), 0);
    if (inputTokens >= contextWindow) {
      throw new AppError(400, "CONTEXT_WINDOW_EXCEEDED", `当前上下文约 ${inputTokens} Token，已超过模型 ${contextWindow} Token 的上下文容量`);
    }
    return {
      ...parameters,
      max_tokens: Math.min(Number(parameters.max_tokens) || DEFAULT_MAX_TOKENS, contextWindow - inputTokens)
    };
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const { model, provider } = this.resolveModel(input.workId, input.taskType, input.modelId);
    const context = this.buildContext(input.workId, input.scope, model);
    const preset = safeJsonObject(stringValue(model, "preset_json"));
    const messages = this.buildMessages(input, context);
    const tools = input.disableTools ? [] : this.enabledAgentTools(input.workId, input.taskType);
    const completionMessages: CompletionMessage[] = [...messages];
    const parameters = this.constrainParametersForContext(
      model,
      messages,
      this.sanitizeParameters({ ...preset, ...(input.parameters ?? {}), max_tokens: numberValue(provider, "max_tokens") || DEFAULT_MAX_TOKENS })
    );
    const callId = id("call");
    const timestamp = now();
    this.store.db.run(
      `INSERT INTO ai_calls (id, work_id, task_type, provider_id, model_id, context_scope_json, parameters_json,
       status, input_chars, created_at, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      callId,
      input.workId,
      input.taskType,
      stringValue(provider, "id"),
      stringValue(model, "id"),
      JSON.stringify(input.scope),
      JSON.stringify(parameters),
      context.length + input.instruction.length,
      timestamp,
      currentRequestActor()?.userId ?? null
    );
    try {
      const apiKey = this.decryptKey(provider);
      const endpoint = `${normalizeBaseUrl(stringValue(provider, "base_url"))}/chat/completions`;
      const timeoutMs = input.taskType === "book-analysis" || input.taskType === "relationship-analysis" ? 300_000 : 60_000;
      const maximumAttempts = Math.round(clamp(input.maxAttempts ?? 3, 1, 5));
      type CompletionPayload = {
        usage?: { completion_tokens?: number; output_tokens?: number };
        choices?: Array<{
          finish_reason?: string | null;
          message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: CompletionToolCall[] };
        }>;
      };
      const requestCompletion = async (toolChoice: "auto" | "none"): Promise<CompletionPayload> => {
        let lastFailure: unknown = null;
        for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
          let retryable = true;
          try {
            const candidate = await this.scheduleProviderRequest(provider, input.signal, async () => {
              const controller = new AbortController();
              const forwardAbort = (): void => controller.abort(input.signal?.reason);
              if (input.signal?.aborted) forwardAbort();
              else input.signal?.addEventListener("abort", forwardAbort, { once: true });
              const timeout = setTimeout(() => controller.abort(), timeoutMs);
              try {
                const response = await this.outboundFetch(endpoint, {
                  method: "POST",
                  headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
                  body: JSON.stringify({ model: stringValue(model, "model_id"), messages: completionMessages, ...parameters, ...(tools.length ? { tools, tool_choice: toolChoice } : {}) }),
                  signal: controller.signal
                });
                return { ok: response.ok, status: response.status, body: await response.text() };
              } finally {
                clearTimeout(timeout);
                input.signal?.removeEventListener("abort", forwardAbort);
              }
            });
            if (candidate.ok) {
              try {
                return JSON.parse(candidate.body) as CompletionPayload;
              } catch {
                throw new Error(`Chat Completions returned invalid JSON: ${candidate.body.slice(0, 500)}`);
              }
            }
            lastFailure = new Error(`HTTP ${candidate.status}: ${candidate.body.slice(0, 500)}`);
            if (candidate.status !== 429 && candidate.status < 500) {
              retryable = false;
              throw lastFailure;
            }
          } catch (error) {
            lastFailure = error;
            if (input.signal?.aborted) throw error;
            if (!retryable || attempt >= maximumAttempts) throw error;
          }
          if (attempt < maximumAttempts) await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
        }
        throw lastFailure instanceof Error ? lastFailure : new Error("AI request failed after all retries.");
      };
      let payload = await requestCompletion("auto");
      let choice = payload.choices?.[0];
      const executedToolCalls: AgentToolCallResult[] = [];
      let toolRound = 0;
      while (choice?.message?.tool_calls?.length) {
        const toolCalls = choice.message.tool_calls;
        if (executedToolCalls.length + toolCalls.length > MAX_AGENT_TOOL_CALLS) {
          throw new Error(`AI requested more than ${MAX_AGENT_TOOL_CALLS} tool calls in one response cycle.`);
        }
        const normalizedToolCalls = toolCalls.map((toolCall) => ({
          ...toolCall,
          function: {
            ...toolCall.function,
            arguments: typeof toolCall.function.arguments === "string" ? toolCall.function.arguments : JSON.stringify(toolCall.function.arguments ?? {})
          }
        }));
        completionMessages.push({ role: "assistant", content: choice.message.content ?? null, tool_calls: normalizedToolCalls });
        for (const toolCall of toolCalls) {
          const execution = this.executeAgentTool(input.workId, toolCall);
          executedToolCalls.push(execution);
          input.onToolCall?.(execution);
          completionMessages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(execution.result) });
        }
        toolRound += 1;
        const forceFinalAnswer = toolRound >= MAX_AGENT_TOOL_ROUNDS;
        payload = await requestCompletion(forceFinalAnswer ? "none" : "auto");
        choice = payload.choices?.[0];
        if (forceFinalAnswer && choice?.message?.tool_calls?.length) {
          throw new Error(`AI returned tool calls after tool_choice was set to none at the ${MAX_AGENT_TOOL_ROUNDS}-round safety limit.`);
        }
      }
      const content = choice?.message?.content;
      if (!content?.trim()) {
        const reasoningLength = choice?.message?.reasoning_content?.length ?? 0;
        const suffix = choice?.finish_reason === "length" || reasoningLength > 0
          ? `；模型已生成 ${reasoningLength} 个推理字符，请提高 max_tokens 输出预算`
          : "";
        throw new Error(`Chat Completions 响应缺少可用正文，finish_reason=${choice?.finish_reason ?? "unknown"}${suffix}`);
      }
      this.store.db.run(
        "UPDATE ai_calls SET status = 'completed', output_chars = ?, completed_at = ? WHERE id = ?",
        content.length,
        now(),
        callId
      );
      return { callId, content, outputTokens: resolveOutputTokens(payload.usage, content), provider: this.mapProvider(provider), model: this.mapModel(model), context, toolCalls: executedToolCalls };
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 调用失败";
      this.store.db.run("UPDATE ai_calls SET status = 'failed', failure = ?, completed_at = ? WHERE id = ?", message, now(), callId);
      throw new AppError(502, "AI_CALL_FAILED", "AI 调用失败", { callId, failure: message });
    }
  }

  private async generateStream(input: GenerateInput, onDelta: (delta: string) => void): Promise<GenerateResult> {
    const { model, provider } = this.resolveModel(input.workId, input.taskType, input.modelId);
    const context = this.buildContext(input.workId, input.scope, model);
    const preset = safeJsonObject(stringValue(model, "preset_json"));
    const messages = this.buildMessages(input, context);
    const parameters = this.constrainParametersForContext(
      model,
      messages,
      this.sanitizeParameters({ ...preset, ...(input.parameters ?? {}), max_tokens: numberValue(provider, "max_tokens") || DEFAULT_MAX_TOKENS })
    );
    const callId = id("call");
    this.store.db.run(
      `INSERT INTO ai_calls (id, work_id, task_type, provider_id, model_id, context_scope_json, parameters_json,
       status, input_chars, created_at, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      callId,
      input.workId,
      input.taskType,
      stringValue(provider, "id"),
      stringValue(model, "id"),
      JSON.stringify(input.scope),
      JSON.stringify(parameters),
      context.length + input.instruction.length,
      now(),
      currentRequestActor()?.userId ?? null
    );
    try {
      const apiKey = this.decryptKey(provider);
      const endpoint = `${normalizeBaseUrl(stringValue(provider, "base_url"))}/chat/completions`;
      const maximumAttempts = Math.round(clamp(input.maxAttempts ?? 3, 1, 5));
      let streamedResult: { content: string; outputTokens: number } | null = null;
      let lastFailure: unknown = null;
      let emitted = false;
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        try {
          const candidate = await this.scheduleProviderRequest(provider, input.signal, async () => {
            const controller = new AbortController();
            const forwardAbort = (): void => controller.abort(input.signal?.reason);
            if (input.signal?.aborted) forwardAbort();
            else input.signal?.addEventListener("abort", forwardAbort, { once: true });
            const timeout = setTimeout(() => controller.abort(), 60_000);
            try {
              const response = await this.outboundFetch(endpoint, {
                method: "POST",
                headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
                body: JSON.stringify({ model: stringValue(model, "model_id"), messages, ...parameters, stream: true, stream_options: { include_usage: true } }),
                signal: controller.signal
              });
              if (!response.ok) return { ok: false as const, status: response.status, body: await response.text() };
              const streamed = await this.readCompletionStream(response, (delta) => {
                emitted = true;
                onDelta(delta);
              });
              return { ok: true as const, status: response.status, result: streamed };
            } finally {
              clearTimeout(timeout);
              input.signal?.removeEventListener("abort", forwardAbort);
            }
          });
          if (candidate.ok) {
            streamedResult = candidate.result;
            break;
          }
          lastFailure = new Error(`HTTP ${candidate.status}: ${candidate.body.slice(0, 500)}`);
          if (candidate.status !== 429 && candidate.status < 500) attempt = maximumAttempts;
        } catch (error) {
          lastFailure = error;
          if (input.signal?.aborted || emitted || attempt >= maximumAttempts) throw error;
        }
        if (attempt < maximumAttempts) await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
      }
      if (streamedResult === null) throw lastFailure instanceof Error ? lastFailure : new Error("AI 流式请求重试后仍未返回响应");
      const { content, outputTokens } = streamedResult;
      this.store.db.run(
        "UPDATE ai_calls SET status = 'completed', output_chars = ?, completed_at = ? WHERE id = ?",
        content.length,
        now(),
        callId
      );
      return { callId, content, outputTokens, provider: this.mapProvider(provider), model: this.mapModel(model), context, toolCalls: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 流式调用失败";
      this.store.db.run("UPDATE ai_calls SET status = 'failed', failure = ?, completed_at = ? WHERE id = ?", message, now(), callId);
      throw new AppError(502, "AI_CALL_FAILED", "AI 调用失败", { callId, failure: message });
    }
  }

  private async readCompletionStream(response: Response, onDelta: (delta: string) => void): Promise<{ content: string; outputTokens: number }> {
    if (!response.body) throw new Error("Chat Completions 流式响应缺少正文");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason = "unknown";
    let usage: unknown = null;
    const consumeEvent = (eventText: string): void => {
      const data = eventText.split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!data || data === "[DONE]") return;
      const payload = JSON.parse(data) as {
        error?: { message?: string };
        usage?: { completion_tokens?: number; output_tokens?: number };
        choices?: Array<{ finish_reason?: string | null; delta?: { content?: string | null } }>;
      };
      if (payload.error) throw new Error(payload.error.message || "上游流式响应返回错误");
      if (payload.usage) usage = payload.usage;
      const choice = payload.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        content += delta;
        onDelta(delta);
      }
    };
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const events = buffer.split(/\r?\n\r?\n/u);
      buffer = events.pop() ?? "";
      for (const eventText of events) consumeEvent(eventText);
      if (chunk.done) break;
    }
    if (buffer.trim()) consumeEvent(buffer);
    if (!content.trim()) throw new Error(`Chat Completions 流式响应缺少可用正文，finish_reason=${finishReason}`);
    return { content, outputTokens: resolveOutputTokens(usage, content) };
  }

  private async runChapterAnalysis(workId: string, scope: ContextScope, modelId?: string, taskId?: string): Promise<Record<string, unknown>> {
    if (!scope.chapterId) throw new AppError(400, "CHAPTER_REQUIRED", "章节分析必须指定章节");
    const chapter = this.store.getChapter(scope.chapterId);
    const generated = await this.generate({
      workId,
      taskType: "chapter-analysis",
      signal: this.taskSignal(taskId),
      instruction: "分析本章并只输出 JSON 对象，字段为 summary（1至3句）、events（数组）、characters（数组）、settings（数组）、evidence（数组，每项含 conclusion 和 quote）、uncertainties（数组）。不得使用 Markdown 代码块。",
      scope,
      ...(modelId ? { modelId } : {}),
      extraSystemPrompt: "本任务要求严格输出可解析的 JSON。"
    });
    const data = extractJson<{
      summary?: string;
      events?: unknown[];
      characters?: unknown[];
      settings?: unknown[];
      evidence?: unknown[];
      uncertainties?: unknown[];
    }>(generated.content);
    if (!this.taskCanCommit(taskId)) return { interrupted: true, callId: generated.callId };
    const insightId = id("insight");
    this.store.db.run(
      `INSERT INTO chapter_insights (id, chapter_id, chapter_version, summary, events_json, characters_json,
       settings_json, evidence_json, uncertainties_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'review', ?)`,
      insightId,
      String(chapter.id),
      Number(chapter.versionNo),
      data.summary ?? "",
      JSON.stringify(data.events ?? []),
      JSON.stringify(data.characters ?? []),
      JSON.stringify(data.settings ?? []),
      JSON.stringify(data.evidence ?? []),
      JSON.stringify(data.uncertainties ?? []),
      now()
    );
    this.store.db.run("UPDATE chapters SET analysis_status = 'review' WHERE id = ?", String(chapter.id));
    return { insightId, chapterId: chapter.id, chapterVersion: chapter.versionNo, callId: generated.callId, ...data };
  }

  private async runTimelineAnalysis(workId: string, scope: ContextScope, modelId?: string, taskId?: string): Promise<Record<string, unknown>> {
    const generated = await this.generate({
      workId,
      taskType: "timeline-analysis",
      signal: this.taskSignal(taskId),
      instruction: "抽取大事件候选并只输出 JSON 数组。每项字段：name、description、eventType、timeLabel、timeSort（无法确定为 null）、location、impactScope、chapterIds、participantIds、evidence。必须区分发生时间与叙述时间；不确定时使用‘时间待定’。不得使用 Markdown 代码块。",
      scope,
      ...(modelId ? { modelId } : {}),
      extraSystemPrompt: "本任务要求严格输出可解析的 JSON。仅生成候选，不得声称已确认。"
    });
    const events = extractJson<Array<Record<string, unknown>>>(generated.content);
    if (!Array.isArray(events)) throw new AppError(502, "AI_INVALID_JSON", "时间轴分析结果必须是数组");
    if (!this.taskCanCommit(taskId)) return { interrupted: true, callId: generated.callId };
    const eventIds: string[] = [];
    for (const event of events) {
      if (typeof event.name !== "string" || !event.name.trim()) continue;
      const created = this.store.createTimelineEvent(workId, {
        name: event.name,
        description: typeof event.description === "string" ? event.description : "",
        eventType: typeof event.eventType === "string" ? event.eventType : "other",
        timeLabel: typeof event.timeLabel === "string" ? event.timeLabel : "时间待定",
        timeSort: typeof event.timeSort === "number" ? event.timeSort : null,
        chapterIds: Array.isArray(event.chapterIds) ? event.chapterIds.filter((value): value is string => typeof value === "string") : [],
        participantIds: Array.isArray(event.participantIds) ? event.participantIds.filter((value): value is string => typeof value === "string") : [],
        location: typeof event.location === "string" ? event.location : "",
        impactScope: typeof event.impactScope === "string" ? event.impactScope : "personal",
        evidence: Array.isArray(event.evidence) ? event.evidence : [],
        status: "candidate"
      }, "analysis", taskId ?? generated.callId);
      eventIds.push(String(created.id));
    }
    return { eventIds, candidateCount: eventIds.length, callId: generated.callId };
  }

  private async runConsistencyCheck(workId: string, scope: ContextScope, modelId?: string, taskId?: string): Promise<Record<string, unknown>> {
    const generated = await this.generate({
      workId,
      taskType: "consistency-check",
      signal: this.taskSignal(taskId),
      instruction: "检查设定、人物状态、关系和时间是否冲突，只输出 JSON 数组。每项字段：itemType、severity（low/medium/high）、title、description、entityRefs、evidence、suggestion。没有问题时输出 []。不得使用 Markdown 代码块。",
      scope,
      ...(modelId ? { modelId } : {}),
      extraSystemPrompt: "本任务要求严格输出可解析的 JSON。"
    });
    const issues = extractJson<Array<Record<string, unknown>>>(generated.content);
    if (!Array.isArray(issues)) throw new AppError(502, "AI_INVALID_JSON", "一致性检查结果必须是数组");
    if (!this.taskCanCommit(taskId)) return { interrupted: true, callId: generated.callId };
    const reviewIds: string[] = [];
    for (const issue of issues) {
      if (typeof issue.title !== "string" || !issue.title.trim()) continue;
      const review = this.store.createReviewItem(workId, {
        itemType: typeof issue.itemType === "string" ? issue.itemType : "consistency",
        severity: typeof issue.severity === "string" ? issue.severity : "medium",
        title: issue.title,
        description: typeof issue.description === "string" ? issue.description : "",
        entityRefs: Array.isArray(issue.entityRefs) ? issue.entityRefs : [],
        evidence: Array.isArray(issue.evidence) ? issue.evidence : [],
        suggestion: typeof issue.suggestion === "string" ? issue.suggestion : ""
      });
      reviewIds.push(String(review.id));
    }
    return { reviewIds, issueCount: reviewIds.length, callId: generated.callId };
  }

  private async runCharacterExtraction(workId: string, scope: ContextScope, modelId?: string, taskId?: string): Promise<Record<string, unknown>> {
    const chapters = this.getScopeChapters(workId, scope);
    if (chapters.length === 0) throw new AppError(409, "CHAPTERS_REQUIRED", "人物抽取范围内没有章节");
    const chunks = this.buildChapterChunks(chapters, 10_000);
    const concurrency = this.configuredConcurrency(workId, "book-analysis", modelId);
    const rawCandidates: Array<Record<string, unknown>> = [];
    const callIds: string[] = [];
    const extractChunk = async (text: string, maxAttempts = 3): Promise<{ candidates: Array<Record<string, unknown>>; callId: string }> => {
      const generated = await this.generate({
        workId,
        taskType: "book-analysis",
        signal: this.taskSignal(taskId),
        maxAttempts,
        scope: { type: "selection", selection: text },
        ...(modelId ? { modelId } : {}),
        parameters: { temperature: 0.2 },
        instruction: [
          "抽取本批原文中有名字且对跨章节剧情有意义的人物或具有人格的生物。只输出 JSON 数组。",
          "每项字段：canonicalName、aliases（仅无歧义昵称或拼写变体）、species（仅原文明确说明时填写）、identity、firstEvidence（chapterId、chapterTitle、quote）。",
          "规则：合并明显拼写变体；不能把怪兽之王、怪兽女王、君王、女王、吾王、博士、舰长、上尉、司令、族长、老师、父亲、母亲、哥哥、姐姐等称号作为全局别名；不能把单字母简称作为别名；梦境或作品内虚构角色需在 identity 标明；不得创造人物；quote 必须是原文连续引文且不超过 80 字。",
          "没有合格人物时输出 []，不得使用 Markdown 代码块。"
        ].join("\n"),
        extraSystemPrompt: [
          "你是严格的人物规范化抽取器。相似名字不能凭空合并。",
          "必须区分：真酱与真姬；魔斯拉与魔蛇；基多拉、银月基多拉、奥尔森与真姬；伊比拉与达哥拉；安吉拉斯与安胡卢克；陈伊琳、陈玲、陈欣、陈芳、陈雅丽与陈妍菲。",
          "明确拼写变体应合并：安吉拉斯/安基拉斯/安加拉斯，伊莉丝/伊莉斯，伊莎贝拉/伊萨贝拉，卡玛佐兹/卡玛左滋/卡玛卓兹/卡玛佐治。",
          "奥卡编号、月柔、加隆、雅典娜和小塞是不同 AI 实例，不能仅因共享奥卡或 AI 称谓而合并。"
        ].join("\n")
      });
      const extracted = extractJson<unknown>(generated.content);
      if (!Array.isArray(extracted)) throw new AppError(502, "AI_INVALID_JSON", "人物抽取结果必须是数组");
      return {
        candidates: extracted.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)),
        callId: generated.callId
      };
    };
    const chunkResults = await this.processChunks(chunks, concurrency, async (chunk) => {
      if (taskId && this.store.getTask(taskId).status !== "running") {
        return { candidates: [], callIds: [], fallbackSegmentCount: 0, policyOmittedSegmentCount: 0 };
      }
      try {
        const extracted = await extractChunk(chunk.text, 1);
        return { candidates: extracted.candidates, callIds: [extracted.callId], fallbackSegmentCount: 0, policyOmittedSegmentCount: 0 };
      } catch {
        const segments = this.splitMarkedChapters(chunk.text);
        return this.runChapterSegmentFallback(
          segments,
          taskId,
          extractChunk,
          (segment) => this.localCharacterFallback(workId, segment),
          concurrency
        );
      }
    }, (completed) => {
      if (taskId && this.store.getTask(taskId).status === "running") {
        this.store.updateTask(taskId, { status: "running", progress: Math.min(92, 5 + Math.round(completed / chunks.length * 87)) });
      }
    });
    let fallbackSegmentCount = 0;
    let policyOmittedSegmentCount = 0;
    for (const result of chunkResults) {
      rawCandidates.push(...result.candidates);
      callIds.push(...result.callIds);
      fallbackSegmentCount += result.fallbackSegmentCount;
      policyOmittedSegmentCount += result.policyOmittedSegmentCount;
    }
    if (!this.taskCanCommit(taskId)) return { interrupted: true, callIds };

    const byChapterId = new Map(chapters.map((chapter) => [String(chapter.id), chapter]));
    const groups: Array<{ name: string; aliases: Set<string>; species: string; identity: string; firstChapterId: string | null; references: Set<string> }> = [];
    for (const candidate of rawCandidates) {
      if (typeof candidate.canonicalName !== "string" || !candidate.canonicalName.trim()) continue;
      const name = candidate.canonicalName.normalize("NFKC").trim();
      const aliases = (Array.isArray(candidate.aliases) ? candidate.aliases : [])
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.normalize("NFKC").trim())
        .filter((value) => value && this.isSafeGlobalAlias(value));
      const evidence = candidate.firstEvidence && typeof candidate.firstEvidence === "object" && !Array.isArray(candidate.firstEvidence)
        ? candidate.firstEvidence as Record<string, unknown>
        : null;
      const chapterId = evidence && typeof evidence.chapterId === "string" ? evidence.chapterId : null;
      const quote = evidence && typeof evidence.quote === "string" ? evidence.quote.trim() : "";
      if (!chapterId || !quote || quote.length > 80 || !byChapterId.has(chapterId)
        || !this.quoteExists(String(byChapterId.get(chapterId)?.content ?? ""), quote)) continue;
      const refs = new Set([name, ...aliases].map((value) => this.normalizeReference(value)));
      const matches = groups.filter((group) => [...refs].some((value) => group.references.has(value)));
      const group = matches[0] ?? {
        name,
        aliases: new Set<string>(),
        species: typeof candidate.species === "string" ? candidate.species.trim() : "",
        identity: typeof candidate.identity === "string" ? candidate.identity : "",
        firstChapterId: chapterId,
        references: new Set<string>()
      };
      if (!matches.length) groups.push(group);
      for (const value of refs) group.references.add(value);
      for (const alias of aliases) if (this.normalizeReference(alias) !== this.normalizeReference(group.name)) group.aliases.add(alias);
      if (!group.identity && typeof candidate.identity === "string") group.identity = candidate.identity;
      if (!group.species && typeof candidate.species === "string") group.species = candidate.species.trim();
      if (!group.firstChapterId && chapterId) group.firstChapterId = chapterId;
      for (const duplicate of matches.slice(1)) {
        for (const alias of [duplicate.name, ...duplicate.aliases]) {
          if (this.normalizeReference(alias) !== this.normalizeReference(group.name) && this.isSafeGlobalAlias(alias)) group.aliases.add(alias);
        }
        for (const value of duplicate.references) group.references.add(value);
        const duplicateIndex = groups.indexOf(duplicate);
        if (duplicateIndex >= 0) groups.splice(duplicateIndex, 1);
      }
    }

    const characterIds: string[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const group of groups) {
      const aliases = [...group.aliases].filter((alias) => this.isSafeGlobalAlias(alias));
      const extractedRaceId = group.species ? this.store.resolveRaceReference(workId, group.species) : null;
      const existingId = [group.name, ...aliases]
        .map((value) => this.store.resolveCharacterReference(workId, value))
        .find((value): value is string => Boolean(value));
      try {
        if (existingId) {
          const existing = this.store.getCharacter(existingId);
          const mergedAliases = [...new Set([...(existing.aliases as string[]), ...aliases])]
            .filter((alias) => this.isSafeGlobalAlias(alias) && this.normalizeReference(alias) !== this.normalizeReference(String(existing.name)));
          const updated = this.store.updateCharacter(existingId, {
            aliases: mergedAliases,
            raceId: (existing.raceId as string | null) ?? extractedRaceId,
            attributes: { ...(existing.attributes as Record<string, unknown>), ...(group.identity ? { identity: group.identity } : {}) },
            firstChapterId: existing.firstChapterId as string | null ?? group.firstChapterId
          });
          characterIds.push(String(updated.id));
        } else {
          const created = this.store.createCharacter(workId, {
            name: group.name,
            aliases,
            raceId: extractedRaceId,
            attributes: group.identity ? { identity: group.identity } : {},
            firstChapterId: group.firstChapterId
          });
          characterIds.push(String(created.id));
        }
      } catch (error) {
        skipped.push({ name: group.name, reason: error instanceof Error ? error.message : "名称冲突" });
      }
    }
    return {
      characterIds: [...new Set(characterIds)],
      candidateCount: groups.length,
      savedCount: new Set(characterIds).size,
      skipped,
      batchCount: chunks.length,
      coveredChapterCount: chapters.length,
      fallbackSegmentCount,
      policyOmittedSegmentCount,
      callIds
    };
  }

  private async runRelationshipAnalysis(workId: string, scope: ContextScope, modelId?: string, taskId?: string): Promise<Record<string, unknown>> {
    const characters = this.store.listCharacters(workId);
    if (characters.length < 2) throw new AppError(409, "CHARACTERS_REQUIRED", "人物关系分析至少需要两个角色档案");
    const chapters = this.getScopeChapters(workId, scope);
    if (chapters.length === 0) throw new AppError(409, "CHAPTERS_REQUIRED", "人物关系分析范围内没有章节");
    const chunks = this.buildChapterChunks(chapters, 12_000);
    const concurrency = this.configuredConcurrency(workId, "relationship-analysis", modelId);
    const roster = characters.map((character) => {
      const aliases = (character.aliases as string[]).filter((alias) => this.isSafeGlobalAlias(alias));
      return `${String(character.id)} | ${String(character.name)}${aliases.length ? ` | 别名：${aliases.join("、")}` : ""}`;
    }).join("\n");
    const rawCandidates: Array<Record<string, unknown>> = [];
    const callIds: string[] = [];
    const extractChunk = async (text: string, maxAttempts = 3): Promise<{ candidates: Array<Record<string, unknown>>; callId: string }> => {
      const generated = await this.generate({
        workId,
        taskType: "relationship-analysis",
        signal: this.taskSignal(taskId),
        maxAttempts,
        scope: { type: "selection", selection: text },
        ...(modelId ? { modelId } : {}),
        parameters: { temperature: 0.1 },
        instruction: [
          "你是小说人物关系抽取器，不是续写者。只抽取角色规范表中人物之间、对跨章节人物图有长期意义且有原文证据的关系。",
          "角色规范表：",
          roster,
          "硬规则：",
          "1. 人名、别名、昵称和拼写变体必须归一到唯一 characterId，禁止创造角色或把相似名字强行合并。",
          "2. 单次见面、同场出现、对话、传话、约定或共同目睹事件本身不是长期人物关系，没有长期意义时不要输出。",
          "3. 区分现实当前、真实历史、回忆/第三方陈述、梦境/平行可能、假设、媒体作品和作者注释。梦境、假设或替代人生不能改变现实关系状态。",
          "3.1 标记为‘作者的话’的章节默认不会进入自动分析；若原文片段仍包含序言、后记、作者注或现实创作说明，其中的人名和关系也不得写入小说人物图。",
          "4. 父母→子女、君王→臣属、导师→学生、施害者→受害者、倾慕者→被倾慕者使用 directed=true；伴侣、朋友、兄弟姐妹、盟友、互为宿敌使用 directed=false。",
          "5. 同一人物对、同一 category、同一 subtype 只输出一次；不得输出反向重复边。",
          "6. currentStatus 表示本批正文结束时的状态；阶段变化写入 timeRange.stages。",
          "7. 每条 evidence 必须同时提供 chapterId、chapterTitle、quote、contextType、supports。quote 必须是原文连续短引文且不超过 80 字。",
          "8. 明示事实可用一条直接证据；confidence>=0.8 原则上需强直接证据，只有共现或含糊代词时不要输出。",
          "9. confidence 低于 0.6 不输出。uncertain 仅用于原文明示关系未知且对剧情重要的情况，不能用来填充证据不足的组合。",
          "10. subtype 必须使用简短中文稳定词：父母子女、收养亲子、手足、叔侄、君臣、师生、同事、盟友、朋友、伴侣、倾慕、亲密羁绊、宿敌、施害与受害、操纵与被操纵；确有其他关系时才新增中文词，禁止英文、下划线和近义重复。父母子女/收养亲子/手足/叔侄只能属于 family；君臣/师生/同事/盟友/朋友只能属于 social；伴侣/倾慕/亲密羁绊只能属于 emotional；宿敌/施害与受害/操纵与被操纵只能属于 conflict。",
          "11. 君臣关系必须 from=君王、to=臣属；父母子女必须 from=父母、to=子女；倾慕必须 from=倾慕者、to=被倾慕者。一次下令或一次服从不能单独证明长期君臣。",
          "12. 同一人物对若已有伴侣，不再另报朋友、亲密羁绊或相互倾慕；已有宿敌，不再另报敌人或竞争者。只保留语义最强的长期边，并把阶段变化合并到 timeRange.stages。",
          "13. 组织、阵营或国家之间的盟约不能投射成代表个人之间的盟友；某人替组织传话、执行任务或参与同一行动，也不能据此建立个人长期关系。",
          "14. evidence 的引文和 supports 必须能共同识别关系双方及关系类型；仅有一方名字、模糊代词或旁人泛称时不要输出。",
          "15. keywords 必须是 2 至 8 个简短中文关键词，描述这两个人之间具体的互动方式、权力结构、情感阶段或剧情张力，例如共同守护、长期信任、王权效忠、单向追求、决裂后和解；不能只重复 subtype。",
          "16. 血亲关系必须有明确亲属称谓、出生或收养证据；年龄差、同族、救援幼崽、照护后辈都不能推断为父子、叔侄或手足。",
          "17. 君臣关系必须同时出现明确权力身份与效忠、听命、下令或服从行为；仅称呼‘君王/女王’、表现敬畏、属于同一族群或接受帮助都不构成君臣，也不能给每个具名族民批量建立君臣边。",
          "18. 宿敌必须有跨两个不同章节/时期的持续冲突证据，或原文直接使用宿敌、世仇、长期威胁等表述；单场危机只能使用战时敌对、围攻与反击、追杀与反击等准确 subtype。",
          "19. 严格核对对话说话人、提问者和回答中的主语。不能把回答者的行为归给提问者，不能因某人被类比、被提及、出现在角色规范表或既有关系上下文中就生成新边。",
          "20. 前任向继任者让位属于前任与继任，不是继任者统御前任；方向必须由原文中的权力交接和实际服从行为共同决定。",
          "21. 关键词只能描述双方互动，不得混入任何一方单独的基因改造、意识变化、物种背景或未参与本关系的事件，也不得把不同时间阶段压成互相矛盾的同一组关键词。",
          "22. 集合身份、分身或内部意识不能当作额外人物扩散关系。若银月基多拉等聚合角色已代表内部意识与外部对象的整体关系，不得再把同一任务协作复制成每个内部意识与该对象的多条边；别名更不能彼此建边。",
          "23. 只输出 JSON 数组。字段：fromCharacterId、toCharacterId、category（family/social/emotional/conflict/uncertain）、subtype、keywords、directed、currentStatus、timeRange、confidence、evidence。不得使用 Markdown。",
          "24. 共同执行一次任务、同属一个组织、在同一集体场景中被感谢或落泪、替第三人转发消息，都不能单独证明同事、朋友或盟友。此类关系必须有原文明示身份，或至少两个不同章节的持续互动证据。"
        ].join("\n"),
        extraSystemPrompt: "关系候选必须可审计。严禁把梦境伴侣、醉后梦话、单次约定、同章共现、礼称、同族归属、救援照护或类比提及写成现实长期关系。逐句校验说话人和关系方向。"
      });
      const extracted = extractJson<unknown>(generated.content);
      if (!Array.isArray(extracted)) throw new AppError(502, "AI_INVALID_JSON", "人物关系分析结果必须是数组");
      return {
        candidates: extracted.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)),
        callId: generated.callId
      };
    };
    const chunkResults = await this.processChunks(chunks, concurrency, async (chunk) => {
      if (taskId && this.store.getTask(taskId).status !== "running") {
        return { candidates: [], callIds: [], fallbackSegmentCount: 0, policyOmittedSegmentCount: 0 };
      }
      try {
        const extracted = await extractChunk(chunk.text, 1);
        return { candidates: extracted.candidates, callIds: [extracted.callId], fallbackSegmentCount: 0, policyOmittedSegmentCount: 0 };
      } catch {
        const segments = this.splitMarkedChapters(chunk.text);
        return this.runChapterSegmentFallback(segments, taskId, extractChunk, undefined, concurrency);
      }
    }, (completed) => {
      if (taskId && this.store.getTask(taskId).status === "running") {
        this.store.updateTask(taskId, { status: "running", progress: Math.min(92, 5 + Math.round(completed / chunks.length * 87)) });
      }
    });
    let fallbackSegmentCount = 0;
    let policyOmittedSegmentCount = 0;
    for (const result of chunkResults) {
      rawCandidates.push(...result.candidates);
      callIds.push(...result.callIds);
      fallbackSegmentCount += result.fallbackSegmentCount;
      policyOmittedSegmentCount += result.policyOmittedSegmentCount;
    }
    if (!this.taskCanCommit(taskId)) return { interrupted: true, callIds };
    if (fallbackSegmentCount > 0 || callIds.length === 0) {
      throw new AppError(502, "RELATIONSHIP_ANALYSIS_INCOMPLETE", "人物关系分析存在未完成批次，已保留原有关系，请重试", {
        fallbackSegmentCount,
        policyOmittedSegmentCount,
        successfulCallCount: callIds.length,
        batchCount: chunks.length
      });
    }

    const chapterById = new Map(chapters.map((chapter) => [String(chapter.id), chapter]));
    const categories = new Set(["family", "social", "emotional", "conflict", "uncertain"]);
    const merged = new Map<string, {
      fromCharacterId: string;
      toCharacterId: string;
      category: string;
      subtype: string;
      keywords: string[];
      directed: boolean;
      currentStatus: string;
      timeRange: Record<string, unknown>;
      confidence: number;
      evidence: Array<Record<string, unknown>>;
    }>();
    const skipped: Array<{ index: number; reason: string }> = [];
    rawCandidates.forEach((candidate, index) => {
      const fromRaw = candidate.fromCharacterId ?? candidate.fromCharacter;
      const toRaw = candidate.toCharacterId ?? candidate.toCharacter;
      const fromResolved = typeof fromRaw === "string"
        ? (characters.some((character) => character.id === fromRaw) ? fromRaw : this.store.resolveCharacterReference(workId, fromRaw))
        : null;
      const toResolved = typeof toRaw === "string"
        ? (characters.some((character) => character.id === toRaw) ? toRaw : this.store.resolveCharacterReference(workId, toRaw))
        : null;
      if (!fromResolved || !toResolved || fromResolved === toResolved) {
        skipped.push({ index, reason: "人物引用无效" });
        return;
      }
      if (typeof candidate.category !== "string" || !categories.has(candidate.category)) {
        skipped.push({ index, reason: "关系分类无效" });
        return;
      }
      const reportedCategory = candidate.category;
      const rawSubtype = typeof candidate.subtype === "string" ? candidate.subtype.trim() : "";
      if (!rawSubtype) {
        skipped.push({ index, reason: "缺少长期关系子类" });
        return;
      }
      const category = canonicalizeRelationshipCategory(reportedCategory, rawSubtype);
      let subtype = canonicalizeRelationshipSubtype(category, rawSubtype);
      const currentStatus = typeof candidate.currentStatus === "string" ? candidate.currentStatus.trim() : "active";
      const keywords = this.normalizeRelationshipKeywords(candidate.keywords, subtype);
      const confidence = typeof candidate.confidence === "number" ? clamp(candidate.confidence, 0, 1) : 0;
      if (confidence < 0.6) {
        skipped.push({ index, reason: "置信度低于 0.6" });
        return;
      }
      const directed = candidate.directed === true;
      let fromCharacterId = fromResolved;
      let toCharacterId = toResolved;
      if (directed && reversesHierarchyDirection(rawSubtype)) [fromCharacterId, toCharacterId] = [toCharacterId, fromCharacterId];
      if (!directed && fromCharacterId.localeCompare(toCharacterId) > 0) [fromCharacterId, toCharacterId] = [toCharacterId, fromCharacterId];
      const evidence = (Array.isArray(candidate.evidence) ? candidate.evidence : [])
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        .filter((item) => {
          if (typeof item.chapterId !== "string" || typeof item.quote !== "string" || item.quote.trim().length > 80) return false;
          const chapter = chapterById.get(item.chapterId);
          return Boolean(chapter && this.quoteExists(String(chapter.content), item.quote));
        })
        .map((item) => ({
          chapterId: item.chapterId,
          chapterTitle: String(chapterById.get(String(item.chapterId))?.title ?? ""),
          quote: String(item.quote).trim(),
          contextType: typeof item.contextType === "string" ? item.contextType : "current",
          supports: typeof item.supports === "string" ? item.supports : ""
        }));
      if (evidence.length === 0) {
        skipped.push({ index, reason: "证据引文未在对应章节原文命中" });
        return;
      }
      const evidenceText = evidence.map((item) => String(item.quote)).join("\n");
      if (category === "family" && ["父母子女", "收养亲子", "手足", "叔侄"].includes(subtype)) {
        const explicitKinship = /父亲|母亲|爸爸|妈妈|父子|父女|母子|母女|儿子|女儿|孩子|亲生|收养|养父|养母|养子|养女|兄弟|姐妹|哥哥|弟弟|姐姐|妹妹|手足|叔叔|叔父|侄|姑姑|舅舅|外甥/u.test(evidenceText);
        if (!explicitKinship) {
          skipped.push({ index, reason: "血亲关系缺少明确亲属称谓、出生或收养证据" });
          return;
        }
      }
      if (category === "social" && subtype === "君臣") {
        const hasAuthority = /君王|女王|国王|陛下|领主|统治者|首领/u.test(evidenceText);
        const hasObedience = /效忠|臣属|臣服|服从|听命|领命|奉命|遵命|命令|下令|宣誓|跪拜|麾下|部下|属下/u.test(evidenceText);
        if (!hasAuthority || !hasObedience) {
          skipped.push({ index, reason: "君臣关系缺少权力身份与效忠、命令或服从的双重证据" });
          return;
        }
      }
      if (category === "conflict" && subtype === "宿敌") {
        const evidenceChapters = new Set(evidence.map((item) => String(item.chapterId)));
        const explicitlyLongRunning = /宿敌|世仇|死敌|多年|长期|世代|一直.{0,24}(?:敌|威胁|对抗|杀手)|远古.{0,16}(?:战|敌)|多次.{0,16}(?:交战|对抗|冲突)/u.test(evidenceText);
        if (evidenceChapters.size < 2 && !explicitlyLongRunning) subtype = "战时敌对";
      }
      const key = [fromCharacterId, toCharacterId, category, this.normalizeReference(subtype), directed ? "1" : "0"].join("|");
      const current = merged.get(key);
      if (current) {
        current.confidence = Math.max(current.confidence, confidence);
        current.currentStatus = currentStatus || current.currentStatus;
        current.keywords = [...new Set([...current.keywords, ...keywords])].slice(0, 8);
        const seenEvidence = new Set(current.evidence.map((item) => `${String(item.chapterId)}|${String(item.quote)}`));
        for (const item of evidence) {
          const evidenceKey = `${String(item.chapterId)}|${String(item.quote)}`;
          if (!seenEvidence.has(evidenceKey)) current.evidence.push(item);
        }
        return;
      }
      merged.set(key, {
        fromCharacterId,
        toCharacterId,
        category,
        subtype,
        keywords,
        directed,
        currentStatus,
        timeRange: candidate.timeRange && typeof candidate.timeRange === "object" && !Array.isArray(candidate.timeRange)
          ? candidate.timeRange as Record<string, unknown>
          : {},
        confidence,
        evidence
      });
    });

    for (const [key, candidate] of merged) {
      const durablePeerSubtype = /同事|同僚|共事|搭档|伙伴|朋友|好友|挚友|老友|旧友|战友|盟友|同盟|联盟/u.test(candidate.subtype);
      if (candidate.category !== "social" || !durablePeerSubtype) continue;
      const evidenceChapters = new Set(candidate.evidence.map((item) => String(item.chapterId)));
      const evidenceText = candidate.evidence.map((item) => String(item.quote)).join("\n");
      const explicitlyLongRunning = /同事|同僚|共事|搭档|伙伴|朋友|好友|挚友|老友|旧友|老朋友|战友|盟友|同盟|联盟|结盟|缔盟|盟约|旧识|好久不见|多年|长期|几十年|经常|往日|一直.{0,16}(?:合作|支援|互助|并肩)/u.test(evidenceText);
      if (evidenceChapters.size >= 2 || explicitlyLongRunning) continue;
      skipped.push({ index: -1, reason: `“${candidate.subtype}”缺少明确身份或跨章长期互动证据` });
      merged.delete(key);
    }

    const relationshipIds: string[] = [];
    this.store.db.transaction(() => {
      if (scope.type === "book") {
        this.store.db.run(
          "DELETE FROM relationships WHERE work_id = ? AND confirmation_status = 'pending' AND locked = 0",
          workId
        );
      }
      const existing = this.store.listRelationships(workId).filter((relationship) => relationship.confirmationStatus !== "rejected");
      const unorderedPairKey = (fromCharacterId: unknown, toCharacterId: unknown): string => {
        const pair = [String(fromCharacterId), String(toCharacterId)].sort((left, right) => left.localeCompare(right));
        return `${pair[0]}|${pair[1]}`;
      };
      const relationshipHasEnded = (relationship: Record<string, unknown>): boolean => {
        const status = String(relationship.currentStatus ?? "").trim();
        if (/未结束|尚未结束|没有结束|未终止|尚未终止|没有终止|未死亡|尚未死亡|没有死亡|\bnot\s+(?:ended|completed|dead|deceased)\b|\bstill\s+alive\b/iu.test(status)) return false;
        if (/已结束|关系结束|已终止|关系终止|已死|死亡|去世|离世|至死亡/iu.test(status)) return true;
        if (/\b(?:active|ongoing|reconciled|established|stable)\b|仍在|持续|现阶段|当前/iu.test(status)) return false;
        if (/\b(?:ended|completed|historical|deceased|dead)\b/iu.test(status)) return true;
        return /历史关系|曾经在一起/iu.test(status);
      };
      const allCandidates = [...existing, ...merged.values()];
      const endedPartnerPairs = new Set(allCandidates
        .filter((relationship) => relationshipHasEnded(relationship)
          && relationship.category === "emotional"
          && canonicalizeRelationshipSubtype("emotional", String(relationship.subtype)) === "伴侣")
        .map((relationship) => unorderedPairKey(relationship.fromCharacterId, relationship.toCharacterId)));
      const currentPartnerPairs = new Set(allCandidates
        .filter((relationship) => !relationshipHasEnded(relationship)
          && relationship.category === "emotional"
          && canonicalizeRelationshipSubtype("emotional", String(relationship.subtype)) === "伴侣")
        .map((relationship) => unorderedPairKey(relationship.fromCharacterId, relationship.toCharacterId)));
      const endedEnemyPairs = new Set(allCandidates
        .filter((relationship) => relationshipHasEnded(relationship)
          && relationship.category === "conflict"
          && canonicalizeRelationshipSubtype("conflict", String(relationship.subtype)) === "宿敌")
        .map((relationship) => unorderedPairKey(relationship.fromCharacterId, relationship.toCharacterId)));
      const currentEnemyPairs = new Set(allCandidates
        .filter((relationship) => !relationshipHasEnded(relationship)
          && relationship.category === "conflict"
          && canonicalizeRelationshipSubtype("conflict", String(relationship.subtype)) === "宿敌")
        .map((relationship) => unorderedPairKey(relationship.fromCharacterId, relationship.toCharacterId)));
      const endedFamilyLikePairs = new Set(allCandidates
        .filter((relationship) => {
          if (!relationshipHasEnded(relationship)) return false;
          const subtype = canonicalizeRelationshipSubtype(String(relationship.category), String(relationship.subtype));
          return relationship.category === "family" || /父母|亲子|手足|兄弟|姐妹|姐弟|叔侄|监护/u.test(subtype);
        })
        .map((relationship) => unorderedPairKey(relationship.fromCharacterId, relationship.toCharacterId)));
      const currentFamilyLikePairs = new Set(allCandidates
        .filter((relationship) => {
          if (relationshipHasEnded(relationship)) return false;
          const subtype = canonicalizeRelationshipSubtype(String(relationship.category), String(relationship.subtype));
          return relationship.category === "family" || /父母|亲子|手足|兄弟|姐妹|姐弟|叔侄|监护/u.test(subtype);
        })
        .map((relationship) => unorderedPairKey(relationship.fromCharacterId, relationship.toCharacterId)));
      const peerSocialStrength = (relationship: Record<string, unknown>): number => {
        if (relationship.category !== "social") return 0;
        const subtype = canonicalizeRelationshipSubtype("social", String(relationship.subtype));
        if (/盟友|挚友/u.test(subtype)) return 3;
        if (/朋友|战友|搭档|合作伙伴/u.test(subtype)) return 2;
        if (/同事|同僚|共事/u.test(subtype)) return 1;
        return 0;
      };
      const strongestEndedPeerSocialByPair = new Map<string, number>();
      const strongestCurrentPeerSocialByPair = new Map<string, number>();
      for (const relationship of allCandidates) {
        const pair = unorderedPairKey(relationship.fromCharacterId, relationship.toCharacterId);
        if (relationshipHasEnded(relationship)) {
          strongestEndedPeerSocialByPair.set(pair, Math.max(strongestEndedPeerSocialByPair.get(pair) ?? 0, peerSocialStrength(relationship)));
        } else {
          strongestCurrentPeerSocialByPair.set(pair, Math.max(strongestCurrentPeerSocialByPair.get(pair) ?? 0, peerSocialStrength(relationship)));
        }
      }
      for (const candidate of merged.values()) {
        const candidatePair = unorderedPairKey(candidate.fromCharacterId, candidate.toCharacterId);
        const candidateEnded = relationshipHasEnded(candidate);
        const relevantPartnerPairs = candidateEnded ? endedPartnerPairs : currentPartnerPairs;
        const relevantEnemyPairs = candidateEnded ? endedEnemyPairs : currentEnemyPairs;
        const relevantFamilyLikePairs = candidateEnded ? endedFamilyLikePairs : currentFamilyLikePairs;
        const relevantPeerStrength = candidateEnded ? strongestEndedPeerSocialByPair : strongestCurrentPeerSocialByPair;
        const weakerThanPartner = (candidate.category === "emotional" && ["倾慕", "亲密羁绊"].includes(candidate.subtype))
          || (candidate.category === "social" && candidate.subtype === "朋友");
        if (weakerThanPartner && relevantPartnerPairs.has(candidatePair)) {
          skipped.push({ index: -1, reason: `已有伴侣关系，忽略较弱的“${candidate.subtype}”重复边` });
          continue;
        }
        const weakerEncounterConflict = ["施害与受害", "战时敌对", "围攻与反击", "追杀与反击", "单次交锋"].includes(candidate.subtype);
        if (candidate.category === "conflict" && weakerEncounterConflict && relevantEnemyPairs.has(candidatePair)) {
          skipped.push({ index: -1, reason: `已有宿敌关系，忽略较弱的“${candidate.subtype}”重复边` });
          continue;
        }
        const weakerThanFamilyLike = (candidate.category === "emotional" && candidate.subtype === "亲密羁绊")
          || (candidate.category === "social" && ["同事", "朋友"].includes(candidate.subtype));
        if (weakerThanFamilyLike && relevantFamilyLikePairs.has(candidatePair)) {
          skipped.push({ index: -1, reason: `已有亲属或监护关系，忽略较弱的“${candidate.subtype}”重复边` });
          continue;
        }
        const candidatePeerStrength = peerSocialStrength(candidate);
        if (candidatePeerStrength > 0 && (relevantPeerStrength.get(candidatePair) ?? 0) > candidatePeerStrength) {
          skipped.push({ index: -1, reason: `已有更强的同级社会关系，忽略较弱的“${candidate.subtype}”重复边` });
          continue;
        }
        const duplicateIndex = existing.findIndex((relationship) => {
          const same = relationship.fromCharacterId === candidate.fromCharacterId && relationship.toCharacterId === candidate.toCharacterId;
          const reverse = !candidate.directed && !relationship.directed
            && relationship.fromCharacterId === candidate.toCharacterId && relationship.toCharacterId === candidate.fromCharacterId;
          return (same || reverse)
            && Boolean(relationship.directed) === candidate.directed
            && relationship.category === candidate.category
            && this.normalizeReference(canonicalizeRelationshipSubtype(String(relationship.category), String(relationship.subtype)))
              === this.normalizeReference(candidate.subtype);
        });
        if (duplicateIndex >= 0) {
          const duplicate = existing[duplicateIndex] as Record<string, unknown>;
          if (duplicate.confirmationStatus === "pending" && duplicate.locked !== true) {
            const mergedEvidence = [...(duplicate.evidence as Array<Record<string, unknown>> ?? [])];
            const seenEvidence = new Set(mergedEvidence.map((item) => `${String(item.chapterId)}|${String(item.quote)}`));
            for (const item of candidate.evidence) {
              const evidenceKey = `${String(item.chapterId)}|${String(item.quote)}`;
              if (!seenEvidence.has(evidenceKey)) mergedEvidence.push(item);
            }
            existing[duplicateIndex] = this.store.updateRelationship(String(duplicate.id), {
              subtype: candidate.subtype,
              keywords: [...new Set([...(duplicate.keywords as string[] ?? []), ...candidate.keywords])].slice(0, 8),
              confidence: Math.max(Number(duplicate.confidence ?? 0), candidate.confidence),
              currentStatus: candidate.currentStatus,
              timeRange: candidate.timeRange,
              evidence: mergedEvidence
            }, "analysis", taskId ?? null, "AI 合并关系证据");
          }
          if (candidatePeerStrength > 0) {
            for (let index = existing.length - 1; index >= 0; index -= 1) {
              const relationship = existing[index] as Record<string, unknown>;
              if (String(relationship.id) === String(duplicate.id)
                || unorderedPairKey(relationship.fromCharacterId, relationship.toCharacterId) !== candidatePair
                || relationship.category !== "social"
                || Boolean(relationship.directed) !== candidate.directed
                || relationship.confirmationStatus !== "pending"
                || relationship.locked === true
                || relationshipHasEnded(relationship) !== candidateEnded
                || peerSocialStrength(relationship) <= 0
                || peerSocialStrength(relationship) >= candidatePeerStrength) continue;
              this.store.deleteRelationship(String(relationship.id));
              existing.splice(index, 1);
            }
          }
          continue;
        }
        const weakerExistingPeerIndex = candidatePeerStrength > 0
          ? existing.findIndex((relationship) => unorderedPairKey(relationship.fromCharacterId, relationship.toCharacterId) === candidatePair
            && relationship.category === "social"
            && Boolean(relationship.directed) === candidate.directed
            && relationship.confirmationStatus === "pending"
            && relationship.locked !== true
            && relationshipHasEnded(relationship) === candidateEnded
            && peerSocialStrength(relationship) > 0
            && peerSocialStrength(relationship) < candidatePeerStrength)
          : -1;
        if (weakerExistingPeerIndex >= 0) {
          const weaker = existing[weakerExistingPeerIndex] as Record<string, unknown>;
          const mergedEvidence = [...(weaker.evidence as Array<Record<string, unknown>> ?? [])];
          const seenEvidence = new Set(mergedEvidence.map((item) => `${String(item.chapterId)}|${String(item.quote)}`));
          for (const item of candidate.evidence) {
            const evidenceKey = `${String(item.chapterId)}|${String(item.quote)}`;
            if (!seenEvidence.has(evidenceKey)) mergedEvidence.push(item);
          }
          existing[weakerExistingPeerIndex] = this.store.updateRelationship(String(weaker.id), {
            subtype: candidate.subtype,
            keywords: [...new Set([...(weaker.keywords as string[] ?? []), ...candidate.keywords])].slice(0, 8),
            confidence: Math.max(Number(weaker.confidence ?? 0), candidate.confidence),
            currentStatus: candidate.currentStatus,
            timeRange: candidate.timeRange,
            evidence: mergedEvidence
          }, "analysis", taskId ?? null, "AI 更新关系强度");
          continue;
        }
        const relationship = this.store.createRelationship(
          workId,
          { ...candidate, confirmationStatus: "pending", locked: false },
          "analysis",
          taskId ?? null
        );
        relationshipIds.push(String(relationship.id));
        existing.push(relationship);
      }
    });
    this.store.audit(workId, "relationship.analysis.completed", "work", workId, {
      batchCount: chunks.length,
      coveredChapterCount: chapters.length,
      rawCandidateCount: rawCandidates.length,
      savedCount: relationshipIds.length,
      skippedCount: skipped.length,
      fallbackSegmentCount,
      policyOmittedSegmentCount,
      scopeType: scope.type
    });
    return {
      relationshipIds,
      candidateCount: relationshipIds.length,
      rawCandidateCount: rawCandidates.length,
      skipped,
      batchCount: chunks.length,
      coveredChapterCount: chapters.length,
      fallbackSegmentCount,
      policyOmittedSegmentCount,
      callIds
    };
  }

  private getScopeChapters(workId: string, scope: ContextScope): Record<string, unknown>[] {
    const tree = this.store.getWorkTree(workId);
    const volumes = tree.volumes as Record<string, unknown>[];
    if (scope.type === "chapter") {
      if (!scope.chapterId) throw new AppError(400, "CHAPTER_REQUIRED", "分析范围缺少章节标识");
      const chapter = this.store.getChapter(scope.chapterId);
      if (chapter.workId !== workId) throw new AppError(400, "CHAPTER_WORK_MISMATCH", "章节不属于当前作品");
      return [chapter];
    }
    if (scope.type === "volume") {
      if (!scope.volumeId) throw new AppError(400, "VOLUME_REQUIRED", "分析范围缺少卷标识");
      const volume = volumes.find((item) => item.id === scope.volumeId);
      if (!volume) throw notFound("卷");
      return (volume.chapters as Record<string, unknown>[]).filter((chapter) => this.isAutomaticAnalysisChapter(chapter));
    }
    return volumes.flatMap((volume) => volume.chapters as Record<string, unknown>[])
      .filter((chapter) => this.isAutomaticAnalysisChapter(chapter));
  }

  private isAutomaticAnalysisChapter(chapter: Record<string, unknown>): boolean {
    return !chapter.excludedFromAnalysis && chapter.chapterType !== "作者的话";
  }

  private buildChapterChunks(chapters: Record<string, unknown>[], maximumChars = 10_000): Array<{ text: string; chapterIds: string[] }> {
    const chunks: Array<{ text: string; chapterIds: string[] }> = [];
    let text = "";
    let chapterIds: string[] = [];
    const flush = (): void => {
      if (!text) return;
      chunks.push({ text, chapterIds });
      text = "";
      chapterIds = [];
    };
    for (const chapter of chapters) {
      const header = `\n<CHAPTER id="${String(chapter.id)}" title="${String(chapter.title).replaceAll('"', "'")}">\n`;
      const footer = "\n</CHAPTER>\n";
      const content = String(chapter.content);
      const block = `${header}${content}${footer}`;
      if (text && text.length + block.length > maximumChars) flush();
      if (block.length <= maximumChars) {
        text += block;
        chapterIds.push(String(chapter.id));
        continue;
      }
      const segmentSize = Math.max(1000, maximumChars - header.length - footer.length - 80);
      for (let offset = 0; offset < content.length; offset += segmentSize) {
        flush();
        const part = Math.floor(offset / segmentSize) + 1;
        text = `${header.replace("<CHAPTER ", `<CHAPTER part="${part}" `)}${content.slice(offset, offset + segmentSize)}${footer}`;
        chapterIds = [String(chapter.id)];
        flush();
      }
    }
    flush();
    return chunks;
  }

  private splitMarkedChapters(text: string): string[] {
    const segments = text.match(/<CHAPTER\b[^>]*>[\s\S]*?<\/CHAPTER>/gu) ?? [];
    return segments.length > 0 ? segments : [text];
  }

  private splitMarkedChapterFragments(markedText: string, maximumChars = 800, overlapChars = 80): string[] {
    const opening = markedText.match(/<CHAPTER\b([^>]*)>/u);
    if (!opening || opening.index === undefined) return [markedText];
    const attributes = opening[1] ?? "";
    const chapterId = attributes.match(/\bid="([^"]+)"/u)?.[1];
    const chapterTitle = attributes.match(/\btitle="([^"]*)"/u)?.[1] ?? "";
    const contentStart = opening.index + opening[0].length;
    const contentEnd = markedText.lastIndexOf("</CHAPTER>");
    if (!chapterId || contentEnd <= contentStart) return [markedText];
    const content = markedText.slice(contentStart, contentEnd).replace(/^\s+/u, "").replace(/\s+$/u, "");
    if (content.length <= maximumChars) return [markedText];

    const pieces: string[] = [];
    let start = 0;
    while (start < content.length) {
      let end = Math.min(content.length, start + maximumChars);
      if (end < content.length) {
        const minimumChunkSize = Math.max(40, Math.min(600, Math.floor(maximumChars * 0.75)));
        const minimumTailSize = Math.max(40, Math.min(400, Math.floor(maximumChars / 2)));
        const minimumEnd = Math.min(end, start + minimumChunkSize);
        const boundaryText = content.slice(minimumEnd, end);
        let boundary = -1;
        for (const match of boundaryText.matchAll(/[。！？!?；;\n]/gu)) boundary = match.index ?? boundary;
        if (boundary >= 0) end = minimumEnd + boundary + 1;
        if (content.length - Math.max(start + 1, end - overlapChars) < minimumTailSize) end = content.length;
      }
      pieces.push(content.slice(start, end));
      if (end >= content.length) break;
      start = Math.max(start + 1, end - overlapChars);
    }
    return pieces.map((piece, index) => [
      `<CHAPTER id="${chapterId}" title="${chapterTitle}" fragment="${index + 1}/${pieces.length}">`,
      piece,
      "</CHAPTER>"
    ].join("\n"));
  }

  private async runChapterSegmentFallback(
    segments: string[],
    taskId: string | undefined,
    extractChunk: (text: string, maxAttempts?: number) => Promise<{ candidates: Array<Record<string, unknown>>; callId: string }>,
    minimumFallback?: (text: string) => Array<Record<string, unknown>>,
    concurrency = 10
  ): Promise<{
    candidates: Array<Record<string, unknown>>;
    callIds: string[];
    fallbackSegmentCount: number;
    policyOmittedSegmentCount: number;
  }> {
    const candidates: Array<Record<string, unknown>> = [];
    const callIds: string[] = [];
    let fallbackSegmentCount = 0;
    let policyOmittedSegmentCount = 0;
    const chapterResults = await this.processChunks(segments, concurrency, async (segment) => {
      if (taskId && this.store.getTask(taskId).status !== "running") {
        return { candidates: [], callId: null, failedSegment: null };
      }
      try {
        const extracted = await extractChunk(segment);
        return { candidates: extracted.candidates, callId: extracted.callId, failedSegment: null };
      } catch {
        return { candidates: [], callId: null, failedSegment: segment };
      }
    });

    const fragments: string[] = [];
    for (const result of chapterResults) {
      candidates.push(...result.candidates);
      if (result.callId) callIds.push(result.callId);
      if (!result.failedSegment) continue;
      const split = this.splitMarkedChapterFragments(result.failedSegment);
      fragments.push(...split);
    }

    const fragmentResults = await this.processChunks(fragments, concurrency, async (fragment) => {
      if (taskId && this.store.getTask(taskId).status !== "running") {
        return { candidates: [], callId: null, failedSegment: null };
      }
      try {
        const extracted = await extractChunk(fragment);
        return { candidates: extracted.candidates, callId: extracted.callId, failedSegment: null };
      } catch {
        return { candidates: [], callId: null, failedSegment: fragment };
      }
    });
    const microFragments: string[] = [];
    for (const result of fragmentResults) {
      candidates.push(...result.candidates);
      if (result.callId) callIds.push(result.callId);
      if (!result.failedSegment) continue;
      const split = this.splitMarkedChapterFragments(result.failedSegment, 240, 32);
      microFragments.push(...split);
    }

    const microResults = await this.processChunks(microFragments, concurrency, async (fragment) => {
      if (taskId && this.store.getTask(taskId).status !== "running") {
        return { candidates: [], callId: null, failedSegment: null };
      }
      try {
        const extracted = await extractChunk(fragment, 5);
        return { candidates: extracted.candidates, callId: extracted.callId, failedSegment: null };
      } catch {
        return { candidates: [], callId: null, failedSegment: fragment };
      }
    });
    const tinyFragments: string[] = [];
    for (const result of microResults) {
      candidates.push(...result.candidates);
      if (result.callId) callIds.push(result.callId);
      if (!result.failedSegment) continue;
      const split = this.splitMarkedChapterFragments(result.failedSegment, 120, 16);
      tinyFragments.push(...split);
    }

    const tinyResults = await this.processChunks(tinyFragments, concurrency, async (fragment) => {
      if (taskId && this.store.getTask(taskId).status !== "running") {
        return { candidates: [], callId: null, fallback: false };
      }
      try {
        const extracted = await extractChunk(fragment, 5);
        return { candidates: extracted.candidates, callId: extracted.callId, fallback: false, policyOmitted: false };
      } catch (error) {
        const policyOmitted = !minimumFallback && this.isSecurityAuditFailure(error);
        return {
          candidates: minimumFallback?.(fragment) ?? [],
          callId: null,
          fallback: !policyOmitted,
          policyOmitted
        };
      }
    });
    for (const result of tinyResults) {
      candidates.push(...result.candidates);
      if (result.callId) callIds.push(result.callId);
      if (result.fallback) fallbackSegmentCount += 1;
      if (result.policyOmitted) policyOmittedSegmentCount += 1;
    }
    return { candidates, callIds, fallbackSegmentCount, policyOmittedSegmentCount };
  }

  private isSecurityAuditFailure(error: unknown): boolean {
    if (error instanceof AppError && error.details && typeof error.details === "object" && !Array.isArray(error.details)) {
      const failure = (error.details as Record<string, unknown>).failure;
      if (typeof failure === "string" && /security_audit_fail|security_error/iu.test(failure)) return true;
    }
    return error instanceof Error && /security_audit_fail|security_error/iu.test(error.message);
  }

  private taskCanCommit(taskId?: string): boolean {
    if (!taskId) return true;
    const task = this.store.getTask(taskId);
    if (task.status !== "running") return false;
    if (this.store.isTaskSourceCurrent(taskId)) return true;
    this.store.updateTask(taskId, { status: "expired" });
    return false;
  }

  private taskSignal(taskId?: string): AbortSignal | undefined {
    return taskId ? this.taskControllers.get(taskId)?.signal : undefined;
  }

  private localCharacterFallback(workId: string, markedText: string): Array<Record<string, unknown>> {
    const header = markedText.match(/<CHAPTER\b[^>]*id="([^"]+)"[^>]*title="([^"]*)"[^>]*>/u);
    if (!header?.[1]) return [];
    const chapterId = header[1];
    const chapterTitle = header[2] ?? "";
    const content = markedText.replace(/^[\s\S]*?<CHAPTER\b[^>]*>/u, "").replace(/<\/CHAPTER>[\s\S]*$/u, "");
    const candidates: Array<Record<string, unknown>> = [];
    for (const character of this.store.listCharacters(workId)) {
      const names = [String(character.name), ...(character.aliases as string[])];
      const matchedName = names.find((name) => content.includes(name));
      if (!matchedName) continue;
      const index = content.indexOf(matchedName);
      const start = Math.max(0, index - 24);
      const quote = content.slice(start, Math.min(content.length, start + 76)).trim();
      candidates.push({
        canonicalName: character.name,
        aliases: (character.aliases as string[]).filter((alias) => this.isSafeGlobalAlias(alias)),
        species: character.species,
        identity: String((character.attributes as Record<string, unknown>).identity ?? "本地回退识别"),
        firstEvidence: { chapterId, chapterTitle, quote }
      });
    }
    return candidates;
  }

  private async processChunks<TInput, TResult>(
    items: TInput[],
    concurrency: number,
    worker: (item: TInput, index: number) => Promise<TResult>,
    onProgress?: (completed: number) => void
  ): Promise<TResult[]> {
    const results = new Array<TResult>(items.length);
    const failures: Array<{ index: number; message: string }> = [];
    let cursor = 0;
    let completed = 0;
    const runners = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        try {
          results[index] = await worker(items[index] as TInput, index);
        } catch (error) {
          failures.push({ index, message: error instanceof Error ? error.message : "批次处理失败" });
        } finally {
          completed += 1;
          onProgress?.(completed);
        }
      }
    });
    await Promise.all(runners);
    const firstPassFailures = failures.splice(0);
    for (const failure of firstPassFailures) {
      try {
        results[failure.index] = await worker(items[failure.index] as TInput, failure.index);
      } catch (error) {
        failures.push({ index: failure.index, message: error instanceof Error ? error.message : "批次处理失败" });
      } finally {
        completed += 1;
        onProgress?.(completed);
      }
    }
    if (failures.length > 0) {
      throw new AppError(502, "AI_BATCH_FAILED", `${failures.length} 个分析批次在双重重试后仍失败`, { failures, completed, total: items.length });
    }
    return results;
  }

  private normalizeReference(value: string): string {
    return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
  }

  private quoteExists(content: string, quote: string): boolean {
    if (!quote.trim()) return false;
    const normalize = (value: string): string => value.normalize("NFKC").replace(/\s+/gu, "").trim();
    return normalize(content).includes(normalize(quote));
  }

  private isSafeGlobalAlias(value: string): boolean {
    return isSafeGlobalAlias(value);
  }

  private enrichContinuationScope(workId: string, scope: ContextScope, instruction: string): ContextScope {
    if (!scope.chapterId) throw new AppError(400, "CHAPTER_REQUIRED", "续写任务必须指定当前章节");
    const chapter = this.store.getChapter(scope.chapterId);
    if (chapter.workId !== workId) throw new AppError(400, "CHAPTER_WORK_MISMATCH", "章节不属于当前作品");
    const haystack = `${String(chapter.content)}\n${instruction}`;
    const ids = new Set(scope.characterIds ?? []);
    for (const character of this.store.listCharacters(workId)) {
      const names = [String(character.name), ...(character.aliases as string[])];
      if (names.some((name) => this.textMentionsName(haystack, name))) ids.add(String(character.id));
    }
    return { ...scope, type: "chapter", chapterId: scope.chapterId, characterIds: [...ids] };
  }

  private textMentionsName(text: string, name: string): boolean {
    const normalized = name.normalize("NFKC").trim();
    if (!normalized) return false;
    if (/^[\x00-\x7F]+$/u.test(normalized)) {
      const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, "iu").test(text.normalize("NFKC"));
    }
    return text.normalize("NFKC").includes(normalized);
  }

  private buildContinuationContextRefs(workId: string, chapterId: string, scope: ContextScope): Record<string, unknown> {
    const work = this.store.getWork(workId);
    const outline = this.store.getChapterOutline(chapterId);
    const foreshadows = this.store.listForeshadows(workId, "unresolved", chapterId);
    const timeline = this.store.listTimelineEvents(workId).filter(
      (item) => Array.isArray(item.chapterIds) && item.chapterIds.includes(chapterId)
    );
    const allCharacters = this.store.listCharacters(workId);
    const selectedCharacterIds = new Set(scope.characterIds ?? []);
    const characters = allCharacters.filter((item) => selectedCharacterIds.has(String(item.id))
      || (Array.isArray(item.lockedFields) && item.lockedFields.length > 0));
    const selectedSettingIds = new Set(scope.settingIds ?? []);
    const settings = this.store.listSettings(workId).filter((item) => item.locked || selectedSettingIds.has(String(item.id)));
    const organizations = this.store.listOrganizations(workId);
    const relationships = selectRelationshipConstraints(this.store, workId, selectedCharacterIds);
    const characterNameById = new Map(allCharacters.map((character) => [String(character.id), String(character.name)]));
    const revision = (value: unknown): string => this.store.hashContent(JSON.stringify(value));
    return {
      version: 4,
      chapterId,
      chapterVersion: this.store.getChapter(chapterId).versionNo,
      workRevision: revision({ title: work.title, author: work.author }),
      characters: characters.map((item) => ({
        id: item.id,
        revision: revision({
          name: item.name,
          aliases: item.aliases,
          species: item.species,
          attributes: item.attributes,
          profile: item.profile,
          currentState: item.currentState,
          lockedFields: item.lockedFields
        })
      })).sort((left, right) => String(left.id).localeCompare(String(right.id))),
      settings: settings.map((item) => ({
        id: item.id,
        revision: revision({ title: item.title, category: item.category, content: item.content, locked: item.locked })
      })).sort((left, right) => String(left.id).localeCompare(String(right.id))),
      organizations: organizations.map((item) => ({
        id: item.id,
        revision: revision({
          name: item.name,
          description: item.description,
          settings: item.settings,
          memberIds: item.memberIds
        })
      })).sort((left, right) => String(left.id).localeCompare(String(right.id))),
      relationships: relationships.map((item) => ({
        id: item.id,
        revision: revision({
          fromCharacterId: item.fromCharacterId,
          fromName: characterNameById.get(String(item.fromCharacterId)) ?? "",
          toCharacterId: item.toCharacterId,
          toName: characterNameById.get(String(item.toCharacterId)) ?? "",
          category: item.category,
          subtype: item.subtype,
          keywords: item.keywords,
          directed: item.directed,
          currentStatus: item.currentStatus,
          timeRange: item.timeRange,
          confirmationStatus: item.confirmationStatus,
          locked: item.locked
        })
      })),
      timeline: timeline.map((item) => ({
        id: item.id,
        revision: revision({ name: item.name, timeLabel: item.timeLabel, timeSort: item.timeSort, location: item.location, status: item.status })
      })).sort((left, right) => String(left.id).localeCompare(String(right.id))),
      outlineRevision: outline ? revision({
        goal: outline.goal,
        conflict: outline.conflict,
        turningPoint: outline.turningPoint,
        notes: outline.notes,
        status: outline.status
      }) : null,
      foreshadows: foreshadows.map((item) => ({
        id: item.id,
        revision: revision({
          title: item.title,
          description: item.description,
          status: item.status,
          importance: item.importance,
          plannedPayoffChapterId: item.plannedPayoffChapterId,
          occurrences: item.occurrences
        })
      })).sort((left, right) => String(left.id).localeCompare(String(right.id)))
    };
  }

  private resolveModel(workId: string, taskType: TaskType, explicitModelId?: string): { model: ModelRow; provider: ProviderRow } {
    let modelId = explicitModelId;
    if (!modelId) {
      const defaultRow = this.store.db.get("SELECT model_id FROM task_defaults WHERE work_id = ? AND task_type = ?", workId, taskType);
      modelId = defaultRow ? stringValue(defaultRow, "model_id") : undefined;
    }
    if (!modelId) throw new AppError(409, "MODEL_REQUIRED", `尚未为 ${taskType} 配置默认模型，请先选择模型`);
    const model = this.getModelRow(modelId);
    const provider = this.getProviderRow(stringValue(model, "provider_id"));
    if (stringValue(provider, "work_id") !== PLATFORM_AI_WORK_ID) throw new AppError(400, "MODEL_PLATFORM_MISMATCH", "模型不属于平台 AI 配置");
    this.assertAvailable(provider, model);
    return { model, provider };
  }

  private configuredConcurrency(workId: string, taskType: TaskType, modelId?: string): number {
    const { provider } = this.resolveModel(workId, taskType, modelId);
    return Math.round(clamp(numberValue(provider, "concurrency_limit") || 10, 1, 100));
  }

  private scheduleProviderRequest<T>(provider: ProviderRow, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    const providerId = stringValue(provider, "id");
    const concurrencyLimit = Math.round(clamp(numberValue(provider, "concurrency_limit") || 10, 1, 100));
    const rpmLimit = Math.round(clamp(numberValue(provider, "rpm_limit") || 10, 1, 10_000));
    let schedule = this.providerSchedules.get(providerId);
    if (!schedule) {
      schedule = { active: 0, starts: [], concurrencyLimit, rpmLimit, queue: [], timer: null };
      this.providerSchedules.set(providerId, schedule);
    } else {
      schedule.concurrencyLimit = concurrencyLimit;
      schedule.rpmLimit = rpmLimit;
    }
    if (signal?.aborted) return Promise.reject(this.abortReason(signal));
    return new Promise<T>((resolve, reject) => {
      let entry: (typeof schedule.queue)[number];
      const onAbort = (): void => {
        const index = schedule.queue.indexOf(entry);
        if (index < 0) return;
        schedule.queue.splice(index, 1);
        entry.detachAbort();
        reject(this.abortReason(signal));
        this.pumpProviderSchedule(providerId);
      };
      entry = {
        signal,
        run,
        resolve: (value) => resolve(value as T),
        reject,
        detachAbort: () => signal?.removeEventListener("abort", onAbort)
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      schedule.queue.push(entry);
      this.pumpProviderSchedule(providerId);
    });
  }

  private pumpProviderSchedule(providerId: string): void {
    const schedule = this.providerSchedules.get(providerId);
    if (!schedule) return;
    if (schedule.timer) {
      clearTimeout(schedule.timer);
      schedule.timer = null;
    }
    const currentTime = Date.now();
    schedule.starts = schedule.starts.filter((startedAt) => startedAt > currentTime - 60_000);
    while (schedule.active < schedule.concurrencyLimit && schedule.starts.length < schedule.rpmLimit && schedule.queue.length > 0) {
      const entry = schedule.queue.shift();
      if (!entry) break;
      entry.detachAbort();
      if (entry.signal?.aborted) {
        entry.reject(this.abortReason(entry.signal));
        continue;
      }
      schedule.active += 1;
      schedule.starts.push(Date.now());
      void Promise.resolve()
        .then(entry.run)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          schedule.active -= 1;
          this.pumpProviderSchedule(providerId);
        });
    }
    if (schedule.queue.length > 0 && schedule.active < schedule.concurrencyLimit && schedule.starts.length >= schedule.rpmLimit) {
      const delay = Math.max(1, (schedule.starts[0] ?? Date.now()) + 60_000 - Date.now() + 1);
      schedule.timer = setTimeout(() => this.pumpProviderSchedule(providerId), delay);
      schedule.timer.unref?.();
    }
  }

  private abortReason(signal?: AbortSignal): Error {
    return signal?.reason instanceof Error ? signal.reason : new Error("AI 请求已取消");
  }

  private normalizeRelationshipKeywords(value: unknown, subtype: string): string[] {
    const source = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(/[，,、；;|]/u)
        : [];
    const keywords = source
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.normalize("NFKC").trim().replace(/^#+/u, "").replace(/\s+/gu, " "))
      .filter((item) => item.length > 0 && item.length <= 24);
    return [...new Set(keywords.length > 0 ? keywords : [subtype])].slice(0, 8);
  }

  private assertAvailable(provider: ProviderRow, model: ModelRow): void {
    if (stringValue(provider, "status") !== "enabled") throw new AppError(409, "PROVIDER_DISABLED", "供应商已停用，不能创建新任务");
    if (stringValue(provider, "connection_status") !== "success") {
      throw new AppError(409, "PROVIDER_UNAVAILABLE", "供应商尚未通过连接测试或连接异常");
    }
    if (!boolValue(model, "enabled")) throw new AppError(409, "MODEL_DISABLED", "模型已停用，不能创建新任务");
  }

  private sanitizeParameters(input: Record<string, unknown>): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!allowedParameters.has(key)) continue;
      if (typeof value === "number" && Number.isFinite(value)) output[key] = value;
    }
    if (typeof output.temperature === "number") output.temperature = clamp(output.temperature, 0, 2);
    if (typeof output.top_p === "number") output.top_p = clamp(output.top_p, 0, 1);
    output.max_tokens = typeof output.max_tokens === "number"
      ? Math.round(clamp(output.max_tokens, 1, 32_768))
      : DEFAULT_MAX_TOKENS;
    return output;
  }

  private decryptKey(row: Row): string {
    try {
      return this.vault.decrypt({
        encrypted: stringValue(row, "encrypted_key"),
        iv: stringValue(row, "key_iv"),
        tag: stringValue(row, "key_tag")
      });
    } catch {
      throw new AppError(500, "CREDENTIAL_DECRYPT_FAILED", "供应商凭据无法解密，请重新填写 API 密钥");
    }
  }

  private getProviderRow(providerId: string): ProviderRow {
    const row = this.store.db.get<ProviderRow>("SELECT * FROM providers WHERE id = ?", providerId);
    if (!row) throw notFound("AI 供应商");
    return row;
  }

  private getModelRow(modelId: string): ModelRow {
    const row = this.store.db.get<ModelRow>("SELECT * FROM models WHERE id = ?", modelId);
    if (!row) throw notFound("AI 模型");
    return row;
  }

  private mapProvider(row: Row): Record<string, unknown> {
    return {
      id: stringValue(row, "id"),
      scope: "platform",
      name: stringValue(row, "name"),
      baseUrl: stringValue(row, "base_url"),
      apiKey: stringValue(row, "key_hint"),
      status: stringValue(row, "status"),
      connectionStatus: stringValue(row, "connection_status"),
      concurrencyLimit: numberValue(row, "concurrency_limit") || 10,
      rpmLimit: numberValue(row, "rpm_limit") || 10,
      maxTokens: numberValue(row, "max_tokens") || DEFAULT_MAX_TOKENS,
      defaultModelId: row.default_model_id === null ? null : stringValue(row, "default_model_id"),
      note: stringValue(row, "note"),
      lastError: row.last_error === null ? null : stringValue(row, "last_error"),
      lastSuccessAt: row.last_success_at === null ? null : stringValue(row, "last_success_at"),
      createdAt: stringValue(row, "created_at"),
      updatedAt: stringValue(row, "updated_at")
    };
  }

  private mapModel(row: Row): Record<string, unknown> {
    return {
      id: stringValue(row, "id"),
      providerId: stringValue(row, "provider_id"),
      displayName: stringValue(row, "display_name"),
      modelId: stringValue(row, "model_id"),
      purposes: json(stringValue(row, "purposes_json"), []),
      contextNote: stringValue(row, "context_note"),
      contextWindow: numberValue(row, "context_window") || DEFAULT_CONTEXT_WINDOW,
      outputNote: stringValue(row, "output_note"),
      preset: normalizeModelPreset(safeJsonObject(stringValue(row, "preset_json"))),
      enabled: boolValue(row, "enabled"),
      note: stringValue(row, "note"),
      createdAt: stringValue(row, "created_at"),
      updatedAt: stringValue(row, "updated_at")
    };
  }

  private mapSuggestion(row: Row): Record<string, unknown> {
    const call = this.store.db.get("SELECT provider_id, model_id FROM ai_calls WHERE id = ?", stringValue(row, "call_id"));
    const guard = this.store.getLatestContinuationGuard(stringValue(row, "id"));
    return {
      id: stringValue(row, "id"),
      callId: stringValue(row, "call_id"),
      workId: stringValue(row, "work_id"),
      chapterId: row.chapter_id === null ? null : stringValue(row, "chapter_id"),
      chapterVersion: row.chapter_version === null ? null : numberValue(row, "chapter_version"),
      taskType: stringValue(row, "task_type"),
      instruction: stringValue(row, "instruction"),
      sourceText: stringValue(row, "source_text"),
      content: stringValue(row, "content"),
      action: stringValue(row, "action"),
      status: stringValue(row, "status"),
      outputTokens: estimateAiTokens(stringValue(row, "content")),
      guard,
      provider: call ? this.getProvider(stringValue(call, "provider_id")) : null,
      model: call ? this.getModel(stringValue(call, "model_id")) : null,
      createdAt: stringValue(row, "created_at"),
      decidedAt: row.decided_at === null ? null : stringValue(row, "decided_at")
    };
  }
}
