import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createRuntime } from "../../src/app.js";
import { runWithRequestActor } from "../../src/request-context.js";

const port = Number(process.env.E2E_READER_PORT ?? 13213);
const dataRoot = join(process.cwd(), ".data");
await mkdir(dataRoot, { recursive: true });
const isolatedDirectory = await mkdtemp(join(dataRoot, "e2e-browser-reader-"));
const runtime = createRuntime({
  databasePath: join(isolatedDirectory, "novel.db"),
  masterSecret: "browser-reader-e2e-secret-at-least-32-characters",
  disableUserAuth: true,
  devAuthBypass: true,
  serveUi: true,
  security: { enforceSameOrigin: false, apiRateLimit: 10_000 }
});
const actor = runtime.auth.register({ username: "reader-browser-e2e", password: "BrowserReaderE2E123!" });
runtime.auth.completeOnboarding(actor.session.user.userId);

const fixture = runWithRequestActor(actor.session.user, () => {
  const work = runtime.store.createWork({ title: "阅读预览 E2E", author: "Codex" });
  const workId = String(work.id);
  const firstVolume = runtime.store.createVolume(workId, { title: "第一卷 & 起航" });
  const slowChapter = runtime.store.createChapter(workId, {
    volumeId: String(firstVolume.id),
    title: "第一章 慢响应",
    content: `慢响应旧章节正文。${"旧请求内容不应覆盖新章节。".repeat(180)}`
  });
  const emptyChapter = runtime.store.createChapter(workId, {
    volumeId: String(firstVolume.id),
    title: "第二章 空章",
    content: ""
  });
  const failureChapter = runtime.store.createChapter(workId, {
    volumeId: String(firstVolume.id),
    title: "第三章 单次失败",
    content: "重试后成功载入的章节正文。"
  });
  const secondVolume = runtime.store.createVolume(workId, { title: "第二卷 <归途>" });
  const longChapter = runtime.store.createChapter(workId, {
    volumeId: String(secondVolume.id),
    title: "第四章 长夜 & 特殊字符",
    content: `第二卷特殊字符：<星门> & “归途”。\n\n${"长章节用于验证分页、滚动、复制和性能。".repeat(2_500)}`
  });

  const otherWork = runtime.store.createWork({ title: "阅读预览 E2E 第二作品", author: "Codex" });
  const otherVolume = runtime.store.createVolume(String(otherWork.id), { title: "独立卷" });
  const otherChapter = runtime.store.createChapter(String(otherWork.id), {
    volumeId: String(otherVolume.id),
    title: "独立章节",
    content: "第二部作品拥有独立阅读位置。"
  });

  return {
    workId,
    slowChapterId: String(slowChapter.id),
    emptyChapterId: String(emptyChapter.id),
    failureChapterId: String(failureChapter.id),
    longChapterId: String(longChapter.id),
    otherWorkId: String(otherWork.id),
    otherChapterId: String(otherChapter.id)
  };
});

let failureRemaining = 1;
const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (request.method === "GET" && requestUrl.pathname === `/api/chapters/${fixture.failureChapterId}` && failureRemaining > 0) {
    failureRemaining -= 1;
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { code: "E2E_READER_FAILURE", message: "模拟章节网络失败" } }));
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === `/api/chapters/${fixture.slowChapterId}`) {
    const timer = setTimeout(() => runtime.app(request, response), 1_200);
    const cancel = (): void => clearTimeout(timer);
    request.once("aborted", cancel);
    response.once("close", () => {
      if (!response.writableEnded) cancel();
    });
    return;
  }
  runtime.app(request, response);
});

try {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
} catch (error) {
  await runtime.close();
  await rm(isolatedDirectory, { recursive: true, force: true });
  throw error;
}
console.log(JSON.stringify({
  ready: true,
  baseUrl: `http://127.0.0.1:${port}`,
  readerUrl: `http://127.0.0.1:${port}/#view=reader&work=${fixture.workId}&chapter=${fixture.slowChapterId}`,
  ...fixture
}));

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.closeAllConnections();
  server.close();
  await runtime.close();
  await rm(isolatedDirectory, { recursive: true, force: true });
  process.exit(0);
}

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
