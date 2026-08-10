import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

type SessionCredentials = {
  cookie: string;
  csrfToken: string;
  userId: string;
};

const setupToken = "presence-restart-setup-token-with-at-least-32-characters";
const masterSecret = "presence-restart-master-secret-with-enough-length";

async function register(runtime: Runtime, username: string): Promise<SessionCredentials> {
  const captcha = await request(runtime.app).get("/api/auth/captcha").expect(200);
  const agent = request.agent(runtime.app);
  const response = await agent.post("/api/auth/register").send({
    username,
    password: "secure-password-123",
    passwordConfirmation: "secure-password-123",
    setupToken,
    captchaId: captcha.body.data.captchaId,
    captchaAnswer: captcha.body.data.answer
  }).expect(201);
  const cookie = response.headers["set-cookie"]?.[0]?.split(";", 1)[0] ?? "";
  expect(cookie).toContain("scriverse_session=");
  return {
    cookie,
    csrfToken: response.body.data.csrfToken,
    userId: response.body.data.user.userId
  };
}

async function login(runtime: Runtime, username: string): Promise<SessionCredentials> {
  const captcha = await request(runtime.app).get("/api/auth/captcha").expect(200);
  const agent = request.agent(runtime.app);
  const response = await agent.post("/api/auth/login").send({
    username,
    password: "secure-password-123",
    captchaId: captcha.body.data.captchaId,
    captchaAnswer: captcha.body.data.answer
  }).expect(200);
  const cookie = response.headers["set-cookie"]?.[0]?.split(";", 1)[0] ?? "";
  expect(cookie).toContain("scriverse_session=");
  return {
    cookie,
    csrfToken: response.body.data.csrfToken,
    userId: response.body.data.user.userId
  };
}

function authenticated(runtime: Runtime, credentials: SessionCredentials) {
  return {
    post: (path: string) => request(runtime.app).post(path).set("Cookie", credentials.cookie).set("X-CSRF-Token", credentials.csrfToken),
    patch: (path: string) => request(runtime.app).patch(path).set("Cookie", credentials.cookie).set("X-CSRF-Token", credentials.csrfToken)
  };
}

describe("协作状态重启恢复", () => {
  let runtime: Runtime | null = null;
  let root: string | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("通过关闭钩子持久化在线参与者和仅向当时接收者发布的变更", async () => {
    root = mkdtempSync(join(tmpdir(), "scriverse-presence-restart-"));
    const databasePath = join(root, "novel.db");
    const options = {
      databasePath,
      masterSecret,
      serveUi: false,
      revealCaptchaAnswer: true,
      security: { allowRegistration: true, enforceSameOrigin: true, setupToken }
    } as const;
    runtime = createRuntime(options);
    const owner = await register(runtime, "restart_owner");
    const writer = await register(runtime, "restart_writer");
    const ownerApi = authenticated(runtime, owner);
    const writerApi = authenticated(runtime, writer);
    const work = await ownerApi.post("/api/works").send({ title: "重启恢复作品" }).expect(201);
    const workId = work.body.data.id as string;
    await ownerApi.post(`/api/works/${workId}/members`).send({ userId: writer.userId, role: "editor" }).expect(201);
    const firstCharacter = await ownerApi.post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    const secondCharacter = await ownerApi.post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const relationship = await ownerApi.post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: firstCharacter.body.data.id,
      toCharacterId: secondCharacter.body.data.id,
      category: "social",
      subtype: "朋友",
      directed: false
    }).expect(201);
    const relationshipId = relationship.body.data.id as string;
    const page = { kind: "entity-editor", module: "relationship", resourceId: relationshipId };
    const ownerClientId = "08c6a5c8-0f18-4718-8568-b8d0de36fd82";
    const writerClientId = "b85a4479-69e0-44f7-92f2-f44e69a6729a";

    await writerApi.post(`/api/works/${workId}/presence`).send({
      clientId: writerClientId,
      page: { kind: "module", module: "relationships" }
    }).expect(200);
    const unobservedUpdate = await ownerApi.patch(`/api/relationships/${relationshipId}`).send({
      subtype: "旧友",
      expectedVersionNo: relationship.body.data.versionNo
    }).expect(200);
    await ownerApi.post(`/api/works/${workId}/presence`).send({ clientId: ownerClientId, page }).expect(200);
    await writerApi.post(`/api/works/${workId}/presence`).send({ clientId: writerClientId, page }).expect(200);
    const observedUpdate = await ownerApi.patch(`/api/relationships/${relationshipId}`).send({
      subtype: "盟友",
      expectedVersionNo: unobservedUpdate.body.data.versionNo
    }).expect(200);

    await runtime.close();
    runtime = createRuntime(options);
    const restoredWriter = await login(runtime, "restart_writer");
    const restoredOwner = await login(runtime, "restart_owner");
    const restoredWriterApi = authenticated(runtime, restoredWriter);
    // 模拟系统重启后重新登录的同一标签页一次性沿用旧 clientId。
    const restored = await restoredWriterApi.post(`/api/works/${workId}/presence`).send({
      clientId: writerClientId,
      page
    }).expect(200);

    expect(restored.body.data.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ clientId: ownerClientId, userId: owner.userId }),
      expect.objectContaining({ clientId: writerClientId, userId: writer.userId })
    ]));
    expect(restored.body.data.recentChanges).toEqual([
      expect.objectContaining({
        pageKey: `entity-editor:relationship:${relationshipId}`,
        actorUserId: owner.userId,
        actorDisplayName: "restart_owner"
      })
    ]);

    const restoredOwnerApi = authenticated(runtime, restoredOwner);
    await restoredOwnerApi.patch(`/api/relationships/${relationshipId}`).send({
      subtype: "挚友",
      expectedVersionNo: observedUpdate.body.data.versionNo
    }).expect(200);
    const afterSecondChange = await restoredWriterApi.post(`/api/works/${workId}/presence`).send({
      clientId: writerClientId,
      page
    }).expect(200);
    expect(afterSecondChange.body.data.recentChanges).toHaveLength(2);
    expect(new Set(afterSecondChange.body.data.recentChanges.map((item: { id: string }) => item.id)).size).toBe(2);
  });
});
