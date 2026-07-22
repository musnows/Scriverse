import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

type SessionCredentials = {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  user: { userId: string; username: string; displayName: string; role: "admin" | "user" };
};

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2z94AAAAASUVORK5CYII=",
  "base64"
);

async function solveCaptcha(app: Runtime["app"]): Promise<{ captchaId: string; captchaAnswer: string }> {
  const response = await request(app).get("/api/auth/captcha").expect(200);
  expect(response.body.data.captchaId).toBeTruthy();
  expect(response.body.data.answer).toBeTruthy();
  return { captchaId: response.body.data.captchaId, captchaAnswer: response.body.data.answer };
}

async function register(runtime: Runtime, username: string): Promise<SessionCredentials> {
  const agent = request.agent(runtime.app);
  const captcha = await solveCaptcha(runtime.app);
  const response = await agent.post("/api/auth/register").send({
    username,
    password: "secure-password-123",
    passwordConfirmation: "secure-password-123",
    ...captcha
  }).expect(201);
  expect(response.body.data.user.displayName).toBe(username);
  return { agent, csrfToken: response.body.data.csrfToken, user: response.body.data.user };
}

describe("用户、作品权限与操作者追踪 API", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "user-auth-test-master-secret-with-enough-length",
      serveUi: false,
      revealCaptchaAnswer: true,
      security: { allowRegistration: true, enforceSameOrigin: true }
    });
  });
  afterEach(() => runtime.close());

  it("首个用户成为管理员，并完成作品邀请、共同编辑与越权拦截", async () => {
    await request(runtime.app).get("/api/works").expect(401);
    const initialSession = await request(runtime.app).get("/api/auth/session").expect(200);
    expect(initialSession.body.data).toMatchObject({ authenticated: false, setupRequired: true, registrationOpen: true });

    const admin = await register(runtime, "admin");
    const writer = await register(runtime, "writer");
    expect(admin.user.role).toBe("admin");
    expect(writer.user.role).toBe("user");

    const adminWork = await admin.agent.post("/api/works").set("X-CSRF-Token", admin.csrfToken).send({ title: "管理员作品" }).expect(201);
    const writerWork = await writer.agent.post("/api/works").set("X-CSRF-Token", writer.csrfToken).send({ title: "作者作品" }).expect(201);
    const adminWorkId = adminWork.body.data.id;
    const writerWorkId = writerWork.body.data.id;

    const privateWorks = await writer.agent.get("/api/works").expect(200);
    expect(privateWorks.body.data.map((work: { id: string }) => work.id)).toEqual([writerWorkId]);
    await writer.agent.get(`/api/works/${adminWorkId}`).expect(403);

    await admin.agent.post(`/api/works/${adminWorkId}/members`).set("X-CSRF-Token", admin.csrfToken).send({ userId: writer.user.userId, role: "editor" }).expect(201);
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
    expect(versions.body.data[0]).toMatchObject({ versionNo: 2, actor: "writer" });
    const auditLogs = await admin.agent.get(`/api/works/${adminWorkId}/audit-logs`).expect(200);
    expect(auditLogs.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "chapter.saved", actor: "writer", userId: writer.user.userId })
    ]));

    await writer.agent.delete(`/api/works/${adminWorkId}`).set("X-CSRF-Token", writer.csrfToken).expect(403);
    await writer.agent.get("/api/platform/ai/providers").expect(403);
    await writer.agent.patch(`/api/chapters/${chapter.body.data.id}`).send({ content: "缺少 CSRF。" }).expect(403);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("按用户在数据库中记录新手引导完成状态", async () => {
    const firstUser = await register(runtime, "onboarding_first");
    const secondUser = await register(runtime, "onboarding_second");
    expect(firstUser.user).toMatchObject({ onboardingCompleted: false });
    expect(secondUser.user).toMatchObject({ onboardingCompleted: false });

    await firstUser.agent.post("/api/auth/onboarding/complete").send({}).expect(403);
    const completed = await firstUser.agent
      .post("/api/auth/onboarding/complete")
      .set("X-CSRF-Token", firstUser.csrfToken)
      .send({})
      .expect(200);
    expect(completed.body.data).toMatchObject({ userId: firstUser.user.userId, onboardingCompleted: true });
    expect(runtime.database.get(
      "SELECT onboarding_completed_at IS NOT NULL AS completed FROM users WHERE id = ?",
      firstUser.user.userId
    )).toEqual({ completed: 1 });

    const session = await firstUser.agent.get("/api/auth/session").expect(200);
    expect(session.body.data.user.onboardingCompleted).toBe(true);
    const otherSession = await secondUser.agent.get("/api/auth/session").expect(200);
    expect(otherSession.body.data.user.onboardingCompleted).toBe(false);
  });

  it("仅查看成员可读取正文和设定，但所有作品写操作都会被拒绝", async () => {
    const owner = await register(runtime, "viewer_owner");
    const viewer = await register(runtime, "readonly_guest");
    const workResponse = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "只读测试作品" })
      .expect(201);
    const workId = String(workResponse.body.data.id);
    const volume = await owner.agent.post(`/api/works/${workId}/volumes`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "正文" })
      .expect(201);
    const chapter = await owner.agent.post(`/api/works/${workId}/chapters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ volumeId: volume.body.data.id, title: "第一章", content: "只能阅读的正文。" })
      .expect(201);
    const setting = await owner.agent.post(`/api/works/${workId}/settings`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "潮汐规则", category: "世界规则", content: "月升时开启航道。" })
      .expect(201);
    const firstCharacter = await owner.agent.post(`/api/works/${workId}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "林舟" })
      .expect(201);
    const secondCharacter = await owner.agent.post(`/api/works/${workId}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "林船长" })
      .expect(201);

    const invited = await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: viewer.user.userId, role: "viewer" })
      .expect(201);
    expect(invited.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: viewer.user.userId, role: "viewer" })
    ]));

    const works = await viewer.agent.get("/api/works").expect(200);
    expect(works.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: workId, accessRole: "viewer" })
    ]));
    const workTree = await viewer.agent.get(`/api/works/${workId}`).expect(200);
    expect(workTree.body.data.volumes[0].chapters[0]).toMatchObject({ id: chapter.body.data.id, title: "第一章" });
    const visibleChapter = await viewer.agent.get(`/api/chapters/${chapter.body.data.id}`).expect(200);
    expect(visibleChapter.body.data.content).toBe("只能阅读的正文。");
    const settings = await viewer.agent.get(`/api/works/${workId}/settings`).expect(200);
    expect(settings.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: setting.body.data.id, content: "月升时开启航道。" })
    ]));

    const chapterWrite = await viewer.agent.patch(`/api/chapters/${chapter.body.data.id}`)
      .set("X-CSRF-Token", viewer.csrfToken)
      .send({ content: "越权修改。" })
      .expect(403);
    expect(chapterWrite.body.error.code).toBe("WORK_EDIT_DENIED");
    await viewer.agent.post(`/api/works/${workId}/settings`)
      .set("X-CSRF-Token", viewer.csrfToken)
      .send({ title: "越权设定", category: "世界规则", content: "不应创建。" })
      .expect(403);
    const mergeBody = {
      targetCharacterId: firstCharacter.body.data.id,
      expectedTargetVersionNo: firstCharacter.body.data.versionNo,
      expectedSourceVersionNo: secondCharacter.body.data.versionNo
    };
    await viewer.agent.post(`/api/characters/${secondCharacter.body.data.id}/merge`)
      .set("X-CSRF-Token", viewer.csrfToken)
      .send(mergeBody)
      .expect(403);
    await owner.agent.post(`/api/characters/${secondCharacter.body.data.id}/merge`)
      .send(mergeBody)
      .expect(403);
    await viewer.agent.patch(`/api/works/${workId}/members/${viewer.user.userId}`)
      .set("X-CSRF-Token", viewer.csrfToken)
      .send({ role: "editor" })
      .expect(403);
    expect(runtime.database.get("SELECT content FROM chapters WHERE id = ?", chapter.body.data.id)?.content).toBe("只能阅读的正文。");

    const promoted = await owner.agent.patch(`/api/works/${workId}/members/${viewer.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ role: "editor" })
      .expect(200);
    expect(promoted.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: viewer.user.userId, role: "editor" })
    ]));
    await viewer.agent.patch(`/api/chapters/${chapter.body.data.id}`)
      .set("X-CSRF-Token", viewer.csrfToken)
      .send({ content: "获得编辑权限后的修改。" })
      .expect(200);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("设定编辑可维护设定集，但不能修改分卷、正文和作品配置", async () => {
    const owner = await register(runtime, "settings_owner");
    const collaborator = await register(runtime, "settings_editor");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "设定协作测试" })
      .expect(201);
    const workId = String(work.body.data.id);
    const volume = await owner.agent.post(`/api/works/${workId}/volumes`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "正文" })
      .expect(201);
    const chapter = await owner.agent.post(`/api/works/${workId}/chapters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ volumeId: volume.body.data.id, title: "第一章", content: "原始正文。" })
      .expect(201);

    const invited = await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: collaborator.user.userId, role: "settings-editor" })
      .expect(201);
    expect(invited.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: collaborator.user.userId, role: "settings-editor" })
    ]));
    const storedMembership = runtime.database.get(
      "SELECT role, permissions_json FROM work_memberships WHERE work_id = ? AND user_id = ?",
      workId,
      collaborator.user.userId
    );
    expect(storedMembership?.role).toBe("editor");
    expect(JSON.parse(String(storedMembership?.permissions_json))).toMatchObject({
      modules: { prose: "read", settings: "write", characters: "write", ai: "read" }
    });

    const works = await collaborator.agent.get("/api/works").expect(200);
    expect(works.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: workId, accessRole: "settings-editor" })
    ]));
    const setting = await collaborator.agent.post(`/api/works/${workId}/settings`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ title: "潮汐规则", category: "世界规则", content: "月升时航道开启。" })
      .expect(201);
    await collaborator.agent.patch(`/api/settings/${setting.body.data.id}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ content: "双月同时升起时航道开启。", changeNote: "修正开启条件" })
      .expect(200);
    await collaborator.agent.put(`/api/chapters/${chapter.body.data.id}/outline`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ goal: "确认航道规则", conflict: "双月并未同时升起", status: "ready" })
      .expect(200);

    const chapterWrite = await collaborator.agent.patch(`/api/chapters/${chapter.body.data.id}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ content: "不应写入的正文。" })
      .expect(403);
    expect(chapterWrite.body.error.code).toBe("WORK_PROSE_EDIT_DENIED");
    const volumeWrite = await collaborator.agent.patch(`/api/volumes/${volume.body.data.id}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ title: "不应修改的分卷" })
      .expect(403);
    expect(volumeWrite.body.error.code).toBe("WORK_PROSE_EDIT_DENIED");
    const taskWrite = await collaborator.agent.post(`/api/works/${workId}/tasks`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ taskType: "book-analysis" })
      .expect(403);
    expect(taskWrite.body.error.code).toBe("WORK_PROSE_EDIT_DENIED");
    await collaborator.agent.patch(`/api/works/${workId}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ title: "不应修改的作品名" })
      .expect(403);
    expect(runtime.database.get("SELECT content FROM chapters WHERE id = ?", chapter.body.data.id)?.content).toBe("原始正文。");

    const promoted = await owner.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ role: "editor" })
      .expect(200);
    expect(promoted.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: collaborator.user.userId, role: "editor" })
    ]));
    expect(JSON.parse(String(runtime.database.get(
      "SELECT permissions_json FROM work_memberships WHERE work_id = ? AND user_id = ?",
      workId,
      collaborator.user.userId
    )?.permissions_json))).toMatchObject({ modules: { prose: "write", settings: "write", ai: "write" } });
    await collaborator.agent.patch(`/api/chapters/${chapter.body.data.id}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ content: "完整协作权限可以修改正文。" })
      .expect(200);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("管理员可按成员配置模块读写权限，并在 API 层拒绝跨模块访问", async () => {
    const owner = await register(runtime, "module_owner");
    const collaborator = await register(runtime, "module_collaborator");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "模块权限测试" })
      .expect(201);
    const workId = String(work.body.data.id);
    const volume = await owner.agent.post(`/api/works/${workId}/volumes`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "正文" })
      .expect(201);
    const chapter = await owner.agent.post(`/api/works/${workId}/chapters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ volumeId: volume.body.data.id, title: "第一章", content: "模块权限正文。" })
      .expect(201);
    const fileVersionId = "file_module_permission_history";
    runtime.database.run(
      `INSERT INTO file_versions (id, work_id, file_name, file_type, word_count, paragraph_count, warnings_json, snapshot_json, created_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      fileVersionId,
      workId,
      "module-permission.txt",
      "txt",
      0,
      0,
      "[]",
      JSON.stringify(runtime.store.getWorkTree(workId)),
      new Date().toISOString(),
      owner.user.userId
    );
    const ownerFileVersions = await owner.agent.get(`/api/works/${workId}/file-versions`).expect(200);
    expect(ownerFileVersions.body.data[0].id).toBe(fileVersionId);

    const permissions = {
      prose: "read",
      settings: "write",
      characters: "none",
      races: "none",
      organizations: "none",
      timeline: "read",
      relationships: "none",
      outlines: "read",
      reviews: "none",
      ai: "none",
      "ai-settings": "none"
    };
    const invited = await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: collaborator.user.userId, permissions })
      .expect(201);
    expect(invited.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: collaborator.user.userId, role: "custom", permissions })
    ]));

    const listedWorks = await collaborator.agent.get("/api/works").expect(200);
    expect(listedWorks.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: workId, accessRole: "custom", modulePermissions: permissions })
    ]));
    const workTree = await collaborator.agent.get(`/api/works/${workId}`).expect(200);
    expect(workTree.body.data.volumes[0].chapters[0].title).toBe("第一章");
    await collaborator.agent.get(`/api/chapters/${chapter.body.data.id}`).expect(200);
    const proseWriteDenied = await collaborator.agent.patch(`/api/chapters/${chapter.body.data.id}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ content: "不应写入。" })
      .expect(403);
    expect(proseWriteDenied.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");
    const proseImportDenied = await collaborator.agent.post(`/api/works/${workId}/import`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .attach("file", Buffer.from("第一章\n\n不应导入。"), "readonly.txt")
      .expect(403);
    expect(proseImportDenied.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");
    const readableFileVersions = await collaborator.agent.get(`/api/works/${workId}/file-versions`).expect(200);
    expect(readableFileVersions.body.data[0].id).toBe(fileVersionId);
    const restoreDenied = await collaborator.agent
      .post(`/api/works/${workId}/file-versions/${fileVersionId}/restore`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({})
      .expect(403);
    expect(restoreDenied.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");

    await collaborator.agent.post(`/api/works/${workId}/settings`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ title: "可编辑设定", category: "世界规则", content: "允许写入。" })
      .expect(201);
    const characterReadDenied = await collaborator.agent.get(`/api/works/${workId}/characters`).expect(403);
    expect(characterReadDenied.body.error).toMatchObject({ code: "WORK_MODULE_READ_DENIED" });
    await collaborator.agent.get(`/api/works/${workId}/timeline`).expect(200);
    await collaborator.agent.post(`/api/works/${workId}/timeline`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ name: "越权事件", timeLabel: "未知", timeSort: null })
      .expect(403);

    const updatedPermissions = { ...permissions, prose: "write", settings: "read" };
    const updated = await owner.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ permissions: updatedPermissions })
      .expect(200);
    expect(updated.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: collaborator.user.userId, permissions: updatedPermissions })
    ]));
    await collaborator.agent.patch(`/api/chapters/${chapter.body.data.id}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ content: "已授权正文编辑。" })
      .expect(200);
    await collaborator.agent.post(`/api/works/${workId}/settings`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ title: "只读后越权", category: "世界规则", content: "不应写入。" })
      .expect(403);

    await collaborator.agent
      .post(`/api/works/${workId}/file-versions/${fileVersionId}/restore`)
      .send({})
      .expect(403);
    const currentWork = await collaborator.agent.get(`/api/works/${workId}`).expect(200);
    const versionCountBeforeConflict = Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM file_versions WHERE work_id = ?",
      workId
    )?.count);
    const conflict = await collaborator.agent
      .post(`/api/works/${workId}/file-versions/${fileVersionId}/restore`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ expectedVersionNo: Number(currentWork.body.data.versionNo) + 1 })
      .expect(409);
    expect(conflict.body.error.code).toBe("VERSION_CONFLICT");
    expect(Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM file_versions WHERE work_id = ?",
      workId
    )?.count)).toBe(versionCountBeforeConflict);
    const restored = await collaborator.agent
      .post(`/api/works/${workId}/file-versions/${fileVersionId}/restore`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ expectedVersionNo: currentWork.body.data.versionNo })
      .expect(200);
    expect(restored.body.data.restoredFrom).toBe(fileVersionId);

    await owner.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ permissions: { ...updatedPermissions, prose: "invalid" } })
      .expect(400);
    await collaborator.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ permissions: updatedPermissions })
      .expect(403);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("模块权限默认拒绝未知路由，并裁剪跨模块数据与关联写入", async () => {
    const owner = await register(runtime, "boundary_owner");
    const collaborator = await register(runtime, "boundary_collaborator");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "权限边界作品" })
      .expect(201);
    const workId = String(work.body.data.id);
    const character = await owner.agent.post(`/api/works/${workId}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "边界角色" })
      .expect(201);
    const characterId = String(character.body.data.id);
    const race = await owner.agent.post(`/api/works/${workId}/races`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "边界种族", settings: ["不可跨模块泄露"], memberIds: [characterId] })
      .expect(201);
    const raceId = String(race.body.data.id);
    const organization = await owner.agent.post(`/api/works/${workId}/organizations`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "边界组织", memberIds: [characterId] })
      .expect(201);
    const organizationId = String(organization.body.data.id);
    const permissions = {
      prose: "none",
      settings: "none",
      characters: "none",
      races: "write",
      organizations: "write",
      timeline: "none",
      relationships: "none",
      outlines: "none",
      reviews: "read",
      ai: "read",
      "ai-settings": "none"
    };
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: collaborator.user.userId, permissions })
      .expect(201);

    await collaborator.agent.get(`/api/works/${workId}/audit-logs`).expect(403);
    await collaborator.agent.get(`/api/works/${workId}/unclassified-route`).expect(403);
    await collaborator.agent.get(`/api/works/${workId}/file-versions`).expect(403);
    await collaborator.agent
      .post(`/api/works/${workId}/file-versions/file_missing/restore`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({})
      .expect(403);
    const hiddenProseImport = await collaborator.agent.post(`/api/works/${workId}/import`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .attach("file", Buffer.from("第一章\n\n不应导入。"), "hidden-prose.txt")
      .expect(403);
    expect(hiddenProseImport.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");
    await collaborator.agent.get(`/api/works/${workId}/reviews`).expect(200);
    await collaborator.agent.get(`/api/works/${workId}/ai-calls`).expect(200);
    await collaborator.agent.get(`/api/works/${workId}/models`).expect(200);

    const visibleRaces = await collaborator.agent.get(`/api/works/${workId}/races`).expect(200);
    expect(visibleRaces.body.data[0]).toMatchObject({ id: raceId, memberIds: [], members: [] });
    const raceVersions = await collaborator.agent.get(`/api/entity-versions/race/${raceId}`).expect(200);
    expect(raceVersions.body.data[0].snapshot).toMatchObject({ memberIds: [] });
    const visibleOrganizations = await collaborator.agent.get(`/api/works/${workId}/organizations`).expect(200);
    expect(visibleOrganizations.body.data[0]).toMatchObject({ id: organizationId, memberIds: [], members: [] });

    await collaborator.agent.patch(`/api/races/${raceId}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ description: "仅修改种族自身字段。" })
      .expect(200);
    const raceMemberWrite = await collaborator.agent.patch(`/api/races/${raceId}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ memberIds: [] })
      .expect(403);
    expect(raceMemberWrite.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");
    await collaborator.agent.patch(`/api/races/${raceId}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ name: "越权更名" })
      .expect(403);
    await collaborator.agent.delete(`/api/races/${raceId}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({})
      .expect(403);
    await collaborator.agent.patch(`/api/organizations/${organizationId}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ description: "仅修改组织自身字段。" })
      .expect(200);
    await collaborator.agent.patch(`/api/organizations/${organizationId}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ memberIds: [] })
      .expect(403);

    const characterOnly = { ...permissions, characters: "read", races: "none", organizations: "none" };
    await owner.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ permissions: characterOnly })
      .expect(200);
    const visibleCharacters = await collaborator.agent.get(`/api/works/${workId}/characters`).expect(200);
    expect(visibleCharacters.body.data[0]).toMatchObject({
      id: characterId,
      raceId: null,
      race: null,
      species: "",
      organizationIds: [],
      organizations: []
    });
    expect(JSON.stringify(visibleCharacters.body.data)).not.toContain("不可跨模块泄露");
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("成员变更保护作品创建者，并在审计失败时回滚", async () => {
    const owner = await register(runtime, "member_owner");
    const collaborator = await register(runtime, "member_transaction_target");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "成员事务作品" })
      .expect(201);
    const workId = String(work.body.data.id);

    const overwriteOwner = await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: owner.user.userId, role: "viewer" })
      .expect(409);
    expect(overwriteOwner.body.error.code).toBe("OWNER_REQUIRED");
    expect(runtime.database.get(
      "SELECT role FROM work_memberships WHERE work_id = ? AND user_id = ?",
      workId,
      owner.user.userId
    )).toEqual({ role: "owner" });

    runtime.database.raw.exec(`
      CREATE TRIGGER reject_member_audit BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'work.member-added'
      BEGIN
        SELECT RAISE(ABORT, 'forced member audit failure');
      END
    `);
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: collaborator.user.userId, role: "viewer" })
      .expect(500);
    expect(runtime.database.get(
      "SELECT role FROM work_memberships WHERE work_id = ? AND user_id = ?",
      workId,
      collaborator.user.userId
    )).toBeUndefined();
    runtime.database.raw.exec("DROP TRIGGER reject_member_audit");

    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: collaborator.user.userId, role: "viewer" })
      .expect(201);
    expect(runtime.database.get(
      "SELECT action FROM audit_logs WHERE work_id = ? AND action = 'work.member-added'",
      workId
    )).toEqual({ action: "work.member-added" });
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("首位管理员注册时自动接管迁移前的现有作品", async () => {
    const legacyWork = runtime.store.createWork({ title: "既有作品" });
    const admin = await register(runtime, "first_admin");
    const works = await admin.agent.get("/api/works").expect(200);
    expect(works.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: legacyWork.id, accessRole: "owner" })]));
    expect(runtime.database.get("SELECT owner_user_id FROM works WHERE id = ?", String(legacyWork.id))?.owner_user_id).toBe(admin.user.userId);
    expect(runtime.database.get("SELECT role FROM work_memberships WHERE work_id = ? AND user_id = ?", String(legacyWork.id), admin.user.userId)?.role).toBe("owner");
  });

  it("管理员可管理账户，但不能停用自己或移除最后一名管理员", async () => {
    const admin = await register(runtime, "root_admin");
    const writer = await register(runtime, "normal_writer");
    await admin.agent.patch(`/api/users/${admin.user.userId}`).set("X-CSRF-Token", admin.csrfToken).send({ role: "user" }).expect(409);
    const promoted = await admin.agent.patch(`/api/users/${writer.user.userId}`).set("X-CSRF-Token", admin.csrfToken).send({ role: "admin" }).expect(200);
    expect(promoted.body.data.role).toBe("admin");
    const disabled = await admin.agent.patch(`/api/users/${writer.user.userId}`).set("X-CSRF-Token", admin.csrfToken).send({ status: "disabled" }).expect(200);
    expect(disabled.body.data.status).toBe("disabled");
    await writer.agent.get("/api/works").expect(401);
  });

  it("管理员可统一设置 Toast 位置，普通用户只能读取", async () => {
    const admin = await register(runtime, "ui_admin");
    const writer = await register(runtime, "ui_writer");

    const defaults = await writer.agent.get("/api/ui-settings").expect(200);
    expect(defaults.body.data).toMatchObject({ toastPosition: "bottom-right" });
    await writer.agent.get("/api/platform/ui-settings").expect(403);
    await writer.agent.patch("/api/platform/ui-settings")
      .set("X-CSRF-Token", writer.csrfToken)
      .send({ toastPosition: "top-right" })
      .expect(403);
    await admin.agent.patch("/api/platform/ui-settings").send({ toastPosition: "top-right" }).expect(403);
    await admin.agent.patch("/api/platform/ui-settings")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({ toastPosition: "top-left" })
      .expect(400);
    await admin.agent.patch("/api/platform/ui-settings")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({ toastPosition: "top-right", unknown: true })
      .expect(400);

    const updated = await admin.agent.patch("/api/platform/ui-settings")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({ toastPosition: "top-right" })
      .expect(200);
    expect(updated.body.data).toMatchObject({ toastPosition: "top-right" });
    const visibleToWriter = await writer.agent.get("/api/ui-settings").expect(200);
    expect(visibleToWriter.body.data).toMatchObject({ toastPosition: "top-right" });
    expect(runtime.database.get(
      "SELECT action, user_id FROM audit_logs WHERE action = 'platform.ui-settings.updated'"
    )).toEqual({ action: "platform.ui-settings.updated", user_id: admin.user.userId });
  });

  it("用户可修改自己的显示名称和密码", async () => {
    const user = await register(runtime, "profile_user");
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

  it("用户可安全上传、读取、替换和移除自己的头像", async () => {
    const user = await register(runtime, "avatar_user");
    const viewer = await register(runtime, "avatar_viewer");
    expect(user.user).toMatchObject({ avatarUrl: null });

    await request(runtime.app).put("/api/auth/avatar").attach("file", onePixelPng, "avatar.png").expect(401);
    await user.agent.put("/api/auth/avatar").attach("file", onePixelPng, "avatar.png").expect(403);
    const invalid = await user.agent.put("/api/auth/avatar")
      .set("X-CSRF-Token", user.csrfToken)
      .attach("file", Buffer.from("not an image"), "avatar.png")
      .expect(415);
    expect(invalid.body.error.code).toBe("INVALID_AVATAR");

    const uploaded = await user.agent.put("/api/auth/avatar")
      .set("X-CSRF-Token", user.csrfToken)
      .attach("file", onePixelPng, "avatar.png")
      .expect(200);
    expect(uploaded.body.data.avatarUrl).toMatch(new RegExp(`^/api/user-avatars/${user.user.userId}\\?v=`, "u"));
    const avatarUrl = String(uploaded.body.data.avatarUrl);
    const avatar = await viewer.agent.get(avatarUrl).expect(200);
    expect(avatar.headers["content-type"]).toBe("image/png");
    expect(avatar.headers["content-length"]).toBe(String(onePixelPng.byteLength));
    expect(avatar.headers.etag).toMatch(/^"[a-f0-9]{64}"$/u);
    expect(avatar.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(Buffer.from(avatar.body)).toEqual(onePixelPng);
    expect(runtime.database.get("SELECT mime_type, width, height FROM user_avatars WHERE user_id = ?", user.user.userId)).toEqual({
      mime_type: "image/png",
      width: 1,
      height: 1
    });

    const session = await user.agent.get("/api/auth/session").expect(200);
    expect(session.body.data.user.avatarUrl).toBe(avatarUrl);
    const directory = await viewer.agent.get("/api/users/directory?q=avatar_user").expect(200);
    expect(directory.body.data[0]).toMatchObject({ userId: user.user.userId, avatarUrl });
    expect(runtime.database.get("SELECT action FROM audit_logs WHERE entity_id = ? AND action = 'user.avatar-updated'", user.user.userId)).toEqual({
      action: "user.avatar-updated"
    });

    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 0);
    await user.agent.put("/api/auth/avatar")
      .set("X-CSRF-Token", user.csrfToken)
      .attach("file", oversized, "too-large.png")
      .expect(400);
    expect(runtime.database.get("SELECT byte_length FROM user_avatars WHERE user_id = ?", user.user.userId)?.byte_length).toBe(onePixelPng.byteLength);

    const removed = await user.agent.delete("/api/auth/avatar").set("X-CSRF-Token", user.csrfToken).expect(200);
    expect(removed.body.data.avatarUrl).toBeNull();
    await viewer.agent.get(avatarUrl).expect(404);
    expect(runtime.database.get("SELECT * FROM user_avatars WHERE user_id = ?", user.user.userId)).toBeUndefined();
    expect(runtime.database.get("SELECT action FROM audit_logs WHERE entity_id = ? AND action = 'user.avatar-deleted'", user.user.userId)).toEqual({
      action: "user.avatar-deleted"
    });
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("用户可重置 API Key，且密钥仅访问所属用户的作品数据和 CLI 白名单", async () => {
    const admin = await register(runtime, "api_admin");
    const writer = await register(runtime, "api_writer");
    const adminWork = await admin.agent.post("/api/works").set("X-CSRF-Token", admin.csrfToken).send({ title: "管理员私有作品" }).expect(201);
    const writerWork = await writer.agent.post("/api/works").set("X-CSRF-Token", writer.csrfToken).send({ title: "作者私有作品" }).expect(201);
    const adminWorkId = String(adminWork.body.data.id);
    const writerWorkId = String(writerWork.body.data.id);

    const emptyStatus = await admin.agent.get("/api/auth/api-key").expect(200);
    expect(emptyStatus.body.data).toEqual({
      configured: false,
      prefix: null,
      createdAt: null,
      rotatedAt: null,
      lastUsedAt: null
    });

    const firstReset = await admin.agent.post("/api/auth/api-key/reset")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({})
      .expect(200);
    const firstKey = String(firstReset.body.data.apiKey);
    expect(firstKey).toMatch(/^scrv_[A-Za-z0-9_-]{43}$/u);
    expect(firstReset.body.data).toMatchObject({ configured: true, prefix: firstKey.slice(0, 13), lastUsedAt: null });
    const storedKey = runtime.database.get("SELECT * FROM user_api_keys WHERE user_id = ?", admin.user.userId);
    expect(storedKey?.key_hash).not.toBe(firstKey);
    expect(JSON.stringify(storedKey)).not.toContain(firstKey);

    const cliSession = await request(runtime.app).get("/api/cli/session").set("Authorization", `Bearer ${firstKey}`).expect(200);
    expect(cliSession.body.data).toMatchObject({
      authenticated: true,
      user: { userId: admin.user.userId, username: "api_admin" },
      apiKeyPrefix: firstKey.slice(0, 13)
    });
    const adminKeyWorks = await request(runtime.app).get("/api/works").set("Authorization", `Bearer ${firstKey}`).expect(200);
    expect(adminKeyWorks.body.data.map((work: { id: string }) => work.id)).toEqual([adminWorkId]);
    await request(runtime.app).get(`/api/works/${writerWorkId}`).set("Authorization", `Bearer ${firstKey}`).expect(403);

    const volume = await request(runtime.app).post(`/api/works/${adminWorkId}/volumes`)
      .set("Authorization", `Bearer ${firstKey}`)
      .send({ title: "CLI 正文" })
      .expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${adminWorkId}/chapters`)
      .set("Authorization", `Bearer ${firstKey}`)
      .send({ volumeId: volume.body.data.id, title: "CLI 第一章", content: "初始正文。" })
      .expect(201);
    await request(runtime.app).patch(`/api/chapters/${chapter.body.data.id}`)
      .set("X-Scriverse-API-Key", firstKey)
      .send({ content: "API Key 修改后的正文。", changeNote: "CLI 调整开场正文" })
      .expect(200);
    const versions = await request(runtime.app).get(`/api/chapters/${chapter.body.data.id}/versions`)
      .set("Authorization", `Bearer ${firstKey}`)
      .expect(200);
    expect(versions.body.data[0]).toMatchObject({ versionNo: 2, actor: "api_admin", changeNote: "CLI 调整开场正文" });
    const setting = await request(runtime.app).post(`/api/works/${adminWorkId}/settings`)
      .set("Authorization", `Bearer ${firstKey}`)
      .send({ title: "潮汐航线", category: "交通", content: "初始设定。" })
      .expect(201);
    await request(runtime.app).patch(`/api/settings/${setting.body.data.id}`)
      .set("Authorization", `Bearer ${firstKey}`)
      .send({ content: "补充后的航线设定。", changeNote: "CLI 补充航线限制" })
      .expect(200);
    const settingVersions = await request(runtime.app).get(`/api/entity-versions/setting/${setting.body.data.id}`)
      .set("Authorization", `Bearer ${firstKey}`)
      .expect(200);
    expect(settingVersions.body.data[0]).toMatchObject({ versionNo: 2, actor: "api_admin", changeNote: "CLI 补充航线限制" });

    await request(runtime.app).get("/api/users").set("Authorization", `Bearer ${firstKey}`).expect(403);
    await request(runtime.app).get("/api/platform/ai/providers").set("Authorization", `Bearer ${firstKey}`).expect(403);
    await request(runtime.app).get(`/api/works/${adminWorkId}/members`).set("Authorization", `Bearer ${firstKey}`).expect(403);
    await request(runtime.app).post("/api/auth/api-key/reset").set("Authorization", `Bearer ${firstKey}`).send({}).expect(403);
    await request(runtime.app).delete(`/api/chapters/${chapter.body.data.id}`).set("Authorization", `Bearer ${firstKey}`).expect(403);

    const secondReset = await admin.agent.post("/api/auth/api-key/reset")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({})
      .expect(200);
    const secondKey = String(secondReset.body.data.apiKey);
    expect(secondKey).not.toBe(firstKey);
    await request(runtime.app).get("/api/cli/session").set("Authorization", `Bearer ${firstKey}`).expect(401);
    await request(runtime.app).get("/api/cli/session").set("Authorization", `Bearer ${secondKey}`).expect(200);
    await request(runtime.app).get("/api/cli/session").set("Authorization", "Bearer scrv_invalid").expect(401);

    const writerReset = await writer.agent.post("/api/auth/api-key/reset")
      .set("X-CSRF-Token", writer.csrfToken)
      .send({})
      .expect(200);
    const writerKey = String(writerReset.body.data.apiKey);
    const writerKeyWorks = await request(runtime.app).get("/api/works").set("Authorization", `Bearer ${writerKey}`).expect(200);
    expect(writerKeyWorks.body.data.map((work: { id: string }) => work.id)).toEqual([writerWorkId]);

    await admin.agent.patch(`/api/users/${writer.user.userId}`)
      .set("X-CSRF-Token", admin.csrfToken)
      .send({ status: "disabled" })
      .expect(200);
    await request(runtime.app).get("/api/cli/session").set("Authorization", `Bearer ${writerKey}`).expect(401);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("未显式开启注册时连首位管理员注册也会被拒绝", async () => {
    runtime.close();
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "user-auth-test-master-secret-with-enough-length",
      serveUi: false,
      revealCaptchaAnswer: true,
      security: { allowRegistration: false, enforceSameOrigin: true }
    });
    const closedSession = await request(runtime.app).get("/api/auth/session").expect(200);
    expect(closedSession.body.data).toMatchObject({ setupRequired: true, registrationOpen: false });
    const captcha = await solveCaptcha(runtime.app);
    const rejected = await request(runtime.app).post("/api/auth/register").send({
      username: "blocked_first_admin",
      password: "secure-password-123",
      passwordConfirmation: "secure-password-123",
      ...captcha
    }).expect(403);
    expect(rejected.body.error.code).toBe("REGISTRATION_DISABLED");
  });

  it("登录与注册必须通过图片验证码", async () => {
    await request(runtime.app).post("/api/auth/register").send({
      username: "captcha_user",
      password: "secure-password-123"
    }).expect(400);
    const wrong = await solveCaptcha(runtime.app);
    await request(runtime.app).post("/api/auth/register").send({
      username: "captcha_user",
      password: "secure-password-123",
      passwordConfirmation: "secure-password-123",
      captchaId: wrong.captchaId,
      captchaAnswer: "XXXX"
    }).expect(400);
    const user = await register(runtime, "captcha_user");
    await user.agent.post("/api/auth/login").send({
      username: "captcha_user",
      password: "secure-password-123",
      captchaId: "missing",
      captchaAnswer: "ABCD"
    }).expect(400);
  });

  it("注册必须二次确认且两次密码相同", async () => {
    const captcha = await solveCaptcha(runtime.app);
    const response = await request(runtime.app).post("/api/auth/register").send({
      username: "password_confirm_user",
      password: "secure-password-123",
      passwordConfirmation: "different-password-456",
      ...captcha
    }).expect(400);
    expect(response.body.error.details).toContainEqual(expect.objectContaining({
      path: "passwordConfirmation",
      message: "两次输入的密码不一致"
    }));
  });
});
