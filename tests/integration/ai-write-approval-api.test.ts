import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRuntime, createWork, seedChapter } from "../helpers.js";
import type { Runtime } from "../../src/app.js";
import type { WriteOperationDraft } from "../../src/ai-write-approvals.js";
import { runWithRequestActor } from "../../src/request-context.js";

function settingCreateDraft(summary = "新增世界观设定"): WriteOperationDraft {
  return {
    operationType: "entity_create",
    entityType: "setting",
    targetModule: "settings",
    aiSummary: summary,
    before: null,
    after: { title: "大陆纪年", category: "历史", content: "以星辰纪年为历法。" },
    diff: [
      { field: "title", label: "标题", before: null, after: "大陆纪年" },
      { field: "content", label: "内容", before: null, after: "以星辰纪年为历法。" }
    ]
  };
}

function actorUserId(runtime: Runtime): string {
  const user = runtime.auth.listUsers().find((item) => item.status === "active");
  return user?.userId ?? "";
}

function createPlan(runtime: Runtime, work: Record<string, unknown>, operations: WriteOperationDraft[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const actor = actorUserId(runtime);
  return runtime.aiWriteApprovals.createPlan({
    workId: String(work.id),
    conversationId: null,
    requesterUserId: actor,
    conversationOwnerUserId: actor,
    summary: "测试修改计划",
    operations,
    ...extra
  });
}

describe("AI 写计划审批核心流程", () => {
  let runtime: Runtime;
  let work: Record<string, unknown>;

  beforeEach(async () => {
    runtime = createTestRuntime();
    // 审批记录引用真实用户外键，测试内注册发起用户与对话归属用户。
    runtime.auth.register({ username: "test-user-1", password: "secure-password-123" });
    work = await createWork(runtime);
    runtime.store.updateWorkAiSettings(String(work.id), {
      aiWriteTools: [
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
      ]
    });
  });

  afterEach(() => {
    runtime.close();
  });

  it("创建计划后持久化不可变内容，详情包含系统 diff", () => {
    const plan = createPlan(runtime, work, [settingCreateDraft()]);
    expect(plan.status).toBe("pending");
    expect(plan.summary).toBe("测试修改计划");
    const operation = runtime.aiWriteApprovals.listPlanOperations(String(plan.id))[0] as Record<string, unknown>;
    expect(operation.operationType).toBe("entity_create");
    expect(operation.entityType).toBe("setting");
    expect(operation.targetModule).toBe("settings");
    expect(operation.diff).toEqual([
      { field: "title", label: "标题", before: null, after: "大陆纪年" },
      { field: "content", label: "内容", before: null, after: "以星辰纪年为历法。" }
    ]);
    // 对外输出不携带 plan_json 全文，避免绕过模块读权限的脱敏
    expect("plan" in plan).toBe(false);
    expect(plan.workId).toBe(String(work.id));
    expect(plan.createdAt).toBeTruthy();
  });

  it("approve 后原子执行词条新建、词条编辑、正文批注与分析任务", () => {
    const { chapter } = seedChapterResult(runtime, work);
    const setting = runtime.store.createSetting(String(work.id), { title: "旧设定", category: "", content: "旧内容" });
    const plan = createPlan(runtime, work, [
      settingCreateDraft(),
      {
        operationType: "entity_update",
        entityType: "setting",
        targetModule: "settings",
        targetId: String(setting.id),
        targetVersion: Number(setting.versionNo),
        aiSummary: "修改已有设定",
        before: { title: "旧设定", content: "旧内容" },
        after: { title: "新设定", content: "新内容" },
        diff: [
          { field: "title", label: "标题", before: "旧设定", after: "新设定" },
          { field: "content", label: "内容", before: "旧内容", after: "新内容" }
        ]
      },
      {
        operationType: "annotation_create",
        targetModule: "prose",
        targetId: String(chapter.id),
        aiSummary: "在正文上添加评论",
        before: null,
        after: { chapterId: String(chapter.id), kind: "note", startLine: 1, endLine: 1, note: "这里需要补充环境描写", quote: "黎明时，林舟抵达北港。" },
        diff: [
          { field: "kind", label: "批注类型", before: null, after: "评论" },
          { field: "lines", label: "引用正文行号", before: null, after: "1-1" },
          { field: "quote", label: "引用正文", before: null, after: "黎明时，林舟抵达北港。" },
          { field: "note", label: "批注内容", before: null, after: "这里需要补充环境描写" }
        ]
      },
      {
        operationType: "analysis_task",
        targetModule: "ai-analysis",
        aiSummary: "创建全书分析任务",
        before: null,
        after: { taskType: "book-analysis", scope: { type: "book" } },
        diff: [
          { field: "taskType", label: "任务类型", before: null, after: "book-analysis" },
          { field: "model", label: "模型", before: null, after: "任务默认模型" },
          { field: "scope", label: "分析范围", before: null, after: { type: "book" } }
        ]
      }
    ]);
    const approved = runtime.aiWriteApprovals.approvePlan(String(plan.id), actorUserId(runtime));
    expect(approved.status).toBe("succeeded");
    expect(approved.executedAt).toBeTruthy();
    const operations = runtime.aiWriteApprovals.listPlanOperations(String(plan.id));
    expect(operations.map((operation) => operation.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    // 词条新建生效
    const createdSetting = runtime.store.listSettings(String(work.id)).find((item) => item.title === "大陆纪年");
    expect(createdSetting).toBeTruthy();
    // 词条编辑生效
    expect(runtime.store.getSetting(String(setting.id)).title).toBe("新设定");
    // 批注创建生效且不改正文
    const annotations = runtime.store.listChapterAnnotations(String(chapter.id));
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.kind).toBe("note");
    expect(runtime.store.getChapter(String(chapter.id)).content).toBe("黎明时，林舟抵达北港。");
    // 分析任务进入队列
    const tasks = runtime.store.listTaskSummariesPage(String(work.id), { page: 1, limit: 10, offset: 0 });
    expect(tasks.items).toHaveLength(1);
    expect(tasks.items[0]?.taskType).toBe("book-analysis");
    expect(tasks.items[0]?.status).toBe("pending");
    // 审计记录
    const audits = runtime.store.listAuditLogsPage(String(work.id), { page: 1, limit: 50, offset: 0 });
    const auditActions = audits.items.map((item) => item.action);
    expect(auditActions).toContain("ai-write-plan.created");
    expect(auditActions).toContain("ai-write-plan.approved");
  });

  it("重复确认不产生重复写入", () => {
    const plan = createPlan(runtime, work, [settingCreateDraft()]);
    runtime.aiWriteApprovals.approvePlan(String(plan.id), actorUserId(runtime));
    // 已成功状态幂等返回结果，不重复执行
    const repeated = runtime.aiWriteApprovals.approvePlan(String(plan.id), actorUserId(runtime));
    expect(repeated.status).toBe("succeeded");
    expect(runtime.store.listSettings(String(work.id)).filter((item) => item.title === "大陆纪年")).toHaveLength(1);
    const current = runtime.aiWriteApprovals.getPlan(String(plan.id));
    expect(current.status).toBe("succeeded");
  });

  it("目标版本变化时审批失效且不执行任何写入", () => {
    const setting = runtime.store.createSetting(String(work.id), { title: "旧设定", category: "", content: "旧内容" });
    const plan = createPlan(runtime, work, [{
      operationType: "entity_update",
      entityType: "setting",
      targetModule: "settings",
      targetId: String(setting.id),
      targetVersion: Number(setting.versionNo),
      aiSummary: "修改设定",
      before: { title: "旧设定" },
      after: { title: "新设定" },
      diff: [{ field: "title", label: "标题", before: "旧设定", after: "新设定" }]
    }]);
    // 计划创建后词条被其他操作修改
    runtime.store.updateSetting(String(setting.id), { title: "并行修改" });
    expect(() => runtime.aiWriteApprovals.approvePlan(String(plan.id), actorUserId(runtime)))
      .toThrow(/版本已变化/u);
    const current = runtime.aiWriteApprovals.getPlan(String(plan.id));
    expect(current.status).toBe("invalidated");
    expect(String(current.invalidReason)).toContain("版本已变化");
    expect(runtime.store.getSetting(String(setting.id)).title).toBe("并行修改");
  });

  it("工具开关关闭时审批失效", () => {
    const plan = createPlan(runtime, work, [settingCreateDraft()]);
    runtime.store.updateWorkAiSettings(String(work.id), { aiWriteTools: [] });
    expect(() => runtime.aiWriteApprovals.approvePlan(String(plan.id), actorUserId(runtime)))
      .toThrow(/开关已关闭/u);
    const current = runtime.aiWriteApprovals.getPlan(String(plan.id));
    expect(current.status).toBe("invalidated");
    expect(runtime.store.listSettings(String(work.id)).filter((item) => item.title === "大陆纪年")).toHaveLength(0);
  });

  it("跨作品传入对象 ID 时审批失效", async () => {
    const otherWork = await createWork(runtime);
    const otherSetting = runtime.store.createSetting(String(otherWork.id), { title: "他作设定", category: "", content: "" });
    const plan = createPlan(runtime, work, [{
      operationType: "entity_update",
      entityType: "setting",
      targetModule: "settings",
      targetId: String(otherSetting.id),
      targetVersion: Number(otherSetting.versionNo),
      aiSummary: "尝试修改他作设定",
      before: { title: "他作设定" },
      after: { title: "被篡改" },
      diff: [{ field: "title", label: "标题", before: "他作设定", after: "被篡改" }]
    }]);
    expect(() => runtime.aiWriteApprovals.approvePlan(String(plan.id), actorUserId(runtime)))
      .toThrow(/不属于当前作品/u);
    expect(runtime.store.getSetting(String(otherSetting.id)).title).toBe("他作设定");
  });

  it("任一操作执行失败时整单回滚，不留部分写入", () => {
    const { chapter } = seedChapterResult(runtime, work);
    const plan = createPlan(runtime, work, [
      settingCreateDraft(),
      {
        // 批注行号超限：执行时 store 抛错，触发整单回滚
        operationType: "annotation_create",
        targetModule: "prose",
        targetId: String(chapter.id),
        aiSummary: "行号超限的批注",
        before: null,
        after: { chapterId: String(chapter.id), kind: "note", startLine: 999, endLine: 999, note: "越界" },
        diff: []
      }
    ]);
    expect(() => runtime.aiWriteApprovals.approvePlan(String(plan.id), actorUserId(runtime)))
      .toThrow();
    const current = runtime.aiWriteApprovals.getPlan(String(plan.id));
    // 执行失败：整单标记 failed，业务写入全部回滚
    expect(current.status).toBe("failed");
    expect(String(current.failure)).toBeTruthy();
    // 第一个操作未留下任何写入
    expect(runtime.store.listSettings(String(work.id)).filter((item) => item.title === "大陆纪年")).toHaveLength(0);
    expect(runtime.store.listChapterAnnotations(String(chapter.id))).toHaveLength(0);
  });

  it("拒绝后不能再次确认", () => {
    const plan = createPlan(runtime, work, [settingCreateDraft()]);
    const rejected = runtime.aiWriteApprovals.rejectPlan(String(plan.id), actorUserId(runtime));
    expect(rejected.status).toBe("rejected");
    expect(rejected.decidedAt).toBeTruthy();
    expect(() => runtime.aiWriteApprovals.approvePlan(String(plan.id), actorUserId(runtime)))
      .toThrow(/不能重复确认/u);
    expect(runtime.store.listSettings(String(work.id)).filter((item) => item.title === "大陆纪年")).toHaveLength(0);
  });

  it("执行成功后撤销编辑类操作，恢复修改前值并产生新版本", () => {
    const setting = runtime.store.createSetting(String(work.id), { title: "旧设定", category: "", content: "旧内容" });
    const plan = createPlan(runtime, work, [{
      operationType: "entity_update",
      entityType: "setting",
      targetModule: "settings",
      targetId: String(setting.id),
      targetVersion: Number(setting.versionNo),
      aiSummary: "修改设定",
      before: { title: "旧设定", content: "旧内容" },
      after: { title: "新设定", content: "新内容" },
      diff: [{ field: "title", label: "标题", before: "旧设定", after: "新设定" }]
    }]);
    runtime.aiWriteApprovals.approvePlan(String(plan.id), actorUserId(runtime));
    expect(runtime.store.getSetting(String(setting.id)).title).toBe("新设定");
    const appliedVersion = Number(runtime.store.getSetting(String(setting.id)).versionNo);
    runtime.aiWriteApprovals.revokePlan(String(plan.id), actorUserId(runtime));
    const restored = runtime.store.getSetting(String(setting.id));
    expect(restored.title).toBe("旧设定");
    expect(Number(restored.versionNo)).toBe(appliedVersion + 1);
    const operations = runtime.aiWriteApprovals.listPlanOperations(String(plan.id));
    const result = operations[0]?.result as Record<string, unknown>;
    expect(result.revoked).toBe(true);
    expect(result.revokedVersionNo).toBe(Number(restored.versionNo));
    // 无可撤销项后再次撤销被拒绝
    expect(() => runtime.aiWriteApprovals.revokePlan(String(plan.id), actorUserId(runtime)))
      .toThrow(/没有可撤销/u);
  });

  it("目标词条被后续修改后不允许撤销", () => {
    const setting = runtime.store.createSetting(String(work.id), { title: "旧设定", category: "", content: "" });
    const plan = createPlan(runtime, work, [{
      operationType: "entity_update",
      entityType: "setting",
      targetModule: "settings",
      targetId: String(setting.id),
      targetVersion: Number(setting.versionNo),
      aiSummary: "修改设定",
      before: { title: "旧设定" },
      after: { title: "新设定" },
      diff: [{ field: "title", label: "标题", before: "旧设定", after: "新设定" }]
    }]);
    runtime.aiWriteApprovals.approvePlan(String(plan.id), actorUserId(runtime));
    runtime.store.updateSetting(String(setting.id), { title: "人工后续修改" });
    expect(() => runtime.aiWriteApprovals.revokePlan(String(plan.id), actorUserId(runtime)))
      .toThrow(/已被后续版本修改/u);
    expect(runtime.store.getSetting(String(setting.id)).title).toBe("人工后续修改");
  });

  it("AI 新建的词条不通过撤销自动删除", () => {
    const plan = createPlan(runtime, work, [settingCreateDraft()]);
    runtime.aiWriteApprovals.approvePlan(String(plan.id), actorUserId(runtime));
    expect(runtime.store.listSettings(String(work.id)).filter((item) => item.title === "大陆纪年")).toHaveLength(1);
    expect(() => runtime.aiWriteApprovals.revokePlan(String(plan.id), actorUserId(runtime)))
      .toThrow(/没有可撤销/u);
    expect(runtime.store.listSettings(String(work.id)).filter((item) => item.title === "大陆纪年")).toHaveLength(1);
  });

  it("过期计划惰性标记为 expired 且不能确认", () => {
    const plan = createPlan(runtime, work, [settingCreateDraft()]);
    runtime.database.run("UPDATE ai_write_plans SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", String(plan.id));
    const current = runtime.aiWriteApprovals.getPlan(String(plan.id));
    expect(current.status).toBe("expired");
    expect(() => runtime.aiWriteApprovals.approvePlan(String(plan.id), actorUserId(runtime)))
      .toThrow(/不能重复确认/u);
  });

  it("计划列表按状态过滤并惰性过期", () => {
    const pending = createPlan(runtime, work, [settingCreateDraft()]);
    const rejected = createPlan(runtime, work, [settingCreateDraft()]);
    runtime.aiWriteApprovals.rejectPlan(String(rejected.id), actorUserId(runtime));
    runtime.database.run("UPDATE ai_write_plans SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", String(pending.id));
    const page = runtime.aiWriteApprovals.listPlansPage(String(work.id), { page: 1, limit: 20, offset: 0 });
    expect(page.stats).toMatchObject({ expired: 1, rejected: 1 });
    expect(page.items.map((item) => item.id)).toEqual(expect.arrayContaining([String(pending.id), String(rejected.id)]));
    const rejectedOnly = runtime.aiWriteApprovals.listPlansPage(String(work.id), { page: 1, limit: 20, offset: 0 }, "rejected");
    expect(rejectedOnly.items.map((item) => item.id)).toEqual([String(rejected.id)]);
  });

  it("提问创建、回答与重复回答拒绝", () => {
    const question = runtime.aiWriteApprovals.createQuestion({
      workId: String(work.id),
      conversationId: null,
      requesterUserId: actorUserId(runtime),
      question: "角色 A 应该怎么发展？",
      options: [{ label: "复仇路线", description: "走向黑暗面" }, { label: "救赎路线" }]
    });
    expect(question.status).toBe("pending");
    expect((question.options as Array<Record<string, unknown>>)[0]).toMatchObject({ label: "复仇路线", recommended: true });
    const pending = runtime.aiWriteApprovals.listPendingQuestions(String(work.id));
    expect(pending.map((item) => item.id)).toEqual([String(question.id)]);
    const answered = runtime.aiWriteApprovals.answerQuestion(String(question.id), "自定义：两条线结合", actorUserId(runtime));
    expect(answered.status).toBe("answered");
    expect(answered.answer).toBe("自定义：两条线结合");
    expect(runtime.aiWriteApprovals.listPendingQuestions(String(work.id))).toHaveLength(0);
    expect(() => runtime.aiWriteApprovals.answerQuestion(String(question.id), "再次回答", actorUserId(runtime)))
      .toThrow(/不能重复回答/u);
  });

  it("提问拒绝与过期", () => {
    const declined = runtime.aiWriteApprovals.createQuestion({
      workId: String(work.id),
      conversationId: null,
      requesterUserId: actorUserId(runtime),
      question: "要拒绝的问题？",
      options: [{ label: "选项一" }, { label: "选项二" }]
    });
    const declinedResult = runtime.aiWriteApprovals.declineQuestion(String(declined.id), actorUserId(runtime));
    expect(declinedResult.status).toBe("declined");
    const expired = runtime.aiWriteApprovals.createQuestion({
      workId: String(work.id),
      conversationId: null,
      requesterUserId: actorUserId(runtime),
      question: "要过期的问题？",
      options: [{ label: "选项一" }, { label: "选项二" }]
    });
    runtime.database.run("UPDATE ai_approval_questions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", String(expired.id));
    expect(runtime.aiWriteApprovals.listPendingQuestions(String(work.id))).toHaveLength(0);
    expect(runtime.aiWriteApprovals.getQuestion(String(expired.id)).status).toBe("expired");
  });

  it("计划详情按查看者模块权限脱敏", () => {
    const setting = runtime.store.createSetting(String(work.id), { title: "秘密设定", category: "", content: "机密内容" });
    const plan = createPlan(runtime, work, [{
      operationType: "entity_update",
      entityType: "setting",
      targetModule: "settings",
      targetId: String(setting.id),
      targetVersion: Number(setting.versionNo),
      aiSummary: "修改秘密设定",
      before: { title: "秘密设定", content: "机密内容" },
      after: { title: "新设定", content: "新机密" },
      diff: [{ field: "title", label: "标题", before: "秘密设定", after: "新设定" }]
    }]);
    // 无 settings 读权限的查看者（权限为 null 表示无访问）
    const redacted = runtime.aiWriteApprovals.getPlanDetail(String(plan.id), null);
    const operations = redacted.operations as Array<Record<string, unknown>>;
    const operation = operations[0] as Record<string, unknown>;
    expect(operation.redacted).toBe(true);
    expect(operation.before).toBeNull();
    expect(operation.after).toBeNull();
    expect(operation.diff).toEqual([]);
    expect(operation.aiSummary).toContain("无权限");
  });

  it("审批 API 决策接口只接受审批 ID 与 action，不信任任何前端内容", async () => {
    const plan = createPlan(runtime, work, [settingCreateDraft()]);
    const response = await request(runtime.app)
      .post(`/api/ai-write-plans/${String(plan.id)}/decision`)
      .send({ action: "approve", operations: [{ targetId: "hacked", after: { title: "注入" } }] })
      .expect(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    const valid = await request(runtime.app)
      .post(`/api/ai-write-plans/${String(plan.id)}/decision`)
      .send({ action: "approve" })
      .expect(200);
    expect(valid.body.data.status).toBe("succeeded");
    expect(runtime.store.listSettings(String(work.id)).filter((item) => item.title === "大陆纪年")).toHaveLength(1);
  });

  it("审批列表与详情 API 返回计划内容", async () => {
    const plan = createPlan(runtime, work, [settingCreateDraft()]);
    const list = await request(runtime.app)
      .get(`/api/works/${String(work.id)}/ai-write-plans`)
      .expect(200);
    expect(list.body.data.items.map((item: Record<string, unknown>) => item.id)).toContain(String(plan.id));
    const detail = await request(runtime.app)
      .get(`/api/ai-write-plans/${String(plan.id)}`)
      .expect(200);
    expect(detail.body.data.operations).toHaveLength(1);
    expect(detail.body.data.summary).toBe("测试修改计划");
  });
});

/** 在测试中创建带章节的作品上下文。 */
function seedChapterResult(runtime: Runtime, work: Record<string, unknown>): { chapter: Record<string, unknown> } {
  const volume = runtime.store.createVolume(String(work.id), { title: "第一卷" });
  const chapter = runtime.store.createChapter(String(work.id), { volumeId: String(volume.id), title: "第一章", content: "黎明时，林舟抵达北港。" });
  return { chapter };
}
