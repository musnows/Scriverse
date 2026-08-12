import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "../helpers.js";
import { Database } from "../../src/database.js";
import { AppError } from "../../src/errors.js";
import { AI_CONVERSATION_STREAM_REQUEST_LEASE_MS, Store } from "../../src/store.js";
import type { Runtime } from "../../src/app.js";

describe("AI 对话流持久化锁", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("跨数据库连接共享锁、复用同键状态并在终态后允许新请求", () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-ai-stream-lock-"));
    roots.push(root);
    const filename = join(root, "lock.db");
    const firstDatabase = new Database(filename);
    const firstStore = new Store(firstDatabase);
    const work = firstStore.createWork({ title: "并发锁作品" });
    const conversation = firstStore.createAiConversation(String(work.id));
    const base = {
      workId: String(work.id),
      conversationId: String(conversation.id),
      actorScope: "user:author-a",
      requestHash: "a".repeat(64),
      userMessage: { content: "只应写入一次" }
    };
    const started = firstStore.beginAiConversationStreamRequest({
      ...base,
      idempotencyKey: "request-shared-0001"
    });
    expect(started.disposition).toBe("started");

    const secondDatabase = new Database(filename);
    const secondStore = new Store(secondDatabase);
    const repeated = secondStore.beginAiConversationStreamRequest({
      ...base,
      idempotencyKey: "request-shared-0001"
    });
    expect(repeated).toMatchObject({ disposition: "in_progress", request: { id: started.request.id } });
    expect(secondDatabase.get("SELECT COUNT(*) AS count FROM ai_conversation_messages")).toEqual({ count: 1 });

    expect(() => secondStore.beginAiConversationStreamRequest({
      ...base,
      requestHash: "b".repeat(64),
      idempotencyKey: "request-distinct-01"
    })).toThrowError(expect.objectContaining({
      status: 409,
      code: "AI_CONVERSATION_RESPONSE_IN_PROGRESS"
    } satisfies Partial<AppError>));
    expect(secondDatabase.get("SELECT COUNT(*) AS count FROM ai_conversation_messages")).toEqual({ count: 1 });

    const assistant = firstStore.addAiConversationMessage(String(conversation.id), {
      role: "assistant",
      content: "唯一回复",
      requestId: `assistant:${started.userMessage?.id}`
    });
    firstStore.finishAiConversationStreamRequest(started.request.id, "completed", "completed", String(assistant.id));
    expect(firstStore.finishAiConversationStreamRequest(started.request.id, "failed", "late_duplicate_finish"))
      .toMatchObject({ status: "completed", terminalReason: "completed", assistantMessageId: assistant.id });
    const terminal = secondStore.beginAiConversationStreamRequest({
      ...base,
      idempotencyKey: "request-shared-0001"
    });
    expect(terminal).toMatchObject({
      disposition: "terminal",
      request: { status: "completed" },
      assistantMessage: { id: assistant.id, content: "唯一回复" }
    });

    const next = secondStore.beginAiConversationStreamRequest({
      ...base,
      requestHash: "c".repeat(64),
      idempotencyKey: "request-distinct-01",
      userMessage: { content: "终态后可继续" }
    });
    expect(next.disposition).toBe("started");
    secondStore.finishAiConversationStreamRequest(next.request.id, "cancelled", "user_cancelled");

    const leaseStartedAt = new Date("2026-08-12T00:00:00.000Z");
    const expiring = firstStore.beginAiConversationStreamRequest({
      ...base,
      requestHash: "d".repeat(64),
      idempotencyKey: "request-expiring-01",
      userMessage: { content: "进程中断前消息" }
    }, leaseStartedAt);
    const expiredRetry = secondStore.beginAiConversationStreamRequest({
      ...base,
      requestHash: "d".repeat(64),
      idempotencyKey: "request-expiring-01",
      userMessage: { content: "进程中断前消息" }
    }, new Date(leaseStartedAt.getTime() + AI_CONVERSATION_STREAM_REQUEST_LEASE_MS + 1));
    expect(expiredRetry).toMatchObject({
      disposition: "terminal",
      request: { id: expiring.request.id, status: "abandoned", terminalReason: "lease_expired" }
    });
    expect(secondDatabase.get(
      "SELECT COUNT(*) AS count FROM ai_conversation_messages WHERE request_id = ?",
      `stream:${expiring.request.id}:user`
    )).toEqual({ count: 1 });
    const afterExpiry = secondStore.beginAiConversationStreamRequest({
      ...base,
      requestHash: "e".repeat(64),
      idempotencyKey: "request-after-expiry",
      userMessage: { content: "租约终态后继续" }
    }, new Date(leaseStartedAt.getTime() + AI_CONVERSATION_STREAM_REQUEST_LEASE_MS + 2));
    expect(afterExpiry.disposition).toBe("started");
    secondStore.finishAiConversationStreamRequest(
      afterExpiry.request.id,
      "cancelled",
      "test_completed",
      undefined,
      new Date(leaseStartedAt.getTime() + AI_CONVERSATION_STREAM_REQUEST_LEASE_MS + 3)
    );

    const shutdownRequest = secondStore.beginAiConversationStreamRequest({
      ...base,
      requestHash: "f".repeat(64),
      idempotencyKey: "request-runtime-shutdown",
      userMessage: { content: "运行时关闭前消息" }
    });
    expect(secondStore.cancelActiveAiConversationStreamRequests()).toBe(1);
    expect(secondStore.findAiConversationStreamRequest(
      base.actorScope,
      base.workId,
      "request-runtime-shutdown"
    )).toMatchObject({
      id: shutdownRequest.request.id,
      status: "cancelled",
      terminalReason: "runtime_shutdown",
      leaseExpiresAt: null
    });
    expect(secondDatabase.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(secondDatabase.all("PRAGMA foreign_key_check")).toEqual([]);
    secondDatabase.close();
    firstDatabase.close();
  });
});

describe("AI 对话流 API 幂等与并发", () => {
  let runtime: Runtime;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let workId: string;
  let chapterId: string;
  let modelId: string;
  let releaseFirstStream: (() => void) | null;
  let streamCallCount: number;

  beforeEach(async () => {
    releaseFirstStream = null;
    streamCallCount = 0;
    fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "idempotency-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { max_tokens?: number; stream?: boolean };
      if (body.max_tokens === 10) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), { status: 200 });
      }
      streamCallCount += 1;
      const response = () => new Response(
        'data: {"choices":[{"delta":{"content":"唯一回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
      if (streamCallCount !== 1) return response();
      return new Promise<Response>((resolve) => {
        releaseFirstStream = () => resolve(response());
      });
    });
    runtime = createTestRuntime(fetchMock);
    const work = await request(runtime.app).post("/api/works").send({ title: "流幂等作品" }).expect(201);
    workId = String(work.body.data.id);
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "北港等待回复。"
    }).expect(201);
    chapterId = String(chapter.body.data.id);
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "幂等测试供应商",
      baseUrl: "https://idempotency-ai.test/v1/chat/completions",
      apiKey: "sk-idempotency-test-value",
      status: "enabled"
    }).expect(201);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "幂等模型",
      modelId: "idempotency-model"
    }).expect(201);
    modelId = String(model.body.data.id);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
  });

  afterEach(async () => {
    releaseFirstStream?.();
    await runtime.close();
  });

  it("拒绝同对话不同键、复用同键状态，并允许另一对话并行生成", async () => {
    const conversationA = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationB = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const bodyA = {
      instruction: "对话 A 的请求",
      scope: { type: "chapter", chapterId },
      modelId,
      conversationId: conversationA.body.data.id
    };
    const firstPromise = request(runtime.app).post(`/api/works/${workId}/chat/stream`)
      .set("Idempotency-Key", "browser-request-a-0001")
      .send(bodyA)
      .expect(200)
      .then((response) => response);
    for (let index = 0; index < 100 && streamCallCount < 1; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(streamCallCount).toBe(1);

    const conflict = await request(runtime.app).post(`/api/works/${workId}/chat/stream`)
      .set("Idempotency-Key", "browser-request-a-0002")
      .send({ ...bodyA, instruction: "不应写入的第二条消息" })
      .expect(409);
    expect(conflict.body.error).toMatchObject({
      code: "AI_CONVERSATION_RESPONSE_IN_PROGRESS",
      message: "当前对话仍在生成回复，请等待完成或取消后再发送"
    });

    const inProgressRetry = await request(runtime.app).post(`/api/works/${workId}/chat/stream`)
      .set("Idempotency-Key", "browser-request-a-0001")
      .send(bodyA)
      .expect(200);
    expect(inProgressRetry.text).toContain('"code":"AI_IDEMPOTENT_REQUEST_IN_PROGRESS"');
    expect(streamCallCount).toBe(1);

    const parallelB = await request(runtime.app).post(`/api/works/${workId}/chat/stream`)
      .set("Idempotency-Key", "browser-request-b-0001")
      .send({ ...bodyA, instruction: "对话 B 可并行", conversationId: conversationB.body.data.id })
      .expect(200);
    expect(parallelB.text).toContain("event: complete");
    expect(streamCallCount).toBe(2);

    releaseFirstStream?.();
    const first = await firstPromise;
    expect(first.text).toContain("event: complete");
    const terminalRetry = await request(runtime.app).post(`/api/works/${workId}/chat/stream`)
      .set("Idempotency-Key", "browser-request-a-0001")
      .send(bodyA)
      .expect(200);
    expect(terminalRetry.text).toContain('"replayed":true');
    expect(terminalRetry.text).toContain('"delta":"唯一回复"');
    expect(streamCallCount).toBe(2);

    const reusedForDifferentPayload = await request(runtime.app).post(`/api/works/${workId}/chat/stream`)
      .set("Idempotency-Key", "browser-request-a-0001")
      .send({ ...bodyA, instruction: "试图复用幂等键修改请求" })
      .expect(409);
    expect(reusedForDifferentPayload.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(streamCallCount).toBe(2);

    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM ai_conversation_messages WHERE conversation_id = ?",
      String(conversationA.body.data.id)
    )).toEqual({ count: 2 });
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM ai_calls WHERE work_id = ?",
      workId
    )).toEqual({ count: 2 });
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM ai_conversation_stream_requests WHERE conversation_id = ?",
      String(conversationA.body.data.id)
    )).toEqual({ count: 1 });
  });

  it("拒绝无效键且上游失败完成收尾后允许下一请求", async () => {
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const body = {
      instruction: "验证失败收尾",
      scope: { type: "none" },
      modelId,
      conversationId: conversation.body.data.id
    };
    await request(runtime.app).post(`/api/works/${workId}/chat/stream`)
      .set("Idempotency-Key", "bad key")
      .send(body)
      .expect(400);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM ai_conversation_stream_requests")).toEqual({ count: 0 });

    releaseFirstStream?.();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "idempotency-model" }] }), { status: 200 });
      const payload = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean };
      if (!payload.stream) return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), { status: 200 });
      return new Response(JSON.stringify({ error: { message: "上游失败" } }), { status: 500 });
    });
    const failed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`)
      .set("Idempotency-Key", "failed-request-0001")
      .send(body)
      .expect(200);
    expect(failed.text).toContain("event: error");
    expect(runtime.database.get(
      "SELECT status FROM ai_conversation_stream_requests WHERE idempotency_key = ?",
      "failed-request-0001"
    )).toEqual({ status: "failed" });

    fetchMock.mockImplementation(async () => new Response(
      'data: {"choices":[{"delta":{"content":"恢复成功"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    ));
    const recovered = await request(runtime.app).post(`/api/works/${workId}/chat/stream`)
      .set("Idempotency-Key", "recovered-request-01")
      .send({ ...body, instruction: "失败后再次发送" })
      .expect(200);
    expect(recovered.text).toContain("event: complete");
    expect(runtime.database.get(
      "SELECT status FROM ai_conversation_stream_requests WHERE idempotency_key = ?",
      "recovered-request-01"
    )).toEqual({ status: "completed" });
  });

  it("空闲超时记录明确终态并释放目标对话锁", async () => {
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const body = {
      instruction: "验证空闲超时收尾",
      scope: { type: "none" },
      modelId,
      conversationId: conversation.body.data.id
    };
    const streamSpy = vi.spyOn(runtime.ai, "createStreamingChat").mockRejectedValueOnce(
      new AppError(504, "AI_STREAM_IDLE_TIMEOUT", "AI 流事件等待超时")
    );
    const timedOut = await request(runtime.app).post(`/api/works/${workId}/chat/stream`)
      .set("Idempotency-Key", "timed-out-request-01")
      .send(body)
      .expect(200);
    expect(timedOut.text).toContain("AI_STREAM_IDLE_TIMEOUT");
    expect(runtime.database.get(
      "SELECT status, terminal_reason FROM ai_conversation_stream_requests WHERE idempotency_key = ?",
      "timed-out-request-01"
    )).toEqual({ status: "timed_out", terminal_reason: "AI_STREAM_IDLE_TIMEOUT" });

    const terminalRetry = await request(runtime.app).post(`/api/works/${workId}/chat/stream`)
      .set("Idempotency-Key", "timed-out-request-01")
      .send(body)
      .expect(200);
    expect(terminalRetry.text).toContain('"status":"timed_out"');
    expect(streamSpy).toHaveBeenCalledTimes(1);
    streamSpy.mockRestore();

    fetchMock.mockImplementation(async () => new Response(
      'data: {"choices":[{"delta":{"content":"超时后恢复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    ));
    const recovered = await request(runtime.app).post(`/api/works/${workId}/chat/stream`)
      .set("Idempotency-Key", "after-timeout-request")
      .send({ ...body, instruction: "超时后再次发送" })
      .expect(200);
    expect(recovered.text).toContain("event: complete");
    expect(runtime.database.get(
      "SELECT status FROM ai_conversation_stream_requests WHERE idempotency_key = ?",
      "after-timeout-request"
    )).toEqual({ status: "completed" });
  });
});
