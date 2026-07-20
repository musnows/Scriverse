import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime, seedChapter } from "../helpers.js";

async function configureAuditModel(runtime: Runtime, workId: string): Promise<string> {
  const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
    name: "角色查重模型",
    baseUrl: "https://identity-audit.test/v1",
    apiKey: "sk-character-identity-audit",
    status: "enabled",
    concurrencyLimit: 4,
    rpmLimit: 100
  }).expect(201);
  runtime.database.run("UPDATE providers SET connection_status = 'success' WHERE id = ?", provider.body.data.id);
  const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
    displayName: "角色查重模型",
    modelId: "identity-audit-model",
    purposes: ["book-analysis"]
  }).expect(201);
  return String(model.body.data.id);
}

describe("AI 角色身份审核与安全合并", () => {
  let runtime: Runtime;

  afterEach(() => runtime.close());

  it("查询作品与正文后创建审核项，并在作者确认时迁移角色引用", async () => {
    let completionRound = 0;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { tools?: Array<{ function?: { name?: string } }>; messages: Array<{ content?: string }> };
      completionRound += 1;
      if (completionRound === 1) {
        expect(body.tools?.map((tool) => tool.function?.name)).toEqual(["read_chapters", "grep", "query_story_knowledge"]);
        expect(body.messages[1]?.content).toContain("角色规范表");
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
          { id: "knowledge", type: "function", function: { name: "query_story_knowledge", arguments: JSON.stringify({ query: "安吉拉斯", categories: ["character", "relationship"] }) } },
          { id: "grep-left", type: "function", function: { name: "grep", arguments: JSON.stringify({ keyword: "安吉拉斯", limit: 20 }) } },
          { id: "grep-right", type: "function", function: { name: "grep", arguments: JSON.stringify({ keyword: "安基拉斯", limit: 20 }) } },
          ...Array.from({ length: 10 }, (_, index) => ({
            id: `extra-grep-${index}`,
            type: "function",
            function: { name: "grep", arguments: JSON.stringify({ keyword: "魔斯拉", limit: 1 }) }
          }))
        ] } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const chapterId = String(seeded.chapter.id);
      return new Response(JSON.stringify({ choices: [{ message: { content: `<json>${JSON.stringify([{
        leftCharacterId: left.id,
        rightCharacterId: right.id,
        verdict: "same",
        confidence: 0.94,
        reason: "正文明确说明两个名字属于同一角色",
        evidence: [{ chapterId, quote: "安吉拉斯又被称为安基拉斯", supports: "明确给出另一译名" }],
        contradictions: []
      }])}</json>` } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const seeded = await seedChapter(runtime, "安吉拉斯又被称为安基拉斯。魔斯拉与它长期并肩作战。");
    const work = seeded.work;
    const workId = String(work.id);
    const organization = await request(runtime.app).post(`/api/works/${workId}/organizations`).send({ name: "泰坦联盟" }).expect(201);
    const leftResponse = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "安吉拉斯",
      aliases: ["安叔"],
      organizationIds: [organization.body.data.id],
      attributes: { identity: "地球泰坦" },
      firstChapterId: seeded.chapter.id
    }).expect(201);
    const rightResponse = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "安基拉斯",
      aliases: ["安基拉斯兽"],
      organizationIds: [organization.body.data.id],
      attributes: { identity: "地球泰坦的另一译名" },
      firstChapterId: seeded.chapter.id
    }).expect(201);
    const mothraResponse = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "魔斯拉" }).expect(201);
    const left = leftResponse.body.data as { id: string };
    const right = rightResponse.body.data as { id: string };
    const mothra = mothraResponse.body.data as { id: string };
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: left.id,
      toCharacterId: mothra.id,
      category: "social",
      subtype: "盟友",
      keywords: ["共同守护"],
      directed: false,
      confidence: 0.9,
      confirmationStatus: "confirmed"
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: right.id,
      toCharacterId: mothra.id,
      category: "social",
      subtype: "盟友",
      keywords: ["长期并肩"],
      directed: false,
      confidence: 0.8,
      confirmationStatus: "confirmed"
    }).expect(201);
    const timeline = await request(runtime.app).post(`/api/works/${workId}/timeline`).send({
      name: "泰坦会合",
      participantIds: [right.id, mothra.id]
    }).expect(201);
    const modelId = await configureAuditModel(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "character-identity-audit",
      scope: { type: "book" }
    }).expect(201);
    const completed = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(completed.body.data).toMatchObject({ status: "review", result: { reviewCount: 1, toolCallCount: 13 } });
    const reviews = await request(runtime.app).get(`/api/works/${workId}/reviews`).expect(200);
    expect(reviews.body.data).toHaveLength(1);
    expect(reviews.body.data[0]).toMatchObject({ itemType: "character-duplicate", status: "pending", severity: "high" });
    const refs = reviews.body.data[0].entityRefs as Array<{ id: string; versionNo: number }>;
    const versionById = new Map(refs.map((reference) => [reference.id, reference.versionNo]));
    const merged = await request(runtime.app).post(`/api/reviews/${reviews.body.data[0].id}/character-resolution`).send({
      action: "merge",
      targetCharacterId: left.id,
      sourceCharacterId: right.id,
      expectedTargetVersionNo: versionById.get(left.id),
      expectedSourceVersionNo: versionById.get(right.id)
    }).expect(200);
    expect(merged.body.data).toMatchObject({ source: { mergedIntoCharacterId: left.id }, review: { status: "fixed" } });

    const activeCharacters = await request(runtime.app).get(`/api/works/${workId}/characters`).expect(200);
    expect(activeCharacters.body.data.map((character: { name: string }) => character.name)).toEqual(["安吉拉斯", "魔斯拉"]);
    const target = activeCharacters.body.data.find((character: { id: string }) => character.id === left.id);
    expect(target.aliases).toEqual(expect.arrayContaining(["安叔", "安基拉斯", "安基拉斯兽"]));
    expect(target.organizationIds).toContain(organization.body.data.id);
    const allCharacters = await request(runtime.app).get(`/api/works/${workId}/characters?includeMerged=1`).expect(200);
    expect(allCharacters.body.data.find((character: { id: string }) => character.id === right.id)).toMatchObject({ mergedIntoCharacterId: left.id });
    const timelineAfter = await request(runtime.app).get(`/api/timeline/${timeline.body.data.id}`).expect(200);
    expect(timelineAfter.body.data.participantIds).toEqual(expect.arrayContaining([left.id, mothra.id]));
    expect(timelineAfter.body.data.participantIds).not.toContain(right.id);
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(1);
    expect(relationships.body.data[0].keywords).toEqual(expect.arrayContaining(["共同守护", "长期并肩"]));
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM character_merges")?.count).toBe(1);
  });

  it("允许作者确认疑似组合实际是两个不同角色", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime);
    const workId = String(seeded.work.id);
    const first = runtime.store.createCharacter(workId, { name: "真酱" });
    const second = runtime.store.createCharacter(workId, { name: "真姬" });
    const review = runtime.store.createReviewItem(workId, {
      itemType: "character-duplicate",
      severity: "medium",
      title: "疑似重复角色：真酱 / 真姬",
      entityRefs: [first, second].map((character) => ({ type: "character", id: character.id, versionNo: character.versionNo }))
    });
    const resolved = await request(runtime.app).post(`/api/reviews/${review.id}/character-resolution`).send({ action: "keep-separate" }).expect(200);
    expect(resolved.body.data).toMatchObject({ status: "exception", resolutionNote: "作者确认是不同角色" });
    expect(runtime.store.listCharacters(workId)).toHaveLength(2);
  });
});
