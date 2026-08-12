import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { emptyWorkModulePermissions } from "../../src/work-permissions.js";

const setupToken = "character-extraction-auth-setup-token";

async function register(runtime: Runtime, username: string) {
  const agent = request.agent(runtime.app);
  const captcha = await request(runtime.app).get("/api/auth/captcha").expect(200);
  const response = await agent.post("/api/auth/register").send({
    username,
    password: "secure-password-123",
    passwordConfirmation: "secure-password-123",
    setupToken,
    captchaId: captcha.body.data.captchaId,
    captchaAnswer: captcha.body.data.answer
  }).expect(201);
  return {
    agent,
    csrfToken: String(response.body.data.csrfToken),
    userId: String(response.body.data.user.userId)
  };
}

describe("角色抽取应用授权", () => {
  let runtime: Runtime;

  afterEach(() => runtime.close());

  it("重新校验任务作品、角色读写权限、会话与 CSRF", async () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "character-extraction-auth-master-secret",
      serveUi: false,
      revealCaptchaAnswer: true,
      security: { allowRegistration: true, enforceSameOrigin: true, setupToken }
    });
    const owner = await register(runtime, "extraction_owner");
    const collaborator = await register(runtime, "extraction_reader");
    const outsider = await register(runtime, "extraction_outsider");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "角色抽取授权作品" })
      .expect(201);
    const workId = String(work.body.data.id);
    const readOnlyPermissions = {
      ...emptyWorkModulePermissions(),
      "ai-analysis": "write",
      prose: "read",
      characters: "read",
      races: "read"
    };
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: collaborator.userId, permissions: readOnlyPermissions })
      .expect(201);
    const task = await owner.agent.post(`/api/works/${workId}/tasks`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ taskType: "character-extraction", scope: { type: "book" } })
      .expect(201);
    const taskId = String(task.body.data.id);
    runtime.store.updateTask(taskId, {
      status: "completed",
      progress: 100,
      result: {
        characterCandidates: [{
          candidateId: "candidate-1",
          name: "授权候选",
          aliases: [],
          species: "",
          identity: "",
          firstChapterId: null,
          firstEvidence: null,
          stableCharacterId: null
        }],
        candidateCount: 1,
        characterApplication: { status: "pending", totalCount: 1 }
      }
    });

    const preview = await collaborator.agent.get(`/api/tasks/${taskId}/character-extraction/preview`).expect(200);
    await outsider.agent.get(`/api/tasks/${taskId}/character-extraction/preview`).expect(403);
    const payload = {
      previewToken: preview.body.data.previewToken,
      selections: [{ candidateId: "candidate-1", action: "create", name: "授权候选" }]
    };
    const denied = await collaborator.agent.post(`/api/tasks/${taskId}/character-extraction/apply`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send(payload)
      .expect(403);
    expect(["WORK_MODULE_WRITE_DENIED", "WORK_EDIT_DENIED"]).toContain(denied.body.error.code);

    await owner.agent.patch(`/api/works/${workId}/members/${collaborator.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ permissions: { ...readOnlyPermissions, characters: "write", races: "write" } })
      .expect(200);
    const missingCsrf = await collaborator.agent.post(`/api/tasks/${taskId}/character-extraction/apply`)
      .send(payload)
      .expect(403);
    expect(missingCsrf.body.error.code).toBe("CSRF_TOKEN_INVALID");
    await collaborator.agent.post(`/api/tasks/${taskId}/character-extraction/apply`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send(payload)
      .expect(200);
    expect(runtime.store.listCharacters(workId)).toEqual([
      expect.objectContaining({ name: "授权候选" })
    ]);
  });
});
