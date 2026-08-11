import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

const runtimes: Runtime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
});

async function testProviderConnection(developmentServer: boolean): Promise<{
  result: Record<string, unknown>;
  requestedUrls: string[];
}> {
  const requestedUrls: string[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "development-model" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), { status: 200 });
  });
  const runtime = createRuntime({
    databasePath: ":memory:",
    masterSecret: "test-master-secret-with-at-least-32-characters",
    disableUserAuth: true,
    fetchImpl: fetchMock,
    serveUi: false,
    security: { allowPrivateAiEndpoints: false, enforceSameOrigin: false },
    developmentServer
  });
  runtimes.push(runtime);

  const provider = await request(runtime.app).post("/api/platform/ai/providers").send({
    name: "开发地址测试供应商",
    baseUrl: "https://198.18.0.7/v1",
    apiKey: "development-test-key",
    status: "enabled"
  }).expect(201);
  const tested = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
  return { result: tested.body.data as Record<string, unknown>, requestedUrls };
}

describe("开发服务 AI 供应商地址校验", () => {
  it("开发模式跳过供应商地址 SSRF 校验", async () => {
    const result = await testProviderConnection(true);

    expect(result.result).toMatchObject({ ok: true, availableModels: ["development-model"] });
    expect(result.requestedUrls).toEqual([
      "https://198.18.0.7/v1/models",
      "https://198.18.0.7/v1/chat/completions"
    ]);
  });

  it("非开发模式仍拒绝受保护地址", async () => {
    const result = await testProviderConnection(false);

    expect(result.result).toMatchObject({ ok: false });
    expect(result.result.error).toContain("AI 供应商地址指向受保护的本机、内网或链路本地网络");
    expect(result.requestedUrls).toEqual([]);
  });
});
