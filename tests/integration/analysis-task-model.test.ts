import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("AI 分析任务模型", () => {
  let runtime: Runtime | null = null;

  afterEach(() => {
    runtime?.close();
    runtime = null;
  });

  it("创建任务时固化本书默认模型并允许单任务覆盖", async () => {
    const requestedModels: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "analysis-model-a" }, { id: "analysis-model-b" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string; max_tokens?: number };
      if (body.max_tokens !== 10 && body.model) requestedModels.push(body.model);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "已完成全书综合分析。" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);

    const work = await request(runtime.app).post("/api/works").send({ title: "任务模型测试" }).expect(201);
    const workId = String(work.body.data.id);
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "林舟在北港启动飞船。"
    }).expect(201);
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "分析模型服务",
      baseUrl: "https://analysis-model.test/v1",
      apiKey: "sk-analysis-model-test",
      status: "enabled"
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    const modelA = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "分析模型 A",
      modelId: "analysis-model-a"
    }).expect(201);
    const modelB = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "分析模型 B",
      modelId: "analysis-model-b"
    }).expect(201);

    await request(runtime.app).put(`/api/works/${workId}/task-defaults/book-analysis`).send({
      modelId: modelA.body.data.id
    }).expect(200);
    const defaultTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "book-analysis",
      scope: { type: "book" }
    }).expect(201);
    expect(defaultTask.body.data.model).toMatchObject({
      id: modelA.body.data.id,
      displayName: "分析模型 A",
      modelId: "analysis-model-a"
    });

    await request(runtime.app).put(`/api/works/${workId}/task-defaults/book-analysis`).send({
      modelId: modelB.body.data.id
    }).expect(200);
    const mappedDefaultTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "worldview-analysis",
      scope: { type: "book" }
    }).expect(201);
    expect(mappedDefaultTask.body.data.model.id).toBe(modelB.body.data.id);

    const overriddenTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "book-analysis",
      scope: { type: "book" },
      modelId: modelA.body.data.id
    }).expect(201);
    expect(overriddenTask.body.data.model.id).toBe(modelA.body.data.id);

    await request(runtime.app).post(`/api/tasks/${defaultTask.body.data.id}/run`).send({}).expect(200);
    expect(requestedModels).toEqual(["analysis-model-a"]);
    const storedTask = runtime.database.get<Record<string, unknown>>(
      "SELECT model_id FROM analysis_tasks WHERE id = ?",
      defaultTask.body.data.id
    );
    expect(storedTask?.model_id).toBe(modelA.body.data.id);

    const tasks = await request(runtime.app).get(`/api/works/${workId}/tasks`).expect(200);
    expect(tasks.body.data.items.find((item: { id: string }) => item.id === overriddenTask.body.data.id)?.model)
      .toMatchObject({ id: modelA.body.data.id, displayName: "分析模型 A" });
    const defaults = await request(runtime.app).get(`/api/works/${workId}/task-defaults`).expect(200);
    expect(defaults.body.data.find((item: { taskType: string }) => item.taskType === "book-analysis")?.model.id)
      .toBe(modelB.body.data.id);
  });
});
