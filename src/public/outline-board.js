const outlineStatuses = new Set(["all", "empty", "draft", "ready", "completed"]);
const foreshadowStatuses = new Set(["all", "none", "unresolved", "resolved", "abandoned"]);
const sortModes = new Set(["tree", "status", "foreshadows", "title"]);

function text(value) {
  return String(value ?? "");
}

function normalizedSearchText(value) {
  return text(value).normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function numericOrder(value) {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? candidate : 0;
}

function stableIdCompare(left, right) {
  return text(left?.id).localeCompare(text(right?.id), "zh-CN");
}

function treeCompare(left, right) {
  const delta = numericOrder(left?.sortOrder) - numericOrder(right?.sortOrder);
  return delta || stableIdCompare(left, right);
}

function outlineStatusRank(chapter) {
  if (!chapter?.outline) return 0;
  return { draft: 1, ready: 2, completed: 3 }[chapter.outline.status] ?? 1;
}

function unresolvedForeshadowCount(chapter) {
  return (Array.isArray(chapter?.foreshadows) ? chapter.foreshadows : [])
    .filter((foreshadow) => foreshadow?.status === "planned" || foreshadow?.status === "planted")
    .length;
}

function compareChapters(left, right, sort) {
  if (sort === "status") {
    const delta = outlineStatusRank(left) - outlineStatusRank(right);
    if (delta) return delta;
  }
  if (sort === "foreshadows") {
    const unresolvedDelta = unresolvedForeshadowCount(right) - unresolvedForeshadowCount(left);
    if (unresolvedDelta) return unresolvedDelta;
    const totalDelta = (right?.foreshadows?.length ?? 0) - (left?.foreshadows?.length ?? 0);
    if (totalDelta) return totalDelta;
  }
  if (sort === "title") {
    const delta = text(left?.title).localeCompare(text(right?.title), "zh-CN");
    if (delta) return delta;
  }
  return treeCompare(left, right);
}

function matchesQuery(chapter, query) {
  if (!query) return true;
  const outline = chapter?.outline ?? {};
  const values = [
    chapter?.title,
    chapter?.chapterType,
    outline.goal,
    outline.conflict,
    outline.turningPoint,
    outline.notes,
    ...(Array.isArray(chapter?.foreshadows) ? chapter.foreshadows.map((item) => item?.title) : [])
  ];
  return values.some((value) => normalizedSearchText(value).includes(query));
}

function matchesOutlineStatus(chapter, status) {
  if (status === "all") return true;
  if (status === "empty") return !chapter?.outline;
  return chapter?.outline?.status === status;
}

function matchesForeshadowStatus(chapter, status) {
  if (status === "all") return true;
  const foreshadows = Array.isArray(chapter?.foreshadows) ? chapter.foreshadows : [];
  if (status === "none") return foreshadows.length === 0;
  if (status === "unresolved") {
    return foreshadows.some((item) => item?.status === "planned" || item?.status === "planted");
  }
  return foreshadows.some((item) => item?.status === status);
}

export function normalizeOutlineBoardState(value = {}) {
  const outlineStatus = text(value?.outlineStatus);
  const foreshadowStatus = text(value?.foreshadowStatus);
  const sort = text(value?.sort);
  return {
    query: text(value?.query),
    volumeId: text(value?.volumeId),
    outlineStatus: outlineStatuses.has(outlineStatus) ? outlineStatus : "all",
    foreshadowStatus: foreshadowStatuses.has(foreshadowStatus) ? foreshadowStatus : "all",
    sort: sortModes.has(sort) ? sort : "tree"
  };
}

/**
 * 保持分卷层级与默认章节树顺序，对章节执行筛选和卷内排序。
 * 未筛选时保留空分卷；指定空分卷时也保留该分组，便于确认数据状态。
 */
export function prepareOutlineBoard(board, value = {}) {
  const state = normalizeOutlineBoardState(value);
  const query = normalizedSearchText(state.query);
  const chapterFilterActive = Boolean(query || state.outlineStatus !== "all" || state.foreshadowStatus !== "all");
  const volumeFilterActive = Boolean(state.volumeId);
  const sourceVolumes = Array.isArray(board?.volumes) ? board.volumes : [];
  const totalChapterCount = sourceVolumes.reduce(
    (total, volume) => total + (Array.isArray(volume?.chapters) ? volume.chapters.length : 0),
    0
  );
  const volumes = [...sourceVolumes].sort(treeCompare).flatMap((volume) => {
    if (volumeFilterActive && text(volume?.id) !== state.volumeId) return [];
    const sourceChapters = Array.isArray(volume?.chapters) ? volume.chapters : [];
    const chapters = sourceChapters
      .filter((chapter) => matchesQuery(chapter, query)
        && matchesOutlineStatus(chapter, state.outlineStatus)
        && matchesForeshadowStatus(chapter, state.foreshadowStatus))
      .sort((left, right) => compareChapters(left, right, state.sort));
    const keepEmptyVolume = sourceChapters.length === 0 && (!chapterFilterActive || state.volumeId === text(volume?.id));
    if (chapters.length === 0 && !keepEmptyVolume) return [];
    return [{ ...volume, chapters }];
  });
  return {
    state,
    volumes,
    totalChapterCount,
    visibleChapterCount: volumes.reduce((total, volume) => total + volume.chapters.length, 0),
    filtersActive: chapterFilterActive || volumeFilterActive
  };
}

export function outlineBoardUnresolvedCount(chapter) {
  return unresolvedForeshadowCount(chapter);
}
