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
  const deletedChapter = runtime.store.createChapter(workId, {
    volumeId: String(volume.id),
    title: "待删除章节",
    content: "等待协作者删除。"
  });
  const deletedSetting = runtime.store.createSetting(workId, {
    title: "待删除设定",
    category: "世界规则",
    content: "等待协作者删除。"
  });
  const firstCharacter = runtime.store.createCharacter(workId, { name: "林舟" });
  const secondCharacter = runtime.store.createCharacter(workId, { name: "沈星" });
  const deletedCharacter = runtime.store.createCharacter(workId, { name: "待删除角色" });
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
    deletedChapterId: String(deletedChapter.id),
    deletedChapterVersionNo: Number(deletedChapter.versionNo),
    deletedSettingId: String(deletedSetting.id),
    deletedSettingVersionNo: Number(deletedSetting.versionNo),
    characterId: String(firstCharacter.id),
    characterVersionNo: Number(firstCharacter.versionNo),
    deletedCharacterId: String(deletedCharacter.id),
    deletedCharacterVersionNo: Number(deletedCharacter.versionNo),
    relationshipId: String(relationship.id),
    relationshipVersionNo: Number(relationship.versionNo)
  };
});

function ownerDeleteTarget(target: string | null): { path: string; versionNo: number } | null {
  if (target === "chapter") return { path: `/api/chapters/${fixture.deletedChapterId}`, versionNo: fixture.deletedChapterVersionNo };
  if (target === "setting") return { path: `/api/settings/${fixture.deletedSettingId}`, versionNo: fixture.deletedSettingVersionNo };
  if (target === "character") return { path: `/api/characters/${fixture.deletedCharacterId}`, versionNo: fixture.deletedCharacterVersionNo };
  return null;
}

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (requestUrl.pathname === "/__e2e/login-writer") {
    const target = requestUrl.searchParams.get("target");
    const location = target === "delete-chapter"
      ? `/#view=editor&work=${fixture.workId}&chapter=${fixture.deletedChapterId}`
      : target === "delete-setting"
        ? `/#view=entity-editor&work=${fixture.workId}&entity=setting&id=${fixture.deletedSettingId}`
        : target === "delete-character"
          ? `/#view=entity-editor&work=${fixture.workId}&entity=character&id=${fixture.deletedCharacterId}`
          : `/#view=entity-editor&work=${fixture.workId}&entity=character&id=${fixture.characterId}`;
    response.setHeader("Set-Cookie", `scriverse_session=${encodeURIComponent(writer.token)}; Path=/; HttpOnly; SameSite=Lax`);
    response.writeHead(302, { Location: location });
    response.end();
    return;
  }
  if (requestUrl.pathname === "/__e2e/login-owner") {
    response.setHeader("Set-Cookie", `scriverse_session=${encodeURIComponent(owner.token)}; Path=/; HttpOnly; SameSite=Lax`);
    response.writeHead(302, { Location: `/#view=entity-editor&work=${fixture.workId}&entity=character&id=${fixture.characterId}` });
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
  if (requestUrl.pathname === "/__e2e/owner-delete" && request.method === "POST") {
    const target = ownerDeleteTarget(requestUrl.searchParams.get("target"));
    if (!target) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Unknown delete target" }));
      return;
    }
    void (async () => {
      try {
        const deleted = await fetch(`http://127.0.0.1:${port}${target.path}`, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Cookie: `scriverse_session=${encodeURIComponent(owner.token)}`,
            "X-CSRF-Token": owner.session.csrfToken
          },
          body: JSON.stringify({ expectedVersionNo: target.versionNo })
        });
        if (!deleted.ok) {
          const payload = await deleted.json() as Json;
          response.writeHead(deleted.status, { "Content-Type": "application/json" });
          response.end(JSON.stringify(payload));
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      } catch (error) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      }
    })();
    return;
  }
  if (requestUrl.pathname === "/__e2e/owner-save-character" && request.method === "POST") {
    void (async () => {
      try {
        const character = await fetch(`http://127.0.0.1:${port}/api/characters/${fixture.characterId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Cookie: `scriverse_session=${encodeURIComponent(owner.token)}`,
            "X-CSRF-Token": owner.session.csrfToken
          },
          body: JSON.stringify({
            aliases: [`协作更新 ${Date.now()}`],
            expectedVersionNo: fixture.characterVersionNo
          })
        });
        const payload = await character.json() as { data?: Json; error?: Json };
        if (!character.ok) {
          response.writeHead(character.status, { "Content-Type": "application/json" });
          response.end(JSON.stringify(payload));
          return;
        }
        fixture.characterVersionNo = Number(payload.data?.versionNo ?? fixture.characterVersionNo);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, versionNo: fixture.characterVersionNo }));
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
  deletedChapterId: fixture.deletedChapterId,
  deletedSettingId: fixture.deletedSettingId,
  characterId: fixture.characterId,
  deletedCharacterId: fixture.deletedCharacterId,
  relationshipId: fixture.relationshipId,
  writerLogin: `${baseUrl}/__e2e/login-writer`,
  ownerLogin: `${baseUrl}/__e2e/login-owner`,
  ownerSave: `${baseUrl}/__e2e/owner-save-character`,
  ownerDelete: `${baseUrl}/__e2e/owner-delete`
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
    assert.ok(chapterChanges.some((change) => (
      change.pageKey === `editor:${fixture.chapterId}`
      && change.label === "正文编辑"
      && change.actorUserId === owner.session.user.userId
      && change.actorDisplayName === "collab_owner"
    )), `expected targeted chapter change, got ${JSON.stringify(chapterChanges)}`);

    const characterPage = { kind: "entity-editor", module: "character", resourceId: fixture.characterId };
    await presence(writer.token, writer.session.csrfToken, writerClientId, characterPage);
    await presence(owner.token, owner.session.csrfToken, ownerClientId, characterPage);
    const characterSaveResponse = await fetch(`${baseUrl}/__e2e/owner-save-character`, { method: "POST" });
    const characterSavePayload = await characterSaveResponse.json() as Json;
    assert.equal(characterSaveResponse.status, 200, JSON.stringify(characterSavePayload));
    assert.equal(characterSavePayload.ok, true);

    const afterCharacterSave = await presence(writer.token, writer.session.csrfToken, writerClientId, characterPage);
    const characterChanges = Array.isArray(afterCharacterSave.recentChanges) ? afterCharacterSave.recentChanges as Json[] : [];
    assert.ok(characterChanges.some((change) => (
      change.pageKey === `entity-editor:character:${fixture.characterId}`
      && change.label === "角色编辑"
      && change.actorUserId === owner.session.user.userId
      && change.actorDisplayName === "collab_owner"
    )), `expected targeted character change, got ${JSON.stringify(characterChanges)}`);

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

    const deletionCases = [
      {
        target: "chapter",
        page: { kind: "editor", resourceId: fixture.deletedChapterId },
        pageKey: `editor:${fixture.deletedChapterId}`,
        label: "正文编辑"
      },
      {
        target: "setting",
        page: { kind: "entity-editor", module: "setting", resourceId: fixture.deletedSettingId },
        pageKey: `entity-editor:setting:${fixture.deletedSettingId}`,
        label: "设定编辑"
      },
      {
        target: "character",
        page: { kind: "entity-editor", module: "character", resourceId: fixture.deletedCharacterId },
        pageKey: `entity-editor:character:${fixture.deletedCharacterId}`,
        label: "角色编辑"
      }
    ];
    for (const deletion of deletionCases) {
      await presence(writer.token, writer.session.csrfToken, writerClientId, deletion.page);
      await presence(owner.token, owner.session.csrfToken, ownerClientId, deletion.page);
      const deleteResponse = await fetch(`${baseUrl}/__e2e/owner-delete?target=${deletion.target}`, { method: "POST" });
      const deletePayload = await deleteResponse.json() as Json;
      assert.equal(deleteResponse.status, 200, JSON.stringify(deletePayload));
      assert.equal(deletePayload.ok, true);
      const afterDelete = await presence(writer.token, writer.session.csrfToken, writerClientId, deletion.page);
      const deleteChanges = Array.isArray(afterDelete.recentChanges) ? afterDelete.recentChanges as Json[] : [];
      assert.ok(deleteChanges.some((change) => (
        change.pageKey === deletion.pageKey
        && change.label === deletion.label
        && change.action === "delete"
        && change.pageDeleted === true
        && change.actorUserId === owner.session.user.userId
      )), `expected targeted ${deletion.target} deletion, got ${JSON.stringify(deleteChanges)}`);
    }

    console.log("[e2e] collaboration-refresh: targeted saves and page deletions OK");

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
