import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("分析任务创建 API 类型白名单", () => {
  let runtime: Runtime | null = null;

  afterEach(() => {
    runtime?.close();
    runtime = null;
  });

  async function setupWork(): Promise<string> {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    runtime = createTestRuntime(fetchMock);
    const work = await request(runtime.app).post("/api/works").send({ title: "创建类型白名单测试" }).expect(201);
    return String(work.body.data.id);
  }

  it("拒绝运行时不支持的历史分析类型（structure/report-update）且不落库", async () => {
    const workId = await setupWork();
    for (const taskType of ["structure", "report-update"]) {
      await request(runtime!.app).post(`/api/works/${workId}/tasks`).send({
        taskType,
        scope: { type: "book" }
      }).expect(400);
    }
    const tasks = await request(runtime!.app).get(`/api/works/${workId}/tasks`).expect(200);
    expect(tasks.body.data.items).toEqual([]);
  });

  it("仍接受可新建的分析类型并创建为 pending 任务", async () => {
    const workId = await setupWork();
    const task = await request(runtime!.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "chapter-analysis",
      scope: { type: "book" }
    }).expect(201);
    expect(task.body.data).toMatchObject({ taskType: "chapter-analysis", status: "pending" });
  });
});
