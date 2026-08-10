import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRuntime } from "../../src/app.js";
import { runWithRequestActor } from "../../src/request-context.js";
import { parseBooleanEnvironmentValue } from "../../src/utils.js";

type Json = Record<string, unknown>;

const port = Number(process.env.E2E_COLLAB_PORT ?? 13213);
const keepAlive = parseBooleanEnvironmentValue(process.env.E2E_COLLAB_KEEP_ALIVE) ?? false;
const dataRoot = join(process.cwd(), ".data");
await mkdir(dataRoot, { recursive: true });
const isolatedDirectory = await mkdtemp(join(dataRoot, "e2e-collab-refresh-"));

const runtime = createRuntime({
  databasePath: join(isolatedDirectory, "novel.db"),
  masterSecret: "collab-refresh-e2e-master-secret-32chars",
  security: { allowPrivateAiEndpoints: true, enforceSameOrigin: false, apiRateLimit: 10_000, allowRegistration: true }
});

const owner = runtime.auth.register({ username: "collab_owner", password: "CollabOwner123!" });
const writer = runtime.auth.register({ username: "collab_writer", password: "CollabWriter123!" });

const fixture = runWithRequestActor(owner.session.user, () => {
  const work = runtime.store.createWork({ title: "协作刷新 E2E", author: "E2E" });
  const workId = String(work.id);
  runtime.auth.addMember(workId, writer.session.user.userId, { role: "editor" }, owner.session.user.userId);
  const volume = runtime.store.createVolume(workId, { title: "第一卷" });
  const chapter = runtime.store.createChapter(workId, {
    volumeId: String(volume.id),
    title: "第一章",
    content: "原始协作正文。"
  });
  const firstCharacter = runtime.store.createCharacter(workId, { name: "林舟" });
  const secondCharacter = runtime.store.createCharacter(workId, { name: "沈星" });
  const relationship = runtime.store.createRelationship(workId, {
    fromCharacterId: String(firstCharacter.id),
    toCharacterId: String(secondCharacter.id),
    category: "social",
    subtype: "朋友",
    directed: false
  });
  return {
    workId,
    chapterId: String(chapter.id),
    chapterVersionNo: Number(chapter.versionNo),
    relationshipId: String(relationship.id),
    relationshipVersionNo: Number(relationship.versionNo)
  };
});

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (requestUrl.pathname === "/__e2e/login-writer") {
    response.setHeader("Set-Cookie", `scriverse_session=${encodeURIComponent(writer.token)}; Path=/; HttpOnly; SameSite=Lax`);
    response.writeHead(302, { Location: `/#view=module&work=${fixture.workId}&module=relationships` });
    response.end();
    return;
  }
  if (requestUrl.pathname === "/__e2e/login-owner") {
    response.setHeader("Set-Cookie", `scriverse_session=${encodeURIComponent(owner.token)}; Path=/; HttpOnly; SameSite=Lax`);
    response.writeHead(302, { Location: `/#view=module&work=${fixture.workId}&module=relationships` });
    response.end();
    return;
  }
  if (requestUrl.pathname === "/__e2e/owner-save" && request.method === "POST") {
    void (async () => {
      try {
        const chapter = await fetch(`http://127.0.0.1:${port}/api/chapters/${fixture.chapterId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Cookie: `scriverse_session=${encodeURIComponent(owner.token)}`,
            "X-CSRF-Token": owner.session.csrfToken
          },
          body: JSON.stringify({
            content: `作者已更新协作正文 ${Date.now()}`,
            expectedVersionNo: fixture.chapterVersionNo
          })
        });
        const payload = await chapter.json() as { data?: Json; error?: Json };
        if (!chapter.ok) {
          response.writeHead(chapter.status, { "Content-Type": "application/json" });
          response.end(JSON.stringify(payload));
          return;
        }
        fixture.chapterVersionNo = Number(payload.data?.versionNo ?? fixture.chapterVersionNo);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, versionNo: fixture.chapterVersionNo }));
      } catch (error) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      }
    })();
    return;
  }
  if (requestUrl.pathname === "/__e2e/owner-save-relationship" && request.method === "POST") {
    void (async () => {
      try {
        const relationship = await fetch(`http://127.0.0.1:${port}/api/relationships/${fixture.relationshipId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Cookie: `scriverse_session=${encodeURIComponent(owner.token)}`,
            "X-CSRF-Token": owner.session.csrfToken
          },
          body: JSON.stringify({
            subtype: `盟友 ${Date.now()}`,
            expectedVersionNo: fixture.relationshipVersionNo
          })
        });
        const payload = await relationship.json() as { data?: Json; error?: Json };
        if (!relationship.ok) {
          response.writeHead(relationship.status, { "Content-Type": "application/json" });
          response.end(JSON.stringify(payload));
          return;
        }
        fixture.relationshipVersionNo = Number(payload.data?.versionNo ?? fixture.relationshipVersionNo);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, versionNo: fixture.relationshipVersionNo }));
      } catch (error) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      }
    })();
    return;
  }
  runtime.app(request, response);
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", () => resolve());
});

const baseUrl = `http://127.0.0.1:${port}`;
console.log(JSON.stringify({
  ready: true,
  baseUrl,
  workId: fixture.workId,
  chapterId: fixture.chapterId,
  relationshipId: fixture.relationshipId,
  writerLogin: `${baseUrl}/__e2e/login-writer`,
  ownerSave: `${baseUrl}/__e2e/owner-save-relationship`
}));

async function presence(cookieToken: string, csrf: string, clientId: string, page: Json): Promise<Json> {
  const response = await fetch(`${baseUrl}/api/works/${fixture.workId}/presence`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `scriverse_session=${encodeURIComponent(cookieToken)}`,
      "X-CSRF-Token": csrf
    },
    body: JSON.stringify({
      clientId,
      page
    })
  });
  const payload = await response.json() as { data?: Json; error?: Json };
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload.data as Json;
}

try {
  if (!keepAlive) {
    const writerClientId = randomUUID();
    const ownerClientId = randomUUID();
    console.log("[e2e] presence clientId", writerClientId);
    await presence(writer.token, writer.session.csrfToken, writerClientId, { kind: "editor", resourceId: fixture.chapterId });

    const saveResponse = await fetch(`${baseUrl}/__e2e/owner-save`, { method: "POST" });
    const savePayload = await saveResponse.json() as Json;
    assert.equal(saveResponse.status, 200, JSON.stringify(savePayload));
    assert.equal(savePayload.ok, true);

    const afterChapterSave = await presence(writer.token, writer.session.csrfToken, writerClientId, { kind: "editor", resourceId: fixture.chapterId });
    const chapterChanges = Array.isArray(afterChapterSave.recentChanges) ? afterChapterSave.recentChanges as Json[] : [];
    assert.deepEqual(chapterChanges, []);

    const relationshipPage = { kind: "entity-editor", module: "relationship", resourceId: fixture.relationshipId };
    await presence(writer.token, writer.session.csrfToken, writerClientId, relationshipPage);
    await presence(owner.token, owner.session.csrfToken, ownerClientId, relationshipPage);
    const relationshipSaveResponse = await fetch(`${baseUrl}/__e2e/owner-save-relationship`, { method: "POST" });
    const relationshipSavePayload = await relationshipSaveResponse.json() as Json;
    assert.equal(relationshipSaveResponse.status, 200, JSON.stringify(relationshipSavePayload));
    assert.equal(relationshipSavePayload.ok, true);

    const afterRelationshipSave = await presence(writer.token, writer.session.csrfToken, writerClientId, relationshipPage);
    const relationshipChanges = Array.isArray(afterRelationshipSave.recentChanges) ? afterRelationshipSave.recentChanges as Json[] : [];
    assert.ok(relationshipChanges.some((change) => (
      change.pageKey === `entity-editor:relationship:${fixture.relationshipId}`
      && change.actorUserId === owner.session.user.userId
      && change.actorDisplayName === "collab_owner"
    )), `expected targeted relationship change, got ${JSON.stringify(relationshipChanges)}`);

    const globalList = await presence(writer.token, writer.session.csrfToken, writerClientId, { kind: "module", module: "relationships" });
    const globalChanges = Array.isArray(globalList.recentChanges) ? globalList.recentChanges as Json[] : [];
    assert.deepEqual(globalChanges, []);

    console.log("[e2e] collaboration-refresh: targeted relationship changes OK");

    server.closeAllConnections();
    server.close();
    await runtime.close();
    await rm(isolatedDirectory, { recursive: true, force: true });
    process.exit(0);
  }

  console.log("[e2e] collaboration-refresh: keep-alive for browser verification");
} catch (error) {
  console.error(error);
  server.closeAllConnections();
  server.close();
  await runtime.close();
  await rm(isolatedDirectory, { recursive: true, force: true });
  process.exit(1);
}

async function shutdown(): Promise<void> {
  server.closeAllConnections();
  server.close();
  await runtime.close();
  await rm(isolatedDirectory, { recursive: true, force: true });
  process.exit(0);
}

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
