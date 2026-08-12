import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRuntime } from "../../src/app.js";
import { runWithRequestActor } from "../../src/request-context.js";

const port = Number(process.env.E2E_OUTLINE_BOARD_PORT ?? 13213);
const dataRoot = join(process.cwd(), ".data");
await mkdir(dataRoot, { recursive: true });
const isolatedDirectory = await mkdtemp(join(dataRoot, "e2e-outline-board-"));
const runtime = createRuntime({
  databasePath: join(isolatedDirectory, "novel.db"),
  masterSecret: "outline-board-browser-e2e-secret-at-least-32-characters",
  disableUserAuth: true,
  devAuthBypass: true,
  security: { enforceSameOrigin: false, apiRateLimit: 10_000 }
});
const registered = runtime.auth.register({ username: "outline-board-e2e", password: "OutlineBoardE2E123!" });
const fixture = runWithRequestActor(registered.session.user, () => {
  const work = runtime.store.createWork({ title: "章节大纲看板 E2E", author: "Codex" });
  const workId = String(work.id);
  const firstVolume = runtime.store.createVolume(workId, { title: "第一卷 旧港" });
  const firstChapter = runtime.store.createChapter(workId, {
    volumeId: String(firstVolume.id),
    title: "第一章 旧信",
    content: "林舟在旧港收到一封没有署名的信。"
  });
  const secondChapter = runtime.store.createChapter(workId, {
    volumeId: String(firstVolume.id),
    title: "第二章 暗潮",
    content: "守望会封锁档案室，潮门提前开启。"
  });
  const thirdChapter = runtime.store.createChapter(workId, {
    volumeId: String(firstVolume.id),
    title: "第三章 回声",
    content: "沈星认出旧信上的坐标。"
  });
  const secondVolume = runtime.store.createVolume(workId, { title: "第二卷 潮门" });
  const fourthChapter = runtime.store.createChapter(workId, {
    volumeId: String(secondVolume.id),
    title: "第四章 越界",
    content: "舰队穿过潮门。"
  });
  runtime.store.createChapter(workId, {
    volumeId: String(secondVolume.id),
    title: "第五章 未定",
    content: "本章仍在规划中。"
  });
  const emptyVolume = runtime.store.createVolume(workId, { title: "第三卷 空卷" });
  runtime.store.upsertChapterOutline(String(firstChapter.id), {
    goal: `确认旧信来源。${"这是一段用于验证超长摘要收起与详情展开的文本。".repeat(80)}`,
    conflict: "守望会拒绝开放档案，林舟必须在不惊动议会的情况下寻找证据。",
    turningPoint: "旧信上的墨迹与沈星的航海日志完全一致。",
    notes: "详情中应显示完整长文本。",
    status: "ready"
  });
  runtime.store.upsertChapterOutline(String(secondChapter.id), {
    goal: "进入档案室",
    conflict: "守卫已经封锁入口",
    turningPoint: "潮门提前开启",
    status: "draft"
  });
  runtime.store.upsertChapterOutline(String(fourthChapter.id), {
    goal: "带领舰队越过潮门",
    conflict: "导航坐标存在偏差",
    turningPoint: "旧信坐标成为唯一航路",
    status: "completed"
  });
  const planted = runtime.store.createForeshadow(workId, {
    title: "旧信坐标",
    description: "坐标会在第二卷成为穿越潮门的关键。",
    status: "planted",
    importance: "high",
    plannedPayoffChapterId: String(fourthChapter.id),
    occurrences: [
      { chapterId: String(firstChapter.id), role: "setup", note: "首次出现坐标" },
      { chapterId: String(thirdChapter.id), role: "reminder", note: "沈星认出坐标" }
    ]
  });
  runtime.store.createForeshadow(workId, {
    title: "铜钥匙",
    status: "resolved",
    importance: "medium",
    occurrences: [{ chapterId: String(secondChapter.id), role: "payoff" }]
  });

  const secondWork = runtime.store.createWork({ title: "章节大纲看板 E2E 第二作品", author: "Codex" });
  const secondWorkId = String(secondWork.id);
  const otherVolume = runtime.store.createVolume(secondWorkId, { title: "隔离卷" });
  const otherChapter = runtime.store.createChapter(secondWorkId, {
    volumeId: String(otherVolume.id),
    title: "隔离章节",
    content: "SECOND_WORK_PROSE_SECRET"
  });
  runtime.store.upsertChapterOutline(String(otherChapter.id), { goal: "SECOND_WORK_BOARD_SECRET", status: "ready" });
  return {
    workId,
    secondWorkId,
    firstChapterId: String(firstChapter.id),
    fourthChapterId: String(fourthChapter.id),
    emptyVolumeId: String(emptyVolume.id),
    plantedForeshadowId: String(planted.id)
  };
});

let failOutlineBoard = false;
const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (requestUrl.pathname === "/__e2e/login") {
    response.setHeader("Set-Cookie", `scriverse_session=${encodeURIComponent(registered.token)}; Path=/; HttpOnly; SameSite=Lax`);
    response.writeHead(302, { Location: `/#view=module&work=${fixture.workId}&module=outlines` });
    response.end();
    return;
  }
  if (requestUrl.pathname === "/__e2e/fixture") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(fixture));
    return;
  }
  if (requestUrl.pathname === "/__e2e/fail-outline-board") {
    failOutlineBoard = requestUrl.searchParams.get("enabled") === "1";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ failOutlineBoard }));
    return;
  }
  if (failOutlineBoard && requestUrl.pathname === `/api/works/${fixture.workId}/outline-board`) {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { code: "OUTLINE_BOARD_E2E_FAILURE", message: "大纲看板测试错误" } }));
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
  await runtime.close();
  await rm(isolatedDirectory, { recursive: true, force: true });
  process.exit(0);
}

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
