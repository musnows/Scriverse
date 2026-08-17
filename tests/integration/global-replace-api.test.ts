import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("全局替换 API", () => {
  let runtime: Runtime;
  let workId: string;
  let volumeId: string;
  let chapterId: string;
  let scopedChapterId: string;
  let otherChapterId: string;
  let settingId: string;

  beforeEach(async () => {
    runtime = createTestRuntime();
    const work = await request(runtime.app).post("/api/works").send({ title: "全局替换测试作品" }).expect(201);
    workId = String(work.body.data.id);
    const volume = runtime.store.createVolume(workId, { title: "第一卷" });
    volumeId = String(volume.id);
    const chapter = runtime.store.createChapter(workId, {
      volumeId,
      title: "第一章",
      content: "共同词出现在正文，星港再次出现共同词。"
    });
    chapterId = String(chapter.id);
    const scopedChapter = runtime.store.createChapter(workId, {
      volumeId,
      title: "分卷替换章节",
      content: "跨卷角色在目标分卷。跨卷角色再次出现。"
    });
    scopedChapterId = String(scopedChapter.id);
    const otherVolume = runtime.store.createVolume(workId, { title: "第二卷" });
    const otherChapter = runtime.store.createChapter(workId, {
      volumeId: String(otherVolume.id),
      title: "其他分卷章节",
      content: "跨卷角色在其他分卷。"
    });
    otherChapterId = String(otherChapter.id);
    const setting = runtime.store.createSetting(workId, {
      title: "星港规则",
      category: "世界规则",
      content: "共同词出现在设定，跃迁需要校准。"
    });
    settingId = String(setting.id);
  });

  afterEach(() => runtime.close());

  it("只替换正文并创建章节版本", async () => {
    const response = await request(runtime.app)
      .post(`/api/works/${workId}/replace`)
      .send({ find: "共同词", replacement: "正文词", scope: "prose" })
      .expect(200);

    expect(response.body.data).toMatchObject({
      scope: "prose",
      chapterCount: 1,
      settingCount: 0,
      totalMatches: 2
    });
    expect(response.body.data.work.id).toBe(workId);

    const chapter = await request(runtime.app).get(`/api/chapters/${chapterId}`).expect(200);
    expect(chapter.body.data.content).toBe("正文词出现在正文，星港再次出现正文词。");
    const setting = await request(runtime.app).get(`/api/settings/${settingId}`).expect(200);
    expect(setting.body.data.content).toBe("共同词出现在设定，跃迁需要校准。");

    const versions = await request(runtime.app).get(`/api/chapters/${chapterId}/versions`).expect(200);
    expect(versions.body.data[0]).toMatchObject({ source: "global-replace", changeNote: "全局替换正文" });
    expect(runtime.database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("可以只替换设定库内容", async () => {
    const response = await request(runtime.app)
      .post(`/api/works/${workId}/replace`)
      .send({ find: "跃迁", replacement: "折跃", scope: "settings" })
      .expect(200);

    expect(response.body.data).toMatchObject({ scope: "settings", chapterCount: 0, settingCount: 1, totalMatches: 1 });
    const chapter = await request(runtime.app).get(`/api/chapters/${chapterId}`).expect(200);
    expect(chapter.body.data.content).toContain("共同词");
    const setting = await request(runtime.app).get(`/api/settings/${settingId}`).expect(200);
    expect(setting.body.data.content).toBe("共同词出现在设定，折跃需要校准。");
    const versions = await request(runtime.app).get(`/api/entity-versions/setting/${settingId}`).expect(200);
    expect(versions.body.data[0]).toMatchObject({ source: "global-replace", changeNote: "全局替换设定库" });
  });

  it("可以把正文替换限制在指定分卷", async () => {
    const response = await request(runtime.app)
      .post(`/api/works/${workId}/replace`)
      .send({ find: "跨卷角色", replacement: "新角色", scope: "prose", volumeId })
      .expect(200);

    expect(response.body.data).toMatchObject({ scope: "prose", volumeId, chapterCount: 1, settingCount: 0, totalMatches: 2 });
    const scopedChapter = await request(runtime.app).get(`/api/chapters/${scopedChapterId}`).expect(200);
    expect(scopedChapter.body.data.content).toBe("新角色在目标分卷。新角色再次出现。");
    const otherChapter = await request(runtime.app).get(`/api/chapters/${otherChapterId}`).expect(200);
    expect(otherChapter.body.data.content).toBe("跨卷角色在其他分卷。");
    const versions = await request(runtime.app).get(`/api/chapters/${scopedChapterId}/versions`).expect(200);
    expect(versions.body.data[0]).toMatchObject({ source: "global-replace", changeNote: "全局替换正文" });
    const audits = runtime.database.all(
      "SELECT detail_json FROM audit_logs WHERE work_id = ? ORDER BY created_at DESC, id DESC",
      workId
    );
    expect(audits.some((row) => String(row.detail_json).includes(`\"volumeId\":\"${volumeId}\"`))).toBe(true);
  });

  it("可以同时替换正文和设定库，并将替换字符串按字面量处理", async () => {
    const response = await request(runtime.app)
      .post(`/api/works/${workId}/replace`)
      .send({ find: "共同词", replacement: "$&-新词", scope: "prose-and-settings" })
      .expect(200);

    expect(response.body.data).toMatchObject({
      scope: "prose-and-settings",
      chapterCount: 1,
      settingCount: 1,
      totalMatches: 3
    });
    const chapter = await request(runtime.app).get(`/api/chapters/${chapterId}`).expect(200);
    expect(chapter.body.data.content).toContain("$&-新词");
    const setting = await request(runtime.app).get(`/api/settings/${settingId}`).expect(200);
    expect(setting.body.data.content).toContain("$&-新词");

    const audits = runtime.database.all(
      "SELECT action, detail_json FROM audit_logs WHERE work_id = ? ORDER BY created_at DESC, id DESC",
      workId
    );
    expect(audits.some((row) => row.action === "work.global-replace" && String(row.detail_json).includes("prose-and-settings"))).toBe(true);
  });

  it("没有命中时不创建版本，且拒绝无效范围", async () => {
    const beforeChapterVersions = runtime.database.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM chapter_versions WHERE chapter_id = ?",
      chapterId
    )?.count;
    const beforeSettingVersions = runtime.database.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = 'setting' AND entity_id = ?",
      settingId
    )?.count;
    const response = await request(runtime.app)
      .post(`/api/works/${workId}/replace`)
      .send({ find: "不存在的文字", replacement: "替换", scope: "prose" })
      .expect(200);
    expect(response.body.data).toMatchObject({ chapterCount: 0, settingCount: 0, totalMatches: 0 });
    expect(runtime.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM chapter_versions WHERE chapter_id = ?", chapterId)?.count).toBe(beforeChapterVersions);
    expect(runtime.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = 'setting' AND entity_id = ?", settingId)?.count).toBe(beforeSettingVersions);

    const missingScope = await request(runtime.app)
      .post(`/api/works/${workId}/replace`)
      .send({ find: "共同词", replacement: "不应替换" })
      .expect(400);
    expect(missingScope.body.error.code).toBe("VALIDATION_ERROR");
    await request(runtime.app).post(`/api/works/${workId}/replace`).send({ find: "共同词", replacement: "替换", scope: "unknown" }).expect(400);
    await request(runtime.app).post(`/api/works/${workId}/replace`).send({ find: "", replacement: "替换" }).expect(400);
    const invalidVolumeScope = await request(runtime.app)
      .post(`/api/works/${workId}/replace`)
      .send({ find: "共同词", replacement: "替换", scope: "settings", volumeId })
      .expect(400);
    expect(invalidVolumeScope.body.error.code).toBe("REPLACE_VOLUME_SCOPE_INVALID");
    expect(runtime.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM chapter_versions WHERE chapter_id = ?", chapterId)?.count).toBe(beforeChapterVersions);
    expect(runtime.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = 'setting' AND entity_id = ?", settingId)?.count).toBe(beforeSettingVersions);
  });
});
