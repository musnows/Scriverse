export function racePathLabel(race) {
  const names = Array.isArray(race?.lineage)
    ? race.lineage.map((item) => String(item?.name ?? "").trim()).filter(Boolean)
    : [];
  return names.length ? names.join(" / ") : String(race?.name ?? "").trim();
}

export function raceDescendantIds(races, raceId) {
  const childrenByParent = new Map();
  for (const race of races) {
    const parentRaceId = race?.parentRaceId == null ? null : String(race.parentRaceId);
    const children = childrenByParent.get(parentRaceId) ?? [];
    children.push(race);
    childrenByParent.set(parentRaceId, children);
  }
  const descendants = new Set();
  const pending = [...(childrenByParent.get(String(raceId)) ?? [])];
  while (pending.length) {
    const race = pending.pop();
    const id = String(race?.id ?? "");
    if (!id || descendants.has(id)) continue;
    descendants.add(id);
    pending.push(...(childrenByParent.get(id) ?? []));
  }
  return descendants;
}

export function eligibleRaceParents(races, currentRaceId = null) {
  if (!currentRaceId) return [...races];
  const excluded = raceDescendantIds(races, currentRaceId);
  excluded.add(String(currentRaceId));
  return races.filter((race) => !excluded.has(String(race?.id ?? "")));
}

export function buildRaceForest(races) {
  const nodes = new Map(races.map((race) => [String(race.id), { ...race, children: [] }]));
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parentRaceId ? nodes.get(String(node.parentRaceId)) : null;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (items) => {
    items.sort((left, right) => String(left.name).localeCompare(String(right.name), "zh-CN"));
    for (const item of items) sort(item.children);
    return items;
  };
  return sort(roots);
}
