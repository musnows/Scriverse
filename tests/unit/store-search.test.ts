import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "../../src/database.js";
import { Store } from "../../src/store.js";

describe("Store 作品搜索", () => {
  let database: Database;
  let store: Store;
  let workId: string;

  beforeEach(() => {
    database = new Database(":memory:");
    store = new Store(database);
    workId = String(store.createWork({ title: "搜索转义测试" }).id);
  });

  afterEach(() => {
    database.close();
  });

  function settingIds(query: string): string[] {
    return store.search(workId, query)
      .filter((item) => item.type === "setting")
      .map((item) => String(item.id));
  }

  it("把反斜杠和用户通配符作为普通字符匹配", () => {
    const backslash = store.createSetting(workId, { title: String.raw`路径 a\b`, category: "测试", content: "" });
    store.createSetting(workId, { title: "路径 ab", category: "测试", content: "" });
    const percent = store.createSetting(workId, { title: "比例 100%", category: "测试", content: "" });
    store.createSetting(workId, { title: "比例 1000", category: "测试", content: "" });
    const underscore = store.createSetting(workId, { title: "标识 item_value", category: "测试", content: "" });
    store.createSetting(workId, { title: "标识 itemXvalue", category: "测试", content: "" });
    const combined = store.createSetting(workId, { title: String.raw`组合 \%_`, category: "测试", content: "" });
    const combinedDecoy = store.createSetting(workId, { title: String.raw`组合 \任意_`, category: "测试", content: "" });

    expect(settingIds(String.raw`a\b`)).toEqual([backslash.id]);
    expect(new Set(settingIds("%"))).toEqual(new Set([String(percent.id), String(combined.id)]));
    expect(new Set(settingIds("_"))).toEqual(new Set([String(underscore.id), String(combined.id), String(combinedDecoy.id)]));
    expect(settingIds(String.raw`\%_`)).toEqual([combined.id]);
  });
});
