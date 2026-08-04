import { describe, expect, it } from "vitest";
import { prioritizeGlobalSearchResults, resolveGlobalSearchTarget, splitGlobalSearchHighlight } from "../../src/public/global-search.js";

describe("全局搜索结果导航", () => {
  it("将设定库结果排在正文条目前并保留各组相关度顺序", () => {
    const results = [
      { type: "chapter", id: "chapter-1" },
      { type: "setting", id: "setting-1" },
      { type: "character", id: "character-1" },
      { type: "agent-history", id: "message-1" },
      { type: "chapter", id: "chapter-2" }
    ];

    expect(prioritizeGlobalSearchResults(results)).toEqual([
      { type: "setting", id: "setting-1" },
      { type: "character", id: "character-1" },
      { type: "agent-history", id: "message-1" },
      { type: "chapter", id: "chapter-1" },
      { type: "chapter", id: "chapter-2" }
    ]);
    expect(results.map((item) => item.id)).toEqual(["chapter-1", "setting-1", "character-1", "message-1", "chapter-2"]);
  });

  it("将章节结果直接定位到正文阅读页", () => {
    expect(resolveGlobalSearchTarget({ type: "chapter", id: "chapter / 1" })).toEqual({
      kind: "chapter",
      type: "chapter",
      id: "chapter / 1",
      module: "editor"
    });
    expect(resolveGlobalSearchTarget({ type: "chapter", id: "chapter-1", startLine: 8, endLine: 10 })).toMatchObject({
      kind: "chapter",
      id: "chapter-1",
      startLine: 8,
      endLine: 10
    });
  });

  it("将 Agent 历史结果定位到对应对话和消息", () => {
    expect(resolveGlobalSearchTarget({
      type: "agent-history",
      id: "message / 1",
      conversationId: "conversation / 1",
      messageId: "message / 1"
    })).toEqual({
      kind: "agent-history",
      type: "agent-history",
      id: "message / 1",
      module: "editor",
      conversationId: "conversation / 1",
      messageId: "message / 1"
    });
    expect(resolveGlobalSearchTarget({ type: "agent-history", id: "conversation-1" })).toBeNull();
  });

  it.each([
    ["setting", "settings", "setting", "/api/settings/setting%20%2F%201"],
    ["character", "characters", "character", "/api/characters/character%20%2F%201"],
    ["race", "races", "race", "/api/races/race%20%2F%201"],
    ["organization", "organizations", "organization", "/api/organizations/organization%20%2F%201"],
    ["timeline-track", "timeline", "timeline-track", "/api/timeline-tracks/timeline-track%20%2F%201"],
    ["timeline-event", "timeline", "timeline-event", "/api/timeline/timeline-event%20%2F%201"],
    ["relationship", "relationships", "relationship", "/api/relationships/relationship%20%2F%201"],
    ["chapter-outline", "outlines", "chapter-outline", "/api/chapters/chapter-outline%20%2F%201/outline"],
    ["foreshadow", "outlines", "foreshadow", "/api/foreshadows/foreshadow%20%2F%201"],
    ["review", "reviews", "review", "/api/reviews/review%20%2F%201"]
  ])("将 %s 结果定位到对应实体详情", (type, module, entity, apiPath) => {
    expect(resolveGlobalSearchTarget({ type, id: `${type} / 1` })).toEqual({
      kind: "entity",
      type,
      id: `${type} / 1`,
      module,
      entity,
      apiPath
    });
  });

  it("拒绝缺少标识或未知类型的结果", () => {
    expect(resolveGlobalSearchTarget({ type: "character" })).toBeNull();
    expect(resolveGlobalSearchTarget({ type: "timeline", id: "timeline-1" })).toBeNull();
  });

  it("按大小写不敏感方式拆分高亮片段且保留原文", () => {
    expect(splitGlobalSearchHighlight("North 北港 north", "north")).toEqual([
      { text: "North", match: true },
      { text: " 北港 ", match: false },
      { text: "north", match: true }
    ]);
    expect(splitGlobalSearchHighlight("北港议会", "beigang")).toEqual([{ text: "北港议会", match: false }]);
  });
});
