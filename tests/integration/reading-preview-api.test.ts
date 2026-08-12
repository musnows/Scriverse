import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { runWithRequestActor } from "../../src/request-context.js";
import { createTestRuntime } from "../helpers.js";

describe("阅读预览章节接口", () => {
  let runtime: Runtime;

  beforeEach(() => { runtime = createTestRuntime(); });
  afterEach(() => runtime.close());

  it("按作品树顺序提供跨卷目录并仅通过章节接口返回正文", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "跨卷阅读作品" }).expect(201);
    const workId = String(work.body.data.id);
    const firstVolume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷 & 起航" }).expect(201);
    const secondVolume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第二卷 <归途>" }).expect(201);
    const chapterInputs = [
      { volumeId: String(firstVolume.body.data.id), title: "第一章 <信号>", content: "林舟收到 & 保留 <特殊字符> 的信号。" },
      { volumeId: String(firstVolume.body.data.id), title: "第二章 空白", content: "" },
      { volumeId: String(secondVolume.body.data.id), title: "第三章 长夜", content: `跨卷正文。${"长章节内容。".repeat(2_000)}` }
    ];
    const created = [];
    for (const input of chapterInputs) {
      created.push(await request(runtime.app).post(`/api/works/${workId}/chapters`).send(input).expect(201));
    }

    const directory = await request(runtime.app).get(`/api/works/${workId}?directory=volumes`).expect(200);
    expect(directory.body.data.volumes.map((volume: { title: string }) => volume.title)).toEqual(["第一卷 & 起航", "第二卷 <归途>"]);
    expect(directory.body.data.volumes.every((volume: { chapters: unknown[] }) => volume.chapters.length === 0)).toBe(true);
    const chapterDirectories = await Promise.all(directory.body.data.volumes.map((volume: { id: string }) => (
      request(runtime.app).get(`/api/volumes/${volume.id}/chapters`).expect(200)
    )));
    const directoryChapters = chapterDirectories.flatMap((response) => response.body.data);
    expect(directoryChapters.map((chapter: { id: string }) => chapter.id)).toEqual(created.map((response) => response.body.data.id));
    expect(directoryChapters.every((chapter: Record<string, unknown>) => !("content" in chapter))).toBe(true);
    expect(JSON.stringify(directory.body)).not.toContain("跨卷正文");

    const details = await Promise.all(created.map((response) => request(runtime.app).get(`/api/chapters/${response.body.data.id}`).expect(200)));
    expect(details.map((response) => response.body.data.content)).toEqual(chapterInputs.map((chapter) => chapter.content));
    expect(details.every((response) => response.body.data.workId === workId)).toBe(true);
  });

  it("沿用正文模块权限限制作品目录和章节内容", async () => {
    const authRuntime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "reader-permission-test-secret-with-enough-length",
      serveUi: false
    });
    try {
      const owner = authRuntime.auth.register({ username: "reader_owner", password: "secure-password-123" });
      const reader = authRuntime.auth.register({ username: "reader_allowed", password: "secure-password-123" });
      const denied = authRuntime.auth.register({ username: "reader_denied", password: "secure-password-123" });
      const fixture = runWithRequestActor(owner.session.user, () => {
        const createdWork = authRuntime.store.createWork({ title: "权限阅读作品" });
        const volume = authRuntime.store.createVolume(String(createdWork.id), { title: "正文" });
        const chapter = authRuntime.store.createChapter(String(createdWork.id), {
          volumeId: String(volume.id),
          title: "保密章节",
          content: "只允许正文读者查看。"
        });
        return { work: createdWork, chapter };
      });
      const noAccess = {
        prose: "none",
        drafts: "none",
        settings: "none",
        characters: "none",
        races: "none",
        organizations: "none",
        timeline: "none",
        relationships: "none",
        outlines: "none",
        reviews: "none",
        "ai-chat": "none",
        "ai-analysis": "none",
        "ai-settings": "none"
      } as const;
      authRuntime.auth.addMember(String(fixture.work.id), reader.session.user.userId, { permissions: { ...noAccess, prose: "read" } }, owner.session.user.userId);
      authRuntime.auth.addMember(String(fixture.work.id), denied.session.user.userId, { permissions: noAccess }, owner.session.user.userId);

      const readerCookie = `scriverse_session=${reader.token}`;
      const deniedCookie = `scriverse_session=${denied.token}`;
      await request(authRuntime.app).get(`/api/works/${fixture.work.id}?directory=volumes`).set("Cookie", readerCookie).expect(200);
      const readable = await request(authRuntime.app).get(`/api/chapters/${fixture.chapter.id}`).set("Cookie", readerCookie).expect(200);
      expect(readable.body.data.content).toBe("只允许正文读者查看。");
      const hiddenDirectory = await request(authRuntime.app).get(`/api/works/${fixture.work.id}?directory=volumes`).set("Cookie", deniedCookie).expect(200);
      expect(hiddenDirectory.body.data.volumes).toEqual([]);
      const forbidden = await request(authRuntime.app).get(`/api/chapters/${fixture.chapter.id}`).set("Cookie", deniedCookie).expect(403);
      expect(forbidden.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    } finally {
      await authRuntime.close();
    }
  });
});
