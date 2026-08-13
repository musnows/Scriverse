/**
 * 可写工具协议级真实 E2E：mock AI 通过 propose_writes 与 ask_user_question
 * 工具提交计划与提问，验证计划创建、审批执行、幂等、撤销与提问回答全链路。
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { createRuntime } from "../../src/app.js";

type JsonObject = Record<string, unknown>;
type ToolMessage = { role?: string; tool_call_id?: string; content?: string };
type CompletionBody = {
  messages?: ToolMessage[];
  tools?: Array<{ function?: { name?: string } }>;
  tool_choice?: string;
};

const checks: Array<{ feature: string; detail: string }> = [];
let planId = "";
let questionId = "";
let proposeSeen = false;
let mockSettingId = "";

function checked(feature: string, detail: string): void {
  checks.push({ feature, detail });
  console.log(`[e2e-write] ${feature}: ${detail}`);
}

function object(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}

async function readRequest(incoming: IncomingMessage): Promise<CompletionBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as CompletionBody;
}

function completion(outgoing: ServerResponse, message: JsonObject): void {
  outgoing.writeHead(200, { "Content-Type": "application/json" });
  outgoing.end(JSON.stringify({ choices: [{ message }], usage: { completion_tokens: 24 } }));
}

function toolCalls(outgoing: ServerResponse, calls: Array<{ id: string; name: string; arguments: unknown }>): void {
  completion(outgoing, {
    content: null,
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments }
    }))
  });
}

function toolResults(body: CompletionBody): Map<string, JsonObject> {
  return new Map((body.messages ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => [String(message.tool_call_id), object(JSON.parse(message.content ?? "{}") as unknown)]));
}

const mockAi = createServer(async (incoming, outgoing) => {
  if (incoming.url === "/v1/models") {
    outgoing.writeHead(200, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify({ data: [{ id: "write-tool-model" }] }));
    return;
  }
  if (incoming.url !== "/v1/chat/completions" || incoming.method !== "POST") {
    outgoing.writeHead(404).end();
    return;
  }
  const body = await readRequest(incoming);
  const messages = body.messages ?? [];
  const joined = messages.map((message) => message.content ?? "").join("\n");
  const results = toolResults(body);
  if (joined.includes("连接成功")) {
    // 供应商连通性测试请求，直接回复成功。
    completion(outgoing, { content: "连接成功" });
    return;
  }
  if (!proposeSeen && results.size === 0) {
    // 第一轮：模型提交一份修改计划并创建一次提问。
    proposeSeen = true;
    const tools = (body.tools ?? []).map((tool) => tool.function?.name);
    assert.ok(tools.includes("propose_writes"), `propose_writes 工具未下发，实际：${tools.join(",")}`);
    assert.ok(tools.includes("ask_user_question"), `ask_user_question 工具未下发，实际：${tools.join(",")}`);
    toolCalls(outgoing, [
      {
        id: "write-plan",
        name: "propose_writes",
        arguments: {
          summary: "完善北港设定并新建南港",
          operations: [
            {
              operationType: "update_setting",
              targetId: mockSettingId,
              summary: "补充北港规模",
              changes: { content: "北港是帝国最大的港口城市，常驻人口超过两百万。" }
            },
            {
              operationType: "create_setting",
              summary: "新建南港设定",
              changes: { title: "南港", category: "地理", content: "南港是帝国的第二大港口。" }
            }
          ]
        }
      },
      {
        id: "write-question",
        name: "ask_user_question",
        arguments: {
          question: "南港的规模应该多大？",
          options: ["小型渔港", "大型商港", "军事要塞"],
          allowCustomAnswer: true
        }
      }
    ]);
    return;
  }
  if (!planId && results.size > 0) {
    // 第二轮：模型收到工具结果，读取审批 ID 与提问 ID 后收尾。
    const planResult = results.get("write-plan") ?? null;
    const questionResult = results.get("write-question") ?? null;
    assert.ok(planResult && planResult.ok === true, `propose_writes 应返回成功，实际：${JSON.stringify(planResult)}`);
    assert.ok(questionResult && questionResult.ok === true, `ask_user_question 应返回成功，实际：${JSON.stringify(questionResult)}`);
    planId = String(object(planResult).planId);
    questionId = String(object(questionResult).questionId);
    assert.ok(planId && questionId, "审批 ID 与提问 ID 均应存在");
    completion(outgoing, { content: "修改计划与提问均已提交，请作者在审批中心确认。" });
    return;
  }
  if (joined.includes("审批禁用场景")) {
    const failed = results.get("write-disabled") ?? null;
    if (!failed) {
      // 第一轮：尝试让模型调用已经下线的可写工具。
      const tools = (body.tools ?? []).map((tool) => tool.function?.name);
      assert.ok(!tools.includes("propose_writes"), `开关关闭后 propose_writes 不应再下发，实际：${tools.join(",")}`);
      toolCalls(outgoing, [
        {
          id: "write-disabled",
          name: "propose_writes",
          arguments: {
            summary: "尝试在开关关闭时提交",
            operations: [{ operationType: "update_setting", targetId: mockSettingId, summary: "不应成功", changes: { content: "不应写入。" } }]
          }
        }
      ]);
      return;
    }
    // 第二轮：服务端拒绝执行已下线的工具。
    assert.ok(failed.ok === false, `开关关闭时 propose_writes 应失败，实际：${JSON.stringify(failed)}`);
    const error = object(failed.error ?? {});
    assert.equal(String(error.code ?? ""), "TOOL_NOT_AVAILABLE", "失败原因应为工具不可用");
    completion(outgoing, { content: "工具已拒绝提交：可写工具已被关闭。" });
    return;
  }
  completion(outgoing, { content: "默认响应。" });
});

mockAi.listen(0, "127.0.0.1");
await once(mockAi, "listening");
const mockAddress = mockAi.address();
assert.ok(mockAddress && typeof mockAddress !== "string", "Mock AI server failed to start");

const dataRoot = join(process.cwd(), ".data");
await mkdir(dataRoot, { recursive: true });
const isolatedDirectory = await mkdtemp(join(dataRoot, "e2e-ai-write-"));
let runtime: ReturnType<typeof createRuntime> | undefined;
let appServer: ReturnType<ReturnType<typeof createRuntime>["app"]["listen"]> | undefined;
let baseUrl = "";
let workId = "";
let settingId = "";

try {
  const createdRuntime = createRuntime({
    databasePath: join(isolatedDirectory, "novel.db"),
    masterSecret: "e2e-ai-write-master-secret-at-least-32-characters",
    disableUserAuth: true,
    security: { allowPrivateAiEndpoints: true, enforceSameOrigin: false, apiRateLimit: 10_000 }
  });
  runtime = createdRuntime;
  const listeningServer = createdRuntime.app.listen(0, "127.0.0.1");
  appServer = listeningServer;
  await once(listeningServer, "listening");
  const address = listeningServer.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;

  async function api<T = JsonObject>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}/api${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    });
    const payload = await response.json() as JsonObject;
    if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}: ${JSON.stringify(payload)}`);
    return (payload.data ?? payload) as T;
  }

  const work = await api<JsonObject>("POST", "/works", { title: "AI 可写工具 E2E" });
  workId = String(work.id);
  const volume = await api<JsonObject>("POST", `/works/${workId}/volumes`, { title: "第一卷" });
  await api("POST", `/works/${workId}/chapters`, {
    volumeId: String(volume.id),
    title: "第一章",
    content: "第一行。\n第二行。\n第三行。"
  });
  const setting = await api<JsonObject>("POST", `/works/${workId}/settings`, {
    title: "北港",
    category: "地理",
    content: "北港是帝国最大的港口城市。"
  });
  settingId = String(setting.id);
  mockSettingId = settingId;
  const provider = await api<JsonObject>("POST", `/works/${workId}/providers`, {
    name: "E2E 可写工具模型",
    baseUrl: `http://127.0.0.1:${mockAddress.port}/v1`,
    apiKey: "sk-write-e2e",
    status: "enabled"
  });
  await api("POST", `/providers/${String(provider.id)}/test`, {});
  const model = await api<JsonObject>("POST", `/providers/${String(provider.id)}/models`, {
    displayName: "可写工具模型",
    modelId: "write-tool-model",
    contextWindow: 64_000
  });
  await api("PUT", `/works/${workId}/task-defaults/chat`, { modelId: String(model.id) });

  // 开启可写工具开关。
  await api("PATCH", `/works/${workId}/ai-settings`, {
    aiWriteTools: {
      settings: true, characters: false, races: false, organizations: false, timeline: false,
      relationships: false, outlines: false, "chapter-annotations": false,
      "analysis-tasks": false, "ask-user-questions": true
    }
  });
  checked("switches", "world settings and ask_user_question tools enabled via work ai settings");

  // 通过真实 chat/stream 触发模型调用可写工具。
  const stream = await fetch(`${baseUrl}/api/works/${workId}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      instruction: "请完善北港设定并新建南港，同时向我确认南港规模。",
      scope: { type: "none" },
      modelId: String(model.id)
    })
  });
  assert.equal(stream.status, 200);
  const streamText = await stream.text();
  assert.match(streamText, /event: tool_call/u);
  assert.match(streamText, /propose_writes/u);
  assert.match(streamText, /ask_user_question/u);
  checked("tool-calls", "mock model submitted a write plan and a question through real stream");

  assert.ok(planId && questionId, "plan and question ids were captured by the mock AI");

  // 计划进入审批中心，详情包含系统生成的 diff。
  const pendingList = await api<JsonObject>("GET", `/works/${workId}/ai-approvals?status=pending`);
  const items = Array.isArray(object(pendingList).items) ? object(pendingList).items as JsonObject[] : [];
  assert.equal(items.length, 1);
  assert.equal(String(items[0]?.summary ?? ""), "完善北港设定并新建南港");
  const detail = await api<JsonObject>("GET", `/ai-approvals/${planId}`);
  const operations = Array.isArray(object(detail).operations) ? object(detail).operations as JsonObject[] : [];
  assert.equal(operations.length, 2);
  const updateOperation = operations.find((item) => item.operationType === "update_setting") as JsonObject | undefined;
  assert.ok(updateOperation, "update operation should exist");
  const updateChanges = Array.isArray(updateOperation.changes) ? updateOperation.changes as JsonObject[] : [];
  assert.equal(updateChanges.length, 1);
  assert.equal(String(updateChanges[0]?.before ?? ""), "北港是帝国最大的港口城市。");
  assert.equal(String(updateChanges[0]?.after ?? ""), "北港是帝国最大的港口城市，常驻人口超过两百万。");
  const createOperation = operations.find((item) => item.operationType === "create_setting") as JsonObject | undefined;
  assert.ok(createOperation, "create operation should exist");
  assert.equal(createOperation.targetId, null);
  checked("plan-detail", "system generated diff shows before/after values and create markers");

  // 提问持久化，等待回答。
  const question = await api<JsonObject>("GET", `/ai-questions/${questionId}`);
  assert.equal(String(object(question).status), "pending");
  assert.equal(Number(object(question).recommendedIndex), 0);
  const answered = await api<JsonObject>("POST", `/ai-questions/${questionId}/answer`, { type: "option", index: 1 });
  assert.equal(String(object(answered).status), "answered");
  assert.deepEqual(object(answered).answer, { type: "option", index: 1 });
  checked("question", "question persisted, answered by option, first option recommended");

  // 确认执行：修改生效、新建生效。
  const approved = await api<JsonObject>("POST", `/ai-approvals/${planId}/approve`, {});
  assert.equal(String(object(approved).status), "succeeded");
  const updatedSetting = await api<JsonObject>("GET", `/settings/${settingId}`);
  assert.equal(String(object(updatedSetting).content), "北港是帝国最大的港口城市，常驻人口超过两百万。");
  assert.equal(Number(object(updatedSetting).versionNo), 2);
  const settings = await api<JsonObject>("GET", `/works/${workId}/settings`);
  const created = (Array.isArray(settings) ? settings as JsonObject[] : []).find((item) => item.title === "南港");
  assert.ok(created, "created setting should exist");
  checked("approve", "plan executed atomically with version bump and created entity");

  // 重复确认幂等。
  const repeated = await api<JsonObject>("POST", `/ai-approvals/${planId}/approve`, {});
  assert.equal(String(object(repeated).status), "succeeded");
  assert.equal(String(object(repeated).executedAt), String(object(approved).executedAt));
  checked("idempotent", "repeated approval returns the original execution result");

  // 撤销本次审批：编辑操作恢复，新建词条保留。
  const revoked = await api<JsonObject>("POST", `/ai-approvals/${planId}/revoke`, {});
  assert.ok(object(revoked).revokedAt, "revokedAt should be set");
  const restoredSetting = await api<JsonObject>("GET", `/settings/${settingId}`);
  assert.equal(String(object(restoredSetting).content), "北港是帝国最大的港口城市。");
  const settingsAfterRevoke = await api<JsonObject>("GET", `/works/${workId}/settings`);
  const createdAfterRevoke = (Array.isArray(settingsAfterRevoke) ? settingsAfterRevoke as JsonObject[] : []).find((item) => item.title === "南港");
  assert.ok(createdAfterRevoke, "created entity must survive revoke");
  checked("revoke", "update restored to before values while created entity survives");

  // 关闭工具开关后，模型再次提交计划被拒绝。
  await api("PATCH", `/works/${workId}/ai-settings`, {
    aiWriteTools: {
      settings: false, characters: false, races: false, organizations: false, timeline: false,
      relationships: false, outlines: false, "chapter-annotations": false,
      "analysis-tasks": false, "ask-user-questions": false
    }
  });
  const disabledStream = await fetch(`${baseUrl}/api/works/${workId}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      instruction: "审批禁用场景：再提交一次修改计划。",
      scope: { type: "none" },
      modelId: String(model.id)
    })
  });
  const disabledText = await disabledStream.text();
  assert.match(disabledText, /TOOL_NOT_AVAILABLE/u);
  checked("disabled", "write tool rejected plans after switches were turned off");

  console.log(JSON.stringify({ ready: true, checks }));
} finally {
  if (appServer) {
    appServer.closeAllConnections();
    appServer.close();
  }
  mockAi.closeAllConnections();
  mockAi.close();
  runtime?.close();
  await rm(isolatedDirectory, { recursive: true, force: true });
}
