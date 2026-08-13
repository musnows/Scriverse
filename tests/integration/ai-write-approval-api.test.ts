import { createServer, type Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { AiWriteApprovalService } from "../../src/ai-write-approval.js";
import { id, now } from "../../src/utils.js";

type SessionCredentials = {
  agent: ReturnType<typeof request.agent>;
  cookie: string;
  csrfToken: string;
  user: { userId: string; username: string; displayName: string; role: "admin" | "user" };
};

const setupToken = "ai-write-approval-api-test-setup-token";

let authTestServer: Server;
let activeRuntimeApp: Runtime["app"] | null = null;

async function solveCaptcha(app: Runtime["app"]): Promise<{ captchaId: string; captchaAnswer: string }> {
  const response = await request(app).get("/api/auth/captcha").expect(200);
  return { captchaId: response.body.data.captchaId, captchaAnswer: response.body.data.answer };
}

async function register(runtime: Runtime, username: string): Promise<SessionCredentials> {
  const agent = request.agent(runtime.app);
  const captcha = await solveCaptcha(runtime.app);
  const response = await agent.post("/api/auth/register").send({
    username,
    password: "secure-password-123",
    passwordConfirmation: "secure-password-123",
    setupToken,
    ...captcha
  }).expect(201);
  const cookie = response.headers["set-cookie"]?.[0]?.split(";", 1)[0] ?? "";
  return { agent, cookie, csrfToken: response.body.data.csrfToken, user: response.body.data.user };
}

function createAuthRuntime(): Runtime {
  const runtime = createRuntime({
    databasePath: ":memory:",
    masterSecret: "ai-write-approval-api-master-secret",
    serveUi: false,
    revealCaptchaAnswer: true,
    security: { allowRegistration: true, enforceSameOrigin: true, setupToken }
  });
  activeRuntimeApp = runtime.app;
  return {
    ...runtime,
    app: authTestServer as unknown as Runtime["app"],
    close: () => {
      if (activeRuntimeApp === runtime.app) activeRuntimeApp = null;
      runtime.close();
    }
  };
}

describe("AI 可写工具审批中心 API", () => {
  let runtime: Runtime;
  let approvalService: AiWriteApprovalService;
  let owner: SessionCredentials;
  let workId: string;
  let settingId: string;
  let chapterId: string;

  beforeAll(async () => {
    authTestServer = createServer((incoming, outgoing) => {
      if (!activeRuntimeApp) {
        outgoing.writeHead(503).end();
        return;
      }
      activeRuntimeApp(incoming, outgoing);
    });
    await new Promise<void>((resolve, reject) => {
      const rejectStart = (error: Error) => reject(error);
      authTestServer.once("error", rejectStart);
      authTestServer.listen(0, "127.0.0.1", () => {
        authTestServer.off("error", rejectStart);
        authTestServer.unref();
        resolve();
      });
    });
  });

  afterAll(async () => {
    authTestServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      authTestServer.close((error) => error ? reject(error) : resolve());
    });
  });

  beforeEach(async () => {
    runtime = createAuthRuntime();
    const createAnalysisTask = vi.fn((targetWorkId: string, input: Record<string, unknown>) => ({
      id: id("task"),
      workId: targetWorkId,
      taskType: input.taskType,
      status: "pending",
      createdAt: now()
    }));
    approvalService = new AiWriteApprovalService(runtime.store, runtime.auth, createAnalysisTask);
    owner = await register(runtime, "ai-approval-owner");
    const csrf = { "X-CSRF-Token": owner.csrfToken };
    const work = await owner.agent.post("/api/works").set(csrf).send({ title: "审批 API 测试作品" }).expect(201);
    workId = String(work.body.data.id);
    const volume = await owner.agent.post(`/api/works/${workId}/volumes`).set(csrf).send({ title: "第一卷" }).expect(201);
    const chapter = await owner.agent.post(`/api/works/${workId}/chapters`).set(csrf).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "第一行。\n第二行。\n第三行。"
    }).expect(201);
    chapterId = String(chapter.body.data.id);
    const setting = await owner.agent.post(`/api/works/${workId}/settings`).set(csrf).send({
      title: "北港",
      category: "地理",
      content: "北港是帝国最大的港口城市。"
    }).expect(201);
    settingId = String(setting.body.data.id);
  });

  const ALL_WRITE_TOOL_KEYS = [
    "settings", "characters", "races", "organizations", "timeline", "relationships",
    "outlines", "chapter-annotations", "analysis-tasks", "ask-user-questions"
  ] as const;

  function enableWriteTools(keys: string[]): Promise<unknown> {
    const switches = Object.fromEntries(ALL_WRITE_TOOL_KEYS.map((key) => [key, keys.includes(key)]));
    return owner.agent.patch(`/api/works/${workId}/ai-settings`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ aiWriteTools: switches })
      .expect(200);
  }

  function proposePlan(operations: Array<{
    operationType: string;
    targetId?: string | null;
    summary?: string;
    changes: Record<string, unknown>;
  }>, summary = "测试计划"): Record<string, unknown> {
    return approvalService.proposeWrites({
      workId,
      conversationId: null,
      requesterUserId: owner.user.userId,
      ownerUserId: owner.user.userId,
      summary,
      operations
    });
  }

  it("未登录与缺少同源 CSRF 的请求被拒绝", async () => {
    await enableWriteTools(["settings"]);
    const plan = proposePlan([{
      operationType: "update_setting",
      targetId: settingId,
      summary: "修改内容",
      changes: { content: "新内容。" }
    }]);
    const planId = String(plan.planId);

    await request(runtime.app).get(`/api/works/${workId}/ai-approvals`).expect(401);
    await request(runtime.app).post(`/api/ai-approvals/${planId}/approve`).send({}).expect(401);
    // 有会话但缺少 CSRF Token。
    await owner.agent.post(`/api/ai-approvals/${planId}/approve`).send({}).expect(403);
    // 伪造确认请求体：确认接口只接收审批 ID，附加字段被拒绝。
    await owner.agent.post(`/api/ai-approvals/${planId}/approve`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ targetId: settingId, changes: { content: "伪造内容" } })
      .expect(400);
  });

  it("确认接口只接收审批 ID，执行内容完全来自系统快照", async () => {
    await enableWriteTools(["settings"]);
    const plan = proposePlan([{
      operationType: "update_setting",
      targetId: settingId,
      summary: "修改内容",
      changes: { content: "系统快照中的内容。" }
    }]);
    const planId = String(plan.planId);

    const approved = await owner.agent.post(`/api/ai-approvals/${planId}/approve`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({})
      .expect(200);
    expect(approved.body.data.status).toBe("succeeded");
    const setting = await owner.agent.get(`/api/settings/${settingId}`).expect(200);
    expect(setting.body.data.content).toBe("系统快照中的内容。");
  });

  it("重复确认与并发重复请求只执行一次", async () => {
    await enableWriteTools(["settings"]);
    const plan = proposePlan([{
      operationType: "update_setting",
      targetId: settingId,
      summary: "只执行一次",
      changes: { content: "只执行一次。" }
    }]);
    const planId = String(plan.planId);

    const first = await owner.agent.post(`/api/ai-approvals/${planId}/approve`)
      .set("X-CSRF-Token", owner.csrfToken).send({}).expect(200);
    const second = await owner.agent.post(`/api/ai-approvals/${planId}/approve`)
      .set("X-CSRF-Token", owner.csrfToken).send({}).expect(200);
    expect(first.body.data.executedAt).toBe(second.body.data.executedAt);
    const setting = await owner.agent.get(`/api/settings/${settingId}`).expect(200);
    expect(setting.body.data.versionNo).toBe(2);
    expect(setting.body.data.content).toBe("只执行一次。");
  });

  it("审批中心列表与详情按状态筛选并展示系统 diff", async () => {
    await enableWriteTools(["settings"]);
    const plan = proposePlan([{
      operationType: "update_setting",
      targetId: settingId,
      summary: "补充内容",
      changes: { content: "北港是帝国最大的港口城市，人口两百万。" }
    }], "完善北港");
    const planId = String(plan.planId);

    const list = await owner.agent.get(`/api/works/${workId}/ai-approvals?status=pending`).expect(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0].summary).toBe("完善北港");

    const detail = await owner.agent.get(`/api/ai-approvals/${planId}`).expect(200);
    const operation = detail.body.data.operations[0];
    expect(operation.changes).toHaveLength(1);
    expect(operation.changes[0]).toMatchObject({
      field: "content",
      label: "内容",
      before: "北港是帝国最大的港口城市。",
      after: "北港是帝国最大的港口城市，人口两百万。"
    });
    expect(detail.body.data.requesterDisplayName).toBe("ai-approval-owner");
  });

  it("关闭工具开关后确认时计划自动失效", async () => {
    await enableWriteTools(["settings"]);
    const plan = proposePlan([{
      operationType: "update_setting",
      targetId: settingId,
      summary: "修改内容",
      changes: { content: "不应写入。" }
    }]);
    const planId = String(plan.planId);
    await enableWriteTools([]);

    const response = await owner.agent.post(`/api/ai-approvals/${planId}/approve`)
      .set("X-CSRF-Token", owner.csrfToken).send({}).expect(409);
    expect(response.body.error.code).toBe("AI_WRITE_PLAN_INVALIDATED");
    const detail = await owner.agent.get(`/api/ai-approvals/${planId}`).expect(200);
    expect(detail.body.data.status).toBe("invalidated");
    const setting = await owner.agent.get(`/api/settings/${settingId}`).expect(200);
    expect(setting.body.data.content).toBe("北港是帝国最大的港口城市。");
  });

  it("目标版本变化后确认时计划失效且无部分写入", async () => {
    await enableWriteTools(["settings", "characters"]);
    const plan = proposePlan([
      {
        operationType: "update_setting",
        targetId: settingId,
        summary: "修改内容",
        changes: { content: "计划中的新内容。" }
      },
      {
        operationType: "create_character",
        summary: "新建角色",
        changes: { name: "林晚" }
      }
    ]);
    const planId = String(plan.planId);
    // 提交计划后目标被修改。
    await owner.agent.patch(`/api/settings/${settingId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ content: "作者手动修改。" })
      .expect(200);

    const response = await owner.agent.post(`/api/ai-approvals/${planId}/approve`)
      .set("X-CSRF-Token", owner.csrfToken).send({}).expect(409);
    expect(response.body.error.code).toBe("AI_WRITE_PLAN_INVALIDATED");
    // 整份计划回滚：角色也没有被创建。
    const characters = await owner.agent.get(`/api/works/${workId}/characters`).expect(200);
    expect(characters.body.data).toHaveLength(0);
  });

  it("撤销本次审批后目标词条恢复为修改前的值", async () => {
    await enableWriteTools(["settings"]);
    const plan = proposePlan([{
      operationType: "update_setting",
      targetId: settingId,
      summary: "修改内容",
      changes: { content: "审批写入的内容。" }
    }]);
    const planId = String(plan.planId);
    await owner.agent.post(`/api/ai-approvals/${planId}/approve`)
      .set("X-CSRF-Token", owner.csrfToken).send({}).expect(200);

    const revoked = await owner.agent.post(`/api/ai-approvals/${planId}/revoke`)
      .set("X-CSRF-Token", owner.csrfToken).send({}).expect(200);
    expect(revoked.body.data.revokedAt).toBeTruthy();
    const setting = await owner.agent.get(`/api/settings/${settingId}`).expect(200);
    expect(setting.body.data.content).toBe("北港是帝国最大的港口城市。");
    // 新建词条不支持通过撤销删除：撤销仅含新建操作的审批被拒绝。
    const createPlan = proposePlan([{
      operationType: "create_setting",
      summary: "新建南港",
      changes: { title: "南港", category: "地理", content: "南港是第二大港口。" }
    }]);
    await owner.agent.post(`/api/ai-approvals/${String(createPlan.planId)}/approve`)
      .set("X-CSRF-Token", owner.csrfToken).send({}).expect(200);
    await owner.agent.post(`/api/ai-approvals/${String(createPlan.planId)}/revoke`)
      .set("X-CSRF-Token", owner.csrfToken).send({}).expect(409);
  });

  it("正文批注计划展示类型、行号与引用正文且不改动正文", async () => {
    await enableWriteTools(["chapter-annotations"]);
    const plan = proposePlan([{
      operationType: "create_chapter_annotation",
      summary: "批注第二行",
      changes: { chapterId, kind: "todo", startLine: 2, endLine: 2, note: "检查这行的设定" }
    }]);
    const planId = String(plan.planId);

    const detail = await owner.agent.get(`/api/ai-approvals/${planId}`).expect(200);
    const operation = detail.body.data.operations[0];
    expect(operation.referencedText).toBe("第二行。");
    const chapterBefore = await owner.agent.get(`/api/chapters/${chapterId}`).expect(200);

    await owner.agent.post(`/api/ai-approvals/${planId}/approve`)
      .set("X-CSRF-Token", owner.csrfToken).send({}).expect(200);

    const annotations = await owner.agent.get(`/api/chapters/${chapterId}/annotations`).expect(200);
    expect(annotations.body.data).toHaveLength(1);
    expect(annotations.body.data[0]).toMatchObject({ kind: "todo", note: "检查这行的设定", startLine: 2 });
    const chapterAfter = await owner.agent.get(`/api/chapters/${chapterId}`).expect(200);
    expect(chapterAfter.body.data.content).toBe(chapterBefore.body.data.content);
    expect(chapterAfter.body.data.versionNo).toBe(chapterBefore.body.data.versionNo);
  });

  it("分析任务计划执行后进入任务队列", async () => {
    await enableWriteTools(["analysis-tasks"]);
    const plan = proposePlan([{
      operationType: "create_analysis_task",
      summary: "运行章节分析",
      changes: { taskType: "chapter-analysis", scope: { type: "chapter", chapterId } }
    }]);
    const planId = String(plan.planId);

    await owner.agent.post(`/api/ai-approvals/${planId}/approve`)
      .set("X-CSRF-Token", owner.csrfToken).send({}).expect(200);

    const tasks = await owner.agent.get(`/api/works/${workId}/tasks`).expect(200);
    const created = tasks.body.data.items.find((task: Record<string, unknown>) => task.taskType === "chapter-analysis");
    expect(created).toBeTruthy();
    expect(created.status).toBe("pending");
  });

  it("无 AI 设置权限的成员不能开启可写工具", async () => {
    const member = await register(runtime, "ai-approval-member");
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        userId: member.user.userId,
        permissions: {
          settings: "write", characters: "write", races: "write", organizations: "write",
          timeline: "write", relationships: "write", outlines: "write", prose: "write",
          reviews: "write", "ai-chat": "write", "ai-analysis": "write", "ai-settings": "read"
        }
      })
      .expect(201);
    const switches = Object.fromEntries(ALL_WRITE_TOOL_KEYS.map((key) => [key, key === "settings"]));
    await member.agent.patch(`/api/works/${workId}/ai-settings`)
      .set("X-CSRF-Token", member.csrfToken)
      .send({ aiWriteTools: switches })
      .expect(403);
    // 作品设置仍保持默认全部关闭。
    const settings = await owner.agent.get(`/api/works/${workId}/ai-settings`).expect(200);
    expect(settings.body.data.aiWriteTools.settings).toBe(false);
  });

  it("非计划参与者无法查看或处理审批", async () => {
    await enableWriteTools(["settings"]);
    const plan = proposePlan([{
      operationType: "update_setting",
      targetId: settingId,
      summary: "修改内容",
      changes: { content: "新内容。" }
    }]);
    const planId = String(plan.planId);

    const stranger = await register(runtime, "ai-approval-stranger");
    await stranger.agent.get(`/api/ai-approvals/${planId}`).expect(403);
    await stranger.agent.post(`/api/ai-approvals/${planId}/approve`)
      .set("X-CSRF-Token", stranger.csrfToken).send({}).expect(403);
  });

  it("写权限取当前用户与对话归属用户交集，任一不足即拒绝", async () => {
    const member = await register(runtime, "ai-approval-collab");
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        userId: member.user.userId,
        permissions: {
          settings: "read", characters: "write", races: "read", organizations: "read",
          timeline: "read", relationships: "read", outlines: "read", prose: "read",
          drafts: "read", reviews: "read", "ai-chat": "write", "ai-analysis": "none", "ai-settings": "none"
        }
      })
      .expect(201);
    await enableWriteTools(["settings"]);

    // 当前用户为 owner（全权），对话归属用户为 member（settings 只读）→ 交集不足，拒绝提交。
    expect(() => approvalService.proposeWrites({
      workId,
      conversationId: null,
      requesterUserId: owner.user.userId,
      ownerUserId: member.user.userId,
      summary: "协作计划",
      operations: [{
        operationType: "update_setting",
        targetId: settingId,
        summary: "修改内容",
        changes: { content: "不应通过。" }
      }]
    })).toThrow(/缺少.*模块的写权限/u);
  });

  describe("AskUserQuestions API", () => {
    it("创建、查询、回答与越界校验", async () => {
      const created = approvalService.createQuestion({
        workId,
        conversationId: null,
        requesterUserId: owner.user.userId,
        ownerUserId: owner.user.userId,
        question: "南港的规模？",
        options: ["小型渔港", "大型商港"],
        allowCustomAnswer: true
      });
      const questionId = String(created.questionId);

      const fetched = await owner.agent.get(`/api/ai-questions/${questionId}`).expect(200);
      expect(fetched.body.data.question).toBe("南港的规模？");
      expect(fetched.body.data.recommendedIndex).toBe(0);
      expect(fetched.body.data.status).toBe("pending");

      const answered = await owner.agent.post(`/api/ai-questions/${questionId}/answer`)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ type: "option", index: 1 })
        .expect(200);
      expect(answered.body.data.status).toBe("answered");
      expect(answered.body.data.answer).toEqual({ type: "option", index: 1 });

      await owner.agent.post(`/api/ai-questions/${questionId}/answer`)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ type: "option", index: 0 })
        .expect(409);
    });

    it("非参与者不能查看或回答提问", async () => {
      const created = approvalService.createQuestion({
        workId,
        conversationId: null,
        requesterUserId: owner.user.userId,
        ownerUserId: owner.user.userId,
        question: "是否继续？",
        options: ["继续", "停止"],
        allowCustomAnswer: false
      });
      const stranger = await register(runtime, "ai-approval-q-stranger");
      await stranger.agent.get(`/api/ai-questions/${String(created.questionId)}`).expect(403);
      await stranger.agent.post(`/api/ai-questions/${String(created.questionId)}/answer`)
        .set("X-CSRF-Token", stranger.csrfToken)
        .send({ type: "option", index: 0 })
        .expect(403);
    });

    it("自定义回答受开关控制", async () => {
      const created = approvalService.createQuestion({
        workId,
        conversationId: null,
        requesterUserId: owner.user.userId,
        ownerUserId: owner.user.userId,
        question: "是否继续？",
        options: ["继续", "停止"],
        allowCustomAnswer: false
      });
      await owner.agent.post(`/api/ai-questions/${String(created.questionId)}/answer`)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ type: "custom", text: "自己决定" })
        .expect(400);
    });
  });
});
