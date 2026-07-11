import { afterEach, describe, expect, it } from "vitest";
import { ContextBuilder } from "../../src/ai.js";
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
});
