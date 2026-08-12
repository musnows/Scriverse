import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("作品草稿 API", () => {
  let runtime: Runtime;
  let workId: string;

  beforeEach(async () => {
    runtime = createTestRuntime();
    const work = await request(runtime.app).post("/api/works").send({ title: "草稿测试作品" }).expect(201);
    workId = String(work.body.data.id);
  });

  afterEach(() => runtime.close());

  it("创建、分类、编辑、删除并恢复正文草稿和设定草稿", async () => {
    const volume = runtime.store.createVolume(workId, { title: "第一卷" });
    const prose = await request(runtime.app).post(`/api/works/${workId}/drafts`).send({
      draftType: "prose",
      volumeId: volume.id,
      title: "开场备选",
      content: "## 备选方向\n\n让主角从失忆中醒来。"
    }).expect(201);
    const setting = await request(runtime.app).post(`/api/works/${workId}/drafts`).send({
      draftType: "setting",
      settingModule: "races",
      title: "跃迁代价猜想",
      content: "可能让每次跃迁消耗一段记忆，但不一定采用。"
    }).expect(201);

    expect(prose.body.data).toMatchObject({ draftType: "prose", volumeId: volume.id, volumeTitle: "第一卷", title: "开场备选", versionNo: 1 });
    expect(setting.body.data).toMatchObject({ draftType: "setting", settingModule: "races", title: "跃迁代价猜想", versionNo: 1 });

    const listed = await request(runtime.app).get(`/api/works/${workId}/drafts`).expect(200);
    expect(listed.body.data).toHaveLength(2);
    expect(listed.body.data[0]).toHaveProperty("contentPreview");
    expect(listed.body.data[0]).not.toHaveProperty("content");

    const settingsOnly = await request(runtime.app).get(`/api/works/${workId}/drafts?draftType=setting&includeContent=true`).expect(200);
    expect(settingsOnly.body.data).toEqual([
      expect.objectContaining({ id: setting.body.data.id, content: expect.stringContaining("不一定采用") })
    ]);

    const updated = await request(runtime.app).patch(`/api/drafts/${prose.body.data.id}`).send({
      draftType: "setting",
      settingModule: "settings",
      title: "失忆机制备选",
      content: "失忆可能来自跃迁副作用。",
      expectedVersionNo: 1,
      changeNote: "转为设定方向"
    }).expect(200);
    expect(updated.body.data).toMatchObject({ draftType: "setting", volumeId: null, settingModule: "settings", title: "失忆机制备选", versionNo: 2 });

    const versions = await request(runtime.app).get(`/api/entity-versions/draft/${prose.body.data.id}`).expect(200);
    expect(versions.body.data.map((version: { versionNo: number }) => version.versionNo)).toEqual([2, 1]);
    expect(versions.body.data[0]).toMatchObject({ changeNote: "转为设定方向", snapshot: { volumeId: null, settingModule: "settings" } });
    expect(versions.body.data[1]).toMatchObject({ snapshot: { volumeId: volume.id, settingModule: null } });

    await request(runtime.app).delete(`/api/drafts/${prose.body.data.id}`).send({ expectedVersionNo: 2 }).expect(204);
    await request(runtime.app).get(`/api/drafts/${prose.body.data.id}`).expect(404);
    const restored = await request(runtime.app).post(`/api/entity-versions/draft/${prose.body.data.id}/restore`).send({
      versionNo: 2,
      expectedVersionNo: 3
    }).expect(200);
    expect(restored.body.data).toMatchObject({ title: "失忆机制备选", content: "失忆可能来自跃迁副作用。", settingModule: "settings", versionNo: 4 });

    const exported = await request(runtime.app).get(`/api/works/${workId}/export?format=json`).expect(200);
    expect(exported.body.data).toMatchObject({ schemaVersion: 8 });
    expect(exported.body.data.drafts).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "失忆机制备选" }),
      expect.objectContaining({ title: "跃迁代价猜想" })
    ]));
    expect(runtime.database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("校验草稿类型、字段长度和 SQL 特殊字符搜索", async () => {
    await request(runtime.app).post(`/api/works/${workId}/drafts`).send({
      draftType: "idea",
      title: "无效类型",
      content: "不会创建"
    }).expect(400);
    await request(runtime.app).post(`/api/works/${workId}/drafts`).send({
      draftType: "prose",
      title: "a".repeat(201),
      content: "不会创建"
    }).expect(400);

    await request(runtime.app).post(`/api/works/${workId}/drafts`).send({
      draftType: "prose",
      title: "100% 成功率只是想法",
      content: "下划线_与百分号%都按普通字符搜索。"
    }).expect(201);
    expect(runtime.store.searchDrafts(workId, "%", undefined, 20)).toEqual([
      expect.objectContaining({ title: "100% 成功率只是想法" })
    ]);
    expect(runtime.store.searchDrafts(workId, "_", "prose", 20)).toEqual([
      expect.objectContaining({ content: expect.stringContaining("下划线_") })
    ]);
  });

  it("拒绝跨作品分卷和与想法类型不匹配的绑定", async () => {
    const otherWork = await request(runtime.app).post("/api/works").send({ title: "其他作品" }).expect(201);
    const otherVolume = runtime.store.createVolume(String(otherWork.body.data.id), { title: "外部分卷" });

    await request(runtime.app).post(`/api/works/${workId}/drafts`).send({
      draftType: "prose",
      volumeId: otherVolume.id,
      title: "越权绑定",
      content: "不会创建"
    }).expect(400);
    await request(runtime.app).post(`/api/works/${workId}/drafts`).send({
      draftType: "setting",
      volumeId: otherVolume.id,
      title: "错误绑定类型",
      content: "不会创建"
    }).expect(400);
    await request(runtime.app).post(`/api/works/${workId}/drafts`).send({
      draftType: "prose",
      settingModule: "characters",
      title: "错误绑定模块",
      content: "不会创建"
    }).expect(400);
    await request(runtime.app).post(`/api/works/${workId}/drafts`).send({
      draftType: "setting",
      settingModule: "reviews",
      title: "无效设定模块",
      content: "不会创建"
    }).expect(400);
  });

  it("分卷进入回收站时保留正文想法绑定并在恢复后继续可用", async () => {
    const volume = runtime.store.createVolume(workId, { title: "待删除分卷" });
    const draft = await request(runtime.app).post(`/api/works/${workId}/drafts`).send({
      draftType: "prose",
      volumeId: volume.id,
      title: "随分卷回退",
      content: "分卷删除后继续保留。"
    }).expect(201);

    await request(runtime.app).delete(`/api/volumes/${volume.id}`).send({ expectedVersionNo: volume.versionNo }).expect(204);
    const retainedDraft = await request(runtime.app).get(`/api/drafts/${draft.body.data.id}`).expect(200);
    expect(retainedDraft.body.data).toMatchObject({ volumeId: volume.id, volumeTitle: "待删除分卷", versionNo: 1 });
    const versions = await request(runtime.app).get(`/api/entity-versions/draft/${draft.body.data.id}`).expect(200);
    expect(versions.body.data).toHaveLength(1);
    expect(versions.body.data[0]).toMatchObject({ snapshot: { volumeId: volume.id } });
    await request(runtime.app).post(`/api/volumes/${volume.id}/restore`).send({ expectedVersionNo: 2 }).expect(200);
    const restoredDraft = await request(runtime.app).get(`/api/drafts/${draft.body.data.id}`).expect(200);
    expect(restoredDraft.body.data).toMatchObject({ volumeId: volume.id, volumeTitle: "待删除分卷", versionNo: 1 });
  });
});
