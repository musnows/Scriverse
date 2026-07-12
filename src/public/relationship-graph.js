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
        label.textContent = edge.subtype;
        const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.textContent = edge.keywords.length ? edge.keywords.join(" · ") : edge.subtype;
        label.append(title);
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
        detailText.textContent = focusedEdges.map((edge) => edge.keywords.length ? edge.keywords.join(" · ") : edge.subtype).join("；");
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
    const radius = 80 + Math.sqrt(random()) * 330;
    return { ...node, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * 0.52, vx: 0, vy: 0, index };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const exactRepulsion = nodes.length <= 180;
  const iterations = exactRepulsion ? 130 : 82;
  const applyRepulsion = (left, right) => {
        let dx = right.x - left.x;
        let dy = right.y - left.y;
        const distanceSquared = Math.max(80, dx * dx + dy * dy);
        const force = 2600 / distanceSquared;
        const distance = Math.sqrt(distanceSquared);
        dx /= distance;
        dy /= distance;
        left.vx -= dx * force;
        left.vy -= dy * force;
        right.vx += dx * force;
        right.vy += dy * force;
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
      const dy = target.y - source.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - 125) * 0.0028 * (0.5 + edge.confidence);
      source.vx += dx / distance * force;
      source.vy += dy / distance * force;
      target.vx -= dx / distance * force;
      target.vy -= dy / distance * force;
    }
    for (const node of nodes) {
      const centrality = clamp(node.importance / Math.max(graph.nodes[0]?.importance || 1, 1), 0, 1);
      node.vx += -node.x * (0.0008 + centrality * 0.0018);
      node.vy += -node.y * (0.0016 + centrality * 0.0025);
      node.vx *= 0.84;
      node.vy *= 0.84;
      node.x += node.vx * cooling;
      node.y += node.vy * cooling;
    }
  }
  return { nodes, byId };
}

export function createGalaxyRenderer(dialog, graph, options = {}) {
  const background = dialog.querySelector("#galaxy-background");
  const canvas = dialog.querySelector("#galaxy-graph");
  const nodeLayer = dialog.querySelector("#galaxy-node-layer");
  const stats = dialog.querySelector("#galaxy-stats");
  const detail = dialog.querySelector("#galaxy-detail");
  const shell = dialog.querySelector(".galaxy-shell");
  const layout = layoutGalaxy(graph, `${options.workId ?? "work"}|${graph.nodes.map((node) => node.id).join("|")}|${graph.edges.length}`);
  const initialNodePositions = new Map(layout.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
  let transform = { x: 0, y: 0, scale: 1 };
  let selectedId = null;
  let drag = null;
  let destroyed = false;
  const nodeElements = new Map();
  const cleanups = [];
  const listen = (target, type, handler, settings) => {
    target.addEventListener(type, handler, settings);
    cleanups.push(() => target.removeEventListener(type, handler, settings));
  };
  const resizeCanvas = (target) => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const rect = shell.getBoundingClientRect();
    const pixelWidth = Math.max(1, Math.round(rect.width * ratio));
    const pixelHeight = Math.max(1, Math.round(rect.height * ratio));
    if (target.width !== pixelWidth) target.width = pixelWidth;
    if (target.height !== pixelHeight) target.height = pixelHeight;
    if (target.style.width !== `${rect.width}px`) target.style.width = `${rect.width}px`;
    if (target.style.height !== `${rect.height}px`) target.style.height = `${rect.height}px`;
    const context = target.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { context, width: rect.width, height: rect.height, ratio };
  };
  const drawBackground = () => {
    const { context, width, height } = resizeCanvas(background);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#05070d";
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "rgba(120,145,180,.045)";
    context.lineWidth = 1;
    for (let x = 0; x < width; x += 42) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke(); }
    for (let y = 0; y < height; y += 42) { context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke(); }
    const random = seededRandom(hashString(String(options.workId ?? "galaxy")));
    const centerX = width / 2;
    const centerY = height / 2;
    const stars = Math.min(3600, Math.round(width * height / 360));
    for (let index = 0; index < stars; index += 1) {
      const angle = random() * Math.PI * 2 + random() * 1.6;
      const radius = Math.pow(random(), 1.75) * Math.min(width * 0.58, 720);
      const arm = Math.sin(angle * 2 + radius * 0.025) * 34;
      const x = centerX + Math.cos(angle) * radius + (random() - 0.5) * 50;
      const y = centerY + Math.sin(angle) * radius * 0.26 + arm + (random() - 0.5) * 34;
      const alpha = 0.12 + random() * 0.68 * (1 - radius / Math.max(width, height));
      const size = random() > 0.96 ? 1.5 : 0.55 + random() * 0.75;
      context.fillStyle = `rgba(${190 + Math.round(random() * 65)},${205 + Math.round(random() * 50)},255,${alpha})`;
      context.beginPath();
      context.arc(x, y, size, 0, Math.PI * 2);
      context.fill();
    }
    const glow = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, Math.min(width, height) * 0.48);
    glow.addColorStop(0, "rgba(225,240,255,.18)");
    glow.addColorStop(0.25, "rgba(62,118,210,.09)");
    glow.addColorStop(0.62, "rgba(38,180,145,.035)");
    glow.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);
  };
  const project = (node, width, height) => ({
    x: width / 2 + transform.x + node.x * transform.scale,
    y: height / 2 + transform.y + node.y * transform.scale
  });
  const drawGraph = () => {
    if (destroyed || !dialog.open) return;
    const { context, width, height } = resizeCanvas(canvas);
    context.clearRect(0, 0, width, height);
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
    for (const edge of graph.edges) {
      const source = layout.byId.get(edge.source);
      const target = layout.byId.get(edge.target);
      if (!source || !target) continue;
      const from = project(source, width, height);
      const to = project(target, width, height);
      const highlighted = selectedId && (edge.source === selectedId || edge.target === selectedId);
      const dimmed = selectedId && !highlighted;
      const opacity = dimmed ? 0.04 : highlighted ? 0.82 : 0.12 + edge.confidence * 0.28;
      const edgeColor = `${RELATION_STYLE[edge.category].color}${Math.round(opacity * 255).toString(16).padStart(2, "0")}`;
      context.strokeStyle = edgeColor;
      context.lineWidth = highlighted ? 1.8 : 0.55 + edge.confidence;
      context.setLineDash(edge.confirmationStatus === "pending" || edge.category === "uncertain" ? [4, 5] : []);
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
      if (edge.directed) {
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        context.fillStyle = edgeColor;
        context.beginPath();
        context.moveTo(to.x, to.y);
        context.lineTo(to.x - Math.cos(angle - 0.45) * 7, to.y - Math.sin(angle - 0.45) * 7);
        context.lineTo(to.x - Math.cos(angle + 0.45) * 7, to.y - Math.sin(angle + 0.45) * 7);
        context.fill();
      }
      if (highlighted) {
        const fullLabel = edge.keywords.length ? edge.keywords.join(" · ") : edge.subtype;
        highlightedKeywords.push(fullLabel);
        const label = fullLabel.length > 42 ? `${fullLabel.slice(0, 41)}…` : fullLabel;
        const x = (from.x + to.x) / 2;
        const y = (from.y + to.y) / 2 - 8;
        context.setLineDash([]);
        context.font = '10px "SFMono-Regular", "SF Mono", Menlo, Monaco, monospace';
        context.textAlign = "center";
        context.textBaseline = "middle";
        const labelWidth = Math.min(280, context.measureText(label).width + 14);
        context.fillStyle = "rgba(5,7,13,.82)";
        context.fillRect(x - labelWidth / 2, y - 9, labelWidth, 18);
        context.fillStyle = "rgba(238,246,255,.94)";
        context.fillText(label, x, y, labelWidth - 8);
      }
    }
    context.setLineDash([]);
    for (const node of layout.nodes) {
      const point = project(node, width, height);
      const element = nodeElements.get(node.id);
      if (!element) continue;
      element.style.transform = `translate(${point.x}px, ${point.y}px) translate(-50%, -50%) scale(${clamp(transform.scale, 0.72, 1.45)})`;
      element.classList.toggle("is-selected", node.id === selectedId);
      element.classList.toggle("is-related", Boolean(selectedId) && node.id !== selectedId && relatedIds.has(node.id));
      element.classList.toggle("is-dimmed", Boolean(selectedId) && !relatedIds.has(node.id));
      element.classList.toggle("show-label", node.index < 24 || relatedIds.has(node.id) || transform.scale > 1.3);
    }
    shell.dataset.selectedNodeId = selectedId ?? "";
    shell.dataset.highlightedKeywords = [...new Set(highlightedKeywords)].join("|");
    shell.dataset.graphScale = transform.scale.toFixed(3);
    shell.dataset.graphX = transform.x.toFixed(1);
    shell.dataset.graphY = transform.y.toFixed(1);
  };
  const renderNodes = () => {
    nodeLayer.replaceChildren();
    nodeElements.clear();
    const maxDegree = Math.max(...layout.nodes.map((node) => node.degree), 1);
    for (const node of layout.nodes) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "galaxy-node";
      button.dataset.galaxyNode = node.id;
      button.style.setProperty("--node-size", `${10 + Math.sqrt(node.degree / maxDegree) * 28}px`);
      const marker = document.createElement("i");
      const label = document.createElement("span");
      label.textContent = node.name;
      button.append(marker, label);
      button.setAttribute("aria-label", `${node.name}，${node.degree} 条关系${node.aliases.length ? `，别名 ${node.aliases.join("、")}` : ""}`);
      button.setAttribute("aria-grabbed", "false");
      let nodeDrag = null;
      let suppressClick = false;
      listen(button, "pointerdown", (event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        nodeDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: node.x, originY: node.y, dragged: false };
        button.setPointerCapture(event.pointerId);
        button.classList.add("is-dragging");
        button.setAttribute("aria-grabbed", "true");
      });
      listen(button, "pointermove", (event) => {
        if (!nodeDrag || event.pointerId !== nodeDrag.pointerId) return;
        if (Math.hypot(event.clientX - nodeDrag.startX, event.clientY - nodeDrag.startY) >= 3) nodeDrag.dragged = true;
        if (!nodeDrag.dragged) return;
        event.preventDefault();
        node.x = nodeDrag.originX + (event.clientX - nodeDrag.startX) / transform.scale;
        node.y = nodeDrag.originY + (event.clientY - nodeDrag.startY) / transform.scale;
        shell.dataset.draggedNodeId = node.id;
        drawGraph();
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
          const keywords = edge.keywords.length ? ` · ${edge.keywords.join("、")}` : "";
          item.append(category, document.createTextNode(`${other?.name ?? "未知角色"} · ${edge.subtype}${keywords}`));
          list.append(item);
        }
        detail.append(list);
        drawGraph();
      });
      nodeElements.set(node.id, button);
      nodeLayer.append(button);
    }
  };
  const reset = () => {
    transform = { x: 0, y: 0, scale: 1 };
    for (const node of layout.nodes) Object.assign(node, initialNodePositions.get(node.id));
    selectedId = null;
    delete shell.dataset.draggedNodeId;
    detail.classList.add("hidden");
    detail.replaceChildren();
    drawGraph();
  };
  const zoom = (factor) => { transform.scale = clamp(transform.scale * factor, 0.5, 3); drawGraph(); };
  const open = () => {
    if (!dialog.open) dialog.showModal();
    shell.classList.toggle("is-paused", window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    dialog.querySelector("#galaxy-rotation").textContent = shell.classList.contains("is-paused") ? "继续旋转" : "暂停旋转";
    stats.value = `${graph.stats.nodeCount} 个角色 / ${graph.stats.edgeCount} 条关系`;
    renderNodes();
    drawBackground();
    drawGraph();
    dialog.querySelector("#galaxy-close").focus();
  };
  const close = () => { if (dialog.open) dialog.close(); options.onClose?.(); };
  listen(dialog.querySelector("#galaxy-close"), "click", close);
  listen(dialog.querySelector("#galaxy-reset"), "click", reset);
  listen(dialog.querySelector("#galaxy-zoom-in"), "click", () => zoom(1.2));
  listen(dialog.querySelector("#galaxy-zoom-out"), "click", () => zoom(1 / 1.2));
  listen(dialog.querySelector("#galaxy-stars"), "click", (event) => {
    const hidden = background.classList.toggle("hidden-stars");
    event.currentTarget.setAttribute("aria-pressed", String(!hidden));
    event.currentTarget.textContent = hidden ? "显示背景星点" : "隐藏背景星点";
  });
  listen(dialog.querySelector("#galaxy-rotation"), "click", (event) => {
    const paused = shell.classList.toggle("is-paused");
    event.currentTarget.setAttribute("aria-pressed", String(paused));
    event.currentTarget.textContent = paused ? "继续旋转" : "暂停旋转";
  });
  listen(shell, "wheel", (event) => { event.preventDefault(); zoom(event.deltaY > 0 ? 0.9 : 1.1); }, { passive: false });
  listen(shell, "pointerdown", (event) => {
    if (event.target.closest("button, aside")) return;
    drag = { x: event.clientX, y: event.clientY, originX: transform.x, originY: transform.y };
    shell.setPointerCapture(event.pointerId);
  });
  listen(shell, "pointermove", (event) => {
    if (!drag) return;
    transform.x = drag.originX + event.clientX - drag.x;
    transform.y = drag.originY + event.clientY - drag.y;
    drawGraph();
  });
  listen(shell, "pointerup", () => { drag = null; });
  listen(window, "resize", () => { if (dialog.open) { drawBackground(); drawGraph(); } });
  listen(dialog, "close", () => options.onClose?.());
  return {
    open,
    close,
    reset,
    destroy() {
      destroyed = true;
      cleanups.splice(0).forEach((cleanup) => cleanup());
      if (dialog.open) dialog.close();
      nodeElements.clear();
      nodeLayer.replaceChildren();
    }
  };
}
