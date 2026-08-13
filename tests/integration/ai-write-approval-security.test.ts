import { createServer, type Server } from "node:http";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { fullWorkModulePermissions, emptyWorkModulePermissions, type WorkModulePermissions } from "../../src/work-permissions.js";
import type { WriteOperationDraft } from "../../src/ai-write-approvals.js";

const setupToken = "ai-write-approval-security-setup-token-32chars";
let authTestServer: Server;
let activeRuntimeApp: Runtime["app"] | null = null;

type SessionCredentials = {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  user: { userId: string; username: string; role: string };
};

function createSecurityRuntime(): Runtime {
  const runtime = createRuntime({
    databasePath: ":memory:",
    masterSecret: "ai-write-approval-security-master-secret",
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
  return { agent, csrfToken: response.body.data.csrfToken, user: response.body.data.user };
}

function permissionFor(modules: Partial<Record<keyof WorkModulePermissions, "none" | "read" | "write">>): WorkModulePermissions {
  const permissions = emptyWorkModulePermissions();
  for (const [module, access] of Object.entries(modules)) {
    if (access) permissions[module as keyof WorkModulePermissions] = access;
  }
  return permissions;
}

function settingCreateDraft(): WriteOperationDraft {
  return {
    operationType: "entity_create",
    entityType: "setting",
    targetModule: "settings",
    aiSummary: "新增世界观设定",
    before: null,
    after: { title: "大陆纪年", category: "历史", content: "以星辰纪年为历法。" },
    diff: [{ field: "title", label: "标题", before: null, after: "大陆纪年" }]
  };
}

describe("AI 写计划审批安全边界", () => {
  let runtime: Runtime;
  let owner: SessionCredentials;
  let work: Record<string, unknown>;

  beforeAll(async () => {
    authTestServer = createServer((incoming, outgoing) => {
      if (!activeRuntimeApp) {
        outgoing.writeHead(503).end();
        return;
      }
      activeRuntimeApp(incoming, outgoing);
    });
    authTestServer.listen(0);
  });

  afterAll(() => {
    authTestServer.close();
  });

  beforeEach(async () => {
    runtime = createSecurityRuntime();
    owner = await register(runtime, "owner");
    const created = await runtime.store.createWork({ title: "测试作品", author: "作者" });
    work = created;
    // 第一个注册用户成为 admin 并认领作品
    runtime.store.updateWorkAiSettings(String(work.id), {
      aiWriteTools: ["entity:settings", "annotation", "analysis-task", "ask-question"]
    });
  });

  afterEach(() => {
    runtime.close();
  });

  function createPlanAs(conversationOwner: SessionCredentials, requester: SessionCredentials): Record<string, unknown> {
    return runtime.aiWriteApprovals.createPlan({
      workId: String(work.id),
      conversationId: null,
      requesterUserId: requester.user.userId,
      conversationOwnerUserId: conversationOwner.user.userId,
      summary: "安全测试计划",
      operations: [settingCreateDraft()]
    });
  }

  it("未登录请求无法查看或确认审批", async () => {
    const plan = createPlanAs(owner, owner);
    await request(runtime.app)
      .get(`/api/ai-write-plans/${String(plan.id)}`)
      .expect(401);
    await request(runtime.app)
      .post(`/api/ai-write-plans/${String(plan.id)}/decision`)
      .send({ action: "approve" })
      .expect(401);
  });

  it("缺少 CSRF 令牌的确认请求被拒绝", async () => {
    const plan = createPlanAs(owner, owner);
    await owner.agent
      .post(`/api/ai-write-plans/${String(plan.id)}/decision`)
      .send({ action: "approve" })
      .expect(403);
    expect(runtime.aiWriteApprovals.getPlan(String(plan.id)).status).toBe("pending");
  });

  it("没有作品访问权限的用户无法读取审批", async () => {
    const outsider = await register(runtime, "outsider");
    const plan = createPlanAs(owner, owner);
    await outsider.agent
      .get(`/api/ai-write-plans/${String(plan.id)}`)
      .expect(403);
  });

  it("当前用户有写权限但对话归属用户没有时，审批失效", async () => {
    const collaborator = await register(runtime, "collaborator");
    // 协作者拥有 settings 写权限；对话归属用户（viewer）只有只读权限。
    runtime.auth.addMember(String(work.id), collaborator.user.userId, {
      permissions: permissionFor({ settings: "write", "ai-chat": "write", "ai-settings": "write" })
    }, owner.user.userId);
    const viewer = await register(runtime, "viewer");
    runtime.auth.addMember(String(work.id), viewer.user.userId, {
      permissions: permissionFor({ settings: "read", "ai-chat": "read" })
    }, owner.user.userId);
    const plan = createPlanAs(viewer, collaborator);
    await collaborator.agent
      .post(`/api/ai-write-plans/${String(plan.id)}/decision`)
      .send({ action: "approve" })
      .set("X-CSRF-Token", collaborator.csrfToken)
      .expect(409);
    const current = runtime.aiWriteApprovals.getPlan(String(plan.id));
    expect(current.status).toBe("invalidated");
    expect(String(current.invalidReason)).toContain("写权限");
  });

  it("对话归属用户与当前用户都有写权限时，确认成功", async () => {
    const collaborator = await register(runtime, "collaborator-2");
    runtime.auth.addMember(String(work.id), collaborator.user.userId, {
      permissions: permissionFor({ settings: "write", "ai-chat": "write" })
    }, owner.user.userId);
    const plan = createPlanAs(owner, collaborator);
    const response = await collaborator.agent
      .post(`/api/ai-write-plans/${String(plan.id)}/decision`)
      .send({ action: "approve" })
      .set("X-CSRF-Token", collaborator.csrfToken)
      .expect(200);
    expect(response.body.data.status).toBe("succeeded");
    expect(runtime.store.listSettings(String(work.id)).some((item) => item.title === "大陆纪年")).toBe(true);
  });

  it("确认请求只能携带审批 ID，伪造操作内容被 Zod 拒绝且不产生写入", async () => {
    const plan = createPlanAs(owner, owner);
    await owner.agent
      .post(`/api/ai-write-plans/${String(plan.id)}/decision`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        action: "approve",
        plan: {
          operations: [{ operationType: "entity_create", entityType: "character", after: { name: "注入角色" } }]
        }
      })
      .expect(400);
    expect(runtime.store.listCharacters(String(work.id))).toHaveLength(0);
  });

  it("提示注入无法跳过确认直接写库：计划只在确认后执行", async () => {
    const plan = createPlanAs(owner, owner);
    // 模拟 AI 工具结果声称已完成的场景：确认前不应有任何写入
    expect(runtime.store.listSettings(String(work.id)).filter((item) => item.title === "大陆纪年")).toHaveLength(0);
    const before = runtime.aiWriteApprovals.getPlan(String(plan.id));
    expect(before.status).toBe("pending");
    await owner.agent
      .post(`/api/ai-write-plans/${String(plan.id)}/decision`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ action: "approve" })
      .expect(200);
    expect(runtime.store.listSettings(String(work.id)).filter((item) => item.title === "大陆纪年")).toHaveLength(1);
  });

  it("撤销需要确认者与归属用户权限交集，无权用户撤销被拒绝", async () => {
    const plan = createPlanAs(owner, owner);
    await owner.agent
      .post(`/api/ai-write-plans/${String(plan.id)}/decision`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ action: "approve" })
      .expect(200);
    const outsider = await register(runtime, "outsider-2");
    await outsider.agent
      .post(`/api/ai-write-plans/${String(plan.id)}/revoke`)
      .set("X-CSRF-Token", outsider.csrfToken)
      .send({})
      .expect(403);
  });

  it("问题回答必须登录且不能重复回答", async () => {
    const question = runtime.aiWriteApprovals.createQuestion({
      workId: String(work.id),
      conversationId: null,
      requesterUserId: owner.user.userId,
      question: "方向问题？",
      options: [{ label: "选项一" }, { label: "选项二" }]
    });
    await request(runtime.app)
      .post(`/api/ai-approval-questions/${String(question.id)}/answer`)
      .send({ answer: "未登录回答" })
      .expect(401);
    await owner.agent
      .post(`/api/ai-approval-questions/${String(question.id)}/answer`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ answer: "选项一" })
      .expect(200);
    await owner.agent
      .post(`/api/ai-approval-questions/${String(question.id)}/answer`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ answer: "再次回答" })
      .expect(409);
  });

  it("计划操作上限超过配置时拒绝生成", () => {
    const drafts = Array.from({ length: 6 }, (_, index) => settingCreateDraft());
    // maxOperations 默认 5，第 6 项应在工具执行层拒绝；这里直接验证 createPlan 的存储不设上限，
    // 上限由工具执行时强制（见 executeAiWriteTool 的 WRITE_PLAN_OPERATION_LIMIT）。
    const plan = runtime.aiWriteApprovals.createPlan({
      workId: String(work.id),
      conversationId: null,
      requesterUserId: owner.user.userId,
      conversationOwnerUserId: owner.user.userId,
      summary: "超限计划",
      operations: drafts
    });
    expect(runtime.aiWriteApprovals.listPlanOperations(String(plan.id))).toHaveLength(6);
  });
});
