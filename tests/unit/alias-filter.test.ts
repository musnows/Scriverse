import { describe, expect, it } from "vitest";
import { isSafeGlobalAlias } from "../../src/ai.js";

describe("自动人物别名过滤", () => {
  it("拒绝通用称号、单字母简称和截断误名", () => {
    for (const alias of ["怪兽之王", "吾王", "舰长", "博士", "父亲", "G", "尔森"]) {
      expect(isSafeGlobalAlias(alias)).toBe(false);
    }
  });

  it("保留原文中有稳定唯一指向的长期昵称", () => {
    for (const alias of ["大胖", "胖胖", "傻大个", "睡神", "魔姐", "安叔"]) {
      expect(isSafeGlobalAlias(alias)).toBe(true);
    }
  });
});
