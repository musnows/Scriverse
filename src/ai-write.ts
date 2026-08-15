import { z } from "zod";
import { AppError, notFound } from "./errors.js";
import { logger, sanitizeError } from "./logger.js";
import { currentRequestActor } from "./request-context.js";
import {
  AI_WRITE_TOOL_KEYS,
  normalizeAiWriteTools,
  Store,
  type AiWriteToolKey,
  type AiWriteToolSettings
} from "./store.js";
import {
  analysisTaskReadModules,
  UserAuthService,
  type AuthUser
} from "./user-auth.js";
import {
  canReadWorkModule,
  canWriteWorkModule,
  emptyWorkModulePermissions,
  fullWorkModulePermissions,
  type WorkModulePermissions,
  type WorkPermissionModule
} from "./work-permissions.js";
import { id, json, now } from "./utils.js";

const recordSchema = z.record(z.string(), z.unknown());
const identifierSchema = z.string().trim().min(1).max(200);
const summarySchema = z.string().trim().min(1).max(500);
const nonEmptyShort = z.string().trim().min(1).max(500);
const nonEmptyLong = z.string().trim().min(1).max(200_000);
const optionalLong = z.string().trim().max(200_000).optional();
const optionalStringList = z.array(z.string().trim().min(1).max(500)).max(200).optional();
const optionalRecord = recordSchema.optional();
const optionalBoolean = z.boolean().optional();

const settingCreateSchema = z.object({
  title: nonEmptyShort,
  category: nonEmptyShort,
  content: nonEmptyLong,
  tags: z.array(z.string().trim().min(1).max(500)).max(200).optional(),
  status: z.enum(["draft", "pending", "confirmed", "deprecated"]).optional(),
  locked: optionalBoolean,
  evidence: z.array(z.unknown()).max(500).optional(),
  scope: recordSchema.optional(),
  authorNote: z.string().trim().max(20_000).optional(),
  summary: summarySchema.optional()
}).strict();
const settingUpdateSchema = settingCreateSchema.partial().extend({
  settingId: identifierSchema,
  summary: summarySchema.optional()
}).strict();

const characterBaseSchema = z.object({
  name: nonEmptyShort,
  isDead: optionalBoolean,
  code: z.string().trim().max(200).optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  raceId: identifierSchema.nullable().optional(),
  species: z.string().trim().max(200).optional(),
  organizationIds: z.array(identifierSchema).max(100).optional(),
  attributes: optionalRecord,
  profile: optionalRecord,
  currentState: optionalRecord,
  lockedFields: optionalStringList,
  firstChapterId: identifierSchema.nullable().optional()
}).strict();
const characterCreateSchema = characterBaseSchema.extend({ summary: summarySchema.optional() }).strict();
const characterUpdateSchema = characterBaseSchema.partial().extend({
  characterId: identifierSchema,
  summary: summarySchema.optional()
}).strict();

const knowledgeSectionSchema = z.object({
  title: nonEmptyShort,
  contentMarkdown: z.string().trim().max(200_000).optional(),
  summary: z.string().trim().max(100_000).optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional()
}).strict();

const raceBaseSchema = z.object({
  name: nonEmptyShort,
  isExtinct: optionalBoolean,
  parentRaceId: identifierSchema.nullable().optional(),
  description: z.string().trim().max(100_000).optional(),
  settings: z.array(z.string().trim().min(1).max(20_000)).max(200).optional(),
  settingsMarkdown: z.string().trim().max(200_000).optional(),
  settingsSections: z.array(knowledgeSectionSchema).max(200).optional(),
  memberIds: z.array(identifierSchema).max(1000).optional()
}).strict();
const raceCreateSchema = raceBaseSchema.extend({ summary: summarySchema.optional() }).strict();
const raceUpdateSchema = raceBaseSchema.partial().extend({
  raceId: identifierSchema,
  summary: summarySchema.optional()
}).strict();

const organizationBaseSchema = z.object({
  name: nonEmptyShort,
  isDissolved: optionalBoolean,
  description: z.string().trim().max(100_000).optional(),
  settings: z.array(z.string().trim().min(1).max(20_000)).max(200).optional(),
  settingsMarkdown: z.string().trim().max(200_000).optional(),
  settingsSections: z.array(knowledgeSectionSchema).max(200).optional(),
  memberIds: z.array(identifierSchema).max(1000).optional()
}).strict();
const organizationCreateSchema = organizationBaseSchema.extend({ summary: summarySchema.optional() }).strict();
const organizationUpdateSchema = organizationBaseSchema.partial().extend({
  organizationId: identifierSchema,
  summary: summarySchema.optional()
}).strict();

const timelineBaseSchema = z.object({
  name: nonEmptyShort,
  trackId: identifierSchema.nullable().optional(),
  description: z.string().trim().max(100_000).optional(),
  eventType: z.string().trim().max(100).optional(),
  timeLabel: z.string().trim().max(300).optional(),
  timeSort: z.number().finite().nullable().optional(),
  chapterIds: z.array(identifierSchema).max(200).optional(),
  participantIds: z.array(identifierSchema).max(100).optional(),
  location: z.string().trim().max(500).optional(),
  causes: optionalStringList,
  impactScope: z.enum(["personal", "organization", "regional", "world", "galaxy"]).optional(),
  evidence: z.array(z.unknown()).max(500).optional(),
  status: z.enum(["candidate", "pending", "confirmed", "deprecated"]).optional()
}).strict();
const timelineCreateSchema = timelineBaseSchema.extend({ summary: summarySchema.optional() }).strict();
const timelineUpdateSchema = timelineBaseSchema.partial().extend({
  eventId: identifierSchema,
  summary: summarySchema.optional()
}).strict();

const relationshipBaseSchema = z.object({
  fromCharacterId: identifierSchema,
  toCharacterId: identifierSchema,
  category: z.enum(["family", "social", "emotional", "conflict", "uncertain"]),
  subtype: z.string().trim().max(100).optional(),
  keywords: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  directed: optionalBoolean,
  currentStatus: z.string().trim().max(100).optional(),
  timeRange: optionalRecord,
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.array(z.unknown()).max(500).optional(),
  confirmationStatus: z.enum(["pending", "confirmed", "rejected"]).optional(),
  locked: optionalBoolean
}).strict();
const relationshipCreateSchema = relationshipBaseSchema.extend({ summary: summarySchema.optional() }).strict();
const relationshipUpdateSchema = relationshipBaseSchema.partial().extend({
  relationshipId: identifierSchema,
  summary: summarySchema.optional()
}).strict();

const outlineBaseSchema = z.object({
  goal: optionalLong,
  conflict: optionalLong,
  turningPoint: optionalLong,
  notes: optionalLong,
  status: z.enum(["draft", "ready", "completed"]).optional()
}).strict();
const outlineCreateSchema = outlineBaseSchema.extend({
  chapterId: identifierSchema,
  summary: summarySchema.optional()
}).strict();
const outlineUpdateSchema = outlineBaseSchema.partial().extend({
  chapterId: identifierSchema,
  summary: summarySchema.optional()
}).strict();

const foreshadowBaseSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(100_000).optional(),
  status: z.enum(["planned", "planted", "resolved", "abandoned"]).optional(),
  importance: z.enum(["low", "medium", "high"]).optional(),
  plannedPayoffChapterId: identifierSchema.nullable().optional(),
  resolutionNote: z.string().trim().max(100_000).optional(),
  occurrences: z.array(z.object({
    chapterId: identifierSchema,
    role: z.enum(["setup", "reminder", "payoff"]),
    note: z.string().trim().max(100_000).optional(),
    evidence: z.array(z.unknown()).max(500).optional()
  }).strict()).max(500).optional()
}).strict();
const foreshadowCreateSchema = foreshadowBaseSchema.extend({ summary: summarySchema.optional() }).strict();
const foreshadowUpdateSchema = foreshadowBaseSchema.partial().extend({
  foreshadowId: identifierSchema,
  summary: summarySchema.optional()
}).strict();

const annotationCreateSchema = z.object({
  chapterId: identifierSchema,
  kind: z.enum(["note", "todo"]),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  note: z.string().trim().min(1).max(20_000),
  summary: summarySchema.optional()
}).strict().refine((value) => value.endLine >= value.startLine, {
  path: ["endLine"],
  message: "批注结束行不能早于开始行"
});

const analysisTaskCreateSchema = z.object({
  taskType: z.string().trim().min(1).max(100),
  scope: recordSchema.optional(),
  modelId: identifierSchema.optional(),
  summary: summarySchema.optional()
}).strict();

const askUserQuestionsSchema = z.object({
  question: z.string().trim().min(1).max(500),
  options: z.array(z.string().trim().min(1).max(300)).min(2).max(10),
  allowCustomAnswer: z.boolean().optional(),
  summary: summarySchema.optional()
}).strict().refine((value) => new Set(value.options).size === value.options.length, {
  path: ["options"],
  message: "预置选项不能重复"
});

export const AI_WRITE_TOOL_NAMES = [
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
  "create_chapter_outline",
  "update_chapter_outline",
  "create_foreshadow",
  "update_foreshadow",
  "create_chapter_annotation",
  "create_analysis_task",
  "ask_user_questions",
  "submit_write_plan"
] as const;
export type AiWriteToolName = (typeof AI_WRITE_TOOL_NAMES)[number];

export type AiWriteOperationType =
  | "setting.create"
  | "setting.update"
  | "character.create"
  | "character.update"
  | "race.create"
  | "race.update"
  | "organization.create"
  | "organization.update"
  | "timeline-event.create"
  | "timeline-event.update"
  | "relationship.create"
  | "relationship.update"
  | "chapter-outline.create"
  | "chapter-outline.update"
  | "foreshadow.create"
  | "foreshadow.update"
  | "chapter-annotation.create"
  | "analysis-task.create";

const TOOL_TO_OPERATION: Partial<Record<AiWriteToolName, AiWriteOperationType>> = {
  create_setting: "setting.create",
  update_setting: "setting.update",
  create_character: "character.create",
  update_character: "character.update",
  create_race: "race.create",
  update_race: "race.update",
  create_organization: "organization.create",
  update_organization: "organization.update",
  create_timeline_event: "timeline-event.create",
  update_timeline_event: "timeline-event.update",
  create_relationship: "relationship.create",
  update_relationship: "relationship.update",
  create_chapter_outline: "chapter-outline.create",
  update_chapter_outline: "chapter-outline.update",
  create_foreshadow: "foreshadow.create",
  update_foreshadow: "foreshadow.update",
  create_chapter_annotation: "chapter-annotation.create",
  create_analysis_task: "analysis-task.create"
};

const TOOL_TO_KEY: Partial<Record<AiWriteToolName, AiWriteToolKey>> = {
  create_setting: "settings",
  update_setting: "settings",
  create_character: "characters",
  update_character: "characters",
  create_race: "races",
  update_race: "races",
  create_organization: "organizations",
  update_organization: "organizations",
  create_timeline_event: "timeline",
  update_timeline_event: "timeline",
  create_relationship: "relationships",
  update_relationship: "relationships",
  create_chapter_outline: "outlines",
  update_chapter_outline: "outlines",
  create_foreshadow: "outlines",
  update_foreshadow: "outlines",
  create_chapter_annotation: "annotations",
  create_analysis_task: "analysis",
  submit_write_plan: "analysis",
  ask_user_questions: "askUserQuestions"
};

export const AI_WRITE_OPERATION_TOOL_KEYS: Record<AiWriteOperationType, AiWriteToolKey> = {
  "setting.create": "settings",
  "setting.update": "settings",
  "character.create": "characters",
  "character.update": "characters",
  "race.create": "races",
  "race.update": "races",
  "organization.create": "organizations",
  "organization.update": "organizations",
  "timeline-event.create": "timeline",
  "timeline-event.update": "timeline",
  "relationship.create": "relationships",
  "relationship.update": "relationships",
  "chapter-outline.create": "outlines",
  "chapter-outline.update": "outlines",
  "foreshadow.create": "outlines",
  "foreshadow.update": "outlines",
  "chapter-annotation.create": "annotations",
  "analysis-task.create": "analysis"
};

export const AI_WRITE_OPERATION_MODULES: Record<AiWriteOperationType, WorkPermissionModule> = {
  "setting.create": "settings",
  "setting.update": "settings",
  "character.create": "characters",
  "character.update": "characters",
  "race.create": "races",
  "race.update": "races",
  "organization.create": "organizations",
  "organization.update": "organizations",
  "timeline-event.create": "timeline",
  "timeline-event.update": "timeline",
  "relationship.create": "relationships",
  "relationship.update": "relationships",
  "chapter-outline.create": "outlines",
  "chapter-outline.update": "outlines",
  "foreshadow.create": "outlines",
  "foreshadow.update": "outlines",
  "chapter-annotation.create": "prose",
  "analysis-task.create": "ai-analysis"
};

const AI_WRITE_ENTITY_LABELS: Record<string, string> = {
  setting: "世界观设定",
  character: "角色",
  race: "种族",
  organization: "组织",
  "timeline-event": "时间线事件",
  relationship: "人物关系",
  "chapter-outline": "章节大纲",
  foreshadow: "伏笔",
  "chapter-annotation": "正文批注",
  "analysis-task": "分析任务"
};

function operationEntityType(operationType: AiWriteOperationType): string {
  return operationType.split(".")[0] ?? "";
}

function operationAction(operationType: AiWriteOperationType): "create" | "update" {
  return operationType.endsWith(".create") ? "create" : "update";
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function resolveAiWritePlanMaxOperations(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 5;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error("AI_WRITE_PLAN_MAX_OPERATIONS 必须为 1–20 之间的整数");
  }
  return parsed;
}

type TaskModelResolver = (workId: string, taskType: string, modelId?: string) => {
  id: string;
  displayName: string;
  modelId: string;
};

type TaskCreator = (workId: string, input: { taskType: string; scope?: Record<string, unknown>; modelId?: string }) => Record<string, unknown>;

type PermissionCheck = {
  permissions: WorkModulePermissions;
  allowAdminAccess: boolean;
};

export type AiWriteOperationRecord = {
  id: string;
  operationIndex: number;
  operationType: AiWriteOperationType;
  module: WorkPermissionModule;
  toolKey: AiWriteToolKey;
  entityType: string;
  targetId: string | null;
  targetVersion: number | null;
  targetLabel: string;
  input: Record<string, unknown>;
  diff: Record<string, unknown>;
  status: "pending" | "executed" | "failed" | "undone";
  result: Record<string, unknown> | null;
  failure: string | null;
};

export type AiWriteApprovalRecord = {
  id: string;
  workId: string;
  conversationId: string | null;
  status: "pending" | "rejected" | "expired" | "invalid" | "executing" | "succeeded" | "failed";
  aiSummary: string;
  requestUserId: string | null;
  ownerUserId: string | null;
  plan: Record<string, unknown>;
  expiresAt: string | null;
  invalidReason: string;
  failures: unknown[];
  executedAt: string | null;
  executedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  operations: AiWriteOperationRecord[];
  events: Array<Record<string, unknown>>;
};

export type AiWriteQuestionRecord = {
  id: string;
  workId: string;
  conversationId: string | null;
  question: string;
  options: string[];
  recommendedOptionIndex: number;
  allowCustomAnswer: boolean;
  status: "pending" | "answered" | "expired" | "refused" | "invalid";
  answerText: string | null;
  answerOptionIndex: number | null;
  answeredByUserId: string | null;
  toolCallId: string | null;
  invalidReason: string;
  createdAt: string;
  expiresAt: string | null;
  answeredAt: string | null;
  updatedAt: string;
};

function zodError(error: z.ZodError): AppError {
  return new AppError(400, "AI_WRITE_ARGUMENTS_INVALID", "可写工具参数不符合要求", {
    details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
  });
}

function operationSchema(operationType: AiWriteOperationType): z.ZodType<Record<string, unknown>> {
  switch (operationType) {
    case "setting.create": return settingCreateSchema;
    case "setting.update": return settingUpdateSchema;
    case "character.create": return characterCreateSchema;
    case "character.update": return characterUpdateSchema;
    case "race.create": return raceCreateSchema;
    case "race.update": return raceUpdateSchema;
    case "organization.create": return organizationCreateSchema;
    case "organization.update": return organizationUpdateSchema;
    case "timeline-event.create": return timelineCreateSchema;
    case "timeline-event.update": return timelineUpdateSchema;
    case "relationship.create": return relationshipCreateSchema;
    case "relationship.update": return relationshipUpdateSchema;
    case "chapter-outline.create": return outlineCreateSchema;
    case "chapter-outline.update": return outlineUpdateSchema;
    case "foreshadow.create": return foreshadowCreateSchema;
    case "foreshadow.update": return foreshadowUpdateSchema;
    case "chapter-annotation.create": return annotationCreateSchema;
    case "analysis-task.create": return analysisTaskCreateSchema;
  }
}

export function parseAiWriteOperation(operationType: AiWriteOperationType, value: unknown): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(AI_WRITE_OPERATION_TOOL_KEYS, operationType) === false) {
    throw new AppError(400, "AI_WRITE_OPERATION_INVALID", `不支持的操作类型：${String(operationType)}`);
  }
  const parsed = operationSchema(operationType).safeParse(value);
  if (!parsed.success) throw zodError(parsed.error);
  return parsed.data as Record<string, unknown>;
}

export type AiWriteActor = AuthUser | null;

export class AiWriteService {
  private taskModelResolver: TaskModelResolver | null = null;
  private taskCreator: TaskCreator | null = null;
  private readonly questionTtlMs = 30 * 60 * 1000;
  private readonly approvalTtlMs = 24 * 60 * 60 * 1000;

  constructor(
    private readonly store: Store,
    private readonly auth: UserAuthService,
    private readonly maxPlanOperations: number
  ) {
    if (!Number.isInteger(maxPlanOperations) || maxPlanOperations < 1 || maxPlanOperations > 20) {
      throw new Error("AI_WRITE_PLAN_MAX_OPERATIONS 必须为 1–20 之间的整数");
    }
  }

  setTaskModelResolver(resolver: TaskModelResolver): void {
    this.taskModelResolver = resolver;
  }

  setTaskCreator(creator: TaskCreator): void {
    this.taskCreator = creator;
  }

  get maximumPlanOperations(): number {
    return this.maxPlanOperations;
  }

  allowAiWriteWithoutActor(): boolean {
    return this.auth.hasUsers() === false;
  }
  enabledWriteToolIds(workId: string, conversationId: string | null, actor: AuthUser | null): AiWriteToolName[] {
    try {
      const authBypass = actor === null && !this.auth.hasUsers();
      if (!actor && !authBypass) return [];
      const conversation = conversationId
        ? this.store.db.get("SELECT id, work_id, roleplay_character_id, created_by_user_id FROM ai_conversations WHERE id = ?", conversationId)
        : null;
      if (conversation && String(conversation.work_id) !== workId) return [];
      if (conversation && conversation.roleplay_character_id != null) return [];
      const ownerUserId = conversation && typeof conversation.created_by_user_id === "string" && conversation.created_by_user_id
        ? String(conversation.created_by_user_id)
        : actor?.userId ?? null;
      const owner = ownerUserId ? this.auth.getUser(ownerUserId) : null;
      if (owner && owner.status !== "active") return [];
      const allowAdminAccess = actor?.authentication !== "api-key";
      const requesterPermissions = this.actorPermissions(actor, workId, allowAdminAccess);
      const ownerPermissions = this.actorPermissions(owner, workId, true);
      const settings = this.workWriteToolSettings(workId);
      const keyByOperationTool: Partial<Record<AiWriteToolName, AiWriteToolKey>> = TOOL_TO_KEY;
      const canUse = (toolName: AiWriteToolName): boolean => {
        const key = keyByOperationTool[toolName];
        if (!key) return false;
        if (!settings[key]) return false;
        if (key === "analysis") {
          return canWriteWorkModule(requesterPermissions, "ai-analysis")
            && canWriteWorkModule(ownerPermissions, "ai-analysis");
        }
        if (key === "askUserQuestions") {
          return (canWriteWorkModule(requesterPermissions, "ai-chat") || canWriteWorkModule(requesterPermissions, "ai-analysis"))
            && (canWriteWorkModule(ownerPermissions, "ai-chat") || canWriteWorkModule(ownerPermissions, "ai-analysis"));
        }
        const operation = TOOL_TO_OPERATION[toolName];
        const module = operation ? AI_WRITE_OPERATION_MODULES[operation] : null;
        return Boolean(module && canWriteWorkModule(requesterPermissions, module) && canWriteWorkModule(ownerPermissions, module));
      };
      const enabled = AI_WRITE_TOOL_NAMES.filter((toolName) => toolName !== "submit_write_plan" && canUse(toolName));
      if (enabled.length > 0) enabled.push("submit_write_plan");
      return enabled;
    } catch {
      return [];
    }
  }


  private actorPermissions(user: AiWriteActor, workId: string, allowAdminAccess: boolean): WorkModulePermissions {
    if (!user) return fullWorkModulePermissions();
    const permissions = this.auth.workModulePermissions(user, workId, allowAdminAccess);
    if (!permissions) throw new AppError(403, "WORK_ACCESS_DENIED", "你没有访问这部作品的权限");
    return permissions;
  }

  private assertActorWorkAccess(actor: AiWriteActor, workId: string, allowAdminAccess: boolean): void {
    if (!actor) return;
    this.auth.assertWorkAccess(actor, workId, {}, false, allowAdminAccess);
  }

  private conversationOwnerId(conversationId: string | null, workId: string, fallbackUserId: string | null): string | null {
    if (!conversationId) return fallbackUserId;
    const row = this.store.db.get("SELECT id, work_id, created_by_user_id FROM ai_conversations WHERE id = ?", conversationId);
    if (!row) throw notFound("AI 对话");
    if (String(row.work_id) !== workId) throw new AppError(400, "CONVERSATION_WORK_MISMATCH", "AI 对话不属于当前作品");
    return typeof row.created_by_user_id === "string" && row.created_by_user_id
      ? String(row.created_by_user_id)
      : fallbackUserId;
  }

  private workWriteToolSettings(workId: string): AiWriteToolSettings {
    return normalizeAiWriteTools(this.store.getWorkAiSettings(workId).writeTools);
  }

  private assertToolEnabled(workId: string, key: AiWriteToolKey): void {
    if (!this.workWriteToolSettings(workId)[key]) {
      throw new AppError(403, "AI_WRITE_TOOL_DISABLED", "该可写工具未开启，请先在作品设置中启用");
    }
  }

  private assertModulePermissions(
    workId: string,
    requester: AiWriteActor,
    owner: AiWriteActor,
    requesterAllowAdmin: boolean,
    ownerAllowAdmin: boolean,
    module: WorkPermissionModule,
    readModules: WorkPermissionModule[] = []
  ): WorkModulePermissions {
    const requesterPermissions = this.actorPermissions(requester, workId, requesterAllowAdmin);
    const ownerPermissions = this.actorPermissions(owner, workId, ownerAllowAdmin);
    for (const check of [
      { label: "当前用户", permissions: requesterPermissions },
      { label: "AI 对话归属用户", permissions: ownerPermissions }
    ]) {
      if (!canWriteWorkModule(check.permissions, module)) {
        throw new AppError(403, "WORK_MODULE_WRITE_DENIED", `${check.label}没有编辑“${module}”模块的权限`, {
          actor: check.label === "当前用户" ? "requester" : "owner",
          module
        });
      }
      for (const readModule of readModules) {
        if (!canReadWorkModule(check.permissions, readModule)) {
          throw new AppError(403, "WORK_MODULE_READ_DENIED", `${check.label}没有读取“${readModule}”模块的权限`, {
            actor: check.label === "当前用户" ? "requester" : "owner",
            module: readModule
          });
        }
      }
    }
    return requesterPermissions;
  }

  private targetIdFor(input: Record<string, unknown>, operationType: AiWriteOperationType): string | null {
    const entityType = operationEntityType(operationType);
    if (operationAction(operationType) === "create") {
      if (entityType === "chapter-outline") return typeof input.chapterId === "string" ? input.chapterId : null;
      if (entityType === "chapter-annotation") return typeof input.chapterId === "string" ? input.chapterId : null;
      return null;
    }
    const keys: Partial<Record<string, string>> = {
      setting: "settingId",
      character: "characterId",
      race: "raceId",
      organization: "organizationId",
      "timeline-event": "eventId",
      relationship: "relationshipId",
      "chapter-outline": "chapterId",
      foreshadow: "foreshadowId"
    };
    const key = keys[entityType];
    return key && typeof input[key] === "string" ? String(input[key]) : null;
  }

  private currentEntity(entityType: string, entityId: string | null, operationType: AiWriteOperationType): Record<string, unknown> | null {
    if (!entityId) return null;
    switch (entityType) {
      case "setting": return this.store.getSetting(entityId);
      case "character": return this.store.getCharacter(entityId);
      case "race": return this.store.getRace(entityId);
      case "organization": return this.store.getOrganization(entityId);
      case "timeline-event": return this.store.getTimelineEvent(entityId);
      case "relationship": return this.store.getRelationship(entityId);
      case "chapter-outline": return this.store.getChapterOutline(entityId);
      case "foreshadow": return this.store.getForeshadow(entityId);
      case "chapter-annotation": return this.store.getChapter(entityId);
      case "analysis-task": return null;
      default: throw new AppError(400, "AI_WRITE_ENTITY_INVALID", `不支持的操作对象：${entityType}`);
    }
  }

  private entityFields(entityType: string): string[] {
    switch (entityType) {
      case "setting": return ["title", "category", "content", "tags", "status", "locked", "evidence", "scope", "authorNote"];
      case "character": return ["name", "isDead", "code", "aliases", "raceId", "species", "organizationIds", "attributes", "profile", "currentState", "lockedFields", "firstChapterId"];
      case "race": return ["name", "isExtinct", "parentRaceId", "description", "settings", "settingsSections", "memberIds"];
      case "organization": return ["name", "isDissolved", "description", "settings", "settingsSections", "memberIds"];
      case "timeline-event": return ["name", "trackId", "description", "eventType", "timeLabel", "timeSort", "chapterIds", "participantIds", "location", "causes", "impactScope", "evidence", "status"];
      case "relationship": return ["fromCharacterId", "toCharacterId", "category", "subtype", "keywords", "directed", "currentStatus", "timeRange", "confidence", "evidence", "confirmationStatus", "locked"];
      case "chapter-outline": return ["goal", "conflict", "turningPoint", "notes", "status"];
      case "foreshadow": return ["title", "description", "status", "importance", "plannedPayoffChapterId", "resolutionNote", "occurrences"];
      case "chapter-annotation": return ["kind", "startLine", "endLine", "note", "quote"];
      case "analysis-task": return ["taskType", "modelId", "scope"];
      default: return [];
    }
  }

  private diffForOperation(
    workId: string,
    operationType: AiWriteOperationType,
    input: Record<string, unknown>,
    current: Record<string, unknown> | null,
    entityType = operationEntityType(operationType)
  ): Record<string, unknown> {
    const action = operationAction(operationType);
    if (entityType === "chapter-annotation") {
      const chapter = current;
      if (!chapter) throw notFound("章节");
      const lines = String(chapter.content).replace(/\r\n?/gu, "\n").split("\n");
      if (Number(input.startLine) > lines.length || Number(input.endLine) > lines.length) {
        throw new AppError(400, "ANNOTATION_LINE_RANGE_INVALID", "批注行号超出当前正文范围");
      }
      if (Number(input.endLine) - Number(input.startLine) >= 20) {
        throw new AppError(400, "ANNOTATION_LINE_RANGE_TOO_LARGE", "一次最多批注 20 行正文");
      }
      const quote = lines.slice(Number(input.startLine) - 1, Number(input.endLine)).join("\n");
      return {
        action,
        module: "prose",
        entityType,
        targetLabel: `《${String(chapter.title)}》L${String(input.startLine)}-L${String(input.endLine)}`,
        fields: [
          { field: "kind", label: "批注类型", before: null, after: input.kind, changed: true },
          { field: "startLine", label: "起始行", before: null, after: input.startLine, changed: true },
          { field: "endLine", label: "结束行", before: null, after: input.endLine, changed: true },
          { field: "note", label: "内容", before: null, after: input.note, changed: true },
          { field: "quote", label: "引用正文", before: null, after: quote, changed: true }
        ],
        created: true,
        chapterTitle: chapter.title,
        chapterId: chapter.id
      };
    }
    if (entityType === "analysis-task") {
      const taskType = String(input.taskType);
      const modelId = typeof input.modelId === "string" ? input.modelId : undefined;
      const resolved = this.taskModelResolver
        ? this.taskModelResolver(workId, taskType, modelId)
        : null;
      return {
        action,
        module: "ai-analysis",
        entityType,
        targetLabel: taskType,
        fields: [
          { field: "taskType", label: "任务类型", before: null, after: taskType, changed: true },
          { field: "modelId", label: "模型", before: null, after: resolved?.id ?? modelId ?? null, changed: true },
          ...(resolved?.displayName ? [{ field: "modelDisplayName", label: "模型名称", before: null, after: resolved.displayName, changed: true }] : []),
          { field: "scope", label: "分析范围", before: null, after: input.scope ?? { type: "book" }, changed: true }
        ],
        created: true
      };
    }
    if (action === "create") {
      const fields = this.entityFields(entityType).filter((field) => Object.prototype.hasOwnProperty.call(input, field));
      return {
        action,
        module: AI_WRITE_OPERATION_MODULES[operationType],
        entityType,
        targetLabel: "新增",
        fields: fields.map((field) => ({ field, label: field, before: null, after: input[field] ?? null, changed: true })),
        created: true
      };
    }
    if (!current) throw notFound(AI_WRITE_ENTITY_LABELS[entityType] ?? "操作对象");
    const fields = this.entityFields(entityType).filter((field) => Object.prototype.hasOwnProperty.call(input, field));
    const changes = fields
      .map((field) => {
        const before = field in current ? current[field] : null;
        const after = input[field];
        return { field, label: field, before, after, changed: !equalJson(before, after) };
      })
      .filter((change) => change.changed);
    return {
      action,
      module: AI_WRITE_OPERATION_MODULES[operationType],
      entityType,
      targetLabel: String(current.name ?? current.title ?? current.id ?? current.chapterTitle ?? ""),
      fields: changes,
      created: false
    };
  }

  private operationTargetVersion(
    workId: string,
    operationType: AiWriteOperationType,
    current: Record<string, unknown> | null,
    input: Record<string, unknown>
  ): { targetVersion: number | null; targetLabel: string } {
    const entityType = operationEntityType(operationType);
    if (entityType === "chapter-annotation") {
      const chapter = current;
      if (!chapter) throw notFound("章节");
      return { targetVersion: Number(chapter.versionNo), targetLabel: `《${String(chapter.title)}》L${String(input.startLine)}-L${String(input.endLine)}` };
    }
    if (entityType === "analysis-task") {
      const scope = parseRecord(input.scope) ?? { type: "book" };
      const sourceVersions = this.store.analysisTaskScopeSourceVersions(workId, scope);
      return { targetVersion: JSON.stringify(sourceVersions).length, targetLabel: String(input.taskType) };
    }
    if (operationAction(operationType) === "create") {
      return { targetVersion: 0, targetLabel: `新增${AI_WRITE_ENTITY_LABELS[entityType] ?? entityType}` };
    }
    if (!current) throw notFound(AI_WRITE_ENTITY_LABELS[entityType] ?? "操作对象");
    return { targetVersion: Number(current.versionNo ?? 0), targetLabel: String(current.name ?? current.title ?? current.chapterTitle ?? current.id ?? "") };
  }

  private resolveOperation(
    workId: string,
    operationType: AiWriteOperationType,
    rawInput: unknown,
    requester: AiWriteActor,
    owner: AiWriteActor,
    requesterAllowAdmin: boolean,
    ownerAllowAdmin: boolean
  ): AiWriteOperationRecord {
    const input = parseAiWriteOperation(operationType, rawInput);
    const entityType = operationEntityType(operationType);
    const targetId = this.targetIdFor(input, operationType);
    const current = this.currentEntity(entityType, targetId, operationType);
    if (current && String(current.workId) !== workId) {
      throw new AppError(400, "AI_WRITE_TARGET_WORK_MISMATCH", "操作对象不属于当前作品，已拒绝执行");
    }
    const toolKey = AI_WRITE_OPERATION_TOOL_KEYS[operationType];
    this.assertToolEnabled(workId, toolKey);
    const module = AI_WRITE_OPERATION_MODULES[operationType];
    const readModules = operationType === "analysis-task.create"
      ? analysisTaskReadModules(input.taskType, input.scope)
      : [];
    this.assertModulePermissions(workId, requester, owner, requesterAllowAdmin, ownerAllowAdmin, module, readModules);
    if (operationType === "analysis-task.create" && this.taskModelResolver) {
      const resolved = this.taskModelResolver(
        workId,
        String(input.taskType),
        typeof input.modelId === "string" ? input.modelId : undefined
      );
      input.modelId = resolved.id;
    }
    const { targetVersion, targetLabel } = this.operationTargetVersion(workId, operationType, current, input);
    const diff = this.diffForOperation(workId, operationType, input, current, entityType);
    const diffFields = Array.isArray(diff.fields) ? diff.fields : [];
    if (diffFields.length === 0) {
      throw new AppError(400, "AI_WRITE_OPERATION_EMPTY", "该操作没有产生任何字段修改，请重新提交");
    }
    return {
      id: id("aiWriteOperation"),
      operationIndex: 0,
      operationType,
      module,
      toolKey,
      entityType,
      targetId,
      targetVersion,
      targetLabel,
      input,
      diff,
      status: "pending",
      result: null,
      failure: null
    };
  }

  createPlanFromTool(input: {
    workId: string;
    conversationId: string | null;
    toolCallId: string;
    toolName: AiWriteToolName;
    arguments: Record<string, unknown>;
    requester: AiWriteActor;
    requesterAllowAdminAccess: boolean;
    ownerAllowAdminAccess?: boolean;
  }): AiWriteApprovalRecord {
    const operationType = TOOL_TO_OPERATION[input.toolName];
    if (!operationType) throw new AppError(400, "AI_WRITE_TOOL_UNKNOWN", `未知可写工具：${input.toolName}`);
    return this.createPlan({
      workId: input.workId,
      conversationId: input.conversationId,
      aiSummary: typeof input.arguments.summary === "string" ? input.arguments.summary : `AI 请求执行${input.toolName}`,
      operations: [{ operationType, input: input.arguments }],
      requester: input.requester,
      requesterAllowAdminAccess: input.requesterAllowAdminAccess,
      ownerAllowAdminAccess: input.ownerAllowAdminAccess,
      toolCallId: input.toolCallId
    });
  }

  createPlan(input: {
    workId: string;
    conversationId: string | null;
    aiSummary: string;
    operations: Array<{ operationType: AiWriteOperationType; input: Record<string, unknown> }>;
    requester: AiWriteActor;
    requesterAllowAdminAccess: boolean;
    ownerAllowAdminAccess?: boolean;
    toolCallId?: string;
  }): AiWriteApprovalRecord {
    this.store.getWork(input.workId);
    if (input.operations.length < 1 || input.operations.length > this.maxPlanOperations) {
      throw new AppError(400, "AI_WRITE_PLAN_OPERATION_LIMIT", `一份修改计划最多包含 ${this.maxPlanOperations} 项操作`, {
        maximum: this.maxPlanOperations
      });
    }
    const requesterUserId = input.requester?.userId ?? null;
    const ownerUserId = this.conversationOwnerId(input.conversationId, input.workId, requesterUserId);
    const owner = ownerUserId ? this.auth.getUser(ownerUserId) : null;
    if (owner && owner.status !== "active") throw new AppError(403, "AI_WRITE_OWNER_INACTIVE", "AI 对话归属用户已停用");
    const resolved = input.operations.map((operation, index) => {
      const record = this.resolveOperation(
        input.workId,
        operation.operationType,
        operation.input,
        input.requester,
        owner,
        input.requesterAllowAdminAccess,
        input.ownerAllowAdminAccess ?? input.requesterAllowAdminAccess
      );
      record.operationIndex = index;
      return record;
    });
    const approvalId = id("aiWriteApproval");
    const timestamp = now();
    const expiresAt = new Date(Date.now() + this.approvalTtlMs).toISOString();
    const plan = {
      id: approvalId,
      planVersion: 1,
      workId: input.workId,
      conversationId: input.conversationId,
      aiSummary: input.aiSummary.trim(),
      requestUserId: requesterUserId,
      ownerUserId,
      maxPlanOperations: this.maxPlanOperations,
      createdBy: "system",
      createdAt: timestamp,
      expiresAt,
      operations: resolved.map((operation) => ({
        id: operation.id,
        operationIndex: operation.operationIndex,
        operationType: operation.operationType,
        module: operation.module,
        toolKey: operation.toolKey,
        entityType: operation.entityType,
        targetId: operation.targetId,
        targetVersion: operation.targetVersion,
        targetLabel: operation.targetLabel,
        input: operation.input,
        diff: operation.diff
      }))
    };
    this.store.db.transaction(() => {
      this.store.db.run(
        `INSERT INTO ai_write_approvals
          (id, work_id, conversation_id, status, plan_json, ai_summary, request_user_id, owner_user_id, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        approvalId,
        input.workId,
        input.conversationId,
        JSON.stringify(plan),
        input.aiSummary.trim(),
        requesterUserId,
        ownerUserId,
        expiresAt,
        timestamp,
        timestamp
      );
      for (const operation of resolved) {
        this.store.db.run(
          `INSERT INTO ai_write_plan_operations
            (id, approval_id, operation_index, operation_type, module, entity_type, target_id, target_version,
             input_json, diff_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          operation.id,
          approvalId,
          operation.operationIndex,
          operation.operationType,
          operation.module,
          operation.entityType,
          operation.targetId,
          operation.targetVersion,
          JSON.stringify(operation.input),
          JSON.stringify(operation.diff),
          timestamp,
          timestamp
        );
      }
      this.recordEvent(approvalId, "plan.created", "pending", requesterUserId, "", {
        toolCallId: input.toolCallId ?? null,
        operationCount: resolved.length
      });
      this.store.audit(input.workId, "ai-write.plan.created", "ai-write-approval", approvalId, {
        requesterUserId: requesterUserId,
        ownerUserId,
        operationCount: resolved.length
      });
    });
    return this.getApproval(approvalId, input.requester, input.requesterAllowAdminAccess);
  }


  private recordEvent(
    approvalId: string,
    action: string,
    status: string,
    actorUserId: string | null,
    reason = "",
    details: Record<string, unknown> = {}
  ): void {
    this.store.db.run(
      `INSERT INTO ai_write_approval_events (id, approval_id, action, status, actor_user_id, reason, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id("aiWriteApprovalEvent"),
      approvalId,
      action,
      status,
      actorUserId,
      reason,
      JSON.stringify(details),
      now()
    );
  }

  private expireApprovalRows(workId?: string): void {
    const timestamp = new Date().toISOString();
    const sql = workId
      ? `UPDATE ai_write_approvals SET status = 'expired', updated_at = ?, invalid_reason = '审批已过期，请重新提交修改计划'
         WHERE work_id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`
      : `UPDATE ai_write_approvals SET status = 'expired', updated_at = ?, invalid_reason = '审批已过期，请重新提交修改计划'
         WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`;
    this.store.db.run(sql, ...(workId ? [timestamp, workId, timestamp] : [timestamp, timestamp]));
  }

  private approvalRow(approvalId: string): Record<string, unknown> {
    this.expireApprovalRows();
    const row = this.store.db.get("SELECT * FROM ai_write_approvals WHERE id = ?", approvalId);
    if (!row) throw notFound("AI 操作审批");
    return row;
  }

  private operationRows(approvalId: string): AiWriteOperationRecord[] {
    return this.store.db.all(
      "SELECT * FROM ai_write_plan_operations WHERE approval_id = ? ORDER BY operation_index, created_at, rowid",
      approvalId
    ).map((row) => {
      const diff = json<Record<string, unknown>>(String(row.diff_json), {});
      const input = json<Record<string, unknown>>(String(row.input_json), {});
      return {
        id: String(row.id),
        operationIndex: Number(row.operation_index),
        operationType: String(row.operation_type) as AiWriteOperationType,
        module: String(row.module) as WorkPermissionModule,
        toolKey: AI_WRITE_OPERATION_TOOL_KEYS[String(row.operation_type) as AiWriteOperationType],
        entityType: String(row.entity_type),
        targetId: row.target_id === null ? null : String(row.target_id),
        targetVersion: row.target_version === null ? null : Number(row.target_version),
        targetLabel: typeof diff.targetLabel === "string" ? diff.targetLabel : String(row.target_id ?? input.title ?? input.name ?? ""),
        input,
        diff,
        status: String(row.status) as AiWriteOperationRecord["status"],
        result: row.result_json ? json<Record<string, unknown> | null>(String(row.result_json), null) : null,
        failure: row.failure_json ? String(row.failure_json) : null
      };
    });
  }

  private mapApproval(row: Record<string, unknown>): AiWriteApprovalRecord {
    const approvalId = String(row.id);
    return {
      id: approvalId,
      workId: String(row.work_id),
      conversationId: row.conversation_id === null ? null : String(row.conversation_id),
      status: String(row.status) as AiWriteApprovalRecord["status"],
      aiSummary: String(row.ai_summary),
      requestUserId: row.request_user_id === null ? null : String(row.request_user_id),
      ownerUserId: row.owner_user_id === null ? null : String(row.owner_user_id),
      plan: json<Record<string, unknown>>(String(row.plan_json), {}),
      expiresAt: row.expires_at === null ? null : String(row.expires_at),
      invalidReason: String(row.invalid_reason),
      failures: json<unknown[]>(String(row.failure_json), []),
      executedAt: row.executed_at === null ? null : String(row.executed_at),
      executedByUserId: row.executed_by_user_id === null ? null : String(row.executed_by_user_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      operations: this.operationRows(approvalId),
      events: this.store.db.all(
        `SELECT event.*, user.display_name AS actor_display_name, user.username AS actor_username
         FROM ai_write_approval_events event LEFT JOIN users user ON user.id = event.actor_user_id
         WHERE event.approval_id = ? ORDER BY event.created_at, event.rowid`,
        approvalId
      ).map((event) => ({
        id: String(event.id),
        action: String(event.action),
        status: String(event.status),
        actor: String(event.actor_display_name ?? event.actor_username ?? "系统"),
        reason: String(event.reason),
        details: json<Record<string, unknown>>(String(event.details_json), {}),
        createdAt: String(event.created_at)
      }))
    };
  }

  private approvalPermissions(actor: AiWriteActor, workId: string, allowAdminAccess: boolean): WorkModulePermissions {
    if (!actor) return this.auth.hasUsers() ? emptyWorkModulePermissions() : fullWorkModulePermissions();
    return this.auth.workModulePermissions(actor, workId, allowAdminAccess) ?? emptyWorkModulePermissions();
  }

  private redactApprovalForPermissions(record: AiWriteApprovalRecord, permissions: WorkModulePermissions): AiWriteApprovalRecord {
    const redactOperation = (operation: Record<string, unknown>): Record<string, unknown> => {
      const module = String(operation.module ?? "settings") as WorkPermissionModule;
      let readable = canReadWorkModule(permissions, module);
      const input = operation.input && typeof operation.input === "object" ? operation.input as Record<string, unknown> : {};
      if (String(operation.operationType) === "analysis-task.create") {
        readable = readable && analysisTaskReadModules(input.taskType, input.scope)
          .every((readModule) => canReadWorkModule(permissions, readModule));
      }
      if (readable) return operation;
      return {
        ...operation,
        targetLabel: "受限对象",
        input: { restricted: true },
        diff: {
          restricted: true,
          targetLabel: "受限对象",
          fields: [{ field: "restricted", label: "内容受限", before: null, after: null, changed: false }]
        }
      };
    };
    const redacted = { ...record };
    const plan = record.plan && typeof record.plan === "object" ? record.plan as Record<string, unknown> : null;
    if (plan && Array.isArray(plan.operations)) {
      redacted.plan = { ...plan, operations: plan.operations.map((operation) => redactOperation(operation as Record<string, unknown>)) };
    }
    redacted.operations = record.operations.map((operation) => redactOperation(operation as unknown as Record<string, unknown>) as unknown as AiWriteOperationRecord);
    if (redacted.operations.some((operation) => operation.diff?.restricted === true)) {
      redacted.aiSummary = "内容受限的 AI 修改计划";
    }
    return redacted;
  }

  getApproval(approvalId: string, requester: AiWriteActor, requesterAllowAdminAccess = true): AiWriteApprovalRecord {
    const row = this.approvalRow(approvalId);
    const workId = String(row.work_id);
    this.assertActorWorkAccess(requester, workId, requesterAllowAdminAccess);
    return this.redactApprovalForPermissions(
      this.mapApproval(row),
      this.approvalPermissions(requester, workId, requesterAllowAdminAccess)
    );
  }
  listApprovalsPage(
    workId: string,
    requester: AiWriteActor,
    requesterAllowAdminAccess: boolean,
    pagination: { page: number; limit: number; offset: number },
    status?: string
  ): { items: AiWriteApprovalRecord[]; page: number; limit: number; total: number; offset: number } {
    this.assertActorWorkAccess(requester, workId, requesterAllowAdminAccess);
    this.expireApprovalRows(workId);
    const page = Math.max(1, Math.min(1_000_000, Math.trunc(pagination.page)));
    const limit = Math.max(1, Math.min(100, Math.trunc(pagination.limit)));
    const offset = (page - 1) * limit;
    const statusFilter = status && ["pending", "rejected", "expired", "invalid", "executing", "succeeded", "failed"].includes(status)
      ? "AND status = ?"
      : "";
    const params: Array<string | number> = statusFilter
      ? [workId, status as string, limit, offset]
      : [workId, limit, offset];
    const rows = this.store.db.all(
      `SELECT id FROM ai_write_approvals WHERE work_id = ? ${statusFilter}
       ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'executing' THEN 1 ELSE 2 END, created_at DESC
       LIMIT ? OFFSET ?`,
      ...params
    );
    const total = Number(this.store.db.get(
      `SELECT COUNT(*) AS count FROM ai_write_approvals WHERE work_id = ? ${statusFilter}`,
      ...(statusFilter ? [workId, status as string] : [workId])
    )?.count ?? 0);
    const permissions = this.approvalPermissions(requester, workId, requesterAllowAdminAccess);
    return {
      items: rows.map((row) => this.redactApprovalForPermissions(this.mapApproval(row), permissions)),
      page,
      limit,
      total,
      offset
    };
  }

  rejectApproval(approvalId: string, requester: AiWriteActor, requesterAllowAdminAccess: boolean, reason = ""): AiWriteApprovalRecord {
    const row = this.approvalRow(approvalId);
    const workId = String(row.work_id);
    this.assertActorWorkAccess(requester, workId, requesterAllowAdminAccess);
    const timestamp = now();
    this.store.db.transaction(() => {
      const locked = this.store.db.get("SELECT id, status FROM ai_write_approvals WHERE id = ?", approvalId);
      if (!locked) throw notFound("AI 操作审批");
      if (String(locked.status) !== "pending") {
        throw new AppError(409, "AI_WRITE_APPROVAL_NOT_PENDING", "只有待确认的审批可以拒绝", {
          status: String(locked.status)
        });
      }
      this.store.db.run(
        `UPDATE ai_write_approvals SET status = 'rejected', updated_at = ?, invalid_reason = ? WHERE id = ?`,
        timestamp,
        reason.trim().slice(0, 500),
        approvalId
      );
      this.recordEvent(approvalId, "approval.rejected", "rejected", requester?.userId ?? null, reason.trim().slice(0, 500), {});
      this.store.audit(workId, "ai-write.approval.rejected", "ai-write-approval", approvalId, {
        actorUserId: requester?.userId ?? null,
        reason: reason.trim().slice(0, 500)
      });
    });
    return this.getApproval(approvalId, requester, requesterAllowAdminAccess);
  }

  private validateBeforeExecution(approvalId: string, requester: AiWriteActor, requesterAllowAdminAccess: boolean): string[] {
    const row = this.store.db.get("SELECT * FROM ai_write_approvals WHERE id = ?", approvalId);
    if (!row) throw notFound("AI 操作审批");
    const workId = String(row.work_id);
    const problems: string[] = [];
    const ownerUserId = row.owner_user_id === null ? null : String(row.owner_user_id);
    let owner: AiWriteActor = null;
    if (ownerUserId) {
      try {
        owner = this.auth.getUser(ownerUserId);
      } catch {
        problems.push("AI 对话归属用户已不存在");
        return problems;
      }
      if (owner.status !== "active") problems.push("AI 对话归属用户已被停用");
    }
    if (requester && requester.status !== "active") problems.push("当前用户已被停用");
    try {
      this.assertActorWorkAccess(requester, workId, requesterAllowAdminAccess);
    } catch (error) {
      problems.push(error instanceof AppError ? error.message : "当前用户已失去作品访问权限");
    }
    const writeTools = this.workWriteToolSettings(workId);
    for (const operation of this.operationRows(approvalId)) {
      const key = AI_WRITE_OPERATION_TOOL_KEYS[operation.operationType];
      if (!writeTools[key]) problems.push(`可写工具“${key}”已被关闭`);
      const module = AI_WRITE_OPERATION_MODULES[operation.operationType];
      let requesterPermissions: WorkModulePermissions | null = null;
      let ownerPermissions: WorkModulePermissions | null = null;
      try {
        requesterPermissions = this.actorPermissions(requester, workId, requesterAllowAdminAccess);
      } catch {
        problems.push("当前用户已失去作品访问权限");
      }
      try {
        ownerPermissions = this.actorPermissions(owner, workId, requesterAllowAdminAccess);
      } catch {
        problems.push("AI 对话归属用户已失去作品访问权限");
      }
      if (!requesterPermissions) {
        problems.push("当前用户已失去作品访问权限");
      } else if (!canWriteWorkModule(requesterPermissions, module)) {
        problems.push(`当前用户缺少“${module}”模块写权限`);
      }
      if (!ownerPermissions) {
        problems.push("AI 对话归属用户已失去作品访问权限");
      } else if (!canWriteWorkModule(ownerPermissions, module)) {
        problems.push(`AI 对话归属用户缺少“${module}”模块写权限`);
      }
      if (operation.operationType === "analysis-task.create") {
        const readModules = analysisTaskReadModules(operation.input.taskType, operation.input.scope);
        for (const [label, permissions] of [["当前用户", requesterPermissions], ["AI 对话归属用户", ownerPermissions]] as const) {
          if (!permissions) continue;
          for (const readModule of readModules) {
            if (!canReadWorkModule(permissions, readModule)) problems.push(`${label}缺少分析范围所需的“${readModule}”读取权限`);
          }
        }
      }
      if (operation.operationType !== "analysis-task.create" && operation.targetId) {
        const current = this.currentEntity(operation.entityType, operation.targetId, operation.operationType);
        if (!current) {
          problems.push(`${AI_WRITE_ENTITY_LABELS[operation.entityType] ?? operation.entityType} 已不存在`);
        } else {
          if (String(current.workId) !== workId) problems.push(`${AI_WRITE_ENTITY_LABELS[operation.entityType] ?? operation.entityType} 不属于当前作品`);
          const currentVersion = Number(current.versionNo ?? 0);
          if (operation.targetVersion !== null && currentVersion !== operation.targetVersion) {
            problems.push(`${AI_WRITE_ENTITY_LABELS[operation.entityType] ?? operation.entityType} 目标版本已变化（计划 v${String(operation.targetVersion)}，当前 v${String(currentVersion)}）`);
          }
        }
      }
      if (operation.operationType === "chapter-annotation.create" && operation.targetId) {
        const chapter = this.store.getChapter(operation.targetId);
        if (String(chapter.workId) !== workId) problems.push("批注章节不属于当前作品");
        else if (Number(chapter.versionNo) !== operation.targetVersion) {
          problems.push(`章节正文版本已变化（计划 v${String(operation.targetVersion)}，当前 v${String(chapter.versionNo)}）`);
        }
      }
      if (operation.operationType === "analysis-task.create") {
        const scope = parseRecord(operation.input.scope) ?? { type: "book" };
        const currentVersions = this.store.analysisTaskScopeSourceVersions(workId, scope);
        const expectedVersion = operation.targetVersion ?? 0;
        const currentVersion = JSON.stringify(currentVersions).length;
        if (currentVersion !== expectedVersion) problems.push("分析范围所引用资料的版本已变化");
        try {
          this.taskModelResolver?.(
            workId,
            String(operation.input.taskType),
            typeof operation.input.modelId === "string" ? operation.input.modelId : undefined
          );
        } catch (error) {
          problems.push(error instanceof AppError ? `分析任务模型不可用：${error.message}` : "分析任务模型不可用");
        }
      }
    }
    return problems;
  }

  private markInvalid(approvalId: string, requester: AiWriteActor, problems: string[]): void {
    const reason = problems.join("；");
    const timestamp = now();
    this.store.db.transaction(() => {
      this.store.db.run(
        `UPDATE ai_write_approvals SET status = 'invalid', invalid_reason = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
        reason.slice(0, 2_000),
        timestamp,
        approvalId
      );
      this.recordEvent(approvalId, "approval.invalidated", "invalid", requester?.userId ?? null, reason.slice(0, 2_000), {
        problems
      });
    });
  }

  private operationResult(entityType: string, targetId: string | null, operationType: AiWriteOperationType): Record<string, unknown> {
    if (!targetId) return {};
    const current = this.currentEntity(entityType, targetId, operationType);
    if (!current) return { entityId: targetId };
    return {
      entityId: targetId,
      ...(current.versionNo !== undefined ? { versionNo: Number(current.versionNo) } : {}),
      ...(typeof current.name === "string" ? { name: current.name } : {}),
      ...(typeof current.title === "string" ? { title: current.title } : {})
    };
  }

  private executeOperation(
    operation: AiWriteOperationRecord,
    approvalId: string,
    aiSummary: string,
    workId: string
  ): Record<string, unknown> {
    const input = operation.input;
    const source = "ai-write";
    const sourceRef = approvalId;
    const changeNote = aiSummary;
    switch (operation.operationType) {
      case "setting.create": {
        const { summary: _summary, ...payload } = input;
        return this.store.createSetting(workId, payload as never, source, sourceRef);
      }
      case "setting.update": {
        const { summary: _summary, settingId: _target, ...payload } = input;
        return this.store.updateSetting(String(input.settingId), payload as never, source, sourceRef, changeNote, operation.targetVersion ?? undefined);
      }
      case "character.create": {
        const { summary: _summary, ...payload } = input;
        return this.store.createCharacter(workId, payload as never);
      }
      case "character.update": {
        const { summary: _summary, characterId: _target, ...payload } = input;
        return this.store.updateCharacter(String(input.characterId), payload as never, source, sourceRef, changeNote, operation.targetVersion ?? undefined);
      }
      case "race.create": {
        const { summary: _summary, ...payload } = input;
        return this.store.createRace(workId, payload as never);
      }
      case "race.update": {
        const { summary: _summary, raceId: _target, ...payload } = input;
        return this.store.updateRace(String(input.raceId), payload as never, source, sourceRef, changeNote, operation.targetVersion ?? undefined);
      }
      case "organization.create": {
        const { summary: _summary, ...payload } = input;
        return this.store.createOrganization(workId, payload as never);
      }
      case "organization.update": {
        const { summary: _summary, organizationId: _target, ...payload } = input;
        return this.store.updateOrganization(String(input.organizationId), payload as never, source, sourceRef, changeNote, operation.targetVersion ?? undefined);
      }
      case "timeline-event.create": {
        const { summary: _summary, ...payload } = input;
        return this.store.createTimelineEvent(workId, payload as never, source, sourceRef);
      }
      case "timeline-event.update": {
        const { summary: _summary, eventId: _target, ...payload } = input;
        return this.store.updateTimelineEvent(String(input.eventId), payload as never, source, sourceRef, changeNote, operation.targetVersion ?? undefined);
      }
      case "relationship.create": {
        const { summary: _summary, ...payload } = input;
        return this.store.createRelationship(workId, payload as never, source, sourceRef);
      }
      case "relationship.update": {
        const { summary: _summary, relationshipId: _target, ...payload } = input;
        return this.store.updateRelationship(String(input.relationshipId), payload as never, source, sourceRef, changeNote, operation.targetVersion ?? undefined);
      }
      case "chapter-outline.create":
      case "chapter-outline.update": {
        const { summary: _summary, chapterId, ...payload } = input;
        return this.store.upsertChapterOutline(String(chapterId), payload as never, source, sourceRef, changeNote, operation.targetVersion ?? undefined);
      }
      case "foreshadow.create": {
        const { summary: _summary, ...payload } = input;
        return this.store.createForeshadow(workId, payload as never);
      }
      case "foreshadow.update": {
        const { summary: _summary, foreshadowId: _target, ...payload } = input;
        return this.store.updateForeshadow(String(input.foreshadowId), payload as never, source, sourceRef, changeNote, operation.targetVersion ?? undefined);
      }
      case "chapter-annotation.create": {
        const { summary: _summary, chapterId, kind, startLine, endLine, note } = input;
        return this.store.createChapterAnnotation(String(chapterId), {
          kind: kind as "note" | "todo",
          startLine: Number(startLine),
          endLine: Number(endLine),
          note: String(note)
        });
      }
      case "analysis-task.create": {
        if (!this.taskCreator) throw new AppError(500, "AI_WRITE_EXECUTOR_UNAVAILABLE", "分析任务执行器未初始化");
        const { summary: _summary, taskType, scope, modelId } = input;
        return this.taskCreator(workId, {
          taskType: String(taskType),
          ...(parseRecord(scope) ? { scope: parseRecord(scope) as Record<string, unknown> } : {}),
          ...(typeof modelId === "string" && modelId ? { modelId } : {})
        });
      }
    }
  }

  approve(approvalId: string, requester: AiWriteActor, requesterAllowAdminAccess: boolean): AiWriteApprovalRecord {
    const row = this.approvalRow(approvalId);
    const workId = String(row.work_id);
    this.assertActorWorkAccess(requester, workId, requesterAllowAdminAccess);
    if (String(row.status) === "succeeded") {
      return this.mapApproval(row);
    }
    if (String(row.status) !== "pending") {
      throw new AppError(409, "AI_WRITE_APPROVAL_NOT_PENDING", `审批当前状态为 ${String(row.status)}，不能重复执行`, {
        status: String(row.status)
      });
    }
    const problems = this.validateBeforeExecution(approvalId, requester, requesterAllowAdminAccess);
    if (problems.length > 0) {
      this.markInvalid(approvalId, requester, problems);
      throw new AppError(409, "AI_WRITE_APPROVAL_INVALID", "审批条件已发生变化，禁止继续执行", {
        approvalId,
        problems,
        status: "invalid"
      });
    }
    const summary = String(row.ai_summary);
    const operations = this.operationRows(approvalId);
    const timestamp = now();
    let failedIndex = -1;
    let failure: unknown = null;
    try {
      this.store.db.transaction(() => {
        const locked = this.store.db.get("SELECT id, status FROM ai_write_approvals WHERE id = ?", approvalId);
        if (!locked || String(locked.status) !== "pending") {
          throw new AppError(409, "AI_WRITE_APPROVAL_NOT_PENDING", "审批已被其他请求处理，不能重复执行", {
            status: locked ? String(locked.status) : "missing"
          });
        }
        this.store.db.run(
          `UPDATE ai_write_approvals SET status = 'executing', updated_at = ? WHERE id = ? AND status = 'pending'`,
          timestamp,
          approvalId
        );
        this.recordEvent(approvalId, "approval.executing", "executing", requester?.userId ?? null, "", { operationCount: operations.length });
        for (const operation of operations) {
          failedIndex = operation.operationIndex;
          const result = this.executeOperation(operation, approvalId, summary, workId);
          const createdEntity = operationAction(operation.operationType) === "create"
            ? {
                ...(typeof result.id === "string" ? { entityId: result.id } : {}),
                ...(typeof result.chapterId === "string" ? { entityId: result.chapterId } : {}),
                ...(typeof result.versionNo === "number" ? { versionNo: result.versionNo } : {})
              }
            : {};
          const finalResult = {
            ...(operation.entityType === "analysis-task"
              ? { taskId: String(result.id ?? "") }
              : { ...createdEntity, ...this.operationResult(operation.entityType, operation.targetId, operation.operationType) }),
            ...(operation.entityType === "analysis-task" && typeof result.taskType === "string" ? { taskType: result.taskType } : {}),
            actorUserId: requester?.userId ?? null,
            executedAt: timestamp
          };
          this.store.db.run(
            `UPDATE ai_write_plan_operations SET status = 'executed', result_json = ?, updated_at = ? WHERE id = ?`,
            JSON.stringify(finalResult),
            timestamp,
            operation.id
          );
        }
        this.store.db.run(
          `UPDATE ai_write_approvals SET status = 'succeeded', executed_at = ?, executed_by_user_id = ?, updated_at = ? WHERE id = ?`,
          timestamp,
          requester?.userId ?? null,
          timestamp,
          approvalId
        );
        this.recordEvent(approvalId, "approval.executed", "succeeded", requester?.userId ?? null, "", {
          operationCount: operations.length
        });
        this.store.audit(workId, "ai-write.approval.executed", "ai-write-approval", approvalId, {
          actorUserId: requester?.userId ?? null,
          operationCount: operations.length
        });
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : "审批执行失败";
      const publicFailure = error instanceof AppError ? error.message : "审批执行失败，已回滚全部修改";
      logger.warn("ai-write.approval.execution_failed", {
        approvalId,
        failedIndex,
        error: sanitizeError(error)
      });
      this.store.db.transaction(() => {
        this.store.db.run(
          `UPDATE ai_write_approvals SET status = 'failed', failure_json = ?, updated_at = ? WHERE id = ?`,
          JSON.stringify([{ operationIndex: failedIndex, message: publicFailure }]),
          now(),
          approvalId
        );
        this.recordEvent(approvalId, "approval.failed", "failed", requester?.userId ?? null, publicFailure, {
          operationIndex: failedIndex
        });
        if (failedIndex >= 0) {
          const target = operations[failedIndex];
          if (target) {
            this.store.db.run(
              `UPDATE ai_write_plan_operations SET status = 'failed', failure_json = ?, updated_at = ? WHERE id = ?`,
              publicFailure,
              now(),
              target.id
            );
          }
        }
      });
      throw new AppError(500, "AI_WRITE_APPROVAL_EXECUTION_FAILED", publicFailure, {
        approvalId,
        operationIndex: failedIndex,
        failure: publicFailure
      });
    }
    return this.getApproval(approvalId, requester, requesterAllowAdminAccess);
  }


  private expireQuestionRows(): void {
    const timestamp = new Date().toISOString();
    this.store.db.run(
      `UPDATE ai_write_questions SET status = 'expired', updated_at = ?, invalid_reason = '提问已过期'
       WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
      timestamp,
      timestamp
    );
  }

  private questionRow(questionId: string): Record<string, unknown> {
    this.expireQuestionRows();
    const row = this.store.db.get("SELECT * FROM ai_write_questions WHERE id = ?", questionId);
    if (!row) throw notFound("AI 提问");
    return row;
  }

  private mapQuestion(row: Record<string, unknown>): AiWriteQuestionRecord {
    return {
      id: String(row.id),
      workId: String(row.work_id),
      conversationId: row.conversation_id === null ? null : String(row.conversation_id),
      question: String(row.question),
      options: json<string[]>(String(row.options_json), []),
      recommendedOptionIndex: Number(row.recommended_option_index),
      allowCustomAnswer: Number(row.allow_custom_answer) === 1,
      status: String(row.status) as AiWriteQuestionRecord["status"],
      answerText: row.answer_text === null ? null : String(row.answer_text),
      answerOptionIndex: row.answer_option_index === null ? null : Number(row.answer_option_index),
      answeredByUserId: row.answered_by_user_id === null ? null : String(row.answered_by_user_id),
      toolCallId: row.tool_call_id === null ? null : String(row.tool_call_id),
      invalidReason: String(row.invalid_reason),
      createdAt: String(row.created_at),
      expiresAt: row.expires_at === null ? null : String(row.expires_at),
      answeredAt: row.answered_at === null ? null : String(row.answered_at),
      updatedAt: String(row.updated_at)
    };
  }

  askQuestion(input: {
    workId: string;
    conversationId: string | null;
    question: string;
    options: string[];
    allowCustomAnswer: boolean;
    toolCallId: string | null;
    requester: AiWriteActor;
    requesterAllowAdminAccess: boolean;
  }): AiWriteQuestionRecord {
    const parsed = askUserQuestionsSchema.safeParse({
      question: input.question,
      options: input.options,
      allowCustomAnswer: input.allowCustomAnswer
    });
    if (!parsed.success) throw zodError(parsed.error);
    this.store.getWork(input.workId);
    this.assertToolEnabled(input.workId, "askUserQuestions");
    if (input.requester) {
      this.auth.assertWorkAccess(input.requester, input.workId, { anyWrite: ["ai-chat", "ai-analysis"] }, false, input.requesterAllowAdminAccess);
    }
    const requesterUserId = input.requester?.userId ?? null;
    if (input.conversationId) {
      this.conversationOwnerId(input.conversationId, input.workId, requesterUserId);
    }
    const questionId = id("aiWriteQuestion");
    const timestamp = now();
    const expiresAt = new Date(Date.now() + this.questionTtlMs).toISOString();
    this.store.db.transaction(() => {
      this.store.db.run(
        `UPDATE ai_write_questions SET status = 'invalid', updated_at = ?, invalid_reason = '已被新的提问取代'
         WHERE conversation_id = ? AND status = 'pending'`,
        timestamp,
        input.conversationId
      );
      this.store.db.run(
        `INSERT INTO ai_write_questions
          (id, work_id, conversation_id, question, options_json, recommended_option_index, allow_custom_answer,
           status, tool_call_id, created_at, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, 'pending', ?, ?, ?, ?)`,
        questionId,
        input.workId,
        input.conversationId,
        parsed.data.question,
        JSON.stringify(parsed.data.options),
        parsed.data.allowCustomAnswer === true ? 1 : 0,
        input.toolCallId,
        timestamp,
        expiresAt,
        timestamp
      );
      this.store.audit(input.workId, "ai-write.question.created", "ai-write-question", questionId, {
        conversationId: input.conversationId,
        optionCount: parsed.data.options.length,
        allowCustomAnswer: parsed.data.allowCustomAnswer === true
      });
    });
    return this.mapQuestion(this.questionRow(questionId));
  }

  getQuestion(questionId: string, requester: AiWriteActor, requesterAllowAdminAccess: boolean): AiWriteQuestionRecord {
    const row = this.questionRow(questionId);
    this.assertActorWorkAccess(requester, String(row.work_id), requesterAllowAdminAccess);
    return this.mapQuestion(row);
  }

  listQuestionsPage(
    workId: string,
    requester: AiWriteActor,
    requesterAllowAdminAccess: boolean,
    pagination: { page: number; limit: number; offset: number },
    status?: string
  ): { items: AiWriteQuestionRecord[]; page: number; limit: number; total: number; offset: number } {
    this.assertActorWorkAccess(requester, workId, requesterAllowAdminAccess);
    this.expireQuestionRows();
    const page = Math.max(1, Math.min(1_000_000, Math.trunc(pagination.page)));
    const limit = Math.max(1, Math.min(100, Math.trunc(pagination.limit)));
    const offset = (page - 1) * limit;
    const statusFilter = status && ["pending", "answered", "expired", "refused", "invalid"].includes(status)
      ? "AND status = ?"
      : "";
    const params: Array<string | number> = statusFilter
      ? [workId, status as string, limit, offset]
      : [workId, limit, offset];
    const rows = this.store.db.all(
      `SELECT id FROM ai_write_questions WHERE work_id = ? ${statusFilter}
       ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT ? OFFSET ?`,
      ...params
    );
    const total = Number(this.store.db.get(
      `SELECT COUNT(*) AS count FROM ai_write_questions WHERE work_id = ? ${statusFilter}`,
      ...(statusFilter ? [workId, status as string] : [workId])
    )?.count ?? 0);
    return { items: rows.map((row) => this.mapQuestion(this.store.db.get("SELECT * FROM ai_write_questions WHERE id = ?", String(row.id))!)), page, limit, total, offset };
  }

  answerQuestion(
    questionId: string,
    requester: AiWriteActor,
    requesterAllowAdminAccess: boolean,
    input: { answer?: string; optionIndex?: number | null; refuse?: boolean }
  ): AiWriteQuestionRecord {
    const row = this.questionRow(questionId);
    this.assertActorWorkAccess(requester, String(row.work_id), requesterAllowAdminAccess);
    const timestamp = now();
    const answer = input.answer?.trim() ?? "";
    const optionIndex = input.optionIndex === undefined || input.optionIndex === null ? null : Number(input.optionIndex);
    this.store.db.transaction(() => {
      const locked = this.questionRow(questionId);
      const workId = String(locked.work_id);
      if (String(locked.status) !== "pending") {
        throw new AppError(409, "AI_WRITE_QUESTION_NOT_PENDING", `提问当前状态为 ${String(locked.status)}，不能回答`, {
          status: String(locked.status)
        });
      }
      const options = json<string[]>(String(locked.options_json), []);
      const allowCustomAnswer = Number(locked.allow_custom_answer) === 1;
      if (input.refuse === true) {
        this.store.db.run(
          `UPDATE ai_write_questions SET status = 'refused', answered_by_user_id = ?, answered_at = ?, updated_at = ? WHERE id = ?`,
          requester?.userId ?? null,
          timestamp,
          timestamp,
          questionId
        );
        this.store.audit(workId, "ai-write.question.refused", "ai-write-question", questionId, { actorUserId: requester?.userId ?? null });
      } else if (optionIndex !== null) {
        if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) {
          throw new AppError(400, "AI_WRITE_QUESTION_OPTION_INVALID", "所选预置选项无效");
        }
        this.store.db.run(
          `UPDATE ai_write_questions SET status = 'answered', answer_option_index = ?, answer_text = ?,
           answered_by_user_id = ?, answered_at = ?, updated_at = ? WHERE id = ?`,
          optionIndex,
          options[optionIndex] ?? "",
          requester?.userId ?? null,
          timestamp,
          timestamp,
          questionId
        );
        this.store.audit(workId, "ai-write.question.answered", "ai-write-question", questionId, {
          actorUserId: requester?.userId ?? null,
          optionIndex,
          customAnswer: false
        });
      } else if (allowCustomAnswer && answer.length > 0 && answer.length <= 2000) {
        this.store.db.run(
          `UPDATE ai_write_questions SET status = 'answered', answer_option_index = NULL, answer_text = ?,
           answered_by_user_id = ?, answered_at = ?, updated_at = ? WHERE id = ?`,
          answer,
          requester?.userId ?? null,
          timestamp,
          timestamp,
          questionId
        );
        this.store.audit(workId, "ai-write.question.answered", "ai-write-question", questionId, {
          actorUserId: requester?.userId ?? null,
          optionIndex: null,
          customAnswer: true
        });
      } else {
        throw new AppError(400, "AI_WRITE_QUESTION_ANSWER_REQUIRED", allowCustomAnswer
          ? "请选择一个预置选项或输入自定义回答"
          : "请选择一个预置选项");
      }
    });
    return this.getQuestion(questionId, requester, requesterAllowAdminAccess);
  }

  undoApproval(approvalId: string, requester: AiWriteActor, requesterAllowAdminAccess: boolean, reason = ""): AiWriteApprovalRecord {
    const row = this.approvalRow(approvalId);
    const workId = String(row.work_id);
    this.assertActorWorkAccess(requester, workId, requesterAllowAdminAccess);
    if (String(row.status) !== "succeeded") {
      throw new AppError(409, "AI_WRITE_APPROVAL_NOT_SUCCEEDED", "只有执行成功的审批可以撤销", {
        status: String(row.status)
      });
    }
    const operations = this.operationRows(approvalId).filter((operation) => operation.operationType.endsWith(".update"));
    if (operations.length === 0) {
      throw new AppError(409, "AI_WRITE_APPROVAL_UNDO_UNSUPPORTED", "该审批不包含可撤销的既有词条编辑");
    }
    const timestamp = now();
    const undone: string[] = [];
    this.store.db.transaction(() => {
      const locked = this.store.db.get("SELECT id, status FROM ai_write_approvals WHERE id = ?", approvalId);
      if (!locked || String(locked.status) !== "succeeded") {
        throw new AppError(409, "AI_WRITE_APPROVAL_UNDO_CONFLICT", "审批状态已变化，不能重复撤销");
      }
      for (const operation of operations) {
        const current = this.currentEntity(operation.entityType, operation.targetId, operation.operationType);
        if (!current) throw new AppError(409, "AI_WRITE_UNDO_TARGET_MISSING", "目标词条已不存在，无法撤销");
        if (String(current.workId) !== workId) throw new AppError(409, "AI_WRITE_UNDO_TARGET_MOVED", "目标词条已不属于当前作品，无法撤销");
        if (operation.result?.versionNo !== undefined && Number(current.versionNo) !== Number(operation.result.versionNo)) {
          throw new AppError(409, "AI_WRITE_UNDO_VERSION_CONFLICT", `目标词条已被后续修改，当前为 v${String(current.versionNo)}，不能撤销`);
        }
        const targetVersion = operation.targetVersion ?? 0;
        if (operation.entityType === "character") {
          this.store.restoreCharacter(String(operation.targetId), targetVersion, Number(current.versionNo));
        } else if (["setting", "race", "organization", "timeline-event", "relationship", "chapter-outline", "foreshadow"].includes(operation.entityType)) {
          this.store.restoreEntityVersion(
            operation.entityType as "setting" | "race" | "organization" | "timeline-event" | "relationship" | "chapter-outline" | "foreshadow",
            String(operation.targetId),
            targetVersion,
            Number(current.versionNo)
          );
        } else {
          throw new AppError(409, "AI_WRITE_UNDO_UNSUPPORTED", "该操作类型不支持撤销");
        }
        this.store.db.run(
          `UPDATE ai_write_plan_operations SET status = 'undone', undo_status = 'undone', updated_at = ? WHERE id = ?`,
          timestamp,
          operation.id
        );
        undone.push(String(operation.targetId));
      }
      this.store.db.run(
        `UPDATE ai_write_approvals SET status = 'succeeded', updated_at = ? WHERE id = ?`,
        timestamp,
        approvalId
      );
      this.recordEvent(approvalId, "approval.undone", "succeeded", requester?.userId ?? null, reason.trim().slice(0, 500), {
        undoneOperationIds: undone
      });
      this.store.audit(workId, "ai-write.approval.undone", "ai-write-approval", approvalId, {
        actorUserId: requester?.userId ?? null,
        reason: reason.trim().slice(0, 500),
        undoneOperationIds: undone
      });
    });
    return this.getApproval(approvalId, requester, requesterAllowAdminAccess);
  }
}

