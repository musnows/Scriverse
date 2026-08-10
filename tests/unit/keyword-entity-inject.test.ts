import { afterEach, describe, expect, it } from "vitest";
import { ContextBuilder, matchKeywordEntities } from "../../src/ai.js";
import { createTestRuntime, seedChapter } from "../helpers.js";

describe("AI 关键词实体注入", () => {
  const runtimes: ReturnType<typeof createTestRuntime>[] = [];
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.close();
  });

  it("按主名与别名最长匹配角色，并匹配种族与组织名", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const { work } = await seedChapter(runtime);
    const godzilla = runtime.store.createCharacter(String(work.id), {
      name: "哥斯拉",
      aliases: ["王者"],
      profile: { summary: "地球守护者" }
    });
    const mothra = runtime.store.createCharacter(String(work.id), {
      name: "魔斯拉",
      aliases: ["小魔"]
    });
    const race = runtime.store.createRace(String(work.id), {
      name: "泰坦",
      description: "远古巨兽"
    });
    const organization = runtime.store.createOrganization(String(work.id), {
      name: "地球防卫军",
      description: "联防组织"
    });

    const matches = matchKeywordEntities(
      runtime.store,
      String(work.id),
      "哥斯拉和魔斯拉、还有泰坦与地球防卫军是什么关系？王者也出场了。"
    );

    expect(matches.characterIds.sort()).toEqual([String(godzilla.id), String(mothra.id)].sort());
    expect(matches.raceIds).toEqual([String(race.id)]);
    expect(matches.organizationIds).toEqual([String(organization.id)]);

    const byAlias = matchKeywordEntities(runtime.store, String(work.id), "小魔出现了");
    expect(byAlias.characterIds).toEqual([String(mothra.id)]);
  });

  it("短名不参与匹配，且已排除的实体不会再次命中", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const { work } = await seedChapter(runtime);
    runtime.store.createCharacter(String(work.id), { name: "一" });
    const character = runtime.store.createCharacter(String(work.id), { name: "林舟" });

    expect(matchKeywordEntities(runtime.store, String(work.id), "一与林舟")).toEqual({
      characterIds: [String(character.id)],
      raceIds: [],
      organizationIds: []
    });
    expect(matchKeywordEntities(runtime.store, String(work.id), "林舟又来了", {
      excludeCharacterIds: [String(character.id)]
    })).toEqual({ characterIds: [], raceIds: [], organizationIds: [] });
  });

  it("同对话已注入实体会持久化并在后续匹配中排除", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const { work } = await seedChapter(runtime);
    const character = runtime.store.createCharacter(String(work.id), {
      name: "哥斯拉",
      aliases: ["王者"],
      profile: { summary: "地球守护者" }
    });
    const conversation = runtime.store.createAiConversation(String(work.id), "测试对话");

    const firstMatches = matchKeywordEntities(runtime.store, String(work.id), "哥斯拉是谁？");
    expect(firstMatches.characterIds).toEqual([String(character.id)]);
    runtime.store.mergeAiConversationInjectedEntities(String(conversation.id), String(work.id), {
      characters: firstMatches.characterIds
    });

    const injected = runtime.store.getAiConversationInjectedEntities(String(conversation.id), String(work.id));
    expect(injected.characters).toEqual([String(character.id)]);

    const secondMatches = matchKeywordEntities(runtime.store, String(work.id), "再说说哥斯拉和王者", {
      excludeCharacterIds: injected.characters
    });
    expect(secondMatches.characterIds).toEqual([]);

    const context = new ContextBuilder(runtime.store).build(String(work.id), {
      type: "none",
      mentionCharacterIds: firstMatches.characterIds
    });
    expect(context).toContain("<mentioned_characters>");
    expect(context).toContain("提及角色");
    expect(context).toContain("哥斯拉");
    expect(context).toContain("地球守护者");
  });

  it("fork 对话会复制已注入实体集合", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const { work } = await seedChapter(runtime);
    const character = runtime.store.createCharacter(String(work.id), { name: "魔斯拉" });
    const conversation = runtime.store.createAiConversation(String(work.id));
    const message = runtime.store.addAiConversationMessage(String(conversation.id), {
      role: "user",
      content: "魔斯拉是谁？"
    });
    runtime.store.mergeAiConversationInjectedEntities(String(conversation.id), String(work.id), {
      characters: [String(character.id)]
    });

    const forked = runtime.store.forkAiConversation(String(conversation.id), String(message.id));
    expect(runtime.store.getAiConversationInjectedEntities(String(forked.id), String(work.id))).toEqual({
      characters: [String(character.id)],
      races: [],
      organizations: []
    });
  });
});
