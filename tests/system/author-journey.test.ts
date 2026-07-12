import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createRuntime } from "../../src/app.js";

describe("作者完整创作流程", () => {
  let runtime: Runtime;
  let mockServer: ReturnType<typeof createServer>;
  let baseUrl: string;
  const receivedBodies: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    mockServer = createServer(async (incoming: IncomingMessage, outgoing: ServerResponse) => {
      if (incoming.url === "/v1/models") {
        outgoing.writeHead(200, { "Content-Type": "application/json" });
        outgoing.end(JSON.stringify({ data: [{ id: "system-novel-model" }] }));
        return;
      }
      if (incoming.url === "/v1/chat/completions" && incoming.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        receivedBodies.push(body);
        const messages = body.messages as Array<{ content: string }>;
        const prompt = messages[1]?.content ?? "";
        let content = "舱门关闭，林舟望向逐渐远去的北港。";
        if (prompt.includes("检查下面的续写候选")) {
          content = "[]";
        } else if (prompt.includes("抽取大事件候选")) {
          content = JSON.stringify([{ name: "北港启航", description: "林舟驾驶飞船离开北港。", eventType: "离别", timeLabel: "启航日", timeSort: 1, location: "北港", impactScope: "personal", chapterIds: [], participantIds: [], evidence: [{ quote: "飞船驶离北港" }] }]);
        } else if (prompt.includes("小说人物关系抽取器")) {
          const chapters = [...prompt.matchAll(/<CHAPTER id="([^"]+)" title="([^"]+)">/gu)];
          content = JSON.stringify([{ fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "旧友", directed: false, currentStatus: "active", timeRange: { start: "第一卷" }, confidence: 0.82, evidence: chapters.map((match, index) => ({ chapterId: match[1], chapterTitle: match[2], quote: index === 0 ? "林舟想起沈星的警告" : "沈星仍保存着林舟的旧信", contextType: "current", supports: "两人保持长期联系" })) }]);
        }
        if (body.stream === true) {
          outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
          outgoing.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "舱门关闭，" } }] })}\n\n`);
          await new Promise((resolve) => setTimeout(resolve, 8));
          outgoing.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "飞船离开北港。" }, finish_reason: "stop" }] })}\n\n`);
          outgoing.end("data: [DONE]\n\n");
          return;
        }
        outgoing.writeHead(200, { "Content-Type": "application/json" });
        outgoing.end(JSON.stringify({ choices: [{ message: { content } }] }));
        return;
      }
      outgoing.writeHead(404).end();
    });
    mockServer.listen(0, "127.0.0.1");
    await once(mockServer, "listening");
    const address = mockServer.address();
    if (!address || typeof address === "string") throw new Error("Mock server failed to start");
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "system-test-master-secret-with-enough-length",
      serveUi: true
    });
  });

  afterAll(async () => {
    runtime.close();
    mockServer.close();
    await once(mockServer, "close");
  });

  it("正文编辑区在章节概览隐藏时仍占满剩余高度", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);
    expect(page.text).toContain('<div class="editor-body">');
    expect(styles.text).toContain(".editor-view { display: grid; grid-template-rows: auto minmax(0, 1fr); height: 100%; }");
    expect(styles.text).toContain(".editor-body { display: flex; min-height: 0; flex-direction: column; }");
    expect(styles.text).toContain(".chapter-content { flex: 1 1 auto;");
  });

  it("作品选择器使用紧凑字号和固定高度", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);
    expect(page.text).toContain('id="work-picker"');
    expect(styles.text).toContain(".work-picker-row select { width: 100%; height: 38px; padding: 7px 9px; font-size: 12px;");
  });

  it("全站使用黑体与等宽英文并提供可持久化显示设置", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    expect(page.text).toContain('id="appearance-button"');
    expect(page.text).toContain('id="appearance-dialog"');
    expect(page.text).toContain("英文字体（仅等宽）");
    expect(styles.text).toContain('--font-cjk: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Heiti SC";');
    expect(styles.text).toContain('--font-latin: "SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono";');
    expect(styles.text).toContain("--editor-line-height: 1.55;");
    expect(styles.text.replaceAll("sans-serif", "").toLowerCase()).not.toContain("serif");
    expect(application.text).toContain('const typographyStorageKey = "ai-novel-typography-v1";');
    expect(application.text).toContain("localStorage.setItem(typographyStorageKey");
  });

  it("首屏书架、大纲伏笔、续写守卫和关系银河图资源完整可达", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const graph = await request(runtime.app).get("/relationship-graph.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);
    expect(page.text).toContain('id="shelf-view"');
    expect(page.text).toContain('data-testid="book-shelf"');
    expect(application.text).toContain('data-testid="book-add-card"');
    expect(page.text).toContain('data-module="outlines"');
    expect(page.text).toContain('data-testid="relationship-fullscreen"');
    expect(page.text).toContain('data-testid="relationship-map-expanded"');
    expect(page.text).toContain('class="relationship-map-floating-close"');
    expect(page.text).not.toContain('id="relationship-map-dialog-title"');
    expect(page.text).toContain('data-testid="chapter-type-menu"');
    expect(application.text).toContain("async function renderOutlines()");
    expect(application.text).toContain("async function streamChat(body)");
    expect(application.text).toContain('field("settings", "组织设定（逐条填写）", "item-list"');
    expect(application.text).toContain('form.getAll("settings")');
    expect(application.text).toContain('field("memberIds", "组织成员（可多选）", "chips"');
    expect(styles.text).toContain(".chip-picker { display: flex; flex-wrap: wrap;");
    expect(application.text).toContain('field("maxTokens", "最大输出 Token 数", "number", item?.maxTokens ?? 32000)');
    expect(application.text).toContain('addEventListener("contextmenu"');
    expect(application.text).toContain("collapsedVolumeIds");
    expect(application.text).toContain('data-testid="continuation-guard"');
    expect(graph.text).toContain("export function buildRelationshipGraph");
    expect(graph.text).toContain("export function createGalaxyRenderer");
    expect(graph.text).toContain('expand.dataset.testid = "relationship-map-expand"');
    expect(graph.text).toContain("viewport.dataset.draggedNodeId = node.id");
    expect(graph.text).toContain("viewport.dataset.graphScale = viewScale.toFixed(3)");
    expect(graph.text).toContain('viewport.addEventListener("wheel"');
    expect(graph.text).toContain('button.addEventListener("pointermove"');
    expect(graph.text).toContain("shell.dataset.draggedNodeId = node.id");
    expect(graph.text).toContain("Math.sqrt(node.degree / maxDegree)");
    expect(graph.text).toContain("initialNodePositions");
    expect(styles.text).toContain(".book-shelf");
    expect(styles.text).toContain(".galaxy-dialog");
    expect(styles.text).toContain("grid-template-rows: var(--node-size) auto");
  });

  it("从导入作品到采纳续写、抽取时间轴并安全导出", async () => {
    await request(runtime.app).get("/api/health").expect(200);
    const page = await request(runtime.app).get("/").expect(200).expect("Content-Type", /html/u);
    expect(page.headers["x-frame-options"]).toBeUndefined();

    const work = await request(runtime.app).post("/api/works").send({ title: "星际纪元", author: "作者" }).expect(201);
    const workId = work.body.data.id;
    const imported = await request(runtime.app).post(`/api/works/${workId}/import`)
      .attach("file", Buffer.from("第一卷 启航\n第一章 北港\n飞船停在北港。林舟检查跃迁引擎。林舟想起沈星的警告。\n第二章 旧信\n沈星仍保存着林舟的旧信。"), "星际纪元.txt")
      .expect(201);
    const chapterId = imported.body.data.tree.volumes[0].chapters[0].id;

    await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "跃迁冷却规则",
      category: "世界规则",
      content: "飞船每次跃迁后必须冷却十二小时。",
      status: "confirmed",
      locked: true
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "林舟",
      attributes: { species: "人类" },
      currentState: { location: "北港" },
      lockedFields: ["species", "location"]
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "沈星",
      aliases: ["沈博士"],
      currentState: { location: "主星" }
    }).expect(201);

    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "系统测试模型服务",
      baseUrl,
      apiKey: "sk-system-test-secret",
      status: "enabled"
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "长篇创作模型",
      modelId: "system-novel-model",
      purposes: ["创作续写", "时间轴分析"]
    }).expect(201);

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "用一句话描述离港",
      scope: { type: "chapter", chapterId },
      modelId: model.body.data.id
    }).expect(200).expect("Content-Type", /text\/event-stream/u);
    expect(streamed.text).toContain('event: delta\ndata: {"delta":"舱门关闭，"}');
    expect(streamed.text).toContain('event: delta\ndata: {"delta":"飞船离开北港。"}');
    expect(streamed.text).toContain("event: complete");

    const suggestion = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "continue",
      instruction: "续写离港场景，不能让飞船立即再次跃迁。",
      scope: { type: "chapter", chapterId },
      modelId: model.body.data.id
    }).expect(201);
    const beforeAccept = await request(runtime.app).get(`/api/chapters/${chapterId}`).expect(200);
    expect(beforeAccept.body.data.versionNo).toBe(1);
    expect(beforeAccept.body.data.content).not.toContain("舱门关闭");

    const accepted = await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/accept`).send({}).expect(200);
    expect(accepted.body.data.chapter.versionNo).toBe(2);
    expect(accepted.body.data.chapter.content).toContain("舱门关闭");

    const timelineTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "timeline-analysis",
      scope: { type: "book" }
    }).expect(201);
    const completedTask = await request(runtime.app).post(`/api/tasks/${timelineTask.body.data.id}/run`).send({ modelId: model.body.data.id }).expect(200);
    expect(completedTask.body.data).toMatchObject({ status: "review", progress: 100 });
    expect(completedTask.body.data.result.candidateCount).toBe(1);

    const timeline = await request(runtime.app).get(`/api/works/${workId}/timeline`).expect(200);
    expect(timeline.body.data[0]).toMatchObject({ name: "北港启航", status: "candidate" });

    const relationshipTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "book" }
    }).expect(201);
    const relationshipResult = await request(runtime.app).post(`/api/tasks/${relationshipTask.body.data.id}/run`).send({ modelId: model.body.data.id }).expect(200);
    expect(relationshipResult.body.data.result.candidateCount).toBe(1);
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data[0]).toMatchObject({ category: "social", subtype: "朋友", confidence: 0.82, confirmationStatus: "pending" });
    expect(relationships.body.data[0].evidence).toHaveLength(2);

    const search = await request(runtime.app).get(`/api/works/${workId}/search?q=${encodeURIComponent("北港")}`).expect(200);
    expect(search.body.data.some((item: { type: string }) => item.type === "chapter")).toBe(true);

    const exported = await request(runtime.app).get(`/api/works/${workId}/export?format=json`).expect(200);
    const serialized = JSON.stringify(exported.body);
    expect(serialized).toContain("北港启航");
    expect(serialized).not.toContain("sk-system-test-secret");
    expect(serialized).not.toContain("encrypted_key");

    const modelRequest = receivedBodies.find((body) => JSON.stringify(body).includes("续写离港场景"));
    expect(JSON.stringify(modelRequest)).toContain("飞船每次跃迁后必须冷却十二小时");
    expect(JSON.stringify(modelRequest)).toContain("species=人类");
  }, 20_000);
});
