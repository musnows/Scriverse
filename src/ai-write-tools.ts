// AI 可写工具与修改计划审批的共享常量与纯函数。
// 计划与提问的持久化、执行引擎在 store.ts；工具声明与调用分发在 ai.ts。

/** 作品设置页可写工具开关键。默认全部关闭。 */
export const AI_WRITE_TOOL_SWITCH_KEYS = [
  "settings",
  "characters",
  "races",
  "organizations",
  "timeline",
  "relationships",
  "outlines",
  "prose-annotations",
  "analysis-tasks",
  "ask-user-questions"
] as const;
export type AiWriteToolSwitchKey = (typeof AI_WRITE_TOOL_SWITCH_KEYS)[number];

export const AI_WRITE_TOOL_SWITCH_LABELS: Record<AiWriteToolSwitchKey, string> = {
  settings: "世界设定",
  characters: "角色",
  races: "种族",
  organizations: "组织",
  timeline: "时间线",
  relationships: "人物关系",
  outlines: "大纲/伏笔",
  "prose-annotations": "正文评论/待办",
  "analysis-tasks": "分析任务",
  "ask-user-questions": "提问工具"
};

/** 计划操作的权限模块。 */
export const AI_WRITE_OPERATION_MODULES = [
  "settings",
  "characters",
  "races",
  "organizations",
  "timeline",
  "relationships",
  "outlines",
  "prose",
  "ai-analysis"
] as const;
export type AiWriteOperationModule = (typeof AI_WRITE_OPERATION_MODULES)[number];

export function writeToolSwitchKey(module: AiWriteOperationModule): AiWriteToolSwitchKey {
  if (module === "prose") return "prose-annotations";
  if (module === "ai-analysis") return "analysis-tasks";
  return module;
}

export const AI_WRITE_OPERATION_TYPES = ["create-entry", "update-entry", "create-annotation", "create-task"] as const;
export type AiWriteOperationType = (typeof AI_WRITE_OPERATION_TYPES)[number];

export const AI_WRITE_ENTITY_TYPES = [
  "setting",
  "character",
  "race",
  "organization",
  "timeline-track",
  "timeline-event",
  "relationship",
  "chapter-outline",
  "foreshadow",
  "chapter-annotation",
  "analysis-task",
  "chapter"
] as const;
export type AiWriteEntityType = (typeof AI_WRITE_ENTITY_TYPES)[number];

/** 实体类型在撤销时可回滚的版本化类型；character 走专属版本表。 */
export function aiWriteEntityVersionType(entityType: AiWriteEntityType): string | null {
  if (entityType === "character") return "character";
  if (entityType === "chapter-annotation" || entityType === "analysis-task") return null;
  return entityType;
}

/** 计划操作字段的中文标签，用于审批详情展示。 */
const ENTRY_FIELD_LABELS: Record<string, Record<string, string>> = {
  setting: {
    title: "标题", category: "分类", content: "内容", tags: "标签", status: "状态",
    locked: "锁定", evidence: "依据", scope: "影响范围", authorNote: "作者备注"
  },
  character: {
    name: "名称", code: "代号", aliases: "别名", raceId: "种族", species: "种族名",
    organizationIds: "所属组织", attributes: "属性", profile: "人物档案", currentState: "当前状态",
    lockedFields: "锁定字段", firstChapterId: "首次出场章节", isDead: "已死亡"
  },
  race: {
    name: "名称", description: "描述", isExtinct: "已灭绝", parentRaceId: "父种族",
    settingsMarkdown: "设定"
  },
  organization: {
    name: "名称", description: "描述", isDissolved: "已解散", settingsMarkdown: "设定"
  },
  "timeline-track": {
    name: "名称", description: "描述", sortOrder: "排序"
  },
  "timeline-event": {
    name: "名称", description: "描述", eventType: "事件类型", timeLabel: "时间标签", timeSort: "时间排序",
    chapterIds: "关联章节", participantIds: "参与角色", location: "地点", causes: "起因",
    impactScope: "影响范围", evidence: "依据", status: "状态", trackId: "所属时间轴"
  },
  relationship: {
    fromCharacterId: "源角色", toCharacterId: "目标角色", category: "关系类型", subtype: "子类型",
    keywords: "关键词", directed: "有向", currentStatus: "当前状态", timeRange: "时间范围",
    confidence: "置信度", evidence: "依据", confirmationStatus: "确认状态", locked: "锁定"
  },
  "chapter-outline": {
    goal: "本章目标", conflict: "冲突", turningPoint: "转折点", notes: "备注", status: "状态"
  },
  foreshadow: {
    title: "标题", description: "描述", status: "状态", importance: "重要程度",
    plannedPayoffChapterId: "计划揭晓章节", resolutionNote: "揭晓说明"
  }
};

export function aiWriteFieldLabel(entityType: AiWriteEntityType, field: string): string {
  return ENTRY_FIELD_LABELS[entityType]?.[field] ?? field;
}

/** 修改计划操作字段级差异。 */
export type AiWriteFieldDiff = {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
};

function stableStringify(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function isEqualValue(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * 将 AI 提供的字段修改应用到实体当前快照上，生成修改后快照。
 * 顶层字段整体替换；JSON 对象字段不深度合并。
 */
export function applyEntryChanges(
  entityType: AiWriteEntityType,
  current: Record<string, unknown>,
  changes: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...current };
  for (const [field, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    next[field] = value;
  }
  // 仅保留与实体输入相关的展示字段，避免把映射层字段混入执行输入。
  const allowed = new Set(Object.keys(ENTRY_FIELD_LABELS[entityType] ?? {}));
  return Object.fromEntries(Object.entries(next).filter(([field]) => allowed.has(field)));
}

/** 生成字段级差异；仅包含实际变化的字段。 */
export function buildEntryFieldDiffs(
  entityType: AiWriteEntityType,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>
): AiWriteFieldDiff[] {
  const diffs: AiWriteFieldDiff[] = [];
  const fields = new Set([...(before ? Object.keys(before) : []), ...Object.keys(after)]);
  for (const field of [...fields].sort()) {
    const beforeValue = before ? before[field] : null;
    const afterValue = after[field];
    if (isEqualValue(beforeValue ?? null, afterValue ?? null)) continue;
    diffs.push({ field, label: aiWriteFieldLabel(entityType, field), before: beforeValue ?? null, after: afterValue ?? null });
  }
  return diffs;
}

export const DEFAULT_AI_WRITE_PLAN_MAX_OPERATIONS = 5;
export const DEFAULT_AI_WRITE_PLAN_TTL_HOURS = 24;
export const DEFAULT_AI_TOOL_QUESTION_TTL_MINUTES = 30;

export type AiWritePlanLimits = {
  maxOperations: number;
  planTtlMs: number;
  questionTtlMs: number;
};

/**
 * 解析审批计划与提问的运行时限制。
 * AI_WRITE_PLAN_MAX_OPERATIONS 有效范围 1-20，超出范围的配置被拒绝并回退默认值 5。
 */
export function resolveAiWritePlanLimits(env: Record<string, string | undefined> = process.env): AiWritePlanLimits {
  const parsedMax = Number(env.AI_WRITE_PLAN_MAX_OPERATIONS);
  const maxOperations = Number.isInteger(parsedMax) && parsedMax >= 1 && parsedMax <= 20
    ? parsedMax
    : DEFAULT_AI_WRITE_PLAN_MAX_OPERATIONS;
  const parsedTtlHours = Number(env.AI_WRITE_PLAN_TTL_HOURS);
  const planTtlHours = Number.isFinite(parsedTtlHours) && parsedTtlHours >= 1 && parsedTtlHours <= 720
    ? parsedTtlHours
    : DEFAULT_AI_WRITE_PLAN_TTL_HOURS;
  const parsedQuestionMinutes = Number(env.AI_TOOL_QUESTION_TTL_MINUTES);
  const questionTtlMinutes = Number.isFinite(parsedQuestionMinutes) && parsedQuestionMinutes >= 1 && parsedQuestionMinutes <= 1_440
    ? parsedQuestionMinutes
    : DEFAULT_AI_TOOL_QUESTION_TTL_MINUTES;
  return { maxOperations, planTtlMs: planTtlHours * 3_600_000, questionTtlMs: questionTtlMinutes * 60_000 };
}
