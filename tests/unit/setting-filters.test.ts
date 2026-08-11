import { describe, expect, it } from "vitest";
import { filterSettings } from "../../src/public/setting-filters.js";

const records = [
  { id: "a", title: "跃迁限制", category: "世界规则", contentPreview: "跃迁后必须冷却十二小时。", locked: true },
  { id: "b", title: "北港", category: "地点与地图", contentPreview: "边境空间站与贸易港。", locked: false },
  { id: "c", title: "Silver Key", category: "科技与物品", contentPreview: "仅在月食期间生效。", locked: true }
];

describe("设定筛选", () => {
  it("按标题或正文预览匹配关键词，并忽略英文大小写和首尾空格", () => {
    expect(filterSettings(records, { keyword: "  SILVER " }).map((item) => item.id)).toEqual(["c"]);
    expect(filterSettings(records, { keyword: "贸易港" }).map((item) => item.id)).toEqual(["b"]);
  });

  it("组合分类与锁定状态筛选", () => {
    expect(filterSettings(records, { category: "世界规则", lockState: "locked" }).map((item) => item.id)).toEqual(["a"]);
    expect(filterSettings(records, { lockState: "unlocked" }).map((item) => item.id)).toEqual(["b"]);
  });

  it("无筛选条件时保留原顺序", () => {
    expect(filterSettings(records)).toEqual(records);
  });
});
