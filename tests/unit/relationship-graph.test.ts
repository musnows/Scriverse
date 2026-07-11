import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { buildRelationshipGraph, layoutGalaxy } from "../../src/public/relationship-graph.js";

describe("人物关系图数据与布局", () => {
  it("不渲染已拒绝关系，但保留待审和确认关系", () => {
    const characters = [{ id: "a", name: "甲" }, { id: "b", name: "乙" }];
    const graph = buildRelationshipGraph(characters, [
      { id: "rejected", fromCharacterId: "a", toCharacterId: "b", category: "social", subtype: "误判", confirmationStatus: "rejected" },
      { id: "pending", fromCharacterId: "a", toCharacterId: "b", category: "social", subtype: "旧友", keywords: ["共同成长", "失联重逢", "共同成长"], confirmationStatus: "pending", confidence: 0.8 }
    ]);
    expect(graph.edges.map((edge: { id: string }) => edge.id)).toEqual(["pending"]);
    expect(graph.edges[0].keywords).toEqual(["共同成长", "失联重逢"]);
    expect(graph.warnings).toContainEqual({ relationshipId: "rejected", reason: "关系候选已拒绝" });
  });

  it("大量角色使用有界采样布局并返回全部节点", () => {
    const characters = Array.from({ length: 600 }, (_, index) => ({ id: `c-${index}`, name: `角色 ${index}` }));
    const graph = buildRelationshipGraph(characters, []);
    const layout = layoutGalaxy(graph, "large-graph-test");
    expect(layout.nodes).toHaveLength(600);
    expect(layout.byId.size).toBe(600);
    expect(layout.nodes.every((node: { x: number; y: number }) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });
});
