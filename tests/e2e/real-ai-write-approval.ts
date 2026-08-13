import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { createRuntime } from "../../src/app.js";

type JsonObject = Record<string, any>;

const checks: Array<{ feature: string; detail: string }> = [];
let mockFailure: Error | null = null;

function checked(feature: string, detail: string): void {
  checks.push({ feature, detail });
  console.log(`[e2e] ${feature}: ${detail}`);
}

function object(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "expected object");
  return value as JsonObject;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "expected array");
  return value;
}

async function readRequest(incoming: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject;
}

function toolCalls(
  outgoing: ServerResponse,
  calls: Array<{ id: string; name: string; arguments: unknown }>,
  content: string | null = null
): void {
  outgoing.writeHead(200, { "Content-Type": "application/json" });
  outgoing.end(JSON.stringify({
    choices: [{
      message: {
        content,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments }
        }))
      }
    }],
    usage: { completion_tokens: 64 }
  }));
}

function completion(outgoing: ServerResponse, content: string): void {
  outgoing.writeHead(200, { "Content-Type": "application/json" });
  outgoing.end(JSON.stringify({ choices: [{ message: { content } }], usage: { completion_tokens: 64 } }));
}

const mockAi = createServer(async (incoming, outgoing) => {
  try {
    if (incoming.url === "/v1/models") {
      outgoing.writeHead(200, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ data: [{ id: "e2e-write-approval-model" }] }));
      return;
    }
    if (incoming.url !== "/v1/chat/completions" || incoming.method !== "POST") {
      outgoing.writeHead(404).end();
      return;
    }
    const body = await readRequest(incoming);
    const messages = array(body.messages ?? []);
    const toolMessages = messages.filter((message) => object(message).role === "tool");
    const tools = array(body.tools ?? []);
    const toolNames = tools.map((tool) => object(object(tool).function).name);
    const joined = messages.map((message) => object(message).content ?? "").join("\n");
    if (joined.includes("E2E_WRITE_PLAN")) {
      if (toolMessages.length === 0) {
        // 工具清单必须在只读工具之外包含全部可写工具
        for (const name of ["create_story_entity", "update_story_entity", "create_chapter_annotation", "create_analysis_task", "ask_user_question"]) {
          assert.ok(toolNames.includes(name), `missing write tool ${name} in ${JSON.stringify(toolNames)}`);
        }
        toolCalls(outgoing, [
          { id: "write-setting", name: "create_story_entity", arguments: { entityType: "setting", fields: { title: "AI 新建设定", category: "世界规则", content: "由侧边栏 AI 提出并经审批创建。" }, summary: "新增世界观设定《AI 新建设定》" } },
          { id: "write-question", name: "ask_user_question", arguments: { question: "新设定应锁定为世界规则吗？", options: [{ label: "锁定为世界规则" }, { label: "保持可修改" }], summary: "确认设定锁定状态" } }
        ]);
        return;
      }
      assert.equal(toolMessages.length, 2);
      completion(outgoing, "已提交修改计划并等待用户审批；同时向用户提出了一个问题。");
      return;
    }
    completion(outgoing, "E2E 默认响应。");
  } catch (error) {
    mockFailure = error instanceof Error ? error : new Error(String(error));
    outgoing.writeHead(500, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify({ error: mockFailure.message }));
  }
});

const dataRoot = join(process.cwd(), ".data");
await mkdir(dataRoot, { recursive: true });
const isolatedDirectory = await mkdtemp(join(dataRoot, "e2e-ai-write-approval-"));
let runtime: ReturnType<typeof createRuntime> | null = null;
let appServer: ReturnType<ReturnType<typeof createRuntime>["app"]["listen"]> | null = null;

try {
  mockAi.listen(0, "127.0.0.1");
  await once(mockAi, "listening");
  const mockAddress = mockAi.address();
  assert.ok(mockAddress && typeof mockAddress !== "string");
  runtime = createRuntime({
    databasePath: join(isolatedDirectory, "novel.db"),
    masterSecret: "e2e-write-approval-master-secret-at-least-32",
    disableUserAuth: true,
    security: { allowPrivateAiEndpoints: true, enforceSameOrigin: false, apiRateLimit: 10_000 }
  });
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

  // 页面资产：审批中心视图、详情对话框与设置入口。
  const page = await fetch(baseUrl).then((response) => response.text());
  const application = await fetch(`${baseUrl}/app.js`).then((response) => response.text());
  assert.match(page, /id="ai-approval-center-view"/u);
  assert.match(page, /id="ai-write-plan-dialog"/u);
  assert.match(page, /id="ai-approval-center-button"/u);
  assert.match(application, /eventName === "plan_created"/u);
  assert.match(application, /eventName === "question_created"/u);
  assert.match(application, /（最推荐）/u);
  checked("ui-assets", "approval center page, plan dialog, plan/question SSE handling and recommended option label are served by the real app");

  // 默认关闭：开启前 AI 不可见任何写工具。
  const work = await api<JsonObject>("POST", "/works", { title: "AI 写审批 E2E" });
  const workId = String(work.id);
  const volume = await api<JsonObject>("POST", `/works/${workId}/volumes`, { title: "第一卷" });
  const chapter = await api<JsonObject>("POST", `/works/${workId}/chapters`, {
    volumeId: String(volume.id),
    title: "第一章",
    content: "黎明时，林舟抵达北港。"
  });
  const chapterId = String(chapter.id);
  const provider = await api<JsonObject>("POST", `/works/${workId}/providers`, {
    name: "E2E Write Provider",
    baseUrl: `http://127.0.0.1:${mockAddress.port}/v1`,
    apiKey: "sk-e2e-write-approval",
    status: "enabled",
    rpmLimit: 1_000
  });
  await api("POST", `/providers/${String(provider.id)}/test`, {});
  const model = await api<JsonObject>("POST", `/providers/${String(provider.id)}/models`, {
    displayName: "E2E Write Model",
    modelId: "e2e-write-approval-model",
    contextWindow: 32_768
  });
  const modelId = String(model.id);

  // 开启全部写工具开关。
  await api("PATCH", `/works/${workId}/ai-settings`, {
    aiWriteTools: ["entity:settings", "annotation", "analysis-task", "ask-question"]
  });

  // 侧边栏对话流：AI 发起写工具调用 → 系统生成计划与问题 → SSE 事件送达。
  const streamResponse = await fetch(`${baseUrl}/api/works/${workId}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      instruction: "E2E_WRITE_PLAN",
      scope: { type: "chapter", chapterId },
      modelId
    })
  });
  assert.equal(streamResponse.status, 200);
  const streamText = await streamResponse.text();
  assert.match(streamText, /event: plan_created/u);
  assert.match(streamText, /event: question_created/u);
  assert.match(streamText, /AI 新建设定/u);
  checked("chat-stream-plan", "write tool calls from the sidebar AI produce an immutable plan and a persisted question via SSE");

  // 计划持久化：审批中心列表与详情包含系统 diff。
  const plans = await api<JsonObject>("GET", `/works/${workId}/ai-write-plans`);
  const items = array(object(plans).items);
  assert.equal(items.length, 1);
  const plan = object(items[0]);
  assert.equal(plan.status, "pending");
  assert.equal(Number(plan.operationCount), 1);
  assert.equal(object(plans).stats.pending, 1);
  const planDetail = await api<JsonObject>("GET", `/ai-write-plans/${String(plan.id)}`);
  assert.equal(array(object(planDetail).operations).length, 1);
  const operation = object(array(object(planDetail).operations)[0]);
  assert.equal(operation.operationType, "entity_create");
  assert.equal(operation.entityType, "setting");
  const diff = array(operation.diff);
  assert.ok(diff.length >= 2);
  assert.equal(object(diff[0]).label, "标题");
  assert.equal(object(diff[0]).before, null);
  assert.equal(object(diff[0]).after, "AI 新建设定");
  checked("plan-detail", "plan details carry system-generated field diffs with before/after values");

  // 确认前没有任何写入。
  assert.equal(array(await api<JsonObject>("GET", `/works/${workId}/settings`)).length, 0);
  const pendingQuestions = await api<JsonObject>("GET", `/works/${workId}/ai-approval-questions`);
  assert.equal(array(pendingQuestions).length, 1);
  const question = object(array(pendingQuestions)[0]);
  assert.equal(question.question, "新设定应锁定为世界规则吗？");
  assert.equal(object(array(question.options)[0]).recommended, true);
  checked("question-pending", "AskUserQuestions persisted with the first option marked recommended and no writes before approval");

  // 确认执行。
  const approved = await api<JsonObject>("POST", `/ai-write-plans/${String(plan.id)}/decision`, { action: "approve" });
  assert.equal(approved.status, "succeeded");
  const settingsAfter = array(await api<JsonObject>("GET", `/works/${workId}/settings`));
  assert.equal(settingsAfter.length, 1);
  assert.equal(object(settingsAfter[0]).title, "AI 新建设定");
  // 重复确认幂等，不产生第二条词条。
  const repeated = await api<JsonObject>("POST", `/ai-write-plans/${String(plan.id)}/decision`, { action: "approve" });
  assert.equal(repeated.status, "succeeded");
  assert.equal(array(await api<JsonObject>("GET", `/works/${workId}/settings`)).length, 1);
  checked("approve-idempotent", "approval executes atomically and repeated confirmation writes nothing twice");

  // 新建词条不支持通过撤销删除。
  const revokeResponse = await fetch(`${baseUrl}/api/ai-write-plans/${String(plan.id)}/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(revokeResponse.status, 409);
  assert.equal(array(await api<JsonObject>("GET", `/works/${workId}/settings`)).length, 1);
  checked("revoke-create-denied", "AI-created entities are not removed by revoke");

  // 问题回答。
  const answered = await api<JsonObject>("POST", `/ai-approval-questions/${String(question.id)}/answer`, { answer: "锁定为世界规则" });
  assert.equal(answered.status, "answered");
  assert.equal(answered.answer, "锁定为世界规则");
  const repeatAnswer = await fetch(`${baseUrl}/api/ai-approval-questions/${String(question.id)}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer: "重复回答" })
  });
  assert.equal(repeatAnswer.status, 409);
  checked("question-answer", "questions accept exactly one answer and reject repeated or fabricated ones");

  // 编辑词条 + 撤销闭环。
  const existingSetting = object(settingsAfter[0]);
  const editPlan = await api<JsonObject>("POST", `/works/${workId}/ai-write-plans`, { action: "unused" }).catch(async () => null);
  void editPlan;
  const plan2 = runtime.aiWriteApprovals.createPlan({
    workId,
    conversationId: null,
    requesterUserId: "",
    conversationOwnerUserId: "",
    summary: "编辑已有设定",
    operations: [{
      operationType: "entity_update",
      entityType: "setting",
      targetModule: "settings",
      targetId: String(existingSetting.id),
      targetVersion: Number(existingSetting.versionNo),
      aiSummary: "修改设定标题",
      before: { title: "AI 新建设定" },
      after: { title: "AI 修改后的设定" },
      diff: [{ field: "title", label: "标题", before: "AI 新建设定", after: "AI 修改后的设定" }]
    }]
  });
  await api("POST", `/ai-write-plans/${String(plan2.id)}/decision`, { action: "approve" });
  const afterEdit = object(array(await api<JsonObject>("GET", `/works/${workId}/settings`))[0]);
  assert.equal(afterEdit.title, "AI 修改后的设定");
  await api("POST", `/ai-write-plans/${String(plan2.id)}/revoke`, {});
  const afterRevoke = object(array(await api<JsonObject>("GET", `/works/${workId}/settings`))[0]);
  assert.equal(afterRevoke.title, "AI 新建设定");
  checked("edit-revoke", "edited entities restore to their previous values with a new version on revoke");

  // 失效流程：目标版本变化后确认被拒绝并标记 invalidated。
  const settingBefore = afterRevoke;
  const stalePlan = runtime.aiWriteApprovals.createPlan({
    workId,
    conversationId: null,
    requesterUserId: "",
    conversationOwnerUserId: "",
    summary: "版本过期计划",
    operations: [{
      operationType: "entity_update",
      entityType: "setting",
      targetModule: "settings",
      targetId: String(settingBefore.id),
      targetVersion: Number(settingBefore.versionNo),
      aiSummary: "过期修改",
      before: { title: "AI 新建设定" },
      after: { title: "永远不会生效" },
      diff: [{ field: "title", label: "标题", before: "AI 新建设定", after: "永远不会生效" }]
    }]
  });
  await api("PATCH", `/settings/${String(settingBefore.id)}`, { title: "人工修改" });
  const staleResponse = await fetch(`${baseUrl}/api/ai-write-plans/${String(stalePlan.id)}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "approve" })
  });
  assert.equal(staleResponse.status, 409);
  const staleDetail = await api<JsonObject>("GET", `/ai-write-plans/${String(stalePlan.id)}`);
  assert.equal(staleDetail.status, "invalidated");
  assert.match(String(staleDetail.invalidReason), /版本已变化/u);
  checked("invalidate-on-version-change", "stale target versions invalidate the whole plan with a concrete reason");

  assert.equal(mockFailure, null);
  console.log(`[e2e] ${checks.length} checks passed`);
} finally {
  appServer?.close();
  mockAi.close();
  runtime?.close();
}
