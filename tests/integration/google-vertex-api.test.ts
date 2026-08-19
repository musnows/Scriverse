import { generateKeyPairSync } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { GOOGLE_OAUTH_TOKEN_URL } from "../../src/google-vertex-auth.js";
import { createTestRuntime } from "../helpers.js";

function createServiceAccountJson(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return JSON.stringify({
    type: "service_account",
    project_id: "scriverse-demo",
    private_key_id: "demo-key",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    client_email: "vertex-bot@scriverse-demo.iam.gserviceaccount.com",
    client_id: "1234567890",
    token_uri: GOOGLE_OAUTH_TOKEN_URL
  });
}

describe("Google Vertex 供应商 API", () => {
  let runtime: Runtime;
  let workId: string;
  let chapterId: string;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let expectedThinkingEffort: "low" | undefined;
  const serviceAccountJson = createServiceAccountJson();
  const vertexBaseUrl = "https://aiplatform.googleapis.com/v1/projects/scriverse-demo/locations/global/endpoints/openapi";

  beforeEach(async () => {
    expectedThinkingEffort = undefined;
    fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === GOOGLE_OAUTH_TOKEN_URL) {
        const body = String(init?.body ?? "");
        expect(body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
        expect(body).toContain("assertion=");
        expect(JSON.stringify(init?.headers ?? {})).not.toContain("BEGIN PRIVATE KEY");
        return new Response(JSON.stringify({ access_token: "ya29.vertex-access-token", expires_in: 3600, token_type: "Bearer" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const authorization = new Headers(init?.headers).get("authorization");
      expect(authorization).toBe("Bearer ya29.vertex-access-token");
      expect(authorization).not.toContain("BEGIN PRIVATE KEY");
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "google/gemini-2.0-flash-001" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const body = JSON.parse(String(init?.body)) as {
        model?: string;
        messages?: Array<{ content?: unknown }>;
        stream?: boolean;
        thinking?: unknown;
        reasoning_effort?: string;
        max_tokens?: number;
      };
      expect(body).not.toHaveProperty("thinking");
      if (expectedThinkingEffort) expect(body.reasoning_effort).toBe(expectedThinkingEffort);
      else expect(body).not.toHaveProperty("reasoning_effort");
      if (body.max_tokens === 10) {
        if (Array.isArray(body.messages?.[0]?.content)) {
          expect(body.messages[0]?.content).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: "text" }),
            expect.objectContaining({ type: "image_url", image_url: expect.objectContaining({ detail: "low" }) })
          ]));
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (body.stream) {
        return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"Vertex 流式回复\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "Vertex 普通回复" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    runtime = createTestRuntime(fetchMock);
    const work = await request(runtime.app).post("/api/works").send({ title: "Vertex 测试作品" });
    workId = work.body.data.id;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" });
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "林舟启动了飞船。"
    });
    chapterId = chapter.body.data.id;
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("拒绝非法服务账号 JSON，并在合法配置下换票后完成探测与调用", async () => {
    await request(runtime.app).post("/api/platform/ai/providers").send({
      name: "恶意 Vertex 地址",
      protocol: "google-vertex",
      baseUrl: "https://attacker.example/v1/projects/scriverse-demo",
      apiKey: serviceAccountJson,
      status: "enabled"
    }).expect(400);
    expect(fetchMock).not.toHaveBeenCalled();

    await request(runtime.app).post("/api/platform/ai/providers").send({
      name: "非法 Vertex",
      protocol: "google-vertex",
      baseUrl: vertexBaseUrl,
      apiKey: JSON.stringify({ type: "service_account", client_email: "a@b.com" }),
      status: "enabled"
    }).expect(400);

    const health = await request(runtime.app).get("/api/health").expect(200);
    expect(health.body.data.protocols).toContain("google-vertex");

    const provider = await request(runtime.app).post("/api/platform/ai/providers").send({
      name: "Google Vertex",
      protocol: "google-vertex",
      baseUrl: vertexBaseUrl,
      apiKey: serviceAccountJson,
      status: "enabled"
    }).expect(201);
    expect(provider.body.data.protocol).toBe("google-vertex");
    expect(provider.body.data.apiKey).toBe("sa:vertex-bot@scriverse-demo.iam.gserviceaccount.com");
    expect(JSON.stringify(provider.body.data)).not.toContain("BEGIN PRIVATE KEY");
    await request(runtime.app).patch(`/api/providers/${provider.body.data.id}`).send({
      baseUrl: "https://aiplatform.googleapis.com.attacker.example/v1"
    }).expect(400);
    const unchangedProvider = await request(runtime.app).get(`/api/providers/${provider.body.data.id}`).expect(200);
    expect(unchangedProvider.body.data.baseUrl).toBe(vertexBaseUrl);

    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "Gemini Flash",
      modelId: "google/gemini-2.0-flash-001",
      thinkingEnabled: true,
      thinkingEffort: "low",
      multimodalEnabled: true
    }).expect(201);
    expect(model.body.data.thinkingEffort).toBe("low");
    expectedThinkingEffort = "low";

    const testResult = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    expect(testResult.body.data.ok).toBe(true);
    const modelTestResult = await request(runtime.app).post(`/api/models/${model.body.data.id}/test`).send({}).expect(200);
    expect(modelTestResult.body.data).toMatchObject({ ok: true, multimodalTested: true });

    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "测试 Vertex 普通调用",
      scope: { type: "chapter", chapterId },
      modelId: model.body.data.id
    }).expect(201);

    const stream = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "测试 Vertex 流式调用",
      scope: { type: "chapter", chapterId },
      modelId: model.body.data.id
    }).expect(200);
    expect(stream.headers["content-type"]).toMatch(/text\/event-stream/u);

    const tokenCalls = fetchMock.mock.calls.filter(([input]) => String(input) === GOOGLE_OAUTH_TOKEN_URL);
    expect(tokenCalls.length).toBeGreaterThanOrEqual(1);
    const completionCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("/chat/completions"));
    expect(completionCalls.length).toBeGreaterThanOrEqual(3);
    for (const [, init] of completionCalls) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ya29.vertex-access-token");
    }
  });

  it("出站前再次拒绝数据库中遗留的非官方 Vertex 地址", async () => {
    const provider = await request(runtime.app).post("/api/platform/ai/providers").send({
      name: "遗留 Vertex",
      protocol: "google-vertex",
      baseUrl: vertexBaseUrl,
      apiKey: serviceAccountJson,
      status: "enabled"
    }).expect(201);
    runtime.database.run(
      "UPDATE providers SET base_url = ? WHERE id = ?",
      "https://attacker.example/v1/projects/scriverse-demo",
      provider.body.data.id
    );
    fetchMock.mockClear();

    const result = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    expect(result.body.data).toMatchObject({ ok: false });
    expect(result.body.data.error).toContain("Google Vertex 接口地址必须使用");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("上游模型列表失败时可回退到本地模型探测", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === GOOGLE_OAUTH_TOKEN_URL) {
        return new Response(JSON.stringify({ access_token: "ya29.vertex-access-token", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ya29.vertex-access-token");
      if (url.endsWith("/models")) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const provider = await request(runtime.app).post("/api/platform/ai/providers").send({
      name: "Vertex 回退探测",
      protocol: "google-vertex",
      baseUrl: vertexBaseUrl,
      apiKey: serviceAccountJson,
      status: "enabled"
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "本地模型",
      modelId: "google/gemini-2.0-flash-001"
    }).expect(201);
    const result = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    expect(result.body.data.ok).toBe(true);
  });
});
