// 真实服务 E2E：AI 可写工具、修改计划审批与提问交互的完整链路。
// 使用本地 mock AI 模型驱动工具调用，验证计划生成、SSE 审批通知、审批执行与提问答复注入。
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
};

const checks: Array<{ feature: string; detail: string }> = [];
let mockFailure: Error | null = null;
let questionInjectedVerified = false;
let planToolResultVerified = false;

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
  try {
    if (incoming.url === "/v1/models") {
      outgoing.writeHead(200, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ data: [{ id: "e2e-write-model" }] }));
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
    if (joined.includes("请以该回答为准继续完成用户的任务")) {
      assert.match(joined, /选择哪个方向/u);
      assert.match(joined, /东方/u);
      assert.match(joined, /不得编造或假设其他答案/u);
      questionInjectedVerified = true;
      completion(outgoing, { content: "已按用户选择的东方方向继续。" });
      return;
    }
    if (joined.includes("E2E_QUESTION")) {
      if (results.size === 0) {
        toolCalls(outgoing, [
          { id: "ask-question", name: "ask_user_question", arguments: { question: "选择哪个方向？", options: ["东方", "西方"], recommendedOption: "东方" } }
        ]);
        return;
      }
      const questionResult = object(results.get("ask-question"));
      if (questionResult.ok !== true) {
        // 重复提问被拒绝：结束本轮
        completion(outgoing, { content: "已有待回答的问题，本轮结束。" });
        return;
      }
      assert.equal(String(object(questionResult.data).recommendedOption), "东方");
      assert.match(String(object(questionResult.data).message), /等待用户回答/u);
      completion(outgoing, { content: "我需要先确认方向，请回答上方问题。" });
      return;
    }
    if (joined.includes("E2E_WRITE_PLAN")) {
      if (results.size === 0) {
        assert.deepEqual(body.tools?.map((tool) => tool.function?.name), ["story_index", "read_chapters", "grep", "search_story_entities", "read_character_sections", "search_drafts", "image", "write_character", "ask_user_question"]);
        toolCalls(outgoing, [
          { id: "write-character", name: "write_character", arguments: { action: "create", name: "林舟", summary: "新建角色林舟" } }
        ]);
        return;
      }
      const writeResult = object(results.get("write-character"));
      assert.equal(writeResult.ok, true);
      assert.ok(String(object(writeResult.data).planId));
      assert.match(String(object(writeResult.data).message), /用户确认/u);
      planToolResultVerified = true;
      completion(outgoing, { content: "我已生成一份修改计划，请确认是否新建角色林舟。" });
      return;
    }
    completion(outgoing, { content: "E2E 默认响应。" });
  } catch (error) {
    mockFailure = error instanceof Error ? error : new Error(String(error));
    outgoing.writeHead(500, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify({ error: mockFailure.message }));
  }
});

const dataRoot = join(process.cwd(), ".data");
await mkdir(dataRoot, { recursive: true });
const isolatedDirectory = await mkdtemp(join(dataRoot, "e2e-ai-write-tools-"));
let runtime: ReturnType<typeof createRuntime> | null = null;
let appServer: ReturnType<ReturnType<typeof createRuntime>["app"]["listen"]> | null = null;

type StreamEvent = { event: string; payload: JsonObject };

async function streamRequest(baseUrl: string, path: string, body: JsonObject): Promise<StreamEvent[]> {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  const events: StreamEvent[] = [];
  let eventName = "message";
  const dataLines: string[] = [];
  const flush = (): void => {
    if (!dataLines.length) return;
    events.push({ event: eventName, payload: JSON.parse(dataLines.join("\n")) as JsonObject });
    dataLines.length = 0;
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      flush();
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();
  return events;
}

try {
  mockAi.listen(0, "127.0.0.1");
  await once(mockAi, "listening");
  const mockAddress = mockAi.address();
  assert.ok(mockAddress && typeof mockAddress !== "string");
  runtime = createRuntime({
    databasePath: join(isolatedDirectory, "novel.db"),
    masterSecret: "e2e-write-tools-master-secret-at-least-32-characters",
    disableUserAuth: true,
    devAuthBypass: true,
    security: { allowPrivateAiEndpoints: true, enforceSameOrigin: false, apiRateLimit: 10_000 }
  });
  const timestamp = new Date().toISOString();
  runtime.database.run(
    `INSERT INTO users (id, username, normalized_username, display_name, password_hash, password_salt, role, status, created_at, updated_at)
     VALUES ('e2e-dev-user', 'e2e_dev', 'e2e_dev', 'E2E 开发用户', 'hash', 'salt', 'admin', 'active', ?, ?)`,
    timestamp,
    timestamp
  );
  appServer = runtime.app.listen(0, "127.0.0.1");
  await once(appServer, "listening");
  const address = appServer.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function api<T = JsonObject>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}/api${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    });
    const payload = await response.json() as JsonObject;
    if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}: ${JSON.stringify(payload)}`);
    return (payload.data ?? payload) as T;
  }

  const health = await api<JsonObject>("GET", "/health");
  assert.equal(health.status, "ok");
  const page = await fetch(baseUrl).then((response) => response.text());
  assert.match(page, /id="ai-write-plan-dialog"/u);
  assert.match(page, /id="ai-question-dialog"/u);
  checked("ui-assets", "approval and question dialogs are served by the real app");

  const work = await api<JsonObject>("POST", "/works", { title: "可写工具 E2E" });
  const workId = String(work.id);
  const provider = await api<JsonObject>("POST", `/works/${workId}/providers`, {
    name: "E2E Write Provider",
    baseUrl: `http://127.0.0.1:${mockAddress.port}/v1`,
    apiKey: "sk-e2e-write-tools",
    status: "enabled",
    rpmLimit: 1_000
  });
  await api("POST", `/providers/${String(provider.id)}/test`, {});
  const model = await api<JsonObject>("POST", `/providers/${String(provider.id)}/models`, {
    displayName: "E2E Write Model",
    modelId: "e2e-write-model",
    contextWindow: 32_768
  });
  const modelId = String(model.id);

  // 默认全部关闭：工具列表不含可写工具
  const defaultSettings = await api<JsonObject>("GET", `/works/${workId}/ai-settings`);
  assert.equal(object(defaultSettings.writeTools).characters, false);
  // 开启角色可写工具与提问工具
  await api("PATCH", `/works/${workId}/ai-settings`, { writeTools: { characters: true, "ask-user-questions": true } });
  const enabledSettings = await api<JsonObject>("GET", `/works/${workId}/ai-settings`);
  assert.equal(object(enabledSettings.writeTools).characters, true);
  assert.equal(object(enabledSettings.writeTools)["ask-user-questions"], true);
  checked("write-tool-switches", "writable tools default to off and can be enabled per module");

  const conversation = await api<JsonObject>("POST", `/works/${workId}/ai-conversations`, {});
  const conversationId = String(conversation.id);

  // 第一轮：模型调用 write_character 生成修改计划，SSE 推送审批通知
  const planEvents = await streamRequest(baseUrl, `/works/${workId}/chat/stream`, {
    instruction: "E2E_WRITE_PLAN",
    scope: { type: "none" },
    modelId,
    conversationId
  });
  assert.equal(planToolResultVerified, true);
  const approvalEvent = planEvents.find((item) => item.event === "approval_plan");
  assert.ok(approvalEvent, "stream must push approval_plan event");
  const planPayload = object(approvalEvent.payload);
  const planId = String(planPayload.planId);
  assert.match(String(planPayload.aiSummary), /新建角色林舟/u);
  assert.equal((planPayload.operations as unknown[]).length, 1);
  const completeEvent = planEvents.find((item) => item.event === "complete");
  assert.ok(completeEvent);
  checked("approval-stream", "write tool stages an immutable plan and the stream pushes the approval notice");

  // 审批前角色未创建
  const charactersBefore = await api<JsonObject>("GET", `/works/${workId}/characters?page=1&limit=10`);
  assert.equal(Array.isArray(charactersBefore.items) ? charactersBefore.items.length : 0, 0);
  const planDetail = await api<JsonObject>("GET", `/works/${workId}/ai-write-plans/${planId}`);
  assert.equal(planDetail.status, "pending");
  const operations = planDetail.operations as unknown[];
  const operation = object(operations[0]);
  assert.equal(operation.opType, "create-entry");
  const diffs = operation.diff as unknown[];
  assert.equal(object(diffs[0]).label, "名称");
  assert.equal(object(operation.after).name, "林舟");
  checked("plan-detail", "plan detail carries system generated before/after values and diffs");

  // 用户确认后原子执行
  const executed = await api<JsonObject>("POST", `/works/${workId}/ai-write-plans/${planId}/approve`, {});
  assert.equal(executed.status, "executed");
  const characters = await api<JsonObject>("GET", `/works/${workId}/characters?page=1&limit=10`);
  const characterItems = characters.items as unknown[] | undefined;
  assert.equal(characterItems?.length, 1);
  assert.equal(String(object(characterItems?.[0] as JsonObject).name), "林舟");
  // 重复确认被拒绝
  const repeated = await fetch(`${baseUrl}/api/works/${workId}/ai-write-plans/${planId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(repeated.status, 409);
  checked("approval-execute", "approval executes exactly once with idempotent rejection");

  // 第二轮：AskUserQuestions 提问、回答与答案注入
  const questionEvents = await streamRequest(baseUrl, `/works/${workId}/chat/stream`, {
    instruction: "E2E_QUESTION",
    scope: { type: "none" },
    modelId,
    conversationId
  });
  const questionToolEvent = questionEvents.find((item) => item.event === "tool_call");
  assert.ok(questionToolEvent);
  const questionData = object(object(object(questionToolEvent.payload).result).data);
  const questionId = String(questionData.questionId);
  assert.deepEqual(questionData.options, ["东方", "西方"]);
  assert.equal(questionData.recommendedOption, "东方");
  checked("ask-user-question", "question tool persists a single choice question with recommended option first");

  // 未回答前再次提问被拒绝
  const duplicateQuestion = await streamRequest(baseUrl, `/works/${workId}/chat/stream`, {
    instruction: "E2E_QUESTION",
    scope: { type: "none" },
    modelId,
    conversationId
  });
  const failedTool = duplicateQuestion.find((item) => item.event === "tool_call");
  assert.ok(failedTool);
  assert.equal(object(object(failedTool.payload).result).ok, false);
  assert.equal(object(object(object(failedTool.payload).result).error).code, "QUESTION_ALREADY_PENDING");
  checked("question-once", "second pending question in the same conversation is rejected");

  // 回答后继续对话,模型收到注入的答案
  const answered = await api<JsonObject>("POST", `/ai-questions/${questionId}/answer`, { answer: "东方" });
  assert.equal(answered.status, "answered");
  assert.equal(answered.answer, "东方");
  const continueEvents = await streamRequest(baseUrl, `/works/${workId}/chat/stream`, {
    instruction: "",
    continueConversation: true,
    scope: { type: "none" },
    modelId,
    conversationId
  });
  assert.equal(questionInjectedVerified, true);
  const continueComplete = continueEvents.find((item) => item.event === "complete");
  assert.ok(continueComplete);
  checked("question-injection", "answer is injected as a tool result and the model continues without fabricating it");

  if (mockFailure) throw mockFailure;
  console.log(`\n[e2e-write] 全部通过：${checks.length} 项检查`);
  for (const item of checks) console.log(`[e2e-write] - ${item.feature}: ${item.detail}`);
} finally {
  appServer?.closeAllConnections();
  if (appServer) await new Promise<void>((resolve) => appServer?.close(() => resolve()));
  runtime?.close();
  mockAi.closeAllConnections();
  await new Promise<void>((resolve) => mockAi.close(() => resolve()));
  await rm(isolatedDirectory, { recursive: true, force: true });
}
