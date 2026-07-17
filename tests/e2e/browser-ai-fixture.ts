import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { createRuntime } from "../../src/app.js";
import { runWithRequestActor } from "../../src/request-context.js";

type JsonObject = Record<string, unknown>;
type CompletionMessage = { role?: string; tool_call_id?: string; content?: string };

const port = Number(process.env.E2E_BROWSER_PORT ?? 13212);
const dataRoot = join(process.cwd(), ".data");
await mkdir(dataRoot, { recursive: true });
const isolatedDirectory = await mkdtemp(join(dataRoot, "e2e-browser-ai-"));
let chapterId = "";

async function readRequest(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject;
}

function sendCompletion(response: ServerResponse, message: JsonObject): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ choices: [{ message }], usage: { completion_tokens: 32 } }));
}

function sendToolCalls(response: ServerResponse, calls: Array<{ id: string; name: string; arguments: unknown }>): void {
  sendCompletion(response, {
    content: null,
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments }
    }))
  });
}

const mockAi = createServer(async (request, response) => {
  if (request.url === "/v1/models") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "browser-agent-model" }] }));
    return;
  }
  if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  const body = await readRequest(request);
  const messages = Array.isArray(body.messages) ? body.messages as CompletionMessage[] : [];
  const latestUserMessage = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const joined = messages.map((message) => message.content ?? "").join("\n");
  const toolMessages = messages.filter((message) => message.role === "tool");
  if (joined.includes("将下面的历史对话压缩")) {
    sendCompletion(response, { content: "作者要求遵守跃迁冷却规则；最近正在确认燃料状态。" });
    return;
  }
  if (latestUserMessage.includes("浏览器工具测试")) {
    if (toolMessages.length === 0) {
      sendToolCalls(response, [
        { id: "browser-index", name: "story_index", arguments: { offset: 0, limit: 1 } },
        { id: "browser-read", name: "read_chapters", arguments: { chapterIds: [chapterId], include: "both" } },
        { id: "browser-query", name: "query_story_knowledge", arguments: { query: "跃迁", categories: ["setting"] } }
      ]);
      return;
    }
    sendCompletion(response, { content: "模型已处理三个工具结果：目录、章节正文和跃迁设定均已确认。" });
    return;
  }
  if (latestUserMessage.includes("这是什么项目")) {
    const systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
    if (!systemPrompt.includes("预加载上下文为空或不足时，必须先调用工具主动查询")) {
      sendCompletion(response, { content: "当前没有上下文，无法判断项目内容。" });
      return;
    }
    if (toolMessages.length === 0) {
      sendToolCalls(response, [{ id: "browser-project-index", name: "story_index", arguments: {} }]);
      return;
    }
    const result = JSON.parse(toolMessages[0]?.content ?? "{}") as JsonObject;
    const data = result.data as JsonObject;
    const work = data.work as JsonObject;
    sendCompletion(response, { content: `这是《${String(work.title)}》，作者是 ${String(work.author)}，当前共有 ${String(work.chapterCount)} 章。` });
    return;
  }
  if (latestUserMessage.includes("浏览器工具失败测试")) {
    if (toolMessages.length === 0) {
      sendToolCalls(response, [
        { id: "browser-invalid", name: "query_story_knowledge", arguments: { query: "", categories: ["unknown"] } },
        { id: "browser-unknown", name: "write_chapter", arguments: {} }
      ]);
      return;
    }
    sendCompletion(response, { content: "模型已收到英文工具错误，并在不伪造结果的情况下继续回答。" });
    return;
  }
  if (latestUserMessage.includes("浏览器多轮工具测试")) {
    if (toolMessages.length === 0) {
      sendToolCalls(response, [{ id: "browser-multi-index", name: "story_index", arguments: { limit: 1 } }]);
      return;
    }
    if (toolMessages.length === 1) {
      const indexResult = JSON.parse(toolMessages[0]?.content ?? "{}") as JsonObject;
      const data = indexResult.data as JsonObject;
      const chapters = Array.isArray(data?.chapters) ? data.chapters as JsonObject[] : [];
      sendToolCalls(response, [{ id: "browser-multi-read", name: "read_chapters", arguments: { chapterIds: [String(chapters[0]?.id ?? chapterId)], include: "content" } }]);
      return;
    }
    sendCompletion(response, { content: "模型先查询目录，再读取对应章节，确认林舟启动了跃迁。" });
    return;
  }
  if (latestUserMessage.includes("浏览器压缩后测试")) {
    sendCompletion(response, { content: "已基于压缩摘要和最近对话继续回答，跃迁冷却规则仍然保留。" });
    return;
  }
  sendCompletion(response, { content: "浏览器 E2E 默认响应。" });
});

mockAi.listen(0, "127.0.0.1");
await once(mockAi, "listening");
const mockAddress = mockAi.address();
if (!mockAddress || typeof mockAddress === "string") throw new Error("Mock AI server failed to start");

const runtime = createRuntime({
  databasePath: join(isolatedDirectory, "novel.db"),
  masterSecret: "browser-e2e-master-secret-at-least-32-characters",
  security: { allowPrivateAiEndpoints: true, enforceSameOrigin: false, apiRateLimit: 10_000 }
});
const registered = runtime.auth.register({ username: "browser-e2e", password: "BrowserE2E123!" });
const fixture = runWithRequestActor(registered.session.user, () => {
  const work = runtime.store.createWork({ title: "浏览器 AI E2E", author: "Codex" });
  const workId = String(work.id);
  const volume = runtime.store.createVolume(workId, { title: "第一卷" });
  const chapter = runtime.store.createChapter(workId, {
    volumeId: String(volume.id),
    title: "第一章 跃迁",
    content: "林舟启动了跃迁，飞船随后进入十二小时冷却。"
  });
  chapterId = String(chapter.id);
  runtime.store.createSetting(workId, {
    title: "跃迁冷却",
    category: "世界规则",
    content: "跃迁后必须冷却十二小时。",
    locked: true,
    status: "confirmed"
  });
  const provider = runtime.ai.createProvider({
    name: "浏览器 E2E 模型",
    baseUrl: `http://127.0.0.1:${mockAddress.port}/v1`,
    apiKey: "sk-browser-e2e",
    status: "enabled",
    rpmLimit: 1_000
  });
  runtime.database.run("UPDATE providers SET connection_status = 'success' WHERE id = ?", String(provider.id));
  const model = runtime.ai.createModel(String(provider.id), {
    displayName: "浏览器 Agent 模型",
    modelId: "browser-agent-model",
    contextWindow: 4_096
  });
  runtime.ai.setTaskDefault(workId, "chat", String(model.id));
  runtime.store.updateWorkAiSettings(workId, { contextCompactThreshold: 50 });
  return { workId, chapterId, modelId: String(model.id) };
});

let compactConversationId = "";
const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (requestUrl.pathname === "/__e2e/login") {
    response.setHeader("Set-Cookie", `scriverse_session=${encodeURIComponent(registered.token)}; Path=/; HttpOnly; SameSite=Lax`);
    response.writeHead(302, { Location: `/#view=editor&work=${fixture.workId}&chapter=${fixture.chapterId}` });
    response.end();
    return;
  }
  if (requestUrl.pathname === "/__e2e/seed-compact") {
    if (!compactConversationId) {
      runWithRequestActor(registered.session.user, () => {
        const conversation = runtime.store.createAiConversation(fixture.workId, "上下文压缩浏览器 E2E");
        compactConversationId = String(conversation.id);
        runtime.store.addAiConversationMessage(compactConversationId, { role: "user", content: `旧作者要求：${"必须遵守跃迁冷却规则。".repeat(100)}` });
        runtime.store.addAiConversationMessage(compactConversationId, { role: "assistant", content: `旧助手回答：${"飞船仍在北港附近。".repeat(100)}` });
        runtime.store.addAiConversationMessage(compactConversationId, { role: "user", content: "最近问题：燃料状态如何？" });
        runtime.store.addAiConversationMessage(compactConversationId, { role: "assistant", content: "最近回答：正文未明确燃料余量。" });
      });
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ conversationId: compactConversationId }));
    return;
  }
  runtime.app(request, response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ ready: true, baseUrl: `http://127.0.0.1:${port}`, ...fixture }));
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.closeAllConnections();
  server.close();
  mockAi.closeAllConnections();
  mockAi.close();
  runtime.close();
  await rm(isolatedDirectory, { recursive: true, force: true });
  process.exit(0);
}

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
