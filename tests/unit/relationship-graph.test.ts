import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { buildRelationshipGraph, createGalaxyStarfield, formatRelationshipLabel, getGalaxyNodeAppearance, getGalaxyNodeFocusCamera, layoutGalaxy, projectGalaxyPoint } from "../../src/public/relationship-graph.js";

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

  it("普通关系图与银河图使用相同的完整关系文字", () => {
    expect(formatRelationshipLabel({
      subtype: "君臣",
      keywords: ["王权效忠", "兄弟情谊", "长期并肩", "舍命相救", "相互调侃", "互相关怀"]
    })).toBe("君臣 · 王权效忠 · 兄弟情谊 · 长期并肩 · 舍命相救 · 相互调侃 · 互相关怀");
    expect(formatRelationshipLabel({ subtype: "", keywords: [] })).toBe("关系");
  });

  it("大量角色使用有界采样布局并返回全部节点", () => {
    const characters = Array.from({ length: 600 }, (_, index) => ({ id: `c-${index}`, name: `角色 ${index}` }));
    const graph = buildRelationshipGraph(characters, []);
    const layout = layoutGalaxy(graph, "large-graph-test");
    expect(layout.nodes).toHaveLength(600);
    expect(layout.byId.size).toBe(600);
    expect(layout.nodes.every((node: { x: number; y: number; z: number }) => Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.z))).toBe(true);
    expect(new Set(layout.nodes.map((node: { z: number }) => Math.round(node.z))).size).toBeGreaterThan(100);
  });

  it("为星点建立三维旋臂并按透视深度缩放", () => {
    const stars = createGalaxyStarfield("three-dimensional-test", 120);
    expect(stars).toHaveLength(120);
    expect(stars.every((star: { x: number; y: number; z: number }) => Number.isFinite(star.x) && Number.isFinite(star.y) && Number.isFinite(star.z))).toBe(true);
    expect(new Set(stars.map((star: { z: number }) => Math.round(star.z))).size).toBeGreaterThan(80);

    const camera = { yaw: 0, pitch: 0, distance: 1500, focalRatio: 1.6, zoom: 1 };
    const viewport = { width: 1200, height: 800 };
    const near = projectGalaxyPoint({ x: 100, y: 0, z: -300 }, camera, viewport);
    const far = projectGalaxyPoint({ x: 100, y: 0, z: 300 }, camera, viewport);
    expect(near.scale).toBeGreaterThan(far.scale);
    expect(near.x - viewport.width / 2).toBeGreaterThan(far.x - viewport.width / 2);
  });

  it("点击节点后把三维相机聚焦并放大到该节点", () => {
    const node = { x: 320, y: -80, z: 140 };
    const initial = { yaw: -0.38, pitch: 0.72, distance: 1420, focalRatio: 1.72, zoom: 1, targetX: 0, targetY: 0, targetZ: 0 };
    const focused = { ...initial, ...getGalaxyNodeFocusCamera(node, initial) };
    const viewport = { width: 1200, height: 800 };
    const projected = projectGalaxyPoint(node, focused, viewport);

    expect(focused).toMatchObject({ targetX: 320, targetY: -80, targetZ: 140, distance: 940, zoom: 1.65 });
    expect(projected.x).toBe(viewport.width / 2);
    expect(projected.y).toBe(viewport.height / 2);
  });

  it("银河图按关系数量区分行星颜色与亮度", () => {
    const outer = getGalaxyNodeAppearance({ degree: 1, weightedDegree: 0.65 }, 20);
    const core = getGalaxyNodeAppearance({ degree: 20, weightedDegree: 27 }, 20);

    expect(outer.tier).toBe("outer");
    expect(core.tier).toBe("core");
    expect(core.hue).toBeLessThan(outer.hue);
    expect(Number(core.brightness)).toBeGreaterThan(Number(outer.brightness));
    expect(Number(core.glow)).toBeGreaterThan(Number(outer.glow));
    expect(core.color).not.toBe(outer.color);
  });
});
