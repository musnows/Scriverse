import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Runtime } from "../../src/app.js";
import { ftsPhrase, relationshipCharacterTokens, relationshipPinyinTokens } from "../../src/relationship-search.js";
import { createTestRuntime, seedChapter } from "../helpers.js";

describe("人物关系来源增量索引", () => {
  let runtime: Runtime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it("后台构建正文和设定索引并由并发请求共享同一次构建", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "摩斯拉从废墟中苏醒。\n\n无关段落。");
    const workId = String(seeded.work.id);
    const setting = runtime.store.createSetting(workId, {
      title: "泰坦记录",
      category: "人物",
      content: "摩斯拉负责守护生态。"
    });
    const ai = runtime.ai as unknown as { ensureRelationshipSearchIndex(workId: string): Promise<number> };
    const generations = await Promise.all(Array.from({ length: 10 }, () => ai.ensureRelationshipSearchIndex(workId)));
    expect(new Set(generations).size).toBe(1);

    const pinyinPhrase = ftsPhrase(relationshipPinyinTokens("魔斯拉"));
    expect(runtime.database.all(
      `SELECT DISTINCT paragraph.chapter_id FROM chapter_paragraph_pinyin_fts
       JOIN chapter_paragraph_search paragraph ON paragraph.id = chapter_paragraph_pinyin_fts.rowid
       WHERE chapter_paragraph_pinyin_fts MATCH ?`,
      pinyinPhrase
    )).toEqual([{ chapter_id: seeded.chapter.id }]);
    expect(runtime.database.all(
      `SELECT source.source_type, source.source_id FROM relationship_source_pinyin_fts
       JOIN relationship_source_search source ON source.id = relationship_source_pinyin_fts.rowid
       WHERE relationship_source_pinyin_fts MATCH ?`,
      pinyinPhrase
    )).toContainEqual({ source_type: "setting", source_id: setting.id });
    expect(runtime.database.all(
      `SELECT source.source_id FROM relationship_source_exact_fts
       JOIN relationship_source_search source ON source.id = relationship_source_exact_fts.rowid
       WHERE relationship_source_exact_fts MATCH ?`,
      ftsPhrase(relationshipCharacterTokens("摩斯拉"))
    )).toContainEqual({ source_id: setting.id });

    const before = Number(runtime.database.get(
      "SELECT generation FROM relationship_source_index_state WHERE work_id = ?",
      workId
    )?.generation ?? 0);
    runtime.store.updateSetting(String(setting.id), { content: "拉顿负责守护火山。" });
    const after = await ai.ensureRelationshipSearchIndex(workId);
    expect(after).toBe(before + 1);
    expect(runtime.database.all(
      `SELECT source.source_id FROM relationship_source_pinyin_fts
       JOIN relationship_source_search source ON source.id = relationship_source_pinyin_fts.rowid
       WHERE relationship_source_pinyin_fts MATCH ?`,
      pinyinPhrase
    )).not.toContainEqual({ source_id: setting.id });

    runtime.store.deleteSetting(String(setting.id));
    await ai.ensureRelationshipSearchIndex(workId);
    expect(runtime.database.get(
      "SELECT id FROM relationship_source_search WHERE source_type = 'setting' AND source_id = ?",
      setting.id as string
    )).toBeUndefined();
  });

  it("可从作品 AI 设置主动重建存量拼音索引", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "摩斯拉从废墟中苏醒。");
    const workId = String(seeded.work.id);
    const ai = runtime.ai as unknown as { ensureRelationshipSearchIndex(workId: string): Promise<number> };
    await ai.ensureRelationshipSearchIndex(workId);
    runtime.database.run(
      `DELETE FROM chapter_paragraph_pinyin_fts WHERE rowid IN (
         SELECT id FROM chapter_paragraph_search WHERE work_id = ?
       )`,
      workId
    );

    const before = await request(runtime.app)
      .get(`/api/works/${workId}/ai-settings/relationship-search-index`)
      .expect(200);
    expect(before.body.data.indexedParagraphCount).toBe(0);

    const queued = await request(runtime.app)
      .post(`/api/works/${workId}/ai-settings/relationship-search-index/rebuild`)
      .send({})
      .expect(202);
    expect(queued.body.data.status).toBe("queued");
    expect(queued.body.data.queuedSourceCount).toBeGreaterThan(0);
    await ai.ensureRelationshipSearchIndex(workId);

    const after = await request(runtime.app)
      .get(`/api/works/${workId}/ai-settings/relationship-search-index`)
      .expect(200);
    expect(after.body.data).toMatchObject({ status: "ready", queuedSourceCount: 0, indexedParagraphCount: 1 });
    expect(runtime.database.get("PRAGMA integrity_check")?.integrity_check).toBe("ok");
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("可从作品 AI 设置查看并主动同步增量任务队列", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "魔斯拉守护森林。");
    const workId = String(seeded.work.id);
    const setting = runtime.store.createSetting(workId, {
      title: "泰坦记录",
      category: "人物",
      content: "魔斯拉负责守护生态。"
    });
    const ai = runtime.ai as unknown as { ensureRelationshipSearchIndex(workId: string): Promise<number> };
    await ai.ensureRelationshipSearchIndex(workId);
    const initial = await request(runtime.app)
      .get(`/api/works/${workId}/ai-settings/relationship-search-index`)
      .expect(200);

    runtime.store.updateSetting(String(setting.id), { content: "拉顿负责守护火山。" });
    const queued = await request(runtime.app)
      .get(`/api/works/${workId}/ai-settings/relationship-search-index`)
      .expect(200);
    expect(queued.body.data).toMatchObject({
      status: "queued",
      queuedSourceCount: 1,
      queuedSources: [{ sourceType: "setting", count: 1 }]
    });
    expect(queued.body.data.queuedSources[0].oldestQueuedAt).not.toBe("");

    const syncing = await request(runtime.app)
      .post(`/api/works/${workId}/ai-settings/relationship-search-index/sync`)
      .send({})
      .expect(202);
    expect(syncing.body.data).toMatchObject({ status: "queued", queuedSourceCount: 1 });
    await ai.ensureRelationshipSearchIndex(workId);

    const ready = await request(runtime.app)
      .get(`/api/works/${workId}/ai-settings/relationship-search-index`)
      .expect(200);
    expect(ready.body.data).toMatchObject({
      status: "ready",
      generation: initial.body.data.generation + 1,
      queuedSourceCount: 0,
      queuedSources: []
    });
    expect(runtime.database.all(
      `SELECT source.source_id FROM relationship_source_pinyin_fts
       JOIN relationship_source_search source ON source.id = relationship_source_pinyin_fts.rowid
       WHERE relationship_source_pinyin_fts MATCH ?`,
      ftsPhrase(relationshipPinyinTokens("拉顿"))
    )).toContainEqual({ source_id: setting.id });
    expect(runtime.database.get("PRAGMA integrity_check")?.integrity_check).toBe("ok");
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("编辑停顿两秒后自动消费增量索引队列", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "魔斯拉守护森林。");
    const workId = String(seeded.work.id);
    const setting = runtime.store.createSetting(workId, {
      title: "泰坦记录",
      category: "人物",
      content: "魔斯拉负责守护生态。"
    });
    const ai = runtime.ai as unknown as { ensureRelationshipSearchIndex(workId: string): Promise<number> };
    await ai.ensureRelationshipSearchIndex(workId);
    const before = Number(runtime.database.get(
      "SELECT generation FROM relationship_source_index_state WHERE work_id = ?",
      workId
    )?.generation ?? 0);

    runtime.store.updateSetting(String(setting.id), { content: "拉顿负责守护火山。" });
    expect(runtime.ai.getRelationshipSearchIndexStatus(workId)).toMatchObject({
      status: "queued",
      generation: before,
      queuedSourceCount: 1
    });

    await new Promise((resolve) => setTimeout(resolve, 2_100));
    await ai.ensureRelationshipSearchIndex(workId);
    expect(runtime.ai.getRelationshipSearchIndexStatus(workId)).toMatchObject({
      status: "ready",
      generation: before + 1,
      queuedSourceCount: 0
    });
    expect(runtime.database.all(
      `SELECT source.source_id FROM relationship_source_pinyin_fts
       JOIN relationship_source_search source ON source.id = relationship_source_pinyin_fts.rowid
       WHERE relationship_source_pinyin_fts MATCH ?`,
      ftsPhrase(relationshipPinyinTokens("拉顿"))
    )).toContainEqual({ source_id: setting.id });
  });

  it("忽略命中过多来源的高频拼音音节", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "无关正文。");
    const workId = String(seeded.work.id);
    for (let index = 0; index < 201; index += 1) {
      runtime.store.createSetting(workId, {
        title: `日常记录 ${index + 1}`,
        category: "背景",
        content: `压点是日常描述 ${index + 1}。`
      });
    }
    const ai = runtime.ai as unknown as {
      ensureRelationshipSearchIndex(workId: string): Promise<number>;
      relationshipFuzzyIndexMatches(workId: string, reference: string, includeSettings: boolean, scope: Record<string, unknown>): Set<string>;
    };
    await ai.ensureRelationshipSearchIndex(workId);

    expect(ai.relationshipFuzzyIndexMatches(workId, "雅典娜", true, { type: "book", includeAllSettings: true })).toEqual(new Set());
  });

  it("父种族更新会重建后代种族和成员的人物关系索引", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "无关正文。");
    const workId = String(seeded.work.id);
    const parent = runtime.store.createRace(workId, { name: "泰坦", settings: ["拥有星髓印记"] });
    const child = runtime.store.createRace(workId, { name: "守望泰坦", parentRaceId: String(parent.id) });
    const character = runtime.store.createCharacter(workId, { name: "魔斯拉", raceId: String(child.id) });
    const ai = runtime.ai as unknown as { ensureRelationshipSearchIndex(workId: string): Promise<number> };
    await ai.ensureRelationshipSearchIndex(workId);

    const matchingSourceIds = (): string[] => runtime!.database.all(
      `SELECT source.source_id FROM relationship_source_exact_fts
       JOIN relationship_source_search source ON source.id = relationship_source_exact_fts.rowid
       WHERE relationship_source_exact_fts MATCH ?`,
      ftsPhrase(relationshipCharacterTokens("星髓印记"))
    ).map((row) => String(row.source_id));
    expect(matchingSourceIds()).toEqual(expect.arrayContaining([String(parent.id), String(child.id), String(character.id)]));

    runtime.store.updateRace(String(parent.id), { settings: ["拥有生态感知"] });
    await ai.ensureRelationshipSearchIndex(workId);
    expect(matchingSourceIds()).not.toEqual(expect.arrayContaining([String(parent.id), String(child.id), String(character.id)]));
    expect(runtime.database.get("PRAGMA integrity_check")?.integrity_check).toBe("ok");
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("分卷改名会重建引用卷标题的伏笔来源索引", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "无关正文。");
    const workId = String(seeded.work.id);
    runtime.store.updateVolume(String(seeded.volume.id), { title: "魔斯拉卷" });
    const foreshadow = runtime.store.createForeshadow(workId, {
      title: "远航线索",
      description: "记录一次普通远航。",
      occurrences: [{ chapterId: String(seeded.chapter.id), role: "setup", note: "首次出现" }]
    });
    const ai = runtime.ai as unknown as { ensureRelationshipSearchIndex(workId: string): Promise<number> };
    await ai.ensureRelationshipSearchIndex(workId);

    const matchingForeshadowIds = (): string[] => runtime!.database.all(
      `SELECT source.source_id FROM relationship_source_exact_fts
       JOIN relationship_source_search source ON source.id = relationship_source_exact_fts.rowid
       WHERE source.source_type = 'foreshadow' AND relationship_source_exact_fts MATCH ?`,
      ftsPhrase(relationshipCharacterTokens("魔斯拉"))
    ).map((row) => String(row.source_id));
    expect(matchingForeshadowIds()).toContain(String(foreshadow.id));

    runtime.store.updateVolume(String(seeded.volume.id), { title: "无关卷" });
    await ai.ensureRelationshipSearchIndex(workId);
    expect(matchingForeshadowIds()).not.toContain(String(foreshadow.id));
    expect(runtime.database.get("PRAGMA integrity_check")?.integrity_check).toBe("ok");
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
