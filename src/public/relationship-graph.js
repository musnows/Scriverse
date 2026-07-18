const RELATION_STYLE = Object.freeze({
  family: { label: "亲属", color: "#43e39a" },
  social: { label: "社交", color: "#438cff" },
  emotional: { label: "情感", color: "#ff5f69" },
  conflict: { label: "冲突", color: "#ffad42" },
  uncertain: { label: "未确定", color: "#9aa5b5" }
});

/** Obsidian Graph View 风格：低饱和度分组配色 */
export const OBSIDIAN_NODE_PALETTE = Object.freeze([
  Object.freeze({ key: "blue", color: "#7a9bb5", glow: "rgba(122,155,181,.48)" }),
  Object.freeze({ key: "lavender", color: "#9a8fb5", glow: "rgba(154,143,181,.48)" }),
  Object.freeze({ key: "slate", color: "#8b9099", glow: "rgba(139,144,153,.42)" }),
  Object.freeze({ key: "rose", color: "#b58a9a", glow: "rgba(181,138,154,.48)" }),
  Object.freeze({ key: "mist", color: "#8aa8a3", glow: "rgba(138,168,163,.45)" }),
  Object.freeze({ key: "sand", color: "#a89a88", glow: "rgba(168,154,136,.42)" })
]);

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const NETWORK_LAYOUTS = Object.freeze({
  standard: Object.freeze({ width: 1200, height: 640, marginX: 48, marginY: 42, desiredEdgeLength: 196, repulsionStrength: 16800 }),
  expanded: Object.freeze({ width: 1600, height: 900, marginX: 64, marginY: 56, desiredEdgeLength: 236, repulsionStrength: 22800 })
});
export const GALAXY_ROTATION_RADIANS_PER_MS = 0.000012;
export const GALAXY_LAYOUT_CONFIG = Object.freeze({
  minimumRadius: 165,
  radialSpan: 690,
  repulsionStrength: 5200,
  desiredEdgeLength: 210
});

export function formatRelationshipLabel(edge, separator = " · ") {
  const subtype = String(edge?.subtype ?? "").trim();
  const keywords = Array.isArray(edge?.keywords)
    ? edge.keywords.map(String).map((value) => value.trim()).filter(Boolean)
    : [];
  return [subtype, ...keywords].filter(Boolean).join(separator) || "关系";
}

export function groupRelationshipDetailsByCharacterName(graph, nodeId) {
  const groups = new Map();
  for (const edge of graph.edges) {
    if (edge.source !== nodeId && edge.target !== nodeId) continue;
    const other = graph.nodeById.get(edge.source === nodeId ? edge.target : edge.source);
    const name = String(other?.name ?? "未知角色").normalize("NFKC").trim() || "未知角色";
    const key = name.toLocaleLowerCase("zh-CN");
    const existing = groups.get(key);
    if (existing) existing.edges.push(edge);
    else groups.set(key, { name, edges: [edge] });
  }
  return [...groups.values()];
}

export function getRelationshipEdgeSelection(graph, edgeId) {
  const edge = graph.edges.find((item) => item.id === edgeId);
  if (!edge) return null;
  return {
    edgeId: edge.id,
    endpointIds: [edge.source, edge.target],
    endpointNames: [graph.nodeById.get(edge.source)?.name ?? "未知角色", graph.nodeById.get(edge.target)?.name ?? "未知角色"],
    label: formatRelationshipLabel(edge)
  };
}

export function resolveRelationshipNodeGroup(node) {
  const organizations = Array.isArray(node?.organizations) ? node.organizations : [];
  const orgName = organizations
    .map((item) => String(item?.name ?? item ?? "").trim())
    .find(Boolean);
  const species = String(node?.species ?? "").trim();
  const identity = String(node?.identity ?? "").trim();
  if (orgName) return { type: "organization", key: `org:${orgName}`, label: orgName };
  if (species) return { type: "species", key: `species:${species}`, label: species };
  if (identity) return { type: "identity", key: `identity:${identity}`, label: identity };
  return { type: "default", key: "default", label: "未分组" };
}

export function getObsidianNodeAppearance(node, maxDegree = 1) {
  const group = resolveRelationshipNodeGroup(node);
  const degree = Math.max(0, Number(node?.degree) || 0);
  const normalizedDegree = clamp(degree / Math.max(1, Number(maxDegree) || 1), 0, 1);
  const paletteIndex = group.key === "default" ? 2 : hashString(group.key) % OBSIDIAN_NODE_PALETTE.length;
  const palette = OBSIDIAN_NODE_PALETTE[paletteIndex];
  return {
    group,
    color: palette.color,
    glow: palette.glow,
    size: clamp(8 + Math.sqrt(degree) * 4.8 + normalizedDegree * 4, 8, 38),
    degree,
    normalizedDegree
  };
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
  const nodes = characters.map((character) => {
    const organizations = Array.isArray(character.organizations)
      ? character.organizations.map((item) => ({
        id: String(item?.id ?? ""),
        name: String(item?.name ?? item ?? "").trim()
      })).filter((item) => item.name)
      : Array.isArray(character.organizationIds)
        ? character.organizationIds.map((id) => ({ id: String(id), name: String(id) }))
        : [];
    const node = {
      id: String(character.id),
      name: String(character.name),
      aliases: Array.isArray(character.aliases) ? character.aliases : [],
      species: String(character.species ?? ""),
      identity: String(character.attributes?.identity ?? ""),
      organizations,
      locked: Array.isArray(character.lockedFields) && character.lockedFields.length > 0,
      degree: 0,
      weightedDegree: 0,
      importance: 0
    };
    const group = resolveRelationshipNodeGroup(node);
    node.groupKey = group.key;
    node.groupLabel = group.label;
    node.groupType = group.type;
    return node;
  });
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
  const maxDegree = Math.max(1, ...nodes.map((node) => node.degree));
  for (const node of nodes) {
    node.importance = node.weightedDegree + Math.sqrt(node.degree) * 0.8;
    const appearance = getObsidianNodeAppearance(node, maxDegree);
    node.color = appearance.color;
    node.glow = appearance.glow;
    node.nodeSize = appearance.size;
  }
  nodes.sort((left, right) => right.importance - left.importance || left.name.localeCompare(right.name, "zh-CN"));
  return { nodes, edges, nodeById, warnings, stats: { nodeCount: nodes.length, edgeCount: edges.length, maxDegree } };
}

export function layoutRelationshipNetwork(graph, seed = "relationship-network", options = {}) {
  const layout = options.expanded ? NETWORK_LAYOUTS.expanded : NETWORK_LAYOUTS.standard;
  const random = seededRandom(hashString(`${seed}:${graph.nodes.map((node) => node.id).join("|")}`));
  const maxImportance = Math.max(1, ...graph.nodes.map((node) => Number(node.importance) || 0));
  const centerX = layout.width / 2;
  const centerY = layout.height / 2;
  const nodes = graph.nodes.map((node, index) => {
    const centrality = clamp((Number(node.importance) || 0) / maxImportance, 0, 1);
    const angle = index * 2.399963229728653 + random() * 0.42;
    const radialScale = (0.2 + Math.sqrt(random()) * 0.34) * (1 - centrality * 0.45);
    const radius = Math.min(layout.width, layout.height) * radialScale;
    return {
      ...node,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius * 0.78,
      vx: 0,
      vy: 0,
      radius: clamp(Number(node.nodeSize) || (8 + Math.sqrt(Math.max(0, node.degree)) * 4.8), 8, 38)
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const exactRepulsion = nodes.length <= 150;
  const iterations = exactRepulsion ? 88 : 64;
  const repel = (left, right) => {
    let dx = right.x - left.x;
    let dy = right.y - left.y;
    if (Math.abs(dx) + Math.abs(dy) < 0.01) {
      dx = random() - 0.5;
      dy = random() - 0.5;
    }
    const minimumDistance = left.radius + right.radius + 9;
    const distanceSquared = Math.max(36, dx * dx + dy * dy);
    const distance = Math.sqrt(distanceSquared);
    const collisionBoost = distance < minimumDistance ? (minimumDistance - distance) * 0.22 : 0;
    const force = layout.repulsionStrength / distanceSquared + collisionBoost;
    left.vx -= dx / distance * force;
    left.vy -= dy / distance * force;
    right.vx += dx / distance * force;
    right.vy += dy / distance * force;
  };
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const cooling = 1 - iteration / (iterations + 24);
    if (exactRepulsion) {
      for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) repel(nodes[leftIndex], nodes[rightIndex]);
      }
    } else {
      const sampleCount = Math.min(32, nodes.length - 1);
      const stride = 19 + iteration % 13;
      for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
        for (let sample = 1; sample <= sampleCount; sample += 1) {
          const rightIndex = (leftIndex + sample * stride) % nodes.length;
          if (rightIndex !== leftIndex) repel(nodes[leftIndex], nodes[rightIndex]);
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
      const desiredLength = layout.desiredEdgeLength + Math.sqrt(Math.max(source.degree, target.degree, 1)) * 10;
      const force = (distance - desiredLength) * (0.0022 + edge.confidence * 0.0018);
      source.vx += dx / distance * force;
      source.vy += dy / distance * force;
      target.vx -= dx / distance * force;
      target.vy -= dy / distance * force;
    }
    for (const node of nodes) {
      const centrality = clamp((Number(node.importance) || 0) / maxImportance, 0, 1);
      node.vx += (centerX - node.x) * (0.00018 + centrality * 0.00055);
      node.vy += (centerY - node.y) * (0.00018 + centrality * 0.00055);
      node.vx = clamp(node.vx * 0.82, -10, 10);
      node.vy = clamp(node.vy * 0.82, -10, 10);
      node.x += node.vx * cooling;
      node.y += node.vy * cooling;
    }
  }
  if (nodes.length === 1) {
    nodes[0].x = centerX;
    nodes[0].y = centerY;
  } else if (nodes.length > 1) {
    const minX = Math.min(...nodes.map((node) => node.x));
    const maxX = Math.max(...nodes.map((node) => node.x));
    const minY = Math.min(...nodes.map((node) => node.y));
    const maxY = Math.max(...nodes.map((node) => node.y));
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    for (const node of nodes) {
      node.x = layout.marginX + (node.x - minX) / width * (layout.width - layout.marginX * 2);
      node.y = layout.marginY + (node.y - minY) / height * (layout.height - layout.marginY * 2);
    }
  }
  return { nodes, byId, width: layout.width, height: layout.height };
}

export const DRAG_PHYSICS_CONFIG = Object.freeze({
  springStrength: 0.048,
  desiredEdgeLength: 188,
  repulsionStrength: 3200,
  collisionPadding: 14,
  damping: 0.9,
  maxSpeed: 18,
  stepsPerFrame: 2,
  coastDamping: 0.9,
  coastSettleSpeed: 0.35,
  coastMaxMs: 800
});

export function stepRelationshipInertiaCoast(state, options = {}) {
  const positions = state.positions;
  const velocities = state.velocities;
  const nodeRadii = state.nodeRadii;
  const bounds = state.bounds ?? {};
  const activeNodeIds = state.activeNodeIds instanceof Set && state.activeNodeIds.size
    ? [...state.activeNodeIds].filter((nodeId) => positions.has(nodeId))
    : [...positions.keys()];
  const minimumX = Number(bounds.minimumX ?? -Infinity);
  const maximumX = Number(bounds.maximumX ?? Infinity);
  const minimumY = Number(bounds.minimumY ?? -Infinity);
  const maximumY = Number(bounds.maximumY ?? Infinity);
  const fitBounds = (position) => ({
    x: clamp(Number(position.x) || 0, minimumX, maximumX),
    y: clamp(Number(position.y) || 0, minimumY, maximumY)
  });
  const radiusOf = (nodeId) => Math.max(1, Number(nodeRadii?.get(nodeId)) || 18);
  const damping = clamp(Number(options.damping ?? DRAG_PHYSICS_CONFIG.coastDamping), 0.7, 0.97);
  const collisionPadding = Number(options.collisionPadding ?? DRAG_PHYSICS_CONFIG.collisionPadding);
  const dt = clamp(Number(options.dt ?? 1), 0.2, 2);
  const changedNodeIds = new Set();
  let energy = 0;

  // 仅做轻量互斥，避免惯性滑行时重叠，不引入弹簧以免再次全图漂移
  for (let leftIndex = 0; leftIndex < activeNodeIds.length; leftIndex += 1) {
    const leftId = activeNodeIds[leftIndex];
    const left = positions.get(leftId);
    const leftVelocity = velocities.get(leftId) ?? { vx: 0, vy: 0 };
    for (let rightIndex = leftIndex + 1; rightIndex < activeNodeIds.length; rightIndex += 1) {
      const rightId = activeNodeIds[rightIndex];
      const right = positions.get(rightId);
      const rightVelocity = velocities.get(rightId) ?? { vx: 0, vy: 0 };
      let dx = right.x - left.x;
      let dy = right.y - left.y;
      let distance = Math.hypot(dx, dy);
      const minimumDistance = radiusOf(leftId) + radiusOf(rightId) + collisionPadding;
      if (distance >= minimumDistance || distance < 0.001) continue;
      if (distance < 0.001) {
        dx = 0.01;
        dy = 0;
        distance = 0.01;
      }
      const overlap = (minimumDistance - distance) * 0.18;
      const nx = dx / distance;
      const ny = dy / distance;
      leftVelocity.vx -= nx * overlap;
      leftVelocity.vy -= ny * overlap;
      rightVelocity.vx += nx * overlap;
      rightVelocity.vy += ny * overlap;
      velocities.set(leftId, leftVelocity);
      velocities.set(rightId, rightVelocity);
    }
  }

  for (const nodeId of activeNodeIds) {
    const position = positions.get(nodeId);
    let velocity = velocities.get(nodeId);
    if (!position) continue;
    if (!velocity) {
      velocity = { vx: 0, vy: 0 };
      velocities.set(nodeId, velocity);
    }
    velocity.vx *= damping;
    velocity.vy *= damping;
    if (Math.abs(velocity.vx) < 0.02) velocity.vx = 0;
    if (Math.abs(velocity.vy) < 0.02) velocity.vy = 0;
    if (!velocity.vx && !velocity.vy) continue;
    const next = fitBounds({
      x: position.x + velocity.vx * dt,
      y: position.y + velocity.vy * dt
    });
    positions.set(nodeId, next);
    changedNodeIds.add(nodeId);
    energy += Math.hypot(velocity.vx, velocity.vy);
  }
  return { changedNodeIds, energy };
}

export function stepRelationshipDragPhysics(state, options = {}) {
  const positions = state.positions;
  const velocities = state.velocities;
  const edges = state.edges ?? [];
  const nodeRadii = state.nodeRadii;
  const bounds = state.bounds ?? {};
  const pinnedNodeId = state.pinnedNodeId ?? null;
  const pinnedPosition = state.pinnedPosition ?? null;
  const activeNodeIds = state.activeNodeIds instanceof Set && state.activeNodeIds.size
    ? state.activeNodeIds
    : null;
  const minimumX = Number(bounds.minimumX ?? -Infinity);
  const maximumX = Number(bounds.maximumX ?? Infinity);
  const minimumY = Number(bounds.minimumY ?? -Infinity);
  const maximumY = Number(bounds.maximumY ?? Infinity);
  const fitBounds = (position) => ({
    x: clamp(Number(position.x) || 0, minimumX, maximumX),
    y: clamp(Number(position.y) || 0, minimumY, maximumY)
  });
  const radiusOf = (nodeId) => Math.max(1, Number(nodeRadii?.get(nodeId)) || 18);
  const springStrength = Number(options.springStrength ?? DRAG_PHYSICS_CONFIG.springStrength);
  const desiredEdgeLength = Number(options.desiredEdgeLength ?? DRAG_PHYSICS_CONFIG.desiredEdgeLength);
  const repulsionStrength = Number(options.repulsionStrength ?? DRAG_PHYSICS_CONFIG.repulsionStrength);
  const collisionPadding = Number(options.collisionPadding ?? DRAG_PHYSICS_CONFIG.collisionPadding);
  const damping = clamp(Number(options.damping ?? DRAG_PHYSICS_CONFIG.damping), 0.5, 0.98);
  const maxSpeed = Number(options.maxSpeed ?? DRAG_PHYSICS_CONFIG.maxSpeed);
  const dt = clamp(Number(options.dt ?? 1), 0.2, 2);
  const nodeIds = activeNodeIds ? [...activeNodeIds].filter((nodeId) => positions.has(nodeId)) : [...positions.keys()];
  const activeSet = activeNodeIds ?? new Set(nodeIds);
  const forces = new Map(nodeIds.map((nodeId) => [nodeId, { fx: 0, fy: 0 }]));

  if (pinnedNodeId && pinnedPosition && positions.has(pinnedNodeId)) {
    const pinned = fitBounds(pinnedPosition);
    positions.set(pinnedNodeId, pinned);
    velocities.set(pinnedNodeId, { vx: 0, vy: 0 });
  }

  for (const edge of edges) {
    if (!activeSet.has(edge.source) && !activeSet.has(edge.target)) continue;
    if (!forces.has(edge.source)) forces.set(edge.source, { fx: 0, fy: 0 });
    if (!forces.has(edge.target)) forces.set(edge.target, { fx: 0, fy: 0 });
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) continue;
    let dx = target.x - source.x;
    let dy = target.y - source.y;
    let distance = Math.hypot(dx, dy);
    if (distance < 0.01) {
      dx = 0.01;
      dy = 0;
      distance = 0.01;
    }
    const sourceDegree = Math.max(1, Number(state.degrees?.get(edge.source)) || 1);
    const targetDegree = Math.max(1, Number(state.degrees?.get(edge.target)) || 1);
    const restLength = desiredEdgeLength + Math.sqrt(Math.max(sourceDegree, targetDegree)) * 8;
    const stretch = distance - restLength;
    const force = stretch * springStrength;
    const fx = dx / distance * force;
    const fy = dy / distance * force;
    if (edge.source !== pinnedNodeId) {
      forces.get(edge.source).fx += fx;
      forces.get(edge.source).fy += fy;
    }
    if (edge.target !== pinnedNodeId) {
      forces.get(edge.target).fx -= fx;
      forces.get(edge.target).fy -= fy;
    }
  }

  const repulsionIds = [...new Set([...nodeIds, ...(pinnedNodeId ? [pinnedNodeId] : [])])];
  for (let leftIndex = 0; leftIndex < repulsionIds.length; leftIndex += 1) {
    const leftId = repulsionIds[leftIndex];
    const left = positions.get(leftId);
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < repulsionIds.length; rightIndex += 1) {
      const rightId = repulsionIds[rightIndex];
      if (!activeSet.has(leftId) && !activeSet.has(rightId)) continue;
      const right = positions.get(rightId);
      if (!right) continue;
      let dx = right.x - left.x;
      let dy = right.y - left.y;
      let distanceSquared = dx * dx + dy * dy;
      if (distanceSquared < 0.0001) {
        dx = (hashString(`${leftId}:${rightId}`) / 4294967296 - 0.5) || 0.01;
        dy = (hashString(`${rightId}:${leftId}`) / 4294967296 - 0.5) || 0.01;
        distanceSquared = dx * dx + dy * dy;
      }
      const distance = Math.sqrt(distanceSquared);
      const minimumDistance = radiusOf(leftId) + radiusOf(rightId) + collisionPadding;
      let force = repulsionStrength / distanceSquared;
      if (distance < minimumDistance) force += (minimumDistance - distance) * 0.42;
      else if (distance > minimumDistance * 3.8) continue;
      const fx = dx / distance * force;
      const fy = dy / distance * force;
      if (!forces.has(leftId)) forces.set(leftId, { fx: 0, fy: 0 });
      if (!forces.has(rightId)) forces.set(rightId, { fx: 0, fy: 0 });
      if (leftId !== pinnedNodeId) {
        forces.get(leftId).fx -= fx;
        forces.get(leftId).fy -= fy;
      }
      if (rightId !== pinnedNodeId) {
        forces.get(rightId).fx += fx;
        forces.get(rightId).fy += fy;
      }
    }
  }

  const changedNodeIds = new Set();
  let energy = 0;
  const movableIds = new Set([...forces.keys(), ...nodeIds]);
  for (const nodeId of movableIds) {
    const position = positions.get(nodeId);
    if (!position) continue;
    const force = forces.get(nodeId) ?? { fx: 0, fy: 0 };
    let velocity = velocities.get(nodeId);
    if (!velocity) {
      velocity = { vx: 0, vy: 0 };
      velocities.set(nodeId, velocity);
    }
    if (nodeId === pinnedNodeId) {
      changedNodeIds.add(nodeId);
      continue;
    }
    if (activeNodeIds && !activeNodeIds.has(nodeId) && Math.hypot(force.fx, force.fy) < 0.01) continue;
    velocity.vx = clamp((velocity.vx + force.fx * dt) * damping, -maxSpeed, maxSpeed);
    velocity.vy = clamp((velocity.vy + force.fy * dt) * damping, -maxSpeed, maxSpeed);
    const next = fitBounds({
      x: position.x + velocity.vx * dt,
      y: position.y + velocity.vy * dt
    });
    if (next.x !== position.x || next.y !== position.y || Math.abs(velocity.vx) > 0.01 || Math.abs(velocity.vy) > 0.01) {
      positions.set(nodeId, next);
      changedNodeIds.add(nodeId);
    }
    energy += Math.hypot(velocity.vx, velocity.vy);
  }
  return { changedNodeIds, energy };
}

export function applyRelationshipDragInfluence(positions, draggedNodeId, nextPosition, neighborIds, nodeRadii, bounds, options = {}) {
  const velocities = options.velocities ?? new Map([...positions.keys()].map((nodeId) => [nodeId, { vx: 0, vy: 0 }]));
  const neighborSet = new Set([...(neighborIds ?? [])].map(String));
  const activeNodeIds = new Set([draggedNodeId, ...neighborSet]);
  // 邻近未连接节点也参与局部避让，避免被拖拽簇硬撞开后到处漂移
  for (const [nodeId, position] of positions) {
    if (activeNodeIds.has(nodeId)) continue;
    const pinned = nextPosition;
    if (Math.hypot(position.x - pinned.x, position.y - pinned.y) < 120) activeNodeIds.add(nodeId);
  }
  const syntheticEdges = [...neighborSet].map((neighborId, index) => ({
    id: `drag-edge-${index}`,
    source: draggedNodeId,
    target: neighborId
  }));
  const degrees = new Map([...positions.keys()].map((nodeId) => [nodeId, nodeId === draggedNodeId ? neighborSet.size : neighborSet.has(nodeId) ? 1 : 0]));
  const steps = Math.max(1, Math.round(Number(options.steps ?? 8)));
  let changedNodeIds = new Set([draggedNodeId]);
  for (let step = 0; step < steps; step += 1) {
    const result = stepRelationshipDragPhysics({
      positions,
      velocities,
      edges: syntheticEdges,
      nodeRadii,
      bounds,
      degrees,
      activeNodeIds,
      pinnedNodeId: draggedNodeId,
      pinnedPosition: nextPosition
    }, {
      springStrength: Number(options.springStrength ?? 0.08),
      desiredEdgeLength: Number(options.desiredEdgeLength ?? DRAG_PHYSICS_CONFIG.desiredEdgeLength),
      repulsionStrength: Number(options.repulsionStrength ?? 3200),
      collisionPadding: Number(options.avoidancePadding ?? 16),
      damping: Number(options.damping ?? 0.86),
      maxSpeed: Number(options.maxSpeed ?? 20),
      dt: Number(options.dt ?? 1)
    });
    result.changedNodeIds.forEach((nodeId) => changedNodeIds.add(nodeId));
  }
  if (options.velocities) options.velocities = velocities;
  return changedNodeIds;
}

export function renderRelationshipMindMap(container, graph, options = {}) {
  container.replaceChildren();
  if (!graph.nodes.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "<b>还没有角色档案</b>先创建角色，关系图会在这里出现。";
    container.append(empty);
    return { destroy() { container.replaceChildren(); } };
  }

  const layout = options.expanded ? NETWORK_LAYOUTS.expanded : NETWORK_LAYOUTS.standard;
  const laidOut = layoutRelationshipNetwork(graph, options.seed ?? "relationship-network-v3", { expanded: options.expanded });
  const positions = new Map(laidOut.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
  const originalPositions = new Map([...positions].map(([id, position]) => [id, { ...position }]));
  const velocities = new Map(graph.nodes.map((node) => [node.id, { vx: 0, vy: 0 }]));
  const nodeInfluenceRadii = new Map(graph.nodes.map((node) => [node.id, clamp(Number(node.nodeSize) || (8 + Math.sqrt(Math.max(0, node.degree)) * 4.8), 8, 38)]));
  const nodeDegrees = new Map(graph.nodes.map((node) => [node.id, node.degree]));
  const dragBounds = { minimumX: layout.marginX, maximumX: layout.width - layout.marginX, minimumY: layout.marginY, maximumY: layout.height - layout.marginY };
  const neighbors = new Map(graph.nodes.map((node) => [node.id, new Set()]));
  graph.edges.forEach((edge) => {
    neighbors.get(edge.source)?.add(edge.target);
    neighbors.get(edge.target)?.add(edge.source);
  });
  let selectedId = null;
  let selectedEdgeId = null;
  let hoveredId = null;
  let viewScale = 1;
  let viewX = 0;
  let viewY = 0;
  let animationFrame = null;
  let geometryFrame = null;
  let physicsFrame = null;
  let pendingDragUpdate = null;
  let pinnedDrag = null;
  let coastActiveIds = null;
  let coastStartedAt = 0;
  let destroyed = false;
  let previousPhysicsTime = 0;

  const shell = document.createElement("section");
  shell.className = `relationship-map-card relationship-network-card relationship-obsidian-card${options.expanded ? " is-expanded" : ""}`;
  shell.dataset.testid = "relationship-mindmap";
  const toolbar = document.createElement("header");
  toolbar.className = "relationship-map-toolbar";
  toolbar.innerHTML = `<div><strong>人物关系图谱</strong><small>${graph.stats.nodeCount} 个角色 · ${graph.stats.edgeCount} 条关系</small></div>`;
  const actions = document.createElement("div");
  actions.className = "relationship-map-actions";
  if (!options.expanded) {
    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "ghost-button";
    expand.textContent = "放大预览";
    expand.setAttribute("aria-label", "放大关系图");
    expand.dataset.testid = "relationship-map-expand";
    expand.addEventListener("click", () => options.onOpenExpanded?.());
    actions.append(expand);
  }
  const fit = document.createElement("button");
  fit.type = "button";
  fit.className = "ghost-button";
  fit.textContent = "适配";
  fit.dataset.testid = "relationship-network-fit";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "ghost-button";
  reset.textContent = "重置布局";
  reset.dataset.testid = "relationship-network-reset";
  const fullscreen = document.createElement("button");
  fullscreen.type = "button";
  fullscreen.className = "ghost-button relationship-galaxy-button";
  fullscreen.innerHTML = '<svg class="relationship-galaxy-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11.5" cy="12" r="4.2"/><ellipse cx="11.5" cy="12" rx="9" ry="3.2" transform="rotate(-18 11.5 12)"/><path d="M19 2.8v3.4M17.3 4.5h3.4"/></svg><span>银河图</span>';
  fullscreen.setAttribute("aria-label", "全屏银河图");
  fullscreen.dataset.testid = "relationship-galaxy-open";
  fullscreen.addEventListener("click", () => options.onOpenGalaxy?.());
  actions.append(fit, reset, fullscreen);
  toolbar.append(actions);

  const viewport = document.createElement("div");
  viewport.className = "relationship-mindmap relationship-network relationship-obsidian";
  viewport.dataset.testid = "relationship-network";
  viewport.dataset.layoutWidth = String(layout.width);
  viewport.dataset.layoutHeight = String(layout.height);
  viewport.dataset.interaction = "idle";
  viewport.dataset.renderStrategy = "obsidian-force-graph";
  viewport.dataset.edgeLabelStrategy = "selected-only";
  const stage = document.createElement("div");
  stage.className = "relationship-mindmap-stage relationship-network-stage";
  viewport.append(stage);

  const focusBadge = document.createElement("div");
  focusBadge.className = "relationship-network-focus";
  focusBadge.innerHTML = "<strong>人物关系图谱</strong><span>力导向布局 · 按阵营/种族着色</span>";
  const focusText = focusBadge.querySelector("span");
  const help = document.createElement("div");
  help.className = "relationship-network-help";
  help.textContent = "滚轮缩放 · 拖拽空白平移 · 拖拽节点固定 · 悬浮高亮关联";
  viewport.append(focusBadge, help);

  const updateViewTransform = (animate = false) => {
    stage.classList.toggle("is-view-animating", animate);
    stage.style.transform = `translate(${viewX}px, ${viewY}px) scale(${viewScale})`;
    viewport.dataset.graphScale = viewScale.toFixed(3);
    viewport.dataset.viewX = viewX.toFixed(1);
    viewport.dataset.viewY = viewY.toFixed(1);
    if (animate) window.setTimeout(() => stage.classList.remove("is-view-animating"), 360);
  };
  updateViewTransform();

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-label", "人物关系连线");
  const edgeElements = [];
  const edgeElementsByNode = new Map(graph.nodes.map((node) => [node.id, []]));
  const updateEdgeGeometry = ({ edge, hitPath, path }, { includeHit = true } = {}) => {
    const from = positions.get(edge.source);
    const to = positions.get(edge.target);
    if (!from || !to) return;
    const geometry = `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} L ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
    path.setAttribute("d", geometry);
    if (includeHit) hitPath.setAttribute("d", geometry);
  };
  const updateLabelGeometry = (edge) => {
    const from = positions.get(edge.source);
    const to = positions.get(edge.target);
    if (!from || !to) return;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const middleX = (from.x + to.x) / 2;
    const middleY = (from.y + to.y) / 2 - 4;
    let angle = Math.atan2(dy, dx) * 180 / Math.PI;
    if (angle > 90 || angle < -90) angle += 180;
    const fullLabel = label.dataset.fullLabel || label.textContent || "";
    // 按连线长度截断，短边只显示极短摘要，完整内容在底部详情
    const maxChars = clamp(Math.floor(distance / 18), 4, 18);
    const shortLabel = fullLabel.length > maxChars ? `${fullLabel.slice(0, Math.max(1, maxChars - 1))}…` : fullLabel;
    label.textContent = shortLabel;
    label.setAttribute("font-size", String(clamp(distance / 36, 6.5, 8)));
    label.setAttribute("x", middleX.toFixed(2));
    label.setAttribute("y", middleY.toFixed(2));
    label.setAttribute("transform", `rotate(${angle.toFixed(2)} ${middleX.toFixed(2)} ${middleY.toFixed(2)})`);
  };
  for (const edge of graph.edges) {
    const hitPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hitPath.classList.add("mind-edge-hit");
    hitPath.dataset.edgeId = edge.id;
    hitPath.setAttribute("role", "button");
    hitPath.setAttribute("tabindex", "0");
    hitPath.setAttribute("aria-label", `选择 ${graph.nodeById.get(edge.source)?.name ?? "未知角色"} 与 ${graph.nodeById.get(edge.target)?.name ?? "未知角色"} 的关系：${formatRelationshipLabel(edge)}`);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.classList.add("mind-edge", "obsidian-edge");
    path.dataset.edgeId = edge.id;
    path.dataset.edgeSource = edge.source;
    path.dataset.edgeTarget = edge.target;
    path.style.setProperty("--edge-opacity", "0.24");
    path.style.setProperty("--edge-width", "1");
    if (edge.confirmationStatus === "pending") path.classList.add("is-pending");
    svg.append(hitPath, path);
    const edgeElement = { edge, hitPath, path };
    edgeElements.push(edgeElement);
    edgeElementsByNode.get(edge.source)?.push(edgeElement);
    edgeElementsByNode.get(edge.target)?.push(edgeElement);
    updateEdgeGeometry(edgeElement);
  }
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("text-anchor", "middle");
  label.classList.add("mind-edge-label", "is-edge-selected", "hidden");
  svg.append(label);
  stage.append(svg);

  const nodeElements = new Map();
  const updateNodePosition = (nodeId) => {
    const position = positions.get(nodeId);
    const button = nodeElements.get(nodeId);
    if (!position || !button) return;
    button.style.left = `${position.x / layout.width * 100}%`;
    button.style.top = `${position.y / layout.height * 100}%`;
  };
  const updateAllGeometry = () => {
    nodeElements.forEach((_, nodeId) => updateNodePosition(nodeId));
    edgeElements.forEach((edgeElement) => updateEdgeGeometry(edgeElement));
  };
  const updateAdjacentGeometry = (nodeIds, { includeHit = false } = {}) => {
    const dirtyEdges = new Set();
    for (const nodeId of nodeIds) {
      updateNodePosition(nodeId);
      const connected = edgeElementsByNode.get(nodeId);
      if (!connected) continue;
      for (let index = 0; index < connected.length; index += 1) dirtyEdges.add(connected[index]);
    }
    dirtyEdges.forEach((edgeElement) => updateEdgeGeometry(edgeElement, { includeHit }));
  };
  const stopPhysicsLoop = () => {
    if (physicsFrame) window.cancelAnimationFrame(physicsFrame);
    physicsFrame = null;
    previousPhysicsTime = 0;
    viewport.dataset.physics = "idle";
  };
  const freezePhysics = () => {
    stopPhysicsLoop();
    pinnedDrag = null;
    pendingDragUpdate = null;
    coastActiveIds = null;
    coastStartedAt = 0;
    velocities.forEach((velocity) => {
      velocity.vx = 0;
      velocity.vy = 0;
    });
    viewport.dataset.interaction = "idle";
    viewport.dataset.physics = "idle";
  };
  const getDragActiveNodes = (nodeId, anchorPosition = null) => {
    const active = new Set([nodeId, ...(neighbors.get(nodeId) ?? [])]);
    const anchor = anchorPosition ?? pinnedDrag?.target ?? positions.get(nodeId);
    if (!anchor) return active;
    for (const [id, position] of positions) {
      if (active.has(id)) continue;
      if (Math.hypot(position.x - anchor.x, position.y - anchor.y) < 140) active.add(id);
    }
    return active;
  };
  const runPhysicsStep = (dt) => {
    if (!pinnedDrag) return 0;
    const steps = DRAG_PHYSICS_CONFIG.stepsPerFrame;
    let changedNodeIds = new Set();
    let energy = 0;
    const activeNodeIds = getDragActiveNodes(pinnedDrag.nodeId);
    for (let step = 0; step < steps; step += 1) {
      const result = stepRelationshipDragPhysics({
        positions,
        velocities,
        edges: graph.edges,
        nodeRadii: nodeInfluenceRadii,
        bounds: dragBounds,
        degrees: nodeDegrees,
        activeNodeIds,
        pinnedNodeId: pinnedDrag.nodeId,
        pinnedPosition: pinnedDrag.target
      }, { dt: dt / steps });
      result.changedNodeIds.forEach((nodeId) => changedNodeIds.add(nodeId));
      energy = result.energy;
    }
    if (changedNodeIds.size) updateAdjacentGeometry(changedNodeIds, { includeHit: false });
    viewport.dataset.influencedNodeCount = String(changedNodeIds.size);
    viewport.dataset.physicsEnergy = energy.toFixed(2);
    return energy;
  };
  const runCoastStep = (dt) => {
    if (!coastActiveIds?.size) return 0;
    const result = stepRelationshipInertiaCoast({
      positions,
      velocities,
      nodeRadii: nodeInfluenceRadii,
      bounds: dragBounds,
      activeNodeIds: coastActiveIds
    }, { dt });
    if (result.changedNodeIds.size) updateAdjacentGeometry(result.changedNodeIds, { includeHit: false });
    viewport.dataset.influencedNodeCount = String(result.changedNodeIds.size);
    viewport.dataset.physicsEnergy = result.energy.toFixed(2);
    return result.energy;
  };
  const startPhysicsLoop = () => {
    if (physicsFrame || destroyed || !pinnedDrag) return;
    viewport.dataset.physics = "dragging";
    previousPhysicsTime = 0;
    const tick = (now) => {
      physicsFrame = 0;
      if (destroyed) return;
      if (!pinnedDrag) {
        freezePhysics();
        return;
      }
      const elapsed = previousPhysicsTime ? Math.min(34, now - previousPhysicsTime) : 16;
      previousPhysicsTime = now;
      const dt = clamp(elapsed / 16.67, 0.5, 1.8);
      if (pendingDragUpdate) {
        const previous = pinnedDrag.target;
        pinnedDrag.target = {
          x: clamp(pendingDragUpdate.nextPosition.x, dragBounds.minimumX, dragBounds.maximumX),
          y: clamp(pendingDragUpdate.nextPosition.y, dragBounds.minimumY, dragBounds.maximumY)
        };
        const moveDt = Math.max(elapsed, 8);
        pinnedDrag.vx = (pinnedDrag.target.x - previous.x) / (moveDt / 16.67);
        pinnedDrag.vy = (pinnedDrag.target.y - previous.y) / (moveDt / 16.67);
        pendingDragUpdate = null;
      }
      runPhysicsStep(dt);
      physicsFrame = window.requestAnimationFrame(tick);
    };
    physicsFrame = window.requestAnimationFrame(tick);
  };
  const startCoastLoop = (activeNodeIds) => {
    if (destroyed || !activeNodeIds?.size) {
      freezePhysics();
      return;
    }
    stopPhysicsLoop();
    pinnedDrag = null;
    pendingDragUpdate = null;
    coastActiveIds = activeNodeIds;
    coastStartedAt = performance.now();
    viewport.dataset.interaction = "settling";
    viewport.dataset.physics = "coasting";
    previousPhysicsTime = 0;
    const tick = (now) => {
      physicsFrame = 0;
      if (destroyed) return;
      const elapsed = previousPhysicsTime ? Math.min(34, now - previousPhysicsTime) : 16;
      previousPhysicsTime = now;
      const dt = clamp(elapsed / 16.67, 0.5, 1.8);
      const energy = runCoastStep(dt);
      const timedOut = now - coastStartedAt > DRAG_PHYSICS_CONFIG.coastMaxMs;
      if (!timedOut && energy > DRAG_PHYSICS_CONFIG.coastSettleSpeed) {
        physicsFrame = window.requestAnimationFrame(tick);
        return;
      }
      const touched = coastActiveIds ?? new Set();
      freezePhysics();
      if (touched.size) updateAdjacentGeometry(touched, { includeHit: true });
    };
    physicsFrame = window.requestAnimationFrame(tick);
  };
  const scheduleDragGeometry = (nodeId, nextPosition) => {
    pendingDragUpdate = { nodeId, nextPosition };
    if (!pinnedDrag || pinnedDrag.nodeId !== nodeId) {
      pinnedDrag = {
        nodeId,
        target: {
          x: clamp(nextPosition.x, dragBounds.minimumX, dragBounds.maximumX),
          y: clamp(nextPosition.y, dragBounds.minimumY, dragBounds.maximumY)
        },
        vx: 0,
        vy: 0
      };
    }
    startPhysicsLoop();
  };
  const flushPendingDrag = () => {
    if (!pendingDragUpdate || !pinnedDrag) return;
    const previous = pinnedDrag.target;
    pinnedDrag.target = {
      x: clamp(pendingDragUpdate.nextPosition.x, dragBounds.minimumX, dragBounds.maximumX),
      y: clamp(pendingDragUpdate.nextPosition.y, dragBounds.minimumY, dragBounds.maximumY)
    };
    pinnedDrag.vx = pinnedDrag.target.x - previous.x;
    pinnedDrag.vy = pinnedDrag.target.y - previous.y;
    pendingDragUpdate = null;
    runPhysicsStep(1);
  };
  const releasePinnedDrag = () => {
    flushPendingDrag();
    if (!pinnedDrag) {
      freezePhysics();
      return;
    }
    const releasedId = pinnedDrag.nodeId;
    const releaseVelocity = {
      vx: clamp(Number(pinnedDrag.vx) || 0, -DRAG_PHYSICS_CONFIG.maxSpeed, DRAG_PHYSICS_CONFIG.maxSpeed),
      vy: clamp(Number(pinnedDrag.vy) || 0, -DRAG_PHYSICS_CONFIG.maxSpeed, DRAG_PHYSICS_CONFIG.maxSpeed)
    };
    const touched = getDragActiveNodes(releasedId, pinnedDrag.target);
    // 把拖拽手感速度注入被拖节点，邻居保留拖拽过程中的弹簧速度，然后短暂惯性滑行
    velocities.set(releasedId, releaseVelocity);
    for (const nodeId of touched) {
      if (nodeId === releasedId) continue;
      const velocity = velocities.get(nodeId) ?? { vx: 0, vy: 0 };
      velocity.vx = clamp(velocity.vx * 0.85 + releaseVelocity.vx * 0.12, -DRAG_PHYSICS_CONFIG.maxSpeed, DRAG_PHYSICS_CONFIG.maxSpeed);
      velocity.vy = clamp(velocity.vy * 0.85 + releaseVelocity.vy * 0.12, -DRAG_PHYSICS_CONFIG.maxSpeed, DRAG_PHYSICS_CONFIG.maxSpeed);
      velocities.set(nodeId, velocity);
    }
    pinnedDrag = null;
    pendingDragUpdate = null;
    startCoastLoop(touched);
  };

  const edgeDetail = document.createElement("div");
  edgeDetail.className = "mind-edge-detail hidden";
  edgeDetail.setAttribute("aria-live", "polite");
  viewport.append(edgeDetail);
  const clearEdgeSelectionClasses = () => {
    nodeElements.forEach((button) => button.classList.remove("is-edge-endpoint"));
    edgeElements.forEach((item) => {
      item.path.classList.remove("is-edge-selected");
      item.hitPath.setAttribute("aria-pressed", "false");
    });
    label.classList.add("hidden");
    label.removeAttribute("data-edge-id");
  };
  const clearGraphHighlight = () => {
    clearEdgeSelectionClasses();
    nodeElements.forEach((button) => {
      button.classList.remove("is-selected", "is-related", "is-dimmed", "is-hovered");
    });
    edgeElements.forEach((item) => {
      item.path.classList.remove("is-highlighted", "is-dimmed");
    });
    focusText.textContent = "力导向布局 · 按阵营/种族着色";
    edgeDetail.classList.add("hidden");
    edgeDetail.replaceChildren();
  };
  const applyNodeFocus = (nodeId, { hover = false } = {}) => {
    if (!nodeId) {
      clearGraphHighlight();
      return;
    }
    clearEdgeSelectionClasses();
    const relatedIds = new Set([nodeId, ...(neighbors.get(nodeId) ?? [])]);
    nodeElements.forEach((button, id) => {
      button.classList.toggle("is-hovered", hover && id === nodeId);
      button.classList.toggle("is-selected", !hover && id === nodeId);
      button.classList.toggle("is-related", id !== nodeId && relatedIds.has(id));
      button.classList.toggle("is-dimmed", !relatedIds.has(id));
    });
    edgeElements.forEach((item) => {
      const active = item.edge.source === nodeId || item.edge.target === nodeId;
      item.path.classList.toggle("is-highlighted", active);
      item.path.classList.toggle("is-dimmed", !active);
    });
    const name = graph.nodeById.get(nodeId)?.name ?? "未知角色";
    focusText.textContent = hover ? `悬浮：${name}` : `聚焦：${name}`;
    edgeDetail.classList.add("hidden");
    edgeDetail.replaceChildren();
  };
  const refreshHighlight = () => {
    if (selectedEdgeId) {
      const selected = edgeElements.find((edgeElement) => edgeElement.edge.id === selectedEdgeId);
      if (selected) applyEdgeSelection(selected);
      return;
    }
    if (hoveredId) {
      applyNodeFocus(hoveredId, { hover: true });
      return;
    }
    if (selectedId) {
      applyNodeFocus(selectedId);
      return;
    }
    clearGraphHighlight();
  };
  const applyEdgeSelection = (edgeElement) => {
    const selection = getRelationshipEdgeSelection(graph, edgeElement.edge.id);
    if (!selection) return;
    clearEdgeSelectionClasses();
    const endpointIds = new Set(selection.endpointIds);
    nodeElements.forEach((button, id) => {
      button.classList.remove("is-selected", "is-related", "is-hovered");
      button.classList.toggle("is-edge-endpoint", endpointIds.has(id));
      button.classList.toggle("is-dimmed", !endpointIds.has(id));
    });
    edgeElements.forEach((item) => {
      const active = item.edge.id === selection.edgeId;
      item.path.classList.toggle("is-highlighted", false);
      item.path.classList.toggle("is-edge-selected", active);
      item.path.classList.toggle("is-dimmed", !active);
      item.hitPath.setAttribute("aria-pressed", String(active));
    });
    const fullLabel = selection.label;
    label.dataset.edgeId = selection.edgeId;
    label.dataset.fullLabel = fullLabel;
    label.classList.remove("hidden");
    updateLabelGeometry(edgeElement.edge);
    focusText.textContent = `关系：${selection.endpointNames[0]} ↔ ${selection.endpointNames[1]}`;
    const heading = document.createElement("b");
    heading.textContent = `${selection.endpointNames[0]}与${selection.endpointNames[1]}`;
    const detailText = document.createElement("span");
    detailText.textContent = selection.label;
    edgeDetail.replaceChildren(heading, detailText);
    edgeDetail.classList.remove("hidden");
  };
  edgeElements.forEach((edgeElement) => {
    const selectEdge = (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectedEdgeId = edgeElement.edge.id;
      applyEdgeSelection(edgeElement);
      if (typeof event.currentTarget?.blur === "function") event.currentTarget.blur();
    };
    edgeElement.hitPath.addEventListener("click", selectEdge);
    edgeElement.hitPath.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") selectEdge(event);
    });
  });

  for (const node of graph.nodes) {
    const button = document.createElement("button");
    const appearance = getObsidianNodeAppearance(node, graph.stats.maxDegree ?? 1);
    const nodeSize = appearance.size;
    button.type = "button";
    button.className = `mind-node network-node obsidian-node${node.locked ? " is-locked" : ""}${node.degree === 0 ? " is-isolated" : ""}`;
    button.dataset.nodeId = node.id;
    button.dataset.groupKey = node.groupKey || appearance.group.key;
    button.style.setProperty("--node-size", `${nodeSize}px`);
    button.style.setProperty("--node-color", node.color || appearance.color);
    button.style.setProperty("--node-glow", node.glow || appearance.glow);
    const labelEl = document.createElement("span");
    labelEl.textContent = node.name;
    button.append(labelEl);
    button.title = [
      node.groupLabel ? `分组：${node.groupLabel}` : "",
      node.species ? `种族：${node.species}` : "",
      node.identity,
      node.aliases.length ? `别名：${node.aliases.join("、")}` : "",
      `${node.degree} 条关系`
    ].filter(Boolean).join("\n");
    button.setAttribute("aria-label", `${node.name}，${node.degree} 条关系${node.aliases.length ? `，别名 ${node.aliases.join("、")}` : ""}`);
    button.setAttribute("aria-grabbed", "false");
    nodeElements.set(node.id, button);
    stage.append(button);
    updateNodePosition(node.id);

    let dragState = null;
    let suppressClick = false;
    button.addEventListener("pointerenter", () => {
      if (viewport.dataset.interaction === "dragging" || viewport.dataset.interaction === "panning") return;
      hoveredId = node.id;
      if (!selectedEdgeId) applyNodeFocus(node.id, { hover: true });
    });
    button.addEventListener("pointerleave", () => {
      if (hoveredId !== node.id) return;
      hoveredId = null;
      if (viewport.dataset.interaction === "dragging") return;
      refreshHighlight();
    });
    button.addEventListener("focus", () => {
      if (!selectedEdgeId) {
        selectedId = node.id;
        applyNodeFocus(node.id);
      }
    });
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const rect = viewport.getBoundingClientRect();
      dragState = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, rect, dragged: false };
      selectedEdgeId = null;
      selectedId = node.id;
      hoveredId = node.id;
      applyNodeFocus(node.id, { hover: true });
      try { button.setPointerCapture(event.pointerId); } catch { /* 非标准指针环境仍允许拖拽事件继续执行。 */ }
      button.classList.add("is-dragging");
      button.setAttribute("aria-grabbed", "true");
      for (const neighborId of neighbors.get(node.id) ?? []) nodeElements.get(neighborId)?.classList.add("is-drag-neighbor");
      viewport.dataset.interaction = "dragging";
      viewport.dataset.draggedNodeId = node.id;
    });
    button.addEventListener("pointermove", (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      if (Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY) >= 3) dragState.dragged = true;
      if (!dragState.dragged) return;
      event.preventDefault();
      const next = {
        x: clamp(((event.clientX - dragState.rect.left - viewX) / viewScale) / Math.max(dragState.rect.width, 1) * layout.width, layout.marginX, layout.width - layout.marginX),
        y: clamp(((event.clientY - dragState.rect.top - viewY) / viewScale) / Math.max(dragState.rect.height, 1) * layout.height, layout.marginY, layout.height - layout.marginY)
      };
      scheduleDragGeometry(node.id, next);
    });
    const endDrag = (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      suppressClick = dragState.dragged;
      dragState = null;
      button.classList.remove("is-dragging");
      for (const neighborId of neighbors.get(node.id) ?? []) nodeElements.get(neighborId)?.classList.remove("is-drag-neighbor");
      button.setAttribute("aria-grabbed", "false");
      try { if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId); } catch { /* 指针已释放时无需重复处理。 */ }
      if (suppressClick) {
        releasePinnedDrag();
        options.onSelect?.(node.id);
        refreshHighlight();
      } else {
        pinnedDrag = null;
        pendingDragUpdate = null;
        viewport.dataset.interaction = "idle";
      }
    };
    button.addEventListener("pointerup", endDrag);
    button.addEventListener("pointercancel", endDrag);
    button.addEventListener("click", () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      selectedEdgeId = null;
      selectedId = node.id;
      options.onSelect?.(node.id);
      applyNodeFocus(node.id);
    });
  }

  const fitView = () => {
    viewScale = 1;
    viewX = 0;
    viewY = 0;
    updateViewTransform(true);
  };
  const animatePositions = (targets, duration = 650) => {
    freezePhysics();
    if (animationFrame) window.cancelAnimationFrame(animationFrame);
    const starts = new Map([...positions].map(([id, position]) => [id, { ...position }]));
    const startedAt = performance.now();
    viewport.classList.add("is-layout-animating");
    viewport.dataset.interaction = "settling";
    viewport.dataset.layoutAnimation = "running";
    const tick = (now) => {
      if (destroyed) return;
      const progress = clamp((now - startedAt) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      targets.forEach((target, id) => {
        const start = starts.get(id) ?? target;
        positions.set(id, { x: start.x + (target.x - start.x) * eased, y: start.y + (target.y - start.y) * eased });
        const velocity = velocities.get(id);
        if (velocity) {
          velocity.vx = 0;
          velocity.vy = 0;
        }
      });
      updateAllGeometry();
      if (progress < 1) animationFrame = window.requestAnimationFrame(tick);
      else {
        animationFrame = null;
        viewport.classList.remove("is-layout-animating");
        viewport.dataset.interaction = "idle";
        viewport.dataset.layoutAnimation = "complete";
      }
    };
    animationFrame = window.requestAnimationFrame(tick);
  };
  fit.addEventListener("click", fitView);
  reset.addEventListener("click", () => {
    selectedEdgeId = null;
    hoveredId = null;
    freezePhysics();
    refreshHighlight();
    fitView();
    animatePositions(originalPositions);
  });

  let panState = null;
  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || ![viewport, stage, svg].includes(event.target)) return;
    panState = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, viewX, viewY };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("is-panning");
    viewport.dataset.interaction = "panning";
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!panState || event.pointerId !== panState.pointerId) return;
    viewX = panState.viewX + event.clientX - panState.startX;
    viewY = panState.viewY + event.clientY - panState.startY;
    updateViewTransform();
  });
  const endPan = (event) => {
    if (!panState || event.pointerId !== panState.pointerId) return;
    panState = null;
    viewport.classList.remove("is-panning");
    viewport.dataset.interaction = "idle";
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  };
  viewport.addEventListener("pointerup", endPan);
  viewport.addEventListener("pointercancel", endPan);
  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const nextScale = clamp(viewScale * (event.deltaY > 0 ? 0.9 : 1.1), 0.45, 3.2);
    const ratio = nextScale / viewScale;
    viewX = pointerX - (pointerX - viewX) * ratio;
    viewY = pointerY - (pointerY - viewY) * ratio;
    viewScale = nextScale;
    updateViewTransform();
  }, { passive: false });
  viewport.addEventListener("click", (event) => {
    if (![viewport, stage, svg].includes(event.target)) return;
    selectedEdgeId = null;
    selectedId = null;
    hoveredId = null;
    clearGraphHighlight();
  });

  updateAllGeometry();
  clearGraphHighlight();
  shell.append(toolbar, viewport);
  container.append(shell);
  return {
    destroy() {
      destroyed = true;
      freezePhysics();
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      if (geometryFrame) window.cancelAnimationFrame(geometryFrame);
      pendingDragUpdate = null;
      pinnedDrag = null;
      container.replaceChildren();
    },
    getState() {
      return { selectedId, selectedEdgeId, hoveredId, viewScale, viewX, viewY, positions: new Map(positions) };
    }
  };
}

export function layoutGalaxy(graph, seed) {
  const random = seededRandom(hashString(seed));
  const nodes = graph.nodes.map((node, index) => {
    const angle = random() * Math.PI * 2;
    const radius = GALAXY_LAYOUT_CONFIG.minimumRadius + Math.sqrt(random()) * GALAXY_LAYOUT_CONFIG.radialSpan;
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
        const force = GALAXY_LAYOUT_CONFIG.repulsionStrength / distanceSquared;
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
      const force = (distance - GALAXY_LAYOUT_CONFIG.desiredEdgeLength) * 0.0028 * (0.5 + edge.confidence);
      source.vx += dx / distance * force;
      source.vz += dz / distance * force;
      target.vx -= dx / distance * force;
      target.vz -= dz / distance * force;
    }
    for (const node of nodes) {
      const centrality = clamp(node.importance / Math.max(graph.nodes[0]?.importance || 1, 1), 0, 1);
      node.vx += -node.x * (0.00052 + centrality * 0.0011);
      node.vy += -node.y * 0.0014;
      node.vz += -node.z * (0.00052 + centrality * 0.0011);
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

export function getGalaxyNodeMarkerCenterOffset(nodeSize) {
  return 8 + Math.max(0, Number(nodeSize) || 0) / 2;
}

export function distanceToGalaxyEdge(point, from, to) {
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared === 0) return Math.hypot(point.x - from.x, point.y - from.y);
  const ratio = clamp(((point.x - from.x) * deltaX + (point.y - from.y) * deltaY) / lengthSquared, 0, 1);
  return Math.hypot(point.x - (from.x + deltaX * ratio), point.y - (from.y + deltaY * ratio));
}

export function findNearestGalaxyEdge(projectedEdges, point, threshold = 9) {
  let nearest = null;
  for (const projected of projectedEdges) {
    const distance = distanceToGalaxyEdge(point, projected.from, projected.to);
    if (distance > threshold || (nearest && distance >= nearest.distance)) continue;
    nearest = { edge: projected.edge, distance };
  }
  return nearest;
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
  let selectedEdgeId = null;
  let projectedEdges = [];
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
  shell.dataset.rotationSpeed = String(GALAXY_ROTATION_RADIANS_PER_MS);
  shell.dataset.layoutMinimumRadius = String(GALAXY_LAYOUT_CONFIG.minimumRadius);
  shell.dataset.layoutRadialSpan = String(GALAXY_LAYOUT_CONFIG.radialSpan);
  shell.dataset.layoutDesiredEdgeLength = String(GALAXY_LAYOUT_CONFIG.desiredEdgeLength);

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
    projectedEdges = orderedEdges.flatMap(({ edge, depth }) => {
      const from = projections.get(edge.source);
      const to = projections.get(edge.target);
      return from?.visible && to?.visible ? [{ edge, from, to, depth }] : [];
    });
    for (const { edge } of orderedEdges) {
      const from = projections.get(edge.source);
      const to = projections.get(edge.target);
      if (!from?.visible || !to?.visible) continue;
      const edgeSelected = edge.id === selectedEdgeId;
      const highlighted = edgeSelected || (Boolean(selectedId) && (edge.source === selectedId || edge.target === selectedId));
      const dimmed = selectedEdgeId ? !edgeSelected : Boolean(selectedId) && !highlighted;
      const depthFactor = clamp((from.scale + to.scale) / 1.9, 0.25, 1.6);
      const opacity = dimmed ? 0.018 : edgeSelected ? 1 : highlighted ? 0.9 : (0.08 + edge.confidence * 0.22) * depthFactor;
      const alpha = Math.round(clamp(opacity, 0, 1) * 255).toString(16).padStart(2, "0");
      const edgeColor = `${RELATION_STYLE[edge.category].color}${alpha}`;
      if (edgeSelected) {
        context.save();
        context.strokeStyle = `${RELATION_STYLE[edge.category].color}52`;
        context.lineWidth = 9 * clamp(depthFactor, 0.75, 1.4);
        context.shadowColor = RELATION_STYLE[edge.category].color;
        context.shadowBlur = 15;
        context.setLineDash([]);
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.stroke();
        context.restore();
      }
      context.strokeStyle = edgeColor;
      context.lineWidth = (edgeSelected ? 4 : highlighted ? 2.1 : 0.55 + edge.confidence) * clamp(depthFactor, 0.55, 1.45);
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
      const nodeSize = Number(element.dataset.nodeSize) || 12;
      const markerCenterOffset = getGalaxyNodeMarkerCenterOffset(nodeSize);
      element.style.transformOrigin = `50% ${markerCenterOffset}px`;
      element.style.transform = `translate3d(${point.x}px, ${point.y}px, 0) translate(-50%, -${markerCenterOffset}px) scale(${perspective * selectedScale})`;
      element.style.zIndex = String(10000 - Math.round(point.depth));
      element.style.setProperty("--depth-opacity", String(clamp(1.45 - point.depth / 2300, 0.38, 1)));
      element.dataset.worldX = node.x.toFixed(2);
      element.dataset.worldY = node.y.toFixed(2);
      element.dataset.worldZ = node.z.toFixed(2);
      element.dataset.projectedDepth = point.depth.toFixed(2);
      element.dataset.projectedScale = point.scale.toFixed(4);
      element.dataset.projectedX = point.x.toFixed(3);
      element.dataset.projectedY = point.y.toFixed(3);
      const edgeEndpoint = Boolean(selectedEdgeId) && graph.edges.some((edge) => edge.id === selectedEdgeId && (edge.source === node.id || edge.target === node.id));
      element.classList.toggle("is-selected", node.id === selectedId);
      element.classList.toggle("is-related", Boolean(selectedId) && node.id !== selectedId && relatedIds.has(node.id));
      element.classList.toggle("is-edge-endpoint", edgeEndpoint);
      element.classList.toggle("is-dimmed", selectedEdgeId ? !edgeEndpoint : Boolean(selectedId) && !relatedIds.has(node.id));
      element.classList.toggle("show-label", edgeEndpoint || node.index < 26 || relatedIds.has(node.id) || camera.zoom > 1.35);
    }
    shell.dataset.selectedNodeId = selectedId ?? "";
    shell.dataset.selectedEdgeId = selectedEdgeId ?? "";
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
    if (!paused && !cameraDrag) camera.yaw += elapsed * GALAXY_ROTATION_RADIANS_PER_MS;
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
    const relationGroups = groupRelationshipDetailsByCharacterName(graph, node.id);
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
    if (node.species) {
      const species = document.createElement("small");
      species.textContent = `种族：${node.species}`;
      detail.append(species);
    }
    if (node.identity) {
      const identity = document.createElement("p");
      identity.textContent = node.identity;
      detail.append(identity);
    }
    const list = document.createElement("ul");
    for (const group of relationGroups.slice(0, 12)) {
      const item = document.createElement("li");
      const categories = group.edges.map((edge) => {
        const category = document.createElement("i");
        category.className = edge.category;
        return category;
      });
      const labels = [...new Set(group.edges.map((edge) => formatRelationshipLabel(edge)))];
      item.append(...categories, document.createTextNode(`${group.name} · ${labels.join("；")}`));
      list.append(item);
    }
    detail.append(list);
  };

  const renderEdgeDetail = (edge) => {
    const selection = getRelationshipEdgeSelection(graph, edge.id);
    if (!selection) return;
    detail.classList.remove("hidden");
    detail.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = selection.endpointNames.join(" ↔ ");
    const category = document.createElement("small");
    category.textContent = RELATION_STYLE[edge.category].label;
    const description = document.createElement("p");
    description.textContent = selection.label;
    detail.append(heading, category, description);
    shell.dataset.selectedEdgeSource = selection.endpointIds[0];
    shell.dataset.selectedEdgeTarget = selection.endpointIds[1];
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
      const nodeSize = 10 + Math.sqrt(node.degree / maxDegree) * 28;
      button.style.setProperty("--node-size", `${nodeSize}px`);
      button.dataset.nodeSize = nodeSize.toFixed(3);
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
        selectedEdgeId = null;
        delete shell.dataset.selectedEdgeSource;
        delete shell.dataset.selectedEdgeTarget;
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
    selectedEdgeId = null;
    projectedEdges = [];
    delete shell.dataset.focusedNodeId;
    delete shell.dataset.draggedNodeId;
    delete shell.dataset.selectedEdgeSource;
    delete shell.dataset.selectedEdgeTarget;
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
    cameraDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, yaw: camera.yaw, pitch: camera.pitch, dragged: false };
    shell.classList.add("is-rotating-camera");
    shell.setPointerCapture(event.pointerId);
  });
  listen(shell, "pointermove", (event) => {
    if (!cameraDrag || event.pointerId !== cameraDrag.pointerId) return;
    if (Math.hypot(event.clientX - cameraDrag.x, event.clientY - cameraDrag.y) >= 3) cameraDrag.dragged = true;
    if (!cameraDrag.dragged) return;
    camera.yaw = cameraDrag.yaw + (event.clientX - cameraDrag.x) * 0.006;
    camera.pitch = clamp(cameraDrag.pitch + (event.clientY - cameraDrag.y) * 0.004, 0.16, 1.38);
    drawScene();
  });
  const endCameraDrag = (event) => {
    if (!cameraDrag || event.pointerId !== cameraDrag.pointerId) return;
    if (!cameraDrag.dragged) {
      const rect = shell.getBoundingClientRect();
      const nearest = findNearestGalaxyEdge(projectedEdges, { x: event.clientX - rect.left, y: event.clientY - rect.top });
      if (nearest) {
        selectedId = null;
        selectedEdgeId = nearest.edge.id;
        renderEdgeDetail(nearest.edge);
        drawScene();
      }
    }
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
