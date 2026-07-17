import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

async function configureModel(runtime: Runtime, workId: string): Promise<string> {
  const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
    name: "设定抽取测试模型",
    baseUrl: "https://setting-ai.test/v1",
    apiKey: "sk-setting-test",
    status: "enabled",
    concurrencyLimit: 4,
    rpmLimit: 1000
  }).expect(201);
  runtime.database.run("UPDATE providers SET connection_status = 'success' WHERE id = ?", provider.body.data.id);
  const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
    displayName: "设定抽取模型",
    modelId: "setting-model"
  }).expect(201);
  return model.body.data.id as string;
}

describe("设定抽取任务", () => {
  let runtime: Runtime | null = null;

  afterEach(() => runtime?.close());

  it("创建可审核候选、合并后续证据且不覆盖作者设定", async () => {
    let chapterIds: string[] = [];
    let callIndex = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const candidates = callIndex === 0
        ? [
            {
              title: "潮汐能源规则",
              category: "科技与物品",
              content: "北港灯塔依靠潮汐能源。",
              tags: ["北港", "能源"],
              confidence: 0.88,
              evidence: [{ chapterId: chapterIds[0], chapterTitle: "伪造标题", quote: "北港灯塔依靠潮汐能源运转。" }]
            },
            {
              title: "北港禁飞令",
              category: "世界规则",
              content: "AI 试图覆盖作者设定。",
              tags: ["禁飞"],
              confidence: 0.95,
              evidence: [{ chapterId: chapterIds[0], chapterTitle: "第一章", quote: "禁飞令仍然有效。" }]
            },
            {
              title: "虚构王朝",
              category: "历史与年代",
              content: "正文中不存在的王朝。",
              tags: [],
              confidence: 0.99,
              evidence: [{ chapterId: chapterIds[0], chapterTitle: "第一章", quote: "不存在的原文引文" }]
            }
          ]
        : [
            {
              title: "潮汐能源规则",
              category: "科技与物品",
              content: "北港灯塔和外海浮标都依靠潮汐能源，退潮后由储能塔接管。",
              tags: ["储能塔", "能源"],
              confidence: 0.94,
              evidence: [{ chapterId: chapterIds[1], chapterTitle: "第二章", quote: "退潮后，储能塔接管外海浮标。" }]
            }
          ];
      callIndex += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(candidates) } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    runtime = createTestRuntime(fetchMock);
    const work = await request(runtime.app).post("/api/works").send({ title: "北港纪事" }).expect(201);
    const workId = work.body.data.id as string;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
    const first = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章 灯塔",
      content: "北港灯塔依靠潮汐能源运转。禁飞令仍然有效。"
    }).expect(201);
    const second = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第二章 退潮",
      content: "退潮后，储能塔接管外海浮标。"
    }).expect(201);
    chapterIds = [first.body.data.id as string, second.body.data.id as string];
    const protectedSetting = await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "北港禁飞令",
      category: "世界规则",
      content: "只有作者能修改这条设定。",
      status: "confirmed",
      locked: true
    }).expect(201);
    const modelId = await configureModel(runtime, workId);

    const firstTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "setting-extraction",
      scope: { type: "book" }
    }).expect(201);
    const firstRun = await request(runtime.app).post(`/api/tasks/${firstTask.body.data.id}/run`).send({ modelId }).expect(200);
    expect(firstRun.body.data.result).toMatchObject({
      candidateCount: 1,
      rawCandidateCount: 3,
      createdCount: 1,
      updatedCount: 0,
      coveredChapterCount: 2
    });
    expect(firstRun.body.data.result.skipped).toHaveLength(2);

    const secondTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "setting-extraction",
      scope: { type: "book" }
    }).expect(201);
    const secondRun = await request(runtime.app).post(`/api/tasks/${secondTask.body.data.id}/run`).send({ modelId }).expect(200);
    expect(secondRun.body.data.result).toMatchObject({ candidateCount: 1, createdCount: 0, updatedCount: 1 });

    const settings = await request(runtime.app).get(`/api/works/${workId}/settings`).expect(200);
    expect(settings.body.data).toHaveLength(2);
    const protectedAfter = settings.body.data.find((item: { id: string }) => item.id === protectedSetting.body.data.id);
    expect(protectedAfter).toMatchObject({ content: "只有作者能修改这条设定。", status: "confirmed", locked: true });
    const candidate = settings.body.data.find((item: { title: string }) => item.title === "潮汐能源规则");
    expect(candidate).toMatchObject({
      category: "科技与物品",
      status: "pending",
      locked: false,
      content: "北港灯塔和外海浮标都依靠潮汐能源，退潮后由储能塔接管。",
      tags: ["北港", "能源", "储能塔"]
    });
    expect(candidate.evidence).toHaveLength(2);
    expect(candidate.evidence.map((item: { chapterTitle: string }) => item.chapterTitle)).toEqual(["第一章 灯塔", "第二章 退潮"]);
    expect(candidate.scope.chapterIds).toEqual(chapterIds);

    const confirmed = await request(runtime.app).patch(`/api/settings/${candidate.id}`).send({
      status: "confirmed",
      changeNote: "确认 AI 设定候选"
    }).expect(200);
    expect(confirmed.body.data.status).toBe("confirmed");
  });
});
