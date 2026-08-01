/** 时间轴轨道色板（与 CSS `--timeline-track-palette-*` 索引对应） */
export const TIMELINE_TRACK_PALETTE_SIZE = 8;

/** 未分组轨道使用的色板索引 */
export const TIMELINE_UNGROUPED_COLOR_INDEX = TIMELINE_TRACK_PALETTE_SIZE - 1;

function timelineEventTrackKey(event) {
  return String(event?.trackId ?? "");
}

function compareNullableTimeSort(left, right) {
  const leftSort = left?.timeSort;
  const rightSort = right?.timeSort;
  const leftMissing = leftSort === null || leftSort === undefined || Number.isNaN(Number(leftSort));
  const rightMissing = rightSort === null || rightSort === undefined || Number.isNaN(Number(rightSort));
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;
  const delta = Number(leftSort) - Number(rightSort);
  if (delta !== 0) return delta;
  return 0;
}

function compareStableTieBreak(left, right) {
  const leftUpdated = String(left?.updatedAt ?? "");
  const rightUpdated = String(right?.updatedAt ?? "");
  if (leftUpdated !== rightUpdated) return leftUpdated < rightUpdated ? -1 : 1;
  const leftId = String(left?.id ?? "");
  const rightId = String(right?.id ?? "");
  if (leftId === rightId) return 0;
  return leftId < rightId ? -1 : 1;
}

/**
 * 按 timeSort 升序排列；缺失或无效的排序值置底；同值按 updatedAt、id 稳定排序。
 */
export function sortTimelineEvents(events = []) {
  return [...events].sort((left, right) => {
    const bySort = compareNullableTimeSort(left, right);
    if (bySort !== 0) return bySort;
    return compareStableTieBreak(left, right);
  });
}

/**
 * 按轨道筛选。trackIds 为空表示不过滤；未分组轨道用空字符串 ""。
 */
export function filterTimelineEvents(events = [], { trackIds = [] } = {}) {
  const selected = new Set(trackIds.map((id) => String(id)));
  if (selected.size === 0) return events;
  return events.filter((event) => selected.has(timelineEventTrackKey(event)));
}

/**
 * 将轨道映射到固定色板索引。按 sortOrder、id 排序后取模；未分组固定为末位索引。
 */
export function timelineTrackColorIndex(trackId, tracks = []) {
  const key = String(trackId ?? "");
  if (!key) return TIMELINE_UNGROUPED_COLOR_INDEX;
  const ordered = [...tracks]
    .filter((track) => String(track?.id ?? ""))
    .sort((left, right) => {
      const orderDelta = Number(left?.sortOrder ?? 0) - Number(right?.sortOrder ?? 0);
      if (orderDelta !== 0) return orderDelta;
      const leftId = String(left?.id ?? "");
      const rightId = String(right?.id ?? "");
      if (leftId === rightId) return 0;
      return leftId < rightId ? -1 : 1;
    });
  const index = ordered.findIndex((track) => String(track.id) === key);
  if (index < 0) return TIMELINE_UNGROUPED_COLOR_INDEX;
  return index % (TIMELINE_TRACK_PALETTE_SIZE - 1);
}

/**
 * 先筛选再按时间排序，供列表渲染使用。
 */
export function prepareTimelineEvents(events = [], filters = {}, tracks = []) {
  return sortTimelineEvents(filterTimelineEvents(events, filters));
}

/**
 * 解析当前激活的轨道 Tab。优先保留已选轨道；失效时回退到第一条真实轨道，再回退未分组。
 * null/undefined 表示尚未选择，回退到第一条真实轨道。
 */
export function resolveTimelineActiveTrackId(activeTrackId, tracks = []) {
  const orderedIds = [...tracks]
    .filter((track) => String(track?.id ?? ""))
    .sort((left, right) => {
      const orderDelta = Number(left?.sortOrder ?? 0) - Number(right?.sortOrder ?? 0);
      if (orderDelta !== 0) return orderDelta;
      const leftId = String(left?.id ?? "");
      const rightId = String(right?.id ?? "");
      if (leftId === rightId) return 0;
      return leftId < rightId ? -1 : 1;
    })
    .map((track) => String(track.id));
  const fallback = orderedIds[0] ?? "";
  if (activeTrackId === null || activeTrackId === undefined) return fallback;
  const key = String(activeTrackId);
  if (orderedIds.includes(key) || key === "") return key;
  return fallback;
}

export function timelineTrackDisplayName(trackId, tracks = []) {
  const key = String(trackId ?? "");
  if (!key) return "未分组";
  const track = tracks.find((item) => String(item?.id ?? "") === key);
  return track?.name || "未知轨道";
}
