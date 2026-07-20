import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { buildRaceForest, eligibleRaceParents, raceDescendantIds, racePathLabel } from "../../src/public/race-hierarchy.js";

const races = [
  { id: "human", name: "人类", parentRaceId: null, lineage: [{ id: "human", name: "人类" }] },
  { id: "titan", name: "泰坦", parentRaceId: null, lineage: [{ id: "titan", name: "泰坦" }] },
  { id: "original", name: "原生泰坦", parentRaceId: "titan", lineage: [{ id: "titan", name: "泰坦" }, { id: "original", name: "原生泰坦" }] },
  { id: "alpha", name: "阿尔法泰坦", parentRaceId: "original", lineage: [{ id: "titan", name: "泰坦" }, { id: "original", name: "原生泰坦" }, { id: "alpha", name: "阿尔法泰坦" }] }
];

describe("种族层级前端逻辑", () => {
  it("按名称构建稳定的多层种族森林", () => {
    const forest = buildRaceForest(races);
    expect(forest.map((race: { id: string }) => race.id)).toEqual(["human", "titan"]);
    const titan = forest.find((race: { id: string }) => race.id === "titan");
    expect(titan.children[0].id).toBe("original");
    expect(titan.children[0].children[0].id).toBe("alpha");
  });

  it("生成完整路径并排除当前种族及全部后代父级候选", () => {
    expect(racePathLabel(races[3])).toBe("泰坦 / 原生泰坦 / 阿尔法泰坦");
    expect([...raceDescendantIds(races, "titan")]).toEqual(expect.arrayContaining(["original", "alpha"]));
    expect(eligibleRaceParents(races, "original").map((race: { id: string }) => race.id)).toEqual(["human", "titan"]);
  });
});
