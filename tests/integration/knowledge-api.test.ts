import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("设定、角色、时间轴、关系和审核 API", () => {
  let runtime: Runtime;
  let workId: string;

  beforeEach(async () => {
    runtime = createTestRuntime();
    const response = await request(runtime.app).post("/api/works").send({ title: "知识库作品" });
    workId = response.body.data.id;
  });
  afterEach(() => runtime.close());

  it("维护锁定设定、角色属性和带证据的跨章关系", async () => {
    const setting = await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "跃迁规则",
      category: "世界规则",
      content: "跃迁后必须冷却十二小时。",
      locked: true,
      status: "confirmed",
      evidence: [{ chapterId: "chapter-1", quote: "引擎进入冷却" }]
    }).expect(201);
    expect(setting.body.data).toMatchObject({ locked: true, status: "confirmed" });

    const first = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "林舟",
      aliases: ["舰长"],
      attributes: { species: "人类" },
      lockedFields: ["species"]
    }).expect(201);
    const second = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);

    const relationship = await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: first.body.data.id,
      toCharacterId: second.body.data.id,
      category: "social",
      subtype: "旧友",
      confidence: 0.88,
      evidence: [{ chapterId: "chapter-2", quote: "她仍记得林舟" }]
    }).expect(201);
    expect(relationship.body.data).toMatchObject({ subtype: "旧友", confidence: 0.88 });

    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: first.body.data.id,
      toCharacterId: first.body.data.id,
      category: "social"
    }).expect(400);

    const filtered = await request(runtime.app).get(`/api/works/${workId}/relationships?minimumConfidence=0.9`).expect(200);
    expect(filtered.body.data).toHaveLength(0);
  });

  it("维护候选事件和审核处理状态", async () => {
    const event = await request(runtime.app).post(`/api/works/${workId}/timeline`).send({
      name: "北港失联",
      description: "北港与主星失去联系。",
      timeLabel: "启航后三日",
      timeSort: 3,
      status: "candidate",
      evidence: [{ quote: "通讯彻底中断" }]
    }).expect(201);
    expect(event.body.data.status).toBe("candidate");

    const review = await request(runtime.app).post(`/api/works/${workId}/reviews`).send({
      itemType: "timeline-conflict",
      severity: "high",
      title: "人物同时出现在两地",
      description: "同一时间出现在北港和主星。"
    }).expect(201);
    const resolved = await request(runtime.app).patch(`/api/reviews/${review.body.data.id}`).send({
      status: "exception",
      resolutionNote: "该段为回忆。"
    }).expect(200);
    expect(resolved.body.data).toMatchObject({ status: "exception", resolutionNote: "该段为回忆。" });
  });

  it("支持为同一作品建立多个独立时间轴并归类事件", async () => {
    const expedition = await request(runtime.app).post(`/api/works/${workId}/timeline-tracks`).send({
      name: "远征主线",
      description: "记录远征舰队的关键节点。"
    }).expect(201);
    const home = await request(runtime.app).post(`/api/works/${workId}/timeline-tracks`).send({
      name: "故乡支线"
    }).expect(201);
    const tracks = await request(runtime.app).get(`/api/works/${workId}/timeline-tracks`).expect(200);
    expect(tracks.body.data.map((track: { name: string }) => track.name)).toEqual(["远征主线", "故乡支线"]);

    const event = await request(runtime.app).post(`/api/works/${workId}/timeline`).send({
      name: "舰队启航",
      trackId: expedition.body.data.id,
      timeLabel: "远征第一日"
    }).expect(201);
    expect(event.body.data.trackId).toBe(expedition.body.data.id);
    const moved = await request(runtime.app).patch(`/api/timeline/${event.body.data.id}`).send({ trackId: home.body.data.id }).expect(200);
    expect(moved.body.data.trackId).toBe(home.body.data.id);

    await request(runtime.app).delete(`/api/timeline-tracks/${home.body.data.id}`).expect(204);
    const ungrouped = await request(runtime.app).get(`/api/timeline/${event.body.data.id}`).expect(200);
    expect(ungrouped.body.data.trackId).toBeNull();
  });

  it("合并和拆分时间轴事件时保留参与者与证据", async () => {
    const first = await request(runtime.app).post(`/api/works/${workId}/timeline`).send({
      name: "警报触发",
      description: "北港响起警报。",
      timeLabel: "启航日",
      timeSort: 1,
      chapterIds: ["chapter-a"],
      participantIds: ["character-a"],
      evidence: [{ quote: "警报响起" }],
      status: "confirmed"
    }).expect(201);
    const second = await request(runtime.app).post(`/api/works/${workId}/timeline`).send({
      name: "飞船离港",
      description: "飞船驶离北港。",
      timeLabel: "启航日",
      timeSort: 2,
      chapterIds: ["chapter-b"],
      participantIds: ["character-b"],
      evidence: [{ quote: "引擎点火" }],
      status: "candidate"
    }).expect(201);

    const merged = await request(runtime.app).post(`/api/works/${workId}/timeline/merge`).send({
      eventIds: [first.body.data.id, second.body.data.id],
      name: "北港启航"
    }).expect(201);
    expect(merged.body.data).toMatchObject({ name: "北港启航", timeSort: 1, status: "pending" });
    expect(merged.body.data.chapterIds).toEqual(["chapter-a", "chapter-b"]);
    expect(merged.body.data.evidence).toHaveLength(2);
    await request(runtime.app).get(`/api/timeline/${first.body.data.id}`).expect(404);

    const split = await request(runtime.app).post(`/api/timeline/${merged.body.data.id}/split`).send({
      parts: [
        { name: "警报阶段", timeSort: 1 },
        { name: "离港阶段", timeSort: 2 }
      ]
    }).expect(201);
    expect(split.body.data.map((item: { name: string }) => item.name)).toEqual(["警报阶段", "离港阶段"]);
    expect(split.body.data.every((item: { evidence: unknown[] }) => item.evidence.length === 2)).toBe(true);
  });

  it("统一检索并导出不含供应商凭据的知识包", async () => {
    await request(runtime.app).post(`/api/works/${workId}/settings`).send({ title: "北港", category: "地点与地图", content: "北港是边境空间站。" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟", aliases: ["北港舰长"] }).expect(201);
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "私有接口",
      baseUrl: "https://ai.example.test/v1",
      apiKey: "sk-never-export-this-value",
      status: "disabled"
    }).expect(201);
    expect(JSON.stringify(provider.body)).not.toContain("never-export-this");

    const search = await request(runtime.app).get(`/api/works/${workId}/search?q=${encodeURIComponent("北港")}`).expect(200);
    expect(search.body.data.map((item: { type: string }) => item.type).sort()).toEqual(["character", "setting"]);

    const exported = await request(runtime.app).get(`/api/works/${workId}/export?format=json`).expect(200);
    const serialized = JSON.stringify(exported.body);
    expect(serialized).toContain("北港是边境空间站");
    expect(serialized).not.toContain("sk-never-export-this-value");
    expect(serialized).not.toContain("encrypted_key");
  });
});
