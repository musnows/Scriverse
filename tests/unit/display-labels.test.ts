import { describe, expect, it } from "vitest";
import {
  chapterVersionSourceLabel,
  foreshadowStatusLabel,
  levelLabel,
  outlineStatusLabel,
  providerConnectionLabel,
  providerProtocolLabel,
  providerStatusLabel,
  relationshipCategoryLabel,
  relationshipConfirmationLabel,
  reviewItemTypeLabel,
  reviewStatusLabel,
  searchResultTypeLabel,
  settingStatusLabel,
  taskScopeLabel,
  timelineStatusLabel,
  characterGenderLabel,
  characterStateFieldLabel
} from "../../src/public/display-labels.js";

describe("前端枚举中文标签", () => {
  it("映射各资料模块的数据库枚举", () => {
    expect(settingStatusLabel("confirmed")).toBe("已确认");
    expect(timelineStatusLabel("candidate")).toBe("候选");
    expect(levelLabel("high")).toBe("高");
    expect(foreshadowStatusLabel("planted")).toBe("已埋设");
    expect(outlineStatusLabel("ready")).toBe("可执行");
    expect(relationshipCategoryLabel("social")).toBe("社交");
    expect(relationshipConfirmationLabel("pending")).toBe("待确认");
  });

  it("映射审核、任务、供应商和版本枚举", () => {
    expect(reviewItemTypeLabel("timeline-conflict")).toBe("时间线冲突");
    expect(reviewItemTypeLabel("character-name-variant")).toBe("疑似人物名错字");
    expect(reviewStatusLabel("fixed")).toBe("已修复");
    expect(taskScopeLabel("book")).toBe("全书");
    expect(providerStatusLabel("enabled")).toBe("已启用");
    expect(providerConnectionLabel("success")).toBe("连接正常");
    expect(providerProtocolLabel("anthropic-messages")).toBe("Anthropic Messages");
    expect(providerProtocolLabel("google-vertex")).toBe("Google Vertex");
    expect(chapterVersionSourceLabel("ai-suggestion")).toBe("AI 建议");
    expect(searchResultTypeLabel("timeline-event")).toBe("时间线事件");
    expect(searchResultTypeLabel("chapter-outline")).toBe("章节大纲");
    expect(searchResultTypeLabel("review")).toBe("审核项");
  });

  it("将角色当前状态常用英文字段显示为中文", () => {
    expect(characterStateFieldLabel("location")).toBe("位置");
    expect(characterStateFieldLabel("condition")).toBe("状况");
    expect(characterStateFieldLabel("自定义字段")).toBe("自定义字段");
    expect(characterStateFieldLabel("energy")).toBe("energy");
  });

  it("将角色性别枚举显示为同时适用于人物与非人角色的文案", () => {
    expect(characterGenderLabel("male")).toBe("男 / 雄");
    expect(characterGenderLabel("female")).toBe("女 / 雌");
    expect(characterGenderLabel("none")).toBe("无性别");
    expect(characterGenderLabel("unknown")).toBe("未知");
    expect(characterGenderLabel("invalid")).toBe("未知");
  });

  it("保留中文自定义值并隐藏未知英文枚举", () => {
    expect(reviewItemTypeLabel("自定义问题")).toBe("自定义问题");
    expect(reviewItemTypeLabel("unknown-issue")).toBe("其他审核问题");
    expect(settingStatusLabel("unknown-status")).toBe("未知状态");
  });
});
