import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("作品、分卷与章节回收站", () => {
  let runtime: Runtime;

  beforeEach(() => { runtime = createTestRuntime(); });
  afterEach(() => runtime.close());

  it("软删除并恢复作品时完整保留正文、层级、设定和版本历史", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "待恢复作品" }).expect(201);
    const workId = String(work.body.data.id);
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "需要完整保留的正文。"
    }).expect(201);
    const setting = await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "潮汐规则",
      category: "世界规则",
      content: "双月重合时潮汐倒流。"
    }).expect(201);
    await request(runtime.app).put(`/api/chapters/${chapter.body.data.id}/outline`).send({ goal: "抵达港口" }).expect(200);

    const chapterVersionCount = Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM chapter_versions WHERE chapter_id = ?",
      chapter.body.data.id
    )?.count);
    const settingVersionCount = Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = 'setting' AND entity_id = ?",
      setting.body.data.id
    )?.count);

    await request(runtime.app).delete(`/api/works/${workId}`).send({ expectedVersionNo: 1 }).expect(204);
    expect((await request(runtime.app).get("/api/works").expect(200)).body.data).toEqual([]);
    await request(runtime.app).get(`/api/settings/${setting.body.data.id}`).expect(404);
    expect(runtime.database.get("SELECT deleted_at FROM works WHERE id = ?", workId)?.deleted_at).toEqual(expect.any(String));
    expect(Number(runtime.database.get("SELECT COUNT(*) AS count FROM chapter_versions WHERE chapter_id = ?", chapter.body.data.id)?.count)).toBe(chapterVersionCount);
    expect(Number(runtime.database.get("SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = 'setting' AND entity_id = ?", setting.body.data.id)?.count)).toBe(settingVersionCount);

    const recycleBin = await request(runtime.app).get("/api/recycle-bin/works").expect(200);
    expect(recycleBin.body.data).toMatchObject({ retentionDays: 30 });
    expect(recycleBin.body.data.works).toEqual([expect.objectContaining({
      id: workId,
      title: "待恢复作品",
      volumeCount: 1,
      chapterCount: 1,
      versionNo: 2,
      deletedAt: expect.any(String),
      expiresAt: expect.any(String)
    })]);

    const restored = await request(runtime.app)
      .post(`/api/recycle-bin/works/${workId}/restore`)
      .send({ expectedVersionNo: 2 })
      .expect(200);
    expect(restored.body.data.volumes[0]).toMatchObject({ id: volume.body.data.id, title: "第一卷" });
    expect(restored.body.data.volumes[0].chapters[0]).toMatchObject({ id: chapter.body.data.id, title: "第一章" });
    expect((await request(runtime.app).get(`/api/chapters/${chapter.body.data.id}`).expect(200)).body.data.content).toBe("需要完整保留的正文。");
    expect((await request(runtime.app).get(`/api/settings/${setting.body.data.id}`).expect(200)).body.data.content).toBe("双月重合时潮汐倒流。");
    expect((await request(runtime.app).get(`/api/chapters/${chapter.body.data.id}/outline`).expect(200)).body.data.goal).toBe("抵达港口");
    expect(runtime.database.all(
      "SELECT source FROM entity_versions WHERE entity_type = 'work' AND entity_id = ? ORDER BY version_no",
      workId
    )).toEqual([{ source: "create" }, { source: "delete" }, { source: "restore" }]);
    expect(runtime.database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("软删除作品仅失效活动分析任务，恢复不重启旧任务且彻底删除仍完整级联", async () => {
    runtime.ai.dispose();
    const work = runtime.store.createWork({ title: "分析任务回收站作品" });
    const workId = String(work.id);
    const pending = runtime.store.createTask(workId, { taskType: "book-analysis", scope: { type: "book" } });
    const running = runtime.store.createTask(workId, { taskType: "book-analysis", scope: { type: "book" } });
    const completed = runtime.store.createTask(workId, { taskType: "book-analysis", scope: { type: "book" } });
    const cancelled = runtime.store.createTask(workId, { taskType: "book-analysis", scope: { type: "book" } });
    const pendingId = String(pending.id);
    const runningId = String(running.id);
    const completedId = String(completed.id);
    const cancelledId = String(cancelled.id);
    expect(runtime.store.claimPendingTask(runningId)).not.toBeNull();
    runtime.store.updateTask(completedId, { status: "completed", progress: 100, result: { summary: "保留历史结果" } });
    runtime.store.cancelTask(cancelledId);
    runtime.store.updateWorkAiSettings(workId, { autoRunEnabled: true });
    runtime.database.run(
      `INSERT INTO ai_calls (id, work_id, task_id, task_type, provider_id, model_id, context_scope_json, status, created_at)
       VALUES (?, ?, ?, 'book-analysis', 'provider-history', 'model-history', '{}', 'completed', ?)`,
      "call-history",
      workId,
      completedId,
      new Date().toISOString()
    );
    runtime.database.run(
      `INSERT INTO relationship_source_index_queue (work_id, source_type, source_id, queued_at)
       VALUES (?, 'work', ?, ?)
       ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at`,
      workId,
      workId,
      new Date().toISOString()
    );
    expect(runtime.store.listAutoRunWorkIds()).toContain(workId);

    await request(runtime.app).delete(`/api/works/${workId}`).send({ expectedVersionNo: 1 }).expect(204);
    expect(runtime.database.all(
      "SELECT id, status FROM analysis_tasks WHERE work_id = ? ORDER BY id",
      workId
    )).toEqual(expect.arrayContaining([
      { id: pendingId, status: "expired" },
      { id: runningId, status: "expired" },
      { id: completedId, status: "completed" },
      { id: cancelledId, status: "cancelled" }
    ]));
    expect(runtime.database.get("SELECT result_json FROM analysis_tasks WHERE id = ?", completedId)).toEqual({
      result_json: JSON.stringify({ summary: "保留历史结果" })
    });
    expect(runtime.database.get("SELECT id, task_id FROM ai_calls WHERE id = 'call-history'")).toEqual({
      id: "call-history",
      task_id: completedId
    });
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM relationship_source_index_queue WHERE work_id = ?",
      workId
    )?.count).toBe(0);
    expect(runtime.store.listAutoRunWorkIds()).not.toContain(workId);

    const repeated = await request(runtime.app).delete(`/api/works/${workId}`).send({ expectedVersionNo: 2 }).expect(404);
    expect(repeated.body.error.code).toBe("NOT_FOUND");
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = 'work' AND entity_id = ?",
      workId
    )?.count).toBe(2);

    await request(runtime.app).post(`/api/recycle-bin/works/${workId}/restore`).send({ expectedVersionNo: 2 }).expect(200);
    expect(runtime.store.listAutoRunWorkIds()).toContain(workId);
    expect(runtime.database.all(
      "SELECT id, status FROM analysis_tasks WHERE id IN (?, ?) ORDER BY id",
      pendingId,
      runningId
    )).toEqual(expect.arrayContaining([
      { id: pendingId, status: "expired" },
      { id: runningId, status: "expired" }
    ]));

    await request(runtime.app).delete(`/api/works/${workId}`).send({ expectedVersionNo: 3 }).expect(204);
    await request(runtime.app).delete(`/api/recycle-bin/works/${workId}/permanent`).send({ expectedVersionNo: 4 }).expect(204);
    expect(runtime.database.get("SELECT id FROM analysis_tasks WHERE work_id = ?", workId)).toBeUndefined();
    expect(runtime.database.get("SELECT id FROM ai_calls WHERE id = 'call-history'")).toBeUndefined();
    expect(runtime.database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("作品删除事务失败时回滚任务失效和关系索引队列清理", async () => {
    runtime.ai.dispose();
    const work = runtime.store.createWork({ title: "删除事务回滚作品" });
    const workId = String(work.id);
    const pending = runtime.store.createTask(workId, { taskType: "book-analysis", scope: { type: "book" } });
    const running = runtime.store.createTask(workId, { taskType: "book-analysis", scope: { type: "book" } });
    runtime.store.claimPendingTask(String(running.id));
    runtime.database.run(
      `INSERT INTO relationship_source_index_queue (work_id, source_type, source_id, queued_at)
       VALUES (?, 'work', ?, ?)
       ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at`,
      workId,
      workId,
      new Date().toISOString()
    );
    runtime.database.raw.exec(`
      CREATE TRIGGER fail_work_delete_audit
      BEFORE INSERT ON audit_logs WHEN NEW.action = 'work.deleted'
      BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END;
    `);

    await request(runtime.app).delete(`/api/works/${workId}`).send({ expectedVersionNo: 1 }).expect(500);
    expect(runtime.database.get("SELECT version_no, deleted_at FROM works WHERE id = ?", workId)).toEqual({
      version_no: 1,
      deleted_at: null
    });
    expect(runtime.database.all(
      "SELECT id, status FROM analysis_tasks WHERE work_id = ? ORDER BY id",
      workId
    )).toEqual(expect.arrayContaining([
      { id: pending.id, status: "pending" },
      { id: running.id, status: "running" }
    ]));
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM relationship_source_index_queue WHERE work_id = ?",
      workId
    )?.count).toBe(1);
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = 'work' AND entity_id = ?",
      workId
    )?.count).toBe(1);
  });

  it("分卷软删除和恢复保持章节关联，彻底删除后清理历史且无悬挂外键", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "分卷恢复作品" }).expect(201);
    const workId = String(work.body.data.id);
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "远航卷" }).expect(201);
    const volumeId = String(volume.body.data.id);
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId,
      title: "启航",
      content: "飞船离港。"
    }).expect(201);
    const chapterId = String(chapter.body.data.id);
    await request(runtime.app).put(`/api/chapters/${chapterId}/outline`).send({ goal: "穿过风暴" }).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/foreshadows`).send({
      title: "失效罗盘",
      occurrences: [{ chapterId, role: "setup", note: "罗盘短暂失灵" }]
    }).expect(201);

    await request(runtime.app).delete(`/api/volumes/${volumeId}`).send({ expectedVersionNo: 1 }).expect(204);
    expect((await request(runtime.app).get(`/api/works/${workId}`).expect(200)).body.data.volumes).toEqual([]);
    await request(runtime.app).get(`/api/chapters/${chapterId}`).expect(404);
    expect(runtime.database.get("SELECT content, deleted_via_volume_id FROM chapters WHERE id = ?", chapterId)).toEqual({
      content: "飞船离港。",
      deleted_via_volume_id: volumeId
    });
    expect(runtime.database.get("SELECT chapter_id FROM chapter_outlines WHERE chapter_id = ?", chapterId)).toEqual({ chapter_id: chapterId });
    expect(runtime.database.get("SELECT chapter_id FROM foreshadow_occurrences WHERE chapter_id = ?", chapterId)).toEqual({ chapter_id: chapterId });
    const recycleBin = await request(runtime.app).get(`/api/works/${workId}/recycle-bin`).expect(200);
    expect(recycleBin.body.data).toMatchObject({ retentionDays: 30, chapters: [] });
    expect(recycleBin.body.data.volumes).toEqual([expect.objectContaining({ id: volumeId, chapterCount: 1, versionNo: 2 })]);

    await request(runtime.app).post(`/api/volumes/${volumeId}/restore`).send({ expectedVersionNo: 2 }).expect(200);
    expect((await request(runtime.app).get(`/api/chapters/${chapterId}`).expect(200)).body.data.content).toBe("飞船离港。");
    expect(runtime.database.get("SELECT deleted_at, deleted_via_volume_id FROM chapters WHERE id = ?", chapterId)).toEqual({
      deleted_at: null,
      deleted_via_volume_id: null
    });
    expect(runtime.store.searchChapterParagraphs(workId, "飞船离港")).toHaveLength(1);

    await request(runtime.app).delete(`/api/volumes/${volumeId}`).send({ expectedVersionNo: 3 }).expect(204);
    await request(runtime.app).delete(`/api/volumes/${volumeId}/permanent`).send({ expectedVersionNo: 4 }).expect(204);
    expect(runtime.database.get("SELECT id FROM volumes WHERE id = ?", volumeId)).toBeUndefined();
    expect(runtime.database.get("SELECT id FROM chapters WHERE id = ?", chapterId)).toBeUndefined();
    expect(runtime.database.all("SELECT id FROM chapter_versions WHERE chapter_id = ?", chapterId)).toEqual([]);
    expect(runtime.database.all("SELECT id FROM entity_versions WHERE entity_type = 'volume' AND entity_id = ?", volumeId)).toEqual([]);
    expect(runtime.database.all("SELECT id FROM entity_versions WHERE entity_type = 'chapter-outline' AND entity_id = ?", chapterId)).toEqual([]);
    expect(runtime.database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("删除事务在审计写入失败时完整回滚", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "事务保护" }).expect(201);
    const volume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "不可半删卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "不可半删章",
      content: "事务必须回滚。"
    }).expect(201);
    runtime.database.raw.exec(`
      CREATE TRIGGER fail_volume_delete_audit
      BEFORE INSERT ON audit_logs WHEN NEW.action = 'volume.deleted'
      BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END;
    `);

    await request(runtime.app).delete(`/api/volumes/${volume.body.data.id}`).send({ expectedVersionNo: 1 }).expect(500);
    expect(runtime.database.get("SELECT version_no, deleted_at FROM volumes WHERE id = ?", volume.body.data.id)).toEqual({ version_no: 1, deleted_at: null });
    expect(runtime.database.get("SELECT deleted_at, deleted_via_volume_id FROM chapters WHERE id = ?", chapter.body.data.id)).toEqual({
      deleted_at: null,
      deleted_via_volume_id: null
    });
    expect(runtime.database.all(
      "SELECT source FROM entity_versions WHERE entity_type = 'volume' AND entity_id = ? ORDER BY version_no",
      volume.body.data.id
    )).toEqual([{ source: "create" }]);
    expect(runtime.store.searchChapterParagraphs(String(work.body.data.id), "事务必须回滚")).toHaveLength(1);
  });

  it("按 30 天保留期自动清理到期的作品、分卷和独立章节", async () => {
    const expiredAt = "2026-06-01T00:00:00.000Z";
    const referenceTime = new Date("2026-08-12T00:00:00.000Z");

    const workTrash = await request(runtime.app).post("/api/works").send({ title: "到期作品" }).expect(201);
    await request(runtime.app).delete(`/api/works/${workTrash.body.data.id}`).send({ expectedVersionNo: 1 }).expect(204);
    runtime.database.run("UPDATE works SET deleted_at = ? WHERE id = ?", expiredAt, workTrash.body.data.id);

    const volumeWork = await request(runtime.app).post("/api/works").send({ title: "到期分卷作品" }).expect(201);
    const expiredVolume = await request(runtime.app).post(`/api/works/${volumeWork.body.data.id}/volumes`).send({ title: "到期分卷" }).expect(201);
    await request(runtime.app).delete(`/api/volumes/${expiredVolume.body.data.id}`).send({ expectedVersionNo: 1 }).expect(204);
    runtime.database.run("UPDATE volumes SET deleted_at = ? WHERE id = ?", expiredAt, expiredVolume.body.data.id);

    const chapterWork = await request(runtime.app).post("/api/works").send({ title: "到期章节作品" }).expect(201);
    const chapterVolume = await request(runtime.app).post(`/api/works/${chapterWork.body.data.id}/volumes`).send({ title: "保留分卷" }).expect(201);
    const expiredChapter = await request(runtime.app).post(`/api/works/${chapterWork.body.data.id}/chapters`).send({
      volumeId: chapterVolume.body.data.id,
      title: "到期章节"
    }).expect(201);
    await request(runtime.app).delete(`/api/chapters/${expiredChapter.body.data.id}`).send({ expectedVersionNo: 1 }).expect(204);
    runtime.database.run("UPDATE chapters SET deleted_at = ? WHERE id = ?", expiredAt, expiredChapter.body.data.id);

    expect(runtime.store.purgeExpiredRecycleBin(referenceTime)).toEqual({ works: 1, volumes: 1, chapters: 1 });
    expect(runtime.database.get("SELECT id FROM works WHERE id = ?", workTrash.body.data.id)).toBeUndefined();
    expect(runtime.database.get("SELECT id FROM volumes WHERE id = ?", expiredVolume.body.data.id)).toBeUndefined();
    expect(runtime.database.get("SELECT id FROM chapters WHERE id = ?", expiredChapter.body.data.id)).toBeUndefined();
    expect(runtime.database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
