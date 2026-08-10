import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("Agent 多模态图片工具", () => {
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
  });

  it("读取设定正文引用的图片并把理解结果返回给 Agent", async () => {
    let completionCount = 0;
    let requestedAttachmentId = "";
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "vision-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role?: string; content?: unknown }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      if (body.messages.length === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), { status: 200 });
      }
      if (body.messages[0]?.role === "system" && body.messages[1]?.role === "user" && Array.isArray(body.messages[1].content)) {
        const content = body.messages[1].content as Array<Record<string, unknown>>;
        const imageBlock = content.find((block) => block.type === "image_url");
        expect(imageBlock).toMatchObject({ type: "image_url", image_url: { detail: "auto" } });
        expect(String((imageBlock?.image_url as Record<string, unknown>)?.url)).toMatch(/^data:image\/(?:png|webp);base64,/u);
        return new Response(JSON.stringify({
          choices: [{ message: { content: "图片显示一座带有三颗卫星的蓝色行星，右侧标注为北港航线。" } }],
          usage: { prompt_tokens: 120, completion_tokens: 24 }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      completionCount += 1;
      if (completionCount === 1) {
        expect(body.tools?.map((tool) => tool.function?.name)).toContain("image");
        return new Response(JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [{
            id: "image-call",
            type: "function",
            function: { name: "image", arguments: JSON.stringify({ attachmentId: requestedAttachmentId }) }
          }] } }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const toolMessage = body.messages.find((message) => message.role === "tool");
      expect(String(toolMessage?.content)).toContain("图片显示一座带有三颗卫星的蓝色行星");
      return new Response(JSON.stringify({ choices: [{ message: { content: "已读取设定图片：图片显示一座带有三颗卫星的蓝色行星，右侧标注为北港航线。" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    runtime = createTestRuntime(fetchMock);

    const work = await request(runtime.app).post("/api/works").send({ title: "图片工具测试作品" }).expect(201);
    const workId = String(work.body.data.id);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2z94AAAAASUVORK5CYII=", "base64");
    const uploaded = await request(runtime.app)
      .post(`/api/works/${workId}/attachments?module=settings`)
      .attach("file", png, { filename: "星图.png", contentType: "image/png" })
      .expect(201);
    const attachmentId = String(uploaded.body.data.id);
    requestedAttachmentId = attachmentId;
    const setting = await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "航线星图",
      category: "地图",
      content: `![星图](attachment://${attachmentId})`
    }).expect(201);
    expect(setting.body.data.content).toContain(`attachment://${attachmentId}`);

    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "图片兼容服务",
      baseUrl: "https://mock-vision.test/v1",
      apiKey: "sk-vision-test",
      status: "enabled"
    }).expect(201);
    const providerId = String(provider.body.data.id);
    const model = await request(runtime.app).post(`/api/providers/${providerId}/models`).send({
      displayName: "图片理解模型",
      modelId: "vision-model",
      multimodalEnabled: true,
      imageToolDefault: true
    }).expect(201);
    const modelId = String(model.body.data.id);
    expect(model.body.data).toMatchObject({ multimodalEnabled: true, imageToolDefault: true });
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentTools: ["image"],
      imageToolModelId: modelId
    }).expect(200);

    const result = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "读取航线星图并告诉我图片内容。",
      scope: { type: "none" },
      modelId
    }).expect(201);

    expect(result.body.data.content).toContain("已读取设定图片");
    expect(result.body.data.toolCalls).toEqual([expect.objectContaining({
      name: "image",
      status: "completed",
      arguments: { attachmentId },
      result: { ok: true, data: expect.objectContaining({ attachmentId, fileName: "星图.png" }) }
    })]);
    expect(JSON.stringify(result.body.data.toolCalls)).not.toContain("data:image");
    expect(fetchMock).toHaveBeenCalled();
    await request(runtime.app).patch(`/api/models/${modelId}`).send({ enabled: false }).expect(200);
    const platformSettings = await request(runtime.app).get("/api/platform/ai/settings").expect(200);
    const workSettings = await request(runtime.app).get(`/api/works/${workId}/ai-settings`).expect(200);
    expect(platformSettings.body.data.imageToolModelId).toBeNull();
    expect(workSettings.body.data.imageToolModelId).toBeNull();
  });

  it("拒绝未配置多模态模型和未被设定引用的附件", async () => {
    let completionCount = 0;
    let requestedAttachmentId = "";
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "text-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string; content?: unknown }> };
      if (body.messages?.[0]?.role === "system" && body.messages?.[1]?.role === "user") {
        completionCount += 1;
        if (completionCount === 1) {
          return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
            id: "missing-image-model",
            type: "function",
            function: { name: "image", arguments: JSON.stringify({ attachmentId: requestedAttachmentId }) }
          }] } }] }), { status: 200 });
        }
        const toolMessage = body.messages.find((message) => message.role === "tool");
        expect(String(toolMessage?.content)).toContain("SETTING_IMAGE_ATTACHMENT_NOT_FOUND");
        return new Response(JSON.stringify({ choices: [{ message: { content: "附件无法读取。" } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), { status: 200 });
    });
    runtime = createTestRuntime(fetchMock);
    const work = await request(runtime.app).post("/api/works").send({ title: "图片权限测试作品" }).expect(201);
    const workId = String(work.body.data.id);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2z94AAAAASUVORK5CYII=", "base64");
    const uploaded = await request(runtime.app)
      .post(`/api/works/${workId}/attachments?module=settings`)
      .attach("file", png, { filename: "未引用.png", contentType: "image/png" })
      .expect(201);
    const attachmentId = String(uploaded.body.data.id);
    requestedAttachmentId = attachmentId;
    const setting = await request(runtime.app).post(`/api/works/${workId}/settings`).send({ title: "空设定", category: "测试", content: "没有图片引用" }).expect(201);
    expect(setting.body.data.id).toBeTruthy();
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "普通兼容服务",
      baseUrl: "https://mock-text.test/v1",
      apiKey: "sk-text-test",
      status: "enabled"
    }).expect(201);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({ displayName: "普通模型", modelId: "text-model" }).expect(201);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: ["image"] }).expect(200);
    const result = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: `读取附件 ${attachmentId}`,
      scope: { type: "none" },
      modelId: model.body.data.id
    });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.data.toolCalls).toEqual([expect.objectContaining({ name: "image", status: "failed" })]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
