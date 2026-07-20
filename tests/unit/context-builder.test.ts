import { afterEach, describe, expect, it } from "vitest";
import { ContextBuilder, estimateAiTokens } from "../../src/ai.js";
import { createTestRuntime, seedChapter } from "../helpers.js";

describe("AI 上下文组装", () => {
  const runtimes: ReturnType<typeof createTestRuntime>[] = [];
  afterEach(() => runtimes.splice(0).forEach((runtime) => runtime.close()));

  it("始终带入锁定设定和锁定角色字段", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const { work, chapter } = await seedChapter(runtime);
    runtime.store.createSetting(String(work.id), {
      title: "跃迁限制",
      category: "世界规则",
      content: "同一艘船每日只能跃迁一次。",
      locked: true,
      status: "confirmed"
    });
    const character = runtime.store.createCharacter(String(work.id), {
      name: "林舟",
      attributes: { species: "人类", age: 27 },
      currentState: { location: "北港" },
      lockedFields: ["species", "location"]
    });
    const partner = runtime.store.createCharacter(String(work.id), { name: "沈星" });
    runtime.store.createRelationship(String(work.id), {
      fromCharacterId: String(character.id),
      toCharacterId: String(partner.id),
      category: "social",
      subtype: "旧友",
      keywords: ["长期信任", "失联重逢"],
      confirmationStatus: "confirmed"
    });
    runtime.store.createRelationship(String(work.id), {
      fromCharacterId: String(character.id),
      toCharacterId: String(partner.id),
      category: "uncertain",
      subtype: "待核实",
      keywords: ["未经作者确认"],
      confirmationStatus: "pending"
    });
    runtime.store.createOrganization(String(work.id), {
      name: "北港守望会",
      description: "维护航道与旧约。",
      settings: ["成员以星图为信物"],
      memberIds: [String(character.id)]
    });
    const profileSection = runtime.store.createCharacterProfileSection(String(character.id), {
      sectionType: "background",
      title: "远古背景",
      summary: "角色曾守护旧航道。",
      contentMarkdown: "不应自动载入的长篇正文标记 CHARACTER_SECTION_FULL_CONTENT"
    });

    const context = new ContextBuilder(runtime.store).build(String(work.id), {
      type: "chapter",
      chapterId: String(chapter.id),
      characterIds: [String(character.id)]
    });

    expect(context).toContain("跃迁限制");
    expect(context).toContain("每日只能跃迁一次");
    expect(context).toContain("species=人类");
    expect(context).toContain("location=北港");
    expect(context).toContain("北港守望会");
    expect(context).toContain("成员以星图为信物");
    expect(context).toContain(String(profileSection.id));
    expect(context).toContain("远古背景");
    expect(context).not.toContain("CHARACTER_SECTION_FULL_CONTENT");
    expect(context).toMatch(/(?:林舟 — 沈星|沈星 — 林舟)/u);
    expect(context).toContain("长期信任、失联重逢");
    expect(context).not.toContain("未经作者确认");
    expect(context).toContain("林舟抵达北港");
  });

  it("明确标记选中文本并拒绝跨作品章节", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const first = await seedChapter(runtime, "旧句需要润色。");
    const second = await seedChapter(runtime, "另一本作品的正文。");
    const builder = new ContextBuilder(runtime.store);

    const context = builder.build(String(first.work.id), {
      type: "chapter",
      chapterId: String(first.chapter.id),
      selection: "旧句需要润色。"
    });
    expect(context).toContain("当前选中文本（本次修改目标）");
    expect(() => builder.build(String(first.work.id), { type: "chapter", chapterId: String(second.chapter.id) })).toThrow("章节不属于当前作品");
  });

  it("无上下文范围不隐式引用作品内容，但保留主动添加的引用", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const { work, chapter } = await seedChapter(runtime, "不应被自动引用的章节正文。");
    const setting = runtime.store.createSetting(String(work.id), {
      title: "主动引用设定",
      category: "世界规则",
      content: "只有主动引用时才应出现。",
      locked: true,
      status: "confirmed"
    });

    expect(new ContextBuilder(runtime.store).build(String(work.id), { type: "none" })).toBe("");
    const explicitContext = new ContextBuilder(runtime.store).build(String(work.id), {
      type: "none",
      settingIds: [String(setting.id)]
    });
    expect(explicitContext).toContain("主动引用设定");
    expect(explicitContext).not.toContain(String(chapter.content));
  });

  it("将用户主动引用的章节正文加入无上下文请求并拒绝跨作品引用", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const first = await seedChapter(runtime, "第一本作品需要主动引用的正文。");
    const second = await seedChapter(runtime, "另一本作品的正文。");
    const builder = new ContextBuilder(runtime.store);

    const context = builder.build(String(first.work.id), {
      type: "none",
      chapterIds: [String(first.chapter.id)]
    });
    expect(context).toContain("作者主动引用的章节");
    expect(context).toContain("第一章 抵达");
    expect(context).toContain("第一本作品需要主动引用的正文");
    expect(() => builder.build(String(first.work.id), {
      type: "none",
      chapterIds: [String(second.chapter.id)]
    })).toThrow("引用章节不属于当前作品");
  });

  it("可引用各章节当前版本的概要而不带入正文", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const { work, chapter } = await seedChapter(runtime, "不应作为全书概要引用的正文。");
    runtime.store.db.run(
      `INSERT INTO chapter_insights (id, chapter_id, chapter_version, summary, events_json, characters_json,
       settings_json, evidence_json, uncertainties_json, status, created_at) VALUES (?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', 'review', ?)`,
      "insight-current",
      String(chapter.id),
      Number(chapter.versionNo),
      "林舟抵达北港，决定追查失踪的信号。",
      "2026-07-15T00:00:00.000Z"
    );

    const context = new ContextBuilder(runtime.store).build(String(work.id), {
      type: "entities",
      includeBookSummary: true
    });

    expect(context).toContain("全书章节概要");
    expect(context).toContain("林舟抵达北港");
    expect(context).not.toContain("不应作为全书概要引用的正文");
  });

  it("按配额降级单章概要时同时保留开头和结尾", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const { work, chapter } = await seedChapter(runtime);
    runtime.store.db.run(
      `INSERT INTO chapter_insights (id, chapter_id, chapter_version, summary, events_json, characters_json,
       settings_json, evidence_json, uncertainties_json, status, created_at) VALUES (?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', 'review', ?)`,
      "insight-long",
      String(chapter.id),
      Number(chapter.versionNo),
      `${"早期概要。".repeat(120)}保留最新概要。`,
      "2026-07-15T00:00:00.000Z"
    );

    const context = new ContextBuilder(runtime.store).build(String(work.id), {
      type: "entities",
      includeBookSummary: true
    }, 60_000, 80);

    expect(context).toContain("本卷其余章节概要已按预算折叠");
    expect(context).toContain("早期概要");
    expect(context).toContain("保留最新概要");
    expect(estimateAiTokens(context)).toBeLessThan(160);
  });

  it("全书超限时保留跨卷概要并优先召回与问题相关的早期正文", () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const work = runtime.store.createWork({ title: "分层上下文", author: "测试作者" });
    const earlyVolume = runtime.store.createVolume(String(work.id), { title: "第一卷 旧港" });
    const earlyChapter = runtime.store.createChapter(String(work.id), {
      volumeId: String(earlyVolume.id),
      title: "第一章 密钥",
      content: `月蚀密钥藏在旧港钟楼。${"早期航行记录。".repeat(80)}`
    });
    const lateVolume = runtime.store.createVolume(String(work.id), { title: "第二卷 北境" });
    const lateChapter = runtime.store.createChapter(String(work.id), {
      volumeId: String(lateVolume.id),
      title: "第九章 追击",
      content: `舰队在北境追击敌人。${"后期战斗记录。".repeat(80)}`
    });
    for (const [id, chapter, summary] of [
      ["insight-early", earlyChapter, "林舟在旧港发现月蚀密钥。"],
      ["insight-late", lateChapter, "舰队抵达北境并开始追击。"]
    ] as const) {
      runtime.store.db.run(
        `INSERT INTO chapter_insights (id, chapter_id, chapter_version, summary, events_json, characters_json,
         settings_json, evidence_json, uncertainties_json, status, created_at) VALUES (?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', 'review', ?)`,
        id,
        String(chapter.id),
        Number(chapter.versionNo),
        summary,
        "2026-07-18T00:00:00.000Z"
      );
    }

    const plan = new ContextBuilder(runtime.store).buildPlan(
      String(work.id),
      { type: "book" },
      260,
      100,
      "月蚀密钥藏在哪里？"
    );

    expect(plan.context).toContain("# 第一卷 旧港");
    expect(plan.context).toContain("# 第二卷 北境");
    expect(plan.context).toContain("月蚀密钥藏在旧港钟楼");
    expect(plan.context).toContain("上下文规划");
    expect(plan.omittedBlockIds.length).toBeGreaterThan(0);
    expect(plan.tokenCount).toBeLessThanOrEqual(260);
  });
});
