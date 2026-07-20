import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { applyRelationshipDragInfluence, assignRelationshipEdgeCurves, buildRelationshipGraph, createGalaxyStarfield, formatRelationshipDetailLabel, formatRelationshipLabel, formatRelationshipStatusNote, getGalaxyNodeAppearance, getGalaxyNodeFocusCamera, getObsidianNodeAppearance, getRelationshipEdgeGeometry, groupRelationshipDetailsByCharacterName, layoutGalaxy, layoutRelationshipNetwork, projectGalaxyPoint, resolveRelationshipNodeGroup, stepRelationshipDragPhysics, stepRelationshipInertiaCoast } from "../../src/public/relationship-graph.js";

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

  it("在关系详情中用括号解释虚线状态", () => {
    expect(formatRelationshipStatusNote({ category: "conflict", confirmationStatus: "pending" })).toBe("（待确认）");
    expect(formatRelationshipStatusNote({ category: "uncertain", confirmationStatus: "confirmed" })).toBe("（关系类型未确定）");
    expect(formatRelationshipDetailLabel({
      category: "uncertain",
      subtype: "身份关联",
      confirmationStatus: "pending"
    })).toBe("身份关联（待确认 · 关系类型未确定）");
    expect(formatRelationshipStatusNote({ category: "social", confirmationStatus: "confirmed" })).toBe("");
  });

  it("为同一人物对的多条关系分配独立弧线", () => {
    const offsets = assignRelationshipEdgeCurves([
      { id: "friend", source: "a", target: "b", directed: false },
      { id: "admire", source: "a", target: "b", directed: true }
    ]);

    expect(offsets.get("admire")).toBe(-12);
    expect(offsets.get("friend")).toBe(12);
    expect(getRelationshipEdgeGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 10, offsets.get("admire")).path)
      .not.toBe(getRelationshipEdgeGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 10, offsets.get("friend")).path);
  });

  it("关系连线避开节点中心并为弧线提供标签位置", () => {
    const straight = getRelationshipEdgeGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 10, 0);
    const curved = getRelationshipEdgeGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 10, 12);

    expect(straight.path).toBe("M 12.0 0.0 L 88.0 0.0");
    expect(curved.path).toContain(" Q ");
    expect(curved.labelY).toBeGreaterThan(0);
  });

  it("银河图角色详情按关联角色名称合并多条关系", () => {
    const graph = buildRelationshipGraph([
      { id: "olsen", name: "奥尔森" },
      { id: "ghidorah", name: "基多拉" },
      { id: "hall", name: "哈尔" }
    ], [
      { id: "family", fromCharacterId: "olsen", toCharacterId: "ghidorah", category: "family", subtype: "叔侄", confirmationStatus: "confirmed" },
      { id: "conflict", fromCharacterId: "olsen", toCharacterId: "ghidorah", category: "conflict", subtype: "挑战与放逐", confirmationStatus: "confirmed" },
      { id: "social", fromCharacterId: "olsen", toCharacterId: "hall", category: "social", subtype: "君臣", confirmationStatus: "confirmed" }
    ]);

    const groups = groupRelationshipDetailsByCharacterName(graph, "olsen");

    expect(groups.map((group: { name: string }) => group.name)).toEqual(["基多拉", "哈尔"]);
    expect(groups[0].edges.map((edge: { id: string }) => edge.id)).toEqual(["family", "conflict"]);
  });

  it("按组织、种族、身份解析 Obsidian 节点分组并映射低饱和配色", () => {
    expect(resolveRelationshipNodeGroup({
      organizations: [{ id: "o1", name: "北境联盟" }],
      species: "人类",
      identity: "将军"
    })).toMatchObject({ type: "organization", label: "北境联盟" });
    expect(resolveRelationshipNodeGroup({ species: "精灵", identity: "学者" })).toMatchObject({ type: "species", label: "精灵" });
    expect(resolveRelationshipNodeGroup({ identity: "流浪商人" })).toMatchObject({ type: "identity", label: "流浪商人" });

    const hub = getObsidianNodeAppearance({ degree: 12, groupKey: "species:人类", species: "人类" }, 12);
    const leaf = getObsidianNodeAppearance({ degree: 1, groupKey: "species:精灵", species: "精灵" }, 12);
    expect(hub.size).toBeGreaterThan(leaf.size);
    expect(hub.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(hub.glow).toContain("rgba");
    expect(hub.color).not.toBe(leaf.color);
  });

  it("构建图谱时写入分组与度数相关节点尺寸", () => {
    const graph = buildRelationshipGraph([
      { id: "a", name: "甲", species: "人类", organizations: [{ id: "o1", name: "朝廷" }] },
      { id: "b", name: "乙", species: "妖族" },
      { id: "c", name: "丙", attributes: { identity: "隐士" } }
    ], [
      { id: "e1", fromCharacterId: "a", toCharacterId: "b", category: "conflict", confidence: 0.9, confirmationStatus: "confirmed" },
      { id: "e2", fromCharacterId: "a", toCharacterId: "c", category: "social", confidence: 0.7, confirmationStatus: "confirmed" }
    ]);
    expect(graph.stats.maxDegree).toBe(2);
    expect(graph.nodeById.get("a")?.groupType).toBe("organization");
    expect(graph.nodeById.get("a")?.nodeSize).toBeGreaterThan(graph.nodeById.get("b")?.nodeSize ?? 0);
    expect(graph.nodeById.get("a")?.color).toBeTruthy();
  });

  it("普通关系网络使用稳定的力导向布局并容纳全部角色", () => {
    const characters = Array.from({ length: 18 }, (_, index) => ({ id: `n-${index}`, name: `角色 ${index}` }));
    const relationships = Array.from({ length: 14 }, (_, index) => ({
      id: `edge-${index}`,
      fromCharacterId: "n-0",
      toCharacterId: `n-${index + 1}`,
      category: index % 2 ? "social" : "family",
      confidence: 0.8,
      confirmationStatus: "confirmed"
    }));
    const graph = buildRelationshipGraph(characters, relationships);
    const first = layoutRelationshipNetwork(graph, "stable-layout");
    const second = layoutRelationshipNetwork(graph, "stable-layout");

    expect(first.nodes).toHaveLength(18);
    expect(first.nodes.map((node: { id: string; x: number; y: number }) => [node.id, node.x, node.y]))
      .toEqual(second.nodes.map((node: { id: string; x: number; y: number }) => [node.id, node.x, node.y]));
    expect(first.nodes.every((node: { x: number; y: number }) => node.x >= 48 && node.x <= 1152 && node.y >= 42 && node.y <= 598)).toBe(true);
    expect(new Set(first.nodes.map((node: { x: number }) => Math.round(node.x))).size).toBeGreaterThan(12);
    expect(new Set(first.nodes.map((node: { y: number }) => Math.round(node.y))).size).toBeGreaterThan(12);
    const hub = first.nodes.find((node: { id: string }) => node.id === "n-0");
    const leaf = first.nodes.find((node: { id: string }) => node.id === "n-1");
    expect(hub?.radius).toBeGreaterThan(leaf?.radius ?? 0);
  });

  it("拖拽节点时用弹簧与斥力带动关联节点并产生惯性位移", () => {
    const positions = new Map([
      ["dragged", { x: 0, y: 0 }],
      ["related", { x: 120, y: 0 }],
      ["nearby", { x: 38, y: 0 }],
      ["distant", { x: 300, y: 0 }]
    ]);
    const radii = new Map([["dragged", 20], ["related", 20], ["nearby", 20], ["distant", 20]]);
    const relatedBefore = positions.get("related")?.x ?? 0;
    const nearbyBefore = positions.get("nearby")?.x ?? 0;
    const changed = applyRelationshipDragInfluence(
      positions,
      "dragged",
      { x: 60, y: 0 },
      new Set(["related"]),
      radii,
      { minimumX: -500, maximumX: 500, minimumY: -500, maximumY: 500 },
      { steps: 12, springStrength: 0.12, repulsionStrength: 3200, damping: 0.8 }
    );

    expect(positions.get("dragged")).toEqual({ x: 60, y: 0 });
    expect(positions.get("related")?.x).toBeGreaterThan(relatedBefore);
    expect(positions.get("nearby")?.x).toBeLessThan(nearbyBefore);
    expect(Math.abs((positions.get("distant")?.x ?? 300) - 300)).toBeLessThan(8);
    expect(changed.has("dragged")).toBe(true);
    expect(changed.has("related")).toBe(true);
  });

  it("物理步进会保留速度并在松手后继续沉降", () => {
    const positions = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 160, y: 0 }]
    ]);
    const velocities = new Map([
      ["a", { vx: 0, vy: 0 }],
      ["b", { vx: 0, vy: 0 }]
    ]);
    const first = stepRelationshipDragPhysics({
      positions,
      velocities,
      edges: [{ id: "e", source: "a", target: "b" }],
      nodeRadii: new Map([["a", 16], ["b", 16]]),
      bounds: { minimumX: -400, maximumX: 400, minimumY: -400, maximumY: 400 },
      degrees: new Map([["a", 1], ["b", 1]]),
      activeNodeIds: new Set(["a", "b"]),
      pinnedNodeId: "a",
      pinnedPosition: { x: 40, y: 0 }
    }, { springStrength: 0.1, desiredEdgeLength: 180, damping: 0.9 });
    expect(first.changedNodeIds.has("b")).toBe(true);
    expect(Math.abs(velocities.get("b")?.vx ?? 0)).toBeGreaterThan(0.01);

    // 松手后若继续步进仍可有能量，但产品层会立即冻结；这里只验证物理核本身仍可用
    const afterRelease = stepRelationshipDragPhysics({
      positions,
      velocities,
      edges: [{ id: "e", source: "a", target: "b" }],
      nodeRadii: new Map([["a", 16], ["b", 16]]),
      bounds: { minimumX: -400, maximumX: 400, minimumY: -400, maximumY: 400 },
      degrees: new Map([["a", 1], ["b", 1]]),
      activeNodeIds: new Set(["a", "b"]),
      pinnedNodeId: null,
      pinnedPosition: null
    }, { springStrength: 0.1, desiredEdgeLength: 180, damping: 0.9 });
    expect(afterRelease.energy).toBeGreaterThan(0);
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

  it("松手惯性滑行只靠速度衰减，不会被弹簧持续拉动", () => {
    const positions = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 120, y: 0 }]
    ]);
    const velocities = new Map([
      ["a", { vx: 8, vy: 0 }],
      ["b", { vx: 5, vy: 0 }]
    ]);
    const first = stepRelationshipInertiaCoast({
      positions,
      velocities,
      nodeRadii: new Map([["a", 12], ["b", 12]]),
      bounds: { minimumX: -200, maximumX: 200, minimumY: -200, maximumY: 200 },
      activeNodeIds: new Set(["a", "b"])
    }, { damping: 0.88 });
    expect(first.changedNodeIds.has("a")).toBe(true);
    expect(positions.get("a")?.x).toBeGreaterThan(0);
    expect(Math.abs(velocities.get("a")?.vx ?? 0)).toBeLessThan(8);

    let energy = first.energy;
    for (let step = 0; step < 40; step += 1) {
      energy = stepRelationshipInertiaCoast({
        positions,
        velocities,
        nodeRadii: new Map([["a", 12], ["b", 12]]),
        bounds: { minimumX: -200, maximumX: 200, minimumY: -200, maximumY: 200 },
        activeNodeIds: new Set(["a", "b"])
      }, { damping: 0.88 }).energy;
    }
    expect(energy).toBeLessThan(0.5);
  });
});
