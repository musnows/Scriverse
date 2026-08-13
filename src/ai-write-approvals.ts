import type { Store } from "./store.js";
import type { WorkModulePermissions, WorkPermissionModule } from "./work-permissions.js";
import { canReadWorkModule, canWriteWorkModule } from "./work-permissions.js";
import { AppError } from "./errors.js";
import { id, json, now } from "./utils.js";
import type { PaginatedResult, Pagination } from "./pagination.js";
import { paginated, paginationSql } from "./pagination.js";
import type { Row } from "./database.js";

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") return "";
  return value;
}

function optionalString(row: Row, key: string): string | null {
  const value = row[key];
  if (typeof value !== "string") return null;
  return value;
}

function numberValue(row: Row, key: string): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : 0;
}

export const AI_WRITE_TOOL_IDS = [
  "create_story_entity",
  "update_story_entity",
  "create_chapter_annotation",
  "create_analysis_task",
  "ask_user_question"
] as const;
export type AiWriteToolId = (typeof AI_WRITE_TOOL_IDS)[number];

/** 作品设置页分别控制的工具开关键。 */
export const AI_WRITE_TOOL_SWITCH_KEYS = [
  "entity:settings",
  "entity:characters",
  "entity:races",
  "entity:organizations",
  "entity:timeline",
  "entity:relationships",
  "entity:outlines",
  "annotation",
  "analysis-task",
  "ask-question"
] as const;
export type AiWriteToolSwitchKey = (typeof AI_WRITE_TOOL_SWITCH_KEYS)[number];

export const AI_WRITE_ENTITY_TYPES = [
  "setting",
  "character",
  "race",
  "organization",
  "timeline_event",
  "relationship",
  "outline",
  "foreshadow"
] as const;
export type AiWriteEntityType = (typeof AI_WRITE_ENTITY_TYPES)[number];

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

export const AI_QUESTION_STATUSES = ["pending", "answered", "declined", "expired", "invalidated"] as const;

export const DEFAULT_AI_WRITE_PLAN_MAX_OPERATIONS = 5;
export const AI_WRITE_PLAN_TTL_MS = 24 * 60 * 60 * 1000;

/** 解析 AI_WRITE_PLAN_MAX_OPERATIONS；无效或超出 1-20 范围时回退默认值并告警。 */
export function resolveAiWritePlanMaxOperations(value: string | undefined, warn?: (message: string) => void): number {
  if (value === undefined || value === "") return DEFAULT_AI_WRITE_PLAN_MAX_OPERATIONS;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 20) {
    warn?.(`AI_WRITE_PLAN_MAX_OPERATIONS 值 "${value}" 无效（有效范围 1-20），已回退默认值 ${DEFAULT_AI_WRITE_PLAN_MAX_OPERATIONS}`);
    return DEFAULT_AI_WRITE_PLAN_MAX_OPERATIONS;
  }
  return numeric;
}

const ENTITY_TYPE_MODULES: Record<AiWriteEntityType, WorkPermissionModule> = {
  setting: "settings",
  character: "characters",
  race: "races",
  organization: "organizations",
  timeline_event: "timeline",
  relationship: "relationships",
  outline: "outlines",
  foreshadow: "outlines"
};

export function entityTypeModule(entityType: AiWriteEntityType): WorkPermissionModule {
  return ENTITY_TYPE_MODULES[entityType];
}

/** 实体字段的中文标签（系统 diff 展示用）。 */
export const ENTITY_FIELD_LABELS: Record<AiWriteEntityType, Record<string, string>> = {
  setting: {
    title: "标题",
    category: "分类",
    content: "内容",
    tags: "标签",
    status: "状态"
  },
  character: {
    name: "姓名",
    code: "代号",
    aliases: "别名",
    species: "种族描述",
    raceId: "所属种族",
    organizationIds: "所属组织",
    attributes: "属性",
    profile: "档案",
    currentState: "当前状态",
    isDead: "是否死亡"
  },
  race: {
    name: "名称",
    parentRaceId: "父种族",
    description: "描述",
    isExtinct: "是否灭绝",
    settingsMarkdown: "设定"
  },
  organization: {
    name: "名称",
    description: "描述",
    isDissolved: "是否解散",
    settingsMarkdown: "设定"
  },
  timeline_event: {
    name: "名称",
    trackId: "所属时间轴",
    description: "描述",
    eventType: "事件类型",
    timeLabel: "时间标签",
    chapterIds: "关联章节",
    participantIds: "参与者",
    location: "地点",
    causes: "起因",
    impactScope: "影响范围",
    evidence: "证据",
    status: "状态"
  },
  relationship: {
    fromCharacterId: "起始人物",
    toCharacterId: "目标人物",
    category: "关系类型",
    subtype: "关系子类型",
    keywords: "关键词",
    directed: "是否单向",
    currentStatus: "当前状态",
    timeRange: "时间范围",
    confidence: "置信度",
    evidence: "证据",
    confirmationStatus: "确认状态",
    locked: "是否锁定"
  },
  outline: {
    goal: "本章目标",
    conflict: "冲突",
    turningPoint: "转折点",
    notes: "备注",
    status: "状态"
  },
  foreshadow: {
    title: "标题",
    description: "描述",
    status: "状态",
    importance: "重要程度",
    plannedPayoffChapterId: "计划揭晓章节"
  }
};

export type WriteOperationDiffEntry = {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
};

export type WriteOperationDraft = {
  operationType: "entity_create" | "entity_update" | "annotation_create" | "analysis_task";
  entityType?: AiWriteEntityType;
  targetModule: WorkPermissionModule;
  targetId?: string;
  targetVersion?: number;
  aiSummary: string;
  before: unknown;
  after: Record<string, unknown>;
  diff: WriteOperationDiffEntry[];
};

export type AiApprovalQuestionDraft = {
  question: string;
  options: Array<{ label: string; description?: string }>;
};

/** 权限解析器：返回 null 表示该用户无作品访问。 */
export type AiWritePermissionResolver = (userId: string, workId: string) => WorkModulePermissions | null;

export type AiWriteApprovalOptions = {
  maxOperations?: number;
  planTtlMs?: number;
  permissionResolver?: AiWritePermissionResolver;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** 从当前实体值中挑选计划涉及的字段，作为修改前值快照。 */
export function entityBeforeSnapshot(entityType: AiWriteEntityType, entity: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const field of fields) {
    const label = ENTITY_FIELD_LABELS[entityType][field];
    if (label === undefined) continue;
    snapshot[field] = entity[field] ?? null;
  }
  return snapshot;
}

/** 生成字段级系统 diff；新建词条 before 为 null，diff 展示全部字段。 */
export function buildFieldDiff(
  entityType: AiWriteEntityType,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>
): WriteOperationDiffEntry[] {
  const entries: WriteOperationDiffEntry[] = [];
  for (const [field, value] of Object.entries(after)) {
    const label = ENTITY_FIELD_LABELS[entityType][field];
    if (label === undefined) continue;
    const previous = before === null ? null : (before[field] ?? null);
    entries.push({ field, label, before: previous, after: value });
  }
  return entries;
}

function scalarDiffLabel(value: unknown): string {
  if (value === null || value === undefined) return "空";
  return String(value);
}

export class AiWriteApprovalManager {
  readonly maxOperations: number;
  private readonly planTtlMs: number;
  private readonly permissionResolver: AiWritePermissionResolver | null;

  constructor(private readonly store: Store, options: AiWriteApprovalOptions = {}) {
    this.maxOperations = options.maxOperations ?? DEFAULT_AI_WRITE_PLAN_MAX_OPERATIONS;
    this.planTtlMs = options.planTtlMs ?? AI_WRITE_PLAN_TTL_MS;
    this.permissionResolver = options.permissionResolver ?? null;
  }

  get db(): Store["db"] {
    return this.store.db;
  }

  // ---------- 工具开关 ----------

  /** 当前作品开启的写工具开关键集合。 */
  enabledWriteToolSwitches(workId: string): Set<AiWriteToolSwitchKey> {
    const settings = this.store.getWorkAiSettings(workId);
    const source = Array.isArray(settings.aiWriteTools)
      ? settings.aiWriteTools
      : typeof settings.aiWriteTools === "string"
        ? json<unknown[]>(settings.aiWriteTools, [])
        : [];
    const tools = source.filter((tool): tool is string => typeof tool === "string");
    return new Set(tools.filter((tool): tool is AiWriteToolSwitchKey =>
      (AI_WRITE_TOOL_SWITCH_KEYS as readonly string[]).includes(tool)));
  }

  isWriteToolSwitchEnabled(workId: string, switchKey: AiWriteToolSwitchKey): boolean {
    return this.enabledWriteToolSwitches(workId).has(switchKey);
  }

  /** 用户对指定模块的写权限；用户无作品访问时返回 false。 */
  userCanWriteModule(userId: string, workId: string, module: WorkPermissionModule): boolean {
    if (!this.permissionResolver) return false;
    const permissions = this.permissionResolver(userId, workId);
    return permissions !== null && canWriteWorkModule(permissions, module);
  }

  userCanReadModule(userId: string, workId: string, module: WorkPermissionModule): boolean {
    if (!this.permissionResolver) return false;
    const permissions = this.permissionResolver(userId, workId);
    return permissions !== null && canReadWorkModule(permissions, module);
  }

  /** 当前用户与对话归属用户的模块权限交集校验；返回不满足写权限的模块列表。 */
  missingIntersectionWriteModules(
    workId: string,
    requesterUserId: string | null,
    conversationOwnerUserId: string | null,
    modules: readonly WorkPermissionModule[]
  ): WorkPermissionModule[] {
    if (!this.permissionResolver) return [...modules];
    const missing = new Set<WorkPermissionModule>();
    for (const module of modules) {
      const requester = requesterUserId ? this.permissionResolver(requesterUserId, workId) : null;
      const owner = conversationOwnerUserId ? this.permissionResolver(conversationOwnerUserId, workId) : null;
      if (!requester || !canWriteWorkModule(requester, module)) missing.add(module);
      if (!owner || !canWriteWorkModule(owner, module)) missing.add(module);
    }
    return [...missing];
  }

  /** 当前用户与对话归属用户对该操作所需的读取模块交集校验（分析任务资料读取）。 */
  missingIntersectionReadModules(
    workId: string,
    requesterUserId: string | null,
    conversationOwnerUserId: string | null,
    modules: readonly WorkPermissionModule[]
  ): WorkPermissionModule[] {
    if (!this.permissionResolver) return [...modules];
    const missing = new Set<WorkPermissionModule>();
    for (const module of modules) {
      const requester = requesterUserId ? this.permissionResolver(requesterUserId, workId) : null;
      const owner = conversationOwnerUserId ? this.permissionResolver(conversationOwnerUserId, workId) : null;
      if (!requester || !canReadWorkModule(requester, module)) missing.add(module);
      if (!owner || !canReadWorkModule(owner, module)) missing.add(module);
    }
    return [...missing];
  }

  // ---------- 计划创建 ----------

  /**
   * 把工具草稿持久化为不可变修改计划。计划内容由系统基于当前数据库内容生成，
   * 持久化后不再修改；确认接口只接受审批 ID。
   */
  createPlan(input: {
    workId: string;
    conversationId: string | null;
    requesterUserId: string;
    conversationOwnerUserId: string;
    summary: string;
    operations: WriteOperationDraft[];
  }): Record<string, unknown> {
    const timestamp = now();
    const expiresAt = new Date(Date.parse(timestamp) + this.planTtlMs).toISOString();
    const planId = id("aiWritePlan");
    const requesterUserId = input.requesterUserId || null;
    const conversationOwnerUserId = input.conversationOwnerUserId || null;
    const plan = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO ai_write_plans (id, work_id, conversation_id, status, summary, plan_json,
           requested_by_user_id, conversation_owner_user_id, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        planId,
        input.workId,
        input.conversationId,
        input.summary.trim(),
        JSON.stringify({
          operationType: "plan",
          workId: input.workId,
          conversationId: input.conversationId,
          requesterUserId: requesterUserId,
          conversationOwnerUserId: conversationOwnerUserId,
          createdAt: timestamp,
          operations: input.operations.map((operation) => ({
            operationType: operation.operationType,
            entityType: operation.entityType ?? null,
            targetModule: operation.targetModule,
            targetId: operation.targetId ?? null,
            targetVersion: operation.targetVersion ?? null,
            aiSummary: operation.aiSummary,
            before: operation.before,
            after: operation.after,
            diff: operation.diff
          }))
        }),
        requesterUserId,
        conversationOwnerUserId,
        expiresAt,
        timestamp,
        timestamp
      );
      input.operations.forEach((operation, index) => {
        this.db.run(
          `INSERT INTO ai_write_plan_operations (id, plan_id, operation_index, operation_type, entity_type,
             target_module, target_id, target_version, ai_summary, before_json, after_json, diff_json,
             status, result_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '{}', ?)`,
          id("aiWriteOperation"),
          planId,
          index,
          operation.operationType,
          operation.entityType ?? "",
          operation.targetModule,
          operation.targetId ?? "",
          operation.targetVersion ?? null,
          operation.aiSummary.trim(),
          JSON.stringify(operation.before),
          JSON.stringify(operation.after),
          JSON.stringify(operation.diff),
          timestamp
        );
      });
      this.store.audit(input.workId, "ai-write-plan.created", "ai-write-plan", planId, {
        conversationId: input.conversationId,
        operationCount: input.operations.length,
        operations: input.operations.map((operation) => ({
          operationType: operation.operationType,
          entityType: operation.entityType ?? null,
          targetModule: operation.targetModule,
          targetId: operation.targetId ?? null,
          targetVersion: operation.targetVersion ?? null,
          aiSummary: operation.aiSummary
        }))
      });
      return this.getPlan(planId);
    });
    return plan;
  }

  // ---------- 计划读取 ----------

  private getPlanRow(planId: string): Row {
    const row = this.db.get("SELECT * FROM ai_write_plans WHERE id = ?", planId);
    if (!row) throw new AppError(404, "AI_WRITE_PLAN_NOT_FOUND", "审批记录不存在");
    return row;
  }

  private expirePendingPlanRow(planId: string): void {
    const timestamp = now();
    this.db.run(
      "UPDATE ai_write_plans SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending' AND expires_at <= ?",
      timestamp,
      planId,
      timestamp
    );
  }

  private mapPlan(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      conversationId: optionalString(row, "conversation_id"),
      status: requiredString(row, "status"),
      summary: requiredString(row, "summary"),
      plan: json(requiredString(row, "plan_json"), {}),
      expiresAt: requiredString(row, "expires_at"),
      decidedAt: optionalString(row, "decided_at"),
      executedAt: optionalString(row, "executed_at"),
      invalidReason: requiredString(row, "invalid_reason"),
      failure: requiredString(row, "failure"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  /** 惰性标记过期后读取计划。 */
  getPlan(planId: string): Record<string, unknown> {
    this.expirePendingPlanRow(planId);
    return this.mapPlan(this.getPlanRow(planId));
  }

  listPlanOperations(planId: string): Record<string, unknown>[] {
    return this.db.all(
      "SELECT * FROM ai_write_plan_operations WHERE plan_id = ? ORDER BY operation_index ASC",
      planId
    ).map((row) => ({
      id: requiredString(row, "id"),
      planId: requiredString(row, "plan_id"),
      operationIndex: numberValue(row, "operation_index"),
      operationType: requiredString(row, "operation_type"),
      entityType: requiredString(row, "entity_type") || null,
      targetModule: requiredString(row, "target_module"),
      targetId: requiredString(row, "target_id") || null,
      targetVersion: row.target_version === null || row.target_version === undefined ? null : numberValue(row, "target_version"),
      aiSummary: requiredString(row, "ai_summary"),
      before: json(requiredString(row, "before_json"), null),
      after: json(requiredString(row, "after_json"), null),
      diff: json<Array<{ field: string; label: string; before: unknown; after: unknown }>>(requiredString(row, "diff_json"), []),
      status: requiredString(row, "status"),
      result: json(requiredString(row, "result_json"), {}),
      error: requiredString(row, "error"),
      createdAt: requiredString(row, "created_at")
    }));
  }

  /** 按当前查看者模块读权限对详情脱敏（不泄露未授权作品内容）。 */
  private redactOperationForViewer(operation: Record<string, unknown>, permissions: WorkModulePermissions | null): Record<string, unknown> {
    const targetModule = String(operation.targetModule ?? "");
    const readable = permissions !== null
      && targetModule.length > 0
      && (workPermissionModuleByKey(targetModule) === null || canReadWorkModule(permissions, targetModule as WorkPermissionModule));
    if (readable) return operation;
    return {
      id: operation.id,
      planId: operation.planId,
      operationIndex: operation.operationIndex,
      operationType: operation.operationType,
      entityType: operation.entityType,
      targetModule: operation.targetModule,
      targetId: operation.targetId,
      targetVersion: operation.targetVersion,
      aiSummary: "（无权限查看该模块内容）",
      before: null,
      after: null,
      diff: [],
      status: operation.status,
      result: operation.result,
      error: operation.error,
      createdAt: operation.createdAt,
      redacted: true
    };
  }

  getPlanDetail(planId: string, viewerPermissions: WorkModulePermissions | null): Record<string, unknown> {
    const plan = this.getPlan(planId);
    return {
      ...plan,
      operations: this.listPlanOperations(planId).map((operation) => this.redactOperationForViewer(operation, viewerPermissions))
    };
  }

  listPlansPage(workId: string, pagination: Pagination, status?: string): PaginatedResult<Record<string, unknown>> & { stats: Record<string, number> } {
    this.store.getWork(workId);
    const timestamp = now();
    this.db.run(
      "UPDATE ai_write_plans SET status = 'expired', updated_at = ? WHERE work_id = ? AND status = 'pending' AND expires_at <= ?",
      timestamp,
      workId,
      timestamp
    );
    const page = paginationSql(pagination);
    const filtered = status !== undefined && status !== "" && AI_WRITE_PLAN_STATUSES.includes(status as AiWritePlanStatus);
    const where = filtered ? " AND plan.status = ?" : "";
    const countWhere = filtered ? " AND status = ?" : "";
    const params: Array<string | number> = filtered ? [workId, status, ...page.params] : [workId, ...page.params];
    const total = numberValue(this.db.get(
      `SELECT COUNT(*) AS value FROM ai_write_plans WHERE work_id = ?${countWhere}`,
      ...params.slice(0, filtered ? 2 : 1)
    ) ?? {}, "value");
    const rows = this.db.all(
      `SELECT plan.*, requester.display_name AS requester_display_name, owner.display_name AS owner_display_name,
              (SELECT COUNT(*) FROM ai_write_plan_operations operation WHERE operation.plan_id = plan.id) AS operation_count
       FROM ai_write_plans plan
       LEFT JOIN users requester ON requester.id = plan.requested_by_user_id
       LEFT JOIN users owner ON owner.id = plan.conversation_owner_user_id
       WHERE plan.work_id = ?${where}
       ORDER BY plan.created_at DESC, plan.id DESC${page.sql}`,
      ...params
    );
    const items = rows.map((row) => ({
      ...this.mapPlan(row),
      requesterDisplayName: optionalString(row, "requester_display_name") ?? "",
      ownerDisplayName: optionalString(row, "owner_display_name") ?? "",
      operationCount: numberValue(row, "operation_count")
    }));
    const stats = Object.fromEntries(AI_WRITE_PLAN_STATUSES.map((item) => [item, 0]));
    const statsRows = this.db.all(
      "SELECT status, COUNT(*) AS count FROM ai_write_plans WHERE work_id = ? GROUP BY status",
      workId
    );
    for (const row of statsRows) {
      const key = requiredString(row, "status");
      if (key in stats) stats[key] = numberValue(row, "count");
    }
    return {
      ...paginated(items, pagination, total),
      stats
    };
  }

  // ---------- 确认 / 拒绝 / 撤销 ----------

  /**
   * 整体确认一份审批。只接受审批 ID；执行前重校验权限/开关/归属/版本，
   * 任一条件变化时整单标记失效并提交；执行在单个事务内原子完成，
   * 任一操作失败整体回滚并将整单标记为执行失败。重复确认（多标签、重试、并发）不会产生重复写入。
   */
  approvePlan(planId: string, approverUserId: string | null): Record<string, unknown> {
    this.expirePendingPlanRow(planId);
    const current = this.getPlanRow(planId);
    const currentStatus = requiredString(current, "status");
    if (currentStatus === "succeeded") {
      return this.getPlan(planId);
    }
    if (currentStatus === "executing") {
      throw new AppError(409, "AI_WRITE_PLAN_EXECUTING", "该审批正在执行中，请稍候");
    }
    if (currentStatus !== "pending") {
      throw new AppError(409, "AI_WRITE_PLAN_NOT_PENDING", "该审批已处理，不能重复确认");
    }
    const timestamp = now();
    const workId = requiredString(current, "work_id");
    const conversationOwnerUserId = optionalString(current, "conversation_owner_user_id");
    const operations = this.listPlanOperations(planId);
    // 无认证环境（开发/测试）下缺少当前用户时，以对话归属用户作为权限基准。
    const effectiveApprover = approverUserId ?? conversationOwnerUserId;

    // 事务外重校验：条件变化时失效标记必须落库，随后才拒绝请求。
    const invalidation = this.planInvalidation(workId, planId, effectiveApprover, conversationOwnerUserId, operations, timestamp);
    if (invalidation !== null) {
      this.db.transaction(() => {
        const changed = this.db.run(
          "UPDATE ai_write_plans SET status = 'invalidated', invalid_reason = ?, decided_at = ?, decided_by_user_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
          invalidation,
          timestamp,
          approverUserId,
          timestamp,
          planId
        );
        if (changed.changes !== 1) return;
        for (const operation of operations) {
          this.db.run(
            "UPDATE ai_write_plan_operations SET status = 'failed', error = ? WHERE id = ?",
            `审批失效：${invalidation}`,
            String(operation.id)
          );
        }
        this.store.audit(workId, "ai-write-plan.invalidated", "ai-write-plan", planId, {
          reason: invalidation,
          decidedByUserId: approverUserId
        });
      });
      throw new AppError(409, "AI_WRITE_PLAN_INVALIDATED", `该审批已失效：${invalidation}`, { planId });
    }

    try {
      return this.db.transaction(() => {
        // 事务内重读并翻转状态：并发确认时只有第一个请求能拿到 pending。
        const locked = this.db.get("SELECT status FROM ai_write_plans WHERE id = ?", planId);
        if (!locked) throw new AppError(404, "AI_WRITE_PLAN_NOT_FOUND", "审批记录不存在");
        const lockedStatus = requiredString(locked, "status");
        if (lockedStatus === "succeeded") {
          return this.getPlan(planId);
        }
        if (lockedStatus !== "pending") {
          throw new AppError(409, "AI_WRITE_PLAN_NOT_PENDING", "该审批已处理，不能重复确认");
        }
        this.db.run(
          "UPDATE ai_write_plans SET status = 'executing', updated_at = ? WHERE id = ? AND status = 'pending'",
          timestamp,
          planId
        );
        // 逐项原子执行；任一失败整体回滚，不留部分写入。
        const operationResults: Record<string, unknown>[] = [];
        for (const operation of operations) {
          const result = this.applyOperation(workId, planId, operation, approverUserId);
          this.db.run(
            "UPDATE ai_write_plan_operations SET status = 'succeeded', result_json = ? WHERE id = ?",
            JSON.stringify(result),
            String(operation.id)
          );
          operationResults.push({ operationIndex: operation.operationIndex, ...result });
        }
        this.db.run(
          "UPDATE ai_write_plans SET status = 'succeeded', decided_at = ?, decided_by_user_id = ?, executed_at = ?, updated_at = ? WHERE id = ?",
          timestamp,
          approverUserId,
          timestamp,
          timestamp,
          planId
        );
        this.store.audit(workId, "ai-write-plan.approved", "ai-write-plan", planId, {
          decidedByUserId: approverUserId,
          conversationOwnerUserId: conversationOwnerUserId ?? null,
          operationCount: operations.length,
          results: operationResults
        });
        return this.getPlan(planId);
      });
    } catch (error) {
      // 执行阶段失败：业务写入已随事务回滚，把整单标记为执行失败以便审批中心展示。
      if (!(error instanceof AppError) || (error.code !== "AI_WRITE_PLAN_NOT_PENDING" && error.code !== "AI_WRITE_PLAN_NOT_FOUND")) {
        const failure = error instanceof Error ? error.message.slice(0, 2_000) : "审批执行失败";
        this.db.transaction(() => {
          this.db.run(
            "UPDATE ai_write_plans SET status = 'failed', failure = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
            failure,
            now(),
            planId
          );
          for (const operation of operations) {
            this.db.run(
              "UPDATE ai_write_plan_operations SET status = 'failed', error = ? WHERE id = ? AND status = 'pending'",
              failure,
              String(operation.id)
            );
          }
          this.store.audit(workId, "ai-write-plan.failed", "ai-write-plan", planId, { failure });
        });
      }
      throw error;
    }
  }

  /** 执行前重校验；返回失效原因或 null。 */
  private planInvalidation(
    workId: string,
    planId: string,
    approverUserId: string | null,
    conversationOwnerUserId: string | null,
    operations: Record<string, unknown>[],
    timestamp: string
  ): string | null {
    const ownerUserId = conversationOwnerUserId ?? approverUserId;
    const plan = this.getPlanRow(planId);
    if (requiredString(plan, "expires_at") <= timestamp) return "审批已过期";
    // 对话归属用户必须仍有作品访问权限。
    if (this.permissionResolver) {
      if (ownerUserId === null || this.permissionResolver(ownerUserId, workId) === null) {
        return "AI 对话归属用户已失去该作品的访问权限";
      }
    }
    const switches = this.enabledWriteToolSwitches(workId);
    for (const operation of operations) {
      const operationType = requiredString(operation, "operationType");
      const targetModule = requiredString(operation, "targetModule");
      // 模块写权限交集。
      const missingWrite = this.missingIntersectionWriteModules(workId, approverUserId, ownerUserId, [targetModule as WorkPermissionModule]);
      if (missingWrite.length > 0) {
        return `当前用户或 AI 对话归属用户缺少“${targetModule}”模块的写权限`;
      }
      if (operationType === "entity_create" || operationType === "entity_update") {
        const entityType = requiredString(operation, "entityType");
        const switchKey = `entity:${entityTypeModule(entityType as AiWriteEntityType)}` as AiWriteToolSwitchKey;
        if (!switches.has(switchKey)) return `词条工具开关已关闭（${switchKey}）`;
        if (operationType === "entity_update") {
          const targetId = requiredString(operation, "targetId");
          const targetVersion = numberValue(operation, "targetVersion");
          const entity = this.entityById(entityType, targetId);
          if (!entity) return `目标对象已不存在（${entityType}:${targetId}）`;
          if (String(entity.workId ?? "") !== workId) return `目标对象不属于当前作品（${entityType}:${targetId}）`;
          if (numberValue(entity, "versionNo") !== targetVersion) {
            return `目标对象版本已变化（${entityType}:${targetId}，计划版本 ${targetVersion}，当前版本 ${numberValue(entity, "versionNo")}）`;
          }
        }
      } else if (operationType === "annotation_create") {
        if (!switches.has("annotation")) return "正文批注工具开关已关闭（annotation）";
        const chapterId = requiredString(operation, "targetId");
        const chapter = this.store.getChapter(chapterId);
        if (String(chapter.workId ?? "") !== workId) return "批注目标章节不属于当前作品";
      } else if (operationType === "analysis_task") {
        if (!switches.has("analysis-task")) return "分析任务工具开关已关闭（analysis-task）";
        if (this.missingIntersectionWriteModules(workId, approverUserId, ownerUserId, ["ai-analysis"]).length > 0) {
          return "当前用户或 AI 对话归属用户缺少“AI 分析”模块的写权限";
        }
      }
    }
    return null;
  }

  private entityById(entityType: string, entityId: string): Record<string, unknown> | null {
    try {
      switch (entityType) {
        case "setting": return this.store.getSetting(entityId);
        case "character": return this.store.getCharacter(entityId);
        case "race": return this.store.getRace(entityId);
        case "organization": return this.store.getOrganization(entityId);
        case "timeline_event": return this.store.getTimelineEvent(entityId);
        case "relationship": return this.store.getRelationship(entityId);
        case "foreshadow": return this.store.getForeshadow(entityId);
        case "outline": return this.store.getChapterOutline(entityId);
        default: return null;
      }
    } catch {
      return null;
    }
  }

  /** 执行单个操作；任何异常向上传播导致整单回滚。 */
  private applyOperation(
    workId: string,
    planId: string,
    operation: Record<string, unknown>,
    actorUserId: string | null
  ): Record<string, unknown> {
    const operationType = requiredString(operation, "operationType");
    const after = isRecord(operation.after) ? operation.after : {};
    const source = "ai-approval";
    const sourceRef = planId;
    if (operationType === "entity_create") {
      const entityType = requiredString(operation, "entityType");
      const created = this.createEntity(workId, entityType, after, source, sourceRef);
      return {
        operationType,
        entityType,
        createdId: String(created.id),
        versionNo: numberValue(created, "versionNo") || 1,
        created: true
      };
    }
    if (operationType === "entity_update") {
      const entityType = requiredString(operation, "entityType");
      const targetId = requiredString(operation, "targetId");
      const targetVersion = numberValue(operation, "targetVersion");
      const before = isRecord(operation.before) ? operation.before : {};
      const updated = this.updateEntity(workId, entityType, targetId, before, after, source, sourceRef, targetVersion);
      return {
        operationType,
        entityType,
        targetId,
        versionNo: numberValue(updated, "versionNo"),
        created: false
      };
    }
    if (operationType === "annotation_create") {
      const chapterId = requiredString(operation, "targetId");
      const annotation = this.store.createChapterAnnotation(chapterId, {
        kind: after.kind === "todo" ? "todo" : "note",
        startLine: numberValue(after, "startLine"),
        endLine: numberValue(after, "endLine"),
        note: String(after.note ?? "")
      });
      return {
        operationType,
        annotationId: String(annotation.id),
        kind: String(annotation.kind),
        startLine: numberValue(annotation, "startLine"),
        endLine: numberValue(annotation, "endLine"),
        versionNo: numberValue(annotation, "versionNo")
      };
    }
    if (operationType === "analysis_task") {
      const task = this.store.createTask(workId, {
        taskType: String(after.taskType ?? ""),
        scope: isRecord(after.scope) ? after.scope : {},
        ...(typeof after.modelId === "string" && after.modelId ? { modelId: after.modelId } : {})
      });
      return {
        operationType,
        taskId: String(task.id),
        taskType: String(task.taskType),
        modelId: typeof task.modelId === "string" ? task.modelId : null
      };
    }
    throw new AppError(400, "AI_WRITE_OPERATION_UNKNOWN", `未知的审批操作类型：${operationType}`);
  }

  private createEntity(workId: string, entityType: string, fields: Record<string, unknown>, source: string, sourceRef: string): Record<string, unknown> {
    switch (entityType) {
      case "setting":
        return this.store.createSetting(workId, {
          title: requiredString(fields, "title"),
          category: String(fields.category ?? ""),
          content: String(fields.content ?? ""),
          tags: normalizedStringList(fields.tags),
          ...(typeof fields.status === "string" ? { status: fields.status } : {})
        }, source, sourceRef);
      case "character":
        return this.store.createCharacter(workId, {
          name: requiredString(fields, "name"),
          ...(typeof fields.code === "string" ? { code: fields.code } : {}),
          ...(Array.isArray(fields.aliases) ? { aliases: normalizedStringList(fields.aliases) } : {}),
          ...(typeof fields.species === "string" ? { species: fields.species } : {}),
          ...(typeof fields.raceId === "string" ? { raceId: fields.raceId } : {}),
          ...(Array.isArray(fields.organizationIds) ? { organizationIds: normalizedStringList(fields.organizationIds) } : {}),
          ...(isRecord(fields.attributes) ? { attributes: fields.attributes } : {}),
          ...(isRecord(fields.profile) ? { profile: fields.profile } : {}),
          ...(isRecord(fields.currentState) ? { currentState: fields.currentState } : {}),
          ...(typeof fields.isDead === "boolean" ? { isDead: fields.isDead } : {})
        });
      case "race":
        return this.store.createRace(workId, {
          name: requiredString(fields, "name"),
          ...(typeof fields.parentRaceId === "string" ? { parentRaceId: fields.parentRaceId } : {}),
          ...(typeof fields.description === "string" ? { description: fields.description } : {}),
          ...(typeof fields.isExtinct === "boolean" ? { isExtinct: fields.isExtinct } : {}),
          ...(typeof fields.settingsMarkdown === "string" ? { settingsMarkdown: fields.settingsMarkdown } : {})
        });
      case "organization":
        return this.store.createOrganization(workId, {
          name: requiredString(fields, "name"),
          ...(typeof fields.description === "string" ? { description: fields.description } : {}),
          ...(typeof fields.isDissolved === "boolean" ? { isDissolved: fields.isDissolved } : {}),
          ...(typeof fields.settingsMarkdown === "string" ? { settingsMarkdown: fields.settingsMarkdown } : {})
        });
      case "timeline_event":
        return this.store.createTimelineEvent(workId, {
          name: requiredString(fields, "name"),
          ...(typeof fields.trackId === "string" ? { trackId: fields.trackId } : {}),
          ...(typeof fields.description === "string" ? { description: fields.description } : {}),
          ...(typeof fields.eventType === "string" ? { eventType: fields.eventType } : {}),
          ...(typeof fields.timeLabel === "string" ? { timeLabel: fields.timeLabel } : {}),
          ...(Array.isArray(fields.chapterIds) ? { chapterIds: normalizedStringList(fields.chapterIds) } : {}),
          ...(Array.isArray(fields.participantIds) ? { participantIds: normalizedStringList(fields.participantIds) } : {}),
          ...(typeof fields.location === "string" ? { location: fields.location } : {}),
          ...(Array.isArray(fields.causes) ? { causes: normalizedStringList(fields.causes) } : {}),
          ...(typeof fields.impactScope === "string" ? { impactScope: fields.impactScope } : {}),
          ...(Array.isArray(fields.evidence) ? { evidence: fields.evidence } : {}),
          ...(typeof fields.status === "string" ? { status: fields.status } : {})
        }, source, sourceRef);
      case "relationship":
        return this.store.createRelationship(workId, {
          fromCharacterId: requiredString(fields, "fromCharacterId"),
          toCharacterId: requiredString(fields, "toCharacterId"),
          category: requiredString(fields, "category"),
          ...(typeof fields.subtype === "string" ? { subtype: fields.subtype } : {}),
          ...(Array.isArray(fields.keywords) ? { keywords: normalizedStringList(fields.keywords) } : {}),
          ...(typeof fields.directed === "boolean" ? { directed: fields.directed } : {}),
          ...(typeof fields.currentStatus === "string" ? { currentStatus: fields.currentStatus } : {}),
          ...(isRecord(fields.timeRange) ? { timeRange: fields.timeRange } : {}),
          ...(typeof fields.confidence === "number" ? { confidence: fields.confidence } : {}),
          ...(Array.isArray(fields.evidence) ? { evidence: fields.evidence } : {}),
          ...(typeof fields.confirmationStatus === "string" ? { confirmationStatus: fields.confirmationStatus } : {}),
          ...(typeof fields.locked === "boolean" ? { locked: fields.locked } : {})
        }, source, sourceRef);
      case "outline":
        return this.store.upsertChapterOutline(requiredString(fields, "chapterId"), {
          ...(typeof fields.goal === "string" ? { goal: fields.goal } : {}),
          ...(typeof fields.conflict === "string" ? { conflict: fields.conflict } : {}),
          ...(typeof fields.turningPoint === "string" ? { turningPoint: fields.turningPoint } : {}),
          ...(typeof fields.notes === "string" ? { notes: fields.notes } : {}),
          ...(typeof fields.status === "string" && ["draft", "ready", "completed"].includes(fields.status)
            ? { status: fields.status as "draft" | "ready" | "completed" }
            : {})
        }, source, sourceRef);
      case "foreshadow":
        return this.store.createForeshadow(workId, {
          title: requiredString(fields, "title"),
          ...(typeof fields.description === "string" ? { description: fields.description } : {}),
          ...(typeof fields.status === "string" && ["planned", "planted", "resolved", "abandoned"].includes(fields.status)
            ? { status: fields.status as "planned" | "planted" | "resolved" | "abandoned" }
            : {}),
          ...(typeof fields.importance === "string" && ["low", "medium", "high"].includes(fields.importance)
            ? { importance: fields.importance as "low" | "medium" | "high" }
            : {}),
          ...(typeof fields.plannedPayoffChapterId === "string" ? { plannedPayoffChapterId: fields.plannedPayoffChapterId } : {})
        });
      default:
        throw new AppError(400, "AI_WRITE_ENTITY_UNKNOWN", `不支持的词条类型：${entityType}`);
    }
  }

  private updateEntity(
    workId: string,
    entityType: string,
    targetId: string,
    before: Record<string, unknown>,
    fields: Record<string, unknown>,
    source: string,
    sourceRef: string,
    expectedVersionNo: number
  ): Record<string, unknown> {
    switch (entityType) {
      case "setting":
        return this.store.updateSetting(targetId, this.settingPatch(fields), source, sourceRef, "", expectedVersionNo);
      case "character":
        return this.store.updateCharacter(targetId, this.characterPatch(fields), source, sourceRef, "", expectedVersionNo);
      case "race":
        return this.store.updateRace(targetId, this.racePatch(fields), source, sourceRef, "", expectedVersionNo);
      case "organization":
        return this.store.updateOrganization(targetId, this.organizationPatch(fields), source, sourceRef, "", expectedVersionNo);
      case "timeline_event":
        return this.store.updateTimelineEvent(targetId, this.timelinePatch(fields), source, sourceRef, "", expectedVersionNo);
      case "relationship":
        return this.store.updateRelationship(targetId, this.relationshipPatch(fields), source, sourceRef, "", expectedVersionNo);
      case "outline":
        return this.store.upsertChapterOutline(targetId, this.outlinePatch(fields), source, sourceRef, "", expectedVersionNo);
      case "foreshadow":
        return this.store.updateForeshadow(targetId, this.foreshadowPatch(fields), source, sourceRef, "", expectedVersionNo);
      default:
        throw new AppError(400, "AI_WRITE_ENTITY_UNKNOWN", `不支持的词条类型：${entityType}`);
    }
  }

  private settingPatch(fields: Record<string, unknown>): Record<string, unknown> {
    return {
      ...(typeof fields.title === "string" ? { title: fields.title } : {}),
      ...(typeof fields.category === "string" ? { category: fields.category } : {}),
      ...(typeof fields.content === "string" ? { content: fields.content } : {}),
      ...(Array.isArray(fields.tags) ? { tags: normalizedStringList(fields.tags) } : {}),
      ...(typeof fields.status === "string" ? { status: fields.status } : {})
    };
  }

  private characterPatch(fields: Record<string, unknown>): Record<string, unknown> {
    return {
      ...(typeof fields.name === "string" ? { name: fields.name } : {}),
      ...(typeof fields.code === "string" ? { code: fields.code } : {}),
      ...(Array.isArray(fields.aliases) ? { aliases: normalizedStringList(fields.aliases) } : {}),
      ...(typeof fields.species === "string" ? { species: fields.species } : {}),
      ...(typeof fields.raceId === "string" ? { raceId: fields.raceId } : {}),
      ...(Array.isArray(fields.organizationIds) ? { organizationIds: normalizedStringList(fields.organizationIds) } : {}),
      ...(isRecord(fields.attributes) ? { attributes: fields.attributes } : {}),
      ...(isRecord(fields.profile) ? { profile: fields.profile } : {}),
      ...(isRecord(fields.currentState) ? { currentState: fields.currentState } : {}),
      ...(typeof fields.isDead === "boolean" ? { isDead: fields.isDead } : {})
    };
  }

  private racePatch(fields: Record<string, unknown>): Record<string, unknown> {
    return {
      ...(typeof fields.name === "string" ? { name: fields.name } : {}),
      ...(typeof fields.parentRaceId === "string" ? { parentRaceId: fields.parentRaceId } : {}),
      ...(typeof fields.description === "string" ? { description: fields.description } : {}),
      ...(typeof fields.isExtinct === "boolean" ? { isExtinct: fields.isExtinct } : {}),
      ...(typeof fields.settingsMarkdown === "string" ? { settingsMarkdown: fields.settingsMarkdown } : {})
    };
  }

  private organizationPatch(fields: Record<string, unknown>): Record<string, unknown> {
    return {
      ...(typeof fields.name === "string" ? { name: fields.name } : {}),
      ...(typeof fields.description === "string" ? { description: fields.description } : {}),
      ...(typeof fields.isDissolved === "boolean" ? { isDissolved: fields.isDissolved } : {}),
      ...(typeof fields.settingsMarkdown === "string" ? { settingsMarkdown: fields.settingsMarkdown } : {})
    };
  }

  private timelinePatch(fields: Record<string, unknown>): Record<string, unknown> {
    return {
      ...(typeof fields.name === "string" ? { name: fields.name } : {}),
      ...(typeof fields.trackId === "string" ? { trackId: fields.trackId } : {}),
      ...(typeof fields.description === "string" ? { description: fields.description } : {}),
      ...(typeof fields.eventType === "string" ? { eventType: fields.eventType } : {}),
      ...(typeof fields.timeLabel === "string" ? { timeLabel: fields.timeLabel } : {}),
      ...(Array.isArray(fields.chapterIds) ? { chapterIds: normalizedStringList(fields.chapterIds) } : {}),
      ...(Array.isArray(fields.participantIds) ? { participantIds: normalizedStringList(fields.participantIds) } : {}),
      ...(typeof fields.location === "string" ? { location: fields.location } : {}),
      ...(Array.isArray(fields.causes) ? { causes: normalizedStringList(fields.causes) } : {}),
      ...(typeof fields.impactScope === "string" ? { impactScope: fields.impactScope } : {}),
      ...(Array.isArray(fields.evidence) ? { evidence: fields.evidence } : {}),
      ...(typeof fields.status === "string" ? { status: fields.status } : {})
    };
  }

  private relationshipPatch(fields: Record<string, unknown>): Record<string, unknown> {
    return {
      ...(typeof fields.fromCharacterId === "string" ? { fromCharacterId: fields.fromCharacterId } : {}),
      ...(typeof fields.toCharacterId === "string" ? { toCharacterId: fields.toCharacterId } : {}),
      ...(typeof fields.category === "string" ? { category: fields.category } : {}),
      ...(typeof fields.subtype === "string" ? { subtype: fields.subtype } : {}),
      ...(Array.isArray(fields.keywords) ? { keywords: normalizedStringList(fields.keywords) } : {}),
      ...(typeof fields.directed === "boolean" ? { directed: fields.directed } : {}),
      ...(typeof fields.currentStatus === "string" ? { currentStatus: fields.currentStatus } : {}),
      ...(isRecord(fields.timeRange) ? { timeRange: fields.timeRange } : {}),
      ...(typeof fields.confidence === "number" ? { confidence: fields.confidence } : {}),
      ...(Array.isArray(fields.evidence) ? { evidence: fields.evidence } : {}),
      ...(typeof fields.confirmationStatus === "string" ? { confirmationStatus: fields.confirmationStatus } : {}),
      ...(typeof fields.locked === "boolean" ? { locked: fields.locked } : {})
    };
  }

  private outlinePatch(fields: Record<string, unknown>): Record<string, unknown> {
    return {
      ...(typeof fields.goal === "string" ? { goal: fields.goal } : {}),
      ...(typeof fields.conflict === "string" ? { conflict: fields.conflict } : {}),
      ...(typeof fields.turningPoint === "string" ? { turningPoint: fields.turningPoint } : {}),
      ...(typeof fields.notes === "string" ? { notes: fields.notes } : {}),
      ...(typeof fields.status === "string" && ["draft", "ready", "completed"].includes(fields.status)
        ? { status: fields.status as "draft" | "ready" | "completed" }
        : {})
    };
  }

  private foreshadowPatch(fields: Record<string, unknown>): Record<string, unknown> {
    return {
      ...(typeof fields.title === "string" ? { title: fields.title } : {}),
      ...(typeof fields.description === "string" ? { description: fields.description } : {}),
      ...(typeof fields.status === "string" && ["planned", "planted", "resolved", "abandoned"].includes(fields.status)
        ? { status: fields.status as "planned" | "planted" | "resolved" | "abandoned" }
        : {}),
      ...(typeof fields.importance === "string" && ["low", "medium", "high"].includes(fields.importance)
        ? { importance: fields.importance as "low" | "medium" | "high" }
        : {}),
      ...(typeof fields.plannedPayoffChapterId === "string" ? { plannedPayoffChapterId: fields.plannedPayoffChapterId } : {})
    };
  }

  rejectPlan(planId: string, approverUserId: string | null): Record<string, unknown> {
    this.expirePendingPlanRow(planId);
    const current = this.getPlanRow(planId);
    if (requiredString(current, "status") !== "pending") {
      throw new AppError(409, "AI_WRITE_PLAN_NOT_PENDING", "该审批已处理，不能重复操作");
    }
    const timestamp = now();
    return this.db.transaction(() => {
      const changed = this.db.run(
        "UPDATE ai_write_plans SET status = 'rejected', decided_at = ?, decided_by_user_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        timestamp,
        approverUserId,
        timestamp,
        planId
      );
      if (changed.changes !== 1) {
        throw new AppError(409, "AI_WRITE_PLAN_NOT_PENDING", "该审批已处理，不能重复操作");
      }
      this.store.audit(requiredString(current, "work_id"), "ai-write-plan.rejected", "ai-write-plan", planId, {
        decidedByUserId: approverUserId
      });
      return this.getPlan(planId);
    });
  }

  /**
   * 撤销本次审批：仅编辑已有词条的操作可撤销，且目标词条未被后续版本修改。
   * 恢复修改前值并产生新版本；新建词条不自动删除。
   */
  revokePlan(planId: string, revokerUserId: string | null): Record<string, unknown> {
    const current = this.getPlanRow(planId);
    if (requiredString(current, "status") !== "succeeded") {
      throw new AppError(409, "AI_WRITE_PLAN_NOT_SUCCEEDED", "只有执行成功的审批才能撤销");
    }
    const workId = requiredString(current, "work_id");
    const conversationOwnerUserId = optionalString(current, "conversation_owner_user_id");
    const operations = this.listPlanOperations(planId);
    const revocable = operations.filter((operation) =>
      requiredString(operation, "operationType") === "entity_update"
      && isRecord(operation.result)
      && operation.result.revoked !== true
    );
    if (revocable.length === 0) {
      throw new AppError(409, "AI_WRITE_PLAN_NOTHING_TO_REVOKE", "该审批没有可撤销的词条编辑操作");
    }
    return this.db.transaction(() => {
      const invalidation = this.revokeInvalidation(workId, revokerUserId, conversationOwnerUserId, revocable);
      if (invalidation !== null) {
        throw new AppError(409, "AI_WRITE_PLAN_REVOKE_DENIED", invalidation);
      }
      const results: Record<string, unknown>[] = [];
      for (const operation of revocable) {
        const entityType = requiredString(operation, "entityType");
        const targetId = requiredString(operation, "targetId");
        const before = isRecord(operation.before) ? operation.before : {};
        const appliedVersion = isRecord(operation.result) && typeof operation.result.versionNo === "number"
          ? operation.result.versionNo
          : null;
        const currentEntity = this.entityById(entityType, targetId);
        if (!currentEntity) throw new AppError(409, "AI_WRITE_PLAN_REVOKE_DENIED", `目标词条已不存在，无法撤销（${entityType}:${targetId}）`);
        if (numberValue(currentEntity, "versionNo") !== appliedVersion) {
          throw new AppError(409, "AI_WRITE_PLAN_REVOKE_DENIED",
            `目标词条已被后续版本修改，无法撤销（${entityType}:${targetId}，审批后版本 ${appliedVersion}，当前版本 ${numberValue(currentEntity, "versionNo")}）`);
        }
        const restored = this.updateEntity(workId, entityType, targetId, before, before, "ai-approval-revoke", planId, numberValue(currentEntity, "versionNo"));
        this.db.run(
          "UPDATE ai_write_plan_operations SET result_json = ? WHERE id = ?",
          JSON.stringify({ ...(operation.result as Record<string, unknown>), revoked: true, revokedVersionNo: numberValue(restored, "versionNo"), revokedAt: now(), revokedByUserId: revokerUserId }),
          String(operation.id)
        );
        results.push({
          operationIndex: operation.operationIndex,
          entityType,
          targetId,
          restoredVersionNo: numberValue(restored, "versionNo")
        });
      }
      this.store.audit(workId, "ai-write-plan.revoked", "ai-write-plan", planId, {
        revokedByUserId: revokerUserId,
        results
      });
      return this.getPlan(planId);
    });
  }

  private revokeInvalidation(
    workId: string,
    revokerUserId: string | null,
    conversationOwnerUserId: string | null,
    operations: Record<string, unknown>[]
  ): string | null {
    const ownerUserId = conversationOwnerUserId ?? revokerUserId;
    for (const operation of operations) {
      const targetModule = requiredString(operation, "targetModule");
      if (this.missingIntersectionWriteModules(workId, revokerUserId, ownerUserId, [targetModule as WorkPermissionModule]).length > 0) {
        return `当前用户或 AI 对话归属用户缺少“${targetModule}”模块的写权限`;
      }
    }
    return null;
  }

  // ---------- AskUserQuestions ----------

  createQuestion(input: {
    workId: string;
    conversationId: string | null;
    requesterUserId: string;
    question: string;
    options: Array<{ label: string; description?: string }>;
  }): Record<string, unknown> {
    const timestamp = now();
    const expiresAt = new Date(Date.parse(timestamp) + this.planTtlMs).toISOString();
    const questionId = id("aiQuestion");
    this.db.run(
      `INSERT INTO ai_approval_questions (id, work_id, conversation_id, question, options_json, status,
         expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      questionId,
      input.workId,
      input.conversationId,
      input.question.trim(),
      JSON.stringify(input.options.map((option, index) => ({
        label: option.label.trim(),
        ...(option.description?.trim() ? { description: option.description.trim() } : {}),
        recommended: index === 0
      }))),
      expiresAt,
      timestamp,
      timestamp
    );
    this.store.audit(input.workId, "ai-approval-question.created", "ai-approval-question", questionId, {
      conversationId: input.conversationId,
      question: input.question
    });
    return this.getQuestion(questionId);
  }

  private expirePendingQuestions(workId: string): void {
    const timestamp = now();
    this.db.run(
      "UPDATE ai_approval_questions SET status = 'expired', updated_at = ? WHERE work_id = ? AND status = 'pending' AND expires_at <= ?",
      timestamp,
      workId,
      timestamp
    );
  }

  private mapQuestion(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      conversationId: optionalString(row, "conversation_id"),
      question: requiredString(row, "question"),
      options: json<Array<{ label: string; description?: string; recommended?: boolean }>>(requiredString(row, "options_json"), []),
      status: requiredString(row, "status"),
      answer: requiredString(row, "answer"),
      answeredAt: optionalString(row, "answered_at"),
      expiresAt: requiredString(row, "expires_at"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  getQuestion(questionId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM ai_approval_questions WHERE id = ?", questionId);
    if (!row) throw new AppError(404, "AI_QUESTION_NOT_FOUND", "提问记录不存在");
    return this.mapQuestion(row);
  }

  listPendingQuestions(workId: string): Record<string, unknown>[] {
    this.store.getWork(workId);
    this.expirePendingQuestions(workId);
    return this.db.all(
      "SELECT * FROM ai_approval_questions WHERE work_id = ? AND status = 'pending' ORDER BY created_at ASC, id ASC",
      workId
    ).map((row) => this.mapQuestion(row));
  }

  answerQuestion(questionId: string, answer: string, answererUserId: string | null): Record<string, unknown> {
    const normalized = answer.trim();
    if (!normalized) throw new AppError(400, "AI_QUESTION_ANSWER_REQUIRED", "回答不能为空");
    return this.db.transaction(() => {
      const row = this.db.get("SELECT * FROM ai_approval_questions WHERE id = ?", questionId);
      if (!row) throw new AppError(404, "AI_QUESTION_NOT_FOUND", "提问记录不存在");
      if (requiredString(row, "status") !== "pending") {
        throw new AppError(409, "AI_QUESTION_NOT_PENDING", "该提问已处理，不能重复回答");
      }
      if (requiredString(row, "expires_at") <= now()) {
        this.db.run("UPDATE ai_approval_questions SET status = 'expired', updated_at = ? WHERE id = ?", now(), questionId);
        throw new AppError(409, "AI_QUESTION_EXPIRED", "该提问已过期");
      }
      const timestamp = now();
      this.db.run(
        "UPDATE ai_approval_questions SET status = 'answered', answer = ?, answered_at = ?, answered_by_user_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        normalized,
        timestamp,
        answererUserId,
        timestamp,
        questionId
      );
      this.store.audit(requiredString(row, "work_id"), "ai-approval-question.answered", "ai-approval-question", questionId, {
        answeredByUserId: answererUserId
      });
      return this.getQuestion(questionId);
    });
  }

  declineQuestion(questionId: string, declinerUserId: string | null): Record<string, unknown> {
    return this.db.transaction(() => {
      const row = this.db.get("SELECT * FROM ai_approval_questions WHERE id = ?", questionId);
      if (!row) throw new AppError(404, "AI_QUESTION_NOT_FOUND", "提问记录不存在");
      if (requiredString(row, "status") !== "pending") {
        throw new AppError(409, "AI_QUESTION_NOT_PENDING", "该提问已处理，不能重复操作");
      }
      const timestamp = now();
      this.db.run(
        "UPDATE ai_approval_questions SET status = 'declined', updated_at = ? WHERE id = ? AND status = 'pending'",
        timestamp,
        questionId
      );
      this.store.audit(requiredString(row, "work_id"), "ai-approval-question.declined", "ai-approval-question", questionId, {
        declinedByUserId: declinerUserId
      });
      return this.getQuestion(questionId);
    });
  }
}

function workPermissionModuleByKey(value: string): WorkPermissionModule | null {
  return ["prose", "drafts", "settings", "characters", "races", "organizations", "timeline", "relationships", "outlines", "reviews", "ai-chat", "ai-analysis", "ai-settings"].includes(value)
    ? value as WorkPermissionModule
    : null;
}
