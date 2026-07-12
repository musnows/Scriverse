import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

async function seedWork(runtime: Runtime, title = "功能测试作品") {
  const work = await request(runtime.app).post("/api/works").send({ title }).expect(201);
  const volume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "第一卷" }).expect(201);
  const first = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
    volumeId: volume.body.data.id,
    title: "第一章 埋线",
    content: "林舟在北港见到沈星。沈星说：我们一直是朋友。"
  }).expect(201);
  const second = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
    volumeId: volume.body.data.id,
    title: "第二章 转折",
    content: "林舟离开北港，旧约仍未兑现。"
  }).expect(201);
  const third = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
    volumeId: volume.body.data.id,
    title: "第三章 回收",
    content: "沈星打开旧信。"
  }).expect(201);
  return { workId: work.body.data.id as string, volumeId: volume.body.data.id as string, chapters: [first.body.data, second.body.data, third.body.data] };
}

async function configureAi(runtime: Runtime, workId: string) {
  const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
    name: "功能测试模型",
    baseUrl: "https://feature-ai.test/v1",
    apiKey: "sk-feature-test",
    status: "enabled",
    concurrencyLimit: 10,
    rpmLimit: 10_000
  }).expect(201);
  runtime.database.run("UPDATE providers SET connection_status = 'success' WHERE id = ?", provider.body.data.id);
  const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
    displayName: "功能模型",
    modelId: "feature-model"
  }).expect(201);
  return model.body.data.id as string;
}

describe("书架、别名、大纲伏笔和一致性守卫 API", () => {
  let runtime: Runtime;

  beforeEach(() => { runtime = createTestRuntime(); });
  afterEach(() => runtime.close());

  it("在作品内统一约束主名和全部别名，并规范化无向关系", async () => {
    const { workId } = await seedWork(runtime);
    const first = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "魔斯拉", aliases: ["小魔", "Mothra"] }).expect(201);
    const duplicateAlias = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "小魔" }).expect(409);
    expect(duplicateAlias.body.error.code).toBe("CHARACTER_NAME_CONFLICT");
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "ｍｏｔｈｒａ" }).expect(409);
    const second = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "拉顿" }).expect(201);
    await request(runtime.app).patch(`/api/characters/${second.body.data.id}`).send({ aliases: [" 小魔 "] }).expect(409);
    const unchanged = await request(runtime.app).get(`/api/characters/${second.body.data.id}`).expect(200);
    expect(unchanged.body.data.aliases).toEqual([]);

    const relation = await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: second.body.data.id,
      toCharacterId: first.body.data.id,
      category: "social",
      subtype: "朋友",
      keywords: ["共同守望", "长期信任"],
      directed: false,
      confidence: 1
    }).expect(201);
    expect(relation.body.data.fromCharacterId.localeCompare(relation.body.data.toCharacterId)).toBeLessThan(0);
    expect(relation.body.data.keywords).toEqual(["共同守望", "长期信任"]);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: first.body.data.id,
      toCharacterId: second.body.data.id,
      category: "social",
      subtype: "朋友",
      directed: false
    }).expect(409);

    await request(runtime.app).delete(`/api/characters/${first.body.data.id}`).expect(204);
    const released = await request(runtime.app).patch(`/api/characters/${second.body.data.id}`).send({ aliases: ["小魔"] }).expect(200);
    expect(released.body.data.aliases).toEqual(["小魔"]);

    const other = await request(runtime.app).post("/api/works").send({ title: "另一作品" }).expect(201);
    await request(runtime.app).post(`/api/works/${other.body.data.id}/characters`).send({ name: "小魔" }).expect(201);
  });

  it("维护世界内组织、设定清单与双向角色绑定", async () => {
    const { workId } = await seedWork(runtime);
    const first = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    const second = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const organization = await request(runtime.app).post(`/api/works/${workId}/organizations`).send({
      name: "北港守望会",
      description: "守护航道与旧约的自治组织。",
      settings: ["成员以星图为信物", "重大决策需双席同意"],
      memberIds: [first.body.data.id]
    }).expect(201);
    expect(organization.body.data).toMatchObject({
      name: "北港守望会",
      settings: ["成员以星图为信物", "重大决策需双席同意"],
      memberIds: [first.body.data.id]
    });
    await request(runtime.app).post(`/api/works/${workId}/organizations`).send({ name: " 北港守望会 " }).expect(409);

    const firstCharacter = await request(runtime.app).get(`/api/characters/${first.body.data.id}`).expect(200);
    expect(firstCharacter.body.data.organizationIds).toEqual([organization.body.data.id]);
    const secondCharacter = await request(runtime.app).patch(`/api/characters/${second.body.data.id}`).send({
      organizationIds: [organization.body.data.id]
    }).expect(200);
    expect(secondCharacter.body.data.organizations[0].name).toBe("北港守望会");

    const replaced = await request(runtime.app).patch(`/api/organizations/${organization.body.data.id}`).send({
      memberIds: [second.body.data.id],
      settings: ["新章程已生效"]
    }).expect(200);
    expect(replaced.body.data.memberIds).toEqual([second.body.data.id]);
    expect(replaced.body.data.settings).toEqual(["新章程已生效"]);
    const firstAfter = await request(runtime.app).get(`/api/characters/${first.body.data.id}`).expect(200);
    expect(firstAfter.body.data.organizationIds).toEqual([]);

    const search = await request(runtime.app).get(`/api/works/${workId}/search?q=${encodeURIComponent("新章程")}`).expect(200);
    expect(search.body.data).toContainEqual(expect.objectContaining({ type: "organization", title: "北港守望会" }));
  });

  it("支持原子导入新建、上传替换和删除书籍封面", async () => {
    const before = await request(runtime.app).get("/api/works").expect(200);
    await request(runtime.app).post("/api/works/import").attach("file", Buffer.from("无效"), "bad.pdf").expect(415);
    const afterFailure = await request(runtime.app).get("/api/works").expect(200);
    expect(afterFailure.body.data).toHaveLength(before.body.data.length);

    const imported = await request(runtime.app).post("/api/works/import")
      .field("author", "测试作者")
      .attach("file", Buffer.from("第一章 开始\n故事开始。"), "导入书名.txt")
      .expect(201);
    const workId = imported.body.data.work.id;
    expect(imported.body.data.work).toMatchObject({ title: "导入书名", chapterCount: 1 });

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const uploaded = await request(runtime.app).put(`/api/works/${workId}/cover`).attach("file", png, "cover.png").expect(200);
    expect(uploaded.body.data.coverUrl).toContain(`/api/works/${workId}/cover?v=`);
    const cover = await request(runtime.app).get(`/api/works/${workId}/cover`).expect(200).expect("Content-Type", /image\/png/u);
    expect(cover.body).toEqual(png);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]);
    await request(runtime.app).put(`/api/works/${workId}/cover`).attach("file", jpeg, "cover.jpg").expect(200);
    await request(runtime.app).get(`/api/works/${workId}/cover`).expect(200).expect("Content-Type", /image\/jpeg/u);
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.from([0x00])]);
    await request(runtime.app).put(`/api/works/${workId}/cover`).attach("file", webp, "cover.webp").expect(200);
    await request(runtime.app).get(`/api/works/${workId}/cover`).expect(200).expect("Content-Type", /image\/webp/u);
    await request(runtime.app).put(`/api/works/${workId}/cover`).attach("file", Buffer.from("<svg></svg>"), "cover.svg").expect(415);
    await request(runtime.app).put(`/api/works/${workId}/cover`).attach("file", Buffer.alloc(5 * 1024 * 1024 + 1), "too-large.png").expect(400);
    await request(runtime.app).delete(`/api/works/${workId}/cover`).expect(204);
    await request(runtime.app).get(`/api/works/${workId}/cover`).expect(404);
  });

  it("维护逐章大纲、伏笔关联、未回收与逾期状态", async () => {
    const { workId, chapters } = await seedWork(runtime);
    const outline = await request(runtime.app).put(`/api/chapters/${chapters[0].id}/outline`).send({
      goal: "建立旧友关系",
      conflict: "是否公开旧信",
      turningPoint: "发现信件被调包",
      status: "ready"
    }).expect(200);
    expect(outline.body.data).toMatchObject({ goal: "建立旧友关系", status: "ready" });

    const foreshadow = await request(runtime.app).post(`/api/works/${workId}/foreshadows`).send({
      title: "旧信的真正内容",
      description: "信件将在第三章揭示真相",
      importance: "high",
      status: "planted",
      plannedPayoffChapterId: chapters[1].id,
      occurrences: [{ chapterId: chapters[0].id, role: "setup", note: "首次出现旧信" }]
    }).expect(201);
    const unresolved = await request(runtime.app).get(`/api/works/${workId}/foreshadows?status=unresolved&currentChapterId=${chapters[2].id}`).expect(200);
    expect(unresolved.body.data[0]).toMatchObject({ unresolved: true, overdue: true });

    const resolved = await request(runtime.app).patch(`/api/foreshadows/${foreshadow.body.data.id}`).send({
      status: "resolved",
      resolutionNote: "第三章完成回收",
      plannedPayoffChapterId: chapters[2].id,
      occurrences: [
        { chapterId: chapters[0].id, role: "setup" },
        { chapterId: chapters[2].id, role: "payoff", note: "真相揭晓" }
      ]
    }).expect(200);
    expect(resolved.body.data).toMatchObject({ unresolved: false, resolutionNote: "第三章完成回收" });
    const otherWork = await seedWork(runtime, "跨作品章节");
    await request(runtime.app).post(`/api/foreshadows/${foreshadow.body.data.id}/occurrences`).send({
      chapterId: otherWork.chapters[0].id,
      role: "reminder"
    }).expect(400);
    const outlines = await request(runtime.app).get(`/api/works/${workId}/outlines`).expect(200);
    expect(outlines.body.data[0]).toMatchObject({ goal: "建立旧友关系", volumeTitle: "第一卷" });
    const exported = await request(runtime.app).get(`/api/works/${workId}/export?format=json`).expect(200);
    expect(exported.body.data).toMatchObject({ schemaVersion: 4 });
    expect(exported.body.data.foreshadows[0].occurrences).toHaveLength(2);
  });
});

describe("续写守卫和全书关系 Map-Reduce", () => {
  let runtime: Runtime;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  afterEach(() => runtime.close());

  it("全书角色抽取会落库人物、合并安全别名并过滤通用称谓", async () => {
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }>; max_tokens: number };
      const prompt = body.messages[1]?.content ?? "";
      expect(body.messages[0]?.content).toContain("人物规范化抽取器");
      const chapters = [...prompt.matchAll(/<CHAPTER id="([^"]+)" title="([^"]+)"[^>]*>/gu)];
      if (chapters.length > 1) {
        return new Response(JSON.stringify({ error: { code: "temporary_large_batch_failure" } }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
      if (chapters.length === 1 && prompt.includes("背景记录") && !prompt.includes('fragment="')) {
        return new Response(JSON.stringify({ error: { code: "security_audit_fail" } }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      const chapter = chapters[0];
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
        { canonicalName: "林舟", aliases: ["小舟", "舰长", "G"], identity: "调查员", firstEvidence: { chapterId: chapter?.[1], chapterTitle: chapter?.[2], quote: "林舟在北港见到沈星" } },
        { canonicalName: "沈星", aliases: ["沈博士", "博士"], identity: "通讯官", firstEvidence: { chapterId: chapter?.[1], chapterTitle: chapter?.[2], quote: "沈星说：我们一直是朋友" } }
      ]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({
      content: `林舟在北港见到沈星。沈星说：我们一直是朋友。${"背景记录。".repeat(360)}`
    }).expect(200);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "character-extraction", scope: { type: "book" } }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result).toMatchObject({ savedCount: 2, coveredChapterCount: 3, fallbackSegmentCount: 0 });
    const prompts = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).messages[1].content as string);
    expect(prompts.filter((prompt) => (prompt.match(/<CHAPTER id=/gu) ?? []).length > 1)).toHaveLength(1);
    expect(prompts.some((prompt) => prompt.includes('fragment="'))).toBe(true);
    const characters = await request(runtime.app).get(`/api/works/${workId}/characters`).expect(200);
    const byName = new Map(characters.body.data.map((character: { name: string }) => [character.name, character]));
    expect((byName.get("林舟") as { aliases: string[] }).aliases).toEqual(["小舟"]);
    expect((byName.get("沈星") as { aliases: string[] }).aliases).toEqual(["沈博士"]);
  });

  it("取消运行中的分批任务后不会被后台结果改回完成状态", async () => {
    let requestStarted = false;
    fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      requestStarted = true;
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")), { once: true });
    }));
    runtime = createTestRuntime(fetchMock);
    const { workId } = await seedWork(runtime);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "character-extraction", scope: { type: "book" } }).expect(201);
    const running = request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).then((response) => response);
    for (let index = 0; index < 50 && !requestStarted; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(requestStarted).toBe(true);
    await request(runtime.app).post(`/api/tasks/${task.body.data.id}/cancel`).send({}).expect(200);
    const completedRequest = await running;
    expect(completedRequest.status).toBe(200);
    expect(completedRequest.body.data.status).toBe("cancelled");
    const after = await request(runtime.app).get(`/api/tasks/${task.body.data.id}`).expect(200);
    expect(after.body.data.status).toBe("cancelled");
    const characters = await request(runtime.app).get(`/api/works/${workId}/characters`).expect(200);
    expect(characters.body.data).toEqual([]);
    await request(runtime.app).post(`/api/tasks/${task.body.data.id}/cancel`).send({}).expect(200);
  });

  it("正文变化会使待执行全书任务过期，终态任务不能被改写为取消", async () => {
    runtime = createTestRuntime();
    const { workId, chapters } = await seedWork(runtime);
    const pending = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "book-analysis",
      scope: { type: "book" }
    }).expect(201);
    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({ content: "林舟改写了北港见面。" }).expect(200);
    const expired = await request(runtime.app).get(`/api/tasks/${pending.body.data.id}`).expect(200);
    expect(expired.body.data.status).toBe("expired");
    const cancel = await request(runtime.app).post(`/api/tasks/${pending.body.data.id}/cancel`).send({}).expect(409);
    expect(cancel.body.error.code).toBe("TASK_NOT_CANCELLABLE");
  });

  it("续写前自动装载相关人物、大纲和伏笔，续写后返回冲突卡并绑定文本哈希", async () => {
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }>; max_tokens: number };
      const prompt = body.messages[1]?.content ?? "";
      expect(body.max_tokens).toBe(32_000);
      if (prompt.includes("检查下面的续写候选")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{
          type: "location", severity: "high", title: "地点冲突", description: "林舟仍在北港", candidateQuote: "抵达主星", sourceRefs: ["currentState.location"], suggestion: "保留在北港"
        }]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "林舟瞬间抵达主星。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    const lin = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟", aliases: ["阿舟"], currentState: { location: "北港" } }).expect(201);
    const shen = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const relationship = await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: lin.body.data.id,
      toCharacterId: shen.body.data.id,
      category: "social",
      subtype: "旧友",
      keywords: ["长期信任", "失联重逢"],
      confirmationStatus: "confirmed"
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/settings`).send({ title: "瞬移限制", category: "世界规则", content: "任何人都不能瞬间移动。", locked: true }).expect(201);
    await request(runtime.app).put(`/api/chapters/${chapters[0].id}/outline`).send({ goal: "准备离港", conflict: "引擎损坏", turningPoint: "收到旧信" }).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/foreshadows`).send({ title: "旧信", status: "planted", occurrences: [{ chapterId: chapters[0].id, role: "setup" }] }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const suggestion = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "continue",
      instruction: "让阿舟继续行动",
      scope: { type: "chapter", chapterId: chapters[0].id },
      modelId
    }).expect(201);
    expect(suggestion.body.data.guard).toMatchObject({ status: "warning", chapterVersion: 1 });
    expect(suggestion.body.data.guard.issues[0]).toMatchObject({ type: "location", severity: "high" });
    const prompts = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).messages[1].content as string);
    expect(prompts.every((prompt) => prompt.includes("任何人都不能瞬间移动"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("当前位置") || prompt.includes('"location":"北港"'))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("当前章大纲") && prompt.includes("旧信"))).toBe(true);
    expect(prompts.every((prompt) => /(?:林舟 — 沈星|沈星 — 林舟)/u.test(prompt) && prompt.includes("长期信任、失联重逢"))).toBe(true);
    const stale = await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/accept`).send({ content: "作者改过的候选" }).expect(409);
    expect(stale.body.error.code).toBe("GUARD_STALE");
    await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/guard`).send({ content: "作者改过的候选" }).expect(201);
    const character = (await request(runtime.app).get(`/api/works/${workId}/characters`).expect(200)).body.data[0];
    await request(runtime.app).patch(`/api/characters/${character.id}`).send({ currentState: { location: "主星" } }).expect(200);
    const knowledgeStale = await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/accept`).send({ content: "作者改过的候选" }).expect(409);
    expect(knowledgeStale.body.error.code).toBe("GUARD_STALE");
    await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/guard`).send({ content: "作者改过的候选" }).expect(201);
    await request(runtime.app).patch(`/api/relationships/${relationship.body.data.id}`).send({ keywords: ["共同守望", "重新建立信任"] }).expect(200);
    const relationshipStale = await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/accept`).send({ content: "作者改过的候选" }).expect(409);
    expect(relationshipStale.body.error.code).toBe("GUARD_STALE");
    await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/guard`).send({ content: "作者改过的候选" }).expect(201);
    const accepted = await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/accept`).send({ content: "作者改过的候选" }).expect(200);
    expect(accepted.body.data.chapter.content).toContain("作者改过的候选");
  });

  it("守卫模型返回非法结果时保留续写建议并明确标记检查失败", async () => {
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = body.messages[1]?.content ?? "";
      const content = prompt.includes("检查下面的续写候选") ? "not-json" : "林舟继续检查旧信。";
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    const modelId = await configureAi(runtime, workId);
    const suggestion = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "continue",
      instruction: "继续检查",
      scope: { type: "chapter", chapterId: chapters[0].id },
      modelId
    }).expect(201);
    expect(suggestion.body.data.guard.status).toBe("failed");
    expect(suggestion.body.data.guard.failure).toContain("有效 JSON");
    const blocked = await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/accept`).send({}).expect(409);
    expect(blocked.body.error.code).toBe("GUARD_FAILED");
    const unchanged = await request(runtime.app).get(`/api/chapters/${chapters[0].id}`).expect(200);
    expect(unchanged.body.data.versionNo).toBe(1);
  });

  it("分块分析全书、验证引文并丢弃无原文依据的关系", async () => {
    let chapterIds: string[] = [];
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }>; max_tokens: number };
      const prompt = body.messages[1]?.content ?? "";
      expect(prompt).toContain("单次见面、同场出现");
      expect(prompt).toContain("梦境、假设或替代人生");
      const matches = [...prompt.matchAll(/<CHAPTER id="([^"]+)"/gu)];
      chapterIds = matches.flatMap((match) => match[1] ? [match[1]] : []);
      if (matches.length > 1) {
        return new Response(JSON.stringify({ error: { code: "temporary_large_batch_failure" } }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
      const markedContent = prompt.match(/<CHAPTER\b[^>]*>([\s\S]*?)<\/CHAPTER>/u)?.[1] ?? "";
      if (prompt.includes("上游策略拒绝片段")) {
        return new Response(JSON.stringify({ error: { code: "security_audit_fail" } }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      if (prompt.includes("我们一直是朋友") && markedContent.length > 200) {
        return new Response(JSON.stringify({ error: { code: "security_audit_fail" } }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      if (!prompt.includes("我们一直是朋友")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
        { fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "朋友", keywords: ["长期信任", "共同守望"], directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId: chapterIds[0], chapterTitle: "第一章 埋线", quote: "我们一直是朋友", contextType: "current", supports: "直接说明" }] },
        { fromCharacterId: "林舟", toCharacterId: "沈星", category: "uncertain", subtype: "未知", directed: false, currentStatus: "unknown", confidence: 0.8, timeRange: {}, evidence: [{ chapterId: chapterIds[0], chapterTitle: "第一章 埋线", quote: "原文中不存在的句子", contextType: "current", supports: "无" }] }
      ]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({
      content: `林舟在北港见到沈星。沈星说：我们一直是朋友。${"航行背景。".repeat(360)}上游策略拒绝片段。`
    }).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "relationship-analysis", scope: { type: "book" } }).expect(201);
    expect(Object.keys(task.body.data.sourceVersions)).toHaveLength(3);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result).toMatchObject({ candidateCount: 1, rawCandidateCount: 2, coveredChapterCount: 3, fallbackSegmentCount: 0 });
    expect(result.body.data.result.policyOmittedSegmentCount).toBeGreaterThan(0);
    const prompts = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).messages[1].content as string);
    expect(prompts.filter((prompt) => (prompt.match(/<CHAPTER id=/gu) ?? []).length > 1)).toHaveLength(1);
    expect(prompts.some((prompt) => prompt.includes('fragment="'))).toBe(true);
    const fragmentLengths = prompts
      .filter((prompt) => prompt.includes('fragment="'))
      .map((prompt) => prompt.match(/<CHAPTER\b[^>]*>([\s\S]*?)<\/CHAPTER>/u)?.[1]?.trim().length ?? 0);
    expect(fragmentLengths.some((length) => length > 200)).toBe(true);
    expect(fragmentLengths.some((length) => length > 0 && length <= 200)).toBe(true);
    expect(result.body.data.result.skipped.some((item: { reason: string }) => item.reason.includes("证据引文"))).toBe(true);
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(1);
    expect(relationships.body.data[0]).toMatchObject({ subtype: "朋友", keywords: ["长期信任", "共同守望"], confirmationStatus: "pending" });
  });

  it("已有强关系时忽略同人物对的弱语义重复边", async () => {
    let firstChapterId = "";
    fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{
      fromCharacterId: "林舟",
      toCharacterId: "沈星",
      category: "emotional",
      subtype: "亲密羁绊",
      directed: false,
      currentStatus: "active",
      confidence: 0.9,
      timeRange: {},
      evidence: [{ chapterId: firstChapterId, chapterTitle: "第一章 埋线", quote: "我们一直是朋友", contextType: "current", supports: "两人关系亲密" }]
    }, {
      fromCharacterId: "林舟",
      toCharacterId: "沈星",
      category: "social",
      subtype: "朋友",
      directed: false,
      currentStatus: "active",
      confidence: 0.9,
      timeRange: {},
      evidence: [{ chapterId: firstChapterId, chapterTitle: "第一章 埋线", quote: "我们一直是朋友", contextType: "current", supports: "两人是朋友" }]
    }, {
      fromCharacterId: "林舟",
      toCharacterId: "沈星",
      category: "conflict",
      subtype: "战时敌对",
      directed: false,
      currentStatus: "ended",
      confidence: 0.9,
      timeRange: {},
      evidence: [{ chapterId: firstChapterId, chapterTitle: "第一章 埋线", quote: "我们一直是朋友", contextType: "historical", supports: "曾在单场战斗中对抗" }]
    }]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    firstChapterId = chapters[0].id as string;
    const first = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    const second = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: first.body.data.id,
      toCharacterId: second.body.data.id,
      category: "emotional",
      subtype: "伴侣",
      directed: false,
      confidence: 0.95
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: first.body.data.id,
      toCharacterId: second.body.data.id,
      category: "conflict",
      subtype: "宿敌",
      directed: false,
      confidence: 0.95
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "chapter", chapterId: firstChapterId }
    }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result.candidateCount).toBe(0);
    expect(result.body.data.result.skipped.some((item: { reason: string }) => item.reason.includes("已有伴侣关系"))).toBe(true);
    expect(result.body.data.result.skipped.some((item: { reason: string }) => item.reason.includes("已有宿敌关系") && item.reason.includes("战时敌对"))).toBe(true);
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(2);
    expect(relationships.body.data.map((item: { subtype: string }) => item.subtype).sort()).toEqual(["伴侣", "宿敌"]);
  });

  it("已有亲属监护或更强同级关系时忽略弱重复边", async () => {
    let chapterId = "";
    fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
      { fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "同事", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "林舟说：沈星是我的同事", supports: "明确同事" }] },
      { fromCharacterId: "林舟", toCharacterId: "沈星", category: "emotional", subtype: "亲密羁绊", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "林舟说：沈星是我的同事", supports: "关系亲密" }] },
      { fromCharacterId: "乔安", toCharacterId: "叶宁", category: "social", subtype: "朋友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "乔安说：叶宁是我的朋友", supports: "明确朋友" }] },
      { fromCharacterId: "罗川", toCharacterId: "苏澜", category: "social", subtype: "朋友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "罗川说：苏澜是我最好的朋友", supports: "明确朋友" }] },
      { fromCharacterId: "罗川", toCharacterId: "苏澜", category: "emotional", subtype: "亲密羁绊", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "罗川说：苏澜是我最好的朋友", supports: "关系亲密" }] }
    ]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    chapterId = String(chapters[0].id);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({
      content: "林舟说：沈星是我的同事。乔安说：叶宁是我的朋友。罗川说：苏澜是我最好的朋友。"
    }).expect(200);
    const characters = new Map<string, string>();
    for (const name of ["林舟", "沈星", "乔安", "叶宁", "罗川", "苏澜"]) {
      const character = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name }).expect(201);
      characters.set(name, character.body.data.id as string);
    }
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: characters.get("林舟"), toCharacterId: characters.get("沈星"), category: "family", subtype: "手足", directed: false
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: characters.get("乔安"), toCharacterId: characters.get("叶宁"), category: "social", subtype: "盟友", directed: false
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: characters.get("罗川"), toCharacterId: characters.get("苏澜"), category: "social", subtype: "姐弟般挚友与监护", directed: true
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "chapter", chapterId }
    }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result.candidateCount).toBe(0);
    const reasons = result.body.data.result.skipped.map((item: { reason: string }) => item.reason).join("\n");
    expect(reasons).toContain("已有亲属或监护关系");
    expect(reasons).toContain("已有更强的同级社会关系");
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(3);
  });

  it("拒绝用单次任务或转发消息推断长期社会关系", async () => {
    let chapterId = "";
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = body.messages[1]?.content ?? "";
      expect(prompt).toContain("共同执行一次任务、同属一个组织");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
        { fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "同事", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "林舟和沈星共同执行了一次任务", supports: "共同任务" }] },
        { fromCharacterId: "乔安", toCharacterId: "罗川", category: "social", subtype: "盟友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "乔安把叶宁的消息转告给罗川", supports: "转发消息" }] },
        { fromCharacterId: "苏澜", toCharacterId: "叶宁", category: "social", subtype: "朋友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "苏澜对叶宁说：我们一直是朋友", supports: "直接说明" }] }
      ]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    chapterId = String(chapters[0].id);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({
      content: "林舟和沈星共同执行了一次任务。乔安把叶宁的消息转告给罗川。苏澜对叶宁说：我们一直是朋友。"
    }).expect(200);
    for (const name of ["林舟", "沈星", "乔安", "罗川", "苏澜", "叶宁"]) {
      await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name }).expect(201);
    }
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "chapter", chapterId }
    }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result.candidateCount).toBe(1);
    const reasons = result.body.data.result.skipped.map((item: { reason: string }) => item.reason).join("\n");
    expect(reasons).toContain("“同事”缺少明确身份或跨章长期互动证据");
    expect(reasons).toContain("“盟友”缺少明确身份或跨章长期互动证据");
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(1);
    expect(relationships.body.data[0]).toMatchObject({ subtype: "朋友" });
  });

  it("先合并跨分块证据再判断长期社会关系", async () => {
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = body.messages[1]?.content ?? "";
      const candidates: Array<Record<string, unknown>> = [];
      const first = prompt.match(/<CHAPTER id="([^"]+)"[^>]*>[^<]*林舟替沈星挡下攻击/gu)?.[0]?.match(/id="([^"]+)"/u)?.[1];
      const second = prompt.match(/<CHAPTER id="([^"]+)"[^>]*>[^<]*沈星撤离时护住林舟/gu)?.[0]?.match(/id="([^"]+)"/u)?.[1];
      if (first) candidates.push({
        fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "盟友", directed: false,
        currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId: first, quote: "林舟替沈星挡下攻击", supports: "一次保护" }]
      });
      if (second) candidates.push({
        fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "盟友", directed: false,
        currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId: second, quote: "沈星撤离时护住林舟", supports: "再次保护" }]
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(candidates) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({
      content: `林舟替沈星挡下攻击。${"第一处背景。".repeat(1400)}`
    }).expect(200);
    await request(runtime.app).patch(`/api/chapters/${chapters[1].id}`).send({
      content: `沈星撤离时护住林舟。${"第二处背景。".repeat(1400)}`
    }).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "book" }
    }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.body.data.result).toMatchObject({ candidateCount: 1, rawCandidateCount: 2 });
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(1);
    expect(relationships.body.data[0]).toMatchObject({ subtype: "盟友" });
    expect(relationships.body.data[0].evidence).toHaveLength(2);
  });

  it("历史已结束的强关系不抑制当前关系阶段", async () => {
    let chapterId = "";
    fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
      { fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "朋友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "林舟和沈星现在是朋友", supports: "当前朋友" }] },
      { fromCharacterId: "乔安", toCharacterId: "叶宁", category: "social", subtype: "朋友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "乔安和叶宁现在是朋友", supports: "当前朋友" }] },
      { fromCharacterId: "罗川", toCharacterId: "苏澜", category: "social", subtype: "朋友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "罗川和苏澜现在是朋友", supports: "当前朋友" }] }
    ]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    chapterId = String(chapters[0].id);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({
      content: "林舟和沈星现在是朋友。乔安和叶宁现在是朋友。罗川和苏澜现在是朋友。"
    }).expect(200);
    const characters = new Map<string, string>();
    for (const name of ["林舟", "沈星", "乔安", "叶宁", "罗川", "苏澜"]) {
      const character = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name }).expect(201);
      characters.set(name, character.body.data.id as string);
    }
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: characters.get("林舟"), toCharacterId: characters.get("沈星"), category: "social", subtype: "盟友", directed: false, currentStatus: "ended"
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: characters.get("乔安"), toCharacterId: characters.get("叶宁"), category: "family", subtype: "手足", directed: false, currentStatus: "historical"
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: characters.get("罗川"), toCharacterId: characters.get("苏澜"), category: "emotional", subtype: "伴侣", directed: false, currentStatus: "关系已结束"
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "relationship-analysis", scope: { type: "chapter", chapterId } }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result.candidateCount).toBe(3);
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(6);
    expect(relationships.body.data.filter((item: { subtype: string }) => item.subtype === "朋友")).toHaveLength(3);
  });

  it("新强关系原地升级已有待确认弱关系", async () => {
    let chapterId = "";
    fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{
      fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "盟友", directed: false,
      currentStatus: "active", confidence: 0.95, timeRange: {}, keywords: ["正式结盟", "共同守望"],
      evidence: [{ chapterId, quote: "林舟和沈星成为盟友", supports: "正式联盟" }]
    }]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    chapterId = String(chapters[0].id);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({ content: "林舟和沈星成为盟友。" }).expect(200);
    const first = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    const second = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const weaker = await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: first.body.data.id, toCharacterId: second.body.data.id, category: "social", subtype: "朋友",
      keywords: ["旧有信任"], directed: false, currentStatus: "active", confirmationStatus: "pending"
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "relationship-analysis", scope: { type: "chapter", chapterId } }).expect(201);
    await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(1);
    expect(relationships.body.data[0]).toMatchObject({ id: weaker.body.data.id, subtype: "盟友", confidence: 0.95 });
    expect(relationships.body.data[0].keywords).toEqual(["旧有信任", "正式结盟", "共同守望"]);
  });

  it("同义社会关系不能绕过长期证据且明示结盟可通过", async () => {
    let chapterId = "";
    fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
      { fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "旧友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "林舟和沈星共同执行了一次任务", supports: "一次协作" }] },
      { fromCharacterId: "乔安", toCharacterId: "叶宁", category: "social", subtype: "盟友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "乔安与叶宁正式结盟", supports: "明示结盟" }] }
    ]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    chapterId = String(chapters[0].id);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({ content: "林舟和沈星共同执行了一次任务。乔安与叶宁正式结盟。" }).expect(200);
    for (const name of ["林舟", "沈星", "乔安", "叶宁"]) {
      await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name }).expect(201);
    }
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "relationship-analysis", scope: { type: "chapter", chapterId } }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result.candidateCount).toBe(1);
    expect(result.body.data.result.skipped.map((item: { reason: string }) => item.reason).join("\n"))
      .toContain("“旧友”缺少明确身份或跨章长期互动证据");
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(1);
    expect(relationships.body.data[0]).toMatchObject({ subtype: "盟友" });
  });

  it("拒绝礼称君臣和救援血亲，并把单场宿敌降级为战时敌对", async () => {
    let chapterId = "";
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = body.messages[1]?.content ?? "";
      expect(prompt).toContain("血亲关系必须有明确亲属称谓");
      expect(prompt).toContain("严格核对对话说话人");
      expect(prompt).toContain("集合身份、分身或内部意识不能当作额外人物扩散关系");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
        { fromCharacterId: "林舟", toCharacterId: "沈星", category: "family", subtype: "叔侄", directed: true, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "有两个幼崽走丢了", supports: "救援幼崽" }] },
        { fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "君臣", directed: true, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "君王估计也会过来", supports: "表现敬畏" }] },
        { fromCharacterId: "林舟", toCharacterId: "沈星", category: "conflict", subtype: "宿敌", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "双方开始战斗", supports: "本场战斗直接对抗" }] }
      ]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    chapterId = String(chapters[0].id);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({
      content: "有两个幼崽走丢了。君王估计也会过来。双方开始战斗。"
    }).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "chapter", chapterId }
    }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result.candidateCount).toBe(1);
    expect(result.body.data.result.skipped.map((item: { reason: string }) => item.reason).join("\n")).toContain("血亲关系缺少明确亲属称谓");
    expect(result.body.data.result.skipped.map((item: { reason: string }) => item.reason).join("\n")).toContain("君臣关系缺少权力身份");
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(1);
    expect(relationships.body.data[0]).toMatchObject({ category: "conflict", subtype: "战时敌对", directed: false });
  });

  it("自动关系分析跳过作者的话章节", async () => {
    const prompts: string[] = [];
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      prompts.push(body.messages[1]?.content ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, volumeId } = await seedWork(runtime);
    await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId,
      title: "后记",
      chapterType: "作者的话",
      content: "作者现实中的朋友关系绝不能进入小说人物图。"
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "book" }
    }).expect(201);
    await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.every((prompt) => !prompt.includes("作者现实中的朋友关系"))).toBe(true);
  });

  it("关系分块全部失败时保留既有候选且任务进入 partial", async () => {
    fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: "unavailable" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    }));
    runtime = createTestRuntime(fetchMock);
    const { workId } = await seedWork(runtime);
    const first = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    const second = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const existing = await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: first.body.data.id,
      toCharacterId: second.body.data.id,
      category: "social",
      subtype: "待核旧友",
      confirmationStatus: "pending"
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "relationship-analysis", scope: { type: "book" } }).expect(201);
    const failed = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(502);
    expect(failed.body.error.code).toBe("RELATIONSHIP_ANALYSIS_INCOMPLETE");
    const afterTask = await request(runtime.app).get(`/api/tasks/${task.body.data.id}`).expect(200);
    expect(afterTask.body.data.status).toBe("partial");
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data.some((relationship: { id: string }) => relationship.id === existing.body.data.id)).toBe(true);
  }, 20_000);
});
