/**
 * AI 可写工具与持久化审批工作流领域层。
 *
 * 核心原则：
 * - AI 只能提交修改计划（propose_writes），系统基于当前数据库内容生成不可变 diff；
 * - 所有计划与提问持久化保存，确认接口只接收审批 ID；
 * - 确认时重新校验权限交集、工具开关、作品归属与目标版本，原子执行；
 * - 每份审批只能成功执行一次；编辑类操作支持整体撤销。
 */
import { z } from "zod";
import {
  normalizeAiWriteToolSwitches,
  Store,
  type AiWriteToolKey,
  type AiWriteToolSwitches,
  type CharacterInput,
  type ChapterOutlineInput,
  type ForeshadowInput,
  type OrganizationInput,
  type RaceInput,
  type RelationshipInput,
  type SettingInput,
  type TimelineInput
} from "./store.js";
import { AppError } from "./errors.js";
import {
  canReadWorkModule,
  canWriteWorkModule,
  workPermissionModuleLabels,
  type WorkPermissionModule
} from "./work-permissions.js";
import { analysisTaskReadModules, UserAuthService, type AuthUser } from "./user-auth.js";
import { paginated, type Pagination } from "./pagination.js";
import { logger, sanitizeError } from "./logger.js";
import { id, json, now } from "./utils.js";

export const AI_WRITE_PLAN_STATUSES = [
  "pending",
  "rejected",
  "expired",
  "invalidated",
  "executing",
  "succeeded",
  "failed"
] as const;
export type AiWritePlanStatus = (typeof AI_WRITE_PLAN_STATUSES)[number];

export const AI_WRITE_OPERATION_TYPES = [
  "create_setting",
  "update_setting",
  "create_character",
  "update_character",
  "create_race",
  "update_race",
  "create_organization",
  "update_organization",
  "create_timeline_event",
  "update_timeline_event",
  "create_relationship",
  "update_relationship",
  "create_outline",
  "update_outline",
  "create_foreshadow",
  "update_foreshadow",
  "create_chapter_annotation",
  "create_analysis_task"
] as const;
export type AiWriteOperationType = (typeof AI_WRITE_OPERATION_TYPES)[number];

export const AI_QUESTION_STATUSES = ["pending", "answered", "expired", "cancelled"] as const;
export type AiQuestionStatus = (typeof AI_QUESTION_STATUSES)[number];

export const AI_WRITE_PLAN_TTL_MS = 24 * 60 * 60 * 1000;
export const AI_QUESTION_TTL_MS = 24 * 60 * 60 * 1000;

export const AI_WRITE_TOOL_LABELS: Record<AiWriteToolKey, string> = {
  settings: "世界设定",
  characters: "角色",
  races: "种族",
  organizations: "组织",
  timeline: "时间线",
  relationships: "人物关系",
  outlines: "大纲/伏笔",
  "chapter-annotations": "正文评论/待办",
  "analysis-tasks": "分析任务",
  "ask-user-questions": "AskUserQuestions"
};

type OperationDefinition = {
  module: WorkPermissionModule;
  toolKey: AiWriteToolKey;
  kind: "create" | "update";
};

const OPERATION_DEFINITIONS: Record<AiWriteOperationType, OperationDefinition> = {
  create_setting: { module: "settings", toolKey: "settings", kind: "create" },
  update_setting: { module: "settings", toolKey: "settings", kind: "update" },
  create_character: { module: "characters", toolKey: "characters", kind: "create" },
  update_character: { module: "characters", toolKey: "characters", kind: "update" },
  create_race: { module: "races", toolKey: "races", kind: "create" },
  update_race: { module: "races", toolKey: "races", kind: "update" },
  create_organization: { module: "organizations", toolKey: "organizations", kind: "create" },
  update_organization: { module: "organizations", toolKey: "organizations", kind: "update" },
  create_timeline_event: { module: "timeline", toolKey: "timeline", kind: "create" },
  update_timeline_event: { module: "timeline", toolKey: "timeline", kind: "update" },
  create_relationship: { module: "relationships", toolKey: "relationships", kind: "create" },
  update_relationship: { module: "relationships", toolKey: "relationships", kind: "update" },
  create_outline: { module: "outlines", toolKey: "outlines", kind: "create" },
  update_outline: { module: "outlines", toolKey: "outlines", kind: "update" },
  create_foreshadow: { module: "outlines", toolKey: "outlines", kind: "create" },
  update_foreshadow: { module: "outlines", toolKey: "outlines", kind: "update" },
  create_chapter_annotation: { module: "prose", toolKey: "chapter-annotations", kind: "create" },
  create_analysis_task: { module: "ai-analysis", toolKey: "analysis-tasks", kind: "create" }
};

export const AI_WRITE_OPERATION_LABELS: Record<AiWriteOperationType, string> = {
  create_setting: "新建世界设定",
  update_setting: "编辑世界设定",
  create_character: "新建角色",
  update_character: "编辑角色",
  create_race: "新建种族",
  update_race: "编辑种族",
  create_organization: "新建组织",
  update_organization: "编辑组织",
  create_timeline_event: "新建时间线事件",
  update_timeline_event: "编辑时间线事件",
  create_relationship: "新建人物关系",
  update_relationship: "编辑人物关系",
  create_outline: "新建章节大纲",
  update_outline: "编辑章节大纲",
  create_foreshadow: "新建伏笔",
  update_foreshadow: "编辑伏笔",
  create_chapter_annotation: "创建正文批注",
  create_analysis_task: "创建分析任务"
};

/** 每个词条实体允许 AI 修改的字段白名单（含中文标签）。 */
type FieldDefinition = { label: string; schema: z.ZodType };

const STRING_200 = z.string().min(1).max(200);
const TEXT_200K = z.string().min(1).max(200_000);

const ENTITY_FIELDS: Record<AiWriteOperationType, Record<string, FieldDefinition>> = {
  create_setting: {
    title: { label: "标题", schema: STRING_200 },
    category: { label: "分类", schema: z.string().min(1).max(100) },
    content: { label: "内容", schema: TEXT_200K },
    tags: { label: "标签", schema: z.array(z.string().max(200)).max(100) },
    status: { label: "状态", schema: z.enum(["draft", "pending", "confirmed", "deprecated"]) },
    locked: { label: "锁定", schema: z.boolean() },
    evidence: { label: "依据", schema: z.array(z.unknown()).max(500) },
    scope: { label: "适用范围", schema: z.record(z.string(), z.unknown()) },
    authorNote: { label: "作者备注", schema: z.string().max(20_000) }
  },
  update_setting: {
    title: { label: "标题", schema: STRING_200 },
    category: { label: "分类", schema: z.string().min(1).max(100) },
    content: { label: "内容", schema: TEXT_200K },
    tags: { label: "标签", schema: z.array(z.string().max(200)).max(100) },
    status: { label: "状态", schema: z.enum(["draft", "pending", "confirmed", "deprecated"]) },
    locked: { label: "锁定", schema: z.boolean() },
    evidence: { label: "依据", schema: z.array(z.unknown()).max(500) },
    scope: { label: "适用范围", schema: z.record(z.string(), z.unknown()) },
    authorNote: { label: "作者备注", schema: z.string().max(20_000) }
  },
  create_character: {
    name: { label: "姓名", schema: STRING_200 },
    isDead: { label: "已死亡", schema: z.boolean() },
    code: { label: "代号", schema: z.string().trim().max(200) },
    aliases: { label: "别名", schema: z.array(z.string().trim().min(1).max(200)).max(100) },
    raceId: { label: "种族", schema: z.string().max(200).nullable() },
    species: { label: "物种", schema: z.string().max(200) },
    organizationIds: { label: "所属组织", schema: z.array(z.string().max(200)).max(100) },
    attributes: { label: "属性", schema: z.record(z.string(), z.unknown()) },
    profile: { label: "人物档案", schema: z.record(z.string(), z.unknown()) },
    currentState: { label: "当前状态", schema: z.record(z.string(), z.unknown()) },
    lockedFields: { label: "锁定字段", schema: z.array(z.string().max(200)).max(100) },
    firstChapterId: { label: "首次登场章节", schema: z.string().max(200).nullable() }
  },
  update_character: {
    name: { label: "姓名", schema: STRING_200 },
    isDead: { label: "已死亡", schema: z.boolean() },
    code: { label: "代号", schema: z.string().trim().max(200) },
    aliases: { label: "别名", schema: z.array(z.string().trim().min(1).max(200)).max(100) },
    raceId: { label: "种族", schema: z.string().max(200).nullable() },
    species: { label: "物种", schema: z.string().max(200) },
    organizationIds: { label: "所属组织", schema: z.array(z.string().max(200)).max(100) },
    attributes: { label: "属性", schema: z.record(z.string(), z.unknown()) },
    profile: { label: "人物档案", schema: z.record(z.string(), z.unknown()) },
    currentState: { label: "当前状态", schema: z.record(z.string(), z.unknown()) },
    lockedFields: { label: "锁定字段", schema: z.array(z.string().max(200)).max(100) },
    firstChapterId: { label: "首次登场章节", schema: z.string().max(200).nullable() }
  },
  create_race: {
    name: { label: "名称", schema: STRING_200 },
    isExtinct: { label: "已灭绝", schema: z.boolean() },
    parentRaceId: { label: "上级种族", schema: z.string().max(200).nullable() },
    description: { label: "描述", schema: z.string().max(100_000) },
    settings: { label: "设定条目", schema: z.array(z.string().trim().min(1).max(20_000)).max(200) },
    settingsMarkdown: { label: "设定正文", schema: z.string().max(200_000) },
    memberIds: { label: "成员", schema: z.array(z.string().max(200)).max(1000) }
  },
  update_race: {
    name: { label: "名称", schema: STRING_200 },
    isExtinct: { label: "已灭绝", schema: z.boolean() },
    parentRaceId: { label: "上级种族", schema: z.string().max(200).nullable() },
    description: { label: "描述", schema: z.string().max(100_000) },
    settings: { label: "设定条目", schema: z.array(z.string().trim().min(1).max(20_000)).max(200) },
    settingsMarkdown: { label: "设定正文", schema: z.string().max(200_000) },
    memberIds: { label: "成员", schema: z.array(z.string().max(200)).max(1000) }
  },
  create_organization: {
    name: { label: "名称", schema: STRING_200 },
    isDissolved: { label: "已解散", schema: z.boolean() },
    description: { label: "描述", schema: z.string().max(100_000) },
    settings: { label: "设定条目", schema: z.array(z.string().trim().min(1).max(20_000)).max(200) },
    settingsMarkdown: { label: "设定正文", schema: z.string().max(200_000) },
    memberIds: { label: "成员", schema: z.array(z.string().max(200)).max(1000) }
  },
  update_organization: {
    name: { label: "名称", schema: STRING_200 },
    isDissolved: { label: "已解散", schema: z.boolean() },
    description: { label: "描述", schema: z.string().max(100_000) },
    settings: { label: "设定条目", schema: z.array(z.string().trim().min(1).max(20_000)).max(200) },
    settingsMarkdown: { label: "设定正文", schema: z.string().max(200_000) },
    memberIds: { label: "成员", schema: z.array(z.string().max(200)).max(1000) }
  },
  create_timeline_event: {
    name: { label: "事件名称", schema: z.string().min(1).max(300) },
    trackId: { label: "时间线轨道", schema: z.string().max(200).nullable() },
    description: { label: "描述", schema: z.string().max(100_000) },
    eventType: { label: "事件类型", schema: z.string().max(100) },
    timeLabel: { label: "时间标签", schema: z.string().max(300) },
    timeSort: { label: "时间排序值", schema: z.number().finite().nullable() },
    chapterIds: { label: "关联章节", schema: z.array(z.string().max(200)).max(100) },
    participantIds: { label: "参与者", schema: z.array(z.string().max(200)).max(100) },
    location: { label: "地点", schema: z.string().max(500) },
    causes: { label: "起因", schema: z.array(z.string().max(500)).max(100) },
    impactScope: { label: "影响范围", schema: z.enum(["personal", "organization", "regional", "world", "galaxy"]) },
    evidence: { label: "依据", schema: z.array(z.unknown()).max(500) },
    status: { label: "状态", schema: z.enum(["candidate", "pending", "confirmed", "deprecated"]) }
  },
  update_timeline_event: {
    name: { label: "事件名称", schema: z.string().min(1).max(300) },
    trackId: { label: "时间线轨道", schema: z.string().max(200).nullable() },
    description: { label: "描述", schema: z.string().max(100_000) },
    eventType: { label: "事件类型", schema: z.string().max(100) },
    timeLabel: { label: "时间标签", schema: z.string().max(300) },
    timeSort: { label: "时间排序值", schema: z.number().finite().nullable() },
    chapterIds: { label: "关联章节", schema: z.array(z.string().max(200)).max(100) },
    participantIds: { label: "参与者", schema: z.array(z.string().max(200)).max(100) },
    location: { label: "地点", schema: z.string().max(500) },
    causes: { label: "起因", schema: z.array(z.string().max(500)).max(100) },
    impactScope: { label: "影响范围", schema: z.enum(["personal", "organization", "regional", "world", "galaxy"]) },
    evidence: { label: "依据", schema: z.array(z.unknown()).max(500) },
    status: { label: "状态", schema: z.enum(["candidate", "pending", "confirmed", "deprecated"]) }
  },
  create_relationship: {
    fromCharacterId: { label: "角色 A", schema: z.string().max(200) },
    toCharacterId: { label: "角色 B", schema: z.string().max(200) },
    category: { label: "关系分类", schema: z.enum(["family", "social", "emotional", "conflict", "uncertain"]) },
    subtype: { label: "关系子类型", schema: z.string().max(100) },
    keywords: { label: "关键词", schema: z.array(z.string().trim().min(1).max(100)).max(30) },
    directed: { label: "单向关系", schema: z.boolean() },
    currentStatus: { label: "当前状态", schema: z.string().max(100) },
    timeRange: { label: "时间范围", schema: z.record(z.string(), z.unknown()) },
    confidence: { label: "可信度", schema: z.number().min(0).max(1) },
    evidence: { label: "依据", schema: z.array(z.unknown()).max(500) },
    confirmationStatus: { label: "确认状态", schema: z.enum(["pending", "confirmed", "rejected"]) },
    locked: { label: "锁定", schema: z.boolean() }
  },
  update_relationship: {
    fromCharacterId: { label: "角色 A", schema: z.string().max(200) },
    toCharacterId: { label: "角色 B", schema: z.string().max(200) },
    category: { label: "关系分类", schema: z.enum(["family", "social", "emotional", "conflict", "uncertain"]) },
    subtype: { label: "关系子类型", schema: z.string().max(100) },
    keywords: { label: "关键词", schema: z.array(z.string().trim().min(1).max(100)).max(30) },
    directed: { label: "单向关系", schema: z.boolean() },
    currentStatus: { label: "当前状态", schema: z.string().max(100) },
    timeRange: { label: "时间范围", schema: z.record(z.string(), z.unknown()) },
    confidence: { label: "可信度", schema: z.number().min(0).max(1) },
    evidence: { label: "依据", schema: z.array(z.unknown()).max(500) },
    confirmationStatus: { label: "确认状态", schema: z.enum(["pending", "confirmed", "rejected"]) },
    locked: { label: "锁定", schema: z.boolean() }
  },
  create_outline: {
    chapterId: { label: "章节", schema: z.string().max(200) },
    goal: { label: "本章目标", schema: z.string().max(100_000) },
    conflict: { label: "冲突", schema: z.string().max(100_000) },
    turningPoint: { label: "转折点", schema: z.string().max(100_000) },
    notes: { label: "备注", schema: z.string().max(100_000) },
    status: { label: "状态", schema: z.enum(["draft", "ready", "completed"]) }
  },
  update_outline: {
    goal: { label: "本章目标", schema: z.string().max(100_000) },
    conflict: { label: "冲突", schema: z.string().max(100_000) },
    turningPoint: { label: "转折点", schema: z.string().max(100_000) },
    notes: { label: "备注", schema: z.string().max(100_000) },
    status: { label: "状态", schema: z.enum(["draft", "ready", "completed"]) }
  },
  create_foreshadow: {
    title: { label: "标题", schema: z.string().min(1).max(300) },
    description: { label: "描述", schema: z.string().max(100_000) },
    status: { label: "状态", schema: z.enum(["planned", "planted", "resolved", "abandoned"]) },
    importance: { label: "重要程度", schema: z.enum(["low", "medium", "high"]) },
    plannedPayoffChapterId: { label: "预计揭晓章节", schema: z.string().max(200).nullable() },
    resolutionNote: { label: "揭晓说明", schema: z.string().max(100_000) }
  },
  update_foreshadow: {
    title: { label: "标题", schema: z.string().min(1).max(300) },
    description: { label: "描述", schema: z.string().max(100_000) },
    status: { label: "状态", schema: z.enum(["planned", "planted", "resolved", "abandoned"]) },
    importance: { label: "重要程度", schema: z.enum(["low", "medium", "high"]) },
    plannedPayoffChapterId: { label: "预计揭晓章节", schema: z.string().max(200).nullable() },
    resolutionNote: { label: "揭晓说明", schema: z.string().max(100_000) }
  },
  create_chapter_annotation: {
    chapterId: { label: "章节", schema: z.string().max(200) },
    kind: { label: "批注类型", schema: z.enum(["note", "todo"]) },
    startLine: { label: "起始行", schema: z.number().int().min(1).max(1_000_000) },
    endLine: { label: "结束行", schema: z.number().int().min(1).max(1_000_000) },
    note: { label: "批注内容", schema: z.string().trim().min(1).max(50_000) }
  },
  create_analysis_task: {
    taskType: { label: "任务类型", schema: z.string().min(1).max(100) },
    scope: { label: "分析范围", schema: z.record(z.string(), z.unknown()) },
    modelId: { label: "模型", schema: z.string().max(200) }
  }
};

const ANNOTATION_KIND_LABELS: Record<string, string> = { note: "评论", todo: "待办" };
const ANALYSIS_TASK_TYPE_LABELS: Record<string, string> = {
  structure: "全书结构分析",
  "chapter-analysis": "章节分析",
  "character-extraction": "角色抽取",
  "character-summary": "角色总结",
  "character-identity-audit": "角色身份审核",
  "timeline-analysis": "时间线分析",
  "relationship-analysis": "人物关系分析",
  "worldview-analysis": "世界观分析",
  "setting-extraction": "设定抽取",
  "consistency-check": "一致性检查",
  "report-update": "报告更新",
  "book-analysis": "全书分析"
};

/** 计划操作快照：由系统基于数据库当前内容生成，确认时原样执行。 */
export type AiWritePlanOperation = {
  id: string;
  operationType: AiWriteOperationType;
  module: WorkPermissionModule;
  moduleLabel: string;
  toolKey: AiWriteToolKey;
  aiSummary: string;
  targetId: string | null;
  targetLabel: string;
  targetVersionNo: number | null;
  changes: Array<{ field: string; label: string; before: unknown; after: unknown }>;
  payload: Record<string, unknown>;
  /** 正文批注专用：引用正文行内容（系统在计划生成时快照）。 */
  referencedText?: string;
  result: Record<string, unknown> | null;
  failure: string;
};

export type AiWritePlanRecord = {
  id: string;
  workId: string;
  conversationId: string | null;
  requesterUserId: string | null;
  requesterDisplayName: string;
  ownerUserId: string | null;
  ownerDisplayName: string;
  status: AiWritePlanStatus;
  summary: string;
  operations: AiWritePlanOperation[];
  expiresAt: string;
  rejectedAt: string | null;
  rejectedByUserId: string | null;
  executedAt: string | null;
  executedByUserId: string | null;
  invalidationReason: string;
  revokedAt: string | null;
  revokedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AiQuestionRecord = {
  id: string;
  workId: string;
  conversationId: string | null;
  requesterUserId: string | null;
  ownerUserId: string | null;
  question: string;
  options: string[];
  recommendedIndex: number;
  allowCustomAnswer: boolean;
  status: AiQuestionStatus;
  answer: { type: "option"; index: number } | { type: "custom"; text: string } | null;
  answeredAt: string | null;
  answeredByUserId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

/** 校验计划时发现的第一条失效原因。 */
export type PlanInvalidation = {
  code: string;
  message: string;
};

const MAX_PLAN_SUMMARY_LENGTH = 500;
const MAX_OPERATION_SUMMARY_LENGTH = 300;
const MAX_QUESTION_LENGTH = 500;
const MAX_QUESTION_OPTIONS = 8;
const MAX_QUESTION_OPTION_LENGTH = 200;
const MAX_CUSTOM_ANSWER_LENGTH = 500;

const ANALYSIS_TASK_TYPES = new Set([
  "structure",
  "chapter-analysis",
  "character-extraction",
  "character-summary",
  "character-identity-audit",
  "timeline-analysis",
  "relationship-analysis",
  "worldview-analysis",
  "setting-extraction",
  "consistency-check",
  "report-update",
  "book-analysis"
]);

/**
 * 解析 AI_WRITE_PLAN_MAX_OPERATIONS 环境变量；默认 5，有效范围 1-20，
 * 无效配置回退默认值并记录警告。
 */
export function aiWritePlanMaxOperations(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AI_WRITE_PLAN_MAX_OPERATIONS;
  if (!raw) return 5;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 20) {
    logger.warn("ai_write.plan.max_operations.invalid", { raw, fallback: 5 });
    return 5;
  }
  return value;
}

export class AiWriteApprovalService {
  private readonly maxOperations: number;

  constructor(
    private readonly store: Store,
    private readonly auth: UserAuthService,
    private readonly createAnalysisTask: (workId: string, input: {
      taskType: string;
      scope?: Record<string, unknown>;
      modelId?: string;
    }) => Record<string, unknown>,
    maxOperations = aiWritePlanMaxOperations()
  ) {
    this.maxOperations = Math.min(20, Math.max(1, maxOperations));
  }

  // ------------------------------------------------------------------
  // 提问（AskUserQuestions）
  // ------------------------------------------------------------------

  createQuestion(input: {
    workId: string;
    conversationId: string | null;
    requesterUserId: string | null;
    ownerUserId: string | null;
    question: string;
    options: string[];
    allowCustomAnswer: boolean;
  }): Record<string, unknown> {
    const question = input.question.trim();
    if (!question || question.length > MAX_QUESTION_LENGTH) {
      throw new AppError(400, "AI_QUESTION_INVALID", "提问内容必须为 1-500 个字符");
    }
    const options = input.options.map((option) => option.trim()).filter(Boolean);
    if (options.length < 2) {
      throw new AppError(400, "AI_QUESTION_OPTIONS_REQUIRED", "每次提问必须提供至少两个预置选项");
    }
    if (options.length > MAX_QUESTION_OPTIONS) {
      throw new AppError(400, "AI_QUESTION_OPTIONS_TOO_MANY", `每次提问最多提供 ${MAX_QUESTION_OPTIONS} 个预置选项`);
    }
    if (options.some((option) => option.length > MAX_QUESTION_OPTION_LENGTH)) {
      throw new AppError(400, "AI_QUESTION_OPTION_TOO_LONG", `预置选项不能超过 ${MAX_QUESTION_OPTION_LENGTH} 个字符`);
    }
    const questionId = id("aiq");
    const timestamp = now();
    const expiresAt = new Date(Date.now() + AI_QUESTION_TTL_MS).toISOString();
    this.store.db.run(
      `INSERT INTO ai_questions (
         id, work_id, conversation_id, requester_user_id, owner_user_id, question, options_json,
         recommended_index, allow_custom_answer, status, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'pending', ?, ?, ?)`,
      questionId,
      input.workId,
      input.conversationId,
      input.requesterUserId,
      input.ownerUserId,
      question,
      JSON.stringify(options),
      input.allowCustomAnswer ? 1 : 0,
      expiresAt,
      timestamp,
      timestamp
    );
    this.store.audit(input.workId, "ai.question.created", "ai-question", questionId, {
      question,
      options,
      allowCustomAnswer: input.allowCustomAnswer
    });
    return {
      ok: true,
      questionId,
      status: "pending" as const,
      question,
      options,
      recommendedIndex: 0,
      allowCustomAnswer: input.allowCustomAnswer
    };
  }

  getQuestion(questionId: string): AiQuestionRecord {
    return this.requireQuestion(questionId);
  }

  private requireQuestion(questionId: string): AiQuestionRecord {
    const row = this.store.db.get("SELECT * FROM ai_questions WHERE id = ?", questionId);
    if (!row) throw new AppError(404, "AI_QUESTION_NOT_FOUND", "提问不存在或已被删除");
    return this.mapQuestion(row as Record<string, unknown>);
  }

  private mapQuestion(row: Record<string, unknown>): AiQuestionRecord {
    const status = String(row.status ?? "pending");
    let resolvedStatus: AiQuestionStatus = "pending";
    if (status === "pending") {
      const expiresAt = Number(new Date(String(row.expires_at)).getTime());
      if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
        resolvedStatus = "expired";
        this.store.db.run("UPDATE ai_questions SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'", now(), String(row.id));
      } else {
        resolvedStatus = "pending";
      }
    } else if (AI_QUESTION_STATUSES.includes(status as AiQuestionStatus)) {
      resolvedStatus = status as AiQuestionStatus;
    }
    const answerValue = json<Record<string, unknown> | null>(String(row.answer_json ?? ""), null);
    const answer = answerValue === null ? null : answerValue.type === "option" && typeof answerValue.index === "number"
      ? { type: "option" as const, index: answerValue.index }
      : answerValue.type === "custom" && typeof answerValue.text === "string"
        ? { type: "custom" as const, text: answerValue.text }
        : null;
    return {
      id: String(row.id),
      workId: String(row.work_id),
      conversationId: row.conversation_id === null || row.conversation_id === undefined ? null : String(row.conversation_id),
      requesterUserId: row.requester_user_id === null || row.requester_user_id === undefined ? null : String(row.requester_user_id),
      ownerUserId: row.owner_user_id === null || row.owner_user_id === undefined ? null : String(row.owner_user_id),
      question: String(row.question ?? ""),
      options: json<string[]>(String(row.options_json ?? "[]"), []),
      recommendedIndex: Math.max(0, Number(row.recommended_index ?? 0)),
      allowCustomAnswer: Number(row.allow_custom_answer ?? 1) === 1,
      status: resolvedStatus,
      answer,
      answeredAt: row.answered_at === null || row.answered_at === undefined ? null : String(row.answered_at),
      answeredByUserId: row.answered_by_user_id === null || row.answered_by_user_id === undefined ? null : String(row.answered_by_user_id),
      expiresAt: String(row.expires_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  answerQuestion(questionId: string, answer: { type: "option"; index: number } | { type: "custom"; text: string }, actor: AuthUser): AiQuestionRecord {
    const question = this.requireQuestion(questionId);
    if (question.status === "answered") throw new AppError(409, "AI_QUESTION_ALREADY_ANSWERED", "该提问已经回答过");
    if (question.status !== "pending") {
      throw new AppError(409, "AI_QUESTION_NOT_PENDING", question.status === "expired" ? "该提问已过期，请重新提问" : "该提问已关闭");
    }
    const permitted = (question.requesterUserId && question.requesterUserId === actor.userId)
      || (question.ownerUserId && question.ownerUserId === actor.userId)
      || actor.role === "admin";
    if (!permitted) throw new AppError(403, "AI_QUESTION_ANSWER_DENIED", "只有提问发起人或对话归属用户可以回答该提问");
    let normalizedAnswer: { type: "option"; index: number } | { type: "custom"; text: string };
    if (answer.type === "option") {
      if (!Number.isInteger(answer.index) || answer.index < 0 || answer.index >= question.options.length) {
        throw new AppError(400, "AI_QUESTION_OPTION_INVALID", "选择的预置选项不存在");
      }
      normalizedAnswer = { type: "option", index: answer.index };
    } else {
      const text = answer.text.trim();
      if (!text) throw new AppError(400, "AI_QUESTION_ANSWER_REQUIRED", "自定义回答不能为空");
      if (text.length > MAX_CUSTOM_ANSWER_LENGTH) throw new AppError(400, "AI_QUESTION_ANSWER_TOO_LONG", `自定义回答不能超过 ${MAX_CUSTOM_ANSWER_LENGTH} 个字符`);
      if (!question.allowCustomAnswer) throw new AppError(400, "AI_QUESTION_CUSTOM_DENIED", "该提问不支持自定义回答");
      normalizedAnswer = { type: "custom", text };
    }
    const timestamp = now();
    this.store.db.run(
      `UPDATE ai_questions SET status = 'answered', answer_json = ?, answered_at = ?, answered_by_user_id = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      JSON.stringify(normalizedAnswer),
      timestamp,
      actor.userId,
      timestamp,
      questionId
    );
    this.store.audit(question.workId, "ai.question.answered", "ai-question", questionId, { answer: normalizedAnswer });
    return this.requireQuestion(questionId);
  }

  /** 供 AI 工具重入时读取提问状态；回答必须由用户通过审批入口给出。 */
  questionToolResult(questionId: string): Record<string, unknown> {
    const question = this.requireQuestion(questionId);
    if (question.status === "pending") {
      return {
        ok: true,
        questionId: question.id,
        status: "pending",
        message: "提问仍在等待作者回答，不得伪造或假设任何回答，必须先等待作者在界面上完成回答。"
      };
    }
    if (question.status === "expired" || question.status === "cancelled") {
      return {
        ok: true,
        questionId: question.id,
        status: question.status,
        message: "该提问已过期或关闭，可以重新提问；不得使用任何未经确认的回答继续写操作。"
      };
    }
    return {
      ok: true,
      questionId: question.id,
      status: "answered",
      question: question.question,
      answer: question.answer,
      answeredByUserId: question.answeredByUserId
    };
  }

  // ------------------------------------------------------------------
  // 修改计划
  // ------------------------------------------------------------------

  /** AI 可写工具入口：只生成并持久化修改计划，不执行任何写入。 */
  proposeWrites(input: {
    workId: string;
    conversationId: string | null;
    requesterUserId: string | null;
    ownerUserId: string | null;
    summary: string;
    operations: Array<{
      operationType: string;
      targetId?: string | null;
      summary?: string;
      changes: Record<string, unknown>;
    }>;
  }): Record<string, unknown> {
    const summary = input.summary.trim();
    if (!summary || summary.length > MAX_PLAN_SUMMARY_LENGTH) {
      throw new AppError(400, "AI_WRITE_PLAN_SUMMARY_INVALID", `计划简述必须为 1-${MAX_PLAN_SUMMARY_LENGTH} 个字符`);
    }
    if (input.operations.length === 0) {
      throw new AppError(400, "AI_WRITE_PLAN_EMPTY", "修改计划至少包含一项操作");
    }
    if (input.operations.length > this.maxOperations) {
      throw new AppError(400, "AI_WRITE_PLAN_TOO_MANY_OPERATIONS", `每份修改计划最多包含 ${this.maxOperations} 项操作`);
    }
    const operations = input.operations.map((raw) => this.buildOperation(input.workId, raw));
    // 提交计划时即校验权限交集与工具开关，未开启或无权时不允许生成计划。
    const requesterUser = input.requesterUserId ? this.auth.getUser(input.requesterUserId) : null;
    const failure = this.validatePlanPermissions(input.workId, input.requesterUserId, input.ownerUserId, requesterUser, operations);
    if (failure) {
      throw new AppError(403, "AI_WRITE_PLAN_FORBIDDEN", failure.message, { reason: failure.code });
    }
    const planId = id("aiwp");
    const timestamp = now();
    const expiresAt = new Date(Date.now() + AI_WRITE_PLAN_TTL_MS).toISOString();
    this.store.db.run(
      `INSERT INTO ai_write_plans (
         id, work_id, conversation_id, requester_user_id, owner_user_id, status, summary,
         operations_json, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      planId,
      input.workId,
      input.conversationId,
      input.requesterUserId,
      input.ownerUserId,
      summary,
      JSON.stringify(operations),
      expiresAt,
      timestamp,
      timestamp
    );
    this.store.audit(input.workId, "ai.write-plan.created", "ai-write-plan", planId, {
      summary,
      operationCount: operations.length,
      operations: operations.map((operation) => ({
        operationType: operation.operationType,
        targetId: operation.targetId,
        targetVersionNo: operation.targetVersionNo
      }))
    });
    return {
      ok: true,
      planId,
      status: "pending" as const,
      summary,
      operationCount: operations.length,
      expiresAt,
      operations: operations.map((operation) => operationSummary(operation))
    };
  }

  private buildOperation(workId: string, raw: {
    operationType: string;
    targetId?: string | null;
    summary?: string;
    changes: Record<string, unknown>;
  }): AiWritePlanOperation {
    const operationType = AI_WRITE_OPERATION_TYPES.includes(raw.operationType as AiWriteOperationType)
      ? raw.operationType as AiWriteOperationType
      : null;
    if (!operationType) {
      throw new AppError(400, "AI_WRITE_OPERATION_TYPE_INVALID", `不支持的操作类型：${raw.operationType}`);
    }
    const definition = OPERATION_DEFINITIONS[operationType];
    const aiSummary = (raw.summary ?? "").trim();
    if (!aiSummary || aiSummary.length > MAX_OPERATION_SUMMARY_LENGTH) {
      throw new AppError(400, "AI_WRITE_OPERATION_SUMMARY_INVALID", `每项操作的简述必须为 1-${MAX_OPERATION_SUMMARY_LENGTH} 个字符`);
    }
    const fields = ENTITY_FIELDS[operationType];
    if (operationType === "create_chapter_annotation") return this.buildChapterAnnotationOperation(workId, raw, aiSummary);
    if (operationType === "create_analysis_task") return this.buildAnalysisTaskOperation(raw, aiSummary);
    if (operationType === "create_outline") return this.buildCreateOutlineOperation(workId, raw, aiSummary);

    const parsedFields = this.parseChanges(operationType, fields, raw.changes);
    if (definition.kind === "create") {
      return this.buildCreateOperation(workId, operationType, raw, aiSummary, parsedFields);
    }
    return this.buildUpdateOperation(workId, operationType, raw, aiSummary, parsedFields);
  }

  private parseChanges(operationType: AiWriteOperationType, fields: Record<string, FieldDefinition>, changes: Record<string, unknown>): Record<string, unknown> {
    const parsed: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(changes)) {
      const definition = fields[field];
      if (!definition) {
        throw new AppError(400, "AI_WRITE_FIELD_NOT_ALLOWED", `操作类型 ${operationType} 不支持修改字段：${field}`);
      }
      const result = definition.schema.safeParse(value);
      if (!result.success) {
        const details = result.error.issues.map((issue) => `${issue.path.join(".") || field}: ${issue.message}`).join("; ");
        throw new AppError(400, "AI_WRITE_FIELD_INVALID", `字段 ${field} 的值无效：${details}`);
      }
      parsed[field] = result.data;
    }
    if (Object.keys(parsed).length === 0) {
      throw new AppError(400, "AI_WRITE_OPERATION_EMPTY", `操作类型 ${operationType} 至少需要一个修改字段`);
    }
    return parsed;
  }

  private buildCreateOperation(
    workId: string,
    operationType: AiWriteOperationType,
    raw: { targetId?: string | null; changes: Record<string, unknown> },
    aiSummary: string,
    parsedFields: Record<string, unknown>
  ): AiWritePlanOperation {
    // 新建操作不能携带目标 ID。
    if (raw.targetId) {
      throw new AppError(400, "AI_WRITE_CREATE_WITH_TARGET", `操作类型 ${operationType} 是新建操作，不能携带目标 ID`);
    }
    const definition = OPERATION_DEFINITIONS[operationType];
    const targetLabel = this.createTargetLabel(operationType, parsedFields);
    this.assertCreateReferences(workId, operationType, parsedFields);
    const changes = Object.entries(parsedFields).map(([field, after]) => ({
      field,
      label: ENTITY_FIELDS[operationType][field]?.label ?? field,
      before: null,
      after
    }));
    return {
      id: id("aiwop"),
      operationType,
      module: definition.module,
      moduleLabel: workPermissionModuleLabels[definition.module],
      toolKey: definition.toolKey,
      aiSummary,
      targetId: null,
      targetLabel,
      targetVersionNo: null,
      changes,
      payload: parsedFields,
      result: null,
      failure: ""
    };
  }

  private buildUpdateOperation(
    workId: string,
    operationType: AiWriteOperationType,
    raw: { targetId?: string | null; changes: Record<string, unknown> },
    aiSummary: string,
    parsedFields: Record<string, unknown>
  ): AiWritePlanOperation {
    const targetId = (raw.targetId ?? "").trim();
    if (!targetId) throw new AppError(400, "AI_WRITE_UPDATE_TARGET_REQUIRED", `操作类型 ${operationType} 必须提供目标对象 ID`);
    const current = this.currentEntity(workId, operationType, targetId);
    this.assertUpdateReferences(workId, operationType, current, parsedFields);
    const versionNo = Number(current.versionNo ?? 0);
    const changes = Object.entries(parsedFields).flatMap(([field, after]) => {
      const before = this.fieldValue(current, field);
      const beforeSerialized = before === undefined ? null : before;
      if (JSON.stringify(beforeSerialized) === JSON.stringify(after)) return [];
      return [{
        field,
        label: ENTITY_FIELDS[operationType][field]?.label ?? field,
        before: beforeSerialized,
        after
      }];
    });
    if (changes.length === 0) {
      throw new AppError(409, "AI_WRITE_UPDATE_NO_CHANGE", `目标对象 ${targetId} 的字段值与当前内容一致，没有需要执行的修改`);
    }
    return {
      id: id("aiwop"),
      operationType,
      module: OPERATION_DEFINITIONS[operationType].module,
      moduleLabel: workPermissionModuleLabels[OPERATION_DEFINITIONS[operationType].module],
      toolKey: OPERATION_DEFINITIONS[operationType].toolKey,
      aiSummary,
      targetId,
      targetLabel: this.entityLabel(operationType, current),
      targetVersionNo: versionNo,
      changes,
      payload: Object.fromEntries(changes.map((change) => [change.field, change.after])),
      result: null,
      failure: ""
    };
  }

  private buildChapterAnnotationOperation(workId: string, raw: {
    targetId?: string | null;
    changes: Record<string, unknown>;
  }, aiSummary: string): AiWritePlanOperation {
    if (raw.targetId) throw new AppError(400, "AI_WRITE_CREATE_WITH_TARGET", "创建正文批注不能携带目标 ID");
    const fields = ENTITY_FIELDS.create_chapter_annotation;
    const parsed = this.parseChanges("create_chapter_annotation", fields, raw.changes) as {
      chapterId: string;
      kind: "note" | "todo";
      startLine: number;
      endLine: number;
      note: string;
    };
    if (parsed.endLine < parsed.startLine) {
      throw new AppError(400, "ANNOTATION_LINE_RANGE_INVALID", "批注结束行不能早于开始行");
    }
    if (parsed.endLine - parsed.startLine >= 20) {
      throw new AppError(400, "ANNOTATION_LINE_RANGE_TOO_LARGE", "一次最多批注 20 行正文");
    }
    let chapter: Record<string, unknown>;
    try {
      chapter = this.store.getChapter(parsed.chapterId);
    } catch {
      throw new AppError(404, "CHAPTER_NOT_FOUND", `批注目标章节不存在：${parsed.chapterId}`);
    }
    if (String(chapter.workId) !== workId) {
      throw new AppError(400, "CHAPTER_WORK_MISMATCH", "批注目标章节不属于当前作品");
    }
    const lines = String(chapter.content ?? "").replace(/\r\n?/gu, "\n").split("\n");
    if (parsed.startLine > lines.length || parsed.endLine > lines.length) {
      throw new AppError(400, "ANNOTATION_LINE_RANGE_INVALID", "批注行号超出当前正文范围");
    }
    const referencedText = lines.slice(parsed.startLine - 1, parsed.endLine).join("\n");
    const changes = [
      { field: "chapterId", label: "章节", before: null, after: `${String(chapter.title)}（${parsed.chapterId}）` },
      { field: "kind", label: "批注类型", before: null, after: ANNOTATION_KIND_LABELS[parsed.kind] ?? parsed.kind },
      { field: "lines", label: "行号", before: null, after: parsed.startLine === parsed.endLine ? `第 ${parsed.startLine} 行` : `第 ${parsed.startLine}-${parsed.endLine} 行` },
      { field: "note", label: "批注内容", before: null, after: parsed.note }
    ];
    return {
      id: id("aiwop"),
      operationType: "create_chapter_annotation",
      module: "prose",
      moduleLabel: workPermissionModuleLabels.prose,
      toolKey: "chapter-annotations",
      aiSummary,
      targetId: parsed.chapterId,
      targetLabel: `章节“${String(chapter.title)}”`,
      targetVersionNo: Number(chapter.versionNo ?? 0),
      changes,
      payload: {
        chapterId: parsed.chapterId,
        kind: parsed.kind,
        startLine: parsed.startLine,
        endLine: parsed.endLine,
        note: parsed.note
      },
      referencedText,
      result: null,
      failure: ""
    };
  }

  private buildAnalysisTaskOperation(raw: {
    targetId?: string | null;
    changes: Record<string, unknown>;
  }, aiSummary: string): AiWritePlanOperation {
    if (raw.targetId) throw new AppError(400, "AI_WRITE_CREATE_WITH_TARGET", "创建分析任务不能携带目标 ID");
    const parsed = this.parseChanges("create_analysis_task", ENTITY_FIELDS.create_analysis_task, raw.changes) as {
      taskType: string;
      scope: Record<string, unknown>;
      modelId?: string;
    };
    if (!ANALYSIS_TASK_TYPES.has(parsed.taskType)) {
      throw new AppError(400, "ANALYSIS_TASK_TYPE_INVALID", `不支持的分析任务类型：${parsed.taskType}`);
    }
    if (parsed.modelId !== undefined && !parsed.modelId.trim()) {
      throw new AppError(400, "ANALYSIS_MODEL_INVALID", "分析任务模型 ID 不能为空");
    }
    const scopeLabel = analysisScopeSummary(parsed.scope);
    const changes = [
      { field: "taskType", label: "任务类型", before: null, after: ANALYSIS_TASK_TYPE_LABELS[parsed.taskType] ?? parsed.taskType },
      ...(parsed.modelId !== undefined ? [{ field: "modelId", label: "模型", before: null, after: parsed.modelId }] : []),
      { field: "scope", label: "分析范围", before: null, after: scopeLabel }
    ];
    return {
      id: id("aiwop"),
      operationType: "create_analysis_task",
      module: "ai-analysis",
      moduleLabel: workPermissionModuleLabels["ai-analysis"],
      toolKey: "analysis-tasks",
      aiSummary,
      targetId: null,
      targetLabel: `分析任务（${ANALYSIS_TASK_TYPE_LABELS[parsed.taskType] ?? parsed.taskType}）`,
      targetVersionNo: null,
      changes,
      payload: {
        taskType: parsed.taskType,
        scope: parsed.scope,
        ...(parsed.modelId !== undefined && parsed.modelId.trim() ? { modelId: parsed.modelId } : {})
      },
      result: null,
      failure: ""
    };
  }

  private buildCreateOutlineOperation(workId: string, raw: {
    targetId?: string | null;
    changes: Record<string, unknown>;
  }, aiSummary: string): AiWritePlanOperation {
    if (raw.targetId) throw new AppError(400, "AI_WRITE_CREATE_WITH_TARGET", "创建章节大纲不能携带目标 ID");
    const parsed = this.parseChanges("create_outline", ENTITY_FIELDS.create_outline, raw.changes) as {
      chapterId: string;
      goal?: string;
      conflict?: string;
      turningPoint?: string;
      notes?: string;
      status?: "draft" | "ready" | "completed";
    };
    let chapter: Record<string, unknown>;
    try {
      chapter = this.store.getChapter(parsed.chapterId);
    } catch {
      throw new AppError(404, "CHAPTER_NOT_FOUND", `大纲目标章节不存在：${parsed.chapterId}`);
    }
    if (String(chapter.workId) !== workId) {
      throw new AppError(400, "CHAPTER_WORK_MISMATCH", "大纲目标章节不属于当前作品");
    }
    if (this.store.getChapterOutline(parsed.chapterId)) {
      throw new AppError(409, "CHAPTER_OUTLINE_EXISTS", `章节“${String(chapter.title)}”已经存在大纲，请改用编辑章节大纲操作`);
    }
    const { chapterId: _chapterId, ...outlineFields } = parsed;
    const changes = Object.entries(outlineFields).map(([field, after]) => ({
      field,
      label: ENTITY_FIELDS.create_outline[field]?.label ?? field,
      before: null,
      after
    }));
    return {
      id: id("aiwop"),
      operationType: "create_outline",
      module: "outlines",
      moduleLabel: workPermissionModuleLabels.outlines,
      toolKey: "outlines",
      aiSummary,
      targetId: parsed.chapterId,
      targetLabel: `章节“${String(chapter.title)}”`,
      targetVersionNo: Number(chapter.versionNo ?? 0),
      changes,
      payload: outlineFields,
      result: null,
      failure: ""
    };
  }

  private currentEntity(workId: string, operationType: AiWriteOperationType, targetId: string): Record<string, unknown> {
    let entity: Record<string, unknown>;
    try {
      switch (operationType) {
        case "update_setting": entity = this.store.getSetting(targetId); break;
        case "update_character": entity = this.store.getCharacter(targetId); break;
        case "update_race": entity = this.store.getRace(targetId); break;
        case "update_organization": entity = this.store.getOrganization(targetId); break;
        case "update_timeline_event": entity = this.store.getTimelineEvent(targetId); break;
        case "update_relationship": entity = this.store.getRelationship(targetId); break;
        case "update_outline": {
          const outline = this.store.getChapterOutline(targetId);
          if (!outline) throw new AppError(404, "CHAPTER_OUTLINE_NOT_FOUND", `章节大纲不存在：${targetId}`);
          entity = outline;
          break;
        }
        case "update_foreshadow": entity = this.store.getForeshadow(targetId); break;
        default: throw new AppError(400, "AI_WRITE_OPERATION_TYPE_INVALID", `不支持的编辑操作类型：${operationType}`);
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "CHAPTER_OUTLINE_NOT_FOUND") throw error;
      throw new AppError(404, "AI_WRITE_TARGET_NOT_FOUND", `目标对象不存在：${targetId}`);
    }
    if (String(entity.workId ?? "") !== workId) {
      throw new AppError(400, "AI_WRITE_TARGET_WORK_MISMATCH", `目标对象不属于当前作品：${targetId}`);
    }
    return entity;
  }

  private fieldValue(entity: Record<string, unknown>, field: string): unknown {
    if (!(field in entity)) return undefined;
    return entity[field];
  }

  private entityLabel(operationType: AiWriteOperationType, entity: Record<string, unknown>): string {
    const name = entity.title ?? entity.name;
    if (name !== null && name !== undefined && String(name)) return String(name);
    return "（未命名）";
  }

  private createTargetLabel(operationType: AiWriteOperationType, fields: Record<string, unknown>): string {
    const name = fields.title ?? fields.name;
    if (name !== null && name !== undefined && String(name)) return String(name);
    return "（新词条）";
  }

  private assertCreateReferences(workId: string, operationType: AiWriteOperationType, fields: Record<string, unknown>): void {
    if (operationType === "create_character" || operationType === "update_character") {
      this.assertCharacterReferences(workId, fields);
      return;
    }
    if (operationType === "create_race" && typeof fields.parentRaceId === "string" && fields.parentRaceId) {
      const race = this.store.getRace(fields.parentRaceId, false);
      if (String(race.workId) !== workId) throw new AppError(400, "AI_WRITE_REFERENCE_WORK_MISMATCH", "上级种族不属于当前作品");
    }
    if (operationType === "create_race" || operationType === "create_organization") {
      const memberIds = Array.isArray(fields.memberIds) ? fields.memberIds as string[] : [];
      for (const characterId of memberIds) {
        const character = this.store.getCharacter(characterId);
        if (String(character.workId) !== workId) throw new AppError(400, "AI_WRITE_REFERENCE_WORK_MISMATCH", "成员角色不属于当前作品");
      }
    }
    if (operationType === "create_relationship") {
      const fromId = String(fields.fromCharacterId ?? "");
      const toId = String(fields.toCharacterId ?? "");
      for (const characterId of [fromId, toId]) {
        const character = this.store.getCharacter(characterId);
        if (String(character.workId) !== workId) throw new AppError(400, "AI_WRITE_REFERENCE_WORK_MISMATCH", "关系角色不属于当前作品");
      }
    }
    if (operationType === "create_timeline_event") {
      const chapterIds = Array.isArray(fields.chapterIds) ? fields.chapterIds as string[] : [];
      for (const chapterId of chapterIds) {
        const chapter = this.store.getChapter(chapterId);
        if (String(chapter.workId) !== workId) throw new AppError(400, "AI_WRITE_REFERENCE_WORK_MISMATCH", "关联章节不属于当前作品");
      }
      const participantIds = Array.isArray(fields.participantIds) ? fields.participantIds as string[] : [];
      for (const characterId of participantIds) {
        const character = this.store.getCharacter(characterId);
        if (String(character.workId) !== workId) throw new AppError(400, "AI_WRITE_REFERENCE_WORK_MISMATCH", "事件参与者不属于当前作品");
      }
      if (typeof fields.trackId === "string" && fields.trackId) {
        const track = this.store.getTimelineTrack(fields.trackId);
        if (String(track.workId) !== workId) throw new AppError(400, "AI_WRITE_REFERENCE_WORK_MISMATCH", "时间线轨道不属于当前作品");
      }
    }
  }

  private assertUpdateReferences(workId: string, operationType: AiWriteOperationType, current: Record<string, unknown>, fields: Record<string, unknown>): void {
    if (operationType === "update_character") {
      this.assertCharacterReferences(workId, fields);
      return;
    }
    if (operationType === "update_race" && typeof fields.parentRaceId === "string" && fields.parentRaceId) {
      const race = this.store.getRace(fields.parentRaceId, false);
      if (String(race.workId) !== workId) throw new AppError(400, "AI_WRITE_REFERENCE_WORK_MISMATCH", "上级种族不属于当前作品");
    }
    if (operationType === "update_race" || operationType === "update_organization") {
      const memberIds = Array.isArray(fields.memberIds) ? fields.memberIds as string[] : [];
      for (const characterId of memberIds) {
        const character = this.store.getCharacter(characterId);
        if (String(character.workId) !== workId) throw new AppError(400, "AI_WRITE_REFERENCE_WORK_MISMATCH", "成员角色不属于当前作品");
      }
    }
    if (operationType === "update_relationship") {
      for (const characterId of [String(fields.fromCharacterId ?? ""), String(fields.toCharacterId ?? "")].filter(Boolean)) {
        const character = this.store.getCharacter(characterId);
        if (String(character.workId) !== workId) throw new AppError(400, "AI_WRITE_REFERENCE_WORK_MISMATCH", "关系角色不属于当前作品");
      }
    }
    if (operationType === "update_timeline_event") {
      const chapterIds = Array.isArray(fields.chapterIds) ? fields.chapterIds as string[] : [];
      for (const chapterId of chapterIds) {
        const chapter = this.store.getChapter(chapterId);
        if (String(chapter.workId) !== workId) throw new AppError(400, "AI_WRITE_REFERENCE_WORK_MISMATCH", "关联章节不属于当前作品");
      }
      const participantIds = Array.isArray(fields.participantIds) ? fields.participantIds as string[] : [];
      for (const characterId of participantIds) {
        const character = this.store.getCharacter(characterId);
        if (String(character.workId) !== workId) throw new AppError(400, "AI_WRITE_REFERENCE_WORK_MISMATCH", "事件参与者不属于当前作品");
      }
      if (typeof fields.trackId === "string" && fields.trackId) {
        const track = this.store.getTimelineTrack(fields.trackId);
        if (String(track.workId) !== workId) throw new AppError(400, "AI_WRITE_REFERENCE_WORK_MISMATCH", "时间线轨道不属于当前作品");
      }
    }
  }

  private assertCharacterReferences(workId: string, fields: Record<string, unknown>): void {
    if (typeof fields.raceId === "string" && fields.raceId) {
      const race = this.store.getRace(fields.raceId, false);
      if (String(race.workId) !== workId) throw new AppError(400, "AI_WRITE_REFERENCE_WORK_MISMATCH", "角色种族不属于当前作品");
    }
    const organizationIds = Array.isArray(fields.organizationIds) ? fields.organizationIds as string[] : [];
    for (const organizationId of organizationIds) {
      const organization = this.store.getOrganization(organizationId);
      if (String(organization.workId) !== workId) throw new AppError(400, "AI_WRITE_REFERENCE_WORK_MISMATCH", "角色所属组织不属于当前作品");
    }
    if (typeof fields.firstChapterId === "string" && fields.firstChapterId) {
      const chapter = this.store.getChapter(fields.firstChapterId);
      if (String(chapter.workId) !== workId) throw new AppError(400, "AI_WRITE_REFERENCE_WORK_MISMATCH", "首次登场章节不属于当前作品");
    }
  }

  // ------------------------------------------------------------------
  // 权限与开关校验
  // ------------------------------------------------------------------

  private workToolSwitches(workId: string): AiWriteToolSwitches {
    return normalizeAiWriteToolSwitches(this.store.getWorkAiSettings(workId).aiWriteTools);
  }

  /** 逐操作校验权限交集（当前操作用户 × 对话归属用户 × 确认操作者）与工具开关。 */
  private validatePlanPermissions(
    workId: string,
    requesterUserId: string | null,
    ownerUserId: string | null,
    operatorUser: AuthUser | null,
    operations: AiWritePlanOperation[]
  ): PlanInvalidation | null {
    const requesterUser = requesterUserId ? this.auth.getUser(requesterUserId) : null;
    if (requesterUser && requesterUser.status !== "active") {
      return { code: "REQUESTER_INACTIVE", message: "计划发起账户已停用" };
    }
    const ownerUser = ownerUserId ? this.auth.getUser(ownerUserId) : null;
    if (ownerUser && ownerUser.status !== "active") {
      return { code: "OWNER_INACTIVE", message: "AI 对话归属账户已停用" };
    }
    const requesterPermissions = requesterUser ? this.auth.workModulePermissions(requesterUser, workId, requesterUser.role === "admin") : null;
    const ownerPermissions = ownerUser && ownerUser !== requesterUser
      ? this.auth.workModulePermissions(ownerUser, workId, ownerUser.role === "admin")
      : requesterPermissions;
    if (!requesterPermissions || !ownerPermissions) {
      return { code: "WORK_ACCESS_LOST", message: "发起用户或对话归属用户已失去这部作品的访问权限" };
    }
    const operatorPermissions = operatorUser && operatorUser !== requesterUser && operatorUser !== ownerUser
      ? this.auth.workModulePermissions(operatorUser, workId, operatorUser.role === "admin")
      : requesterPermissions;
    if (!operatorPermissions) {
      return { code: "OPERATOR_ACCESS_LOST", message: "确认操作者已失去这部作品的访问权限" };
    }
    const switches = this.workToolSwitches(workId);
    for (const operation of operations) {
      const definition = OPERATION_DEFINITIONS[operation.operationType];
      if (!switches[definition.toolKey]) {
        return {
          code: "TOOL_DISABLED",
          message: `可写工具“${AI_WRITE_TOOL_LABELS[definition.toolKey]}”已被关闭`
        };
      }
      if (operation.operationType === "create_analysis_task") {
        const requiredRead = analysisTaskReadModules(operation.payload.taskType, operation.payload.scope);
        const requesterReadOk = requiredRead.every((module) => canReadWorkModule(requesterPermissions, module));
        const ownerReadOk = requiredRead.every((module) => canReadWorkModule(ownerPermissions, module));
        const operatorReadOk = requiredRead.every((module) => canReadWorkModule(operatorPermissions, module));
        const requesterWriteOk = canWriteWorkModule(requesterPermissions, "ai-analysis");
        const ownerWriteOk = canWriteWorkModule(ownerPermissions, "ai-analysis");
        const operatorWriteOk = canWriteWorkModule(operatorPermissions, "ai-analysis");
        if (!requesterReadOk || !ownerReadOk || !operatorReadOk || !requesterWriteOk || !ownerWriteOk || !operatorWriteOk) {
          return { code: "ANALYSIS_PERMISSION_DENIED", message: "发起用户、对话归属用户或确认操作者缺少 AI 分析权限或分析范围所需资料的读取权限" };
        }
        continue;
      }
      if (!canWriteWorkModule(requesterPermissions, definition.module)
        || !canWriteWorkModule(ownerPermissions, definition.module)
        || !canWriteWorkModule(operatorPermissions, definition.module)) {
        return {
          code: "MODULE_WRITE_DENIED",
          message: `发起用户、对话归属用户或确认操作者缺少“${workPermissionModuleLabels[definition.module]}”模块的写权限`
        };
      }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // 审批中心查询
  // ------------------------------------------------------------------

  listPlans(workId: string, pagination: Pagination, status: string | undefined, actor: AuthUser): Record<string, unknown> {
    const conditions = ["work_id = ?"];
    const params: Array<string | number> = [workId];
    if (status && AI_WRITE_PLAN_STATUSES.includes(status as AiWritePlanStatus)) {
      conditions.push("status = ?");
      params.push(status);
    }
    const where = conditions.join(" AND ");
    const total = Number(this.store.db.get(`SELECT COUNT(*) AS count FROM ai_write_plans WHERE ${where}`, ...params)?.count ?? 0);
    const rows = this.store.db.all(
      `SELECT * FROM ai_write_plans WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ...params,
      pagination.limit,
      pagination.offset
    );
    const items = rows.map((row) => this.mapPlan(row as Record<string, unknown>, actor, false));
    return paginated(items, pagination, total);
  }

  getPlan(planId: string, actor: AuthUser): Record<string, unknown> {
    const plan = this.requirePlan(planId);
    this.assertPlanViewer(plan, actor);
    return this.mapPlan(this.store.db.get("SELECT * FROM ai_write_plans WHERE id = ?", planId) as Record<string, unknown>, actor, true);
  }

  private requirePlan(planId: string): AiWritePlanRecord {
    const row = this.store.db.get("SELECT * FROM ai_write_plans WHERE id = ?", planId);
    if (!row) throw new AppError(404, "AI_WRITE_PLAN_NOT_FOUND", "修改计划不存在或已被删除");
    return this.mapPlan(row as Record<string, unknown>, null, true);
  }

  private mapPlan(row: Record<string, unknown>, viewer: AuthUser | null, includeOperations: boolean): AiWritePlanRecord {
    const storedStatus = String(row.status ?? "pending");
    let status: AiWritePlanStatus = AI_WRITE_PLAN_STATUSES.includes(storedStatus as AiWritePlanStatus)
      ? storedStatus as AiWritePlanStatus
      : "pending";
    if (status === "pending") {
      const expiresAt = Number(new Date(String(row.expires_at)).getTime());
      if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
        this.store.db.run("UPDATE ai_write_plans SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'", now(), String(row.id));
        status = "expired";
      }
    }
    const operations = json<AiWritePlanOperation[]>(String(row.operations_json ?? "[]"), []);
    const workId = String(row.work_id);
    const requesterRow = row.requester_user_id === null || row.requester_user_id === undefined
      ? null
      : this.store.db.get("SELECT display_name FROM users WHERE id = ?", String(row.requester_user_id));
    const ownerRow = row.owner_user_id === null || row.owner_user_id === undefined
      ? null
      : this.store.db.get("SELECT display_name FROM users WHERE id = ?", String(row.owner_user_id));
    return {
      id: String(row.id),
      workId,
      conversationId: row.conversation_id === null || row.conversation_id === undefined ? null : String(row.conversation_id),
      requesterUserId: row.requester_user_id === null || row.requester_user_id === undefined ? null : String(row.requester_user_id),
      requesterDisplayName: requesterRow ? String(requesterRow.display_name) : "",
      ownerUserId: row.owner_user_id === null || row.owner_user_id === undefined ? null : String(row.owner_user_id),
      ownerDisplayName: ownerRow ? String(ownerRow.display_name) : "",
      status,
      summary: String(row.summary ?? ""),
      operations: includeOperations ? this.redactOperations(workId, operations, viewer) : operations.map((operation) => ({
        ...operation,
        payload: {},
        changes: [],
        referencedText: undefined,
        failure: ""
      })),
      expiresAt: String(row.expires_at),
      rejectedAt: row.rejected_at === null || row.rejected_at === undefined ? null : String(row.rejected_at),
      rejectedByUserId: row.rejected_by_user_id === null || row.rejected_by_user_id === undefined ? null : String(row.rejected_by_user_id),
      executedAt: row.executed_at === null || row.executed_at === undefined ? null : String(row.executed_at),
      executedByUserId: row.executed_by_user_id === null || row.executed_by_user_id === undefined ? null : String(row.executed_by_user_id),
      invalidationReason: String(row.invalidation_reason ?? ""),
      revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : String(row.revoked_at),
      revokedByUserId: row.revoked_by_user_id === null || row.revoked_by_user_id === undefined ? null : String(row.revoked_by_user_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  /**
   * 按查看者权限过滤操作详情：查看者对操作所属模块没有读取权限时，
   * 隐藏字段 diff、执行载荷与引用正文，防止未授权作品内容泄露。
   */
  private redactOperations(workId: string, operations: AiWritePlanOperation[], viewer: AuthUser | null): AiWritePlanOperation[] {
    if (!viewer) return operations;
    const permissions = this.auth.workModulePermissions(viewer, workId, viewer.role === "admin");
    if (!permissions) return operations.map((operation) => ({ ...operation, changes: [], payload: {}, referencedText: undefined }));
    return operations.map((operation) => {
      if (canReadWorkModule(permissions, operation.module)) return operation;
      return { ...operation, changes: [], payload: {}, referencedText: undefined };
    });
  }

  private assertPlanViewer(plan: AiWritePlanRecord, actor: AuthUser): void {
    const isParticipant = (plan.requesterUserId && plan.requesterUserId === actor.userId)
      || (plan.ownerUserId && plan.ownerUserId === actor.userId);
    if (!isParticipant && actor.role !== "admin") {
      const work = this.store.getWork(plan.workId);
      const owner = work.ownerUserId !== undefined ? String(work.ownerUserId ?? "") : "";
      const membership = this.store.db.get(
        "SELECT role FROM work_memberships WHERE work_id = ? AND user_id = ?",
        plan.workId,
        actor.userId
      );
      const isWorkOwner = owner === actor.userId || String(membership?.role ?? "") === "owner";
      if (!isWorkOwner) throw new AppError(403, "AI_WRITE_PLAN_ACCESS_DENIED", "你无权查看这份修改计划");
    }
  }

  private assertPlanOperator(plan: AiWritePlanRecord, actor: AuthUser): void {
    const isParticipant = (plan.requesterUserId && plan.requesterUserId === actor.userId)
      || (plan.ownerUserId && plan.ownerUserId === actor.userId);
    if (isParticipant || actor.role === "admin") return;
    const work = this.store.getWork(plan.workId);
    const owner = work.ownerUserId !== undefined ? String(work.ownerUserId ?? "") : "";
    const membership = this.store.db.get(
      "SELECT role FROM work_memberships WHERE work_id = ? AND user_id = ?",
      plan.workId,
      actor.userId
    );
    if (owner === actor.userId || String(membership?.role ?? "") === "owner") return;
    throw new AppError(403, "AI_WRITE_PLAN_OPERATION_DENIED", "你无权处理这份修改计划");
  }

  // ------------------------------------------------------------------
  // 审批执行
  // ------------------------------------------------------------------

  approvePlan(planId: string, actor: AuthUser): Record<string, unknown> {
    const plan = this.requirePlan(planId);
    this.assertPlanOperator(plan, actor);
    if (plan.status === "succeeded") {
      // 幂等：重复确认直接返回既有执行结果，不产生重复写入。
      return this.executionResult(planId);
    }
    if (plan.status !== "pending") {
      throw new AppError(409, "AI_WRITE_PLAN_NOT_PENDING", planStatusMessage(plan.status));
    }
    const failure = this.validatePlanPermissions(plan.workId, plan.requesterUserId, plan.ownerUserId, actor, plan.operations);
    if (failure) {
      this.markInvalidated(planId, failure);
      throw new AppError(409, "AI_WRITE_PLAN_INVALIDATED", `修改计划已失效：${failure.message}`, { reason: failure.code });
    }
    const timestamp = now();
    try {
      const results = this.store.db.transaction(() => {
        // 原子抢占：只有仍处于 pending 的计划能进入执行，防止多标签页/网络重试重复执行。
        const claimed = this.store.db.run(
          "UPDATE ai_write_plans SET status = 'executing', updated_at = ? WHERE id = ? AND status = 'pending'",
          timestamp,
          planId
        );
        if (claimed.changes === 0) {
          const current = this.store.db.get("SELECT status FROM ai_write_plans WHERE id = ?", planId);
          const currentStatus = String(current?.status ?? "pending");
          if (currentStatus === "succeeded") return { idempotent: true as const, operations: [] };
          throw new AppError(409, "AI_WRITE_PLAN_NOT_PENDING", planStatusMessage(
            AI_WRITE_PLAN_STATUSES.includes(currentStatus as AiWritePlanStatus) ? currentStatus as AiWritePlanStatus : "pending"
          ));
        }
        // 事务内再次校验目标版本与归属，防止确认与执行之间的并发修改。
        const operations = plan.operations;
        for (const operation of operations) {
          if (operation.operationType === "create_chapter_annotation") {
            const chapter = this.store.getChapter(String(operation.targetId));
            if (String(chapter.workId) !== plan.workId || Number(chapter.versionNo ?? 0) !== operation.targetVersionNo) {
              throw new AppError(409, "AI_WRITE_TARGET_CHANGED", `章节“${String(chapter.title)}”在计划提交后已发生变化`);
            }
          }
        }
        const executed: Array<Record<string, unknown>> = [];
        for (const operation of operations) {
          executed.push(this.executeOperation(plan, operation));
        }
        return { idempotent: false as const, operations: executed };
      });
      if (results.idempotent) {
        return this.executionResult(planId);
      }
      const resultPayload = { operations: results.operations };
      // 把每项操作的执行结果写回计划快照，供撤销与审批详情展示。
      const executedOperations = plan.operations.map((operation) => {
        const executed = results.operations.find((item) => String(item.id) === operation.id);
        const executedResult = executed?.result && typeof executed.result === "object"
          ? executed.result as Record<string, unknown>
          : null;
        return { ...operation, result: executedResult };
      });
      this.store.db.run(
        `UPDATE ai_write_plans SET status = 'succeeded', executed_at = ?, executed_by_user_id = ?,
           execution_result_json = ?, operations_json = ?, updated_at = ?
         WHERE id = ?`,
        timestamp,
        actor.userId,
        JSON.stringify(resultPayload),
        JSON.stringify(executedOperations),
        timestamp,
        planId
      );
      this.store.audit(plan.workId, "ai.write-plan.executed", "ai-write-plan", planId, {
        executorUserId: actor.userId,
        operations: results.operations.map((operation) => {
          const result = operation.result && typeof operation.result === "object"
            ? operation.result as Record<string, unknown>
            : null;
          return {
            operationType: operation.operationType,
            targetId: operation.targetId ?? result?.id ?? null,
            versionNo: result?.versionNo ?? null
          };
        })
      });
      return this.executionResult(planId);
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      if (appError?.code === "AI_WRITE_PLAN_NOT_PENDING") throw error;
      logger.warn("ai_write.plan.execute.failed", {
        planId,
        workId: plan.workId,
        error: sanitizeError(error)
      });
      if (appError && ["AI_WRITE_TARGET_CHANGED", "AI_WRITE_TARGET_NOT_FOUND", "ANNOTATION_LINE_RANGE_INVALID", "VERSION_CONFLICT", "CHARACTER_ALREADY_MERGED"].includes(appError.code)) {
        this.markInvalidated(planId, {
          code: appError.code,
          message: `执行前校验失败：${appError.message}`
        });
        throw new AppError(409, "AI_WRITE_PLAN_INVALIDATED", `修改计划已失效：${appError.message}`, { reason: appError.code });
      }
      this.store.db.run(
        "UPDATE ai_write_plans SET status = 'failed', updated_at = ? WHERE id = ?",
        now(),
        planId
      );
      throw new AppError(500, "AI_WRITE_PLAN_EXECUTION_FAILED", "修改计划执行失败，未产生任何写入；请刷新后重试");
    }
  }

  private markInvalidated(planId: string, failure: PlanInvalidation): void {
    this.store.db.run(
      "UPDATE ai_write_plans SET status = 'invalidated', invalidation_reason = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      failure.message,
      now(),
      planId
    );
  }

  private executionResult(planId: string): Record<string, unknown> {
    const row = this.store.db.get("SELECT * FROM ai_write_plans WHERE id = ?", planId);
    if (!row) throw new AppError(404, "AI_WRITE_PLAN_NOT_FOUND", "修改计划不存在或已被删除");
    const operations = json<AiWritePlanOperation[]>(String(row.operations_json ?? "[]"), []);
    return {
      ok: true,
      planId,
      status: String(row.status),
      summary: String(row.summary ?? ""),
      executedAt: row.executed_at === null || row.executed_at === undefined ? null : String(row.executed_at),
      revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : String(row.revoked_at),
      operations: operations.map((operation) => ({
        id: operation.id,
        operationType: operation.operationType,
        targetId: operation.targetId,
        targetLabel: operation.targetLabel,
        result: operation.result,
        failure: operation.failure
      }))
    };
  }

  private executeOperation(plan: AiWritePlanRecord, operation: AiWritePlanOperation): Record<string, unknown> {
    const source = "ai-approval";
    const changeNote = `AI 审批执行（${operation.aiSummary}）`;
    const payload = operation.payload;
    let result: Record<string, unknown>;
    switch (operation.operationType) {
      case "create_setting":
        result = this.store.createSetting(plan.workId, payload as unknown as SettingInput, source, plan.id);
        break;
      case "update_setting":
        result = this.store.updateSetting(String(operation.targetId), payload as unknown as Partial<SettingInput>, source, plan.id, changeNote, operation.targetVersionNo ?? undefined);
        break;
      case "create_character":
        result = this.store.createCharacter(plan.workId, payload as unknown as CharacterInput);
        break;
      case "update_character":
        result = this.store.updateCharacter(String(operation.targetId), payload as unknown as Partial<CharacterInput>, source, plan.id, changeNote, operation.targetVersionNo ?? undefined);
        break;
      case "create_race":
        result = this.store.createRace(plan.workId, payload as unknown as RaceInput);
        break;
      case "update_race":
        result = this.store.updateRace(String(operation.targetId), payload as unknown as Partial<RaceInput>, source, plan.id, changeNote, operation.targetVersionNo ?? undefined);
        break;
      case "create_organization":
        result = this.store.createOrganization(plan.workId, payload as unknown as OrganizationInput);
        break;
      case "update_organization":
        result = this.store.updateOrganization(String(operation.targetId), payload as unknown as Partial<OrganizationInput>, source, plan.id, changeNote, operation.targetVersionNo ?? undefined);
        break;
      case "create_timeline_event":
        result = this.store.createTimelineEvent(plan.workId, payload as unknown as TimelineInput, source, plan.id);
        break;
      case "update_timeline_event":
        result = this.store.updateTimelineEvent(String(operation.targetId), payload as unknown as Partial<TimelineInput>, source, plan.id, changeNote, operation.targetVersionNo ?? undefined);
        break;
      case "create_relationship":
        result = this.store.createRelationship(plan.workId, payload as unknown as RelationshipInput, source, plan.id);
        break;
      case "update_relationship":
        result = this.store.updateRelationship(String(operation.targetId), payload as unknown as Partial<RelationshipInput>, source, plan.id, changeNote, operation.targetVersionNo ?? undefined);
        break;
      case "create_outline":
        result = this.store.upsertChapterOutline(String(operation.targetId), payload as unknown as ChapterOutlineInput, source, plan.id, changeNote, operation.targetVersionNo ?? undefined);
        break;
      case "update_outline":
        result = this.store.upsertChapterOutline(String(operation.targetId), payload as unknown as ChapterOutlineInput, source, plan.id, changeNote, operation.targetVersionNo ?? undefined);
        break;
      case "create_foreshadow":
        result = this.store.createForeshadow(plan.workId, payload as unknown as ForeshadowInput);
        break;
      case "update_foreshadow":
        result = this.store.updateForeshadow(String(operation.targetId), payload as unknown as Partial<ForeshadowInput>, source, plan.id, changeNote, operation.targetVersionNo ?? undefined);
        break;
      case "create_chapter_annotation": {
        const annotationPayload = payload as { chapterId: string; kind: "note" | "todo"; startLine: number; endLine: number; note: string };
        result = this.store.createChapterAnnotation(annotationPayload.chapterId, {
          kind: annotationPayload.kind,
          startLine: annotationPayload.startLine,
          endLine: annotationPayload.endLine,
          note: annotationPayload.note
        });
        break;
      }
      case "create_analysis_task":
        result = this.createAnalysisTask(plan.workId, payload as { taskType: string; scope?: Record<string, unknown>; modelId?: string });
        break;
      default:
        throw new AppError(400, "AI_WRITE_OPERATION_TYPE_INVALID", `不支持的执行操作类型：${operation.operationType}`);
    }
    return {
      id: operation.id,
      operationType: operation.operationType,
      targetId: operation.targetId,
      result: {
        id: result.id,
        versionNo: result.versionNo ?? null,
        createdAt: result.createdAt ?? null
      }
    };
  }

  rejectPlan(planId: string, actor: AuthUser): Record<string, unknown> {
    const plan = this.requirePlan(planId);
    this.assertPlanOperator(plan, actor);
    if (plan.status !== "pending") {
      throw new AppError(409, "AI_WRITE_PLAN_NOT_PENDING", planStatusMessage(plan.status));
    }
    const timestamp = now();
    this.store.db.run(
      `UPDATE ai_write_plans SET status = 'rejected', rejected_at = ?, rejected_by_user_id = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      timestamp,
      actor.userId,
      timestamp,
      planId
    );
    this.store.audit(plan.workId, "ai.write-plan.rejected", "ai-write-plan", planId, { rejectedByUserId: actor.userId });
    return this.executionResult(planId);
  }

  /**
   * 撤销本次审批：仅恢复编辑已有词条的操作；新建词条、正文批注与分析任务
   * 不支持通过撤销自动删除。目标词条被后续版本修改时拒绝撤销。
   */
  revokePlan(planId: string, actor: AuthUser): Record<string, unknown> {
    const plan = this.requirePlan(planId);
    this.assertPlanOperator(plan, actor);
    if (plan.status !== "succeeded") {
      throw new AppError(409, "AI_WRITE_PLAN_NOT_SUCCEEDED", "只有执行成功的审批才能撤销");
    }
    if (plan.revokedAt) {
      throw new AppError(409, "AI_WRITE_PLAN_ALREADY_REVOKED", "本次审批已经撤销");
    }
    const revocable = plan.operations.filter((operation) => operation.operationType.startsWith("update_") && operation.result !== null);
    if (revocable.length === 0) {
      throw new AppError(409, "AI_WRITE_PLAN_NOTHING_TO_REVOKE", "本次审批只包含新建操作，不支持通过撤销自动删除");
    }
    const timestamp = now();
    try {
      const revokedOperations = this.store.db.transaction(() => {
        // 事务内逐项校验：目标词条版本必须仍停留在本次审批执行的版本。
        const current = this.store.db.get("SELECT status, revoked_at FROM ai_write_plans WHERE id = ?", planId);
        if (String(current?.status ?? "") !== "succeeded" || current?.revoked_at) {
          throw new AppError(409, "AI_WRITE_PLAN_ALREADY_REVOKED", "本次审批已经撤销");
        }
        const results: Array<Record<string, unknown>> = [];
        for (const operation of revocable) {
          const restored = this.revokeOperation(plan, operation);
          results.push(restored);
        }
        return results;
      });
      this.store.db.run(
        "UPDATE ai_write_plans SET revoked_at = ?, revoked_by_user_id = ?, updated_at = ? WHERE id = ?",
        timestamp,
        actor.userId,
        timestamp,
        planId
      );
      this.store.audit(plan.workId, "ai.write-plan.revoked", "ai-write-plan", planId, {
        revokedByUserId: actor.userId,
        operations: revokedOperations
      });
      return { ...this.executionResult(planId), revokedOperations };
    } catch (error) {
      if (error instanceof AppError && error.code === "AI_WRITE_PLAN_ALREADY_REVOKED") throw error;
      throw new AppError(409, "AI_WRITE_REVOKE_FAILED", error instanceof AppError ? `撤销失败：${error.message}` : "撤销失败：目标词条已被后续版本修改，无法安全撤销");
    }
  }

  private revokeOperation(plan: AiWritePlanRecord, operation: AiWritePlanOperation): Record<string, unknown> {
    const targetId = String(operation.targetId ?? "");
    const restoreFields: Record<string, unknown> = {};
    const skippedFields: string[] = [];
    for (const change of operation.changes) {
      if (change.before === null || change.before === undefined) {
        skippedFields.push(change.field);
        continue;
      }
      restoreFields[change.field] = change.before;
    }
    const current = this.currentEntity(plan.workId, operation.operationType, targetId);
    const executedVersion = Number(operation.result?.versionNo ?? 0);
    const currentVersion = Number(current.versionNo ?? 0);
    if (!Number.isInteger(executedVersion) || currentVersion !== executedVersion) {
      throw new AppError(409, "AI_WRITE_REVOKE_VERSION_CONFLICT", `目标对象“${operation.targetLabel}”在审批执行后又被修改，无法撤销`);
    }
    if (Object.keys(restoreFields).length === 0) {
      throw new AppError(409, "AI_WRITE_REVOKE_NO_RESTORABLE_FIELDS", `目标对象“${operation.targetLabel}”没有可恢复的字段快照`);
    }
    const source = "ai-revoke";
    const changeNote = `撤销 AI 审批（${operation.aiSummary}）`;
    switch (operation.operationType) {
      case "update_setting": this.store.updateSetting(targetId, restoreFields as unknown as Partial<SettingInput>, source, plan.id, changeNote, currentVersion); break;
      case "update_character": this.store.updateCharacter(targetId, restoreFields as unknown as Partial<CharacterInput>, source, plan.id, changeNote, currentVersion); break;
      case "update_race": this.store.updateRace(targetId, restoreFields as unknown as Partial<RaceInput>, source, plan.id, changeNote, currentVersion); break;
      case "update_organization": this.store.updateOrganization(targetId, restoreFields as unknown as Partial<OrganizationInput>, source, plan.id, changeNote, currentVersion); break;
      case "update_timeline_event": this.store.updateTimelineEvent(targetId, restoreFields as unknown as Partial<TimelineInput>, source, plan.id, changeNote, currentVersion); break;
      case "update_relationship": this.store.updateRelationship(targetId, restoreFields as unknown as Partial<RelationshipInput>, source, plan.id, changeNote, currentVersion); break;
      case "update_outline": this.store.upsertChapterOutline(targetId, restoreFields as unknown as ChapterOutlineInput, source, plan.id, changeNote, currentVersion); break;
      case "update_foreshadow": this.store.updateForeshadow(targetId, restoreFields as unknown as Partial<ForeshadowInput>, source, plan.id, changeNote, currentVersion); break;
      default:
        throw new AppError(409, "AI_WRITE_REVOKE_UNSUPPORTED", `操作类型 ${operation.operationType} 不支持撤销`);
    }
    return {
      id: operation.id,
      operationType: operation.operationType,
      targetId,
      targetLabel: operation.targetLabel,
      restoredFields: Object.keys(restoreFields),
      skippedFields
    };
  }
}

function operationSummary(operation: AiWritePlanOperation): Record<string, unknown> {
  return {
    id: operation.id,
    operationType: operation.operationType,
    module: operation.module,
    moduleLabel: operation.moduleLabel,
    aiSummary: operation.aiSummary,
    targetId: operation.targetId,
    targetLabel: operation.targetLabel,
    targetVersionNo: operation.targetVersionNo,
    changes: operation.changes
  };
}

function planStatusMessage(status: AiWritePlanStatus): string {
  switch (status) {
    case "rejected": return "该修改计划已被拒绝";
    case "expired": return "该修改计划已过期，请让 AI 重新提交计划";
    case "invalidated": return "该修改计划已失效";
    case "executing": return "该修改计划正在执行中，请稍候";
    case "succeeded": return "该修改计划已经执行成功";
    case "failed": return "该修改计划执行失败，请让 AI 重新提交计划";
    default: return "该修改计划当前不可确认";
  }
}

function analysisScopeSummary(scope: Record<string, unknown>): string {
  const type = String(scope.type ?? "book");
  const parts: string[] = [];
  switch (type) {
    case "chapter": {
      if (typeof scope.chapterId === "string" && scope.chapterId) parts.push(`指定章节（${scope.chapterId}）`);
      else parts.push("指定章节");
      break;
    }
    case "selection": parts.push("选定正文内容"); break;
    case "volume": parts.push("整卷"); break;
    case "book": parts.push("全书"); break;
    case "settings-catalog": parts.push("设定库"); break;
    case "entities": parts.push("相关实体"); break;
    case "none": parts.push("无预加载范围"); break;
    default: parts.push("自定义范围");
  }
  if (Array.isArray(scope.characterIds) && scope.characterIds.length > 0) {
    parts.push(`${scope.characterIds.length} 位被分析角色`);
  }
  if (scope.includeAllSettings === true) parts.push("包含全部设定");
  if (scope.includeBookSummary === true) parts.push("包含全书概要");
  if (typeof scope.additionalPrompt === "string" && scope.additionalPrompt.trim()) parts.push("附带额外提示");
  return parts.join("；");
}

export function questionDisplay(question: AiQuestionRecord): Record<string, unknown> {
  return {
    id: question.id,
    workId: question.workId,
    conversationId: question.conversationId,
    question: question.question,
    options: question.options,
    recommendedIndex: question.recommendedIndex,
    allowCustomAnswer: question.allowCustomAnswer,
    status: question.status,
    ...(question.answer ? { answer: question.answer } : {}),
    answeredAt: question.answeredAt,
    expiresAt: question.expiresAt,
    createdAt: question.createdAt
  };
}
