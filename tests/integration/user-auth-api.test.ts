import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

type SessionCredentials = {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  user: { userId: string; username: string; displayName: string; role: "admin" | "user" };
};

async function solveCaptcha(app: Runtime["app"]): Promise<{ captchaId: string; captchaAnswer: string }> {
  const response = await request(app).get("/api/auth/captcha").expect(200);
  expect(response.body.data.captchaId).toBeTruthy();
  expect(response.body.data.answer).toBeTruthy();
  return { captchaId: response.body.data.captchaId, captchaAnswer: response.body.data.answer };
}

async function register(runtime: Runtime, username: string, displayName: string): Promise<SessionCredentials> {
  const agent = request.agent(runtime.app);
  const captcha = await solveCaptcha(runtime.app);
  const response = await agent.post("/api/auth/register").send({
    username,
    displayName,
    password: "secure-password-123",
    ...captcha
  }).expect(201);
  return { agent, csrfToken: response.body.data.csrfToken, user: response.body.data.user };
}

describe("用户、作品权限与操作者追踪 API", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "user-auth-test-master-secret-with-enough-length",
      serveUi: false,
      revealCaptchaAnswer: true
    });
  });
  afterEach(() => runtime.close());

  it("首个用户成为管理员，并完成作品邀请、共同编辑与越权拦截", async () => {
    await request(runtime.app).get("/api/works").expect(401);
    const initialSession = await request(runtime.app).get("/api/auth/session").expect(200);
    expect(initialSession.body.data).toMatchObject({ authenticated: false, setupRequired: true });

    const admin = await register(runtime, "admin", "总编");
    const writer = await register(runtime, "writer", "协作者");
    expect(admin.user.role).toBe("admin");
    expect(writer.user.role).toBe("user");

    const adminWork = await admin.agent.post("/api/works").set("X-CSRF-Token", admin.csrfToken).send({ title: "管理员作品" }).expect(201);
    const writerWork = await writer.agent.post("/api/works").set("X-CSRF-Token", writer.csrfToken).send({ title: "作者作品" }).expect(201);
    const adminWorkId = adminWork.body.data.id;
    const writerWorkId = writerWork.body.data.id;

    const privateWorks = await writer.agent.get("/api/works").expect(200);
    expect(privateWorks.body.data.map((work: { id: string }) => work.id)).toEqual([writerWorkId]);
    await writer.agent.get(`/api/works/${adminWorkId}`).expect(403);

    await admin.agent.post(`/api/works/${adminWorkId}/members`).set("X-CSRF-Token", admin.csrfToken).send({ userId: writer.user.userId }).expect(201);
    const sharedWorks = await writer.agent.get("/api/works").expect(200);
    expect(new Set(sharedWorks.body.data.map((work: { id: string }) => work.id))).toEqual(new Set([adminWorkId, writerWorkId]));

    const volume = await admin.agent.post(`/api/works/${adminWorkId}/volumes`).set("X-CSRF-Token", admin.csrfToken).send({ title: "正文" }).expect(201);
    const chapter = await admin.agent.post(`/api/works/${adminWorkId}/chapters`).set("X-CSRF-Token", admin.csrfToken).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "初稿。"
    }).expect(201);
    await writer.agent.patch(`/api/chapters/${chapter.body.data.id}`).set("X-CSRF-Token", writer.csrfToken).send({ content: "协作修改。" }).expect(200);

    const versions = await writer.agent.get(`/api/chapters/${chapter.body.data.id}/versions`).expect(200);
    expect(versions.body.data[0]).toMatchObject({ versionNo: 2, actor: "协作者" });
    const auditLogs = await admin.agent.get(`/api/works/${adminWorkId}/audit-logs`).expect(200);
    expect(auditLogs.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "chapter.saved", actor: "协作者", userId: writer.user.userId })
    ]));

    await writer.agent.delete(`/api/works/${adminWorkId}`).set("X-CSRF-Token", writer.csrfToken).expect(403);
    await writer.agent.get("/api/platform/ai/providers").expect(403);
    await writer.agent.patch(`/api/chapters/${chapter.body.data.id}`).send({ content: "缺少 CSRF。" }).expect(403);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("首位管理员注册时自动接管迁移前的现有作品", async () => {
    const legacyWork = runtime.store.createWork({ title: "既有作品" });
    const admin = await register(runtime, "first_admin", "首位管理员");
    const works = await admin.agent.get("/api/works").expect(200);
    expect(works.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: legacyWork.id, accessRole: "owner" })]));
    expect(runtime.database.get("SELECT owner_user_id FROM works WHERE id = ?", String(legacyWork.id))?.owner_user_id).toBe(admin.user.userId);
    expect(runtime.database.get("SELECT role FROM work_memberships WHERE work_id = ? AND user_id = ?", String(legacyWork.id), admin.user.userId)?.role).toBe("owner");
  });

  it("管理员可管理账户，但不能停用自己或移除最后一名管理员", async () => {
    const admin = await register(runtime, "root_admin", "管理员");
    const writer = await register(runtime, "normal_writer", "普通用户");
    await admin.agent.patch(`/api/users/${admin.user.userId}`).set("X-CSRF-Token", admin.csrfToken).send({ role: "user" }).expect(409);
    const promoted = await admin.agent.patch(`/api/users/${writer.user.userId}`).set("X-CSRF-Token", admin.csrfToken).send({ role: "admin" }).expect(200);
    expect(promoted.body.data.role).toBe("admin");
    const disabled = await admin.agent.patch(`/api/users/${writer.user.userId}`).set("X-CSRF-Token", admin.csrfToken).send({ status: "disabled" }).expect(200);
    expect(disabled.body.data.status).toBe("disabled");
    await writer.agent.get("/api/works").expect(401);
  });

  it("用户可修改自己的显示名称和密码", async () => {
    const user = await register(runtime, "profile_user", "旧名称");
    const profile = await user.agent.patch("/api/auth/profile").set("X-CSRF-Token", user.csrfToken).send({ displayName: "新名称" }).expect(200);
    expect(profile.body.data.displayName).toBe("新名称");
    await user.agent.patch("/api/auth/password").set("X-CSRF-Token", user.csrfToken).send({
      currentPassword: "secure-password-123",
      newPassword: "new-secure-password-456"
    }).expect(204);
    const staleLogin = await solveCaptcha(runtime.app);
    await request(runtime.app).post("/api/auth/login").send({
      username: "profile_user",
      password: "secure-password-123",
      ...staleLogin
    }).expect(401);
    const loginCaptcha = await solveCaptcha(runtime.app);
    await request(runtime.app).post("/api/auth/login").send({
      username: "profile_user",
      password: "new-secure-password-456",
      ...loginCaptcha
    }).expect(200);
  });

  it("可通过 APP_ALLOW_REGISTRATION=false 关闭开放注册", async () => {
    runtime.close();
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "user-auth-test-master-secret-with-enough-length",
      serveUi: false,
      revealCaptchaAnswer: true,
      security: { allowRegistration: false, enforceSameOrigin: true }
    });
    const openSession = await request(runtime.app).get("/api/auth/session").expect(200);
    expect(openSession.body.data).toMatchObject({ setupRequired: true, registrationOpen: true });
    await register(runtime, "only_admin", "唯一管理员");
    const closedSession = await request(runtime.app).get("/api/auth/session").expect(200);
    expect(closedSession.body.data.registrationOpen).toBe(false);
    const captcha = await solveCaptcha(runtime.app);
    const rejected = await request(runtime.app).post("/api/auth/register").send({
      username: "blocked_user",
      displayName: "被拦截",
      password: "secure-password-123",
      ...captcha
    }).expect(403);
    expect(rejected.body.error.code).toBe("REGISTRATION_DISABLED");
  });

  it("登录与注册必须通过图片验证码", async () => {
    await request(runtime.app).post("/api/auth/register").send({
      username: "captcha_user",
      displayName: "验证码用户",
      password: "secure-password-123"
    }).expect(400);
    const wrong = await solveCaptcha(runtime.app);
    await request(runtime.app).post("/api/auth/register").send({
      username: "captcha_user",
      displayName: "验证码用户",
      password: "secure-password-123",
      captchaId: wrong.captchaId,
      captchaAnswer: "XXXX"
    }).expect(400);
    const user = await register(runtime, "captcha_user", "验证码用户");
    await user.agent.post("/api/auth/login").send({
      username: "captcha_user",
      password: "secure-password-123",
      captchaId: "missing",
      captchaAnswer: "ABCD"
    }).expect(400);
  });
});
