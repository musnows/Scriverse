const RELATION_STYLE = Object.freeze({
  family: { label: "亲属", color: "#43e39a" },
  social: { label: "社交", color: "#438cff" },
  emotional: { label: "情感", color: "#ff5f69" },
  conflict: { label: "冲突", color: "#ffad42" },
  uncertain: { label: "未确定", color: "#9aa5b5" }
});

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const MINDMAP_LAYOUTS = Object.freeze({
  standard: Object.freeze({ width: 1000, height: 490, firstRadiusX: 270, firstRadiusY: 145, secondRadiusX: 425, secondRadiusY: 205, marginX: 65, marginY: 48, edgeCurve: 55, labelOffset: 6 }),
  expanded: Object.freeze({ width: 1400, height: 760, firstRadiusX: 520, firstRadiusY: 285, secondRadiusX: 650, secondRadiusY: 350, marginX: 72, marginY: 54, edgeCurve: 88, labelOffset: 10 })
});

export function formatRelationshipLabel(edge, separator = " · ") {
  const subtype = String(edge?.subtype ?? "").trim();
  const keywords = Array.isArray(edge?.keywords)
    ? edge.keywords.map(String).map((value) => value.trim()).filter(Boolean)
    : [];
  return [subtype, ...keywords].filter(Boolean).join(separator) || "关系";
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let value = seed || 1;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildRelationshipGraph(characters, relationships) {
  const nodes = characters.map((character) => ({
    id: String(character.id),
    name: String(character.name),
    aliases: Array.isArray(character.aliases) ? character.aliases : [],
    identity: String(character.attributes?.identity ?? ""),
    locked: Array.isArray(character.lockedFields) && character.lockedFields.length > 0,
    degree: 0,
    weightedDegree: 0,
    importance: 0
  }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const warnings = [];
  const edges = [];
  for (const relationship of relationships) {
    if (String(relationship.confirmationStatus ?? "pending") === "rejected") {
      warnings.push({ relationshipId: relationship.id, reason: "关系候选已拒绝" });
      continue;
    }
    const source = nodeById.get(String(relationship.fromCharacterId));
    const target = nodeById.get(String(relationship.toCharacterId));
    if (!source || !target || source === target) {
      warnings.push({ relationshipId: relationship.id, reason: "关系端点不存在" });
      continue;
    }
    const confidence = clamp(Number(relationship.confidence) || 0, 0, 1);
    const edge = {
      id: String(relationship.id),
      source: source.id,
      target: target.id,
      category: RELATION_STYLE[relationship.category] ? relationship.category : "uncertain",
      subtype: String(relationship.subtype || relationship.category || "关系"),
      keywords: Array.isArray(relationship.keywords)
        ? [...new Set(relationship.keywords.map(String).map((value) => value.trim()).filter(Boolean))].slice(0, 8)
        : [],
      directed: Boolean(relationship.directed),
      confidence,
      evidenceCount: Array.isArray(relationship.evidence) ? relationship.evidence.length : 0,
      confirmationStatus: String(relationship.confirmationStatus ?? "pending"),
      currentStatus: String(relationship.currentStatus ?? "active"),
      locked: Boolean(relationship.locked)
    };
    edges.push(edge);
    const weight = confidence * (edge.confirmationStatus === "confirmed" ? 1.35 : 1) * (1 + Math.min(edge.evidenceCount, 4) * 0.08);
    for (const node of [source, target]) {
      node.degree += 1;
      node.weightedDegree += weight;
    }
  }
  for (const node of nodes) node.importance = node.weightedDegree + Math.sqrt(node.degree) * 0.8;
  nodes.sort((left, right) => right.importance - left.importance || left.name.localeCompare(right.name, "zh-CN"));
  return { nodes, edges, nodeById, warnings, stats: { nodeCount: nodes.length, edgeCount: edges.length } };
}

function mindMapLayout(graph, rootId, visibleIds, layout) {
  const root = graph.nodeById.get(rootId) ?? graph.nodes[0];
  const positions = new Map();
  if (!root) return positions;
  const centerX = layout.width / 2;
  const centerY = layout.height / 2;
  positions.set(root.id, { x: centerX, y: centerY, depth: 0 });
  const adjacency = new Map(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    adjacency.get(edge.source)?.push({ id: edge.target, edge });
    adjacency.get(edge.target)?.push({ id: edge.source, edge });
  }
  const visited = new Set([root.id]);
  const first = (adjacency.get(root.id) ?? []).filter((item) => visibleIds.has(item.id));
  first.sort((left, right) => {
    const categoryOrder = ["family", "social", "emotional", "conflict", "uncertain"];
    return categoryOrder.indexOf(left.edge.category) - categoryOrder.indexOf(right.edge.category);
  });
  first.forEach((item, index) => {
    const angle = -Math.PI / 2 + Math.PI * 2 * index / Math.max(first.length, 1);
    positions.set(item.id, { x: centerX + Math.cos(angle) * layout.firstRadiusX, y: centerY + Math.sin(angle) * layout.firstRadiusY, depth: 1 });
    visited.add(item.id);
  });
  const second = [...visibleIds].filter((id) => !visited.has(id));
  second.forEach((id, index) => {
    const parent = first.length ? first[index % first.length]?.id : root.id;
    const parentPosition = positions.get(parent) ?? positions.get(root.id);
    const baseAngle = Math.atan2(parentPosition.y - centerY, parentPosition.x - centerX);
    const offset = (Math.floor(index / Math.max(first.length, 1)) + 1) * 0.18 * (index % 2 ? 1 : -1);
    positions.set(id, {
      x: clamp(centerX + Math.cos(baseAngle + offset) * layout.secondRadiusX, layout.marginX, layout.width - layout.marginX),
      y: clamp(centerY + Math.sin(baseAngle + offset) * layout.secondRadiusY, layout.marginY, layout.height - layout.marginY),
      depth: 2
    });
  });
  return positions;
}

export function renderRelationshipMindMap(container, graph, options = {}) {
  let selectedId = graph.nodes[0]?.id ?? null;
  const manualPositions = new Map();
  const layout = options.expanded ? MINDMAP_LAYOUTS.expanded : MINDMAP_LAYOUTS.standard;
  const render = () => {
    container.replaceChildren();
    if (!graph.nodes.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = "<b>还没有角色档案</b>先创建角色，关系图会在这里出现。";
      container.append(empty);
      return;
    }
    const visibleNodes = graph.nodes.slice(0, 30);
    if (selectedId && !visibleNodes.some((node) => node.id === selectedId)) visibleNodes[visibleNodes.length - 1] = graph.nodeById.get(selectedId);
    const visibleIds = new Set(visibleNodes.filter(Boolean).map((node) => node.id));
    const positions = mindMapLayout(graph, selectedId, visibleIds, layout);
    for (const [nodeId, position] of manualPositions) if (visibleIds.has(nodeId)) positions.set(nodeId, position);
    const shell = document.createElement("section");
    shell.className = `relationship-map-card${options.expanded ? " is-expanded" : ""}`;
    shell.dataset.testid = "relationship-mindmap";
    const toolbar = document.createElement("header");
    toolbar.className = "relationship-map-toolbar";
    toolbar.innerHTML = `<div><strong>人物关系思维图</strong><small>${graph.stats.nodeCount} 个角色 · ${graph.stats.edgeCount} 条关系</small></div><div class="relationship-map-legend">${Object.entries(RELATION_STYLE).map(([key, style]) => `<span><i class="${key}"></i>${style.label}</span>`).join("")}</div>`;
    const actions = document.createElement("div");
    actions.className = "relationship-map-actions";
    if (!options.expanded) {
      const expand = document.createElement("button");
      expand.type = "button";
      expand.className = "ghost-button";
      expand.textContent = "放大关系图";
      expand.dataset.testid = "relationship-map-expand";
      expand.addEventListener("click", () => options.onOpenExpanded?.());
      actions.append(expand);
    }
    const fullscreen = document.createElement("button");
    fullscreen.type = "button";
    fullscreen.className = "ghost-button";
    fullscreen.textContent = "全屏银河图";
    fullscreen.dataset.testid = "relationship-galaxy-open";
    fullscreen.addEventListener("click", () => options.onOpenGalaxy?.());
    actions.append(fullscreen);
    toolbar.append(actions);
    const viewport = document.createElement("div");
    viewport.className = "relationship-mindmap";
    viewport.dataset.layoutWidth = String(layout.width);
    viewport.dataset.layoutHeight = String(layout.height);
    const stage = document.createElement("div");
    stage.className = "relationship-mindmap-stage";
    viewport.append(stage);
    let viewScale = 1;
    let viewX = 0;
    let viewY = 0;
    const updateViewTransform = () => {
      stage.style.transform = `translate(${viewX}px, ${viewY}px) scale(${viewScale})`;
      viewport.dataset.graphScale = viewScale.toFixed(3);
    };
    updateViewTransform();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    marker.innerHTML = '<marker id="mind-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"></path></marker>';
    svg.append(marker);
    const relevantEdges = graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
    const edgeElements = [];
    const updateEdgeGeometry = ({ edge, path, label }) => {
      const from = positions.get(edge.source);
      const to = positions.get(edge.target);
      if (!from || !to) return;
      const curve = Math.min(layout.edgeCurve, Math.abs(from.x - to.x) * 0.12);
      path.setAttribute("d", `M ${from.x} ${from.y} Q ${(from.x + to.x) / 2} ${(from.y + to.y) / 2 - curve} ${to.x} ${to.y}`);
      if (label) {
        label.setAttribute("x", String((from.x + to.x) / 2));
        label.setAttribute("y", String((from.y + to.y) / 2 - curve - layout.labelOffset));
      }
    };
    for (const edge of relevantEdges) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.classList.add("mind-edge", edge.category);
      path.dataset.edgeSource = edge.source;
      path.dataset.edgeTarget = edge.target;
      path.style.setProperty("--edge-opacity", String(0.28 + edge.confidence * 0.48));
      path.style.setProperty("--edge-width", String(1 + edge.confidence * 1.8));
      if (edge.confirmationStatus === "pending") path.classList.add("is-pending");
      if (edge.directed) path.setAttribute("marker-end", "url(#mind-arrow)");
      svg.append(path);
      let label = null;
      if (edge.source === selectedId || edge.target === selectedId) {
        label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("text-anchor", "middle");
        label.classList.add("mind-edge-label");
        const fullLabel = formatRelationshipLabel(edge);
        label.textContent = fullLabel;
        label.dataset.fullLabel = fullLabel;
        svg.append(label);
      }
      const edgeElement = { edge, path, label };
      edgeElements.push(edgeElement);
      updateEdgeGeometry(edgeElement);
    }
    stage.append(svg);
    const edgeDetail = document.createElement("div");
    edgeDetail.className = "mind-edge-detail hidden";
    edgeDetail.setAttribute("aria-live", "polite");
    viewport.append(edgeDetail);
    const updateHighlight = (nodeId, locked = false) => {
      const related = new Set([nodeId]);
      for (const edge of graph.edges) if (edge.source === nodeId || edge.target === nodeId) {
        related.add(edge.source);
        related.add(edge.target);
      }
      viewport.querySelectorAll(".mind-node").forEach((node) => node.classList.toggle("is-dimmed", locked && !related.has(node.dataset.nodeId)));
      viewport.querySelectorAll(".mind-edge").forEach((edge) => {
        const active = edge.dataset.edgeSource === nodeId || edge.dataset.edgeTarget === nodeId;
        edge.classList.toggle("is-dimmed", locked && !active);
        edge.classList.toggle("is-highlighted", locked && active);
      });
      const focusedEdges = locked && nodeId !== selectedId
        ? relevantEdges.filter((edge) => (edge.source === selectedId && edge.target === nodeId) || (edge.target === selectedId && edge.source === nodeId))
        : [];
      if (focusedEdges.length) {
        const selectedName = graph.nodeById.get(selectedId)?.name ?? "当前角色";
        const focusedName = graph.nodeById.get(nodeId)?.name ?? "关联角色";
        const heading = document.createElement("b");
        heading.textContent = `${selectedName}与${focusedName}`;
        const detailText = document.createElement("span");
        detailText.textContent = focusedEdges.map((edge) => formatRelationshipLabel(edge)).join("；");
        edgeDetail.replaceChildren(heading, detailText);
        edgeDetail.classList.remove("hidden");
      } else {
        edgeDetail.classList.add("hidden");
        edgeDetail.replaceChildren();
      }
    };
    for (const node of visibleNodes.filter(Boolean)) {
      const position = positions.get(node.id);
      if (!position) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `mind-node ${node.id === selectedId ? "is-selected" : ""} ${node.locked ? "is-locked" : ""}`;
      button.dataset.nodeId = node.id;
      button.style.left = `${position.x / layout.width * 100}%`;
      button.style.top = `${position.y / layout.height * 100}%`;
      button.textContent = node.name;
      button.title = [node.identity, node.aliases.length ? `别名：${node.aliases.join("、")}` : "", `${node.degree} 条关系`].filter(Boolean).join("\n");
      button.setAttribute("aria-label", `${node.name}，${node.degree} 条关系${node.aliases.length ? `，别名 ${node.aliases.join("、")}` : ""}`);
      button.setAttribute("aria-grabbed", "false");
      button.addEventListener("mouseenter", () => updateHighlight(node.id, true));
      button.addEventListener("mouseleave", () => updateHighlight(selectedId, false));
      button.addEventListener("focus", () => updateHighlight(node.id, true));
      let dragState = null;
      let suppressClick = false;
      button.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        const rect = viewport.getBoundingClientRect();
        dragState = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, rect, dragged: false };
        button.setPointerCapture(event.pointerId);
        button.classList.add("is-dragging");
        button.setAttribute("aria-grabbed", "true");
      });
      button.addEventListener("pointermove", (event) => {
        if (!dragState || event.pointerId !== dragState.pointerId) return;
        if (Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY) >= 3) dragState.dragged = true;
        if (!dragState.dragged) return;
        event.preventDefault();
        const position = {
          x: clamp(((event.clientX - dragState.rect.left - viewX) / viewScale) / Math.max(dragState.rect.width, 1) * layout.width, layout.marginX, layout.width - layout.marginX),
          y: clamp(((event.clientY - dragState.rect.top - viewY) / viewScale) / Math.max(dragState.rect.height, 1) * layout.height, layout.marginY, layout.height - layout.marginY),
          depth: positions.get(node.id)?.depth ?? 1
        };
        positions.set(node.id, position);
        manualPositions.set(node.id, position);
        button.style.left = `${position.x / layout.width * 100}%`;
        button.style.top = `${position.y / layout.height * 100}%`;
        viewport.dataset.draggedNodeId = node.id;
        edgeElements.forEach(updateEdgeGeometry);
      });
      const endDrag = (event) => {
        if (!dragState || event.pointerId !== dragState.pointerId) return;
        suppressClick = dragState.dragged;
        dragState = null;
        button.classList.remove("is-dragging");
        button.setAttribute("aria-grabbed", "false");
        if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
      };
      button.addEventListener("pointerup", endDrag);
      button.addEventListener("pointercancel", endDrag);
      button.addEventListener("click", () => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        selectedId = node.id;
        options.onSelect?.(node.id);
        render();
      });
      stage.append(button);
    }
    if (graph.nodes.length > visibleNodes.length) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "mindmap-more";
      more.textContent = `还有 ${graph.nodes.length - visibleNodes.length} 位角色，进入全屏查看`;
      more.addEventListener("click", () => options.onOpenGalaxy?.());
      viewport.append(more);
    }
    if (options.expanded) viewport.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const nextScale = clamp(viewScale * (event.deltaY > 0 ? 0.9 : 1.1), 0.5, 2.5);
      const ratio = nextScale / viewScale;
      viewX = pointerX - (pointerX - viewX) * ratio;
      viewY = pointerY - (pointerY - viewY) * ratio;
      viewScale = nextScale;
      updateViewTransform();
    }, { passive: false });
    shell.append(toolbar, viewport);
    container.append(shell);
  };
  render();
  return { destroy() { container.replaceChildren(); } };
}

export function layoutGalaxy(graph, seed) {
  const random = seededRandom(hashString(seed));
  const nodes = graph.nodes.map((node, index) => {
    const angle = random() * Math.PI * 2;
    const radius = 105 + Math.sqrt(random()) * 470;
    const thickness = 18 + radius * 0.12;
    return {
      ...node,
      x: Math.cos(angle) * radius,
      y: (random() - 0.5) * thickness,
      z: Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      vz: 0,
      index
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const exactRepulsion = nodes.length <= 180;
  const iterations = exactRepulsion ? 130 : 82;
  const applyRepulsion = (left, right) => {
        let dx = right.x - left.x;
        let dz = right.z - left.z;
        const distanceSquared = Math.max(80, dx * dx + dz * dz);
        const force = 2600 / distanceSquared;
        const distance = Math.sqrt(distanceSquared);
        dx /= distance;
        dz /= distance;
        left.vx -= dx * force;
        left.vz -= dz * force;
        right.vx += dx * force;
        right.vz += dz * force;
  };
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const cooling = 1 - iteration / (iterations + 20);
    if (exactRepulsion) {
      for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
        const left = nodes[leftIndex];
        for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
          applyRepulsion(left, nodes[rightIndex]);
        }
      }
    } else {
      const sampleCount = Math.min(28, nodes.length - 1);
      const stride = 17 + iteration % 11;
      for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
        const left = nodes[leftIndex];
        for (let sample = 1; sample <= sampleCount; sample += 1) {
          const rightIndex = (leftIndex + sample * stride) % nodes.length;
          if (rightIndex !== leftIndex) applyRepulsion(left, nodes[rightIndex]);
        }
      }
    }
    for (const edge of graph.edges) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (!source || !target) continue;
      const dx = target.x - source.x;
      const dz = target.z - source.z;
      const distance = Math.max(1, Math.hypot(dx, dz));
      const force = (distance - 125) * 0.0028 * (0.5 + edge.confidence);
      source.vx += dx / distance * force;
      source.vz += dz / distance * force;
      target.vx -= dx / distance * force;
      target.vz -= dz / distance * force;
    }
    for (const node of nodes) {
      const centrality = clamp(node.importance / Math.max(graph.nodes[0]?.importance || 1, 1), 0, 1);
      node.vx += -node.x * (0.0008 + centrality * 0.0018);
      node.vy += -node.y * 0.0014;
      node.vz += -node.z * (0.0008 + centrality * 0.0018);
      node.vx *= 0.84;
      node.vy *= 0.84;
      node.vz *= 0.84;
      node.x += node.vx * cooling;
      node.y += node.vy * cooling;
      node.z += node.vz * cooling;
    }
  }
  return { nodes, byId };
}

export function createGalaxyStarfield(seed, count = 3600) {
  const random = seededRandom(hashString(seed));
  const stars = [];
  const armCount = 4;
  for (let index = 0; index < count; index += 1) {
    const radius = 55 + Math.pow(random(), 0.62) * 1120;
    const arm = index % armCount;
    const armAngle = arm / armCount * Math.PI * 2;
    const angle = armAngle + radius * 0.0065 + (random() - 0.5) * (0.42 + radius / 1100);
    const thickness = 22 + radius * 0.105;
    stars.push({
      x: Math.cos(angle) * radius + (random() - 0.5) * 62,
      y: (random() + random() + random() - 1.5) * thickness,
      z: Math.sin(angle) * radius + (random() - 0.5) * 62,
      size: random() > 0.965 ? 1.7 + random() * 1.4 : 0.45 + random() * 0.85,
      brightness: 0.22 + random() * 0.78
    });
  }
  return stars;
}

export function projectGalaxyPoint(point, camera, viewport) {
  const relativeX = point.x - Number(camera.targetX ?? 0);
  const relativeY = point.y - Number(camera.targetY ?? 0);
  const relativeZ = point.z - Number(camera.targetZ ?? 0);
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const cameraX = relativeX * cosYaw - relativeZ * sinYaw;
  const yawedZ = relativeX * sinYaw + relativeZ * cosYaw;
  const cameraY = relativeY * cosPitch - yawedZ * sinPitch;
  const cameraZ = relativeY * sinPitch + yawedZ * cosPitch;
  const depth = camera.distance + cameraZ;
  const focalLength = Math.min(viewport.width, viewport.height) * camera.focalRatio;
  const scale = depth > 1 ? focalLength / depth * camera.zoom : 0;
  return {
    x: viewport.width / 2 + cameraX * scale,
    y: viewport.height / 2 + cameraY * scale,
    depth,
    scale,
    visible: depth > 80
  };
}

export function getGalaxyNodeFocusCamera(node, camera) {
  return {
    targetX: Number(node?.x ?? 0),
    targetY: Number(node?.y ?? 0),
    targetZ: Number(node?.z ?? 0),
    distance: Math.min(Number(camera?.distance ?? 1420), 940),
    zoom: Math.max(Number(camera?.zoom ?? 1), 1.65)
  };
}

export function getGalaxyNodeAppearance(node, maxDegree) {
  const degree = Math.max(0, Number(node?.degree) || 0);
  const normalizedDegree = clamp(degree / Math.max(1, Number(maxDegree) || 1), 0, 1);
  const weightedDegree = Math.max(0, Number(node?.weightedDegree) || 0);
  const confidenceBoost = clamp(weightedDegree / Math.max(1, degree) / 1.35, 0, 1);
  const intensity = clamp(normalizedDegree * 0.8 + confidenceBoost * 0.2, 0, 1);
  const hue = Math.round(218 - intensity * 166);
  const saturation = Math.round(58 + intensity * 35);
  const lightness = Math.round(47 + intensity * 27);
  const brightness = (0.7 + intensity * 0.68).toFixed(3);
  const glow = (0.26 + intensity * 0.74).toFixed(3);
  const tier = intensity >= 0.7 ? "core" : intensity >= 0.34 ? "active" : "outer";
  return {
    degree,
    intensity,
    hue,
    saturation,
    lightness,
    brightness,
    glow,
    tier,
    color: `hsl(${hue} ${saturation}% ${lightness}%)`
  };
}

export function createGalaxyRenderer(dialog, graph, options = {}) {
  const background = dialog.querySelector("#galaxy-background");
  const canvas = dialog.querySelector("#galaxy-graph");
  const nodeLayer = dialog.querySelector("#galaxy-node-layer");
  const stats = dialog.querySelector("#galaxy-stats");
  const detail = dialog.querySelector("#galaxy-detail");
  const shell = dialog.querySelector(".galaxy-shell");
  const seed = `${options.workId ?? "work"}|${graph.nodes.map((node) => node.id).join("|")}|${graph.edges.length}`;
  const layout = layoutGalaxy(graph, seed);
  const stars = createGalaxyStarfield(`${seed}|stars`);
  const initialNodePositions = new Map(layout.nodes.map((node) => [node.id, { x: node.x, y: node.y, z: node.z }]));
  const initialCamera = Object.freeze({ yaw: -0.38, pitch: 0.72, distance: 1420, focalRatio: 1.72, zoom: 1, targetX: 0, targetY: 0, targetZ: 0 });
  const camera = { ...initialCamera };
  const nodeElements = new Map();
  const cleanups = [];
  let selectedId = null;
  let cameraDrag = null;
  let animationFrame = 0;
  let previousFrameTime = 0;
  let cameraFocus = null;
  let paused = false;
  let starsVisible = true;
  let destroyed = false;

  shell.classList.add("is-three-dimensional");
  shell.dataset.sceneDimension = "3";
  shell.dataset.starCount = String(stars.length);

  const listen = (target, type, handler, settings) => {
    target.addEventListener(type, handler, settings);
    cleanups.push(() => target.removeEventListener(type, handler, settings));
  };

  const resizeCanvas = (target) => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const rect = shell.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (target.width !== pixelWidth) target.width = pixelWidth;
    if (target.height !== pixelHeight) target.height = pixelHeight;
    if (target.style.width !== `${width}px`) target.style.width = `${width}px`;
    if (target.style.height !== `${height}px`) target.style.height = `${height}px`;
    const context = target.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { context, width, height };
  };

  const project = (point, width, height) => projectGalaxyPoint(point, camera, { width, height });

  const drawBackground = () => {
    const { context, width, height } = resizeCanvas(background);
    context.clearRect(0, 0, width, height);
    const backdrop = context.createRadialGradient(width * 0.53, height * 0.48, 0, width * 0.53, height * 0.48, Math.max(width, height) * 0.78);
    backdrop.addColorStop(0, "#0b1830");
    backdrop.addColorStop(0.36, "#07101f");
    backdrop.addColorStop(0.72, "#03070e");
    backdrop.addColorStop(1, "#010205");
    context.fillStyle = backdrop;
    context.fillRect(0, 0, width, height);

    context.lineWidth = 1;
    context.strokeStyle = "rgba(105,142,182,.06)";
    for (let offset = -1200; offset <= 1200; offset += 160) {
      const horizontalStart = project({ x: -1200, y: 0, z: offset }, width, height);
      const horizontalEnd = project({ x: 1200, y: 0, z: offset }, width, height);
      const verticalStart = project({ x: offset, y: 0, z: -1200 }, width, height);
      const verticalEnd = project({ x: offset, y: 0, z: 1200 }, width, height);
      if (horizontalStart.visible && horizontalEnd.visible) {
        context.beginPath();
        context.moveTo(horizontalStart.x, horizontalStart.y);
        context.lineTo(horizontalEnd.x, horizontalEnd.y);
        context.stroke();
      }
      if (verticalStart.visible && verticalEnd.visible) {
        context.beginPath();
        context.moveTo(verticalStart.x, verticalStart.y);
        context.lineTo(verticalEnd.x, verticalEnd.y);
        context.stroke();
      }
    }

    const center = project({ x: 0, y: 0, z: 0 }, width, height);
    const coreRadius = Math.min(width, height) * 0.28 * camera.zoom;
    const core = context.createRadialGradient(center.x, center.y, 0, center.x, center.y, coreRadius);
    core.addColorStop(0, "rgba(235,247,255,.22)");
    core.addColorStop(0.12, "rgba(100,166,230,.14)");
    core.addColorStop(0.42, "rgba(52,160,126,.06)");
    core.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = core;
    context.fillRect(0, 0, width, height);

    if (!starsVisible) return;
    context.save();
    context.globalCompositeOperation = "lighter";
    for (let index = 0; index < stars.length; index += 1) {
      const star = stars[index];
      const point = project(star, width, height);
      if (!point.visible || point.x < -8 || point.x > width + 8 || point.y < -8 || point.y > height + 8) continue;
      const perspective = clamp(point.scale / 0.95, 0.32, 2.4);
      const radius = star.size * perspective;
      const twinkle = 0.82 + Math.sin(index * 12.9898 + camera.yaw * 5) * 0.18;
      const alpha = clamp(star.brightness * twinkle * perspective, 0.08, 0.92);
      context.fillStyle = `rgba(216,235,255,${alpha})`;
      context.beginPath();
      context.arc(point.x, point.y, Math.max(0.28, radius), 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  };

  const drawGraph = () => {
    if (destroyed || !dialog.open) return;
    const { context, width, height } = resizeCanvas(canvas);
    context.clearRect(0, 0, width, height);
    const projections = new Map(layout.nodes.map((node) => [node.id, project(node, width, height)]));
    const relatedIds = new Set(selectedId ? [selectedId] : []);
    if (selectedId) {
      for (const edge of graph.edges) {
        if (edge.source === selectedId || edge.target === selectedId) {
          relatedIds.add(edge.source);
          relatedIds.add(edge.target);
        }
      }
    }

    const highlightedKeywords = [];
    const orderedEdges = graph.edges.map((edge) => ({
      edge,
      depth: ((projections.get(edge.source)?.depth ?? 0) + (projections.get(edge.target)?.depth ?? 0)) / 2
    })).sort((left, right) => right.depth - left.depth);
    for (const { edge } of orderedEdges) {
      const from = projections.get(edge.source);
      const to = projections.get(edge.target);
      if (!from?.visible || !to?.visible) continue;
      const highlighted = Boolean(selectedId) && (edge.source === selectedId || edge.target === selectedId);
      const dimmed = Boolean(selectedId) && !highlighted;
      const depthFactor = clamp((from.scale + to.scale) / 1.9, 0.25, 1.6);
      const opacity = dimmed ? 0.025 : highlighted ? 0.9 : (0.08 + edge.confidence * 0.22) * depthFactor;
      const alpha = Math.round(clamp(opacity, 0, 1) * 255).toString(16).padStart(2, "0");
      const edgeColor = `${RELATION_STYLE[edge.category].color}${alpha}`;
      context.strokeStyle = edgeColor;
      context.lineWidth = (highlighted ? 2.1 : 0.55 + edge.confidence) * clamp(depthFactor, 0.55, 1.45);
      context.setLineDash(edge.confirmationStatus === "pending" || edge.category === "uncertain" ? [5, 6] : []);
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
      if (edge.directed) {
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        const arrowSize = 6 * clamp(depthFactor, 0.7, 1.5);
        context.fillStyle = edgeColor;
        context.beginPath();
        context.moveTo(to.x, to.y);
        context.lineTo(to.x - Math.cos(angle - 0.45) * arrowSize, to.y - Math.sin(angle - 0.45) * arrowSize);
        context.lineTo(to.x - Math.cos(angle + 0.45) * arrowSize, to.y - Math.sin(angle + 0.45) * arrowSize);
        context.fill();
      }
      if (highlighted) {
        const fullLabel = formatRelationshipLabel(edge);
        highlightedKeywords.push(fullLabel);
        const label = fullLabel.length > 42 ? `${fullLabel.slice(0, 41)}…` : fullLabel;
        const x = (from.x + to.x) / 2;
        const y = (from.y + to.y) / 2 - 9;
        context.setLineDash([]);
        context.font = '10px "SFMono-Regular", "SF Mono", Menlo, Monaco, monospace';
        context.textAlign = "center";
        context.textBaseline = "middle";
        const labelWidth = Math.min(300, context.measureText(label).width + 14);
        context.fillStyle = "rgba(3,7,14,.86)";
        context.fillRect(x - labelWidth / 2, y - 9, labelWidth, 18);
        context.fillStyle = "rgba(238,246,255,.96)";
        context.fillText(label, x, y, labelWidth - 8);
      }
    }
    context.setLineDash([]);

    const baseScale = Math.min(width, height) * camera.focalRatio / camera.distance * camera.zoom;
    for (const node of layout.nodes) {
      const point = projections.get(node.id);
      const element = nodeElements.get(node.id);
      if (!element || !point) continue;
      const perspective = clamp(point.scale / Math.max(baseScale, 0.01), 0.5, 1.8);
      const selectedScale = node.id === selectedId ? clamp(camera.zoom, 1, 1.8) : 1;
      element.hidden = !point.visible;
      element.style.transform = `translate3d(${point.x}px, ${point.y}px, 0) translate(-50%, -50%) scale(${perspective * selectedScale})`;
      element.style.zIndex = String(10000 - Math.round(point.depth));
      element.style.setProperty("--depth-opacity", String(clamp(1.45 - point.depth / 2300, 0.38, 1)));
      element.dataset.worldX = node.x.toFixed(2);
      element.dataset.worldY = node.y.toFixed(2);
      element.dataset.worldZ = node.z.toFixed(2);
      element.dataset.projectedDepth = point.depth.toFixed(2);
      element.dataset.projectedScale = point.scale.toFixed(4);
      element.classList.toggle("is-selected", node.id === selectedId);
      element.classList.toggle("is-related", Boolean(selectedId) && node.id !== selectedId && relatedIds.has(node.id));
      element.classList.toggle("is-dimmed", Boolean(selectedId) && !relatedIds.has(node.id));
      element.classList.toggle("show-label", node.index < 26 || relatedIds.has(node.id) || camera.zoom > 1.35);
    }
    shell.dataset.selectedNodeId = selectedId ?? "";
    shell.dataset.highlightedKeywords = [...new Set(highlightedKeywords)].join("|");
    shell.dataset.cameraYaw = camera.yaw.toFixed(5);
    shell.dataset.cameraPitch = camera.pitch.toFixed(5);
    shell.dataset.cameraDistance = camera.distance.toFixed(1);
    shell.dataset.graphScale = camera.zoom.toFixed(3);
    shell.dataset.cameraTarget = [camera.targetX, camera.targetY, camera.targetZ].map((value) => value.toFixed(2)).join(",");
  };

  const drawScene = () => {
    drawBackground();
    drawGraph();
  };

  const renderFrame = (time) => {
    animationFrame = 0;
    if (destroyed || !dialog.open) return;
    const elapsed = previousFrameTime ? Math.min(50, time - previousFrameTime) : 0;
    previousFrameTime = time;
    if (cameraFocus) {
      const progress = clamp((time - cameraFocus.startedAt) / cameraFocus.duration, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      for (const key of ["targetX", "targetY", "targetZ", "distance", "zoom"]) {
        camera[key] = cameraFocus.from[key] + (cameraFocus.to[key] - cameraFocus.from[key]) * eased;
      }
      if (progress >= 1) {
        cameraFocus = null;
        shell.classList.remove("is-focusing-node");
      }
    }
    if (!paused && !cameraDrag) camera.yaw += elapsed * 0.000045;
    drawScene();
    animationFrame = window.requestAnimationFrame(renderFrame);
  };

  const startAnimation = () => {
    if (animationFrame || destroyed) return;
    previousFrameTime = 0;
    animationFrame = window.requestAnimationFrame(renderFrame);
  };

  const cancelCameraFocus = () => {
    cameraFocus = null;
    shell.classList.remove("is-focusing-node");
  };

  const focusCameraOnNode = (node) => {
    const target = getGalaxyNodeFocusCamera(node, camera);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    shell.dataset.focusedNodeId = node.id;
    if (reducedMotion) {
      Object.assign(camera, target);
      drawScene();
      return;
    }
    cameraFocus = {
      from: Object.fromEntries(["targetX", "targetY", "targetZ", "distance", "zoom"].map((key) => [key, camera[key]])),
      to: target,
      startedAt: performance.now(),
      duration: 650
    };
    shell.classList.add("is-focusing-node");
    startAnimation();
  };

  const renderDetail = (node) => {
    const relations = graph.edges.filter((edge) => edge.source === node.id || edge.target === node.id);
    detail.classList.remove("hidden");
    detail.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = node.name;
    detail.append(heading);
    if (node.aliases.length) {
      const aliases = document.createElement("small");
      aliases.textContent = `别名：${node.aliases.join("、")}`;
      detail.append(aliases);
    }
    if (node.identity) {
      const identity = document.createElement("p");
      identity.textContent = node.identity;
      detail.append(identity);
    }
    const list = document.createElement("ul");
    for (const edge of relations.slice(0, 12)) {
      const other = graph.nodeById.get(edge.source === node.id ? edge.target : edge.source);
      const item = document.createElement("li");
      const category = document.createElement("i");
      category.className = edge.category;
      item.append(category, document.createTextNode(`${other?.name ?? "未知角色"} · ${formatRelationshipLabel(edge)}`));
      list.append(item);
    }
    detail.append(list);
  };

  const renderNodes = () => {
    nodeLayer.replaceChildren();
    nodeElements.clear();
    const maxDegree = Math.max(...layout.nodes.map((node) => node.degree), 1);
    for (const node of layout.nodes) {
      const appearance = getGalaxyNodeAppearance(node, maxDegree);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "galaxy-node";
      button.dataset.galaxyNode = node.id;
      button.dataset.relationshipTier = appearance.tier;
      button.style.setProperty("--node-size", `${10 + Math.sqrt(node.degree / maxDegree) * 28}px`);
      button.style.setProperty("--node-color", appearance.color);
      button.style.setProperty("--node-brightness", appearance.brightness);
      button.style.setProperty("--node-glow", appearance.glow);
      const marker = document.createElement("i");
      const label = document.createElement("span");
      label.textContent = node.name;
      button.append(marker, label);
      button.title = `${node.degree} 条关系 · ${appearance.tier === "core" ? "核心高亮" : appearance.tier === "active" ? "活跃连接" : "外围连接"}`;
      button.setAttribute("aria-label", `${node.name}，${node.degree} 条关系，${appearance.tier === "core" ? "核心高亮" : appearance.tier === "active" ? "活跃连接" : "外围连接"}${node.aliases.length ? `，别名 ${node.aliases.join("、")}` : ""}`);
      button.setAttribute("aria-grabbed", "false");
      let nodeDrag = null;
      let suppressClick = false;
      listen(button, "pointerdown", (event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        cancelCameraFocus();
        nodeDrag = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          originX: node.x,
          originY: node.y,
          originZ: node.z,
          yaw: camera.yaw,
          pitch: camera.pitch,
          scale: Number(button.dataset.projectedScale) || 1,
          dragged: false
        };
        button.setPointerCapture(event.pointerId);
        button.classList.add("is-dragging");
        button.setAttribute("aria-grabbed", "true");
      });
      listen(button, "pointermove", (event) => {
        if (!nodeDrag || event.pointerId !== nodeDrag.pointerId) return;
        const deltaX = event.clientX - nodeDrag.startX;
        const deltaY = event.clientY - nodeDrag.startY;
        if (Math.hypot(deltaX, deltaY) >= 3) nodeDrag.dragged = true;
        if (!nodeDrag.dragged) return;
        event.preventDefault();
        const worldX = deltaX / Math.max(nodeDrag.scale, 0.16);
        const worldY = deltaY / Math.max(nodeDrag.scale, 0.16);
        const cosYaw = Math.cos(nodeDrag.yaw);
        const sinYaw = Math.sin(nodeDrag.yaw);
        const cosPitch = Math.cos(nodeDrag.pitch);
        const sinPitch = Math.sin(nodeDrag.pitch);
        node.x = nodeDrag.originX + worldX * cosYaw - worldY * sinYaw * sinPitch;
        node.y = nodeDrag.originY + worldY * cosPitch;
        node.z = nodeDrag.originZ - worldX * sinYaw - worldY * cosYaw * sinPitch;
        shell.dataset.draggedNodeId = node.id;
        drawScene();
      });
      const endNodeDrag = (event) => {
        if (!nodeDrag || event.pointerId !== nodeDrag.pointerId) return;
        suppressClick = nodeDrag.dragged;
        nodeDrag = null;
        button.classList.remove("is-dragging");
        button.setAttribute("aria-grabbed", "false");
        if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
      };
      listen(button, "pointerup", endNodeDrag);
      listen(button, "pointercancel", endNodeDrag);
      listen(button, "click", () => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        selectedId = node.id;
        renderDetail(node);
        focusCameraOnNode(node);
        drawScene();
      });
      nodeElements.set(node.id, button);
      nodeLayer.append(button);
    }
  };

  const reset = () => {
    cancelCameraFocus();
    Object.assign(camera, initialCamera);
    for (const node of layout.nodes) Object.assign(node, initialNodePositions.get(node.id));
    selectedId = null;
    delete shell.dataset.focusedNodeId;
    delete shell.dataset.draggedNodeId;
    detail.classList.add("hidden");
    detail.replaceChildren();
    drawScene();
  };

  const zoom = (factor) => {
    cancelCameraFocus();
    camera.zoom = clamp(camera.zoom * factor, 0.45, 2.8);
    drawScene();
  };

  const updateRotationControl = () => {
    shell.classList.toggle("is-paused", paused);
    const control = dialog.querySelector("#galaxy-rotation");
    control.setAttribute("aria-pressed", String(paused));
    control.textContent = paused ? "继续旋转" : "暂停旋转";
  };

  const open = () => {
    if (!dialog.open) dialog.showModal();
    paused = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    starsVisible = true;
    background.classList.remove("hidden-stars");
    dialog.querySelector("#galaxy-stars").setAttribute("aria-pressed", "true");
    dialog.querySelector("#galaxy-stars").textContent = "隐藏背景星点";
    updateRotationControl();
    stats.value = `${graph.stats.nodeCount} 个节点 / ${graph.stats.edgeCount} 条关系`;
    renderNodes();
    drawScene();
    startAnimation();
    dialog.querySelector("#galaxy-close").focus();
  };

  const close = () => {
    if (dialog.open) dialog.close();
  };

  listen(dialog.querySelector("#galaxy-close"), "click", close);
  listen(dialog.querySelector("#galaxy-reset"), "click", reset);
  listen(dialog.querySelector("#galaxy-zoom-in"), "click", () => zoom(1.18));
  listen(dialog.querySelector("#galaxy-zoom-out"), "click", () => zoom(1 / 1.18));
  listen(dialog.querySelector("#galaxy-stars"), "click", (event) => {
    starsVisible = !starsVisible;
    background.classList.toggle("hidden-stars", !starsVisible);
    event.currentTarget.setAttribute("aria-pressed", String(starsVisible));
    event.currentTarget.textContent = starsVisible ? "隐藏背景星点" : "显示背景星点";
    drawScene();
  });
  listen(dialog.querySelector("#galaxy-rotation"), "click", () => {
    paused = !paused;
    updateRotationControl();
  });
  listen(shell, "wheel", (event) => {
    event.preventDefault();
    zoom(event.deltaY > 0 ? 0.9 : 1.1);
  }, { passive: false });
  listen(shell, "pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button, aside")) return;
    cancelCameraFocus();
    cameraDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, yaw: camera.yaw, pitch: camera.pitch };
    shell.classList.add("is-rotating-camera");
    shell.setPointerCapture(event.pointerId);
  });
  listen(shell, "pointermove", (event) => {
    if (!cameraDrag || event.pointerId !== cameraDrag.pointerId) return;
    camera.yaw = cameraDrag.yaw + (event.clientX - cameraDrag.x) * 0.006;
    camera.pitch = clamp(cameraDrag.pitch + (event.clientY - cameraDrag.y) * 0.004, 0.16, 1.38);
    drawScene();
  });
  const endCameraDrag = (event) => {
    if (!cameraDrag || event.pointerId !== cameraDrag.pointerId) return;
    cameraDrag = null;
    shell.classList.remove("is-rotating-camera");
    if (shell.hasPointerCapture(event.pointerId)) shell.releasePointerCapture(event.pointerId);
  };
  listen(shell, "pointerup", endCameraDrag);
  listen(shell, "pointercancel", endCameraDrag);
  listen(window, "resize", () => {
    if (dialog.open) drawScene();
  });
  listen(dialog, "close", () => {
    if (animationFrame) window.cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    previousFrameTime = 0;
    options.onClose?.();
  });

  return {
    open,
    close,
    reset,
    destroy() {
      destroyed = true;
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      cleanups.splice(0).forEach((cleanup) => cleanup());
      if (dialog.open) dialog.close();
      nodeElements.clear();
      nodeLayer.replaceChildren();
      shell.classList.remove("is-three-dimensional", "is-rotating-camera", "is-paused");
    }
  };
}
