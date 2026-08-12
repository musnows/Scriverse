import { AppError, notFound } from "./errors.js";
import { currentRequestActor } from "./request-context.js";
import { paginated, paginationSql, type PaginatedResult, type Pagination } from "./pagination.js";
import { id, json, now } from "./utils.js";
import { analysisTaskReadModules } from "./user-auth.js";
import {
  AI_WRITE_APPROVAL_STATUS_LABELS,
  AI_WRITE_APPROVAL_TTL_MS,
  AI_WRITE_OPERATION_KINDS,
  AI_USER_QUESTION_STATUS_LABELS,
  OPERATION_KIND_LABELS,
  OPERATION_KIND_MODULE,
  OPERATION_KIND_TOOL_ID,
  WRITE_TOOL_LABELS,
  analysisScopeLabel,
  annotationKindLabel,
  assertIntersectedReadAccess,
  assertIntersectedWriteAccess,
  assertWriteToolsEnabled,
  buildFieldDiffs,
  formatFieldValue,
  intersectWorkModulePermissions,
  pickDefinedFields,
  recommendedAskUserOptionLabel,
  redactSensitiveApprovalText,
  resolveAiWritePlanMaxOperations,
  type AiUserQuestionStatus,
  type AiWriteApprovalStatus,
  type AiWriteOperationInput,
  type AskUserQuestionsInput,
  type BuiltAiWriteOperation,
  type BuiltAiWritePlan,
  type WorkAgentWriteToolId
} from "./ai-write-plan.js";
import type { Store } from "./store.js";
import {
  canReadWorkModule,
  emptyWorkModulePermissions,
  fullWorkModulePermissions,
  storedWorkModulePermissions,
  type WorkModulePermissions,
  type WorkPermissionModule
} from "./work-permissions.js";
import type { Row } from "./database.js";

type ApprovalRow = Row & {
  id: string;
  work_id: string;
  conversation_id: string;
  status: string;
};

function requiredString(row: Row, key: string): string {
  return String(row[key] ?? "");
}

function optionalString(row: Row, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : String(row[key]);
}

function numberValue(row: Row, key: string): number {
  return Number(row[key] ?? 0);
}

function entityLabel(entity: Record<string, unknown> | null, fallback: string): string {
  if (!entity) return fallback;
  return String(entity.title ?? entity.name ?? fallback);
}

function comparableEntity(fields: string[], entity: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, entity[field] ?? null]));
}

const SETTING_FIELDS = ["title", "category", "content", "tags", "status", "locked", "evidence", "scope", "authorNote"];
const CHARACTER_FIELDS = ["name", "isDead", "code", "aliases", "raceId", "organizationIds", "attributes", "profile", "currentState", "lockedFields", "firstChapterId"];
const RACE_FIELDS = ["name", "isExtinct", "parentRaceId", "description", "settings", "settingsMarkdown", "memberIds"];
const ORGANIZATION_FIELDS = ["name", "isDissolved", "description", "settings", "settingsMarkdown", "memberIds"];
const TRACK_FIELDS = ["name", "description", "sortOrder"];
const EVENT_FIELDS = ["name", "trackId", "description", "eventType", "timeLabel", "timeSort", "chapterIds", "participantIds", "location", "causes", "impactScope", "evidence", "status"];
const RELATIONSHIP_FIELDS = ["fromCharacterId", "toCharacterId", "category", "subtype", "keywords", "directed", "currentStatus", "timeRange", "confidence", "evidence", "confirmationStatus", "locked"];
const OUTLINE_FIELDS = ["goal", "conflict", "turningPoint", "notes", "status"];
const FORESHADOW_FIELDS = ["title", "description", "status", "importance", "plannedPayoffChapterId", "resolutionNote"];

export class AiWriteApprovalService {
  constructor(private readonly store: Store) {}

  getUserWorkModulePermissions(workId: string, userId: string | null): WorkModulePermissions | null {
    if (!userId) return fullWorkModulePermissions();
    const work = this.store.db.get("SELECT owner_user_id FROM works WHERE id = ?", workId);
    if (!work) throw notFound("作品");
    const user = this.store.db.get("SELECT role, status FROM users WHERE id = ?", userId);
    if (!user || requiredString(user, "status") !== "active") return null;
    if (requiredString(user, "role") === "admin") return fullWorkModulePermissions();
    if (optionalString(work, "owner_user_id") === userId) return fullWorkModulePermissions();
    const membership = this.store.db.get(
      "SELECT role, permissions_json FROM work_memberships WHERE work_id = ? AND user_id = ?",
      workId,
      userId
    );
    if (!membership) return null;
    return storedWorkModulePermissions(requiredString(membership, "role"), optionalString(membership, "permissions_json"));
  }

  intersectedWritePermissions(workId: string, conversationOwnerUserId: string | null): WorkModulePermissions {
    const actor = currentRequestActor();
    const current = this.getUserWorkModulePermissions(workId, actor?.userId ?? null);
    const owner = this.getUserWorkModulePermissions(workId, conversationOwnerUserId);
    if (!current || !owner) return emptyWorkModulePermissions();
    return intersectWorkModulePermissions(current, owner);
  }

  conversationOwnerUserId(conversationId: string): string | null {
    const conversation = this.store.db.get("SELECT created_by_user_id FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    return optionalString(conversation, "created_by_user_id");
  }

  enabledWriteToolIds(workId: string, conversationId?: string): WorkAgentWriteToolId[] {
    const tools = conversationId
      ? this.store.ensureAiConversationAgentTools(conversationId, workId)
      : this.store.getWorkAiSettings(workId).agentTools as string[];
    return tools.filter((item): item is WorkAgentWriteToolId => item.startsWith("write_") || item === "ask_user_questions");
  }

  currentWriteToolIds(workId: string): WorkAgentWriteToolId[] {
    return (this.store.getWorkAiSettings(workId).agentTools as string[])
      .filter((item): item is WorkAgentWriteToolId => item.startsWith("write_") || item === "ask_user_questions");
  }

  submitPlan(input: {
    workId: string;
    conversationId: string;
    summary: string;
    operations: AiWriteOperationInput[];
    enabledToolIds: readonly string[];
    maxOperations?: number;
  }): Record<string, unknown> {
    const ownerUserId = this.conversationOwnerUserId(input.conversationId);
    const permissions = this.intersectedWritePermissions(input.workId, ownerUserId);
    const plan = this.buildPlan(input);
    assertWriteToolsEnabled(this.currentWriteToolIds(input.workId), plan.requiredToolIds);
    assertWriteToolsEnabled(input.enabledToolIds, plan.requiredToolIds);
    assertIntersectedWriteAccess(permissions, plan.requiredModules.filter((module) => module !== "ai-analysis"));
    if (plan.requiredModules.includes("ai-analysis")) {
      assertIntersectedWriteAccess(permissions, ["ai-analysis"]);
      for (const operation of plan.operations) {
        if (operation.kind !== "create_analysis_task" || !operation.analysisTask) continue;
        assertIntersectedReadAccess(permissions, analysisTaskReadModules(operation.analysisTask.taskType, operation.analysisTask.scope));
      }
    }
    return this.createApproval(plan);
  }

  buildPlan(input: {
    workId: string;
    conversationId: string;
    summary: string;
    operations: AiWriteOperationInput[];
    maxOperations?: number;
  }): BuiltAiWritePlan {
    const work = this.store.getWork(input.workId);
    const conversation = this.store.getAiConversationSummary(input.conversationId);
    if (String(conversation.workId) !== input.workId) {
      throw new AppError(400, "CONVERSATION_WORK_MISMATCH", "AI 对话不属于当前作品");
    }
    const maxOperations = input.maxOperations ?? resolveAiWritePlanMaxOperations(process.env.AI_WRITE_PLAN_MAX_OPERATIONS);
    if (input.operations.length > maxOperations) {
      throw new AppError(400, "AI_WRITE_PLAN_TOO_LARGE", `每份修改计划最多包含 ${maxOperations} 项操作`);
    }
    const operations = input.operations.map((operation) => this.buildOperation(input.workId, operation, String(work.title)));
    const requiredModules = [...new Set(operations.flatMap((item) => item.requiredModules))];
    const requiredToolIds = [...new Set(operations.map((item) => item.toolId))];
    return {
      workId: input.workId,
      conversationId: input.conversationId,
      aiSummary: redactSensitiveApprovalText(input.summary.trim()),
      requiredModules,
      requiredToolIds,
      operations
    };
  }

  createApproval(plan: BuiltAiWritePlan): Record<string, unknown> {
    const actor = currentRequestActor();
    const ownerUserId = this.conversationOwnerUserId(plan.conversationId);
    const timestamp = now();
    const approvalId = id("aiWriteApproval");
    const expiresAt = new Date(Date.now() + AI_WRITE_APPROVAL_TTL_MS).toISOString();
    this.store.db.transaction(() => {
      this.store.db.run(
        `INSERT INTO ai_write_approvals (
          id, work_id, conversation_id, status, ai_summary, required_modules_json, required_tool_ids_json,
          initiator_user_id, conversation_owner_user_id, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
        approvalId,
        plan.workId,
        plan.conversationId,
        plan.aiSummary,
        JSON.stringify(plan.requiredModules),
        JSON.stringify(plan.requiredToolIds),
        actor?.userId ?? null,
        ownerUserId,
        expiresAt,
        timestamp,
        timestamp
      );
      plan.operations.forEach((operation, index) => {
        this.store.db.run(
          `INSERT INTO ai_write_approval_operations (
            id, approval_id, sort_order, kind, tool_id, module, action, target_id, target_work_id, target_label,
            expected_version_no, required_modules_json, ai_summary, fields_json, before_json, after_json, diffs_json,
            annotation_json, analysis_task_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id("aiWriteOp"),
          approvalId,
          index,
          operation.kind,
          operation.toolId,
          operation.module,
          operation.action,
          operation.targetId,
          operation.targetWorkId,
          operation.targetLabel,
          operation.expectedVersionNo,
          JSON.stringify(operation.requiredModules),
          operation.aiSummary,
          JSON.stringify(operation.fields),
          operation.before ? JSON.stringify(operation.before) : null,
          JSON.stringify(operation.after),
          JSON.stringify(operation.diffs),
          operation.annotation ? JSON.stringify(operation.annotation) : null,
          operation.analysisTask ? JSON.stringify(operation.analysisTask) : null
        );
      });
      this.store.audit(plan.workId, "ai-write-approval.created", "ai-write-approval", approvalId, {
        operationCount: plan.operations.length,
        requiredModules: plan.requiredModules
      });
    });
    return this.getApproval(approvalId);
  }

  listApprovals(workId: string, pagination?: Pagination, status?: string): PaginatedResult<Record<string, unknown>> | Record<string, unknown>[] {
    this.store.getWork(workId);
    this.expireDueRecords(workId);
    const actor = currentRequestActor();
    const statusFilter = status && status !== "all" ? " AND approval.status = ?" : "";
    const params: Array<string> = [workId];
    if (status && status !== "all") params.push(status);
    const visibility = this.visibilitySql(actor?.userId ?? null);
    const sql = `SELECT approval.* FROM ai_write_approvals approval
      WHERE approval.work_id = ?${statusFilter} AND ${visibility.sql}
      ORDER BY approval.created_at DESC`;
    params.push(...visibility.params);
    if (!pagination) {
      return this.store.db.all(sql, ...params).map((row) => this.mapApprovalSummary(row));
    }
    const page = paginationSql(pagination);
    const count = this.store.db.get(
      `SELECT COUNT(*) AS count FROM ai_write_approvals approval
       WHERE approval.work_id = ?${statusFilter} AND ${visibility.sql}`,
      ...params
    );
    const rows = this.store.db.all(`${sql}${page.sql}`, ...params, ...page.params);
    return paginated(rows.map((row) => this.mapApprovalSummary(row)), pagination, Number(count?.count ?? 0));
  }

  getApproval(approvalId: string): Record<string, unknown> {
    const row = this.store.db.get("SELECT * FROM ai_write_approvals WHERE id = ?", approvalId);
    if (!row) throw notFound("AI 修改计划");
    this.expireDueRecords(requiredString(row, "work_id"), approvalId);
    const current = this.store.db.get("SELECT * FROM ai_write_approvals WHERE id = ?", approvalId);
    if (!current) throw notFound("AI 修改计划");
    this.assertCanView(current);
    const operations = this.store.db.all(
      "SELECT * FROM ai_write_approval_operations WHERE approval_id = ? ORDER BY sort_order",
      approvalId
    );
    return this.mapApproval(current, operations);
  }

  rejectApproval(approvalId: string): Record<string, unknown> {
    const current = this.requirePendingApproval(approvalId);
    this.assertCanDecide(current);
    const timestamp = now();
    const actor = currentRequestActor();
    this.store.db.run(
      `UPDATE ai_write_approvals SET status = 'rejected', decided_at = ?, decided_by_user_id = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      timestamp,
      actor?.userId ?? null,
      timestamp,
      approvalId
    );
    this.store.audit(requiredString(current, "work_id"), "ai-write-approval.rejected", "ai-write-approval", approvalId, {});
    return this.getApproval(approvalId);
  }

  confirmApproval(approvalId: string): Record<string, unknown> {
    const row = this.store.db.get("SELECT * FROM ai_write_approvals WHERE id = ?", approvalId);
    if (!row) throw notFound("AI 修改计划");
    this.expireDueRecords(requiredString(row, "work_id"), approvalId);
    const current = this.store.db.get("SELECT * FROM ai_write_approvals WHERE id = ?", approvalId);
    if (!current) throw notFound("AI 修改计划");
    this.assertCanDecide(current);
    const status = requiredString(current, "status");
    if (status === "succeeded") return this.getApproval(approvalId);
    if (status === "expired") throw new AppError(409, "AI_WRITE_APPROVAL_EXPIRED", "该审批已过期");
    if (status === "invalidated") {
      throw new AppError(409, "AI_WRITE_APPROVAL_INVALIDATED", optionalString(current, "invalidation_reason") || "该审批已失效");
    }
    if (status !== "pending") {
      throw new AppError(409, "AI_WRITE_APPROVAL_NOT_PENDING", "该审批当前不可确认");
    }
    const workId = requiredString(current, "work_id");
    const invalidation = this.invalidationReason(current);
    if (invalidation) {
      this.invalidateApproval(approvalId, invalidation);
      throw new AppError(409, "AI_WRITE_APPROVAL_INVALIDATED", invalidation);
    }
    const actor = currentRequestActor();
    const timestamp = now();
    const claimed = this.store.db.run(
      `UPDATE ai_write_approvals SET status = 'executing', decided_at = ?, decided_by_user_id = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      timestamp,
      actor?.userId ?? null,
      timestamp,
      approvalId
    );
    if (claimed.changes === 0) {
      const latest = this.store.db.get("SELECT status FROM ai_write_approvals WHERE id = ?", approvalId);
      if (requiredString(latest ?? {}, "status") === "succeeded") return this.getApproval(approvalId);
      throw new AppError(409, "AI_WRITE_APPROVAL_NOT_PENDING", "该审批已处理，不能重复确认");
    }
    const resumeNotifications = this.store.pauseAnalysisTaskNotifications();
    let createdAnalysisTask = false;
    try {
      const results = this.store.db.transaction(() => this.executeOperations(approvalId, workId));
      createdAnalysisTask = results.some((item) => item.kind === "create_analysis_task");
      this.store.db.run(
        `UPDATE ai_write_approvals SET status = 'succeeded', result_json = ?, executed_at = ?, updated_at = ?
         WHERE id = ?`,
        JSON.stringify({ operations: results }),
        now(),
        now(),
        approvalId
      );
      this.store.audit(workId, "ai-write-approval.executed", "ai-write-approval", approvalId, {
        operationCount: results.length
      });
    } catch (error) {
      const message = error instanceof AppError ? error.message : "审批执行失败";
      this.store.db.run(
        `UPDATE ai_write_approvals SET status = 'failed', failure_json = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify({ message: redactSensitiveApprovalText(message), code: error instanceof AppError ? error.code : "AI_WRITE_EXECUTION_FAILED" }),
        now(),
        approvalId
      );
      this.store.audit(workId, "ai-write-approval.failed", "ai-write-approval", approvalId, {
        message: redactSensitiveApprovalText(message)
      });
      throw error instanceof AppError ? error : new AppError(500, "AI_WRITE_EXECUTION_FAILED", "审批执行失败，未写入任何内容");
    } finally {
      resumeNotifications();
    }
    if (createdAnalysisTask) this.store.notifyAnalysisTasksQueued(workId);
    return this.getApproval(approvalId);
  }

  rollbackApproval(approvalId: string): Record<string, unknown> {
    const current = this.store.db.get("SELECT * FROM ai_write_approvals WHERE id = ?", approvalId);
    if (!current) throw notFound("AI 修改计划");
    this.assertCanDecide(current);
    if (requiredString(current, "status") !== "succeeded") {
      throw new AppError(409, "AI_WRITE_APPROVAL_NOT_SUCCEEDED", "只有执行成功的审批可以撤销");
    }
    const operations = this.store.db.all(
      "SELECT * FROM ai_write_approval_operations WHERE approval_id = ? ORDER BY sort_order",
      approvalId
    );
    const editable = operations.filter((row) => requiredString(row, "action") === "update" && optionalString(row, "target_id"));
    if (!editable.length) {
      throw new AppError(409, "AI_WRITE_ROLLBACK_UNSUPPORTED", "该审批没有可撤销的词条编辑；AI 新建的词条不支持通过撤销自动删除");
    }
    for (const operation of editable) {
      const targetId = optionalString(operation, "target_id");
      if (!targetId) continue;
      const expected = numberValue(operation, "expected_version_no");
      const result = json<Record<string, unknown>>(optionalString(operation, "result_json"), {});
      const writtenVersion = Number(result.versionNo ?? 0);
      const currentVersion = this.currentTargetVersion(requiredString(operation, "kind"), targetId);
      if (writtenVersion && currentVersion !== writtenVersion) {
        throw new AppError(409, "AI_WRITE_ROLLBACK_STALE", "目标词条已被后续版本修改，不能撤销本次审批");
      }
      if (!writtenVersion && expected && currentVersion !== expected + 1) {
        throw new AppError(409, "AI_WRITE_ROLLBACK_STALE", "目标词条已被后续版本修改，不能撤销本次审批");
      }
    }
    this.store.db.transaction(() => {
      for (const operation of editable) {
        const targetId = optionalString(operation, "target_id");
        if (!targetId) continue;
        const expected = numberValue(operation, "expected_version_no");
        const kind = requiredString(operation, "kind");
        const writtenVersion = Number(json<Record<string, unknown>>(optionalString(operation, "result_json"), {}).versionNo ?? 0) || undefined;
        if (kind === "update_character") this.store.restoreCharacter(targetId, expected, writtenVersion);
        else this.store.restoreEntityVersion(this.entityTypeForKind(kind), targetId, expected, writtenVersion);
      }
      this.store.audit(requiredString(current, "work_id"), "ai-write-approval.rolled-back", "ai-write-approval", approvalId, {
        operationCount: editable.length
      });
    });
    return this.getApproval(approvalId);
  }

  createQuestion(input: {
    workId: string;
    conversationId: string;
    question: AskUserQuestionsInput;
  }): Record<string, unknown> {
    const conversation = this.store.getAiConversationSummary(input.conversationId);
    if (String(conversation.workId) !== input.workId) {
      throw new AppError(400, "CONVERSATION_WORK_MISMATCH", "AI 对话不属于当前作品");
    }
    assertWriteToolsEnabled(this.currentWriteToolIds(input.workId), ["ask_user_questions"]);
    assertWriteToolsEnabled(this.enabledWriteToolIds(input.workId, input.conversationId), ["ask_user_questions"]);
    const actor = currentRequestActor();
    const ownerUserId = this.conversationOwnerUserId(input.conversationId);
    const timestamp = now();
    const questionId = id("aiUserQuestion");
    const options = input.question.options.map((option, index) => ({
      id: option.id,
      label: recommendedAskUserOptionLabel(option.label, index)
    }));
    this.store.db.run(
      `INSERT INTO ai_user_questions (
        id, work_id, conversation_id, status, question, options_json, allow_custom,
        initiator_user_id, conversation_owner_user_id, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      questionId,
      input.workId,
      input.conversationId,
      redactSensitiveApprovalText(input.question.question),
      JSON.stringify(options),
      input.question.allowCustom ? 1 : 0,
      actor?.userId ?? null,
      ownerUserId,
      new Date(Date.now() + AI_WRITE_APPROVAL_TTL_MS).toISOString(),
      timestamp,
      timestamp
    );
    this.store.audit(input.workId, "ai-user-question.created", "ai-user-question", questionId, {
      optionCount: options.length
    });
    return this.getQuestion(questionId);
  }

  listQuestions(workId: string, pagination?: Pagination, status?: string): PaginatedResult<Record<string, unknown>> | Record<string, unknown>[] {
    this.store.getWork(workId);
    this.expireDueRecords(workId);
    const actor = currentRequestActor();
    const statusFilter = status && status !== "all" ? " AND question.status = ?" : "";
    const params: string[] = [workId];
    if (status && status !== "all") params.push(status);
    const visibility = this.questionVisibilitySql(actor?.userId ?? null);
    const sql = `SELECT question.* FROM ai_user_questions question
      WHERE question.work_id = ?${statusFilter} AND ${visibility.sql}
      ORDER BY question.created_at DESC`;
    params.push(...visibility.params);
    if (!pagination) return this.store.db.all(sql, ...params).map((row) => this.mapQuestion(row));
    const page = paginationSql(pagination);
    const count = this.store.db.get(
      `SELECT COUNT(*) AS count FROM ai_user_questions question
       WHERE question.work_id = ?${statusFilter} AND ${visibility.sql}`,
      ...params
    );
    const rows = this.store.db.all(`${sql}${page.sql}`, ...params, ...page.params);
    return paginated(rows.map((row) => this.mapQuestion(row)), pagination, Number(count?.count ?? 0));
  }

  getQuestion(questionId: string): Record<string, unknown> {
    const row = this.store.db.get("SELECT * FROM ai_user_questions WHERE id = ?", questionId);
    if (!row) throw notFound("AI 提问");
    this.expireDueRecords(requiredString(row, "work_id"), undefined, questionId);
    const current = this.store.db.get("SELECT * FROM ai_user_questions WHERE id = ?", questionId);
    if (!current) throw notFound("AI 提问");
    this.assertCanViewQuestion(current);
    return this.mapQuestion(current);
  }

  answerQuestion(questionId: string, input: { optionId?: string; customAnswer?: string }): Record<string, unknown> {
    const current = this.requirePendingQuestion(questionId);
    this.assertCanDecideQuestion(current);
    const options = json<Array<{ id: string; label: string }>>(requiredString(current, "options_json"), []);
    const allowCustom = Number(current.allow_custom) === 1;
    const customAnswer = input.customAnswer?.trim() ?? "";
    const optionId = input.optionId?.trim() ?? "";
    if (optionId && customAnswer) {
      throw new AppError(400, "AI_USER_QUESTION_ANSWER_INVALID", "不能同时选择预置选项和自定义回答");
    }
    if (!optionId && !customAnswer) {
      throw new AppError(400, "AI_USER_QUESTION_ANSWER_REQUIRED", "请选择一个选项或提供自定义回答");
    }
    if (customAnswer && !allowCustom) {
      throw new AppError(400, "AI_USER_QUESTION_CUSTOM_DISABLED", "该提问不支持自定义回答");
    }
    const selected = optionId ? options.find((option) => option.id === optionId) : null;
    if (optionId && !selected) throw new AppError(400, "AI_USER_QUESTION_OPTION_INVALID", "所选选项无效");
    const answerText = selected ? selected.label.replace(/（最推荐）$/u, "").trim() : customAnswer;
    const timestamp = now();
    const actor = currentRequestActor();
    const claimed = this.store.db.run(
      `UPDATE ai_user_questions
       SET status = 'answered', selected_option_id = ?, custom_answer = ?, answer_text = ?,
           decided_at = ?, decided_by_user_id = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      selected?.id ?? null,
      customAnswer || null,
      redactSensitiveApprovalText(answerText),
      timestamp,
      actor?.userId ?? null,
      timestamp,
      questionId
    );
    if (claimed.changes === 0) throw new AppError(409, "AI_USER_QUESTION_NOT_PENDING", "该提问已处理");
    this.store.audit(requiredString(current, "work_id"), "ai-user-question.answered", "ai-user-question", questionId, {
      optionId: selected?.id ?? null,
      custom: Boolean(customAnswer)
    });
    return this.getQuestion(questionId);
  }

  rejectQuestion(questionId: string): Record<string, unknown> {
    const current = this.requirePendingQuestion(questionId);
    this.assertCanDecideQuestion(current);
    const timestamp = now();
    const actor = currentRequestActor();
    this.store.db.run(
      `UPDATE ai_user_questions SET status = 'rejected', decided_at = ?, decided_by_user_id = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      timestamp,
      actor?.userId ?? null,
      timestamp,
      questionId
    );
    this.store.audit(requiredString(current, "work_id"), "ai-user-question.rejected", "ai-user-question", questionId, {});
    return this.getQuestion(questionId);
  }

  listPendingToasts(workId: string): { approvals: Record<string, unknown>[]; questions: Record<string, unknown>[] } {
    this.store.getWork(workId);
    this.expireDueRecords(workId);
    const actorId = currentRequestActor()?.userId ?? null;
    const approvals = this.store.db.all(
      `SELECT * FROM ai_write_approvals
       WHERE work_id = ? AND status = 'pending' AND (initiator_user_id IS ? OR (? IS NULL AND initiator_user_id IS NULL))
       ORDER BY created_at`,
      workId,
      actorId,
      actorId
    ).map((row) => this.mapApprovalSummary(row));
    const questions = this.store.db.all(
      `SELECT * FROM ai_user_questions
       WHERE work_id = ? AND status = 'pending' AND (initiator_user_id IS ? OR (? IS NULL AND initiator_user_id IS NULL))
       ORDER BY created_at`,
      workId,
      actorId,
      actorId
    ).map((row) => this.mapQuestion(row));
    return { approvals, questions };
  }

  private buildOperation(workId: string, operation: AiWriteOperationInput, workTitle: string): BuiltAiWriteOperation {
    const kind = operation.kind;
    if (!AI_WRITE_OPERATION_KINDS.includes(kind)) {
      throw new AppError(400, "AI_WRITE_OPERATION_INVALID", "不支持的写入操作类型");
    }
    const toolId = OPERATION_KIND_TOOL_ID[kind];
    const module = OPERATION_KIND_MODULE[kind];
    const aiSummary = redactSensitiveApprovalText(String(operation.summary ?? OPERATION_KIND_LABELS[kind]));
    if (kind === "create_chapter_annotation") {
      return this.buildAnnotationOperation(workId, operation, toolId, module, aiSummary);
    }
    if (kind === "create_analysis_task") {
      return this.buildAnalysisTaskOperation(workId, operation, toolId, module, aiSummary, workTitle);
    }
    const fields = pickDefinedFields(("fields" in operation ? operation.fields : {}) as Record<string, unknown>);
    const targetId = "targetId" in operation ? String(operation.targetId) : null;
    const action = kind.startsWith("create_") || kind === "upsert_outline" && !this.existingOutline(targetId) ? "create" : "update";
    const loaded = this.loadTarget(kind, workId, targetId, action);
    if (loaded && loaded.workId !== workId) {
      throw new AppError(400, "AI_WRITE_TARGET_WORK_MISMATCH", "目标对象不属于当前作品");
    }
    const before = loaded ? this.snapshotFields(kind, loaded.entity) : null;
    const after = action === "create" ? fields : { ...(before ?? {}), ...fields };
    const diffs = buildFieldDiffs(action === "create" ? null : before, after);
    if (action === "update" && diffs.length === 0) {
      throw new AppError(400, "AI_WRITE_NO_CHANGES", "没有检测到可保存的字段变更");
    }
    return {
      kind,
      toolId,
      module,
      action: action === "create" ? "create" : "update",
      targetId: action === "create" && kind !== "upsert_outline" ? null : targetId,
      targetWorkId: workId,
      targetLabel: loaded ? entityLabel(loaded.entity, OPERATION_KIND_LABELS[kind]) : String(fields.title ?? fields.name ?? OPERATION_KIND_LABELS[kind]),
      expectedVersionNo: loaded ? Number(loaded.entity.versionNo ?? 0) || null : null,
      requiredModules: [module],
      aiSummary,
      fields,
      before,
      after,
      diffs
    };
  }

  private existingOutline(chapterId: string | null): boolean {
    if (!chapterId) return false;
    return Boolean(this.store.getChapterOutline(chapterId));
  }

  private buildAnnotationOperation(
    workId: string,
    operation: AiWriteOperationInput,
    toolId: BuiltAiWriteOperation["toolId"],
    module: WorkPermissionModule,
    aiSummary: string
  ): BuiltAiWriteOperation {
    if (operation.kind !== "create_chapter_annotation") throw new AppError(400, "AI_WRITE_OPERATION_INVALID", "批注操作类型无效");
    const fields = operation.fields;
    const chapter = this.store.getChapter(fields.chapterId);
    if (String(chapter.workId) !== workId) throw new AppError(400, "AI_WRITE_TARGET_WORK_MISMATCH", "目标章节不属于当前作品");
    const lines = String(chapter.content).replace(/\r\n?/gu, "\n").split("\n");
    if (fields.startLine > lines.length || fields.endLine > lines.length) {
      throw new AppError(400, "ANNOTATION_LINE_RANGE_INVALID", "批注行号超出当前正文范围");
    }
    const quote = lines.slice(fields.startLine - 1, fields.endLine).join("\n");
    const after = {
      kind: fields.kind,
      chapterId: fields.chapterId,
      startLine: fields.startLine,
      endLine: fields.endLine,
      note: fields.note,
      quote
    };
    return {
      kind: operation.kind,
      toolId,
      module,
      action: "create",
      targetId: null,
      targetWorkId: workId,
      targetLabel: `${annotationKindLabel(fields.kind)} · ${String(chapter.title)} L${fields.startLine}${fields.startLine === fields.endLine ? "" : `-${fields.endLine}`}`,
      expectedVersionNo: Number(chapter.versionNo ?? 0) || null,
      requiredModules: ["prose"],
      aiSummary,
      fields: after,
      before: null,
      after,
      diffs: buildFieldDiffs(null, after),
      annotation: {
        kind: fields.kind,
        chapterId: fields.chapterId,
        chapterTitle: String(chapter.title),
        startLine: fields.startLine,
        endLine: fields.endLine,
        quote,
        note: fields.note
      }
    };
  }

  private buildAnalysisTaskOperation(
    workId: string,
    operation: AiWriteOperationInput,
    toolId: BuiltAiWriteOperation["toolId"],
    module: WorkPermissionModule,
    aiSummary: string,
    workTitle: string
  ): BuiltAiWriteOperation {
    if (operation.kind !== "create_analysis_task") throw new AppError(400, "AI_WRITE_OPERATION_INVALID", "分析任务操作类型无效");
    const fields = operation.fields;
    const scope = { ...(fields.scope ?? { type: "book" }) };
    if (scope.chapterId) {
      const chapter = this.store.getChapter(String(scope.chapterId));
      if (String(chapter.workId) !== workId) throw new AppError(400, "AI_WRITE_TARGET_WORK_MISMATCH", "分析范围章节不属于当前作品");
    }
    const purpose = fields.taskType === "timeline-analysis" ? "timeline-analysis"
      : fields.taskType === "relationship-analysis" ? "relationship-analysis"
        : fields.taskType === "consistency-check" ? "consistency-check"
          : fields.taskType === "chapter-analysis" ? "chapter-analysis"
            : "book-analysis";
    const defaultRow = this.store.db.get(
      "SELECT model_id FROM task_defaults WHERE work_id = ? AND task_type = ?",
      workId,
      purpose
    );
    const modelId = fields.modelId ?? (defaultRow ? requiredString(defaultRow, "model_id") : null);
    let modelLabel = "作品默认模型";
    if (modelId) {
      const model = this.store.db.get("SELECT display_name, model_id FROM models WHERE id = ?", modelId);
      if (!model) throw new AppError(400, "MODEL_NOT_FOUND", "指定的分析模型不存在");
      modelLabel = `${requiredString(model, "display_name")} (${requiredString(model, "model_id")})`;
    }
    const requiredModules: WorkPermissionModule[] = [...new Set<WorkPermissionModule>(["ai-analysis", ...analysisTaskReadModules(fields.taskType, scope)])];
    const after = {
      taskType: fields.taskType,
      modelId,
      scope,
      analysisScope: analysisScopeLabel(scope)
    };
    return {
      kind: operation.kind,
      toolId,
      module,
      action: "create",
      targetId: null,
      targetWorkId: workId,
      targetLabel: `${fields.taskType} · ${workTitle}`,
      expectedVersionNo: null,
      requiredModules,
      aiSummary,
      fields: after,
      before: null,
      after,
      diffs: buildFieldDiffs(null, after),
      analysisTask: {
        taskType: fields.taskType,
        modelId,
        modelLabel,
        scope,
        scopeLabel: analysisScopeLabel(scope)
      }
    };
  }

  private loadTarget(
    kind: AiWriteOperationInput["kind"],
    workId: string,
    targetId: string | null,
    action: "create" | "update"
  ): { workId: string; entity: Record<string, unknown> } | null {
    if (action === "create" && kind !== "upsert_outline") return null;
    if (!targetId) throw new AppError(400, "AI_WRITE_TARGET_REQUIRED", "编辑操作必须指定目标对象");
    if (kind === "update_setting") {
      const entity = this.store.getSetting(targetId);
      return { workId: String(entity.workId), entity };
    }
    if (kind === "update_character") {
      const entity = this.store.getCharacter(targetId);
      return { workId: String(entity.workId), entity };
    }
    if (kind === "update_race") {
      const entity = this.store.getRace(targetId, false);
      return { workId: String(entity.workId), entity };
    }
    if (kind === "update_organization") {
      const entity = this.store.getOrganization(targetId);
      return { workId: String(entity.workId), entity };
    }
    if (kind === "update_timeline_track") {
      const entity = this.store.getTimelineTrack(targetId);
      return { workId: String(entity.workId), entity };
    }
    if (kind === "update_timeline_event") {
      const entity = this.store.getTimelineEvent(targetId);
      return { workId: String(entity.workId), entity };
    }
    if (kind === "update_relationship") {
      const entity = this.store.getRelationship(targetId);
      return { workId: String(entity.workId), entity };
    }
    if (kind === "upsert_outline") {
      const chapter = this.store.getChapter(targetId);
      if (String(chapter.workId) !== workId) throw new AppError(400, "AI_WRITE_TARGET_WORK_MISMATCH", "目标章节不属于当前作品");
      const outline = this.store.getChapterOutline(targetId);
      return { workId: String(chapter.workId), entity: outline ?? { chapterId: targetId, workId: chapter.workId, title: chapter.title, versionNo: 0 } };
    }
    if (kind === "update_foreshadow") {
      const entity = this.store.getForeshadow(targetId);
      return { workId: String(entity.workId), entity };
    }
    return null;
  }

  private snapshotFields(kind: AiWriteOperationInput["kind"], entity: Record<string, unknown>): Record<string, unknown> {
    if (kind.includes("setting")) return comparableEntity(SETTING_FIELDS, entity);
    if (kind.includes("character")) {
      const profile = entity.profile && typeof entity.profile === "object" && !Array.isArray(entity.profile)
        ? { ...(entity.profile as Record<string, unknown>) }
        : {};
      delete profile.sections;
      return comparableEntity(CHARACTER_FIELDS, { ...entity, profile });
    }
    if (kind.includes("race")) return comparableEntity(RACE_FIELDS, entity);
    if (kind.includes("organization")) return comparableEntity(ORGANIZATION_FIELDS, entity);
    if (kind.includes("timeline_track")) return comparableEntity(TRACK_FIELDS, entity);
    if (kind.includes("timeline_event")) return comparableEntity(EVENT_FIELDS, entity);
    if (kind.includes("relationship")) return comparableEntity(RELATIONSHIP_FIELDS, entity);
    if (kind.includes("outline")) return comparableEntity(OUTLINE_FIELDS, entity);
    return comparableEntity(FORESHADOW_FIELDS, entity);
  }

  private executeOperations(approvalId: string, workId: string): Array<Record<string, unknown>> {
    const operations = this.store.db.all(
      "SELECT * FROM ai_write_approval_operations WHERE approval_id = ? ORDER BY sort_order",
      approvalId
    );
    const results: Array<Record<string, unknown>> = [];
    for (const row of operations) {
      const result = this.executeOperation(workId, row);
      this.store.db.run("UPDATE ai_write_approval_operations SET result_json = ? WHERE id = ?", JSON.stringify(result), requiredString(row, "id"));
      results.push(result);
    }
    return results;
  }

  private executeOperation(workId: string, row: Row): Record<string, unknown> {
    const kind = requiredString(row, "kind");
    const fields = json<Record<string, unknown>>(requiredString(row, "fields_json"), {});
    const targetId = optionalString(row, "target_id");
    const expected = row.expected_version_no === null || row.expected_version_no === undefined ? undefined : numberValue(row, "expected_version_no");
    const sourceRef = requiredString(row, "approval_id");
    const note = "AI 审批执行";
    if (kind === "create_setting") {
      const created = this.store.createSetting(workId, fields as never, "ai-approval", sourceRef);
      return { kind, action: "create", id: created.id, versionNo: created.versionNo, actor: currentRequestActor()?.displayName ?? null };
    }
    if (kind === "update_setting" && targetId) {
      const updated = this.store.updateSetting(targetId, fields as never, "ai-approval", sourceRef, note, expected);
      return { kind, action: "update", id: updated.id, versionNo: updated.versionNo, actor: currentRequestActor()?.displayName ?? null };
    }
    if (kind === "create_character") {
      const created = this.store.createCharacter(workId, fields as never);
      return { kind, action: "create", id: created.id, versionNo: created.versionNo, actor: currentRequestActor()?.displayName ?? null };
    }
    if (kind === "update_character" && targetId) {
      const updated = this.store.updateCharacter(targetId, fields as never, "ai-approval", sourceRef, note, expected);
      return { kind, action: "update", id: updated.id, versionNo: updated.versionNo, actor: currentRequestActor()?.displayName ?? null };
    }
    if (kind === "create_race") {
      const created = this.store.createRace(workId, fields as never);
      return { kind, action: "create", id: created.id, versionNo: created.versionNo, actor: currentRequestActor()?.displayName ?? null };
    }
    if (kind === "update_race" && targetId) {
      const updated = this.store.updateRace(targetId, fields as never, "ai-approval", sourceRef, note, expected);
      return { kind, action: "update", id: updated.id, versionNo: updated.versionNo, actor: currentRequestActor()?.displayName ?? null };
    }
    if (kind === "create_organization") {
      const created = this.store.createOrganization(workId, fields as never);
      return { kind, action: "create", id: created.id, versionNo: created.versionNo, actor: currentRequestActor()?.displayName ?? null };
    }
    if (kind === "update_organization" && targetId) {
      const updated = this.store.updateOrganization(targetId, fields as never, "ai-approval", sourceRef, note, expected);
      return { kind, action: "update", id: updated.id, versionNo: updated.versionNo, actor: currentRequestActor()?.displayName ?? null };
    }
    if (kind === "create_timeline_track") {
      const created = this.store.createTimelineTrack(workId, fields as never);
      return { kind, action: "create", id: created.id, versionNo: created.versionNo, actor: currentRequestActor()?.displayName ?? null };
    }
    if (kind === "update_timeline_track" && targetId) {
      const updated = this.store.updateTimelineTrack(targetId, fields as never, "ai-approval", sourceRef, note, expected);
      return { kind, action: "update", id: updated.id, versionNo: updated.versionNo, actor: currentRequestActor()?.displayName ?? null };
    }
    if (kind === "create_timeline_event") {
      const created = this.store.createTimelineEvent(workId, fields as never);
      return { kind, action: "create", id: created.id, versionNo: created.versionNo, actor: currentRequestActor()?.displayName ?? null };
    }
    if (kind === "update_timeline_event" && targetId) {
      const updated = this.store.updateTimelineEvent(targetId, fields as never, "ai-approval", sourceRef, note, expected);
      return { kind, action: "update", id: updated.id, versionNo: updated.versionNo, actor: currentRequestActor()?.displayName ?? null };
    }
    if (kind === "create_relationship") {
      const created = this.store.createRelationship(workId, fields as never);
      return { kind, action: "create", id: created.id, versionNo: created.versionNo, actor: currentRequestActor()?.displayName ?? null };
    }
    if (kind === "update_relationship" && targetId) {
      const updated = this.store.updateRelationship(targetId, fields as never, "ai-approval", sourceRef, note, expected);
      return { kind, action: "update", id: updated.id, versionNo: updated.versionNo, actor: currentRequestActor()?.displayName ?? null };
    }
    if (kind === "upsert_outline" && targetId) {
      const updated = this.store.upsertChapterOutline(targetId, fields as never, "ai-approval", sourceRef, note, expected);
      return { kind, action: requiredString(row, "action"), id: targetId, versionNo: updated.versionNo, actor: currentRequestActor()?.displayName ?? null };
    }
    if (kind === "create_foreshadow") {
      const created = this.store.createForeshadow(workId, fields as never);
      return { kind, action: "create", id: created.id, versionNo: created.versionNo, actor: currentRequestActor()?.displayName ?? null };
    }
    if (kind === "update_foreshadow" && targetId) {
      const updated = this.store.updateForeshadow(targetId, fields as never, "ai-approval", sourceRef, note, expected);
      return { kind, action: "update", id: updated.id, versionNo: updated.versionNo, actor: currentRequestActor()?.displayName ?? null };
    }
    if (kind === "create_chapter_annotation") {
      const created = this.store.createChapterAnnotation(String(fields.chapterId), {
        kind: fields.kind as "note" | "todo",
        startLine: Number(fields.startLine),
        endLine: Number(fields.endLine),
        note: String(fields.note)
      });
      return { kind, action: "create", id: created.id, versionNo: created.versionNo, actor: currentRequestActor()?.displayName ?? null };
    }
    if (kind === "create_analysis_task") {
      const created = this.store.createTask(workId, {
        taskType: String(fields.taskType),
        ...(fields.scope ? { scope: fields.scope as Record<string, unknown> } : {}),
        ...(fields.modelId ? { modelId: String(fields.modelId) } : {})
      });
      return { kind, action: "create", id: created.id, taskType: created.taskType, status: created.status, actor: currentRequestActor()?.displayName ?? null };
    }
    throw new AppError(400, "AI_WRITE_OPERATION_INVALID", "无法执行该审批操作");
  }

  private currentTargetVersion(kind: string, targetId: string): number {
    if (kind === "update_character") return Number(this.store.getCharacter(targetId).versionNo ?? 0);
    if (kind === "update_setting") return Number(this.store.getSetting(targetId).versionNo ?? 0);
    if (kind === "update_race") return Number(this.store.getRace(targetId, false).versionNo ?? 0);
    if (kind === "update_organization") return Number(this.store.getOrganization(targetId).versionNo ?? 0);
    if (kind === "update_timeline_track") return Number(this.store.getTimelineTrack(targetId).versionNo ?? 0);
    if (kind === "update_timeline_event") return Number(this.store.getTimelineEvent(targetId).versionNo ?? 0);
    if (kind === "update_relationship") return Number(this.store.getRelationship(targetId).versionNo ?? 0);
    if (kind === "upsert_outline") return Number(this.store.getChapterOutline(targetId)?.versionNo ?? 0);
    if (kind === "update_foreshadow") return Number(this.store.getForeshadow(targetId).versionNo ?? 0);
    return 0;
  }

  private entityTypeForKind(kind: string): "setting" | "race" | "organization" | "timeline-track" | "timeline-event" | "relationship" | "chapter-outline" | "foreshadow" {
    if (kind === "update_setting") return "setting";
    if (kind === "update_race") return "race";
    if (kind === "update_organization") return "organization";
    if (kind === "update_timeline_track") return "timeline-track";
    if (kind === "update_timeline_event") return "timeline-event";
    if (kind === "update_relationship") return "relationship";
    if (kind === "upsert_outline") return "chapter-outline";
    return "foreshadow";
  }

  private invalidationReason(row: Row): string | null {
    const workId = requiredString(row, "work_id");
    const ownerId = optionalString(row, "conversation_owner_user_id");
    const requiredModules = json<WorkPermissionModule[]>(requiredString(row, "required_modules_json"), []);
    const requiredToolIds = json<WorkAgentWriteToolId[]>(requiredString(row, "required_tool_ids_json"), []);
    const currentTools = this.currentWriteToolIds(workId);
    try {
      assertWriteToolsEnabled(currentTools, requiredToolIds);
    } catch {
      const missing = requiredToolIds.filter((toolId) => !currentTools.includes(toolId)).map((toolId) => WRITE_TOOL_LABELS[toolId]);
      return `可写工具已关闭：${missing.join("、") || "相关工具"}`;
    }
    const permissions = this.intersectedWritePermissions(workId, ownerId);
    const actor = currentRequestActor();
    if (actor?.userId && !this.getUserWorkModulePermissions(workId, actor.userId)) {
      return "当前用户已失去作品访问权限";
    }
    if (ownerId && !this.getUserWorkModulePermissions(workId, ownerId)) {
      return "对话归属用户已失去作品访问权限";
    }
    try {
      assertIntersectedWriteAccess(permissions, requiredModules.filter((module) => module !== "ai-analysis"));
      if (requiredModules.includes("ai-analysis")) {
        assertIntersectedWriteAccess(permissions, ["ai-analysis"]);
      }
    } catch {
      return "当前用户与对话归属用户的模块权限已变化，不再满足写入条件";
    }
    const operations = this.store.db.all(
      "SELECT * FROM ai_write_approval_operations WHERE approval_id = ? ORDER BY sort_order",
      requiredString(row, "id")
    );
    for (const operation of operations) {
      const kind = requiredString(operation, "kind") as AiWriteOperationInput["kind"];
      const targetId = optionalString(operation, "target_id");
      const expected = operation.expected_version_no === null || operation.expected_version_no === undefined
        ? null
        : numberValue(operation, "expected_version_no");
      if (kind === "create_analysis_task") {
        const analysis = json<Record<string, unknown>>(optionalString(operation, "analysis_task_json"), {});
        try {
          assertIntersectedReadAccess(permissions, analysisTaskReadModules(analysis.taskType, analysis.scope));
        } catch {
          return "分析任务所需资料的读取权限已变化";
        }
        continue;
      }
      if (kind === "create_chapter_annotation") {
        const annotation = json<{ chapterId: string }>(optionalString(operation, "annotation_json"), { chapterId: "" });
        try {
          const chapter = this.store.getChapter(annotation.chapterId);
          if (String(chapter.workId) !== workId) return "正文批注目标章节已不属于当前作品";
          if (expected && Number(chapter.versionNo) !== expected) return "正文版本已变化，批注位置可能失效";
        } catch (error) {
          if (error instanceof AppError && error.status === 404) return "目标对象已不存在";
          throw error;
        }
        continue;
      }
      if (requiredString(operation, "action") === "create" && kind !== "upsert_outline") continue;
      if (!targetId) return "审批缺少目标对象";
      try {
        const loaded = this.loadTarget(kind, workId, targetId, "update");
        if (!loaded || loaded.workId !== workId) return "目标对象已不属于当前作品";
        if (expected !== null && Number(loaded.entity.versionNo ?? 0) !== expected) {
          return `「${entityLabel(loaded.entity, OPERATION_KIND_LABELS[kind])}」的版本已变化`;
        }
      } catch (error) {
        if (error instanceof AppError && error.status === 404) return "目标对象已不存在";
        throw error;
      }
    }
    return null;
  }

  private invalidateApproval(approvalId: string, reason: string): void {
    this.store.db.run(
      `UPDATE ai_write_approvals SET status = 'invalidated', invalidation_reason = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      reason,
      now(),
      approvalId
    );
    const row = this.store.db.get("SELECT work_id FROM ai_write_approvals WHERE id = ?", approvalId);
    if (row) this.store.audit(requiredString(row, "work_id"), "ai-write-approval.invalidated", "ai-write-approval", approvalId, { reason });
  }

  private expireDueRecords(workId: string, approvalId?: string, questionId?: string): void {
    const timestamp = now();
    if (approvalId) {
      this.store.db.run(
        `UPDATE ai_write_approvals SET status = 'expired', updated_at = ?
         WHERE id = ? AND status = 'pending' AND expires_at <= ?`,
        timestamp,
        approvalId,
        timestamp
      );
    } else {
      this.store.db.run(
        `UPDATE ai_write_approvals SET status = 'expired', updated_at = ?
         WHERE work_id = ? AND status = 'pending' AND expires_at <= ?`,
        timestamp,
        workId,
        timestamp
      );
    }
    if (questionId) {
      this.store.db.run(
        `UPDATE ai_user_questions SET status = 'expired', updated_at = ?
         WHERE id = ? AND status = 'pending' AND expires_at <= ?`,
        timestamp,
        questionId,
        timestamp
      );
    } else {
      this.store.db.run(
        `UPDATE ai_user_questions SET status = 'expired', updated_at = ?
         WHERE work_id = ? AND status = 'pending' AND expires_at <= ?`,
        timestamp,
        workId,
        timestamp
      );
    }
  }

  private requirePendingApproval(approvalId: string): ApprovalRow {
    const row = this.store.db.get("SELECT * FROM ai_write_approvals WHERE id = ?", approvalId);
    if (!row) throw notFound("AI 修改计划");
    this.expireDueRecords(requiredString(row, "work_id"), approvalId);
    const current = this.store.db.get("SELECT * FROM ai_write_approvals WHERE id = ?", approvalId) as ApprovalRow | undefined;
    if (!current) throw notFound("AI 修改计划");
    this.assertCanView(current);
    if (requiredString(current, "status") === "expired") {
      throw new AppError(409, "AI_WRITE_APPROVAL_EXPIRED", "该审批已过期");
    }
    if (requiredString(current, "status") === "invalidated") {
      throw new AppError(409, "AI_WRITE_APPROVAL_INVALIDATED", optionalString(current, "invalidation_reason") || "该审批已失效");
    }
    if (requiredString(current, "status") !== "pending") {
      throw new AppError(409, "AI_WRITE_APPROVAL_NOT_PENDING", "该审批当前不可确认");
    }
    return current;
  }

  private requirePendingQuestion(questionId: string): Row {
    const row = this.store.db.get("SELECT * FROM ai_user_questions WHERE id = ?", questionId);
    if (!row) throw notFound("AI 提问");
    this.expireDueRecords(requiredString(row, "work_id"), undefined, questionId);
    const current = this.store.db.get("SELECT * FROM ai_user_questions WHERE id = ?", questionId);
    if (!current) throw notFound("AI 提问");
    this.assertCanViewQuestion(current);
    if (requiredString(current, "status") === "expired") throw new AppError(409, "AI_USER_QUESTION_EXPIRED", "该提问已过期");
    if (requiredString(current, "status") === "invalidated") {
      throw new AppError(409, "AI_USER_QUESTION_INVALIDATED", optionalString(current, "invalidation_reason") || "该提问已失效");
    }
    if (requiredString(current, "status") !== "pending") throw new AppError(409, "AI_USER_QUESTION_NOT_PENDING", "该提问当前不可回答");
    const invalidation = this.questionInvalidationReason(current);
    if (invalidation) {
      this.invalidateQuestion(questionId, invalidation);
      throw new AppError(409, "AI_USER_QUESTION_INVALIDATED", invalidation);
    }
    return current;
  }

  private questionInvalidationReason(row: Row): string | null {
    const workId = requiredString(row, "work_id");
    if (!this.currentWriteToolIds(workId).includes("ask_user_questions")) {
      return "向用户提问工具已关闭";
    }
    const actor = currentRequestActor();
    const ownerId = optionalString(row, "conversation_owner_user_id");
    if (actor?.userId && !this.getUserWorkModulePermissions(workId, actor.userId)) {
      return "当前用户已失去作品访问权限";
    }
    if (ownerId && !this.getUserWorkModulePermissions(workId, ownerId)) {
      return "对话归属用户已失去作品访问权限";
    }
    return null;
  }

  private invalidateQuestion(questionId: string, reason: string): void {
    this.store.db.run(
      `UPDATE ai_user_questions SET status = 'invalidated', invalidation_reason = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      reason,
      now(),
      questionId
    );
    const row = this.store.db.get("SELECT work_id FROM ai_user_questions WHERE id = ?", questionId);
    if (row) this.store.audit(requiredString(row, "work_id"), "ai-user-question.invalidated", "ai-user-question", questionId, { reason });
  }

  private visibilitySql(userId: string | null): { sql: string; params: string[] } {
    if (!userId) return { sql: "1 = 1", params: [] };
    return {
      sql: "(approval.initiator_user_id = ? OR approval.conversation_owner_user_id = ? OR approval.initiator_user_id IS NULL)",
      params: [userId, userId]
    };
  }

  private questionVisibilitySql(userId: string | null): { sql: string; params: string[] } {
    if (!userId) return { sql: "1 = 1", params: [] };
    return {
      sql: "(question.initiator_user_id = ? OR question.conversation_owner_user_id = ? OR question.initiator_user_id IS NULL)",
      params: [userId, userId]
    };
  }

  private assertCanView(row: Row): void {
    const actor = currentRequestActor();
    if (!actor) return;
    const userId = actor.userId;
    if (optionalString(row, "initiator_user_id") === userId || optionalString(row, "conversation_owner_user_id") === userId) return;
    if (this.getUserWorkModulePermissions(requiredString(row, "work_id"), userId)) return;
    throw new AppError(403, "AI_WRITE_APPROVAL_DENIED", "你没有查看该审批的权限");
  }

  private assertCanDecide(row: Row): void {
    this.assertCanView(row);
    const actor = currentRequestActor();
    if (!actor) return;
    if (optionalString(row, "initiator_user_id") && optionalString(row, "initiator_user_id") !== actor.userId
      && optionalString(row, "conversation_owner_user_id") !== actor.userId) {
      throw new AppError(403, "AI_WRITE_APPROVAL_DENIED", "你没有处理该审批的权限");
    }
  }

  private assertCanViewQuestion(row: Row): void {
    const actor = currentRequestActor();
    if (!actor) return;
    const userId = actor.userId;
    if (optionalString(row, "initiator_user_id") === userId || optionalString(row, "conversation_owner_user_id") === userId) return;
    if (this.getUserWorkModulePermissions(requiredString(row, "work_id"), userId)) return;
    throw new AppError(403, "AI_USER_QUESTION_DENIED", "你没有查看该提问的权限");
  }

  private assertCanDecideQuestion(row: Row): void {
    this.assertCanViewQuestion(row);
    const actor = currentRequestActor();
    if (!actor) return;
    if (optionalString(row, "initiator_user_id") && optionalString(row, "initiator_user_id") !== actor.userId
      && optionalString(row, "conversation_owner_user_id") !== actor.userId) {
      throw new AppError(403, "AI_USER_QUESTION_DENIED", "你没有处理该提问的权限");
    }
  }

  private mapApprovalSummary(row: Row): Record<string, unknown> {
    const status = requiredString(row, "status") as AiWriteApprovalStatus;
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      conversationId: requiredString(row, "conversation_id"),
      status,
      statusLabel: AI_WRITE_APPROVAL_STATUS_LABELS[status] ?? status,
      aiSummary: requiredString(row, "ai_summary"),
      requiredModules: json<string[]>(requiredString(row, "required_modules_json"), []),
      requiredToolIds: json<string[]>(requiredString(row, "required_tool_ids_json"), []),
      invalidationReason: requiredString(row, "invalidation_reason"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
      expiresAt: requiredString(row, "expires_at"),
      decidedAt: optionalString(row, "decided_at"),
      executedAt: optionalString(row, "executed_at")
    };
  }

  private mapApproval(row: Row, operations: Row[]): Record<string, unknown> {
    const permissions = this.intersectedWritePermissions(
      requiredString(row, "work_id"),
      optionalString(row, "conversation_owner_user_id")
    );
    const actor = currentRequestActor();
    const viewer = actor ? this.getUserWorkModulePermissions(requiredString(row, "work_id"), actor.userId) : fullWorkModulePermissions();
    const mappedOperations = operations.map((operation) => this.mapOperation(operation, viewer ?? permissions));
    return {
      ...this.mapApprovalSummary(row),
      initiatorUserId: optionalString(row, "initiator_user_id"),
      conversationOwnerUserId: optionalString(row, "conversation_owner_user_id"),
      failure: json<Record<string, unknown> | null>(optionalString(row, "failure_json"), null),
      result: json<Record<string, unknown> | null>(optionalString(row, "result_json"), null),
      canRollback: requiredString(row, "status") === "succeeded"
        && mappedOperations.some((operation) => operation.action === "update"),
      operations: mappedOperations,
      audits: this.listApprovalAudits(requiredString(row, "work_id"), requiredString(row, "id"))
    };
  }

  private listApprovalAudits(workId: string, approvalId: string): Record<string, unknown>[] {
    const rows = this.store.db.all(
      `SELECT action, entity_type, entity_id, actor, created_at, detail_json
       FROM audit_logs
       WHERE work_id = ? AND (entity_id = ? OR json_extract(detail_json, '$.sourceRef') = ?)
       ORDER BY created_at, rowid`,
      workId,
      approvalId,
      approvalId
    );
    return rows.map((row) => {
      const detail = json<Record<string, unknown>>(optionalString(row, "detail_json"), {});
      const safeDetail = Object.fromEntries(
        Object.entries(detail).filter(([key]) => !/key|token|secret|password|prompt|cookie|session/iu.test(key))
          .map(([key, value]) => [key, typeof value === "string" ? redactSensitiveApprovalText(value) : value])
      );
      return {
        action: requiredString(row, "action"),
        entityType: requiredString(row, "entity_type"),
        entityId: optionalString(row, "entity_id"),
        actor: requiredString(row, "actor"),
        createdAt: requiredString(row, "created_at"),
        detail: safeDetail
      };
    });
  }

  private mapOperation(row: Row, permissions: WorkModulePermissions): Record<string, unknown> {
    const module = requiredString(row, "module") as WorkPermissionModule;
    const canRead = canReadWorkModule(permissions, module);
    const diffs = json<Array<Record<string, unknown>>>(requiredString(row, "diffs_json"), []);
    const kind = requiredString(row, "kind") as AiWriteOperationInput["kind"];
    const action = requiredString(row, "action");
    const toolId = requiredString(row, "tool_id") as WorkAgentWriteToolId;
    return {
      id: requiredString(row, "id"),
      kind,
      kindLabel: OPERATION_KIND_LABELS[kind] ?? kind,
      toolId,
      toolLabel: WRITE_TOOL_LABELS[toolId] ?? toolId,
      module,
      action,
      actionLabel: action === "create" ? "新增" : "编辑",
      targetId: optionalString(row, "target_id"),
      targetLabel: requiredString(row, "target_label"),
      expectedVersionNo: row.expected_version_no === null || row.expected_version_no === undefined ? null : numberValue(row, "expected_version_no"),
      aiSummary: requiredString(row, "ai_summary"),
      diffs: canRead ? diffs.map((diff) => ({
        ...diff,
        beforeText: formatFieldValue(diff.before),
        afterText: formatFieldValue(diff.after)
      })) : [],
      before: canRead ? json<Record<string, unknown> | null>(optionalString(row, "before_json"), null) : null,
      after: canRead ? json<Record<string, unknown>>(requiredString(row, "after_json"), {}) : {},
      annotation: canRead ? json<Record<string, unknown> | null>(optionalString(row, "annotation_json"), null) : null,
      analysisTask: canRead ? json<Record<string, unknown> | null>(optionalString(row, "analysis_task_json"), null) : null,
      result: json<Record<string, unknown> | null>(optionalString(row, "result_json"), null),
      redacted: !canRead
    };
  }

  private mapQuestion(row: Row): Record<string, unknown> {
    const status = requiredString(row, "status") as AiUserQuestionStatus;
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      conversationId: requiredString(row, "conversation_id"),
      status,
      statusLabel: AI_USER_QUESTION_STATUS_LABELS[status] ?? status,
      question: requiredString(row, "question"),
      options: json<Array<{ id: string; label: string }>>(requiredString(row, "options_json"), []),
      allowCustom: Number(row.allow_custom) === 1,
      selectedOptionId: optionalString(row, "selected_option_id"),
      customAnswer: optionalString(row, "custom_answer"),
      answerText: optionalString(row, "answer_text"),
      invalidationReason: requiredString(row, "invalidation_reason"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
      expiresAt: requiredString(row, "expires_at"),
      decidedAt: optionalString(row, "decided_at")
    };
  }
}
