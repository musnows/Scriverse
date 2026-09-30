import { describe, expect, it } from "vitest";
import {
  aiConversationTitleSource,
  composeRoleplayCurrentUserTurn,
  composeRoleplayStoredUserContent,
  formatRoleplayScenePinText,
  normalizeRoleplayScenePin,
  parseRoleplayUserTurn,
  roleplayScenePinHasContent,
  roleplayUserTurnTitleSource
} from "../../src/roleplay-turn.js";
import { defaultAiConversationTitle } from "../../src/store.js";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import * as frontend from "../../src/public/roleplay-turn.js";

describe("角色扮演回合 XML", () => {
  it("把旁白放在 user_message 之前，无旁白时存储原文", () => {
    expect(composeRoleplayStoredUserContent("", "你还要走吗？")).toBe("你还要走吗？");
    expect(composeRoleplayCurrentUserTurn("", "你还要走吗？")).toBe("<user_message>\n你还要走吗？\n</user_message>");
    expect(composeRoleplayCurrentUserTurn("夜雨刚停。", "你还要走吗？")).toBe([
      "<scene_direction>",
      "夜雨刚停。",
      "</scene_direction>",
      "",
      "<user_message>",
      "你还要走吗？",
      "</user_message>"
    ].join("\n"));
    expect(composeRoleplayStoredUserContent("夜雨刚停。", "")).toBe("<scene_direction>\n夜雨刚停。\n</scene_direction>");
  });

  it("转义旁白中的 XML 特殊字符并在解析时还原", () => {
    const stored = composeRoleplayStoredUserContent("灯下写着 A & B <夜航>", "跟我走。");
    expect(stored).toContain("A &amp; B &lt;夜航>");
    expect(stored).not.toContain("<夜航>");
    expect(parseRoleplayUserTurn(stored)).toEqual({
      sceneDirection: "灯下写着 A & B <夜航>",
      userMessage: "跟我走。",
      hasMarkup: true
    });
  });

  it("旧消息没有旁白标签时保持原样", () => {
    expect(parseRoleplayUserTurn("你还要走吗？")).toEqual({
      sceneDirection: "",
      userMessage: "你还要走吗？",
      hasMarkup: false
    });
    expect(roleplayUserTurnTitleSource("<scene_direction>\n夜雨刚停。\n</scene_direction>\n\n<user_message>\n你还要走吗？\n</user_message>")).toBe("你还要走吗？");
    expect(roleplayUserTurnTitleSource("<scene_direction>\n夜雨刚停。\n</scene_direction>")).toBe("夜雨刚停。");
    expect(roleplayUserTurnTitleSource("你还要走吗？")).toBe("你还要走吗？");
  });

  it("格式化会话场景钉并忽略空字段", () => {
    expect(formatRoleplayScenePinText({
      location: " 北港码头 ",
      present: "林舟、顾潮",
      timeLabel: "远航第 12 日黄昏"
    })).toBe("地点：北港码头\n在场：林舟、顾潮\n故事时间：远航第 12 日黄昏");
    expect(roleplayScenePinHasContent(normalizeRoleplayScenePin({ location: "  " }))).toBe(false);
    expect(roleplayScenePinHasContent(normalizeRoleplayScenePin({ location: "北港" }))).toBe(true);
  });

  it.each([
    ['<ai_reference kind="character" id="character_1">林舟</ai_reference> 的感情描写', "林舟 的感情描写"],
    ['检查 <ai_reference kind="setting" id="setting_1">A &amp; B &lt;规则></ai_reference> 的漏洞', "检查 A & B <规则> 的漏洞"],
    ['<ai_reference kind="chapter" id="chapter_1">第一卷 / 第一章</ai_reference>续写', "第一卷 / 第一章续写"],
    ['<ai_reference kind="context-settings" id="include-setting-info">注入上下文设定</ai_reference>\n请检查逻辑', "注入上下文设定\n请检查逻辑"],
    ['<scene_direction>\n夜雨刚停。\n</scene_direction>\n\n<user_message>\n<ai_reference kind="character" id="character_1">林舟</ai_reference>为何离开？\n</user_message>', "林舟为何离开？"],
    ["<user_message>\n请继续写作\n</user_message>", "请继续写作"],
    ["<author_instruction>\n分析人物动机\n</author_instruction>", "分析人物动机"],
    ["解释 <custom>用户 XML</custom> 和 a < b", "解释 <custom>用户 XML</custom> 和 a < b"],
    ["普通提示词", "普通提示词"]
  ])("标题只去除项目 XML 并保留 prompt 语义：%s", (content, expected) => {
    expect(aiConversationTitleSource(content)).toBe(expected);
    expect(frontend.aiConversationTitleSource(content)).toBe(expected);
    expect(defaultAiConversationTitle(content)).toBe(Array.from(expected.replace(/\s+/gu, " ").trim()).slice(0, 15).join("") || "新对话");
  });

  it("默认标题按字符截取且空 prompt 保留新对话", () => {
    expect(defaultAiConversationTitle("<user_message>\n \n</user_message>")).toBe("新对话");
    expect(defaultAiConversationTitle("𠮷".repeat(16))).toBe("𠮷".repeat(15));
  });

  it("前后端纯函数保持同一契约", () => {
    const scene = "潮水拍上木桩。";
    const speech = "别回头。";
    expect(frontend.composeRoleplayCurrentUserTurn(scene, speech)).toBe(composeRoleplayCurrentUserTurn(scene, speech));
    expect(frontend.parseRoleplayUserTurn(composeRoleplayStoredUserContent(scene, speech))).toEqual(
      parseRoleplayUserTurn(composeRoleplayStoredUserContent(scene, speech))
    );
  });
});
