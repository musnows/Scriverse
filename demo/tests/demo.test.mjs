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
