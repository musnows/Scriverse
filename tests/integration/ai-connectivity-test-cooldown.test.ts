import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

function releasePendingRequest(release: (() => void) | null): void {
  if (!release) throw new Error("等待中的 AI 请求尚未开始");
  release();
}

describe("AI 供应商与模型连通性测试冷却", () => {
  let runtime: Runtime;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "cooldown-model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    runtime = createTestRuntime(fetchMock);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await runtime.close();
  });

  async function configureConnectivityTarget(): Promise<{ providerId: string; modelId: string }> {
    const provider = await request(runtime.app).post("/api/platform/ai/providers").send({
      name: "冷却测试供应商",
      baseUrl: "https://cooldown-ai.test/v1",
      apiKey: "sk-provider-cooldown-secret",
      status: "enabled"
    }).expect(201);
    const providerId = String(provider.body.data.id);
    const model = await request(runtime.app).post(`/api/providers/${providerId}/models`).send({
      displayName: "冷却测试模型",
      modelId: "cooldown-model"
    }).expect(201);
    return { providerId, modelId: String(model.body.data.id) };
  }

  it("供应商成功测试后执行 120 秒边界，配置变化立即解除旧冷却", async () => {
    const { providerId } = await configureConnectivityTarget();
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-08-12T12:00:00.000Z");
    vi.setSystemTime(startedAt);

    const first = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expect(first.body.data).toMatchObject({
      ok: true,
      cooldown: {
        reason: "success_cooldown",
        retryAfterSeconds: 120,
        retryAt: "2026-08-12T12:02:00.000Z"
      }
    });
    expect(JSON.stringify(first.body)).not.toMatch(/fingerprint|attemptId|sk-provider-cooldown-secret/u);

    const immediate = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(429);
    expect(immediate.headers["retry-after"]).toBe("120");
    expect(immediate.body.error).toMatchObject({
      code: "AI_CONNECTIVITY_TEST_COOLDOWN",
      details: { reason: "success_cooldown", retryAfterSeconds: 120, retryAt: "2026-08-12T12:02:00.000Z" }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(startedAt + 119_999);
    const beforeBoundary = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(429);
    expect(beforeBoundary.headers["retry-after"]).toBe("1");

    vi.setSystemTime(startedAt + 120_000);
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ note: "新配置版本" }).expect(200);
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("供应商失败后冷却 10 秒，边界重试成功后切换到 120 秒冷却并保持脱敏", async () => {
    const { providerId } = await configureConnectivityTarget();
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-08-12T13:00:00.000Z");
    vi.setSystemTime(startedAt);
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "cooldown-model" }] }), { status: 200 });
      }
      return new Response("credential sk-provider-cooldown-secret rejected", { status: 503 });
    });

    const failed = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expect(failed.body.data).toMatchObject({
      ok: false,
      cooldown: { reason: "failure_cooldown", retryAfterSeconds: 10, retryAt: "2026-08-12T13:00:10.000Z" }
    });
    expect(JSON.stringify(failed.body)).not.toContain("sk-provider-cooldown-secret");

    const immediate = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(429);
    expect(immediate.body.error.details).toMatchObject({ reason: "failure_cooldown", retryAfterSeconds: 10 });
    vi.setSystemTime(startedAt + 9_999);
    const beforeBoundary = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(429);
    expect(beforeBoundary.body.error.details.retryAfterSeconds).toBe(1);

    fetchMock.mockImplementation(async (input) => String(input).endsWith("/models")
      ? new Response(JSON.stringify({ data: [{ id: "cooldown-model" }] }), { status: 200 })
      : new Response(JSON.stringify({ choices: [{ message: { content: "恢复成功" } }] }), { status: 200 }));
    vi.setSystemTime(startedAt + 10_000);
    const recovered = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expect(recovered.body.data.cooldown).toMatchObject({ reason: "success_cooldown", retryAfterSeconds: 120 });
    const successCooldown = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(429);
    expect(successCooldown.body.error.details.reason).toBe("success_cooldown");
  });

  it("模型测试使用独立对象冷却，并在模型或供应商配置变化后立即放行", async () => {
    const { providerId, modelId } = await configureConnectivityTarget();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-08-12T14:00:00.000Z");

    const first = await request(runtime.app).post(`/api/models/${modelId}/test`).send({}).expect(200);
    expect(first.body.data).toMatchObject({
      ok: true,
      cooldown: { reason: "success_cooldown", retryAfterSeconds: 120 }
    });
    const blocked = await request(runtime.app).post(`/api/models/${modelId}/test`).send({}).expect(429);
    expect(blocked.body.error.details.reason).toBe("success_cooldown");

    await request(runtime.app).patch(`/api/models/${modelId}`).send({ modelId: "cooldown-model-v2" }).expect(200);
    await request(runtime.app).post(`/api/models/${modelId}/test`).send({}).expect(200);

    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ note: "供应商配置也参与模型版本" }).expect(200);
    await request(runtime.app).post(`/api/models/${modelId}/test`).send({}).expect(200);
    expect(runtime.database.all(
      "SELECT object_type, object_id, state FROM ai_connectivity_test_states ORDER BY object_type, object_id"
    )).toEqual([{ object_type: "model", object_id: modelId, state: "success" }]);
  });

  it("同一供应商或模型的并发请求只启动一次真实上游调用", async () => {
    const { providerId, modelId } = await configureConnectivityTarget();
    let completionStarts = 0;
    let releaseCompletion: (() => void) | null = null;
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "cooldown-model" }] }), { status: 200 });
      }
      completionStarts += 1;
      return new Promise<Response>((resolve) => {
        releaseCompletion = () => resolve(new Response(JSON.stringify({ choices: [{ message: { content: "并发成功" } }] }), { status: 200 }));
      });
    });

    const firstProviderRequest = request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).then((response) => response);
    await vi.waitFor(() => expect(completionStarts).toBe(1));
    const duplicateProvider = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(429);
    expect(duplicateProvider.body.error).toMatchObject({
      code: "AI_CONNECTIVITY_TEST_IN_PROGRESS",
      details: { reason: "in_progress" }
    });
    expect(completionStarts).toBe(1);
    expect(releaseCompletion).not.toBeNull();
    releasePendingRequest(releaseCompletion);
    expect((await firstProviderRequest).status).toBe(200);

    releaseCompletion = null;
    const firstModelRequest = request(runtime.app).post(`/api/models/${modelId}/test`).send({}).then((response) => response);
    await vi.waitFor(() => expect(completionStarts).toBe(2));
    const duplicateModel = await request(runtime.app).post(`/api/models/${modelId}/test`).send({}).expect(429);
    expect(duplicateModel.body.error.details.reason).toBe("in_progress");
    expect(completionStarts).toBe(2);
    expect(releaseCompletion).not.toBeNull();
    releasePendingRequest(releaseCompletion);
    expect((await firstModelRequest).status).toBe(200);
  });

  it("测试进行中修改配置时不让旧结果覆盖新配置，并允许新版本立即重试", async () => {
    const { providerId, modelId } = await configureConnectivityTarget();
    let releaseCompletion: (() => void) | null = null;
    fetchMock.mockImplementation(async () => new Promise<Response>((resolve) => {
      releaseCompletion = () => resolve(new Response(JSON.stringify({ choices: [{ message: { content: "旧配置成功" } }] }), { status: 200 }));
    }));

    const oldConfigurationRequest = request(runtime.app).post(`/api/models/${modelId}/test`).send({}).then((response) => response);
    await vi.waitFor(() => expect(releaseCompletion).not.toBeNull());
    await request(runtime.app).patch(`/api/models/${modelId}`).send({ displayName: "新配置模型" }).expect(200);
    releasePendingRequest(releaseCompletion);
    const oldResult = await oldConfigurationRequest;
    expect(oldResult.status).toBe(200);
    expect(oldResult.body.data.cooldown).toEqual({
      reason: "configuration_changed",
      retryAfterSeconds: 0,
      retryAt: null
    });
    expect((await request(runtime.app).get(`/api/providers/${providerId}`).expect(200)).body.data.connectionStatus).toBe("unchecked");

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "新配置成功" } }] }), { status: 200 }));
    const newResult = await request(runtime.app).post(`/api/models/${modelId}/test`).send({}).expect(200);
    expect(newResult.body.data.cooldown.reason).toBe("success_cooldown");
  });

  it("在真实供应商调用之前拒绝未知请求字段", async () => {
    const { providerId, modelId } = await configureConnectivityTarget();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({ unexpected: true }).expect(400);
    await request(runtime.app).post(`/api/models/${modelId}/test`).send({ unexpected: true }).expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM ai_connectivity_test_states")).toEqual({ count: 0 });
  });
});
