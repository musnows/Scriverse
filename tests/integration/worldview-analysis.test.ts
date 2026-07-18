import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

async function configureModel(runtime: Runtime, workId: string): Promise<string> {
  const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
    name: "世界观测试模型",
    baseUrl: "https://worldview-ai.test/v1",
    apiKey: "sk-worldview-test",
    status: "enabled",
    concurrencyLimit: 4,
    rpmLimit: 1000
  }).expect(201);
  runtime.database.run("UPDATE providers SET connection_status = 'success' WHERE id = ?", provider.body.data.id);
  const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
    displayName: "世界观模型",
    modelId: "worldview-model"
  }).expect(201);
  return model.body.data.id as string;
}

describe("世界观分析任务", () => {
  let runtime: Runtime | null = null;

  afterEach(() => runtime?.close());

  it("生成带可核验证据的结构化报告并过滤伪造引文", async () => {
    let chapterId = "";
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      expect(body.messages.some((message) => message.content.includes("世界观"))).toBe(true);
      expect(body.messages.find((message) => message.role === "system")?.content).toContain("最终 JSON 必须且只能放在唯一一对 <json> 和 </json> 标签中");
      expect(body.messages.at(-1)?.content).toContain("标签外不要输出任何内容，也不要使用 Markdown 代码块");
      const analysis = JSON.stringify({
        summary: "北港以潮汐能源维持城市运转。",
        dimensions: [
          {
            category: "科技与能力",
            title: "潮汐能源",
            conclusion: "城市依赖可预测的潮汐供能。",
            confidence: 0.92,
            evidence: [{ chapterId, chapterTitle: "伪造标题", quote: "北港依靠潮汐能源维持灯塔与航道。" }]
          },
          {
            category: "历史与文明",
            title: "虚构王朝",
            conclusion: "王朝统治北港。",
            confidence: 0.99,
            evidence: [{ chapterId, chapterTitle: "第一章", quote: "正文不存在的王朝引文" }]
          }
        ],
        conflicts: [{
          title: "供能周期冲突",
          description: "潮落期间的供能来源尚不明确。",
          evidence: [{ chapterId, chapterTitle: "第一章", quote: "退潮后能源会中断两个小时。" }]
        }],
        uncertainties: [
          {
            question: "备用能源是什么？",
            reason: "正文没有说明。",
            evidence: [{ chapterId: "第一章", chapterTitle: "潮汐", quote: "退潮后能源会中断两个小时。" }]
          },
          {
            question: "异乡制度是什么？",
            reason: "证据来自范围外章节。",
            evidence: [{ chapterId: "第二章", chapterTitle: "异乡", quote: "退潮后能源会中断两个小时。" }]
          }
        ]
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: `<think><json>{"status":"planning"}</json></think>\n分析完成：\n<json>${analysis}</json>` } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const work = await request(runtime.app).post("/api/works").send({ title: "北港纪事" }).expect(201);
    const workId = work.body.data.id as string;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章 潮汐",
      content: "北港依靠潮汐能源维持灯塔与航道。退潮后能源会中断两个小时。"
    }).expect(201);
    chapterId = chapter.body.data.id as string;
    const modelId = await configureModel(runtime, workId);

    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "worldview-analysis",
      scope: { type: "book" }
    }).expect(201);
    const completed = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);

    expect(completed.body.data).toMatchObject({ status: "review", taskType: "worldview-analysis" });
    expect(completed.body.data.result).toMatchObject({
      summary: "北港以潮汐能源维持城市运转。",
      dimensionCount: 1,
      omittedDimensionCount: 1,
      coveredChapterCount: 1
    });
    expect(completed.body.data.result.dimensions[0]).toMatchObject({
      category: "科技与能力",
      title: "潮汐能源",
      evidence: [{ chapterId, chapterTitle: "第一章 潮汐", quote: "北港依靠潮汐能源维持灯塔与航道。" }]
    });
    expect(completed.body.data.result.conflicts[0].evidence[0].chapterTitle).toBe("第一章 潮汐");
    expect(completed.body.data.result.uncertainties).toHaveLength(1);
    expect(completed.body.data.result.uncertainties[0]).toMatchObject({ question: "备用能源是什么？" });
  });

  it("拒绝没有任何分析内容的成功结果", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ summary: "", dimensions: [], conflicts: [], uncertainties: [] }) } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    runtime = createTestRuntime(fetchMock);
    const work = await request(runtime.app).post("/api/works").send({ title: "空分析测试" }).expect(201);
    const workId = work.body.data.id as string;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "城墙以潮汐能源维持运转。"
    }).expect(201);
    const modelId = await configureModel(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "worldview-analysis",
      scope: { type: "chapter", chapterId: chapter.body.data.id }
    }).expect(201);

    await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(502);

    expect(runtime.store.getTask(task.body.data.id)).toMatchObject({
      status: "partial",
      failures: [{ message: "AI 返回的世界观分析为空" }]
    });
  });
});
