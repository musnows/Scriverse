const outlineStatuses = new Set(["all", "empty", "draft", "ready", "completed"]);
const foreshadowStatuses = new Set(["all", "none", "unresolved", "resolved", "abandoned"]);
const sortModes = new Set(["tree", "status", "foreshadows", "title"]);

function text(value) {
  return String(value ?? "");
}

function unresolvedForeshadowCount(chapter) {
  return (Array.isArray(chapter?.foreshadows) ? chapter.foreshadows : [])
    .filter((foreshadow) => foreshadow?.status === "planned" || foreshadow?.status === "planted")
    .length;
}

export function normalizeOutlineBoardState(value = {}) {
  const outlineStatus = text(value?.outlineStatus);
  const foreshadowStatus = text(value?.foreshadowStatus);
  const sort = text(value?.sort);
  return {
    query: text(value?.query).slice(0, 200),
    volumeId: text(value?.volumeId),
    outlineStatus: outlineStatuses.has(outlineStatus) ? outlineStatus : "all",
    foreshadowStatus: foreshadowStatuses.has(foreshadowStatus) ? foreshadowStatus : "all",
    sort: sortModes.has(sort) ? sort : "tree"
  };
}

export function outlineBoardRequestPath(workId, value = {}, page = 1, limit = 30) {
  const state = normalizeOutlineBoardState(value);
  const safePage = Number.isInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
  const safeLimit = Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 100 ? Number(limit) : 30;
  const params = new URLSearchParams({ page: String(safePage), limit: String(safeLimit) });
  if (state.query.trim()) params.set("q", state.query.trim());
  if (state.volumeId) params.set("volumeId", state.volumeId);
  if (state.outlineStatus !== "all") params.set("outlineStatus", state.outlineStatus);
  if (state.foreshadowStatus !== "all") params.set("foreshadowStatus", state.foreshadowStatus);
  if (state.sort !== "tree") params.set("sort", state.sort);
  return `/api/works/${encodeURIComponent(text(workId))}/outline-board?${params.toString()}`;
}

export function outlineBoardUnresolvedCount(chapter) {
  return unresolvedForeshadowCount(chapter);
}
