import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

type Entity = Record<string, any>;

const baseUrl = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:3210/api").replace(/\/$/u, "");
const appUrl = baseUrl.replace(/\/api$/u, "");
const checks: Array<{ feature: string; detail: string }> = [];
const suffix = Date.now().toString(36);
let disposableWorkId: string | null = null;
const cleanupWorkIds = new Set<string>();
let upstreamStreamCompleted = false;

function checked(feature: string, detail: string): void {
  checks.push({ feature, detail });
  console.log(`[e2e] ${feature}: ${detail}`);
}

async function readRequest(incoming: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

const mockAi = createServer(async (incoming: IncomingMessage, outgoing: ServerResponse) => {
  if (incoming.url === "/v1/models") {
    outgoing.writeHead(200, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify({ data: [{ id: "e2e-deterministic-model" }] }));
    return;
  }
  if (incoming.url === "/v1/chat/completions" && incoming.method === "POST") {
    const body = await readRequest(incoming);
    const messages = body.messages as Array<{ content?: string }>;
    const prompt = messages?.[1]?.content ?? "";
    let content = "林舟留在北港，继续检查那封旧信。";
    if (prompt.includes("检查下面的续写候选")) {
      content = "[]";
    } else if (prompt.includes("小说人物关系抽取器")) {
      const chapter = prompt.match(/<CHAPTER id="([^"]+)" title="([^"]+)">/u);
      content = JSON.stringify([{
        fromCharacterId: "林舟",
        toCharacterId: "沈星",
        category: "social",
        subtype: "旧友",
        keywords: ["长期信任", "失联重逢", "共同守望"],
        directed: false,
        currentStatus: "active",
        timeRange: {},
        confidence: 0.9,
        evidence: [{
          chapterId: chapter?.[1],
          chapterTitle: chapter?.[2],
          quote: "我们一直是朋友",
          contextType: "current",
          supports: "原文直接说明"
        }]
      }]);
    }
    if (body.stream === true) {
      upstreamStreamCompleted = false;
      outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
      outgoing.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "林舟收到" } }] })}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      outgoing.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "流式回复。" }, finish_reason: "stop" }] })}\n\n`);
      upstreamStreamCompleted = true;
      outgoing.end("data: [DONE]\n\n");
      return;
    }
    outgoing.writeHead(200, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify({ choices: [{ message: { content } }] }));
    return;
  }
  outgoing.writeHead(404).end();
});

async function api<T = Entity>(method: string, path: string, body?: unknown): Promise<T> {
  const form = body instanceof FormData;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined ? {} : form ? { body } : {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
  });
  const payload = response.status === 204 ? null : await response.json() as Entity;
  if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}: ${JSON.stringify(payload)}`);
  return (payload?.data ?? payload) as T;
}

async function expectApiError(method: string, path: string, body: unknown, expectedStatus: number, expectedCode: string): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json() as Entity;
  assert.equal(response.status, expectedStatus);
  assert.equal(payload.error?.code, expectedCode);
}

try {
  mockAi.listen(0, "127.0.0.1");
  await once(mockAi, "listening");
  const address = mockAi.address();
  if (!address || typeof address === "string") throw new Error("Mock AI server failed to start");
  const mockBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  const health = await api<Entity>("GET", "/health");
  assert.equal(health.status, "ok");
  checked("health", "service is available");

  const [page, application, graph] = await Promise.all([
    fetch(`${appUrl}/`).then((response) => response.text()),
    fetch(`${appUrl}/app.js`).then((response) => response.text()),
    fetch(`${appUrl}/relationship-graph.js`).then((response) => response.text())
  ]);
  assert.match(page, /id="shelf-view"/u);
  assert.match(page, /data-testid="relationship-fullscreen"/u);
  assert.match(page, /data-testid="relationship-map-expanded"/u);
  assert.match(page, /data-testid="chapter-type-menu"/u);
  assert.match(application, /preservedOccurrences/u);
  assert.match(application, /openOrganizationDialog/u);
  assert.match(application, /concurrencyLimit/u);
  assert.match(application, /step="any"/u);
  assert.match(application, /streamChat/u);
  assert.match(application, /collapsedVolumeIds/u);
  assert.match(application, /contextmenu/u);
  assert.match(graph, /createGalaxyRenderer/u);
  assert.match(graph, /relationship-map-expand/u);
  assert.match(graph, /highlightedKeywords/u);
  assert.match(graph, /is-related/u);
  checked("ui-assets", "shelf, organizations, provider limits, foreshadow preservation, mind map, and galaxy assets are reachable");

  const importedForm = new FormData();
  importedForm.append("title", `E2E 可清理作品 ${suffix}`);
  importedForm.append("author", "E2E");
  importedForm.append("file", new Blob([
    "第一卷 起航\n第一章 旧友\n林舟在北港见到沈星。沈星说：我们一直是朋友。\n第二章 离港\n林舟仍在北港检查旧信。\n第三章 回收\n沈星打开旧信。\n后记\n感谢读者陪伴。"
  ], { type: "text/plain" }), "e2e-current-features.txt");
  const imported = await api<Entity>("POST", "/works/import", importedForm);
  disposableWorkId = String(imported.work.id);
  cleanupWorkIds.add(disposableWorkId);
  const tree = await api<Entity>("GET", `/works/${disposableWorkId}`);
  const chapters = tree.volumes.flatMap((volume: Entity) => volume.chapters) as Entity[];
  assert.equal(chapters.length, 4);
  const [firstChapter, secondChapter, thirdChapter, postscriptChapter] = chapters;
  assert.ok(firstChapter && secondChapter && thirdChapter && postscriptChapter);
  assert.ok(chapters.every((chapter) => chapter.content.trim()));
  assert.equal(tree.volumes.length, 1);
  assert.equal(postscriptChapter.title, "后记");
  assert.equal(postscriptChapter.chapterType, "作者的话");
  checked("disposable-import", "a fresh work was imported and its postscript remained a typed chapter instead of a standalone volume");

  const originalVersion = secondChapter.versionNo;
  const typedChapter = await api<Entity>("PATCH", `/chapters/${secondChapter.id}`, { chapterType: "设定" });
  assert.equal(typedChapter.chapterType, "设定");
  assert.equal(typedChapter.versionNo, originalVersion);
  checked("chapter-types", "all chapter metadata supports type marking without creating a false content version");

  const coverForm = new FormData();
  coverForm.append("file", new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])], { type: "image/png" }), "cover.png");
  const covered = await api<Entity>("PUT", `/works/${disposableWorkId}/cover`, coverForm);
  assert.match(covered.coverUrl, /\/cover\?v=/u);
  const coverResponse = await fetch(`${baseUrl}/works/${disposableWorkId}/cover`);
  assert.equal(coverResponse.status, 200);
  assert.match(coverResponse.headers.get("content-type") ?? "", /image\/png/u);
  checked("cover", "cover upload and binary retrieval succeed");

  const lin = await api<Entity>("POST", `/works/${disposableWorkId}/characters`, {
    name: "林舟",
    aliases: ["阿舟", "Lin Zhou"],
    currentState: { location: "北港" },
    lockedFields: ["location"]
  });
  const shen = await api<Entity>("POST", `/works/${disposableWorkId}/characters`, { name: "沈星", aliases: ["沈博士"] });
  await expectApiError("POST", `/works/${disposableWorkId}/characters`, { name: "ＡＬＩＡＳ", aliases: ["lin zhou"] }, 409, "CHARACTER_NAME_CONFLICT");
  const otherWork = await api<Entity>("POST", "/works", { title: `E2E 别名隔离 ${suffix}` });
  cleanupWorkIds.add(otherWork.id);
  await api("POST", `/works/${otherWork.id}/characters`, { name: "Lin Zhou" });
  await api("DELETE", `/works/${otherWork.id}`);
  cleanupWorkIds.delete(otherWork.id);
  checked("character-aliases", "canonical names and aliases are normalized uniquely per work");

  const organization = await api<Entity>("POST", `/works/${disposableWorkId}/organizations`, {
    name: "北港守望会",
    description: "维护北港航道与旧约的自治组织。",
    settings: ["以星图为成员信物", "重大决策需双席同意"],
    memberIds: [lin.id]
  });
  const shenInOrganization = await api<Entity>("PATCH", `/characters/${shen.id}`, { organizationIds: [organization.id] });
  assert.deepEqual(shenInOrganization.organizationIds, [organization.id]);
  const organizations = await api<Entity[]>("GET", `/works/${disposableWorkId}/organizations`);
  assert.deepEqual(new Set(organizations[0]?.memberIds), new Set([lin.id, shen.id]));
  assert.deepEqual(organizations[0]?.settings, ["以星图为成员信物", "重大决策需双席同意"]);
  checked("organizations", "organization settings and character membership stay synchronized in both directions");

  await api("PUT", `/chapters/${firstChapter.id}/outline`, {
    goal: "建立旧友关系",
    conflict: "是否公开旧信",
    turningPoint: "决定离港",
    status: "ready"
  });
  const foreshadow = await api<Entity>("POST", `/works/${disposableWorkId}/foreshadows`, {
    title: "旧信内容",
    status: "planted",
    importance: "high",
    plannedPayoffChapterId: thirdChapter.id,
    occurrences: [
      { chapterId: firstChapter.id, role: "setup", note: "首次出现" },
      { chapterId: secondChapter.id, role: "reminder", note: "第一次提醒" },
      { chapterId: thirdChapter.id, role: "reminder", note: "第二次提醒" }
    ]
  });
  const renamedForeshadow = await api<Entity>("PATCH", `/foreshadows/${foreshadow.id}`, { title: "旧信的真相" });
  assert.equal(renamedForeshadow.occurrences.length, 3);
  const outlines = await api<Entity[]>("GET", `/works/${disposableWorkId}/outlines`);
  assert.equal(outlines[0]?.goal, "建立旧友关系");
  checked("outline-foreshadow", "outline and repeated foreshadow occurrences survive metadata edits");

  const provider = await api<Entity>("POST", `/works/${disposableWorkId}/providers`, {
    name: "E2E deterministic provider",
    baseUrl: mockBaseUrl,
    apiKey: "sk-e2e-disposable-secret",
    status: "enabled"
  });
  assert.equal(provider.concurrencyLimit, 10);
  assert.equal(provider.rpmLimit, 10);
  const configuredProvider = await api<Entity>("PATCH", `/providers/${provider.id}`, { concurrencyLimit: 4, rpmLimit: 20 });
  assert.equal(configuredProvider.concurrencyLimit, 4);
  assert.equal(configuredProvider.rpmLimit, 20);
  const connection = await api<Entity>("POST", `/providers/${provider.id}/test`, {});
  assert.equal(connection.ok, true);
  const model = await api<Entity>("POST", `/providers/${provider.id}/models`, {
    displayName: "E2E deterministic model",
    modelId: "e2e-deterministic-model"
  });
  assert.equal(model.preset.max_tokens, 32_000);

  const streamResponse = await fetch(`${baseUrl}/works/${disposableWorkId}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ instruction: "给出流式回复", scope: { type: "chapter", chapterId: firstChapter.id }, modelId: model.id })
  });
  assert.equal(streamResponse.status, 200);
  assert.ok(streamResponse.body);
  const streamReader = streamResponse.body.getReader();
  const streamDecoder = new TextDecoder();
  let streamedText = "";
  let observedDeltaBeforeUpstreamEnd = false;
  while (true) {
    const chunk = await streamReader.read();
    streamedText += streamDecoder.decode(chunk.value, { stream: !chunk.done });
    if (streamedText.includes('event: delta\ndata: {"delta":"林舟收到"}') && !upstreamStreamCompleted) {
      observedDeltaBeforeUpstreamEnd = true;
    }
    if (chunk.done) break;
  }
  assert.equal(observedDeltaBeforeUpstreamEnd, true);
  assert.match(streamedText, /event: delta\ndata: \{"delta":"流式回复。"\}/u);
  assert.match(streamedText, /event: complete/u);
  checked("streaming-chat", "the sidebar chat endpoint forwards the first model delta before the upstream response finishes");

  const suggestion = await api<Entity>("POST", `/works/${disposableWorkId}/suggestions`, {
    taskType: "continue",
    instruction: "让阿舟继续检查旧信。",
    scope: { type: "chapter", chapterId: firstChapter.id },
    modelId: model.id
  });
  assert.equal(suggestion.guard.status, "clear");
  await api("PATCH", `/characters/${lin.id}`, { currentState: { location: "主星" } });
  await expectApiError("POST", `/suggestions/${suggestion.id}/accept`, {}, 409, "GUARD_STALE");
  await api("POST", `/suggestions/${suggestion.id}/guard`, {});
  const accepted = await api<Entity>("POST", `/suggestions/${suggestion.id}/accept`, {});
  assert.match(accepted.chapter.content, /继续检查那封旧信/u);
  checked("continuation-guard", "knowledge changes invalidate a guard and a rerun permits acceptance");

  const relationshipTask = await api<Entity>("POST", `/works/${disposableWorkId}/tasks`, {
    taskType: "relationship-analysis",
    scope: { type: "book" }
  });
  const relationshipResult = await api<Entity>("POST", `/tasks/${relationshipTask.id}/run`, { modelId: model.id });
  assert.equal(relationshipResult.status, "review");
  let relationships = await api<Entity[]>("GET", `/works/${disposableWorkId}/relationships`);
  const generated = relationships.find((relationship) => relationship.subtype === "旧友" && relationship.confirmationStatus === "pending");
  assert.ok(generated);
  assert.deepEqual(generated.keywords, ["长期信任", "失联重逢", "共同守望"]);
  await api("PATCH", `/relationships/${generated.id}`, { confirmationStatus: "rejected" });
  const retryTask = await api<Entity>("POST", `/works/${disposableWorkId}/tasks`, { taskType: "relationship-analysis", scope: { type: "book" } });
  await api("POST", `/tasks/${retryTask.id}/run`, { modelId: model.id });
  relationships = await api<Entity[]>("GET", `/works/${disposableWorkId}/relationships`);
  assert.ok(relationships.some((relationship) => relationship.subtype === "旧友" && relationship.confirmationStatus === "pending"));
  checked("relationship-analysis", "small chunked analysis verifies quotes, persists keyword lists, and rejected history does not suppress new evidence");

  const staleTask = await api<Entity>("POST", `/works/${disposableWorkId}/tasks`, { taskType: "book-analysis", scope: { type: "book" } });
  const latestChapter = await api<Entity>("GET", `/chapters/${secondChapter.id}`);
  await api("PATCH", `/chapters/${secondChapter.id}`, { content: `${latestChapter.content}\n作者补充。` });
  const expiredTask = await api<Entity>("GET", `/tasks/${staleTask.id}`);
  assert.equal(expiredTask.status, "expired");
  await expectApiError("POST", `/tasks/${staleTask.id}/run`, { modelId: model.id }, 409, "TASK_NOT_PENDING");
  const cancellable = await api<Entity>("POST", `/works/${disposableWorkId}/tasks`, { taskType: "book-analysis", scope: { type: "book" } });
  const cancelled = await api<Entity>("POST", `/tasks/${cancellable.id}/cancel`, {});
  assert.equal(cancelled.status, "cancelled");
  await expectApiError("POST", `/tasks/${relationshipTask.id}/cancel`, {}, 409, "TASK_NOT_CANCELLABLE");
  checked("task-lifecycle", "source edits expire pending tasks and only active tasks can be cancelled");

  const calls = await api<Entity[]>("GET", `/works/${disposableWorkId}/ai-calls`);
  assert.ok(calls.length >= 5);
  assert.ok(calls.every((call) => call.parameters.max_tokens === 32_000));
  const exported = await fetch(`${baseUrl}/works/${disposableWorkId}/export?format=json`).then((response) => response.text());
  assert.ok(!exported.includes("sk-e2e-disposable-secret"));
  assert.ok(exported.includes("旧信的真相"));
  assert.ok(exported.includes("北港守望会"));
  checked("audit-export", "AI calls use max_tokens 32000, export includes organizations, and credentials remain omitted");

  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  for (const workId of cleanupWorkIds) {
    try {
      await api("DELETE", `/works/${workId}`);
      console.log(`[e2e] cleanup: deleted disposable work ${workId}`);
    } catch (error) {
      console.error("[e2e] cleanup failed", error);
    }
  }
  mockAi.close();
  if (mockAi.listening) await once(mockAi, "close");
}
