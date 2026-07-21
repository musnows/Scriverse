import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("waitFor timeout"));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

async function setupWork(fetchMock: typeof fetch): Promise<{
  runtime: Runtime;
  workId: string;
  chapterIds: string[];
  releaseGates: Array<() => void>;
}> {
  const releaseGates: Array<() => void> = [];
  const gatedFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    await new Promise<void>((resolve) => {
      releaseGates.push(resolve);
    });
    return fetchMock(input, init);
  };
  const runtime = createTestRuntime(gatedFetch);
  const work = await request(runtime.app).post("/api/works").send({ title: "自动运行测试" }).expect(201);
  const workId = work.body.data.id;
  const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
  const chapterIds: string[] = [];
  for (let index = 1; index <= 5; index += 1) {
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: `第${index}章`,
      content: `章节正文 ${index}`
    }).expect(201);
    chapterIds.push(chapter.body.data.id);
  }
  const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
    name: "本地兼容服务",
    baseUrl: "https://mock-ai.test/v1/chat/completions",
    apiKey: "sk-test-auto-run",
    status: "enabled"
  }).expect(201);
  await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
  const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
    displayName: "小说模型",
    modelId: "mock-novel-model",
    purposes: ["chapter-analysis", "chat"]
  }).expect(201);
  await request(runtime.app).put(`/api/works/${workId}/task-defaults/chapter-analysis`).send({ modelId: model.body.data.id }).expect(200);
  for (const chapterId of chapterIds) {
    await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "chapter-analysis",
      scope: { type: "chapter", chapterId }
    }).expect(201);
  }
  return { runtime, workId, chapterIds, releaseGates };
}

describe("分析任务自动运行", () => {
  const runtimes: Runtime[] = [];

  afterEach(() => {
    while (runtimes.length) runtimes.pop()?.close();
  });

  it("校验自动运行设置并返回任务范围摘要", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ summary: "测试摘要", events: [], characters: [], settings: [], evidence: [], uncertainties: [] }) } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const { runtime, workId } = await setupWork(fetchMock);
    runtimes.push(runtime);

    const defaults = await request(runtime.app).get(`/api/works/${workId}/ai-settings`).expect(200);
    expect(defaults.body.data).toMatchObject({
      autoRunEnabled: false,
      autoRunConcurrency: 2,
      autoRunBatchLimit: 20,
      bookSummaryContextPercent: 50,
      contextCompactThreshold: 85,
      agentTools: ["story_index", "read_chapters", "query_story_knowledge", "grep", "read_character_sections"]
    });

    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      autoRunConcurrency: 0
    }).expect(400);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      autoRunBatchLimit: 201
    }).expect(400);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      bookSummaryContextPercent: 91
    }).expect(400);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      contextCompactThreshold: 91
    }).expect(400);
    const updated = await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      bookSummaryContextPercent: 35,
      contextCompactThreshold: 90
    }).expect(200);
    expect(updated.body.data.bookSummaryContextPercent).toBe(35);
    expect(updated.body.data.contextCompactThreshold).toBe(90);

    const tasks = await request(runtime.app).get(`/api/works/${workId}/tasks`).expect(200);
    expect(tasks.body.data.length).toBeGreaterThanOrEqual(5);
    expect(tasks.body.data[0]).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^task_/u),
      scopeSummary: expect.stringContaining("第一卷"),
      scopeDetails: expect.any(Array)
    }));
  });

  it("开启自动运行后遵守并发与单次上限", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "测试摘要",
            events: [],
            characters: [],
            settings: [],
            evidence: [{ conclusion: "有据", quote: "原文" }],
            uncertainties: []
          })
        }
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const { runtime, workId, releaseGates } = await setupWork(fetchMock);
    runtimes.push(runtime);

    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      autoRunEnabled: true,
      autoRunConcurrency: 2,
      autoRunBatchLimit: 3
    }).expect(200);
    // 开启自动运行时已 reset 并 schedule，勿再调 startAutoRunBatch，否则会清掉本轮 claimed

    await waitFor(() => releaseGates.length >= 2);
    expect(releaseGates.length).toBe(2);
    expect(runtime.store.countRunningTasks(workId)).toBe(2);

    releaseGates.splice(0).forEach((release) => release());
    await waitFor(() => releaseGates.length >= 1);
    expect(releaseGates.length).toBe(1);
    expect(runtime.store.countRunningTasks(workId)).toBe(1);
    releaseGates.splice(0).forEach((release) => release());
    await waitFor(() => runtime.store.countRunningTasks(workId) === 0);

    const tasks = await request(runtime.app).get(`/api/works/${workId}/tasks`).expect(200);
    const statuses = (tasks.body.data as Array<{ status: string }>).map((item) => item.status);
    expect(statuses.filter((status) => status === "review")).toHaveLength(3);
    expect(statuses.filter((status) => status === "pending").length).toBeGreaterThanOrEqual(2);

    await request(runtime.app).post(`/api/works/${workId}/tasks/auto-run`).send({}).expect(200);
    await waitFor(() => releaseGates.length >= 1);
    const started = releaseGates.splice(0);
    started.forEach((release) => release());
    await waitFor(() => runtime.store.countRunningTasks(workId) === 0);
    for (const release of releaseGates.splice(0)) release();
    await waitFor(() => runtime.store.countRunningTasks(workId) === 0);
  });
});
