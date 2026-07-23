import { describe, expect, it } from "vitest";
import { characterVersionSourceLabel, describeCharacterVersionChanges } from "../../src/public/character-version.js";

describe("人物版本历史摘要", () => {
  it("显示两个快照之间发生变化的档案分区", () => {
    expect(describeCharacterVersionChanges(
      { name: "燃烧哥斯拉", code: "G-002", raceId: "evolved", species: "进化泰坦", organizationIds: [] },
      { name: "哥斯拉", code: "G-001", raceId: "original", species: "原生泰坦", organizationIds: ["monarch"] }
    )).toEqual(["标准名", "编号", "种族", "所属组织"]);
    expect(describeCharacterVersionChanges({ code: "" }, {})).toEqual([]);
    expect(describeCharacterVersionChanges({ name: "哥斯拉" }, null)).toEqual(["建立人物档案"]);
  });

  it("将版本来源转换为用户可读文案", () => {
    expect(characterVersionSourceLabel("restore")).toBe("历史回滚");
    expect(characterVersionSourceLabel("race")).toBe("种族变更");
    expect(characterVersionSourceLabel("organization")).toBe("组织变更");
  });
});
