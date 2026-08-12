import { z } from "zod";
import { AppError } from "./errors.js";
import {
  canReadWorkModule,
  canWriteWorkModule,
  emptyWorkModulePermissions,
  type WorkModulePermissions,
  type WorkPermissionModule
} from "./work-permissions.js";

export const WORK_AGENT_READ_TOOL_IDS = [
  "story_index",
  "read_chapters",
  "grep",
  "search_story_entities",
  "read_character_sections",
  "search_drafts",
  "image"
] as const;

export const WORK_AGENT_WRITE_TOOL_IDS = [
  "write_settings",
  "write_characters",
  "write_races",
  "write_organizations",
  "write_timeline",
  "write_relationships",
  "write_outlines",
  "write_chapter_annotations",
  "write_analysis_tasks",
  "ask_user_questions"
] as const;

export const ASK_USER_QUESTIONS_TOOL_NAME = "AskUserQuestions";

export type WorkAgentReadToolId = (typeof WORK_AGENT_READ_TOOL_IDS)[number];
export type WorkAgentWriteToolId = (typeof WORK_AGENT_WRITE_TOOL_IDS)[number];

export const AI_WRITE_APPROVAL_STATUSES = [
  "pending",
  "rejected",
  "expired",
  "invalidated",
  "executing",
  "succeeded",
  "failed"
] as const;
export type AiWriteApprovalStatus = (typeof AI_WRITE_APPROVAL_STATUSES)[number];

export const AI_USER_QUESTION_STATUSES = [
  "pending",
  "answered",
  "rejected",
  "expired",
  "invalidated"
] as const;
export type AiUserQuestionStatus = (typeof AI_USER_QUESTION_STATUSES)[number];

export const AI_WRITE_OPERATION_KINDS = [
  "create_setting",
  "update_setting",
  "create_character",
  "update_character",
  "create_race",
  "update_race",
  "create_organization",
  "update_organization",
  "create_timeline_track",
  "update_timeline_track",
  "create_timeline_event",
  "update_timeline_event",
  "create_relationship",
  "update_relationship",
  "upsert_outline",
  "create_foreshadow",
  "update_foreshadow",
  "create_chapter_annotation",
  "create_analysis_task"
] as const;
export type AiWriteOperationKind = (typeof AI_WRITE_OPERATION_KINDS)[number];

export const DEFAULT_AI_WRITE_PLAN_MAX_OPERATIONS = 5;
export const AI_WRITE_PLAN_MAX_OPERATIONS_LIMIT = 20;
export const AI_WRITE_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

const identifier = z.string().trim().min(1).max(200);
const optionalStrings = z.array(z.string().trim().min(1).max(200)).max(100).optional();
const jsonObject = z.record(z.string(), z.unknown());
const aiSummary = z.string().trim().min(1).max(500);

export const WRITE_TOOL_PERMISSION_MODULE: Record<Exclude<WorkAgentWriteToolId, "ask_user_questions">, WorkPermissionModule> = {
  write_settings: "settings",
  write_characters: "characters",
  write_races: "races",
  write_organizations: "organizations",
  write_timeline: "timeline",
  write_relationships: "relationships",
  write_outlines: "outlines",
  write_chapter_annotations: "prose",
  write_analysis_tasks: "ai-analysis"
};

export const OPERATION_KIND_TOOL_ID: Record<AiWriteOperationKind, Exclude<WorkAgentWriteToolId, "ask_user_questions">> = {
  create_setting: "write_settings",
  update_setting: "write_settings",
  create_character: "write_characters",
  update_character: "write_characters",
  create_race: "write_races",
  update_race: "write_races",
  create_organization: "write_organizations",
  update_organization: "write_organizations",
  create_timeline_track: "write_timeline",
  update_timeline_track: "write_timeline",
  create_timeline_event: "write_timeline",
  update_timeline_event: "write_timeline",
  create_relationship: "write_relationships",
  update_relationship: "write_relationships",
  upsert_outline: "write_outlines",
  create_foreshadow: "write_outlines",
  update_foreshadow: "write_outlines",
  create_chapter_annotation: "write_chapter_annotations",
  create_analysis_task: "write_analysis_tasks"
};

export const OPERATION_KIND_MODULE: Record<AiWriteOperationKind, WorkPermissionModule> = {
  create_setting: "settings",
  update_setting: "settings",
  create_character: "characters",
  update_character: "characters",
  create_race: "races",
  update_race: "races",
  create_organization: "organizations",
  update_organization: "organizations",
  create_timeline_track: "timeline",
  update_timeline_track: "timeline",
  create_timeline_event: "timeline",
  update_timeline_event: "timeline",
  create_relationship: "relationships",
  update_relationship: "relationships",
  upsert_outline: "outlines",
  create_foreshadow: "outlines",
  update_foreshadow: "outlines",
  create_chapter_annotation: "prose",
  create_analysis_task: "ai-analysis"
};

export const OPERATION_KIND_LABELS: Record<AiWriteOperationKind, string> = {
  create_setting: "新建世界设定",
  update_setting: "编辑世界设定",
  create_character: "新建角色",
  update_character: "编辑角色",
  create_race: "新建种族",
  update_race: "编辑种族",
  create_organization: "新建组织",
  update_organization: "编辑组织",
  create_timeline_track: "新建时间轴",
  update_timeline_track: "编辑时间轴",
  create_timeline_event: "新建时间线事件",
  update_timeline_event: "编辑时间线事件",
  create_relationship: "新建人物关系",
  update_relationship: "编辑人物关系",
  upsert_outline: "新建或编辑章节大纲",
  create_foreshadow: "新建伏笔",
  update_foreshadow: "编辑伏笔",
  create_chapter_annotation: "创建正文批注",
  create_analysis_task: "创建分析任务"
};

export const WRITE_TOOL_LABELS: Record<WorkAgentWriteToolId, string> = {
  write_settings: "世界设定",
  write_characters: "角色",
  write_races: "种族",
  write_organizations: "组织",
  write_timeline: "时间线",
  write_relationships: "人物关系",
  write_outlines: "大纲/伏笔",
  write_chapter_annotations: "正文评论/待办",
  write_analysis_tasks: "分析任务",
  ask_user_questions: "向用户提问"
};

export const AI_WRITE_APPROVAL_STATUS_LABELS: Record<AiWriteApprovalStatus, string> = {
  pending: "待确认",
  rejected: "已拒绝",
  expired: "已过期",
  invalidated: "已失效",
  executing: "执行中",
  succeeded: "执行成功",
  failed: "执行失败"
};

export const AI_USER_QUESTION_STATUS_LABELS: Record<AiUserQuestionStatus, string> = {
  pending: "待确认",
  answered: "已回答",
  rejected: "已拒绝",
  expired: "已过期",
  invalidated: "已失效"
};

export const FIELD_LABELS: Record<string, string> = {
  title: "标题",
  category: "分类",
  content: "内容",
  tags: "标签",
  status: "状态",
  locked: "锁定",
  evidence: "证据",
  scope: "范围",
  authorNote: "作者备注",
  name: "名称",
  isDead: "已死亡",
  code: "编号",
  aliases: "别名",
  raceId: "种族",
  organizationIds: "所属组织",
  attributes: "属性",
  profile: "档案",
  currentState: "当前状态",
  lockedFields: "锁定字段",
  firstChapterId: "首次出场章节",
  isExtinct: "已灭绝",
  parentRaceId: "父级种族",
  description: "说明",
  settings: "设定条目",
  settingsMarkdown: "设定 Markdown",
  settingsSections: "设定章节",
  memberIds: "成员",
  isDissolved: "已解散",
  sortOrder: "排序",
  trackId: "所属时间轴",
  eventType: "事件类型",
  timeLabel: "时间标注",
  timeSort: "时间排序",
  chapterIds: "关联章节",
  participantIds: "参与者",
  location: "地点",
  causes: "起因",
  impactScope: "影响范围",
  fromCharacterId: "起始角色",
  toCharacterId: "目标角色",
  subtype: "子类型",
  keywords: "关键词",
  directed: "有向",
  currentStatus: "当前关系状态",
  timeRange: "时间范围",
  confidence: "置信度",
  confirmationStatus: "确认状态",
  goal: "目标",
  conflict: "冲突",
  turningPoint: "转折",
  notes: "备注",
  importance: "重要程度",
  plannedPayoffChapterId: "计划回收章节",
  resolutionNote: "回收说明",
  occurrences: "出现记录",
  kind: "批注类型",
  startLine: "起始行",
  endLine: "结束行",
  note: "批注内容",
  quote: "引用正文",
  chapterId: "章节",
  taskType: "任务类型",
  modelId: "模型",
  analysisScope: "分析范围"
};

const settingFields = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  content: z.string().trim().min(1).max(200_000).optional(),
  tags: optionalStrings,
  status: z.enum(["draft", "pending", "confirmed", "deprecated"]).optional(),
  locked: z.boolean().optional(),
  evidence: z.array(z.unknown()).max(50).optional(),
  scope: jsonObject.optional(),
  authorNote: z.string().max(20_000).optional()
}).strict();

const characterFields = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  isDead: z.boolean().optional(),
  code: z.string().trim().max(200).optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  raceId: identifier.nullable().optional(),
  organizationIds: z.array(identifier).max(100).optional(),
  attributes: jsonObject.optional(),
  profile: jsonObject.optional(),
  currentState: jsonObject.optional(),
  lockedFields: optionalStrings,
  firstChapterId: identifier.nullable().optional()
}).strict();

const raceFields = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  isExtinct: z.boolean().optional(),
  parentRaceId: identifier.nullable().optional(),
  description: z.string().max(100_000).optional(),
  settings: z.array(z.string().trim().min(1).max(20_000)).max(200).optional(),
  settingsMarkdown: z.string().max(200_000).optional(),
  memberIds: z.array(identifier).max(1000).optional()
}).strict();

const organizationFields = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  isDissolved: z.boolean().optional(),
  description: z.string().max(100_000).optional(),
  settings: z.array(z.string().trim().min(1).max(20_000)).max(200).optional(),
  settingsMarkdown: z.string().max(200_000).optional(),
  memberIds: z.array(identifier).max(1000).optional()
}).strict();

const timelineTrackFields = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(20_000).optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional()
}).strict();

const timelineEventFields = z.object({
  name: z.string().trim().min(1).max(300).optional(),
  trackId: identifier.nullable().optional(),
  description: z.string().max(100_000).optional(),
  eventType: z.string().max(100).optional(),
  timeLabel: z.string().max(300).optional(),
  timeSort: z.number().finite().nullable().optional(),
  chapterIds: optionalStrings,
  participantIds: optionalStrings,
  location: z.string().max(500).optional(),
  causes: optionalStrings,
  impactScope: z.enum(["personal", "organization", "regional", "world", "galaxy"]).optional(),
  evidence: z.array(z.unknown()).max(50).optional(),
  status: z.enum(["candidate", "pending", "confirmed", "deprecated"]).optional()
}).strict();

const relationshipFields = z.object({
  fromCharacterId: identifier.optional(),
  toCharacterId: identifier.optional(),
  category: z.enum(["family", "social", "emotional", "conflict", "uncertain"]).optional(),
  subtype: z.string().max(100).optional(),
  keywords: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  directed: z.boolean().optional(),
  currentStatus: z.string().max(100).optional(),
  timeRange: jsonObject.optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.array(z.unknown()).max(50).optional(),
  confirmationStatus: z.enum(["pending", "confirmed", "rejected"]).optional(),
  locked: z.boolean().optional()
}).strict();

const outlineFields = z.object({
  goal: z.string().max(100_000).optional(),
  conflict: z.string().max(100_000).optional(),
  turningPoint: z.string().max(100_000).optional(),
  notes: z.string().max(100_000).optional(),
  status: z.enum(["draft", "ready", "completed"]).optional()
}).strict();

const foreshadowFields = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(100_000).optional(),
  status: z.enum(["planned", "planted", "resolved", "abandoned"]).optional(),
  importance: z.enum(["low", "medium", "high"]).optional(),
  plannedPayoffChapterId: identifier.nullable().optional(),
  resolutionNote: z.string().max(100_000).optional()
}).strict();

const analysisTaskTypes = [
  "structure",
  "chapter-analysis",
  "character-extraction",
  "character-summary",
  "character-identity-audit",
  "timeline-analysis",
  "worldview-analysis",
  "setting-extraction",
  "consistency-check",
  "report-update",
  "book-analysis",
  "relationship-analysis"
] as const;

function requireCreateFields<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  fields: Array<keyof T & string>
) {
  return schema.superRefine((value, context) => {
    const record = value as Record<string, unknown>;
    for (const field of fields) {
      if (record[field] === undefined || record[field] === null || record[field] === "") {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `新建时必须提供 ${field}` });
      }
    }
  });
}

const createSettingFields = requireCreateFields(settingFields, ["title", "category", "content"]);
const createCharacterFields = requireCreateFields(characterFields, ["name"]);
const createRaceFields = requireCreateFields(raceFields, ["name"]);
const createOrganizationFields = requireCreateFields(organizationFields, ["name"]);
const createTimelineTrackFields = requireCreateFields(timelineTrackFields, ["name"]);
const createTimelineEventFields = requireCreateFields(timelineEventFields, ["name"]);
const createRelationshipFields = requireCreateFields(relationshipFields, ["fromCharacterId", "toCharacterId", "category"]);
const createForeshadowFields = requireCreateFields(foreshadowFields, ["title"]);

export const aiWriteOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create_setting"), summary: aiSummary.optional(), fields: createSettingFields }).strict(),
  z.object({ kind: z.literal("update_setting"), summary: aiSummary.optional(), targetId: identifier, fields: settingFields }).strict(),
  z.object({ kind: z.literal("create_character"), summary: aiSummary.optional(), fields: createCharacterFields }).strict(),
  z.object({ kind: z.literal("update_character"), summary: aiSummary.optional(), targetId: identifier, fields: characterFields }).strict(),
  z.object({ kind: z.literal("create_race"), summary: aiSummary.optional(), fields: createRaceFields }).strict(),
  z.object({ kind: z.literal("update_race"), summary: aiSummary.optional(), targetId: identifier, fields: raceFields }).strict(),
  z.object({ kind: z.literal("create_organization"), summary: aiSummary.optional(), fields: createOrganizationFields }).strict(),
  z.object({ kind: z.literal("update_organization"), summary: aiSummary.optional(), targetId: identifier, fields: organizationFields }).strict(),
  z.object({ kind: z.literal("create_timeline_track"), summary: aiSummary.optional(), fields: createTimelineTrackFields }).strict(),
  z.object({ kind: z.literal("update_timeline_track"), summary: aiSummary.optional(), targetId: identifier, fields: timelineTrackFields }).strict(),
  z.object({ kind: z.literal("create_timeline_event"), summary: aiSummary.optional(), fields: createTimelineEventFields }).strict(),
  z.object({ kind: z.literal("update_timeline_event"), summary: aiSummary.optional(), targetId: identifier, fields: timelineEventFields }).strict(),
  z.object({ kind: z.literal("create_relationship"), summary: aiSummary.optional(), fields: createRelationshipFields }).strict(),
  z.object({ kind: z.literal("update_relationship"), summary: aiSummary.optional(), targetId: identifier, fields: relationshipFields }).strict(),
  z.object({ kind: z.literal("upsert_outline"), summary: aiSummary.optional(), targetId: identifier, fields: outlineFields }).strict(),
  z.object({ kind: z.literal("create_foreshadow"), summary: aiSummary.optional(), fields: createForeshadowFields }).strict(),
  z.object({ kind: z.literal("update_foreshadow"), summary: aiSummary.optional(), targetId: identifier, fields: foreshadowFields }).strict(),
  z.object({
    kind: z.literal("create_chapter_annotation"),
    summary: aiSummary.optional(),
    fields: z.object({
      chapterId: identifier,
      kind: z.enum(["note", "todo"]),
      startLine: z.number().int().positive().max(100_000),
      endLine: z.number().int().positive().max(100_000),
      note: z.string().trim().min(1).max(20_000)
    }).strict().refine((value) => value.endLine >= value.startLine, { message: "引用结束行不能早于开始行", path: ["endLine"] })
      .refine((value) => value.endLine - value.startLine < 20, { message: "一次最多批注 20 行正文", path: ["endLine"] })
  }).strict(),
  z.object({
    kind: z.literal("create_analysis_task"),
    summary: aiSummary.optional(),
    fields: z.object({
      taskType: z.enum(analysisTaskTypes),
      modelId: identifier.optional(),
      scope: jsonObject.optional()
    }).strict()
  }).strict()
]);

export type AiWriteOperationInput = z.infer<typeof aiWriteOperationSchema>;

export const writeToolArgumentsSchema = z.object({
  summary: aiSummary,
  operations: z.array(aiWriteOperationSchema).min(1).max(AI_WRITE_PLAN_MAX_OPERATIONS_LIMIT)
}).strict();

export const askUserQuestionsArgumentsSchema = z.object({
  question: z.string().trim().min(1).max(2_000),
  options: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(200)
  }).strict()).min(2).max(8),
  allowCustom: z.boolean().default(true)
}).strict().superRefine((value, context) => {
  const ids = value.options.map((option) => option.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "选项标识不能重复" });
  }
});

export type AskUserQuestionsInput = z.infer<typeof askUserQuestionsArgumentsSchema>;

export type FieldDiff = {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
};

export type BuiltAiWriteOperation = {
  kind: AiWriteOperationKind;
  toolId: Exclude<WorkAgentWriteToolId, "ask_user_questions">;
  module: WorkPermissionModule;
  action: "create" | "update";
  targetId: string | null;
  targetWorkId: string;
  targetLabel: string;
  expectedVersionNo: number | null;
  requiredModules: WorkPermissionModule[];
  aiSummary: string;
  fields: Record<string, unknown>;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  diffs: FieldDiff[];
  annotation?: {
    kind: "note" | "todo";
    chapterId: string;
    chapterTitle: string;
    startLine: number;
    endLine: number;
    quote: string;
    note: string;
  };
  analysisTask?: {
    taskType: string;
    modelId: string | null;
    modelLabel: string;
    scope: Record<string, unknown>;
    scopeLabel: string;
  };
};

export type BuiltAiWritePlan = {
  workId: string;
  conversationId: string;
  aiSummary: string;
  requiredModules: WorkPermissionModule[];
  requiredToolIds: Array<Exclude<WorkAgentWriteToolId, "ask_user_questions">>;
  operations: BuiltAiWriteOperation[];
};

const ACCESS_RANK: Record<"none" | "read" | "write", number> = { none: 0, read: 1, write: 2 };
const ACCESS_VALUES = ["none", "read", "write"] as const;

export function resolveAiWritePlanMaxOperations(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_AI_WRITE_PLAN_MAX_OPERATIONS;
  if (!/^-?\d+$/u.test(value.trim())) {
    throw new AppError(400, "AI_WRITE_PLAN_MAX_OPERATIONS_INVALID", "AI_WRITE_PLAN_MAX_OPERATIONS 必须是 1 到 20 之间的整数");
  }
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > AI_WRITE_PLAN_MAX_OPERATIONS_LIMIT) {
    throw new AppError(400, "AI_WRITE_PLAN_MAX_OPERATIONS_INVALID", "AI_WRITE_PLAN_MAX_OPERATIONS 必须是 1 到 20 之间的整数");
  }
  return parsed;
}

export function intersectWorkModulePermissions(
  left: WorkModulePermissions | null,
  right: WorkModulePermissions | null
): WorkModulePermissions {
  const a = left ?? emptyWorkModulePermissions();
  const b = right ?? emptyWorkModulePermissions();
  const result = emptyWorkModulePermissions();
  for (const module of Object.keys(result) as WorkPermissionModule[]) {
    result[module] = ACCESS_VALUES[Math.min(ACCESS_RANK[a[module]], ACCESS_RANK[b[module]])] ?? "none";
  }
  return result;
}

export function operationKindsForWriteTool(toolId: Exclude<WorkAgentWriteToolId, "ask_user_questions">): AiWriteOperationKind[] {
  return AI_WRITE_OPERATION_KINDS.filter((kind) => OPERATION_KIND_TOOL_ID[kind] === toolId);
}

export function isEntityWriteToolId(toolId: string): toolId is Exclude<WorkAgentWriteToolId, "ask_user_questions"> {
  return Object.prototype.hasOwnProperty.call(WRITE_TOOL_PERMISSION_MODULE, toolId);
}

export function writeToolIdForFunctionName(name: string): WorkAgentWriteToolId | null {
  if (name === ASK_USER_QUESTIONS_TOOL_NAME) return "ask_user_questions";
  return WORK_AGENT_WRITE_TOOL_IDS.includes(name as WorkAgentWriteToolId) ? name as WorkAgentWriteToolId : null;
}

export function functionNameForWriteToolId(toolId: WorkAgentWriteToolId): string {
  return toolId === "ask_user_questions" ? ASK_USER_QUESTIONS_TOOL_NAME : toolId;
}

export function isWriteAgentToolName(name: string): boolean {
  return writeToolIdForFunctionName(name) !== null;
}

export function recommendedAskUserOptionLabel(label: string, index: number): string {
  const trimmed = label.trim();
  if (index !== 0) return trimmed;
  return trimmed.endsWith("（最推荐）") ? trimmed : `${trimmed}（最推荐）`;
}

export function formatFieldValue(value: unknown): string {
  if (value === undefined) return "（未设置）";
  if (value === null) return "（空）";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value === "" ? "（空）" : value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function buildFieldDiffs(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>
): FieldDiff[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])];
  const diffs: FieldDiff[] = [];
  for (const field of keys) {
    const previous = before ? before[field] : undefined;
    const next = after[field];
    if (stableEqual(previous, next)) continue;
    diffs.push({
      field,
      label: FIELD_LABELS[field] ?? field,
      before: before ? previous ?? null : null,
      after: next ?? null
    });
  }
  return diffs;
}

function stableEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(normalizeForCompare(left)) === JSON.stringify(normalizeForCompare(right));
  } catch {
    return false;
  }
}

function normalizeForCompare(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeForCompare(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort().map((key) => [key, normalizeForCompare((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

export function pickDefinedFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function analysisScopeLabel(scope: Record<string, unknown> | null | undefined): string {
  const type = String(scope?.type ?? "book");
  if (type === "chapter") return scope?.chapterId ? `指定章节 ${String(scope.chapterId)}` : "指定章节";
  if (type === "volume") return scope?.volumeId ? `指定分卷 ${String(scope.volumeId)}` : "指定分卷";
  if (type === "settings") return "设定范围";
  if (type === "none") return "无范围";
  if (type === "selection") return "选中正文";
  return "全书";
}

export function annotationKindLabel(kind: string): string {
  return kind === "todo" ? "待办" : "评论";
}

export function assertWriteToolsEnabled(
  enabledTools: readonly string[],
  toolIds: readonly WorkAgentWriteToolId[]
): void {
  for (const toolId of toolIds) {
    if (!enabledTools.includes(toolId)) {
      throw new AppError(403, "AI_WRITE_TOOL_DISABLED", `可写工具“${WRITE_TOOL_LABELS[toolId]}”未开启`);
    }
  }
}

export function assertIntersectedWriteAccess(
  permissions: WorkModulePermissions,
  modules: readonly WorkPermissionModule[]
): void {
  for (const module of modules) {
    if (!canWriteWorkModule(permissions, module)) {
      throw new AppError(403, "AI_WRITE_PERMISSION_DENIED", "当前用户与对话归属用户都没有执行该写入所需的模块权限");
    }
  }
}

export function assertIntersectedReadAccess(
  permissions: WorkModulePermissions,
  modules: readonly WorkPermissionModule[]
): void {
  for (const module of modules) {
    if (!canReadWorkModule(permissions, module)) {
      throw new AppError(403, "AI_WRITE_PERMISSION_DENIED", "当前用户与对话归属用户都没有读取该操作所需资料的权限");
    }
  }
}

export function redactSensitiveApprovalText(value: string): string {
  return value
    .replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"' \n]{6,}/giu, "[REDACTED]")
    .replace(/sk-[A-Za-z0-9]{10,}/gu, "[REDACTED]");
}
