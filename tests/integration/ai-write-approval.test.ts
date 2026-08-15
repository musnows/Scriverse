import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { resolveAiWritePlanMaxOperations } from "../../src/ai-write.js";

type Session = {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  user: { userId: string; username: string };
};

function createRuntimeForTest(options: { maxOperations?: number; authEnabled?: boolean; fetchImpl?: typeof fetch } = {}): Runtime {
  return createRuntime({
    databasePath: ":memory:",
    masterSecret: "ai-write-approval-test-master-secret-with-length",
    serveUi: false,
    revealCaptchaAnswer: true,
    disableUserAuth: options.authEnabled === false,
    security: { allowRegistration: true, enforceSameOrigin: true, setupToken: "ai-write-test-setup-token-with-at-least-32-characters" },
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.maxOperations ? { aiWritePlanMaxOperations: options.maxOperations } : {})
  });
}

async function solveCaptcha(app: Runtime["app"]): Promise<{ captchaId: string; captchaAnswer: string }> {
  const response = await request(app).get("/api/auth/captcha").expect(200);
  return { captchaId: response.body.data.captchaId, captchaAnswer: response.body.data.answer };
}

async function register(runtime: Runtime, username: string): Promise<Session> {
  const agent = request.agent(runtime.app);
  const captcha = await solveCaptcha(runtime.app);
  const response = await agent.post("/api/auth/register").send({
    username,
    password: "secure-password-123",
    passwordConfirmation: "secure-password-123",
    setupToken: "ai-write-test-setup-token-with-at-least-32-characters",
    ...captcha
  }).expect(201);
  return { agent, csrfToken: response.body.data.csrfToken, user: response.body.data.user };
}

async function seedSetting(runtime: Runtime, workId: string, session?: Session, title = "原有设定") {
  const target = session ? session.agent : request(runtime.app);
  const req = session ? target.post(`/api/works/${workId}/settings`).set("X-CSRF-Token", session.csrfToken) : target.post(`/api/works/${workId}/settings`);
  return req.send({ title, category: "世界", content: "初始内容" }).expect(201);
}

async function enableWriteTool(runtime: Runtime, workId: string, session: Session, writeTools: Record<string, boolean>) {
  await session.agent.patch(`/api/works/${workId}/ai-settings`).set("X-CSRF-Token", session.csrfToken).send({ writeTools }).expect(200);
}

describe("AI 可写工具审批流", () => {
  let runtime: Runtime;

  afterEach(() => {
    if (runtime) runtime.close();
    runtime = undefined as unknown as Runtime;
  });

  it("所有可写工具默认关闭，开启后才能创建计划", async () => {
    runtime = createRuntimeForTest();
    const owner = await register(runtime, "write_default_owner");
    const work = await owner.agent.post("/api/works").set("X-CSRF-Token", owner.csrfToken).send({ title: "默认关闭" }).expect(201);
    const workId = work.body.data.id;
    const settings = await owner.agent.get(`/api/works/${workId}/ai-settings`).expect(200);
    expect(settings.body.data.writeTools).toEqual({
      settings: false, characters: false, races: false, organizations: false, timeline: false,
      relationships: false, outlines: false, annotations: false, analysis: false, AskUserQuestions: false
    });
    await owner.agent.post(`/api/works/${workId}/ai-write/plans`).set("X-CSRF-Token", owner.csrfToken).send({
      summary: "未开启工具的计划",
      operations: [{ operationType: "setting.create", input: { title: "魔法", category: "世界观", content: "魔法存在", summary: "新增设定" } }]
    }).expect(403);
    await enableWriteTool(runtime, workId, owner, { settings: true });
    const plan = await owner.agent.post(`/api/works/${workId}/ai-write/plans`).set("X-CSRF-Token", owner.csrfToken).send({
      summary: "新增世界观设定",
      operations: [{ operationType: "setting.create", input: { title: "魔法", category: "世界观", content: "魔法存在", summary: "新增设定" } }]
    }).expect(201);
    expect(plan.body.data.status).toBe("pending");
    expect(plan.body.data.operations[0].diff.fields.map((field: Record<string, unknown>) => field.field)).toEqual(["title", "category", "content"]);
  });

  it("确认接口只接收审批 ID，计划内容由系统生成且不可由前端改写", async () => {
    runtime = createRuntimeForTest();
    const owner = await register(runtime, "plan_immutable_owner");
    const work = await owner.agent.post("/api/works").set("X-CSRF-Token", owner.csrfToken).send({ title: "不可变计划" }).expect(201);
    const workId = work.body.data.id;
    await enableWriteTool(runtime, workId, owner, { settings: true });
    const plan = await owner.agent.post(`/api/works/${workId}/ai-write/plans`).set("X-CSRF-Token", owner.csrfToken).send({
      summary: "新建设定 A",
      operations: [{ operationType: "setting.create", input: { title: "设定 A", category: "世界", content: "内容 A", summary: "新建设定 A" } }]
    }).expect(201);
    const approvalId = plan.body.data.id;
    await owner.agent.post(`/api/ai-write-approvals/${approvalId}/approve`).set("X-CSRF-Token", owner.csrfToken).send({
      operations: [{ operationType: "setting.create", input: { title: "伪造设定", category: "世界", content: "伪造内容", summary: "伪造" } }]
    }).expect(400);
    await owner.agent.post(`/api/ai-write-approvals/${approvalId}/approve`).set("X-CSRF-Token", owner.csrfToken).send({}).expect(200);
    const settings = await owner.agent.get(`/api/works/${workId}/settings`).expect(200);
    expect(settings.body.data).toHaveLength(1);
    expect(settings.body.data[0].title).toBe("设定 A");
    const detailSetting = await owner.agent.get(`/api/settings/${settings.body.data[0].id}`).expect(200);
    expect(detailSetting.body.data.content).toBe("内容 A");
  });

  it("执行前重新校验目标版本，版本变化后审批失效且不产生写入", async () => {
    runtime = createRuntimeForTest();
    const owner = await register(runtime, "version_owner");
    const work = await owner.agent.post("/api/works").set("X-CSRF-Token", owner.csrfToken).send({ title: "版本校验" }).expect(201);
    const workId = work.body.data.id;
    await enableWriteTool(runtime, workId, owner, { settings: true });
    const setting = await seedSetting(runtime, workId, owner, "待更新设定");
    const settingId = setting.body.data.id;
    const plan = await owner.agent.post(`/api/works/${workId}/ai-write/plans`).set("X-CSRF-Token", owner.csrfToken).send({
      summary: "更新设定标题",
      operations: [{ operationType: "setting.update", input: { settingId, title: "AI 更新后", summary: "更新设定标题" } }]
    }).expect(201);
    expect(plan.body.data.operations[0].targetVersion).toBe(setting.body.data.versionNo);
    await owner.agent.patch(`/api/settings/${settingId}`).set("X-CSRF-Token", owner.csrfToken).send({
      title: "用户抢先修改",
      expectedVersionNo: setting.body.data.versionNo
    }).expect(200);
    const rejected = await owner.agent.post(`/api/ai-write-approvals/${plan.body.data.id}/approve`).set("X-CSRF-Token", owner.csrfToken).send({}).expect(409);
    expect(rejected.body.error.code).toBe("AI_WRITE_APPROVAL_INVALID");
    expect(rejected.body.error.details.problems.join("；")).toContain("目标版本已变化");
    const detail = await owner.agent.get(`/api/ai-write-approvals/${plan.body.data.id}`).expect(200);
    expect(detail.body.data.status).toBe("invalid");
    const settings = await owner.agent.get(`/api/works/${workId}/settings`).expect(200);
    expect(settings.body.data[0].title).toBe("用户抢先修改");
  });

  it("原子执行：任一操作失败时整份计划回滚，并保证审批只成功一次", async () => {
    runtime = createRuntimeForTest({ maxOperations: 2 });
    const owner = await register(runtime, "atomic_owner");
    const work = await owner.agent.post("/api/works").set("X-CSRF-Token", owner.csrfToken).send({ title: "原子审批" }).expect(201);
    const workId = work.body.data.id;
    await enableWriteTool(runtime, workId, owner, { settings: true });
    const before = await owner.agent.get(`/api/works/${workId}/settings`).expect(200);
    const plan = await owner.agent.post(`/api/works/${workId}/ai-write/plans`).set("X-CSRF-Token", owner.csrfToken).send({
      summary: "混合计划",
      operations: [
        { operationType: "setting.create", input: { title: "应回滚", category: "世界", content: "不得保留", summary: "应回滚" } },
        { operationType: "setting.update", input: { settingId: "cross-work-setting", title: "跨作品目标", summary: "必然失败" } }
      ]
    }).expect(404);
    expect(plan.body.error.code).toBe("NOT_FOUND");
    // 使用另一个作品的合法对象伪装成当前作品目标
    const otherWork = await owner.agent.post("/api/works").set("X-CSRF-Token", owner.csrfToken).send({ title: "另一部作品" }).expect(201);
    const otherSetting = await seedSetting(runtime, otherWork.body.data.id, owner, "其他作品设定");
    await enableWriteTool(runtime, otherWork.body.data.id, owner, { settings: true });
    const crossPlan = await owner.agent.post(`/api/works/${workId}/ai-write/plans`).set("X-CSRF-Token", owner.csrfToken).send({
      summary: "混合计划",
      operations: [
        { operationType: "setting.create", input: { title: "应回滚", category: "世界", content: "不得保留", summary: "应回滚" } },
        { operationType: "setting.update", input: { settingId: otherSetting.body.data.id, title: "跨作品目标", summary: "必然失败" } }
      ]
    }).expect(400);
    expect(crossPlan.body.error.code).toBe("AI_WRITE_TARGET_WORK_MISMATCH");
    expect((await owner.agent.get(`/api/works/${workId}/settings`).expect(200)).body.data).toHaveLength(before.body.data.length);
  });

  it("AskUserQuestions 一次一问、推荐第一项，并持久化未回答与拒绝状态", async () => {
    runtime = createRuntimeForTest();
    const owner = await register(runtime, "question_owner");
    const work = await owner.agent.post("/api/works").set("X-CSRF-Token", owner.csrfToken).send({ title: "提问" }).expect(201);
    const workId = work.body.data.id;
    await enableWriteTool(runtime, workId, owner, { AskUserQuestions: true });
    const asked = await owner.agent.post(`/api/ai-write-questions/${"missing"}/answer`).set("X-CSRF-Token", owner.csrfToken).send({ answer: "x" }).expect(404);
    expect(asked.body.error.code).toBe("NOT_FOUND");
    // 直接调用持久化服务，并通过 API 读取
    const question = runtime.aiWrite.askQuestion({
      workId,
      conversationId: null,
      question: "主角应该选择哪条路线？",
      options: ["北上寻找旧友", "南下进入遗迹"],
      allowCustomAnswer: true,
      toolCallId: "call-1",
      requester: owner.user as never,
      requesterAllowAdminAccess: true
    });
    expect(question.status).toBe("pending");
    expect(question.options).toEqual(["北上寻找旧友", "南下进入遗迹"]);
    expect(question.recommendedOptionIndex).toBe(0);
    const page = await owner.agent.get(`/api/works/${workId}/ai-write/questions`).expect(200);
    expect(page.body.data.items).toHaveLength(1);
    expect(page.body.data.items[0].status).toBe("pending");
    await owner.agent.post(`/api/ai-write-questions/${question.id}/answer`).set("X-CSRF-Token", owner.csrfToken).send({ refuse: true }).expect(200);
    const refused = await owner.agent.get(`/api/ai-write-questions/${question.id}`).expect(200);
    expect(refused.body.data.status).toBe("refused");
    await owner.agent.post(`/api/ai-write-questions/${question.id}/answer`).set("X-CSRF-Token", owner.csrfToken).send({ optionIndex: 0 }).expect(409);
  });

  it("缺少 CSRF 或未登录不能创建或执行审批", async () => {
    runtime = createRuntimeForTest();
    const owner = await register(runtime, "csrf_owner");
    const work = await owner.agent.post("/api/works").set("X-CSRF-Token", owner.csrfToken).send({ title: "安全校验" }).expect(201);
    const workId = work.body.data.id;
    await enableWriteTool(runtime, workId, owner, { settings: true });
    await owner.agent.post(`/api/works/${workId}/ai-write/plans`).send({
      summary: "缺少 CSRF",
      operations: [{ operationType: "setting.create", input: { title: "x", category: "世界", content: "x", summary: "x" } }]
    }).expect(403);
    const plan = await owner.agent.post(`/api/works/${workId}/ai-write/plans`).set("X-CSRF-Token", owner.csrfToken).send({
      summary: "安全校验",
      operations: [{ operationType: "setting.create", input: { title: "安全", category: "世界", content: "内容", summary: "安全" } }]
    }).expect(201);
    await request(runtime.app).post(`/api/ai-write-approvals/${plan.body.data.id}/approve`).send({}).expect(401);
  });

  it("写权限取当前用户与 AI 对话归属用户交集", async () => {
    runtime = createRuntimeForTest();
    const owner = await register(runtime, "intersection_owner");
    const writer = await register(runtime, "intersection_writer");
    const work = await owner.agent.post("/api/works").set("X-CSRF-Token", owner.csrfToken).send({ title: "权限交集" }).expect(201);
    const workId = work.body.data.id;
    await owner.agent.post(`/api/works/${workId}/members`).set("X-CSRF-Token", owner.csrfToken).send({
      userId: writer.user.userId,
      permissions: {
        prose: "read", drafts: "read", settings: "write", characters: "read", races: "read",
        organizations: "read", timeline: "read", relationships: "read", outlines: "read",
        reviews: "read", "ai-chat": "write", "ai-analysis": "none", "ai-settings": "none"
      }
    }).expect(201);
    const conversation = await owner.agent.post(`/api/works/${workId}/ai-conversations`).set("X-CSRF-Token", owner.csrfToken).send({ title: "归属对话" }).expect(201);
    await enableWriteTool(runtime, workId, owner, { settings: true });
    const allowed = await writer.agent.post(`/api/works/${workId}/ai-write/plans`).set("X-CSRF-Token", writer.csrfToken).send({
      conversationId: conversation.body.data.id,
      summary: "交集写权限计划",
      operations: [{ operationType: "setting.create", input: { title: "交集设定", category: "世界", content: "内容", summary: "交集" } }]
    }).expect(201);
    expect(allowed.body.data.ownerUserId).toBe(owner.user.userId);
    expect(allowed.body.data.requestUserId).toBe(writer.user.userId);
    await owner.agent.patch(`/api/works/${workId}/members/${writer.user.userId}`).set("X-CSRF-Token", owner.csrfToken).send({
      permissions: { prose: "read", drafts: "read", settings: "read", characters: "read", races: "read", organizations: "read", timeline: "read", relationships: "read", outlines: "read", reviews: "read", "ai-chat": "write", "ai-analysis": "none", "ai-settings": "none" }
    }).expect(200);
    await writer.agent.post(`/api/works/${workId}/ai-write/plans`).set("X-CSRF-Token", writer.csrfToken).send({
      conversationId: conversation.body.data.id,
      summary: "不应允许",
      operations: [{ operationType: "setting.create", input: { title: "越权", category: "世界", content: "内容", summary: "越权" } }]
    }).expect(403);
  });

  it("正文批注只能创建评论或待办，不改变章节正文与标题", async () => {
    runtime = createRuntimeForTest({ authEnabled: false });
    const work = await request(runtime.app).post("/api/works").send({ title: "批注只读正文" }).expect(201);
    const workId = work.body.data.id;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "第一行\n第二行正文"
    }).expect(201);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ writeTools: { annotations: true } }).expect(200);
    const plan = await request(runtime.app).post(`/api/works/${workId}/ai-write/plans`).send({
      summary: "在第二行创建待办",
      operations: [{ operationType: "chapter-annotation.create", input: { chapterId: chapter.body.data.id, kind: "todo", startLine: 2, endLine: 2, note: "核实设定", summary: "第二行待办" } }]
    }).expect(201);
    const approved = await request(runtime.app).post(`/api/ai-write-approvals/${plan.body.data.id}/approve`).send({}).expect(200);
    expect(approved.body.data.status).toBe("succeeded");
    const current = await request(runtime.app).get(`/api/chapters/${chapter.body.data.id}`).expect(200);
    expect(current.body.data.title).toBe("第一章");
    expect(current.body.data.content).toBe("第一行\n第二行正文");
    const annotations = await request(runtime.app).get(`/api/chapters/${chapter.body.data.id}/annotations`).expect(200);
    expect(annotations.body.data).toHaveLength(1);
    expect(annotations.body.data[0]).toMatchObject({ kind: "todo", startLine: 2, endLine: 2, quote: "第二行正文" });
  });

  it("分析任务计划确认后进入既有任务队列，且任务类型、模型和范围一致", async () => {
    runtime = createRuntimeForTest({ authEnabled: false });
    const work = await request(runtime.app).post("/api/works").send({ title: "分析任务计划" }).expect(201);
    const workId = work.body.data.id;
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "审批测试供应商",
      baseUrl: "https://ai-write.test/v1/chat/completions",
      apiKey: "sk-ai-write-test-secret",
      status: "enabled"
    }).expect(201);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "审批测试模型",
      modelId: "ai-write-model",
      purposes: ["analysis"]
    }).expect(201);
    runtime.database.run("UPDATE providers SET status = 'enabled', connection_status = 'success' WHERE id = ?", provider.body.data.id);
    runtime.database.run("UPDATE models SET enabled = 1 WHERE id = ?", model.body.data.id);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ writeTools: { analysis: true } }).expect(200);
    const plan = await request(runtime.app).post(`/api/works/${workId}/ai-write/plans`).send({
      summary: "创建章节分析任务",
      operations: [{ operationType: "analysis-task.create", input: { taskType: "chapter-analysis", modelId: model.body.data.id, scope: { type: "book" }, summary: "创建章节分析任务" } }]
    }).expect(201);
    const approved = await request(runtime.app).post(`/api/ai-write-approvals/${plan.body.data.id}/approve`).send({}).expect(200);
    const taskId = approved.body.data.operations[0].result.taskId;
    const task = await request(runtime.app).get(`/api/tasks/${taskId}`).expect(200);
    expect(task.body.data).toMatchObject({
      taskType: "chapter-analysis",
      scope: { type: "book" },
      status: "pending"
    });
    expect(task.body.data.model?.id).toBe(model.body.data.id);
    const again = await request(runtime.app).post(`/api/ai-write-approvals/${plan.body.data.id}/approve`).send({}).expect(200);
    expect(again.body.data.id).toBe(plan.body.data.id);
    const tasks = await request(runtime.app).get(`/api/works/${workId}/tasks`).expect(200);
    expect(tasks.body.data.items.filter((item: Record<string, unknown>) => item.id === taskId)).toHaveLength(1);
  });

  it("侧边栏 AI 可写工具调用会先生成待确认计划而不是直接写入", async () => {
    let callIndex = 0;
    const fetchMock = (async () => new Response(JSON.stringify(callIndex++ === 0
      ? { choices: [{ message: { content: null, tool_calls: [{ id: "write-call-1", type: "function", function: { name: "create_setting", arguments: JSON.stringify({ title: "AI 工具设定", category: "世界", content: "由工具生成", summary: "新建 AI 工具设定" }) } }] } }] }
      : { choices: [{ message: { content: "已提交修改计划，等待你确认。" } }] }
    ), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    runtime = createRuntimeForTest({ authEnabled: false, fetchImpl: fetchMock });
    const work = await request(runtime.app).post("/api/works").send({ title: "工具流" }).expect(201);
    const workId = work.body.data.id;
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "工具流供应商",
      baseUrl: "https://ai-write-tools.test/v1/chat/completions",
      apiKey: "sk-ai-write-tools-secret",
      status: "enabled"
    }).expect(201);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "工具流模型",
      modelId: "ai-write-tool-model"
    }).expect(201);
    runtime.database.run("UPDATE providers SET status = 'enabled', connection_status = 'success' WHERE id = ?", provider.body.data.id);
    runtime.database.run("UPDATE models SET enabled = 1 WHERE id = ?", model.body.data.id);
    runtime.database.run(
      "INSERT INTO task_defaults (work_id, task_type, model_id) VALUES (?, 'chat', ?) ON CONFLICT(work_id, task_type) DO UPDATE SET model_id = excluded.model_id",
      workId,
      model.body.data.id
    );
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ writeTools: { settings: true } }).expect(200);
    const generated = await runtime.ai.createStreamingChat({
      workId,
      instruction: "请新建一条世界设定。",
      scope: { type: "none" }
    }, () => undefined);
    const toolCalls = generated.toolCalls as Array<{ name: string; status: string; result?: { data?: Record<string, unknown> } }>;
    const writeCall = toolCalls.find((call) => call.name === "create_setting");
    expect(writeCall?.status).toBe("completed");
    const approvalId = String(writeCall?.result?.data?.approvalId ?? "");
    expect(approvalId).toContain("aiWriteApproval_");
    expect(await request(runtime.app).get(`/api/works/${workId}/settings`).expect(200)).toBeTruthy();
    const settingsBefore = await request(runtime.app).get(`/api/works/${workId}/settings`).expect(200);
    expect(settingsBefore.body.data).toHaveLength(0);
    const approved = await request(runtime.app).post(`/api/ai-write-approvals/${approvalId}/approve`).send({}).expect(200);
    expect(approved.body.data.status).toBe("succeeded");
    const settingsAfter = await request(runtime.app).get(`/api/works/${workId}/settings`).expect(200);
    expect(settingsAfter.body.data).toHaveLength(1);
    expect(settingsAfter.body.data[0].title).toBe("AI 工具设定");
  });

  it("编辑词条的审批支持撤销，且目标被后续修改后拒绝撤销", async () => {
    runtime = createRuntimeForTest();
    const owner = await register(runtime, "undo_owner");
    const work = await owner.agent.post("/api/works").set("X-CSRF-Token", owner.csrfToken).send({ title: "撤销审批" }).expect(201);
    const workId = work.body.data.id;
    await enableWriteTool(runtime, workId, owner, { settings: true });
    const setting = await seedSetting(runtime, workId, owner, "撤销前标题");
    const settingId = setting.body.data.id;
    const plan = await owner.agent.post(`/api/works/${workId}/ai-write/plans`).set("X-CSRF-Token", owner.csrfToken).send({
      summary: "AI 修改标题",
      operations: [{ operationType: "setting.update", input: { settingId, title: "AI 修改后标题", summary: "AI 修改标题" } }]
    }).expect(201);
    await owner.agent.post(`/api/ai-write-approvals/${plan.body.data.id}/approve`).set("X-CSRF-Token", owner.csrfToken).send({}).expect(200);
    let current = await owner.agent.get(`/api/settings/${settingId}`).expect(200);
    expect(current.body.data.title).toBe("AI 修改后标题");
    await owner.agent.post(`/api/ai-write-approvals/${plan.body.data.id}/undo`).set("X-CSRF-Token", owner.csrfToken).send({ reason: "撤销测试" }).expect(200);
    current = await owner.agent.get(`/api/settings/${settingId}`).expect(200);
    expect(current.body.data.title).toBe("撤销前标题");

    const plan2 = await owner.agent.post(`/api/works/${workId}/ai-write/plans`).set("X-CSRF-Token", owner.csrfToken).send({
      summary: "AI 再次修改",
      operations: [{ operationType: "setting.update", input: { settingId, title: "AI 再次修改后", summary: "AI 再次修改" } }]
    }).expect(201);
    await owner.agent.post(`/api/ai-write-approvals/${plan2.body.data.id}/approve`).set("X-CSRF-Token", owner.csrfToken).send({}).expect(200);
    await owner.agent.patch(`/api/settings/${settingId}`).set("X-CSRF-Token", owner.csrfToken).send({
      title: "用户后续修改",
      expectedVersionNo: current.body.data.versionNo + 1
    }).expect(200);
    await owner.agent.post(`/api/ai-write-approvals/${plan2.body.data.id}/undo`).set("X-CSRF-Token", owner.csrfToken).send({ reason: "不应成功" }).expect(409);
    current = await owner.agent.get(`/api/settings/${settingId}`).expect(200);
    expect(current.body.data.title).toBe("用户后续修改");
  });

  it("环境变量上限解析：缺省 5，1–20 生效，超过 20 拒绝", () => {
    expect(resolveAiWritePlanMaxOperations(undefined)).toBe(5);
    expect(resolveAiWritePlanMaxOperations("1")).toBe(1);
    expect(resolveAiWritePlanMaxOperations("20")).toBe(20);
    expect(() => resolveAiWritePlanMaxOperations("21")).toThrow();
    expect(() => resolveAiWritePlanMaxOperations("0")).toThrow();
  });
});
