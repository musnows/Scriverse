import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime, seedChapter } from "../helpers.js";

describe("组织、角色与种族人工管理", () => {
  let runtime: Runtime;

  beforeEach(() => { runtime = createTestRuntime(); });
  afterEach(() => runtime.close());

  it("人工合并角色并迁移档案章节、时间线与人物关系", async () => {
    const seeded = await seedChapter(runtime);
    const workId = String(seeded.work.id);
    const target = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "林舟",
      aliases: ["舰长"],
      attributes: { identity: "北港领航员" }
    }).expect(201);
    const source = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "林船长",
      aliases: ["阿舟"],
      profile: { summary: "林舟的另一份档案" }
    }).expect(201);
    const companion = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const section = await request(runtime.app).post(`/api/characters/${source.body.data.id}/sections`).send({
      title: "航行经历",
      contentMarkdown: "曾穿越北港风暴。"
    }).expect(201);
    const timeline = await request(runtime.app).post(`/api/works/${workId}/timeline`).send({
      name: "北港启航",
      participantIds: [source.body.data.id, companion.body.data.id]
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: source.body.data.id,
      toCharacterId: companion.body.data.id,
      category: "social",
      subtype: "旧友",
      confirmationStatus: "confirmed"
    }).expect(201);

    const merged = await request(runtime.app).post(`/api/characters/${source.body.data.id}/merge`).send({
      targetCharacterId: target.body.data.id,
      expectedTargetVersionNo: target.body.data.versionNo,
      expectedSourceVersionNo: source.body.data.versionNo
    }).expect(200);
    expect(merged.body.data).toMatchObject({
      target: { id: target.body.data.id },
      source: { id: source.body.data.id, mergedIntoCharacterId: target.body.data.id },
      review: null
    });
    expect(merged.body.data.target.aliases).toEqual(expect.arrayContaining(["舰长", "林船长", "阿舟"]));

    const sections = await request(runtime.app).get(`/api/characters/${target.body.data.id}/sections`).expect(200);
    expect(sections.body.data).toEqual([expect.objectContaining({ id: section.body.data.id, characterId: target.body.data.id })]);
    const timelineAfter = await request(runtime.app).get(`/api/timeline/${timeline.body.data.id}`).expect(200);
    expect(timelineAfter.body.data.participantIds).toEqual(expect.arrayContaining([target.body.data.id, companion.body.data.id]));
    expect(timelineAfter.body.data.participantIds).not.toContain(source.body.data.id);
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toEqual([expect.objectContaining({
      fromCharacterId: expect.any(String),
      toCharacterId: expect.any(String)
    })]);
    expect([relationships.body.data[0].fromCharacterId, relationships.body.data[0].toCharacterId]).toEqual(
      expect.arrayContaining([target.body.data.id, companion.body.data.id])
    );
    expect(runtime.database.get("SELECT review_id FROM character_merges WHERE source_character_id = ?", source.body.data.id)).toEqual({ review_id: null });
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("人工合并祖先种族并迁移角色、子种族和共同设定", async () => {
    const seeded = await seedChapter(runtime);
    const workId = String(seeded.work.id);
    const source = await request(runtime.app).post(`/api/works/${workId}/races`).send({
      name: "泰坦",
      description: "远古巨兽族群。",
      settings: ["体型巨大"]
    }).expect(201);
    const branch = await request(runtime.app).post(`/api/works/${workId}/races`).send({
      name: "陆生泰坦",
      parentRaceId: source.body.data.id
    }).expect(201);
    const target = await request(runtime.app).post(`/api/works/${workId}/races`).send({
      name: "守护泰坦",
      parentRaceId: branch.body.data.id,
      description: "守护生态平衡。",
      settings: ["自然共鸣"]
    }).expect(201);
    const sibling = await request(runtime.app).post(`/api/works/${workId}/races`).send({
      name: "海生泰坦",
      parentRaceId: source.body.data.id
    }).expect(201);
    const sourceMember = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "哥斯拉",
      raceId: source.body.data.id
    }).expect(201);
    const targetMember = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "魔斯拉",
      raceId: target.body.data.id
    }).expect(201);

    const merged = await request(runtime.app).post(`/api/races/${source.body.data.id}/merge`).send({
      targetRaceId: target.body.data.id
    }).expect(200);
    expect(merged.body.data.target).toMatchObject({
      id: target.body.data.id,
      parentRaceId: null,
      memberIds: expect.arrayContaining([sourceMember.body.data.id, targetMember.body.data.id]),
      settings: expect.arrayContaining(["体型巨大", "自然共鸣"])
    });
    expect(merged.body.data.target.description).toContain("远古巨兽族群");
    await request(runtime.app).get(`/api/races/${source.body.data.id}`).expect(404);
    expect((await request(runtime.app).get(`/api/races/${branch.body.data.id}`).expect(200)).body.data.parentRaceId).toBe(target.body.data.id);
    expect((await request(runtime.app).get(`/api/races/${sibling.body.data.id}`).expect(200)).body.data.parentRaceId).toBe(target.body.data.id);
    expect((await request(runtime.app).get(`/api/characters/${sourceMember.body.data.id}`).expect(200)).body.data).toMatchObject({
      raceId: target.body.data.id,
      species: "守护泰坦"
    });
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("人工合并组织并保留成员资料、简介与组织设定", async () => {
    const seeded = await seedChapter(runtime);
    const workId = String(seeded.work.id);
    const firstMember = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    const secondMember = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const target = await request(runtime.app).post(`/api/works/${workId}/organizations`).send({
      name: "北港守望会",
      description: "守卫北港。",
      settings: ["使用星图徽记"],
      memberIds: [firstMember.body.data.id]
    }).expect(201);
    const source = await request(runtime.app).post(`/api/works/${workId}/organizations`).send({
      name: "北港守卫队",
      description: "负责巡航。",
      settings: ["夜间轮值"],
      memberIds: [secondMember.body.data.id]
    }).expect(201);
    runtime.database.run(
      "UPDATE character_organization_memberships SET role = ?, note = ? WHERE character_id = ? AND organization_id = ?",
      "队长",
      "负责夜航",
      secondMember.body.data.id,
      source.body.data.id
    );

    const merged = await request(runtime.app).post(`/api/organizations/${source.body.data.id}/merge`).send({
      targetOrganizationId: target.body.data.id
    }).expect(200);
    expect(merged.body.data.target).toMatchObject({
      id: target.body.data.id,
      memberIds: expect.arrayContaining([firstMember.body.data.id, secondMember.body.data.id]),
      settings: expect.arrayContaining(["使用星图徽记", "夜间轮值"])
    });
    expect(merged.body.data.target.description).toContain("负责巡航");
    expect(merged.body.data.target.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ characterId: secondMember.body.data.id, role: "队长", note: "负责夜航" })
    ]));
    await request(runtime.app).get(`/api/organizations/${source.body.data.id}`).expect(404);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("拒绝把组织、角色或种族合并到其他作品的档案", async () => {
    const first = await seedChapter(runtime);
    const secondWork = await request(runtime.app).post("/api/works").send({ title: "另一作品" }).expect(201);
    const firstWorkId = String(first.work.id);
    const secondWorkId = String(secondWork.body.data.id);
    const sourceCharacter = await request(runtime.app).post(`/api/works/${firstWorkId}/characters`).send({ name: "林舟" }).expect(201);
    const targetCharacter = await request(runtime.app).post(`/api/works/${secondWorkId}/characters`).send({ name: "异界林舟" }).expect(201);
    const sourceRace = await request(runtime.app).post(`/api/works/${firstWorkId}/races`).send({ name: "人类" }).expect(201);
    const targetRace = await request(runtime.app).post(`/api/works/${secondWorkId}/races`).send({ name: "异界人类" }).expect(201);
    const sourceOrganization = await request(runtime.app).post(`/api/works/${firstWorkId}/organizations`).send({ name: "北港" }).expect(201);
    const targetOrganization = await request(runtime.app).post(`/api/works/${secondWorkId}/organizations`).send({ name: "南港" }).expect(201);

    await request(runtime.app).post(`/api/characters/${sourceCharacter.body.data.id}/merge`).send({
      targetCharacterId: targetCharacter.body.data.id,
      expectedTargetVersionNo: targetCharacter.body.data.versionNo,
      expectedSourceVersionNo: sourceCharacter.body.data.versionNo
    }).expect(400);
    await request(runtime.app).post(`/api/races/${sourceRace.body.data.id}/merge`).send({ targetRaceId: targetRace.body.data.id }).expect(400);
    await request(runtime.app).post(`/api/organizations/${sourceOrganization.body.data.id}/merge`).send({
      targetOrganizationId: targetOrganization.body.data.id
    }).expect(400);
    expect(runtime.store.listCharacters(firstWorkId)).toHaveLength(1);
    expect(runtime.store.listRaces(firstWorkId)).toHaveLength(1);
    expect(runtime.store.listOrganizations(firstWorkId)).toHaveLength(1);
  });
});
