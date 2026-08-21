import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { BROWSER_AI_STORAGE_KEY, buildBrowserAiMessages, createBrowserAiStore, publicProvider, requestBrowserAi, testBrowserAiModel, testBrowserAiProvider } from "../browser-ai.js";
import { works } from "../data.js";
import { DEMO_CREDENTIALS, isValidDemoLogin } from "../demo-auth.js";
import { demoAssetVersion, demoCoverCacheControl, readDemoCoverVersions, readMainVersion, versionModuleSource, versionedDemoAdapterSource } from "../scripts/version.mjs";

test("预制两本不同类型的作品", () => {
  assert.equal(works.length, 2);
  assert.match(works[0].genre, /科幻/);
  assert.match(works[1].genre, /都市言情/);
});

test("科幻作品包含 20 到 30 个完整章节", () => {
  assert.ok(works[0].chapters.length >= 20 && works[0].chapters.length <= 30);
  for (const chapter of works[0].chapters) {
    assert.ok(chapter.title.length > 1);
    assert.ok(chapter.summary.length > 10);
    assert.ok(chapter.content.length > 100);
  }
});

test("两本作品都覆盖主要知识模块", () => {
  for (const work of works) {
    for (const key of ["chapters", "characters", "settings", "races", "organizations", "timeline", "relations", "outlines"]) {
      assert.ok(Array.isArray(work[key]) && work[key].length > 0, `${work.title} 缺少 ${key}`);
    }
  }
});

test("两本作品的人物关系图都具有足够密度", () => {
  for (const work of works) {
    assert.ok(work.characters.length >= 16, `${work.title} 的人物数量不足`);
    assert.ok(work.relations.length >= 24, `${work.title} 的关系数量不足`);
    const characterIds = new Set(work.characters.map((character) => character.id));
    for (const relationship of work.relations) {
      assert.ok(characterIds.has(relationship.from), `${work.title} 的关系起点不存在：${relationship.from}`);
      assert.ok(characterIds.has(relationship.to), `${work.title} 的关系终点不存在：${relationship.to}`);
    }
    assert.ok(new Set(work.relations.map((relationship) => relationship.kind)).size >= 4, `${work.title} 的关系类型不够丰富`);
  }
});

test("开发服务器直接复用正式站点前端资源", async () => {
  const server = await readFile(new URL("../scripts/serve.mjs", import.meta.url), "utf8");
  assert.match(server, /src\/public/);
  assert.match(server, /mock-api\.js/);
  assert.match(server, /process\.env\.PORT \?\? 45678/);
  assert.match(server, /"\.svg": "image\/svg\+xml; charset=utf-8"/);
  assert.doesNotMatch(server, /novel\.db|sqlite/iu);
});

test("构建产物复制正式前端并注入预制数据适配层", async () => {
  const build = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
  const adapter = await readFile(new URL("../mock-api.js", import.meta.url), "utf8");
  assert.match(build, /src\/public/);
  assert.match(build, /mock-api\.js/);
  assert.match(build, /browser-ai\.js/);
  assert.doesNotMatch(build, /cover-originals/);
  assert.match(adapter, /window\.fetch = mockApi/);
  assert.match(adapter, /\[data-product-footer\]/);
  assert.match(adapter, /notice\.textContent = "演示站"/);
  assert.doesNotMatch(adapter, /novel\.db|sqlite/iu);
});

test("Demo 适配主干最新正文管理能力且不重写正式前端", async () => {
  const build = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
  const adapter = await readFile(new URL("../mock-api.js", import.meta.url), "utf8");
  assert.match(build, /await cp\(publicSource, output, \{ recursive: true \}\)/);
  assert.doesNotMatch(build, /writeFile\(new URL\("app\.js"|writeFile\(new URL\("styles\.css"/u);
  for (const capability of [
    "deleted-chapters",
    "audit-logs",
    "writing-progress",
    "writing-goal",
    "chapter-annotations",
    "annotations",
    "volumes",
    "move",
    "restore",
    "permanent"
  ]) assert.match(adapter, new RegExp(capability), `Demo 缺少 ${capability} 适配`);
  assert.match(adapter, /chapters\\\/batch/);
  assert.match(adapter, /softDeleteChapter/);
  assert.match(adapter, /permanentlyDeleteChapter/);
  assert.match(adapter, /recordChapterVersion/);
  assert.match(adapter, /chapter\.deletedAt/);
  assert.match(adapter, /chapter\.purged/);
  assert.match(adapter, /chapterAnnotations = work\.chapterAnnotations\.filter/);
  assert.match(adapter, /targetCount \+ index/);
  assert.match(adapter, /volume\.chapters\.filter/);
  assert.match(adapter, /scope === "roots"/);
  assert.match(adapter, /scope === "descendants"/);
});

test("Demo 适配 0.6.1 评论、模型测试和对话流契约", async () => {
  const adapter = await readFile(new URL("../mock-api.js", import.meta.url), "utf8");
  for (const capability of [
    "chapter-annotations",
    "testBrowserAiModel",
    "minimumModelContextWindow",
    "runBrowserChat",
    "conversationSummary",
    "appendConversationMessage",
    "event: context",
    "event: user_message",
    "contextUsage",
    "compactedMessageCount",
    "relationshipSearchIndex",
    "demoTokenUsage"
  ]) assert.match(adapter, new RegExp(capability), `Demo 缺少 0.6.1 能力：${capability}`);
  assert.ok(adapter.includes('match = path.match(/^\\/api\\/ai-conversations\\/([^/]+)\\/fork$/u);'));
  assert.ok(adapter.includes('match = path.match(/^\\/api\\/ai-conversations\\/([^/]+)\\/compact$/u);'));
  assert.match(adapter, /chapterAnnotations = chapters\.slice\(0, 3\)/);
  assert.match(adapter, /chapterTitle: chapter\?\.title/);
  assert.match(adapter, /volumeTitle: volume\?\.title/);
});

test("Demo 适配当前正文、资料和协作接口契约", async () => {
  const adapter = await readFile(new URL("../mock-api.js", import.meta.url), "utf8");
  const browserAi = await readFile(new URL("../browser-ai.js", import.meta.url), "utf8");
  const sources = `${adapter}\n${browserAi}`;
  for (const capability of [
    "works/import",
    "firstImportedChapterId",
    "attachments",
    "entity-versions",
    "agent-history",
    "timeline",
    "split",
    "character-resolution",
    "imageToolModelId",
    "autoRunFailureThreshold",
    "settings-catalog"
  ]) assert.match(sources, new RegExp(capability), `Demo 缺少当前能力：${capability}`);
  assert.match(adapter, /members: \[\{ userId: demoUser\.userId/);
  assert.match(adapter, /suggestion\.status = "accepted"/);
  assert.match(adapter, /restoreEntityVersion/);
});

test("Demo 补齐当前前端新增契约并隔离 S3 凭据", async () => {
  const adapter = await readFile(new URL("../mock-api.js", import.meta.url), "utf8");
  for (const capability of [
    "annotation-counts",
    "recycle-bin/works",
    "outline-board",
    "foreshadow-reminders",
    "character-extraction",
    "demoCharacterAvatarBlobs",
    "demoExportArtifact",
    "demoGlobalReplace",
    "installDemoUploadAdapter",
    "favorite",
    "roleplayUserCharacter",
    "recall_story",
    "platform/ai/protocols",
    "pricing/refresh",
    "platform/backups/targets",
    "monthlyTokenQuota",
    "externalRequestSent"
  ]) assert.match(adapter, new RegExp(capability), `Demo 缺少当前前端契约：${capability}`);
  assert.ok(adapter.includes('match = path.match(/^\\/api\\/volumes\\/([^/]+)\\/(restore|permanent)$/u);'));
  assert.ok(adapter.includes('match = path.match(/^\\/api\\/ai-conversations\\/([^/]+)\\/export$/u);'));
  assert.match(adapter, /不会保存或上传 AK、SK/);
  assert.match(adapter, /不会向任何 S3 服务发起外部请求/);
  assert.doesNotMatch(adapter, /state\.backup.*(?:accessKeyId|secretAccessKey)/u);
});

test("浏览器 AI 保留多章节、剧情顺序、思考强度与图片输入", async () => {
  const scoped = buildBrowserAiMessages({
    work: works[0],
    scope: { type: "chapter", chapterIds: [works[0].chapters[0].id, works[0].chapters[1].id] },
    instruction: "对比两章"
  });
  assert.match(scoped[0].content, new RegExp(works[0].chapters[0].title));
  assert.match(scoped[0].content, new RegExp(works[0].chapters[1].title));
  const guardedScope = buildBrowserAiMessages({
    work: {
      title: "范围安全",
      chapters: [{ id: "prose", title: "正文章", chapterType: "正文", content: "可分析正文" }, { id: "author-note", title: "作者的话", chapterType: "作者的话", content: "不应发送的作者说明" }],
      settings: [{ title: "设定条目", content: "需一并参考" }]
    },
    scope: { type: "book", includeAllSettings: true },
    instruction: "分析"
  });
  assert.match(guardedScope[0].content, /可分析正文/u);
  assert.match(guardedScope[0].content, /需一并参考/u);
  assert.doesNotMatch(guardedScope[0].content, /不应发送的作者说明/u);

  const storyWork = {
    title: "并行剧情",
    volumes: [
      { id: "later", sortOrder: 0, storyOrder: 2, chapters: [{ id: "later-chapter", title: "后发生", content: "后发生的事" }] },
      { id: "earlier", sortOrder: 1, storyOrder: 0, chapters: [{ id: "earlier-chapter", title: "先发生", content: "先发生的事" }] }
    ],
    characters: [{ id: "role", name: "角色", gender: "female", isDead: true }],
    relationships: []
  };
  const roleplay = buildBrowserAiMessages({ work: storyWork, scope: { type: "none" }, instruction: "回忆故事", roleplayCharacter: storyWork.characters[0] });
  assert.ok(roleplay[0].content.indexOf("先发生") < roleplay[0].content.indexOf("后发生"));
  assert.match(roleplay[0].content, /生命状态：已死亡/u);

  let request;
  await requestBrowserAi({
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: "已识别" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
    provider: { protocol: "openai-chat-completions", baseUrl: "https://example.test/v1", apiKey: "sk-local", maxTokensParameter: "max_completion_tokens", thinkingType: "enabled" },
    model: { modelId: "vision-model", thinkingEnabled: true, thinkingEffort: "high", preset: { max_tokens: 512 } },
    messages: [{ role: "system", content: "系统" }, { role: "user", content: "看图" }],
    imageAttachments: [{ mimeType: "image/png", dataUrl: "data:image/png;base64,AA==" }]
  });
  const body = JSON.parse(request.init.body);
  assert.equal(body.max_completion_tokens, 512);
  assert.equal(body.reasoning_effort, "high");
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.messages[1].content[1].type, "image_url");
});

test("Demo mock 实际响应正式前端的新增功能契约", async () => {
  const previous = Object.fromEntries(["window", "document", "sessionStorage"].map((key) => [key, globalThis[key]]));
  const memoryStorage = () => {
    const values = new Map();
    return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key), values };
  };
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  globalThis.window = {
    fetch: async () => { throw new Error("合约测试不允许外部网络请求"); },
    localStorage,
    location: { origin: "https://demo.example.test" },
    setTimeout
  };
  globalThis.document = { readyState: "loading", addEventListener() {} };
  globalThis.sessionStorage = sessionStorage;
  try {
    await import(`../mock-api.js?contracts=${Date.now()}`);
    sessionStorage.setItem("scriverse-demo-authenticated", "true");
    const request = async (path, init = {}) => {
      const response = await window.fetch(path, init);
      const payload = response.status !== 204 && response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
      return { response, payload, data: payload?.data };
    };
    const json = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const upload = (path, method, form) => new Promise((resolve, reject) => {
      const xhr = new window.XMLHttpRequest();
      const progress = [];
      xhr.open(method, path, true);
      xhr.upload.addEventListener("progress", (event) => progress.push(event.lengthComputable ? Math.round(event.loaded / event.total * 100) : null));
      xhr.addEventListener("load", () => resolve({ status: xhr.status, payload: JSON.parse(xhr.responseText), progress }));
      xhr.addEventListener("error", () => reject(new Error("Demo XHR 上传失败")));
      xhr.send(form);
    });
    const zipLocalEntries = (bytes) => {
      const entries = new Map();
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let offset = 0;
      while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
        const size = view.getUint32(offset + 18, true);
        const nameLength = view.getUint16(offset + 26, true);
        const extraLength = view.getUint16(offset + 28, true);
        const contentOffset = offset + 30 + nameLength + extraLength;
        const name = new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + nameLength));
        entries.set(name, bytes.slice(contentOffset, contentOffset + size));
        offset = contentOffset + size;
      }
      return entries;
    };

    const work = (await request("/api/works/silent-tide")).data;
    const board = (await request(`/api/works/${work.id}/outline-board?page=1&limit=10&sort=foreshadows`)).data;
    assert.equal(board.workId, work.id);
    assert.ok(board.total > 0);
    assert.ok(board.volumeOptions.every((volume) => Number.isInteger(volume.filteredChapterCount)));

    const replaced = (await request(`/api/works/${work.id}/replace`, json("POST", { find: "空气", replacement: "雾气", scope: "prose", volumeId: work.volumes[0].id }))).data;
    assert.ok(replaced.totalMatches > 0);
    assert.ok(replaced.chapterCount > 0);

    const reminders = (await request(`/api/works/${work.id}/chapters/${work.id}-chapter-6/foreshadow-reminders`)).data;
    assert.ok(reminders.length > 0);
    const resolved = (await request(`/api/works/${work.id}/chapters/${work.id}-chapter-6/foreshadow-reminders/${reminders[0].foreshadowId}/resolve`, json("POST", { expectedVersionNo: reminders[0].versionNo }))).data;
    assert.equal(resolved.status, "resolved");

    const conversation = (await request(`/api/works/${work.id}/ai-conversations`, json("POST", { taskType: "chat" }))).data;
    await request(`/api/ai-conversations/${conversation.id}/messages`, json("POST", { role: "user", content: "演示对话导出" }));
    const conversationExport = await request(`/api/ai-conversations/${conversation.id}/export`);
    assert.equal(conversationExport.response.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.match(await conversationExport.response.text(), /演示对话导出/u);

    const markdownExport = await request(`/api/works/${work.id}/export?format=markdown`);
    assert.equal(markdownExport.response.headers.get("content-type"), "application/zip");
    const markdownEntries = zipLocalEntries(new Uint8Array(await markdownExport.response.arrayBuffer()));
    assert.ok([...markdownEntries.keys()].some((name) => name.endsWith(".md")));
    const docxExport = await request(`/api/works/${work.id}/export?format=docx`);
    const docxEntries = zipLocalEntries(new Uint8Array(await docxExport.response.arrayBuffer()));
    assert.ok(docxEntries.has("[Content_Types].xml"));
    assert.ok(docxEntries.has("word/document.xml"));
    const epubHead = await request(`/api/volumes/${work.volumes[0].id}/export?format=epub`, { method: "HEAD" });
    assert.equal(epubHead.response.status, 204);
    assert.equal(epubHead.response.headers.get("content-type"), "application/epub+zip");
    const epubExport = await request(`/api/volumes/${work.volumes[0].id}/export?format=epub`);
    const epubEntries = zipLocalEntries(new Uint8Array(await epubExport.response.arrayBuffer()));
    assert.equal(new TextDecoder().decode(epubEntries.get("mimetype")), "application/epub+zip");
    assert.ok(epubEntries.has("META-INF/container.xml"));
    assert.ok(epubEntries.has("OEBPS/nav.xhtml"));

    const avatarForm = new FormData();
    avatarForm.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "avatar.png");
    const character = work.characters[0];
    const avatarUpload = await upload(`/api/characters/${character.id}/avatar`, "PUT", avatarForm);
    assert.equal(avatarUpload.status, 200);
    assert.deepEqual(avatarUpload.progress, [0, 100]);
    const avatar = avatarUpload.payload.data;
    assert.match(avatar.avatarUrl, /\/api\/characters\/.*\/avatar/u);
    assert.equal((await request(`/api/characters/${character.id}/avatar`)).response.headers.get("content-type"), "image/png");

    const task = work.tasks[0];
    const preview = (await request(`/api/tasks/${task.id}/character-extraction/preview`)).data;
    const applied = (await request(`/api/tasks/${task.id}/character-extraction/apply`, json("POST", {
      previewToken: preview.previewToken,
      selections: preview.items.map((item) => ({ candidateId: item.candidateId, action: "skip" }))
    }))).data;
    assert.equal(applied.status, "applied");
    assert.equal(applied.skippedCount, preview.items.length);

    const backupTarget = (await request("/api/platform/backups/targets", json("POST", { name: "安全演示", endpoint: "https://s3.example.invalid", bucket: "demo", accessKeyId: "DO-NOT-STORE", secretAccessKey: "DO-NOT-STORE-EITHER", enabled: true }))).data;
    assert.doesNotMatch(JSON.stringify(backupTarget), /DO-NOT-STORE/u);
    const backupRun = (await request("/api/platform/backups/run", json("POST", { targetIds: [backupTarget.id] }))).data;
    assert.equal(backupRun.simulated, true);
    assert.doesNotMatch([...localStorage.values.values()].join("\n"), /DO-NOT-STORE/u);

    const deletedVolume = work.volumes.at(-1);
    await request(`/api/volumes/${deletedVolume.id}`, json("DELETE", { expectedVersionNo: deletedVolume.versionNo }));
    const recycleBin = (await request(`/api/works/${work.id}/recycle-bin`)).data;
    const recycledVolume = recycleBin.volumes.find((volume) => volume.id === deletedVolume.id);
    assert.equal(recycledVolume.chapterCount, deletedVolume.chapters.length);
    await request(`/api/volumes/${deletedVolume.id}/restore`, json("POST", { expectedVersionNo: recycledVolume.versionNo }));
    assert.ok((await request(`/api/works/${work.id}`)).data.volumes.some((volume) => volume.id === deletedVolume.id));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test("AI 配置仅保存在浏览器并说明前端直连方式", async () => {
  const adapter = await readFile(new URL("../mock-api.js", import.meta.url), "utf8");
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const store = createBrowserAiStore(storage);
  store.update((state) => { state.providers.push({ id: "provider-local", apiKey: "sk-browser-only" }); });
  assert.equal(JSON.parse(values.get(BROWSER_AI_STORAGE_KEY)).providers[0].apiKey, "sk-browser-only");
  assert.equal(store.read().providers[0].id, "provider-local");
  assert.doesNotMatch(publicProvider(store.read().providers[0]).apiKey, /browser-only/);
  assert.match(adapter, /API Key 仅保存在当前浏览器/);
  assert.match(adapter, /不经过演示站服务器/);
  assert.match(adapter, /不会接收、记录或存储 API Key/);
});

test("浏览器直接调用 OpenAI 兼容模型并携带作品上下文", async () => {
  const messages = buildBrowserAiMessages({ work: works[0], scope: { type: "chapter", chapterId: works[0].chapters[0].id }, instruction: "概括当前冲突" });
  assert.match(messages[0].content, new RegExp(works[0].title));
  assert.match(messages[0].content, new RegExp(works[0].chapters[0].title));
  let request;
  const result = await requestBrowserAi({
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: "冲突概括" } }], usage: { completion_tokens: 12 } }), { status: 200, headers: { "content-type": "application/json" } });
    },
    provider: { baseUrl: "https://example.test/v1", apiKey: "sk-local", maxTokens: 2000 },
    model: { modelId: "demo-model", preset: { temperature: 0.5, max_tokens: 1000 } },
    messages
  });
  assert.equal(request.url, "https://example.test/v1/chat/completions");
  assert.equal(request.init.headers.Authorization, "Bearer sk-local");
  assert.equal(JSON.parse(request.init.body).model, "demo-model");
  assert.deepEqual(result, { content: "冲突概括", outputTokens: 12 });
});

test("浏览器直连模式支持 OpenAI Responses 与关系角色扮演回忆", async () => {
  const roleplayCharacter = {
    id: works[0].characters[0].id,
    name: works[0].characters[0].name,
    profile: { summary: works[0].characters[0].detail },
    currentState: { 身份: works[0].characters[0].role }
  };
  const roleplayUserCharacter = {
    id: works[0].characters[1].id,
    name: works[0].characters[1].name
  };
  const messages = buildBrowserAiMessages({
    work: works[0],
    scope: { type: "none" },
    instruction: "继续刚才的对话",
    roleplayCharacter,
    roleplayUserCharacter
  });
  assert.match(messages[0].content, new RegExp(`你扮演 ${roleplayCharacter.name}`));
  assert.match(messages[0].content, new RegExp(`对话者扮演：${roleplayUserCharacter.name}`));
  assert.match(messages[0].content, /人物关系回忆/);
  assert.match(messages[0].content, /故事回忆/);

  let request;
  const result = await requestBrowserAi({
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ output_text: "角色回应", usage: { output_tokens: 7 } }), { status: 200, headers: { "content-type": "application/json" } });
    },
    provider: { protocol: "openai-responses", baseUrl: "https://example.test/v1/responses", apiKey: "sk-local" },
    model: { modelId: "response-model", preset: { temperature: 0.4, max_tokens: 800 } },
    messages
  });
  const body = JSON.parse(request.init.body);
  assert.equal(request.url, "https://example.test/v1/responses");
  assert.equal(body.model, "response-model");
  assert.equal(body.instructions, messages[0].content);
  assert.deepEqual(body.input, messages.slice(1));
  assert.deepEqual(result, { content: "角色回应", outputTokens: 7 });
});

test("供应商和模型连接测试都会发起最小模型请求并接受纯思考响应", async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "available-model" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { reasoning_content: "OK", content: "" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const provider = { baseUrl: "https://example.test/v1", apiKey: "sk-local", maxTokens: 2000 };
  const providerResult = await testBrowserAiProvider({ fetchImpl, provider });
  const modelResult = await testBrowserAiModel({ fetchImpl, provider, model: { modelId: "configured-model", preset: { max_tokens: 8 } } });
  const thinkingResult = await requestBrowserAi({ fetchImpl, provider, model: { modelId: "thinking-model", preset: { max_tokens: 8 } }, messages: [{ role: "user", content: "测试" }] });

  assert.deepEqual(providerResult, { ok: true, availableModels: ["available-model"] });
  assert.deepEqual(modelResult, { ok: true });
  assert.deepEqual(thinkingResult, { content: "OK", outputTokens: 0 });
  assert.equal(requests.length, 4);
  assert.equal(JSON.parse(requests[1].init.body).model, "available-model");
  assert.equal(JSON.parse(requests[2].init.body).model, "configured-model");
  assert.equal(JSON.parse(requests[3].init.body).model, "thinking-model");
});

test("浏览器直连模式支持 Anthropic Messages 响应", async () => {
  let request;
  const result = await requestBrowserAi({
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ content: [{ type: "text", text: "Anthropic 回复" }], usage: { output_tokens: 9 } }), { status: 200, headers: { "content-type": "application/json" } });
    },
    provider: { protocol: "anthropic-messages", baseUrl: "https://example.test", apiKey: "sk-ant" },
    model: { modelId: "claude-demo", preset: { max_tokens: 100 } },
    messages: [{ role: "system", content: "系统约束" }, { role: "user", content: "测试" }]
  });
  assert.equal(request.url, "https://example.test/v1/messages");
  assert.equal(request.init.headers["x-api-key"], "sk-ant");
  assert.equal(JSON.parse(request.init.body).system, "系统约束");
  assert.deepEqual(result, { content: "Anthropic 回复", outputTokens: 9 });
});

test("两本预制作品都设置了项目内封面", async () => {
  const adapter = await readFile(new URL("../mock-api.js", import.meta.url), "utf8");
  const server = await readFile(new URL("../scripts/serve.mjs", import.meta.url), "utf8");
  const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  const coverVersions = await readDemoCoverVersions();
  assert.match(adapter, /DEMO_COVER_VERSIONS/);
  assert.match(adapter, /\/demo-covers\/\$\{id\}\.webp\?v=\$\{encodeURIComponent\(DEMO_COVER_VERSIONS\[id\] \?\? "0"\)\}/);
  assert.match(server, /demoCoverCacheControl/);
  assert.match(server, /isDemoCover/);
  assert.equal(demoCoverCacheControl(), "public, max-age=31536000, immutable");
  assert.deepEqual(vercel.git?.deploymentEnabled, { "*": false, main: true });
  assert.equal(vercel.headers?.[0]?.source, "/demo-covers/(.*)");
  assert.equal(vercel.headers?.[0]?.headers?.[0]?.value, "public, max-age=31536000, immutable");
  assert.deepEqual(Object.keys(coverVersions).sort(), ["city-blank", "silent-tide"]);
  for (const filename of ["silent-tide.webp", "city-blank.webp"]) {
    const cover = await stat(new URL(`../demo-covers/${filename}`, import.meta.url));
    assert.ok(cover.size > 50_000, `${filename} 不是有效的完整封面`);
    assert.ok(cover.size <= 200_000, `${filename} 超过 200 KB`);
    const id = filename.slice(0, -".webp".length);
    assert.match(coverVersions[id], /^[a-f0-9]{8}$/u);
  }
  for (const filename of ["silent-tide.png", "city-blank.png"]) {
    const original = await stat(new URL(`../cover-originals/${filename}`, import.meta.url));
    assert.ok(original.size > 2_000_000, `${filename} 不是保留的高分辨率原图`);
  }
});

test("Demo 使用公开凭据登录且关闭注册", async () => {
  const adapter = await readFile(new URL("../mock-api.js", import.meta.url), "utf8");
  assert.deepEqual(DEMO_CREDENTIALS, { username: "demo", password: "scriverse-demo", captchaAnswer: "2468" });
  assert.equal(isValidDemoLogin({ ...DEMO_CREDENTIALS, captchaId: "demo-captcha" }), true);
  assert.equal(isValidDemoLogin({ ...DEMO_CREDENTIALS, password: "wrong", captchaId: "demo-captcha" }), false);
  assert.equal(isValidDemoLogin({ ...DEMO_CREDENTIALS, captchaAnswer: "0000", captchaId: "demo-captcha" }), false);
  assert.match(adapter, /registrationOpen: false/);
  assert.match(adapter, /sessionStorage\.getItem\(demoAuthStorageKey\)/);
  assert.match(adapter, /Demo 不开放注册/);
  assert.match(adapter, /hint\.textContent = `演示账号：\$\{demoCredentials\.username\}　密码：\$\{demoCredentials\.password\}`/);
  assert.doesNotMatch(adapter, /hint\.textContent = `[^`]*验证码/);
});

test("Demo 版本直接继承主项目版本", async () => {
  const mainPackage = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const demoPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const adapter = await readFile(new URL("../mock-api.js", import.meta.url), "utf8");
  assert.equal(await readMainVersion(), mainPackage.version);
  assert.equal(Object.hasOwn(demoPackage, "version"), false);
  assert.equal(versionModuleSource(mainPackage.version), `export const DEMO_VERSION = ${JSON.stringify(mainPackage.version)};\nexport const DEMO_COVER_VERSIONS = {};\n`);
  assert.equal(versionModuleSource(mainPackage.version, { "silent-tide": "abcd1234" }), `export const DEMO_VERSION = ${JSON.stringify(mainPackage.version)};\nexport const DEMO_COVER_VERSIONS = ${JSON.stringify({ "silent-tide": "abcd1234" })};\n`);
  assert.match(demoAssetVersion(adapter, mainPackage.version), new RegExp(`^${mainPackage.version.replaceAll(".", "\\.")}-[a-f0-9]{8}$`));
  assert.match(versionedDemoAdapterSource(adapter, mainPackage.version), new RegExp(`demo-version\\.js\\?v=${mainPackage.version.replaceAll(".", "\\.")}`));
  assert.match(adapter, /version: DEMO_VERSION/);
  assert.doesNotMatch(adapter, /0\.1\.0-demo/);
});

test("Demo 在正式前端和主版本来源变化时触发 Vercel 重建", async () => {
  const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(vercel.ignoreCommand, "git diff --quiet HEAD^ HEAD -- ./ ../src/public ../package.json ../package-lock.json");
});
