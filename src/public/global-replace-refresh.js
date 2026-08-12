function normalizeId(value) {
  const id = String(value ?? "").trim();
  return id || null;
}

function collapsedIds(value) {
  if (value instanceof Set) return value;
  return new Set(Array.isArray(value) ? value.map(normalizeId).filter(Boolean) : []);
}

function normalizedChapterCount(value) {
  if (value === null || value === undefined || value === "") return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function resolveGlobalReplaceChapterCount(volume, previousVolume) {
  const responseCount = normalizedChapterCount(volume?.chapterCount);
  if (responseCount !== null) return responseCount;
  if (Array.isArray(volume?.chapters)) return volume.chapters.length;
  const previousCount = normalizedChapterCount(previousVolume?.chapterCount);
  if (previousCount !== null) return previousCount;
  return Array.isArray(previousVolume?.chapters) ? previousVolume.chapters.length : 0;
}

export function buildGlobalReplaceRefreshPlan({
  volumes = [],
  collapsedVolumeIds = [],
  selectedChapterId = null,
  selectedChapterVolumeId = null,
  routeChapterId = null,
  scope = "",
  chapterCount = 0,
  settingCount = 0
} = {}) {
  const volumeList = Array.isArray(volumes) ? volumes : [];
  const collapsed = collapsedIds(collapsedVolumeIds);
  const chapterId = normalizeId(selectedChapterId) ?? normalizeId(routeChapterId);
  const chapterVolumeId = normalizeId(selectedChapterVolumeId)
    ?? normalizeId(volumeList.find((volume) => Array.isArray(volume?.chapters)
      && volume.chapters.some((chapter) => normalizeId(chapter?.id) === chapterId))?.id);
  const proseChanged = (scope === "prose" || scope === "prose-and-settings") && Number(chapterCount) > 0;
  const settingsChanged = (scope === "settings" || scope === "prose-and-settings") && Number(settingCount) > 0;
  const expandedVolumeIds = volumeList
    .filter((volume) => !collapsed.has(volume?.id))
    .map((volume) => normalizeId(volume?.id))
    .filter(Boolean);
  const reloadVolumeIds = proseChanged
    ? [...new Set([...expandedVolumeIds, chapterVolumeId].filter(Boolean))]
    : [];

  return {
    proseChanged,
    settingsChanged,
    selectedChapterId: chapterId,
    selectedChapterVolumeId: chapterVolumeId,
    expandedVolumeIds,
    reloadVolumeIds
  };
}
