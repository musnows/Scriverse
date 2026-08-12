export const READING_PREFERENCES_STORAGE_KEY = "scriverse-reading-preferences-v1";
export const READING_POSITION_STORAGE_PREFIX = "scriverse-reading-position-v1:";
export const READING_PREFERENCES_VERSION = 2;

export const DEFAULT_READING_PREFERENCES = Object.freeze({
  mode: "scroll",
  fontSize: 20,
  lineHeight: 1.9,
  theme: "auto"
});

const readingModes = new Set(["scroll", "paged"]);
const readingFontSizes = new Set([16, 18, 20, 22, 24]);
const readingLineHeights = new Set([1.6, 1.8, 1.9, 2, 2.2]);
const readingThemes = new Set(["auto", "paper", "light", "dark"]);

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeReadingPreferences(value) {
  const candidate = record(value);
  const fontSize = Number(candidate.fontSize);
  const lineHeight = Number(candidate.lineHeight);
  return {
    mode: readingModes.has(candidate.mode) ? candidate.mode : DEFAULT_READING_PREFERENCES.mode,
    fontSize: readingFontSizes.has(fontSize) ? fontSize : DEFAULT_READING_PREFERENCES.fontSize,
    lineHeight: readingLineHeights.has(lineHeight) ? lineHeight : DEFAULT_READING_PREFERENCES.lineHeight,
    theme: readingThemes.has(candidate.theme) ? candidate.theme : DEFAULT_READING_PREFERENCES.theme
  };
}

export function normalizeStoredReadingPreferences(value) {
  const candidate = record(value);
  const legacyTheme = candidate.version === READING_PREFERENCES_VERSION
    ? candidate.theme
    : candidate.theme === "paper" ? "auto" : candidate.theme;
  return normalizeReadingPreferences({ ...candidate, theme: legacyTheme });
}

export function resolveReadingTheme(theme, colorTheme) {
  const normalized = readingThemes.has(theme) ? theme : DEFAULT_READING_PREFERENCES.theme;
  if (normalized === "auto") return colorTheme === "dark" ? "dark" : "paper";
  return normalized;
}

export function readingPositionStorageKey(workId) {
  return `${READING_POSITION_STORAGE_PREFIX}${encodeURIComponent(String(workId ?? ""))}`;
}

export function buildReadingChapterSequence(work) {
  const workId = String(work?.id ?? "");
  const volumes = Array.isArray(work?.volumes) ? work.volumes : [];
  const seen = new Set();
  const sequence = [];
  for (const [volumeIndex, volume] of volumes.entries()) {
    const volumeId = String(volume?.id ?? "");
    const chapters = Array.isArray(volume?.chapters) ? volume.chapters : [];
    for (const [chapterIndex, chapter] of chapters.entries()) {
      const id = String(chapter?.id ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      sequence.push({
        id,
        workId: String(chapter?.workId ?? workId),
        volumeId: String(chapter?.volumeId ?? volumeId),
        volumeTitle: String(volume?.title ?? "正文"),
        title: String(chapter?.title ?? "未命名章节"),
        chapterType: String(chapter?.chapterType ?? "正文"),
        volumeIndex,
        chapterIndex,
        sequenceIndex: sequence.length
      });
    }
  }
  return sequence;
}

export function normalizeReadingPosition(value, sequence) {
  const candidate = record(value);
  const chapterId = String(candidate.chapterId ?? "");
  if (!sequence.some((chapter) => chapter.id === chapterId)) return null;
  const scrollRatio = Number(candidate.scrollRatio);
  const pageIndex = Number(candidate.pageIndex);
  return {
    chapterId,
    scrollRatio: Number.isFinite(scrollRatio) ? Math.min(1, Math.max(0, scrollRatio)) : 0,
    pageIndex: Number.isInteger(pageIndex) && pageIndex >= 0 ? pageIndex : 0
  };
}

export function resolveReadingStart(sequence, options = {}) {
  if (!sequence.length) return null;
  const requestedChapterId = String(options.chapterId ?? "");
  const requested = sequence.find((chapter) => chapter.id === requestedChapterId);
  if (requested) return requested;
  const stored = normalizeReadingPosition(options.storedPosition, sequence);
  if (stored) return sequence.find((chapter) => chapter.id === stored.chapterId) ?? sequence[0];
  const volumeId = String(options.volumeId ?? "");
  return sequence.find((chapter) => chapter.volumeId === volumeId) ?? sequence[0];
}

export function adjacentReadingChapter(sequence, chapterId, direction) {
  const index = sequence.findIndex((chapter) => chapter.id === chapterId);
  if (index < 0) return null;
  return sequence[index + (direction < 0 ? -1 : 1)] ?? null;
}

export function resolvePagedReadingStep({ sequence, chapterId, pageIndex, pageCount }, direction) {
  const safePageCount = Math.max(1, Math.floor(Number(pageCount) || 1));
  const safePageIndex = Math.min(safePageCount - 1, Math.max(0, Math.floor(Number(pageIndex) || 0)));
  if (direction >= 0) {
    if (safePageIndex < safePageCount - 1) return { chapterId, pageIndex: safePageIndex + 1, chapterChanged: false };
    const next = adjacentReadingChapter(sequence, chapterId, 1);
    return next ? { chapterId: next.id, pageIndex: 0, chapterChanged: true } : null;
  }
  if (safePageIndex > 0) return { chapterId, pageIndex: safePageIndex - 1, chapterChanged: false };
  const previous = adjacentReadingChapter(sequence, chapterId, -1);
  return previous ? { chapterId: previous.id, pageIndex: -1, chapterChanged: true } : null;
}

export function createReadingRequestGate() {
  let generation = 0;
  let active = null;
  return {
    begin(chapterId) {
      active?.controller.abort();
      const request = {
        chapterId: String(chapterId),
        generation: ++generation,
        controller: new AbortController()
      };
      active = request;
      return { chapterId: request.chapterId, generation: request.generation, signal: request.controller.signal };
    },
    isCurrent(request) {
      return Boolean(active)
        && active.chapterId === request?.chapterId
        && active.generation === request?.generation
        && !request?.signal?.aborted;
    },
    finish(request) {
      if (active?.generation === request?.generation) active = null;
    },
    cancel() {
      active?.controller.abort();
      active = null;
      generation += 1;
    }
  };
}
